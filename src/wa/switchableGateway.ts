import { systemClock, type Clock } from '../util/clock.ts';
import type { EventHandler, GatewayLike, GatewayState, GatewayStatus, HistoryAnchor, HistoryAnswer } from './gateway.ts';
import type { GroupSendSocket } from './groupSend.ts';
import type { NormalizedEvent } from './normalize.ts';

// Holds the founder's WhatsApp gateway so the dashboard can replace it in place (a relink) without restarting the
// service (D3). The app registers its handlers here once; they keep working across swaps. Only the current inner
// gateway's statuses get through. Its events do too, and so do (bug 12) the events a gateway swapped out had already
// taken (its queue drains into the handlers: real messages from the customer's allowed groups, which the store keeps
// once by WhatsApp id), and those of a relink's new gateway from its start, before it is swapped in. Anything a stopped
// gateway fires after its queue has drained is ignored.

/** listGroups with no open WhatsApp connection. */
export class NotConnectedError extends Error {
  readonly code = 'whatsapp_not_connected';
  constructor() {
    super('WhatsApp is not connected');
    this.name = 'NotConnectedError';
  }
}

/** The states SwitchableGateway reports while it holds no gateway. */
export type HeldState = Extract<GatewayState, 'not_linked' | 'linking'>;

const STOP_CAP_MS = 5_000;

export class SwitchableGateway implements GatewayLike {
  readonly #clock: Clock;
  readonly #stopCapMs: number;
  readonly #eventFns: EventHandler[] = [];
  readonly #statusFns: ((s: GatewayStatus) => void)[] = [];
  readonly #historyFns: ((a: HistoryAnswer) => void)[] = [];
  #inner: GatewayLike | undefined;
  #held: { state: HeldState; since: string };
  /**
   * idle: never started (a gateway swapped in waits for start()); running: a gateway swapped in is started; stopped: the
   * service is shutting down, so a gateway swapped in is stopped (a relink may hand over one that is already running).
   */
  #phase: 'idle' | 'running' | 'stopped' = 'idle';
  /** Failure and drop counts of earlier gateways, so the counters run on across swaps. */
  #failedBefore = 0;
  #droppedBefore = 0;
  /** Earlier gateways' idle(), taken as each was swapped out: an event it was storing still finishes before shutdown. */
  #retired: Promise<unknown> = Promise.resolve();
  /** Gateways swapped out whose queue is still draining: their events still reach the handlers until it has. */
  readonly #draining = new Set<GatewayLike>();
  /** A relink's new gateway, not yet swapped in, whose events already reach the handlers (follow). */
  #following: GatewayLike | undefined;
  /** Gateways whose events are forwarded already: wired once, so a followed gateway swapped in is not doubled. */
  readonly #wired = new WeakSet<GatewayLike>();

  constructor(o: { inner?: GatewayLike; clock?: Clock; initialState?: HeldState; stopCapMs?: number } = {}) {
    this.#clock = o.clock ?? systemClock;
    this.#stopCapMs = o.stopCapMs ?? STOP_CAP_MS;
    this.#held = { state: o.initialState ?? 'not_linked', since: this.#clock.now().toISOString() };
    if (o.inner) this.#install(o.inner);
  }

  onEvent(fn: EventHandler): void {
    this.#eventFns.push(fn);
  }

