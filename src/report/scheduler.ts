import { loadTrackerView, type HealthLine } from '../output/view.ts';
import { tx, type Db } from '../store/db.ts';
import { getKv, setKv } from '../store/kv.ts';
import {
  claimReport, closeOldRetries, finishReport, markInterruptedReports, parseReportRequest, REPORT_REQUEST_KEY, REPORT_REQUEST_MAX_AGE_MS, reportFor,
  reportRequestValue, retryReport, skipReport, type ReportRow,
} from '../store/reports.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { istDate, istDayLabel, istTime } from '../util/time.ts';
import { buildShortMorningText, trackerLink } from './morningReport.ts';
import type { ReportDays, ReportHealth, ReportSender, ReportSettings, SenderState, SendResult } from './types.ts';

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
  self_send: "the sender is linked to the founder's own number; re-link with the spare phone",
  connect_timeout: 'could not connect to WhatsApp',
  connect_error: 'the WhatsApp connection could not be started',
  closed: 'the WhatsApp connection closed before sending',
  restart_required: 'WhatsApp asked for a reconnect',
  logged_out: 'the spare number was logged out',
  forbidden: 'WhatsApp refused the spare number (403)',
  replaced: 'another session took over the spare number',
  build_failed: 'the report could not be built',
  no_tracker_link: 'the tracker is not on Google Drive yet (run google-auth and let it upload once)',
  busy: 'another send was running',
  stopped: 'the service was stopping',
  timeout: 'WhatsApp did not confirm in time',
  send_error: 'the send failed part-way',
  crash: 'the sender crashed',
  interrupted: 'the service stopped mid-send',
  not_recorded: 'the outcome could not be recorded',
};

/**
 * A send takes at most about 3.5 minutes (60 s to connect, 120 s for the message, 15 s linger). A row still 'sending' after
 * this long had its outcome lost (recording it failed), so it reads unknown and is never retried.
 */
export const STALE_SENDING_MS = 10 * 60_000;

/** True for a 'sending' row last changed more than STALE_SENDING_MS before now. */
export function isStaleSending(row: ReportRow | undefined, now: Date): boolean {
  return row?.status === 'sending' && now.getTime() - Date.parse(row.updatedAt) > STALE_SENDING_MS;
}

export const reasonText = (code: string | null): string => (code ? (REASON_TEXT[code] ?? code) : 'no reason recorded');

export const UNKNOWN_WARNING = '⚠️ Morning report: unknown, check WhatsApp. See docs/SETUP.md → "Morning report".';

export const SENDER_WARNINGS: Partial<Record<SenderState, string>> = {
  not_linked: '⚠️ Morning report: the spare number is not linked. Stop the service and run: npm run cli -- link-sender',
  unreadable: "⚠️ Morning report: the spare number's saved session cannot be read. Stop the service and run: npm run cli -- link-sender --reset",
  unavailable:
    "⚠️ Morning report: the spare number's session file could not be opened (disk, permissions or a lock). Restart the service; see docs/SETUP.md",
  self_send:
    "⚠️ Morning report: the sender is linked to the founder's own number. Stop the service and run: npm run cli -- link-sender --reset, then scan with the SPARE phone",
  logged_out: '⚠️ Morning report: the spare number was logged out. Stop the service and run: npm run cli -- link-sender --reset',
  forbidden: '⚠️ Morning report: WhatsApp refused the spare number (403). Check the spare phone.',
  replaced: '⚠️ Morning report: another session took over the spare number. Restart the service.',
};

/** 0 for Sunday to 6 for Saturday: the weekday of an IST calendar date "YYYY-MM-DD" (the date alone fixes it). */
function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** True when the scheduled report goes out on this IST date: weekdays is Monday to Friday, mon-sat adds Saturday, daily is every day. */
export function isReportDay(date: string, days: ReportDays): boolean {
  const day = weekdayOf(date);
  if (days === 'daily') return true;
  if (days === 'mon-sat') return day !== 0;
  return day !== 0 && day !== 6;
}

/** The Health and `cli status` line for one day. Pure: reads nothing. */
export function describeReport(row: ReportRow | undefined, now: Date, settings: ReportSettings, sender: SenderState): ReportHealth {
  const unknown = row?.status === 'unknown' || isStaleSending(row, now);
  const text = ((): string => {
    if (unknown) return 'Morning report: unknown, check WhatsApp';
    if (!row) {
      // No scheduled report today, so no "due" promise and no skip. A row on such a day comes only from send-now.
      const date = istDate(now);
      if (!isReportDay(date, settings.days)) {
        // 'not a report day' is unreachable with today's REPORT_DAYS values (every off day is a Saturday or Sunday).
        // It is kept for a future value that makes a weekday an off day; add a test for the label with that value.
        const weekend = weekdayOf(date) === 0 || weekdayOf(date) === 6;
        return `Morning report: no report today (${weekend ? 'weekend' : 'not a report day'})`;
      }
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
      case 'retry': {
        const next = new Date(row.nextAttemptAt ?? row.updatedAt);
        // A try due at or after the deadline (or on a later IST date) never comes: the deadline skips the day first.
        if (istDate(next) !== row.date || istTime(next) >= settings.deadline) {
          return `Morning report: not sent yet (${reasonText(row.detail)}); no more tries today, it will be skipped at ${settings.deadline} IST`;
        }
        return `Morning report: not sent yet (${reasonText(row.detail)}), next try ${istTime(next)} IST`;
      }
      case 'unknown':
        return 'Morning report: unknown, check WhatsApp';
      case 'skipped':
        return `Morning report skipped today (${reasonText(row.detail)})`;
    }
  })();
  return { text, warning: unknown ? UNKNOWN_WARNING : (SENDER_WARNINGS[sender] ?? null) };
}

