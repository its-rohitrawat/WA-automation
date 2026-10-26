import { loadTrackerView, type HealthLine } from '../output/view.ts';
import { buildWorkbook } from '../output/workbook.ts';
import { tx, type Db } from '../store/db.ts';
import { getKv, setKv } from '../store/kv.ts';
import {
  claimReport, closeOldRetries, finishReport, markInterruptedReports, REPORT_REQUEST_KEY, reportFor, reportRequestValue, retryReport, skipReport,
  type ReportRow,
} from '../store/reports.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { istDate, istTime } from '../util/time.ts';
import { buildMorningText } from './morningReport.ts';
import type { ReportHealth, ReportSender, ReportSettings, SenderState, SendResult } from './types.ts';

/** Waits after a definite failure: 2 minutes, then 5, then 10 for every later try, until the deadline. */
export const RETRY_WAITS_MS = [2 * 60_000, 5 * 60_000, 10 * 60_000];

export function retryWaitMs(attempts: number): number {
  return RETRY_WAITS_MS[Math.min(Math.max(attempts, 1), RETRY_WAITS_MS.length) - 1]!;
}

/** Reason codes stored in reports.detail, in plain words for the status line. */
export const REASON_TEXT: Record<string, string> = {
  not_running: 'the service was not running in time',
  not_linked: 'the spare number is not linked',
  session_unreadable: "the spare number's saved session cannot be read",
  session_unavailable: "the spare number's session file could not be opened",
  connect_timeout: 'could not connect to WhatsApp',
  closed: 'the WhatsApp connection closed before sending',
  restart_required: 'WhatsApp asked for a reconnect',
  logged_out: 'the spare number was logged out',
  forbidden: 'WhatsApp refused the spare number (403)',
  replaced: 'another session took over the spare number',
  build_failed: 'the report could not be built',
  busy: 'another send was running',
  stopped: 'the service was stopping',
  timeout: 'WhatsApp did not confirm in time',
  send_error: 'the send failed part-way',
  crash: 'the sender crashed',
  interrupted: 'the service stopped mid-send',
};

export const reasonText = (code: string | null): string => (code ? (REASON_TEXT[code] ?? code) : 'no reason recorded');

export const UNKNOWN_WARNING = '⚠️ Morning report: unknown, check WhatsApp. See docs/SETUP.md → "Morning report".';

export const SENDER_WARNINGS: Partial<Record<SenderState, string>> = {
  not_linked: '⚠️ Morning report: the spare number is not linked. Stop the service and run: npm run cli -- link-sender',
  unreadable: "⚠️ Morning report: the spare number's saved session cannot be read. Stop the service and run: npm run cli -- link-sender --reset",
  unavailable:
    "⚠️ Morning report: the spare number's session file could not be opened (disk, permissions or a lock). Restart the service; see docs/SETUP.md",
  logged_out: '⚠️ Morning report: the spare number was logged out. Stop the service and run: npm run cli -- link-sender --reset',
  forbidden: '⚠️ Morning report: WhatsApp refused the spare number (403). Check the spare phone.',
  replaced: '⚠️ Morning report: another session took over the spare number. Restart the service.',
};

/** The Health and `cli status` line for one day. Pure: reads nothing. */
export function describeReport(row: ReportRow | undefined, now: Date, settings: ReportSettings, sender: SenderState): ReportHealth {
  const text = ((): string => {
    if (!row) {
      const hm = istTime(now);
      if (hm < settings.time) return `Morning report: due at ${settings.time} IST`;
      if (hm < settings.deadline) return 'Morning report: due now';
      return `Morning report skipped today (${reasonText('not_running')})`;
    }
    switch (row.status) {
      case 'sent':
        return `Morning report: sent at ${istTime(new Date(row.updatedAt))} IST`;
      case 'sending':
        return 'Morning report: sending now';
      case 'retry':
        return `Morning report: not sent yet (${reasonText(row.detail)}), next try ${istTime(new Date(row.nextAttemptAt ?? row.updatedAt))} IST`;
      case 'unknown':
        return 'Morning report: unknown, check WhatsApp';
      case 'skipped':
        return `Morning report skipped today (${reasonText(row.detail)})`;
    }
  })();
  return { text, warning: row?.status === 'unknown' ? UNKNOWN_WARNING : (SENDER_WARNINGS[sender] ?? null) };
}

