import { randomBytes } from 'node:crypto';
import { DisconnectReason } from 'baileys';
import { maskNumber } from '../config/env.ts';
import type { Db } from '../store/db.ts';
import { setKv } from '../store/kv.ts';
import { systemClock, type Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { backupAndReset, dropBackup, hasSessionRows, restoreBackup, useEncryptedAuthState, type EncryptedAuth } from './authState.ts';
import { TRACKER_DEVICE_NAME, type GatewayLike } from './gateway.ts';
import type { SwitchableGateway } from './switchableGateway.ts';

// Linking a phone from the dashboard (D3): the founder's phone (a relink) or the spare phone. One link at a time. Each
// QR goes to the browser of the owner who started the link (subscribers get only the latest one) and is never logged,
// audited or stored. A link that is cancelled, times out (5 minutes) or fails is undone by its driver: for the founder's
// phone, the saved session comes back exactly as it was and WhatsApp reconnects as before.

export type LinkTarget = 'founder' | 'spare';

/** 'confirming' is the dashboard's own step before start(); the server goes from 'waiting_qr' on. */
export type LinkState = 'idle' | 'confirming' | 'waiting_qr' | 'qr' | 'opening' | 'linked' | 'cancelled' | 'timed_out' | 'failed';

export type LinkEvent =
  | { type: 'qr'; qr: string }
  | { type: 'state'; state: LinkState }
  | { type: 'done'; device: string }
  | { type: 'error'; code: string };

export interface LinkInfo {
  id: string;
  target: LinkTarget;
  /** Who started it (the owner's email, or 'cli'); for the audit log. */
  actor: string;
  state: LinkState;
  startedAt: string;
  endedAt: string | null;
  /** Why it ended without a link: cancelled, timed_out, stopped, or the driver's code. */
  errorCode: string | null;
  /** The linked device's name, once linked. */
  device: string | null;
}

export type LinkOutcome = { ok: true; device: string } | { ok: false; code: string };

export interface LinkHooks {
  /** A new QR code to show (WhatsApp rotates it about every 20 seconds). */
  qr(qr: string): void;
  /** The phone scanned the code; the connection is being set up. */
  opening(): void;
}

/**
 * One kind of link. run() resolves when the phone is linked or the link failed. When the signal aborts (cancel, timeout,
 * shutdown) before the link is committed, it must undo its changes, then resolve with { ok: false }. It resolves
 * { ok: true } only once the new link is committed (kept): the link is then reported as linked even if an abort came
 * meanwhile, because nothing undoes it any more. A throw is reported as failed ('error').
 */
export interface LinkDriver {
  run(hooks: LinkHooks, signal: AbortSignal): Promise<LinkOutcome>;
}

/** A link is already running (the dashboard answers 409). */
export class LinkBusyError extends Error {
  readonly code = 'link_in_progress';
  constructor() {
    super('A phone link is already in progress.');
    this.name = 'LinkBusyError';
  }
}

export type LinkAudit = (event: string, actor: string) => Promise<void>;

const AUDIT: Record<LinkTarget, { linked: string; cancelled: string; timedOut: string; failed: (code: string) => string }> = {
  founder: {
    linked: "WhatsApp relinked · founder's phone",
    cancelled: 'WhatsApp relink cancelled',
    timedOut: 'WhatsApp relink timed out',
    failed: (code) => `WhatsApp relink failed (${code})`,
  },
  spare: {
    linked: 'Spare phone linked',
    cancelled: 'Spare phone link cancelled',
    timedOut: 'Spare phone link timed out',
    failed: (code) => `Spare phone link failed (${code})`,
  },
};

const TIMEOUT_MS = 5 * 60_000;
const ENDED: ReadonlySet<LinkState> = new Set(['linked', 'cancelled', 'timed_out', 'failed']);

interface Running {
  info: LinkInfo;
  abort: AbortController;
  qr: string | null;
  subscribers: Set<(e: LinkEvent) => void>;
  done: Promise<void>;
}

/** The dashboard's phone links: at most one at a time, across both phones. */
export class LinkSessions {
  readonly #drivers: Partial<Record<LinkTarget, LinkDriver>>;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #audit: LinkAudit;
  readonly #timeoutMs: number;
  #current: Running | undefined;

  constructor(o: { drivers: Partial<Record<LinkTarget, LinkDriver>>; log: Logger; audit: LinkAudit; clock?: Clock; timeoutMs?: number }) {
    this.#drivers = o.drivers;
    this.#log = o.log;
    this.#audit = o.audit;
    this.#clock = o.clock ?? systemClock;
    this.#timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
  }

  /** Starts a link. Throws LinkBusyError while another one runs. */
  start(o: { target: LinkTarget; actor: string }): LinkInfo {
    if (this.#current && !ENDED.has(this.#current.info.state)) throw new LinkBusyError();
    const driver = this.#drivers[o.target];
    if (!driver) throw new Error(`No ${o.target} link is available`);
    const info: LinkInfo = {
      id: randomBytes(16).toString('hex'), target: o.target, actor: o.actor, state: 'waiting_qr',
      startedAt: this.#now(), endedAt: null, errorCode: null, device: null,
    };
    const abort = new AbortController();
    const run: Running = { info, abort, qr: null, subscribers: new Set(), done: Promise.resolve() };
    this.#current = run;
    this.#log.info({ link: info.id, target: o.target }, 'phone link started');
    const timer = setTimeout(() => abort.abort('timed_out'), this.#timeoutMs);
    const hooks: LinkHooks = {
      qr: (qr) => {
        if (abort.signal.aborted || ENDED.has(info.state)) return;
        run.qr = qr;
        this.#emit(run, { type: 'qr', qr });
        if (info.state !== 'qr') this.#setState(run, 'qr');
      },
      opening: () => {
        if (!abort.signal.aborted && !ENDED.has(info.state) && info.state !== 'opening') this.#setState(run, 'opening');
      },
    };
    // Through a promise, so a driver that throws at once still ends the link (and frees the one-at-a-time slot).
    run.done = Promise.resolve()
      .then(() => driver.run(hooks, abort.signal))
      .catch((err: unknown): LinkOutcome => {
        this.#log.error({ link: info.id, code: (err as Error | null)?.name ?? 'Error' }, 'phone link driver failed');
        return { ok: false, code: 'error' };
      })
      .then((outcome) => {
        clearTimeout(timer);
        this.#finish(run, outcome);
      });
    return { ...info };
  }

  /** Cancels the running link if it has this id. The driver restores what it changed. */
  cancel(id: string): boolean {
    const run = this.#current;
    if (!run || run.info.id !== id || ENDED.has(run.info.state)) return false;
    run.abort.abort('cancelled');
    return true;
  }

  /** The current or last link. */
  info(id: string): LinkInfo | undefined {
    return this.#current?.info.id === id ? { ...this.#current.info } : undefined;
  }

  /** Waits until the link with this id has ended (its driver finished undoing or handing over). */
  async settled(id: string): Promise<void> {
    if (this.#current?.info.id === id) await this.#current.done;
  }

  /**
   * Events of the link with this id: first its current state and the latest QR (only the latest), then each change.
   * Returns an unsubscribe function, or undefined for an unknown link.
   */
  subscribe(id: string, fn: (e: LinkEvent) => void): (() => void) | undefined {
    const run = this.#current;
    if (!run || run.info.id !== id) return undefined;
    safely(fn, { type: 'state', state: run.info.state });
    if (ENDED.has(run.info.state)) {
      safely(fn, run.info.state === 'linked' ? { type: 'done', device: run.info.device ?? '' } : { type: 'error', code: run.info.errorCode ?? 'failed' });
      return () => {};
    }
    if (run.qr !== null) safely(fn, { type: 'qr', qr: run.qr });
    run.subscribers.add(fn);
    return () => run.subscribers.delete(fn);
  }

  /** On shutdown: stops a running link (its driver undoes it) and waits for it. */
  async stop(): Promise<void> {
    const run = this.#current;
    if (!run) return;
    if (!ENDED.has(run.info.state)) run.abort.abort('stopped');
    await run.done;
  }

  #finish(run: Running, outcome: LinkOutcome): void {
    const { info } = run;
    const reason = run.abort.signal.aborted ? String(run.abort.signal.reason) : null;
    const texts = AUDIT[info.target];
    run.qr = null;
    info.endedAt = this.#now();
    if (outcome.ok) {
      // The driver committed the link: it is kept, so it is reported as linked even if an abort came meanwhile.
      info.device = outcome.device;
      this.#setState(run, 'linked');
      this.#emit(run, { type: 'done', device: outcome.device });
      this.#record(texts.linked, info.actor);
    } else {
      const code = reason ?? (outcome.ok ? 'failed' : outcome.code);
      info.errorCode = code;
      this.#setState(run, code === 'timed_out' ? 'timed_out' : code === 'cancelled' ? 'cancelled' : 'failed');
      this.#emit(run, { type: 'error', code });
      this.#record(code === 'timed_out' ? texts.timedOut : code === 'cancelled' ? texts.cancelled : texts.failed(code), info.actor);
    }
    this.#log.info({ link: info.id, target: info.target, state: info.state, code: info.errorCode }, 'phone link ended');
    run.subscribers.clear();
  }

  #record(event: string, actor: string): void {
    const failed = (err: unknown) => this.#log.error({ err }, 'audit line for a phone link could not be written');
    try {
      void this.#audit(event, actor).catch(failed);
    } catch (err) {
      failed(err);
    }
  }

  #setState(run: Running, state: LinkState): void {
    run.info.state = state;
    this.#emit(run, { type: 'state', state });
  }

  #emit(run: Running, e: LinkEvent): void {
    for (const fn of [...run.subscribers]) safely(fn, e);
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }
}

