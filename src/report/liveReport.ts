import type { HealthLine } from '../output/view.ts';
import type { Db } from '../store/db.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { ReportScheduler, type ReportPayload } from './scheduler.ts';
import type { ReportHealth, ReportSender, ReportSettings } from './types.ts';

// The morning briefing with settings the owner changes while the service runs (D5 Task 1, spec 4.7). It wraps the
// ReportScheduler, which keeps every safety rule: the claim before the send, at most once per IST date, an unknown
// outcome never retried, the catch-up until the deadline. This class only decides which scheduler runs:
// - none until the briefing is first switched on with a number (the module is opened then, once);
// - a new one when the number changes: the recipient stays fixed per sender, so the old scheduler is stopped and its
//   sender closed first (no send can be in flight: ticks never overlap), and the new one recovers before it sends.
// Switching off needs nothing here: the scheduler reads the settings on every tick and sends nothing while off.

export interface LiveReportSettings {
  report: ReportSettings;
  /** The founder's number, digits only; undefined while none is set. */
  recipient: string | undefined;
}

/** A sender for one recipient, and how to close what it opened (the spare number's session file). */
export interface OpenedSender {
  sender: ReportSender;
  close: () => void;
}

export interface LiveReportOptions {
  db: Db;
  clock: Clock;
  log: Logger;
  /** Read at the start of every tick. */
  settings: () => LiveReportSettings;
  /** Makes the sender for a number (in the service: openMorningReport, through senderOpener). May throw. */
  open: (recipient: string) => OpenedSender;
  healthLine: () => HealthLine;
  /** Test seam, passed to the scheduler. */
  build?: (now: Date) => Promise<ReportPayload>;
}

/** How long a stop or a rebuild waits for a send in flight (the scheduler adds at most 5 s to it). */
const STOP_WAIT_MS = 10_000;

export class LiveReport {
  readonly #o: LiveReportOptions;
  #current: { recipient: string; opened: OpenedSender; scheduler: ReportScheduler } | undefined;
  #busy: Promise<void> | undefined;
  #stopped = false;

  constructor(o: LiveReportOptions) {
    this.#o = o;
  }

  /** Called from the app tick. Never throws. A tick while another runs does nothing. */
  async tick(now: Date = this.#o.clock.now()): Promise<void> {
    if (this.#busy || this.#stopped) return;
    const run = this.#run(now);
    this.#busy = run;
    try {
      await run;
    } finally {
      this.#busy = undefined;
    }
  }

  async #run(now: Date): Promise<void> {
    const { log } = this.#o;
    try {
      const s = this.#o.settings();
      const cur = this.#current;
      if (cur && s.recipient !== undefined && s.recipient !== cur.recipient) {
        this.#current = undefined;
        await this.#close(cur);
        log.info({}, 'morning report: the number changed; the sender is made again for the new number');
      }
      if (this.#stopped) return; // stop() came while the old sender was closing: open nothing new
      if (!this.#current) {
        if (!s.report.enabled || s.recipient === undefined) return;
        this.#current = this.#start(s.recipient);
      }
      await this.#current.scheduler.tick(now);
    } catch (err) {
      log.error({ err }, 'morning report live tick failed');
    }
  }

  /** Opens the sender and its scheduler; a send cut off under the previous one becomes unknown before anything is sent. */
  #start(recipient: string): { recipient: string; opened: OpenedSender; scheduler: ReportScheduler } {
    const { db, clock, log, healthLine, build } = this.#o;
    const opened = this.#o.open(recipient);
    const scheduler = new ReportScheduler({
      db, clock, log, sender: opened.sender, healthLine, ...(build ? { build } : {}),
      settings: () => this.#o.settings().report,
    });
    try {
      scheduler.recover();
    } catch (err) {
      log.error({ err }, 'morning report recovery failed; the scheduler tries again before any send');
    }
    return { recipient, opened, scheduler };
  }

  async #close(c: { opened: OpenedSender; scheduler: ReportScheduler }): Promise<void> {
    await c.scheduler.stop(STOP_WAIT_MS);
    try {
      c.opened.close();
    } catch (err) {
      this.#o.log.error({ err }, 'closing the morning report sender failed');
    }
  }

  /** Today's line for Health. */
  health(now: Date = this.#o.clock.now()): ReportHealth {
    if (this.#current) return this.#current.scheduler.health(now);
    const s = this.#o.settings();
    if (!s.report.enabled) return { text: 'Morning report: off', warning: null };
    return { text: s.recipient === undefined ? "Morning report: no founder's number set" : 'Morning report: starting', warning: null };
  }

  /** Starts nothing more, waits for a tick in flight (bounded by the scheduler's own stop), then stops and closes. */
  async stop(waitMs: number = STOP_WAIT_MS): Promise<void> {
    this.#stopped = true;
    const cur = this.#current;
    this.#current = undefined;
    if (cur) {
      await cur.scheduler.stop(waitMs);
      try {
        cur.opened.close();
      } catch (err) {
        this.#o.log.error({ err }, 'closing the morning report sender failed');
      }
    }
    if (this.#busy) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([this.#busy, new Promise<void>((resolve) => (timer = setTimeout(resolve, Math.min(2_000, waitMs))))]);
      clearTimeout(timer);
    }
  }
}
