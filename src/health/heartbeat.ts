import type { Logger } from '../util/logger.ts';

/** The first visit, a minute after start, so a restart shows up quickly. */
export const FIRST_BEAT_MS = 60_000;
/** Then every 5 minutes; set the UptimeRobot heartbeat monitor to the same interval. */
export const HEARTBEAT_INTERVAL_MS = 5 * 60_000;
/** One visit may take at most this long. */
export const HEARTBEAT_TIMEOUT_MS = 10_000;

/**
 * What beatNow() found. reason is a short code: 'refused' (the monitor answered with a non-2xx status), 'timeout',
 * 'unreachable', 'not_up' (no visit: the agent is not up) or 'stopped'.
 */
export interface BeatNowResult {
  ok: boolean;
  status?: number;
  reason?: string;
}

export interface HeartbeatOptions {
  /** HEARTBEAT_URL. Secret: it is never logged. */
  url: string;
  /** Health.isUp(): visit only while the agent is doing its job. */
  isUp: () => boolean;
  log: Logger;
  fetch?: typeof fetch;
}

/**
 * Tells an uptime monitor the agent is alive by visiting its heartbeat link while the agent is up. When the visits
 * stop (the machine is off, the service crashed, WhatsApp is unlinked, Google sign-in expired), the monitor alerts.
 * Sends nothing but a plain GET: no messages, names or numbers. Never throws.
 */
export class Heartbeat {
  readonly #o: HeartbeatOptions;
  readonly #fetch: typeof fetch;
  #first: NodeJS.Timeout | undefined;
  #every: NodeJS.Timeout | undefined;
  #inFlight: AbortController | undefined;
  /** beatNow() visits in flight; kept apart from #inFlight so a test visit never makes a scheduled one skip. */
  readonly #testVisits = new Set<AbortController>();
  #stopped = false;
  #pausedLogged = false;

  constructor(o: HeartbeatOptions) {
    this.#o = o;
    this.#fetch = o.fetch ?? fetch;
  }

  start(): void {
    this.#first = setTimeout(() => {
      this.#first = undefined;
      void this.#beat();
      this.#every = setInterval(() => void this.#beat(), HEARTBEAT_INTERVAL_MS);
      this.#every.unref?.();
    }, FIRST_BEAT_MS);
    this.#first.unref?.();
  }

  /** Stops the timers and aborts a visit still running (a test visit too). Leaves no timers. */
  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#first);
    clearInterval(this.#every);
    this.#first = undefined;
    this.#every = undefined;
    this.#inFlight?.abort();
    for (const c of this.#testVisits) c.abort();
  }

  /**
   * One visit now, for the dashboard's "Send test beat": outside the 5-minute schedule, which it leaves as it was.
   * Like a scheduled visit it only goes while the agent is up (reason 'not_up'), so a test never tells the monitor a
   * down agent is alive. Never throws; never logs or returns the link or an error message.
   */
  async beatNow(): Promise<BeatNowResult> {
    if (this.#stopped) return { ok: false, reason: 'stopped' };
    let up: boolean;
    try {
      up = this.#o.isUp();
    } catch {
      up = false;
    }
    if (!up) return { ok: false, reason: 'not_up' };
    const ctrl = new AbortController();
    this.#testVisits.add(ctrl);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, HEARTBEAT_TIMEOUT_MS);
    try {
      const res = await this.#fetch(this.#o.url, { method: 'GET', signal: ctrl.signal });
      if (res.ok) {
        this.#o.log.info({ status: res.status }, 'test uptime heartbeat sent');
        return { ok: true, status: res.status };
      }
      this.#o.log.warn({ status: res.status }, 'test uptime heartbeat was refused');
      return { ok: false, status: res.status, reason: 'refused' };
    } catch (err) {
      const reason = timedOut ? 'timeout' : this.#stopped ? 'stopped' : 'unreachable';
      // As in #beat: only the error's type, never its message or the link.
      this.#o.log.warn({ problem: err instanceof Error ? err.name : 'unknown', reason }, 'test uptime heartbeat failed');
      return { ok: false, reason };
    } finally {
      clearTimeout(timer);
      this.#testVisits.delete(ctrl);
    }
  }

  async #beat(): Promise<void> {
    if (this.#stopped || this.#inFlight) return;
    let up: boolean;
    try {
      up = this.#o.isUp();
    } catch {
      up = false;
    }
    if (!up) {
      if (!this.#pausedLogged) this.#o.log.warn('uptime heartbeat paused: the agent is not up (see the health line)');
      this.#pausedLogged = true;
      return;
    }
    if (this.#pausedLogged) this.#o.log.info('uptime heartbeat resumed');
    this.#pausedLogged = false;
    const ctrl = new AbortController();
    this.#inFlight = ctrl;
    const timer = setTimeout(() => ctrl.abort(), HEARTBEAT_TIMEOUT_MS);
    try {
      const res = await this.#fetch(this.#o.url, { method: 'GET', signal: ctrl.signal });
      if (!res.ok) this.#o.log.warn({ status: res.status }, 'uptime heartbeat visit was refused');
    } catch (err) {
      // Never log the error message or the link: either could contain the secret heartbeat token.
      if (!this.#stopped) this.#o.log.warn({ problem: err instanceof Error ? err.name : 'unknown' }, 'uptime heartbeat visit failed');
    } finally {
      clearTimeout(timer);
      this.#inFlight = undefined;
    }
  }
}
