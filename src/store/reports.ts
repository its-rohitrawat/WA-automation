import type { Db, Sql } from './db.ts';

export type ReportStatus = 'sending' | 'sent' | 'retry' | 'unknown' | 'skipped';

/**
 * kv key: `report send-now` stores a request here (see reportRequest), and the service's next tick takes it. An empty
 * value means no request.
 */
export const REPORT_REQUEST_KEY = 'report_send_requested';

/** How long a send-now request stays valid. An older one (for example left behind by a stopping service) is ignored. */
export const REPORT_REQUEST_MAX_AGE_MS = 5 * 60_000;

/**
 * The confirmed part of a send-now request: the IST date plus the row state the owner saw when confirming
 * (`date|status|updatedAt`, `date|none|` when there was no row). The service honours a request only while today's row is
 * still exactly that state, so a request confirmed before a send whose outcome became unknown can never send a second
 * report.
 */
export function reportRequestValue(date: string, row: ReportRow | undefined): string {
  return `${date}|${row?.status ?? 'none'}|${row?.updatedAt ?? ''}`;
}

/** The stored send-now request: reportRequestValue plus the time of the request, `date|status|updatedAt|requestedAt`. */
export function reportRequest(date: string, row: ReportRow | undefined, requestedAt: Date): string {
  return `${reportRequestValue(date, row)}|${requestedAt.toISOString()}`;
}

/** Splits a stored request into its confirmed part and its time. Undefined for any other form (such as one without a time). */
export function parseReportRequest(value: string): { confirmed: string; requestedAt: Date } | undefined {
  const parts = value.split('|');
  if (parts.length !== 4) return undefined;
  const requestedAt = new Date(parts[3]!);
  if (Number.isNaN(requestedAt.getTime())) return undefined;
  return { confirmed: parts.slice(0, 3).join('|'), requestedAt };
}

export interface ReportRow {
  /** IST date, YYYY-MM-DD. */
  date: string;
  status: ReportStatus;
  /** sent: WhatsApp message ids. retry, unknown, skipped: a reason code. Never message text or a phone number. */
  detail: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  /** True when the last claim came from `report send-now`. */
  forced: boolean;
  createdAt: string;
  updatedAt: string;
}

interface RawReport {
  date: string;
  status: ReportStatus;
  detail: string | null;
  attempts: number;
  next_attempt_at: string | null;
  forced: number;
  created_at: string;
  updated_at: string;
}

function toRow(r: RawReport): ReportRow {
  return {
    date: r.date,
    status: r.status,
    detail: r.detail,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    forced: r.forced === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function reportFor(db: Sql, date: string): Promise<ReportRow | undefined> {
  const r = await db.get<RawReport>('SELECT * FROM reports WHERE date = ?', [date]);
  return r ? toRow(r) : undefined;
}

/** Newest date first. */
export async function recentReports(db: Sql, limit: number): Promise<ReportRow[]> {
  return (await db.all<RawReport>('SELECT * FROM reports ORDER BY date DESC LIMIT ?', [limit])).map(toRow);
}

/**
 * Claims the report for an IST date by setting it to 'sending'. It is one statement, so two callers can never both win.
 * Normal claim: only a date with no row, or a 'retry' row whose wait is over. Forced claim (`report send-now`): also an
 * 'unknown' or 'skipped' row, or a 'retry' row still waiting. Never a 'sent' or 'sending' row.
 * Returns true when this call claimed the date.
 */
export async function claimReport(db: Sql, date: string, at: string, opts: { force?: boolean } = {}): Promise<boolean> {
  const reclaim = opts.force ? "reports.status IN ('retry', 'unknown', 'skipped')" : "reports.status = 'retry' AND reports.next_attempt_at <= @at";
  const info = await db.run(
    `INSERT INTO reports (date, status, attempts, forced, created_at, updated_at)
      VALUES (@date, 'sending', 1, @forced, @at, @at)
      ON CONFLICT (date) DO UPDATE SET status = 'sending', attempts = reports.attempts + 1, next_attempt_at = NULL, forced = @forced,
        updated_at = @at
      WHERE ${reclaim}`,
    { date, at, forced: opts.force ? 1 : 0 },
  );
  return info.changes === 1;
}

/** 'sending' becomes 'sent' or 'unknown'. Returns false, changing nothing, when the row is not 'sending'. */
export async function finishReport(db: Sql, date: string, status: 'sent' | 'unknown', detail: string | null, at: string): Promise<boolean> {
  const info = await db.run(
    "UPDATE reports SET status = @status, detail = @detail, next_attempt_at = NULL, updated_at = @at WHERE date = @date AND status = 'sending'",
    { date, status, detail, at },
  );
  return info.changes === 1;
}

/** 'sending' becomes 'retry': a definite failure before anything left. A normal claim takes it again from nextAttemptAt. */
export async function retryReport(db: Sql, date: string, detail: string, nextAttemptAt: string, at: string): Promise<boolean> {
  const info = await db.run(
    "UPDATE reports SET status = 'retry', detail = @detail, next_attempt_at = @nextAttemptAt, updated_at = @at WHERE date = @date AND status = 'sending'",
    { date, detail, nextAttemptAt, at },
  );
  return info.changes === 1;
}

/** Past the deadline: no row, or a 'retry' row, becomes 'skipped'. A 'sent', 'sending', 'unknown' or 'skipped' row is left as it is. */
export async function skipReport(db: Sql, date: string, reason: string, at: string): Promise<boolean> {
  const info = await db.run(
    `INSERT INTO reports (date, status, detail, created_at, updated_at) VALUES (@date, 'skipped', @reason, @at, @at)
      ON CONFLICT (date) DO UPDATE SET status = 'skipped', detail = @reason, next_attempt_at = NULL, updated_at = @at
      WHERE reports.status = 'retry'`,
    { date, reason, at },
  );
  return info.changes === 1;
}

/** At service start: a row still 'sending' was cut off mid-send, so its outcome is unknown. Returns how many rows changed. */
export async function markInterruptedReports(db: Sql, at: string): Promise<number> {
  return (await db.run("UPDATE reports SET status = 'unknown', detail = 'interrupted', updated_at = ? WHERE status = 'sending'", [at])).changes;
}

/** A 'retry' row of an earlier date (the service stopped before its deadline) becomes 'skipped' and keeps its reason. */
export async function closeOldRetries(db: Sql, beforeDate: string, at: string): Promise<number> {
  return (await db.run("UPDATE reports SET status = 'skipped', next_attempt_at = NULL, updated_at = @at WHERE status = 'retry' AND date < @beforeDate", { beforeDate, at })).changes;
}

/**
 * S1 only, removed in S1.5: reportFor and markInterruptedReports on raw, for the two synchronous readers left (the
 * Health line through ReportScheduler.health() and SettingsStore.view(), and the start-up recovery app.ts calls).
 */
export function reportForSync(db: Db, date: string): ReportRow | undefined {
  const r = db.raw.prepare('SELECT * FROM reports WHERE date = ?').get(date) as RawReport | undefined;
  return r ? toRow(r) : undefined;
}

/** S1 only, removed in S1.5: see reportForSync. */
export function markInterruptedReportsSync(db: Db, at: string): number {
  return db.raw.prepare("UPDATE reports SET status = 'unknown', detail = 'interrupted', updated_at = ? WHERE status = 'sending'").run(at).changes;
}
