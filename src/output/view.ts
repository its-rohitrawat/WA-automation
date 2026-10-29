import { displayName, fileDescription } from '../media/labels.ts';
import { listClients, type ClientRow } from '../store/clients.ts';
import type { Db } from '../store/db.ts';
import { listClientFiles } from '../store/media.ts';
import { lastMeetingByClient, listClientMeetings, listUnassigned, meetingStats } from '../store/meetings.ts';
import { lastActivity } from '../store/messages.ts';
import { listPeople, type PersonRow } from '../store/people.ts';
import { readSentimentEnabled } from '../config/prioritySettings.ts';
import { listDecisions, listTasks, priorityRank, type DecisionRow, type TaskRow } from '../store/tasks.ts';
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
  /** Null when the file is not on Drive, or when its message was deleted for everyone (D3). */
  driveFileId: string | null;
}

/** At most this many meetings in a client tab, and unassigned meetings on the Overview. */
export const CLIENT_MEETINGS_LIMIT = 100;
export const UNASSIGNED_LIMIT = 50;

/** A done meeting of a client. */
export interface MeetingView {
  id: number;
  /** IST date, YYYY-MM-DD. */
  date: string;
  title: string;
  seconds: number | null;
  docFileId: string | null;
  actionItemCount: number;
}

/** Deliberately without title or attendees: everyone who opens the workbook sees the Overview. */
export interface UnassignedView {
  id: number;
  /** IST date, YYYY-MM-DD. */
  date: string;
  seconds: number | null;
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
  /** Done meetings, newest first. */
  meetings: MeetingView[];
  people: PersonRow[];
  lastActivity: string | null;
  /** IST date (YYYY-MM-DD) of the latest done meeting. */
  lastMeeting: string | null;
  percentDone: number | null;
  overdue: number;
  maybeDone: number;
  nextDeadline: string | null;
}

export interface TrackerView {
  generatedAt: Date;
  today: string;
  health: HealthLine;
  /** Unassigned meetings, newest first; internal meetings are never listed. */
  unassigned: UnassignedView[];
  /** All unassigned meetings; more than unassigned holds past UNASSIGNED_LIMIT. */
  unassignedTotal: number;
  clients: ClientView[];
  /** Sentiment is switched on: the tracker shows each task's mood. Off or absent: the Sentiment column stays empty. */
  sentiment?: boolean;
}

export function isOverdue(t: TaskRow, today: string): boolean {
  return t.status !== 'done' && t.deadline !== null && t.deadline < today;
}

/** Priority critical to low (a task without a level by its old one), earliest deadline first (none last), then task code. */
function byUrgency(a: TaskRow, b: TaskRow): number {
  return (
    priorityRank(a) - priorityRank(b) ||
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
  const lastMeetings = lastMeetingByClient(db);
  const ordered = [...clients].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id - b.id);
  return {
    generatedAt: now,
    sentiment: readSentimentEnabled(db),
    today,
    health,
    unassigned: listUnassigned(db, UNASSIGNED_LIMIT).map((m) => ({ id: m.id, date: istDate(new Date(m.startedAt)), seconds: m.seconds })),
    unassignedTotal: meetingStats(db, now.toISOString()).unassigned,
    clients: ordered.map((client) => {
      const all = listTasks(db, client.id);
      const notDone = all.filter((t) => t.status !== 'done');
      const last = lastMeetings.get(client.id);
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
          // Owner decision D3: a file deleted for everyone loses its Drive link as well as its description. The Drive copy is kept.
          driveFileId: f.revoked ? null : f.driveFileId,
        })),
        meetings: listClientMeetings(db, client.id, CLIENT_MEETINGS_LIMIT).map((m) => ({
          id: m.id,
          date: istDate(new Date(m.startedAt)),
          title: m.title,
          seconds: m.seconds,
          docFileId: m.docFileId,
          actionItemCount: m.actionItemCount,
        })),
        people: listPeople(db, client.id),
        lastActivity: lastActivity(db, client.id),
        lastMeeting: last === undefined ? null : istDate(new Date(last)),
        percentDone: all.length ? Math.floor((100 * (all.length - notDone.length)) / all.length) : null,
        overdue: notDone.filter((t) => isOverdue(t, today)).length,
        maybeDone: notDone.filter((t) => t.status === 'maybe_done').length,
        nextDeadline: deadlines[0] ?? null,
      };
    }),
  };
}
