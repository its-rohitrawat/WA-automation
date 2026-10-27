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
/** After a failed open, the next try waits 1 minute, doubling to at most 10. */
const OPEN_RETRY_MS = [60_000, 120_000, 240_000, 480_000, 600_000];
/** After this many failed opens in a row, Health tells the owner. */
const OPEN_WARN_AFTER = 3;
export const OPEN_FAILED_WARNING = '⚠️ Morning report: the spare number could not be started. Restart the service; see docs/SETUP.md';

type Current = { recipient: string; opened: OpenedSender; scheduler: ReportScheduler };

export class LiveReport {
  readonly #o: LiveReportOptions;
  #current: Current | undefined;
  /** A sender being stopped and closed (a number change): stop() waits for it, and nothing opens before it ends. */
  #closing: Promise<void> | undefined;
  #busy: Promise<void> | undefined;
  #stopped = false;
  #openFailures = 0;
  #nextOpenAt = 0;

  constructor(o: LiveReportOptions) {
    this.#o = o;
  }

  /**
   * Called from the app tick, which does not wait for it. Never throws. A tick while another runs does nothing, so a
   * number change never stops a scheduler in the middle of its send.
   */
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
      let s = this.#o.settings();
      const cur = this.#current;
      if (cur && s.recipient !== undefined && s.recipient !== cur.recipient) {
        this.#current = undefined;
        const closing = this.#close(cur);
        this.#closing = closing;
        try {
          await closing; // the old sender lets go of the session file before a new one opens it
        } finally {
          this.#closing = undefined;
        }
        log.info({}, 'morning report: the number changed; the sender is made again for the new number');
        if (this.#stopped) return; // stop() came while the old sender was closing: open nothing new
        // The close takes up to a few seconds: the owner may have changed the number (or switched off) meanwhile.
        s = this.#o.settings();
      }
      if (!this.#current) {
        if (!s.report.enabled || s.recipient === undefined) return;
        if (now.getTime() < this.#nextOpenAt) return;
        try {
          this.#current = this.#start(s.recipient);
          this.#openFailures = 0;
          this.#nextOpenAt = 0;
        } catch (err) {
          this.#openFailures++;
          this.#nextOpenAt = now.getTime() + OPEN_RETRY_MS[Math.min(this.#openFailures, OPEN_RETRY_MS.length) - 1]!;
          log.error({ err, failures: this.#openFailures }, 'morning report: the spare number sender could not be opened; trying again later');
          return;
        }
      }
      await this.#current.scheduler.tick(now);
    } catch (err) {
      log.error({ err }, 'morning report live tick failed');
    }
  }

  /** Opens the sender and its scheduler; a send cut off under the previous one becomes unknown before anything is sent. */
  #start(recipient: string): Current {
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

  async #close(c: Current, waitMs: number = STOP_WAIT_MS): Promise<void> {
    await c.scheduler.stop(waitMs);
    try {
      c.opened.close();
    } catch (err) {
      this.#o.log.error({ err }, 'closing the morning report sender failed');
    }
  }

  /** Today's line for Health. Never throws: settings that cannot be read give a plain line. */
  health(now: Date = this.#o.clock.now()): ReportHealth {
    if (this.#current) return this.#current.scheduler.health(now);
    try {
      const s = this.#o.settings();
      if (!s.report.enabled) return { text: 'Morning report: off', warning: null };
      if (s.recipient === undefined) return { text: "Morning report: no founder's number set", warning: null };
    } catch (err) {
      this.#o.log.error({ err }, 'morning report settings could not be read');
      return { text: 'Morning report: settings could not be read', warning: null };
    }
    return { text: 'Morning report: starting', warning: this.#openFailures >= OPEN_WARN_AFTER ? OPEN_FAILED_WARNING : null };
  }

  /**
   * Starts nothing more, then stops and closes the sender, also one being closed for a number change, so the spare
   * number's session file is closed when this resolves. Bounded by the scheduler's own stop (waitMs + 5 s).
   */
  async stop(waitMs: number = STOP_WAIT_MS): Promise<void> {
    this.#stopped = true;
    const cur = this.#current;
    this.#current = undefined;
    if (cur) await this.#close(cur, waitMs);
    if (this.#closing) await this.#closing;
    if (this.#busy) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([this.#busy, new Promise<void>((resolve) => (timer = setTimeout(resolve, Math.min(2_000, waitMs))))]);
      clearTimeout(timer);
    }
  }
}