export interface ReportPayload {
  text: string;
  xlsx: Buffer;
  fileName: string;
}

export interface ReportSchedulerOptions {
  db: Db;
  clock: Clock;
  log: Logger;
  sender: ReportSender;
  settings: ReportSettings;
  /** The health line printed in the attached workbook (Health.workbookLine). */
  healthLine: () => HealthLine;
  /** Test seam: replaces building the text and the workbook from the tracker. */
  build?: (now: Date) => Promise<ReportPayload>;
}

/**
 * Decides when the morning report goes out, and records every attempt in the reports table. The row is claimed before
 * any send, so a date is sent at most once; an unknown outcome is never retried automatically. Makes no AI call.
 */
export class ReportScheduler {
  readonly #o: ReportSchedulerOptions;
  #inFlight: Promise<void> | undefined;
  #stopped = false;
  /** Set once recover() has succeeded. No send starts before it: a row left 'sending' must become unknown first. */
  #recovered = false;

  constructor(o: ReportSchedulerOptions) {
    this.#o = o;
  }

  /** At service start: a row still 'sending' was cut off by a crash or a stop mid-send, so its outcome is unknown. */
  recover(now: Date = this.#o.clock.now()): void {
    const count = markInterruptedReports(this.#o.db, now.toISOString());
    this.#recovered = true;
    if (count > 0) this.#o.log.warn({ count }, 'morning report was cut off mid-send; marked unknown, not retried');
  }

  /** Called from the app tick (every 30 s). Never throws. Resolves when a send it started has finished. */
  async tick(now: Date = this.#o.clock.now()): Promise<void> {
    if (this.#inFlight || this.#stopped) return;
    if (!this.#recovered) {
      // The recovery at service start failed (for example the database was locked). Until it succeeds, a row cut off
      // mid-send would read 'sending now' all day and hide a report that may already have gone out, so send nothing.
      try {
        this.recover(now);
      } catch (err) {
        this.#o.log.error({ err }, 'morning report recovery failed again; nothing is sent until it succeeds');
        return;
      }
    }
    const run = this.#run(now);
    this.#inFlight = run;
    try {
      await run;
    } finally {
      this.#inFlight = undefined;
    }
  }

  /** Today's line for Health. */
  health(now: Date = this.#o.clock.now()): ReportHealth {
    if (!this.#o.settings.enabled) return { text: 'Morning report: off', warning: null };
    return describeReport(reportFor(this.#o.db, istDate(now)), now, this.#o.settings, this.#o.sender.status().state);
  }

  /**
   * Starts no new send, waits up to waitMs for the send in flight, stops the sender (up to 3 s), then waits up to 2 s
   * more for that send to record its outcome. Neither extra wait is longer than waitMs, so the whole stop takes at most
   * waitMs + 5 s. Leaves no timers.
   */
  async stop(waitMs: number): Promise<void> {
    this.#stopped = true;
    const inFlight = this.#inFlight;
    if (inFlight) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([inFlight, new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]);
      clearTimeout(timer);
    }
    // Bounded: closing a socket on a dead network can hang (SenderGateway also caps it at 3 s).
    let stopTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.#o.sender.stop(),
        new Promise<void>((resolve) => {
          stopTimer = setTimeout(resolve, Math.min(3_000, waitMs));
        }),
      ]);
    } catch (err) {
      this.#o.log.error({ err }, 'stopping the report sender failed');
    } finally {
      clearTimeout(stopTimer);
    }
    // Stopping the sender ends a send in its linger (both ids already back) or cuts one off. Give it up to 2 s more to
    // record its outcome, so a report that went out is 'sent' before main.ts closes the database.
    if (inFlight) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([inFlight, new Promise<void>((resolve) => (timer = setTimeout(resolve, Math.min(2_000, waitMs))))]);
      clearTimeout(timer);
    }
  }