  /**
   * The current gateway's idle(), a followed one's, and every earlier one's as it was swapped out: their events taken
   * before the swap.
   */
  idle(): Promise<void> {
    return Promise.all([this.#retired, this.#inner?.idle?.(), this.#following?.idle?.()]).then(() => undefined);
  }

  /**
   * A relink's new gateway, before it is swapped in: its events reach the handlers from now on, so what the new link
   * brings between 'open' and the swap is stored. Its statuses stay its driver's. Call before it starts.
   */
  follow(g: GatewayLike): void {
    this.#following = g;
    this.#wireEvents(g);
  }

  /** The relink was undone: g's events stop reaching the handlers, once those it has already taken are through. */
  unfollow(g: GatewayLike): void {
    if (this.#following !== g) return;
    this.#following = undefined;
    this.#failedBefore += g.failedCount();
    this.#droppedBefore += g.droppedCount();
    this.#drain(g);
  }

  onStatus(fn: (s: GatewayStatus) => void): void {
    this.#statusFns.push(fn);
  }

  onHistory(fn: (a: HistoryAnswer) => void): void {
    this.#historyFns.push(fn);
  }

  /** Asks the current gateway; false without one (setup mode, a relink in progress) or when it cannot ask. */
  async fetchHistory(groupId: string, anchor: HistoryAnchor, count: number): Promise<boolean> {
    const inner = this.#inner;
    if (!inner?.fetchHistory || inner.status().state !== 'open') return false;
    return inner.fetchHistory(groupId, anchor, count);
  }

  /** The current gateway's socket for an approved group (groupSend.ts); null without one, or while it is not open. */
  groupSocket(groupId: string): GroupSendSocket | null {
    const inner = this.#inner;
    if (!inner?.groupSocket || inner.status().state !== 'open') return null;
    return inner.groupSocket(groupId);
  }

  status(): GatewayStatus {
    if (this.#inner) return this.#inner.status();
    return { state: this.#held.state, since: this.#held.since, lastErrorCode: null, credsSaveFailures: 0 };
  }

  start(): void {
    this.#phase = 'running';
    if (this.#inner) this.#inner.start();
    else this.#emitStatus(this.status()); // setup mode: Health learns 'not_linked' (or 'linking') at once
  }

  /** While a relink holds no gateway ('linking'), the link session owns and stops its own gateway. */
  async stop(): Promise<void> {
    this.#phase = 'stopped';
    await this.#inner?.stop();
  }

  async listGroups(): Promise<{ id: string; subject: string }[]> {
    const inner = this.#inner;
    if (!inner || inner.status().state !== 'open') throw new NotConnectedError();
    return inner.listGroups();
  }

  failedCount(): number {
    return this.#failedBefore + (this.#inner?.failedCount() ?? 0);
  }

  droppedCount(): number {
    return this.#droppedBefore + (this.#inner?.droppedCount() ?? 0);
  }

  /** Has an inner gateway (WhatsApp linked, or a relink just handed over). */
  hasGateway(): boolean {
    return this.#inner !== undefined;
  }

  /**
   * Stops the current gateway (waiting at most 5 s), installs next, and starts it while the service runs. A gateway
   * that is already running (a finished relink) is handed over as it is: WhatsAppGateway.start() is a no-op then.
   */
  async swap(next: GatewayLike): Promise<void> {
    if (next === this.#inner) return; // already installed: installing again would deliver every event twice
    const old = this.#detach();
    this.#install(next);
    await this.#stopCapped(old);
    if (this.#inner !== next) return; // swapped or cleared again meanwhile
    if (this.#phase === 'running') next.start();
    else if (this.#phase === 'stopped') await this.#stopCapped(next); // shutting down: never leave a live socket behind
    if (this.#inner === next) this.#emitStatus(next.status());
  }

  /** Stops the current gateway (at most 5 s) and holds none: status() reports `state`, listGroups throws. */
  async clear(state: HeldState): Promise<void> {
    const old = this.#detach();
    this.#held = { state, since: this.#clock.now().toISOString() };
    this.#emitStatus(this.status()); // Health shows the new state at once, not after the old gateway has stopped
    await this.#stopCapped(old);
  }

  #install(inner: GatewayLike): void {
    if (this.#following === inner) this.#following = undefined; // a followed relink gateway, swapped in: now the inner
    this.#inner = inner;
    this.#wireEvents(inner);
    inner.onStatus((s) => {
      if (this.#inner === inner) this.#emitStatus(s);
    });
    inner.onHistory?.((a) => {
      if (this.#inner !== inner) return;
      for (const fn of this.#historyFns) fn(a);
    });
  }

  /** Events reach the handlers while g is the inner, the followed one, or a swapped-out one still draining. */
  #wireEvents(g: GatewayLike): void {
    if (this.#wired.has(g)) return;
    this.#wired.add(g);
    g.onEvent((e) => (this.#inner === g || this.#following === g || this.#draining.has(g) ? this.#emitEvent(e) : undefined));
  }

  /** From here on the old gateway's statuses are ignored, and its events once its queue has drained; its counts are kept. */
  #detach(): GatewayLike | undefined {
    const old = this.#inner;
    if (old) {
      this.#failedBefore += old.failedCount();
      this.#droppedBefore += old.droppedCount();
      this.#drain(old);
    }
    this.#inner = undefined;
    return old;
  }

  /**
   * g's queue as it stands drains into the handlers, and shutdown waits for it. A gateway without idle() (it cannot say
   * what it has taken) is ignored at once, as before.
   */
  #drain(g: GatewayLike): void {
    const drained = g.idle?.();
    if (!drained) return;
    this.#draining.add(g);
    const done = drained.then(() => void this.#draining.delete(g), () => void this.#draining.delete(g));
    this.#retired = Promise.all([this.#retired, done]);
  }

  async #stopCapped(g: GatewayLike | undefined): Promise<void> {
    if (!g) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<void>((r) => {
      timer = setTimeout(r, this.#stopCapMs);
    });
    try {
      await Promise.race([g.stop().catch(() => undefined), cap]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The handlers in turn; a promise one returns is waited for (and returned), so the inner gateway keeps the order. */
  #emitEvent(e: NormalizedEvent): unknown {
    // The app's event handler rethrows on failure so the gateway can count it; keep that, as WhatsAppGateway does.
    let chain: Promise<unknown> | undefined;
    for (const fn of this.#eventFns) {
      if (chain) chain = chain.then(() => fn(e));
      else {
        const r = fn(e);
        if (r instanceof Promise) chain = r;
      }
    }
    return chain;
  }

  #emitStatus(s: GatewayStatus): void {
    for (const fn of this.#statusFns) {
      try {
        fn(s);
      } catch {
        // a faulty status listener must not break the connection
      }
    }
  }
}
