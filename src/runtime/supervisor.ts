import { platformAudit } from '../platform/store.ts';
import type { Sql } from '../store/engine/types.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { backoffMs } from './backoff.ts';
import { tenantContext } from './context.ts';

// The Supervisor (design section 7; plan 2026-10-29-saas-s3-s6.md, task S4.5): one runtime per customer that should
// run, read from the platform tenants table.
// - active: a full runtime; onboarding: a setup runtime (WhatsApp linking and Google connect, no AI work);
//   paused, invited or removed: none.
// - On SQLite only the founder runs: customers need the Postgres switch (S6).
// - Limits: at most maxActive full runtimes (the founder counts and is never refused), and no customer start above the
//   memory ceiling.
// - A crash stops that runtime and starts it again after a backoff (1 s doubling to 5 minutes, back to 1 s after 10
//   minutes of running); after 5 crashes in an hour the customer shows as failing, still retried every 5 minutes. The
//   other runtimes are never touched. Crashes are audited by the error's name and code, never its message.
// Everything the Supervisor does runs one step at a time, in order, so a crash report never meets a reconcile halfway.

export interface RuntimeStart {
  id: string;
  founder: boolean;
  setupOnly: boolean;
  /** How the runtime reports a crash of its own (its guarded() entry points use it). */
  crashed: (e: unknown) => void;
}
/** What a running customer runtime knows about its setup: the onboarding probes read these (src/runtime/probes.ts). */
export interface RuntimeFacts {
  whatsappLinked: boolean;
  spareLinked: boolean;
  driveConnected: boolean;
  groupsApproved: number;
  reportTimeSet: boolean;
  aiKey: 'configured' | 'missing';
}

export interface RuntimeHandle {
  stop(): Promise<void>;
  /** The runtime's setup facts, read synchronously from what it holds in memory. */
  facts?(): RuntimeFacts;
}
export interface RuntimeFactory {
  start(t: RuntimeStart): Promise<RuntimeHandle>;
}

export type RuntimeState = 'starting' | 'running' | 'backoff' | 'failing' | 'stopped' | 'refused:limit' | 'refused:memory' | 'refused:postgres';

export interface SupervisorDeps {
  /** The platform tables (tenants, platform_audit). */
  db: Sql;
  clock: Clock;
  log: Logger;
  factory: RuntimeFactory;
  engine: 'sqlite' | 'postgres';
  /** Full runtimes at most, the founder's included (PLATFORM_MAX_ACTIVE, 20). */
  maxActive: number;
  /** No customer start above this resident memory (PLATFORM_MAX_RSS_MB). */
  maxRssMb: number;
  rssMb: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
  /** How long one runtime's stop may take before it is left behind (10 s). */
  stopTimeoutMs?: number;
}

interface Slot {
  state: RuntimeState;
  handle: RuntimeHandle | null;
  setupOnly: boolean;
  crashes: number[];
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const CRASH_WINDOW_MS = 3_600_000;
const HEALTHY_AFTER_MS = 600_000;
const FAILING_AFTER = 5;

export class Supervisor {
  readonly #d: SupervisorDeps;
  readonly #slots = new Map<string, Slot>();
  #chain: Promise<void> = Promise.resolve();

  constructor(d: SupervisorDeps) {
    this.#d = d;
  }

  state(id: string): RuntimeState {
    return this.#slots.get(id)?.state ?? 'stopped';
  }