function safely(fn: (e: LinkEvent) => void, e: LinkEvent): void {
  try {
    fn(e);
  } catch {
    // a broken stream must not stop the link
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The session backup helpers live in authState.ts (openPhoneSession restores an unfinished link's backup); re-exported here.
export { backupAndReset, dropBackup, recoverInterruptedLink, restoreBackup } from './authState.ts';

/**
 * The link's auth state, with its writes (saveCreds and key changes) dropped once `stopped()` is true. A socket that is
 * closing after a cancel can still fire creds.update; without this, that late write would land on the restored rows.
 */
export function guardAuth(auth: EncryptedAuth, stopped: () => boolean): EncryptedAuth {
  const { keys } = auth.state;
  return {
    hasSession: auth.hasSession,
    saveCreds: () => (stopped() ? Promise.resolve() : auth.saveCreds()),
    state: {
      creds: auth.state.creds,
      keys: { get: (type, ids) => keys.get(type, ids), set: (data) => (stopped() ? Promise.resolve() : keys.set(data)) },
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The founder's phone.

export interface FounderLinkDeps {
  /** data/session.db (the founder's session). */
  sessionDb: Db;
  /** tracker.db, for kv session_reset_at. */
  trackerDb: Db;
  /** The master key: the founder's session is sealed with it directly. */
  key: Buffer;
  switchable: SwitchableGateway;
  /** A founder gateway on this auth state, built exactly as main.ts builds it (allow-list, Baileys factory, saveCreds). */
  buildGateway: (auth: EncryptedAuth, onQr?: (qr: string) => void) => GatewayLike;
  log: Logger;
  clock?: Clock;
  /** How long to wait for the new gateway to stop when undoing. Default 5 s. */
  stopCapMs?: number;
}

const TERMINAL = new Set(['logged_out', 'forbidden', 'replaced']);

/**
 * Relinks the founder's phone in-process: holds the gateway as 'linking', backs up and resets the session in one
 * transaction (backupAndReset), and starts a fresh gateway that shows QR codes. On open the backup is dropped and the new
 * gateway is handed to the service: from then on the link is kept, and reported as linked even if a stop arrives. On
 * cancel, timeout or a refusal before that, the backed-up rows come back in one transaction and the service reconnects
 * with them, as it was before.
 */
export function founderLinkDriver(d: FounderLinkDeps): LinkDriver {
  const clock = d.clock ?? systemClock;
  const stopCap = d.stopCapMs ?? 5_000;
  const stopCapped = async (g: GatewayLike | undefined) => {
    if (!g) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([g.stop().catch(() => undefined), new Promise<void>((r) => (timer = setTimeout(r, stopCap)))]);
    clearTimeout(timer);
  };

  /** The rows exactly as they were, and the service reconnected with them (or holding none, if it had none). */
  const restore = async (wasLinked: boolean): Promise<void> => {
    try {
      await restoreBackup(d.sessionDb);
    } catch (err) {
      // The backup stays in the database; the next start restores it (recoverInterruptedLink).
      d.log.error({ err }, 'founder session could not be restored now; it is restored at the next start');
      await d.switchable.clear('not_linked');
      return;
    }
    if (!wasLinked) {
      await d.switchable.clear('not_linked');
      return;
    }
    try {
      await d.switchable.swap(d.buildGateway(await useEncryptedAuthState(d.sessionDb, d.key)));
    } catch (err) {
      // The rows are back as they were; only the reconnect failed (it would fail the same way at the next start).
      d.log.error({ err }, 'founder session restored, but reconnecting with it failed');
      await d.switchable.clear('not_linked');
    }
  };

  return {
    async run(hooks, signal) {
      const wasLinked = d.switchable.hasGateway();
      // Read only when there are rows: on an empty table useEncryptedAuthState would write its canary row.
      const hasRows = await hasSessionRows(d.sessionDb);
      const before = hasRows ? await numberOf(() => useEncryptedAuthState(d.sessionDb, d.key)) : undefined;
      let gw: GatewayLike | undefined;
      let onAbort: (() => void) | undefined;
      let backedUp = false;
      let undone = false;
      let auth: EncryptedAuth | undefined;
      try {
        await d.switchable.clear('linking');
        if (signal.aborted) throw new Aborted();
        await backupAndReset(d.sessionDb);
        backedUp = true;
        // Its writes stop once the link is undone, so the closing socket never writes over the restored rows.
        auth = guardAuth(await useEncryptedAuthState(d.sessionDb, d.key), () => undone);
        const linkAuth = auth;
        const outcome = await new Promise<LinkOutcome>((resolve) => {
          let qrSeen = false;
          onAbort = () => resolve({ ok: false, code: 'aborted' });
          signal.addEventListener('abort', onAbort, { once: true });
          gw = d.buildGateway(linkAuth, (qr) => {
            qrSeen = true;
            hooks.qr(qr);
          });
          gw.onStatus((s) => {
            if (s.state === 'open') resolve({ ok: true, device: TRACKER_DEVICE_NAME });
            else if (TERMINAL.has(s.state)) resolve({ ok: false, code: s.state });
            // After a scan WhatsApp closes once with "restart required" and the gateway reconnects by itself. Other
            // closes (an expired code, a network blip) are not a scan.
            else if (s.state === 'closed' && qrSeen && s.lastErrorCode === DisconnectReason.restartRequired) hooks.opening();
          });
          gw.start();
        });
        if (onAbort) signal.removeEventListener('abort', onAbort);
        if (!outcome.ok || signal.aborted) {
          undone = true;
          await stopCapped(gw);
          await restore(wasLinked);
          return outcome.ok ? { ok: false, code: 'aborted' } : outcome;
        }
        // Committed from here: the new session is kept, whatever comes next.
        await dropBackup(d.sessionDb);
      } catch (err) {
        if (!(err instanceof Aborted)) d.log.error({ err }, 'founder relink failed; restoring the saved session');
        undone = true;
        await stopCapped(gw);
        if (backedUp) await restore(wasLinked);
        else if (wasLinked && !d.switchable.hasGateway()) await reconnectAsBefore();
        return { ok: false, code: err instanceof Aborted ? 'aborted' : 'error' };
      }
      // After the commit nothing may undo the link: each step only logs when it fails.
      try {
        await d.switchable.swap(gw!); // already running: handed over without a restart
      } catch (err) {
        d.log.error({ err }, 'the relinked gateway could not be handed over; it connects at the next start');
      }
      try {
        await setKv(d.trackerDb, 'session_reset_at', clock.now().toISOString());
      } catch (err) {
        d.log.error({ err }, 'session_reset_at could not be recorded');
      }
      const linked = auth ? await numberOf(async () => auth!) : undefined;
      if (before && linked && before !== linked) {
        d.log.warn({ before: maskNumber(before), after: maskNumber(linked) }, "founder's WhatsApp was relinked from a different number");
      }
      return { ok: true, device: TRACKER_DEVICE_NAME };

      async function reconnectAsBefore(): Promise<void> {
        // Nothing was reset (the abort or error came before the backup): reconnect with the untouched session.
        try {
          await d.switchable.swap(d.buildGateway(await useEncryptedAuthState(d.sessionDb, d.key)));
        } catch (err) {
          d.log.error({ err }, 'reconnecting with the untouched founder session failed');
          await d.switchable.clear('not_linked');
        }
      }
    },
  };
}

class Aborted extends Error {}

/** The phone number in a session's creds, or undefined (no link, or the session cannot be read). */
async function numberOf(load: () => Promise<EncryptedAuth>): Promise<string | undefined> {
  try {
    const id = (await load()).state.creds.me?.id;
    return id ? id.split(/[:@]/)[0] : undefined;
  } catch {
    return undefined;
  }
}