  async #run(now: Date): Promise<void> {
    const { db, settings, log } = this.#o;
    try {
      const date = istDate(now);
      const at = now.toISOString();
      // Taking the request, checking it and the forced claim are one transaction, so a request written meanwhile is
      // never wiped unread, and the row cannot change between the check and the claim. The send comes after it.
      const step = tx(db, (): 'send' | 'done' | 'schedule' => {
        const requested = getKv(db, REPORT_REQUEST_KEY);
        if (requested) setKv(db, REPORT_REQUEST_KEY, ''); // a request is used once, whatever happens next
        if (!settings.enabled) return 'done';
        closeOldRetries(db, date, at);
        if (!requested) return 'schedule';
        // Honoured only while today's row is exactly what the owner confirmed: a send that started after the
        // confirmation and ended unknown changes the row, and must never be followed by a second report.
        if (requested !== reportRequestValue(date, reportFor(db, date))) {
          log.info({ date }, 'send-now request ignored: it is not for today, or today changed since it was confirmed');
          return 'schedule';
        }
        if (claimReport(db, date, at, { force: true })) return 'send';
        log.info({ date }, 'send-now request ignored: today is already sent or being sent');
        return 'done';
      });
      if (step === 'send') await this.#send(date, now);
      if (step !== 'schedule') return;
      const hm = istTime(now);
      if (hm < settings.time) return;
      if (hm >= settings.deadline) {
        const row = reportFor(db, date);
        const reason = row?.detail ?? 'not_running';
        if ((!row || row.status === 'retry') && skipReport(db, date, reason, at)) log.warn({ date, reason }, 'morning report skipped today');
        return;
      }
      if (claimReport(db, date, at)) await this.#send(date, now);
    } catch (err) {
      log.error({ err }, 'morning report tick failed');
    }
  }

  async #send(date: string, now: Date): Promise<void> {
    const { db, log, sender } = this.#o;
    let payload: ReportPayload;
    try {
      payload = await (this.#o.build ?? ((n: Date) => this.#build(n)))(now);
    } catch (err) {
      log.error({ err }, 'morning report could not be built');
      this.#retry(date, 'build_failed');
      return;
    }
    if (this.#stopped) {
      this.#retry(date, 'stopped'); // stop() arrived during the build: nothing has been sent yet, so start no send
      return;
    }
    let result: SendResult;
    try {
      result = await sender.sendReport(payload.text, payload.xlsx, payload.fileName);
    } catch (err) {
      log.error({ err }, 'morning report sender crashed');
      result = { status: 'unknown', code: 'crash' };
    }
    const at = this.#o.clock.now().toISOString();
    if (result.status === 'sent') {
      finishReport(db, date, 'sent', result.messageIds.join(','), at);
      log.info({ date }, 'morning report sent');
    } else if (result.status === 'unknown') {
      finishReport(db, date, 'unknown', result.code, at);
      log.warn({ date, code: result.code }, 'morning report outcome unknown; not retried automatically');
    } else {
      this.#retry(date, result.code);
    }
  }

  #retry(date: string, code: string): void {
    const now = this.#o.clock.now();
    const next = new Date(now.getTime() + retryWaitMs(reportFor(this.#o.db, date)?.attempts ?? 1)).toISOString();
    retryReport(this.#o.db, date, code, next, now.toISOString());
    this.#o.log.warn({ date, code, nextAttemptAt: next }, 'morning report not sent; will try again');
  }

  async #build(now: Date): Promise<ReportPayload> {
    const view = loadTrackerView(this.#o.db, now, this.#o.healthLine());
    return { text: buildMorningText(view, view.today), xlsx: await buildWorkbook(view), fileName: `Tracker-${view.today}.xlsx` };
  }
}