  /** Every customer the Supervisor has a state for. */
  states(): ReadonlyMap<string, RuntimeState> {
    return new Map([...this.#slots].map(([id, s]) => [id, s.state]));
  }

  /** A running runtime's setup facts; null when that customer has no runtime running (refused, stopped, restarting). */
  facts(id: string): RuntimeFacts | null {
    const slot = this.#slots.get(id);
    return slot?.state === 'running' && slot.handle?.facts ? slot.handle.facts() : null;
  }

  /** Brings the runtimes in line with the tenants table. */
  reconcile(): Promise<void> {
    return this.#queue(() => this.#reconcile());
  }

  /** reconcile() without waiting: after a pause, a resume or an activation. */
  poke(): void {
    void this.reconcile();
  }

  /** A runtime reports a crash (its guarded() entry points, or the process's handlers through crashOwner()). */
  crashed(id: string, e: unknown): Promise<void> {
    return this.#queue(() => this.#crash(id, e));
  }

  /** Resolves when everything asked of the Supervisor so far is done. */
  settled(): Promise<void> {
    return this.#chain;
  }

  /** Every runtime, in parallel, each within its stop limit. */
  stopAll(): Promise<void> {
    return this.#queue(async () => {
      await Promise.all([...this.#slots.keys()].map((id) => this.#stop(id, 'stopped')));
    });
  }

  #queue(fn: () => Promise<void>): Promise<void> {
    const run = this.#chain.then(fn);
    this.#chain = run.catch((e: unknown) => this.#d.log.error({ err: { name: (e as Error)?.name } }, 'supervisor step failed'));
    return this.#chain;
  }

  async #reconcile(): Promise<void> {
    const rows = await this.#d.db.all<{ id: string; kind: string; status: string }>(
      "SELECT id, kind, status FROM tenants WHERE status <> 'removed' ORDER BY kind = 'founder' DESC, created_at, id",
    );
    const want = new Map(rows.filter((r) => r.status === 'active' || r.status === 'onboarding').map((r) => [r.id, r]));
    for (const [id, slot] of this.#slots) if (!want.has(id) && (slot.handle || slot.timer)) await this.#stop(id, 'stopped');
    for (const [id, slot] of this.#slots) if (!want.has(id)) slot.state = 'stopped';

    let full = [...this.#slots.values()].filter((s) => s.handle && !s.setupOnly).length;
    for (const r of want.values()) {
      const founder = r.kind === 'founder';
      const setupOnly = r.status === 'onboarding';
      const slot = this.#slots.get(r.id);
      // Running, or waiting out a backoff (its timer reconciles again): leave it. Refused or stopped: try again here.
      if (slot && (slot.handle || slot.timer) && slot.setupOnly === setupOnly) continue;
      if (slot && (slot.handle || slot.timer)) {
        if (slot.handle && !slot.setupOnly) full -= 1;
        await this.#stop(r.id, 'stopped'); // onboarding became active, or the other way: start it again as the other kind
      }
      if (!founder && this.#d.engine === 'sqlite') {
        this.#set(r.id, 'refused:postgres', setupOnly);
        continue;
      }
      if (!founder && !setupOnly && full >= this.#d.maxActive) {
        this.#set(r.id, 'refused:limit', setupOnly);
        continue;
      }
      if (!founder && this.#d.rssMb() > this.#d.maxRssMb) {
        this.#set(r.id, 'refused:memory', setupOnly);
        continue;
      }
      if ((await this.#start(r.id, founder, setupOnly)) && !setupOnly) full += 1;
    }
  }

  #set(id: string, state: RuntimeState, setupOnly: boolean): Slot {
    const slot = this.#slots.get(id) ?? { state, handle: null, setupOnly, crashes: [], startedAt: 0, timer: null };
    slot.state = state;
    slot.setupOnly = setupOnly;
    this.#slots.set(id, slot);
    return slot;
  }

  async #start(id: string, founder: boolean, setupOnly: boolean): Promise<boolean> {
    const slot = this.#set(id, 'starting', setupOnly);
    try {
      const crashed = (e: unknown) => void this.crashed(id, e);
      slot.handle = await tenantContext.run(id, () => this.#d.factory.start({ id, founder, setupOnly, crashed }));
      slot.state = 'running';
      slot.startedAt = this.#d.clock.now().getTime();
      return true;
    } catch (e) {
      await this.#crash(id, e);
      return false;
    }
  }

  async #stop(id: string, then: RuntimeState): Promise<void> {
    const slot = this.#slots.get(id);
    if (!slot) return;
    if (slot.timer) (this.#d.clearTimer ?? clearTimeout)(slot.timer);
    slot.timer = null;
    const h = slot.handle;
    slot.handle = null;
    slot.state = then;
    if (!h) return;
    const limit = new Promise<void>((r) => setTimeout(r, this.#d.stopTimeoutMs ?? 10_000).unref());
    await Promise.race([h.stop(), limit]).catch((e: unknown) => this.#d.log.warn({ tenant: id, err: { name: (e as Error)?.name } }, 'runtime stop failed'));
  }

  async #crash(id: string, e: unknown): Promise<void> {
    const slot = this.#slots.get(id);
    // Only a runtime that is starting or running can crash; a late report after a stop or a pause changes nothing.
    if (!slot || (slot.state !== 'running' && slot.state !== 'starting')) return;
    const now = this.#d.clock.now().getTime();
    if (slot.state === 'running' && now - slot.startedAt >= HEALTHY_AFTER_MS) slot.crashes = [];
    slot.crashes = [...slot.crashes.filter((t) => now - t < CRASH_WINDOW_MS), now];
    const next: RuntimeState = slot.crashes.length >= FAILING_AFTER ? 'failing' : 'backoff';
    await this.#stop(id, next);
    const err = (e ?? {}) as { name?: unknown; code?: unknown };
    const detail = `${typeof err.name === 'string' ? err.name : 'Error'} ${typeof err.code === 'string' ? err.code : ''}`.trim().slice(0, 100);
    this.#d.log.warn({ tenant: id, crashes: slot.crashes.length, err: detail }, 'customer runtime crashed');
    await platformAudit(this.#d.db, { at: new Date(now).toISOString(), actor: 'supervisor', event: 'runtime.crashed', tenantId: id, detail, requestId: null })
      .catch(() => undefined);
    const set = this.#d.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms).unref());
    slot.timer = set(() => {
      slot.timer = null;
      this.poke();
    }, backoffMs(slot.crashes.length));
  }
}
