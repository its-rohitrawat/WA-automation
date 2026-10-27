import { uniqueSheetNames } from '../output/sheetNames.ts';
import { getClientByCode, listClients, type ClientRow } from '../store/clients.ts';
import type { Db } from '../store/db.ts';
import type { MeetingStatus } from '../store/meetings.ts';
import { lastActivity } from '../store/messages.ts';
import type { Status } from '../store/tasks.ts';
import { istDate, istWeekday } from '../util/time.ts';

// The dashboard's Clients screen (D2): one card per active client and the client drawer. Only counts, names, dates and
// task titles leave here: never message text, task quotes or progress notes, meeting attendees or names.

export interface ClientCounts {
  /** Not done (open or in review). */
  open: number;
  /** Deadline before today (IST) and not done. */
  overdue: number;
  /** Status maybe_done: the AI thinks it is done and a person should confirm. */
  review: number;
  /** Closed since Monday (IST) of the current week. */
  doneThisWeek: number;
}

export interface ClientCard {
  code: string;
  name: string;
  /** The WhatsApp group name from the last live list; the client name when there is none. */
  groupName: string;
  counts: ClientCounts;
  phases: string[];
  currentPhase: string | null;
  /** The latest message time for the client; null when none. */
  lastActivity: string | null;
  /** The client's tab in the tracker workbook. */
  sheetName: string;
}

export interface ClientOpenTask {
  code: string;
  title: string;
  assignedTo: string | null;
  deadline: string | null;
  status: Exclude<Status, 'done'>;
}

export interface ClientMeeting {
  id: number;
  startedAt: string;
  title: string;
  status: MeetingStatus;
}

export interface ClientDetail extends ClientCard {
  /** The tasks counted as open, deadline first (none last), then by task number. */
  openTasks: ClientOpenTask[];
  /** Meetings matched to the client, newest first (at most MEETINGS_LIMIT). */
  meetings: ClientMeeting[];
  /** When the client's latest batch that did not fail finished (its start while it still runs); null when none. */
  lastSyncAt: string | null;
}

export const MEETINGS_LIMIT = 50;

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** "YYYY-MM-DD" of the Monday (IST) of now's week. */
function weekStart(now: Date): string {
  const back = Math.max(0, WEEKDAYS.indexOf(istWeekday(now)));
  return new Date(Date.parse(`${istDate(now)}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
}

const ZERO: ClientCounts = { open: 0, overdue: 0, review: 0, doneThisWeek: 0 };

const COUNTS = `SUM(status <> 'done') AS open,
  SUM(status <> 'done' AND deadline IS NOT NULL AND deadline < @today) AS overdue,
  SUM(status = 'maybe_done') AS review,
  SUM(status = 'done' AND closed_on >= @monday) AS doneThisWeek`;

/** Every client's counts, in one pass over tasks. */
function countsByClient(db: Db, now: Date): Map<number, ClientCounts> {
  const rows = db
    .prepare(`SELECT client_id AS id, ${COUNTS} FROM tasks GROUP BY client_id`)
    .all({ today: istDate(now), monday: weekStart(now) }) as (ClientCounts & { id: number })[];
  return new Map(rows.map(({ id, ...c }) => [id, c]));
}

/** One client's counts: its own WHERE client_id = ?, so the tasks_client_status index is used. */
function countsForClient(db: Db, now: Date, clientId: number): Map<number, ClientCounts> {
  const row = db
    .prepare(`SELECT ${COUNTS} FROM tasks WHERE client_id = @clientId`)
    .get({ today: istDate(now), monday: weekStart(now), clientId }) as { [K in keyof ClientCounts]: number | null };
  // SUM over no rows is NULL.
  return new Map([[clientId, { open: row.open ?? 0, overdue: row.overdue ?? 0, review: row.review ?? 0, doneThisWeek: row.doneThisWeek ?? 0 }]]);
}

/** The latest message time per client, in one statement. */
function lastActivityByClient(db: Db): Map<number, string> {
  const rows = db.prepare('SELECT client_id AS id, MAX(ts) AS ts FROM messages GROUP BY client_id').all() as { id: number; ts: string }[];
  return new Map(rows.map((r) => [r.id, r.ts]));
}

/** Tracker tab names, assigned as the tracker does: in id order over every client, active or not (output/view.ts). */
function sheetNames(db: Db): Map<number, string> {
  const byId = listClients(db, false).sort((a, b) => a.id - b.id);
  const names = uniqueSheetNames(byId.map((c) => c.name));
  return new Map(byId.map((c, i) => [c.id, names[i]!]));
}

function card(
  c: ClientRow,
  counts: Map<number, ClientCounts>,
  latest: ReadonlyMap<number, string | null>,
  sheets: Map<number, string>,
  groupNames?: ReadonlyMap<string, string>,
): ClientCard {
  return {
    code: c.code,
    name: c.name,
    groupName: groupNames?.get(c.groupId) || c.name,
    counts: { ...(counts.get(c.id) ?? ZERO) },
    phases: [...c.phases],
    currentPhase: c.currentPhase,
    lastActivity: latest.get(c.id) ?? null,
    sheetName: sheets.get(c.id) ?? c.name,
  };
}

/** One card per active client, by name. groupNames: group id → WhatsApp group name, from the last live list. */
export function clientCards(db: Db, now: Date, groupNames?: ReadonlyMap<string, string>): ClientCard[] {
  const counts = countsByClient(db, now);
  const latest = lastActivityByClient(db);
  const sheets = sheetNames(db);
  return listClients(db, true).map((c) => card(c, counts, latest, sheets, groupNames));
}

/** The client drawer for an active client; null for an unknown or inactive code. */
export function clientDetail(db: Db, code: string, now: Date, groupNames?: ReadonlyMap<string, string>): ClientDetail | null {
  const c = getClientByCode(db, code);
  if (!c || !c.active) return null;
  const base = card(c, countsForClient(db, now, c.id), new Map([[c.id, lastActivity(db, c.id)]]), sheetNames(db), groupNames);
  const openTasks = db
    .prepare(`SELECT code, title, assigned_to AS assignedTo, deadline, status FROM tasks
      WHERE client_id = ? AND status <> 'done' ORDER BY deadline IS NULL, deadline, id`)
    .all(c.id) as ClientOpenTask[];
  const meetings = db
    .prepare('SELECT id, started_at AS startedAt, title, status FROM meetings WHERE client_id = ? ORDER BY started_at DESC, id DESC LIMIT ?')
    .all(c.id, MEETINGS_LIMIT) as ClientMeeting[];
  const batch = db
    .prepare("SELECT started_at AS startedAt, finished_at AS finishedAt FROM batches WHERE client_id = ? AND status <> 'failed' ORDER BY id DESC LIMIT 1")
    .get(c.id) as { startedAt: string; finishedAt: string | null } | undefined;
  return { ...base, openTasks, meetings, lastSyncAt: batch ? (batch.finishedAt ?? batch.startedAt) : null };
}
