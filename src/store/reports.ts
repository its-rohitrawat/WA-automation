import type { Db } from './db.ts';

export type ReportStatus = 'sending' | 'sent' | 'retry' | 'unknown' | 'skipped';

/** kv key: `report send-now` stores today's IST date here, and the service's next tick takes it. */
export const REPORT_REQUEST_KEY = 'report_send_requested';

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

export function reportFor(db: Db, date: string): ReportRow | undefined {
  const r = db.prepare('SELECT * FROM reports WHERE date = ?').get(date) as RawReport | undefined;
  return r ? toRow(r) : undefined;
}

/** Newest date first. */
export function recentReports(db: Db, limit: number): ReportRow[] {
  return (db.prepare('SELECT * FROM reports ORDER BY date DESC LIMIT ?').all(limit) as RawReport[]).map(toRow);
}

/**
 * Claims the report for an IST date by setting it to 'sending'. It is one statement, so two callers can never both win.
 * Normal claim: only a date with no row, or a 'retry' row whose wait is over. Forced claim (`report send-now`): also an
 * 'unknown' or 'skipped' row, or a 'retry' row still waiting. Never a 'sent' or 'sending' row.
 * Returns true when this call claimed the date.
 */
export function claimReport(db: Db, date: string, at: string, opts: { force?: boolean } = {}): boolean {
  const reclaim = opts.force ? "reports.status IN ('retry', 'unknown', 'skipped')" : "reports.status = 'retry' AND reports.next_attempt_at <= @at";
  const info = db
    .prepare(`INSERT INTO reports (date, status, attempts, forced, created_at, updated_at)
      VALUES (@date, 'sending', 1, @forced, @at, @at)
      ON CONFLICT (date) DO UPDATE SET status = 'sending', attempts = reports.attempts + 1, next_attempt_at = NULL, forced = @forced,
        updated_at = @at
      WHERE ${reclaim}`)
    .run({ date, at, forced: opts.force ? 1 : 0 });
  return info.changes === 1;
}

/** 'sending' becomes 'sent' or 'unknown'. Returns false, changing nothing, when the row is not 'sending'. */
export function finishReport(db: Db, date: string, status: 'sent' | 'unknown', detail: string | null, at: string): boolean {
  const info = db
    .prepare("UPDATE reports SET status = @status, detail = @detail, next_attempt_at = NULL, updated_at = @at WHERE date = @date AND status = 'sending'")
    .run({ date, status, detail, at });
  return info.changes === 1;
}

/** 'sending' becomes 'retry': a definite failure before anything left. A normal claim takes it again from nextAttemptAt. */
export function retryReport(db: Db, date: string, detail: string, nextAttemptAt: string, at: string): boolean {
  const info = db
    .prepare("UPDATE reports SET status = 'retry', detail = @detail, next_attempt_at = @nextAttemptAt, updated_at = @at WHERE date = @date AND status = 'sending'")
    .run({ date, detail, nextAttemptAt, at });
  return info.changes === 1;
}

/** Past the deadline: no row, or a 'retry' row, becomes 'skipped'. A 'sent', 'sending', 'unknown' or 'skipped' row is left as it is. */
export function skipReport(db: Db, date: string, reason: string, at: string): boolean {
  const info = db
    .prepare(`INSERT INTO reports (date, status, detail, created_at, updated_at) VALUES (@date, 'skipped', @reason, @at, @at)
      ON CONFLICT (date) DO UPDATE SET status = 'skipped', detail = @reason, next_attempt_at = NULL, updated_at = @at
      WHERE reports.status = 'retry'`)
    .run({ date, reason, at });
  return info.changes === 1;
}

/** At service start: a row still 'sending' was cut off mid-send, so its outcome is unknown. Returns how many rows changed. */
export function markInterruptedReports(db: Db, at: string): number {
  return db.prepare("UPDATE reports SET status = 'unknown', detail = 'interrupted', updated_at = ? WHERE status = 'sending'").run(at).changes;
}

/** A 'retry' row of an earlier date (the service stopped before its deadline) becomes 'skipped' and keeps its reason. */
export function closeOldRetries(db: Db, beforeDate: string, at: string): number {
  return db
    .prepare("UPDATE reports SET status = 'skipped', next_attempt_at = NULL, updated_at = @at WHERE status = 'retry' AND date < @beforeDate")
    .run({ beforeDate, at }).changes;
}
