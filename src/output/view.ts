import { displayName, fileDescription } from '../media/labels.ts';
import { listClients, type ClientRow } from '../store/clients.ts';
import type { Db } from '../store/db.ts';
import { listClientFiles } from '../store/media.ts';
import { lastActivity } from '../store/messages.ts';
import { listPeople, type PersonRow } from '../store/people.ts';
import { listDecisions, listTasks, type DecisionRow, type TaskRow } from '../store/tasks.ts';
import { istDate } from '../util/time.ts';
import { uniqueSheetNames } from './sheetNames.ts';

export interface HealthLine {
  ok: boolean;
  text: string;
}

export interface FileView {
  /** IST date, YYYY-MM-DD. */
  date: string;
  sentBy: string;
  name: string;
  description: string;
  driveFileId: string | null;
}

export interface ClientView {
  client: ClientRow;
  sheetName: string;
  usOpen: TaskRow[];
  clientOpen: TaskRow[];
  done: TaskRow[];
  decisions: DecisionRow[];
  /** Files received from client members (spec §8.3), newest first. */
  files: FileView[];
  people: PersonRow[];
  lastActivity: string | null;
  percentDone: number | null;
  overdue: number;
  maybeDone: number;
  nextDeadline: string | null;
}

export interface TrackerView {
  generatedAt: Date;
  today: string;
  health: HealthLine;
  clients: ClientView[];
}

export function isOverdue(t: TaskRow, today: string): boolean {
  return t.status !== 'done' && t.deadline !== null && t.deadline < today;
}

const PRIORITY_RANK: Record<TaskRow['priority'], number> = { high: 0, medium: 1, low: 2 };

/** Priority high to low, earliest deadline first (none last), then task code. */
function byUrgency(a: TaskRow, b: TaskRow): number {
  return (
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
    (a.deadline ?? '9999-99-99').localeCompare(b.deadline ?? '9999-99-99') ||
    a.id - b.id
  );
}

/** Newest closing date first, then task code. */
function byClosed(a: TaskRow, b: TaskRow): number {
  return (b.closedOn ?? '').localeCompare(a.closedOn ?? '') || a.id - b.id;
}

/** Inactive clients stay in the workbook, marked "(inactive)". Tabs are in name order. */
export function loadTrackerView(db: Db, now: Date, health: HealthLine): TrackerView {
  const today = istDate(now);
  const clients = listClients(db, false);
  // Sheet names are assigned in id (creation) order so a new client never changes an existing suffix.
  const byId = [...clients].sort((a, b) => a.id - b.id);
  const assigned = uniqueSheetNames(byId.map((c) => c.name));
  const sheetNames = new Map(byId.map((c, i) => [c.id, assigned[i]!]));
  const ordered = [...clients].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id - b.id);
  return {
    generatedAt: now,
    today,
    health,
    clients: ordered.map((client) => {
      const all = listTasks(db, client.id);
      const notDone = all.filter((t) => t.status !== 'done');
      const deadlines = notDone.map((t) => t.deadline).filter((d): d is string => d !== null).sort();
      return {
        client,
        sheetName: sheetNames.get(client.id)!,
        usOpen: notDone.filter((t) => t.side === 'us').sort(byUrgency),
        clientOpen: notDone.filter((t) => t.side === 'client').sort(byUrgency),
        done: all.filter((t) => t.status === 'done').sort(byClosed),
        decisions: listDecisions(db, client.id),
        files: listClientFiles(db, client.id).map((f) => ({
          date: istDate(new Date(f.ts)),
          sentBy: f.sender ?? 'Unknown',
          name: displayName({ kind: f.kind, fileName: f.fileName, mimeType: f.mimeType, ts: f.ts, mediaId: f.id }),
          description: fileDescription(f),
          driveFileId: f.driveFileId,
        })),
        people: listPeople(db, client.id),
        lastActivity: lastActivity(db, client.id),
        percentDone: all.length ? Math.floor((100 * (all.length - notDone.length)) / all.length) : null,
        overdue: notDone.filter((t) => isOverdue(t, today)).length,
        maybeDone: notDone.filter((t) => t.status === 'maybe_done').length,
        nextDeadline: deadlines[0] ?? null,
      };
    }),
  };
}