/**
 * When the next report goes out, for the Automations screen: "today 07:30", "today, due now", "tomorrow 07:30" or
 * "Mon 3 Nov, 07:30". settings.time is today's time (a time changed after it had passed starts the next day, see
 * SettingsStore), laterTime the one for the days after. Null while the briefing is off. Pure: reads nothing.
 */
export function nextReport(row: ReportRow | undefined, now: Date, settings: ReportSettings, laterTime: string = settings.time): string | null {
  if (!settings.enabled) return null;
  const today = istDate(now);
  const hm = istTime(now);
  // Today is still to come only before the deadline, with no row on a report day or a retry row. A row sent, skipped or
  // unknown (a stale 'sending' one too) is done with: the next report is on a later day.
  if (hm < settings.deadline && !isStaleSending(row, now)) {
    if (row?.status === 'sending') return 'today, sending now';
    let due: string | undefined;
    if (!row && isReportDay(today, settings.days)) due = settings.time;
    if (row?.status === 'retry') {
      const next = new Date(row.nextAttemptAt ?? row.updatedAt);
      // The scheduler tries again once the wait is over and today's time has come.
      if (istDate(next) === today) due = istTime(next) > settings.time ? istTime(next) : settings.time;
    }
    if (due !== undefined && due < settings.deadline) return due > hm ? `today ${due}` : 'today, due now';
  }
  for (let i = 1; i <= 7; i++) {
    const date = new Date(Date.parse(`${today}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
    if (!isReportDay(date, settings.days)) continue;
    return i === 1 ? `tomorrow ${laterTime}` : `${istDayLabel(new Date(`${date}T12:00:00+05:30`))}, ${laterTime}`;
  }
  return null; // unreachable: every REPORT_DAYS value has a report day each week
}

/** What the report sends: the short text with the tracker link. No attachment. */
export interface ReportPayload {
  text: string;
}

/** A definite failure while building the report: nothing was sent, so the day is retried with this reason code. */
export class ReportBuildError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`The morning report could not be built (${code})`);
    this.name = 'ReportBuildError';
    this.code = code;
  }
}

export interface ReportSchedulerOptions {
  db: Db;
  clock: Clock;
  log: Logger;
  sender: ReportSender;
  /**
   * When the report goes out. A getter is read once at the start of every tick (and by health()), so a change made from
   * the dashboard applies from the next tick; a plain object stays fixed, as before.
   */
  settings: ReportSettings | (() => ReportSettings);
  /** The health line the tracker view is loaded with (Health.workbookLine). The short text does not show it. */
  healthLine: () => HealthLine;
  /** Test seam: replaces building the text from the tracker. */
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
  /** The spare-number sender; replaced in place when the spare phone is linked from the dashboard. */
  #sender: ReportSender;

  constructor(o: ReportSchedulerOptions) {
    this.#o = o;
    this.#sender = o.sender;
  }

  /** The current sender's masked recipient ("…5678"). */
  maskedRecipient(): string {
    return this.#sender.maskedRecipient();
  }

  /** The sender the next tick uses (its status shows on the dashboard's Connections screen). */
  sender(): ReportSender {
    return this.#sender;
  }

  /** Resolves once no send is in flight (at once when none is). */
  async whenIdle(): Promise<void> {
    while (this.#inFlight) await this.#inFlight.catch(() => undefined);
  }

  /**
   * A newly linked spare phone's sender (D3), used from the next tick. A send already in flight finishes with the sender
   * it started with. The old sender is stopped unless a send is using it (it then disconnects by itself afterwards).
   */
  replaceSender(next: ReportSender): void {
    const old = this.#sender;
    if (old === next) return;
    this.#sender = next;
    if (!this.#inFlight) {
      void old.stop().catch((err: unknown) => this.#o.log.error({ err }, 'stopping the replaced report sender failed'));
    }
  }

  /** At service start: a row still 'sending' was cut off by a crash or a stop mid-send, so its outcome is unknown. */
  recover(now: Date = this.#o.clock.now()): void {
    const count = markInterruptedReports(this.#o.db, now.toISOString());
    this.#recovered = true; // only after the rows are marked (tests/report/scheduler.test.ts)
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

  /** The settings in force now: the getter's answer, or the fixed object. */
  #settings(): ReportSettings {
    const s = this.#o.settings;
    return typeof s === 'function' ? s() : s;
  }

  /** Today's line for Health. Never throws: a settings getter that fails gives a plain line. */
  health(now: Date = this.#o.clock.now()): ReportHealth {
    const recipientMasked = this.#sender.maskedRecipient();
    let settings: ReportSettings;
    try {
      settings = this.#settings();
    } catch (err) {
      this.#o.log.error({ err }, 'morning report settings could not be read');
      return { text: 'Morning report: settings could not be read', warning: null, recipientMasked };
    }
    if (!settings.enabled) return { text: 'Morning report: off', warning: null, recipientMasked };
    return { ...describeReport(reportFor(this.#o.db, istDate(now)), now, settings, this.#sender.status().state), recipientMasked };
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
        this.#sender.stop(),
        new Promise<void>((resolve) => {
          stopTimer = setTimeout(resolve, Math.min(3_000, waitMs));
        }),
      ]);
    } catch (err) {
      this.#o.log.error({ err }, 'stopping the report sender failed');
    } finally {
      clearTimeout(stopTimer);
    }
    // Stopping the sender ends a send in its linger (its id already back) or cuts one off. Give it up to 2 s more to
    // record its outcome, so a report that went out is 'sent' before main.ts closes the database.
    if (inFlight) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([inFlight, new Promise<void>((resolve) => (timer = setTimeout(resolve, Math.min(2_000, waitMs))))]);
      clearTimeout(timer);
    }
  }

  async #run(now: Date): Promise<void> {
    const { db, log } = this.#o;
    try {
      // Read once, inside the try: a getter that throws is logged like any other tick failure, and one tick never mixes
      // two versions of the settings.
      const settings = this.#settings();
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
        // A request lives 5 minutes. An older one (left behind by a service that was stopping, then started much later)
        // or one without its time is dropped: the owner asked for a report then, not now.
        const request = parseReportRequest(requested);
        if (!request || Math.abs(now.getTime() - request.requestedAt.getTime()) > REPORT_REQUEST_MAX_AGE_MS) {
          log.info({ date }, 'send-now request ignored: it expired (older than 5 minutes) or has no request time');
          return 'schedule';
        }
        // Honoured only while today's row is exactly what the owner confirmed: a send that started after the
        // confirmation and ended unknown changes the row, and must never be followed by a second report.
        if (request.confirmed !== reportRequestValue(date, reportFor(db, date))) {
          log.info({ date }, 'send-now request ignored: it is not for today, or today changed since it was confirmed');
          return 'schedule';
        }
        // A stale 'sending' row is a send whose outcome could not be recorded (no send is in flight here: tick returns
        // while one is). Status shows it as unknown, so it becomes unknown first and the request can take it, as it
        // would take any unknown row the owner confirmed.
        if (isStaleSending(reportFor(db, date), now) && finishReport(db, date, 'unknown', 'not_recorded', at)) {
          log.warn({ date }, 'morning report outcome was never recorded; marked unknown before the send-now request');
        }
        if (claimReport(db, date, at, { force: true })) return 'send';
        log.info({ date }, 'send-now request ignored: today is already sent or being sent');
        return 'done';
      });
      if (step === 'send') await this.#send(date, now);
      if (step !== 'schedule') return;
      // On a day that is not a report day the scheduled path creates nothing: no claim, no row, no skipped row. A row
      // that exists on such a day was made by a send-now request, and keeps the usual retry and deadline rules.
      if (!isReportDay(date, settings.days) && !reportFor(db, date)) return;
      const hm = istTime(now);
      if (hm < settings.time) return;
      if (hm >= settings.deadline) {
        const row = reportFor(db, date);
        // No send is in flight here (tick returns while one is), so a stale 'sending' row is a send whose outcome could
        // not be recorded. It may have gone out: unknown, never skipped and never retried.
        if (isStaleSending(row, now)) {
          if (finishReport(db, date, 'unknown', 'not_recorded', at)) log.warn({ date }, 'morning report outcome was never recorded; marked unknown, not retried');
          return;
        }
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
    const { db, log } = this.#o;
    const sender = this.#sender;
    let payload: ReportPayload;
    try {
      payload = await (this.#o.build ?? ((n: Date) => this.#build(n)))(now);
    } catch (err) {
      if (err instanceof ReportBuildError) {
        log.warn({ code: err.code }, 'morning report could not be built');
        this.#retry(date, err.code);
      } else {
        log.error({ err }, 'morning report could not be built');
        this.#retry(date, 'build_failed');
      }
      return;
    }
    if (this.#stopped) {
      this.#retry(date, 'stopped'); // stop() arrived during the build: nothing has been sent yet, so start no send
      return;
    }
    let result: SendResult;
    try {
      result = await sender.sendReport(payload.text);
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

  /** Throws ReportBuildError('no_tracker_link') while the tracker is not on Drive: the text has nothing to link to. */
  async #build(now: Date): Promise<ReportPayload> {
    const link = trackerLink(this.#o.db);
    if (!link) throw new ReportBuildError('no_tracker_link');
    const view = loadTrackerView(this.#o.db, now, this.#o.healthLine());
    return { text: buildShortMorningText(view, view.today, link) };
  }
}
