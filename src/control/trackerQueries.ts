import type { HealthSnapshot } from '../health/health.ts';
import { accountEmail, MAIN_ACCOUNT } from '../output/googleAuth.ts';
import { uniqueSheetNames } from '../output/sheetNames.ts';
import { DRIVE_ROOT_NAME, TRACKER_FILE_NAME, TRACKER_NEW_FILE_KEY } from '../output/trackerKey.ts';
import { trackerLink } from '../report/morningReport.ts';
import { listClients } from '../store/clients.ts';
import type { Db } from '../store/db.ts';
import { getKv } from '../store/kv.ts';
import { istDate } from '../util/time.ts';

// The dashboard's Tracker screen (D4 Task 5): the workbook link, the last upload and failure, and per-sheet counts.
// Counts follow the workbook: notDone is every task not done, as its Today tab counts "Open" (the Tasks screen and the Overview
// say open for the not-done tasks that are neither overdue nor in review); overdue (not done, deadline
// before today IST) and review (maybe done and not overdue, as the Tasks screen splits them) are parts of it.

export interface TrackerSheet {
  /** The tab's name in Tracker.xlsx: "Today", or the client's sheet name as the workbook assigns it. */
  name: string;
  client: { code: string; name: string } | null;
  /** Every task not done: the workbook's "Open". */
  notDone: number;
  overdue: number;
  review: number;
  /** Closed in the last 7 IST days, today included. */
  doneThisWeek: number;
}

/** Which file the agent writes: its name, its folder, and the main Google account's email when it is known. */
export interface TrackerFile {
  name: string;
  folder: string;
  account: string | null;
}

export interface TrackerSummary {
  uploaded: boolean;
  url: string | null;
  file: TrackerFile;
  /** When the agent last had to start a new Tracker.xlsx because the old one could not be reached; null if never. */
  newFileAt: string | null;
  lastPublishedAt: string | null;
  lastFailure: { at: string; reason: string } | null;
  failingSince: string | null;
  health: { ok: boolean; text: string } | null;
  sheets: TrackerSheet[];
}

/** "YYYY-MM-DD" minus n days (calendar dates, no time zone involved). */
function minusDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
}

const FAILURE_PREFIX = 'Tracker upload failed: ';

/** The tracker file the agent writes, for the Tracker screen and the Connections Drive card. */
export function trackerFile(db: Db): TrackerFile {
  return { name: TRACKER_FILE_NAME, folder: DRIVE_ROOT_NAME, account: accountEmail(db, MAIN_ACCOUNT) };
}

/** The stored new-file time, when it is a valid time. */
function newFileAt(db: Db): string | null {
  const v = getKv(db, TRACKER_NEW_FILE_KEY);
  return v && !Number.isNaN(Date.parse(v)) ? v : null;
}

/**
 * The last tracker upload: the agent's own audit row (it survives a restart) or the live snapshot's time (which the
 * audit log may not have yet: it is written on changes only), whichever is later. Counts no tasks.
 */
export function lastTrackerUpload(db: Db, snapshotLast: string | null | undefined): string | null {
  const published = db.prepare("SELECT MAX(at) AS at FROM audit_log WHERE actor = 'agent' AND event = 'tracker.published'").get() as { at: string | null };
  return [published.at, snapshotLast ?? null].filter((t): t is string => t !== null).sort().at(-1) ?? null;
}

/**
 * The Tracker screen. health: the live (or last persisted) snapshot, when there is one. The upload times come from the
 * agent's own audit rows (src/control/activityQueries.ts publisherAuditHooks) and the snapshot, whichever is later.
 */
export function trackerSummary(
  db: Db,
  now: Date,
  health?: Pick<HealthSnapshot, 'line' | 'lastPublishedAt' | 'publishFailingSince'>,
): TrackerSummary {
  const today = istDate(now);
  const url = trackerLink(db) ?? null;
  const failure = db
    .prepare("SELECT at, detail FROM audit_log WHERE actor = 'agent' AND event = 'tracker.publish_failed' ORDER BY at DESC, id DESC LIMIT 1")
    .get() as { at: string; detail: string } | undefined;

  const clients = listClients(db, false);
  const byId = [...clients].sort((a, b) => a.id - b.id);
  const assigned = uniqueSheetNames(byId.map((c) => c.name));
  const sheetName = new Map(byId.map((c, i) => [c.id, assigned[i]!]));
  const counts = new Map(
    (db.prepare(`SELECT client_id AS clientId,
        COALESCE(SUM(status <> 'done' AND deadline IS NOT NULL AND deadline < @today), 0) AS overdue,
        COALESCE(SUM(status = 'maybe_done' AND NOT (deadline IS NOT NULL AND deadline < @today)), 0) AS review,
        COALESCE(SUM(status <> 'done'), 0) AS notDone,
        COALESCE(SUM(status = 'done' AND closed_on BETWEEN @weekStart AND @today), 0) AS doneThisWeek
      FROM tasks GROUP BY client_id`).all({ today, weekStart: minusDays(today, 6) }) as (Omit<TrackerSheet, 'name' | 'client'> & { clientId: number })[])
      .map((r) => [r.clientId, r]),
  );
  // Tabs are in name order, as in the workbook (src/output/view.ts loadTrackerView).
  const active = clients.filter((c) => c.active).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id - b.id);
  const perClient: TrackerSheet[] = active.map((c) => {
    const n = counts.get(c.id);
    return {
      name: sheetName.get(c.id)!, client: { code: c.code, name: c.name },
      notDone: n?.notDone ?? 0, overdue: n?.overdue ?? 0, review: n?.review ?? 0, doneThisWeek: n?.doneThisWeek ?? 0,
    };
  });
  const sum = (k: 'notDone' | 'overdue' | 'review' | 'doneThisWeek') => perClient.reduce((a, s) => a + s[k], 0);

  return {
    uploaded: url !== null,
    url,
    file: trackerFile(db),
    newFileAt: newFileAt(db),
    lastPublishedAt: lastTrackerUpload(db, health?.lastPublishedAt),
    lastFailure: failure
      ? { at: failure.at, reason: failure.detail.startsWith(FAILURE_PREFIX) ? failure.detail.slice(FAILURE_PREFIX.length) : failure.detail }
      : null,
    failingSince: health?.publishFailingSince ?? null,
    health: health ? { ok: health.line.ok, text: health.line.text } : null,
    sheets: [{ name: 'Today', client: null, notDone: sum('notDone'), overdue: sum('overdue'), review: sum('review'), doneThisWeek: sum('doneThisWeek') }, ...perClient],
  };
}
