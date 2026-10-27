import type { Logger } from '../util/logger.ts';

/** The first visit, a minute after start, so a restart shows up quickly. */
export const FIRST_BEAT_MS = 60_000;
/** Then every 5 minutes; set the UptimeRobot heartbeat monitor to the same interval. */
export const HEARTBEAT_INTERVAL_MS = 5 * 60_000;
/** One visit may take at most this long. */
export const HEARTBEAT_TIMEOUT_MS = 10_000;

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

  /** Stops the timers and aborts a visit still running. Leaves no timers. */
  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#first);
    clearInterval(this.#every);
    this.#first = undefined;
    this.#every = undefined;
    this.#inFlight?.abort();
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
