import { uniqueSheetNames } from '../output/sheetNames.ts';
import { getClientByCode, listClients, type ClientRow } from '../store/clients.ts';
import type { Db } from '../store/db.ts';
import { backfillStatus, listBackfills, type BackfillState, type BackfillStatus } from '../store/historyBackfill.ts';
import type { MeetingStatus } from '../store/meetings.ts';
import { lastActivity } from '../store/messages.ts';
import { readSentimentEnabled } from '../config/prioritySettings.ts';
import type { Priority, Sentiment, Status } from '../store/tasks.ts';
import { istDate, istWeekday } from '../util/time.ts';

// The dashboard's Clients screen (D2): one card per active client and the client drawer. Counts, names, dates and task
// titles leave here, and (owner decision, 28 Oct 2026) the drawer's last three messages of the group, cut to one short
// line, with the sender's saved name only. Never task quotes or progress notes, meeting attendees, or a phone number.
// All of it goes to the owner-guarded API only; none of it to logs or the audit log.

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
  /** Reading the group's earlier messages after it was approved (up to 7 days back); null when there is nothing to say. */
  history: BackfillStatus;
  /** The card's status line: messages waiting for the next batch, when the group was last read, the quiet minutes. */
  pulse: ClientPulse;
}

export interface ClientPulse {
  /** Stored messages the AI has not read yet. */
  pending: number;
  /** When the latest batch that worked finished; null before the first. */
  lastReadAt: string | null;
  /** QUIET_MINUTES: a group's batch runs this long after its last message. */
  quietMinutes: number;
}

export interface ClientOpenTask {
  code: string;
  title: string;
  assignedTo: string | null;
  deadline: string | null;
  status: Exclude<Status, 'done'>;
  /** null for a task from before priority levels. */
  priority: Priority | null;
  /** The client's mood about the task; null while sentiment is off. */
  sentiment: Sentiment | null;
}

export interface ClientMeeting {
  id: number;
  startedAt: string;
  title: string;
  status: MeetingStatus;
}

/** One of the group's latest messages, as the client drawer shows it. */
export interface ClientMessage {
  /** The sender's saved name (people), "Founder" for the founder's own, or "Someone": never a phone number. */
  sender: string;
  /** text, or a file, photo, voice note, location and so on (the text is then empty or a caption). */
  kind: 'text' | 'image' | 'video' | 'document' | 'sticker' | 'voice' | 'audio' | 'location' | 'contact' | 'poll' | 'event' | 'other';
  /** One line, at most MESSAGE_CHARS characters (with "…" when cut); empty for a file without a caption. */
  text: string;
  /** A voice note's or audio file's length, when known. */
  seconds: number | null;
  /** A voice note or audio file was transcribed. */
  transcribed: boolean;
  at: string;
}

/** What the agent has seen of a client's group: the drawer's status line, last-7-days numbers and latest messages. */
export interface ClientActivity {
  /** Messages stored and not yet read by the AI (the next batch). */
  pending: number;
  /** How long a group must be quiet before its batch runs (QUIET_MINUTES). */
  quietMinutes: number;
  /** The latest batch that worked: when it finished, how many messages it read, how many tasks it added or changed. */
  lastBatch: { at: string; messages: number; taskChanges: number } | null;
  /** Every task the client has ever had (done ones too): 0 means none was ever found. */
  taskCount: number;
  /** The last 7 days: messages (not deleted), distinct senders, files and photos, voice notes. */
  week: { messages: number; people: number; files: number; voice: number };
  /** Newest first, at most LATEST_MESSAGES. */
  latest: ClientMessage[];
  /** When the group was approved, if this approval was recorded (approvals since the 7-day history began). */
  approvedAt: string | null;
  /** The 7-day history read on approval: its state and how many earlier messages it found; null when there was none. */
  history: { state: BackfillState; found: number } | null;
}

export interface ClientDetail extends ClientCard {
  /** The client's mood in its latest batch that judged it, and when; null while sentiment is off or before any. */
  sentiment: { mood: Sentiment; at: string | null } | null;
  /** The tasks counted as open, deadline first (none last), then by task number. */
  openTasks: ClientOpenTask[];
  /** Meetings matched to the client, newest first (at most MEETINGS_LIMIT). */
  meetings: ClientMeeting[];
  /** When the client's latest batch that did not fail finished (its start while it still runs); null when none. */
  lastSyncAt: string | null;
  activity: ClientActivity;
}

export const MEETINGS_LIMIT = 50;
export const LATEST_MESSAGES = 3;
export const MESSAGE_CHARS = 160;
const WEEK_MS = 7 * 86_400_000;
const MEDIA_KINDS = new Set(['image', 'video', 'document', 'sticker', 'voice', 'audio']);
/** Message kinds with no file and usually no text (wa/normalize.ts): named, so their bubble is never blank. */
const OTHER_KINDS = new Set(['location', 'contact', 'poll', 'event']);
/** Seven digits or more in a name (separators aside) is a phone number in it: such a name is never shown. */
const HAS_NUMBER = /(?:\d[\s().+-]*){7,}/;
const SENDER_CHARS = 60;
// Control characters, line and paragraph breaks, direction marks and zero-width spaces become spaces: the line stays one
// line of plain text. Joiners (ZWJ, ZWNJ) and emoji tags stay, so emoji sequences and Indic conjuncts keep their shape.
const UNPRINTABLE = /[\p{Cc}\u2028\u2029\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]+/gu;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** One line of at most max visible characters (whole graphemes: never half an emoji or a conjunct), "…" when cut. */
export function oneLine(text: string | null, max = MESSAGE_CHARS): string {
  const s = (text ?? '').replace(UNPRINTABLE, ' ').replace(/\s+/g, ' ').trim();
  const parts = Array.from(graphemes.segment(s), (g) => g.segment);
  return parts.length > max ? `${parts.slice(0, max - 1).join('').trimEnd()}…` : s;
}

/** The kind a stored message shows as: its media's kind, else its message type, else text. Shared with Open chat. */
export function messageKind(kind: string | null, mediaType: string | null): ClientMessage['kind'] {
  return (kind && MEDIA_KINDS.has(kind) ? kind
    : mediaType && (MEDIA_KINDS.has(mediaType) || OTHER_KINDS.has(mediaType)) ? mediaType : mediaType ? 'other' : 'text') as ClientMessage['kind'];
}

/** The sender as shown: the saved name, cleaned, never one holding a phone number; else Founder or Someone. Shared with Open chat. */
export function senderLabel(name: string | null, fromMe: boolean): string {
  // Cleaned first, so marks around a number can't hide it.
  const n = oneLine(name, SENDER_CHARS);
  return n && !HAS_NUMBER.test(n) ? n : fromMe ? 'Founder' : 'Someone';
}

/** What the drawer shows about the client's group (see ClientActivity). Parameterised reads only. */
export async function clientActivity(db: Db, c: ClientRow, now: Date, quietMinutes: number): Promise<ClientActivity> {
  const since = new Date(now.getTime() - WEEK_MS).toISOString();
  const pending = (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE client_id = ? AND processed_at IS NULL AND revoked = 0', [c.id]))!.n;
  const batch = await db.get<{ at: string; messages: number }>(
    "SELECT finished_at AS at, message_count AS messages FROM batches WHERE client_id = ? AND status = 'ok' AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1",
    [c.id],
  );
  // The batch's own task changes: its task events carry its finish time (reconciler: one appliedAt for both). Decisions,
  // phases, people's roles and reminders are not task changes.
  const taskChanges = batch
    ? (await db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM task_events WHERE client_id = ? AND actor = 'ai' AND at = ? AND task_id IS NOT NULL AND op <> 'log_reminder'",
      [c.id, batch.at],
    ))!.n
    : 0;
  const taskCount = (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE client_id = ?', [c.id]))!.n;
  const week = (await db.get<{ messages: number; people: number; files: number | null; voice: number | null }>(
    `SELECT COUNT(*) AS messages, COUNT(DISTINCT m.sender_jid) AS people,
        SUM(COALESCE(md.kind, m.media_type) IN ('image', 'video', 'document', 'audio')) AS files, SUM(COALESCE(md.kind, m.media_type) = 'voice') AS voice
      FROM messages m LEFT JOIN media md ON md.message_id = m.id
      WHERE m.client_id = ? AND m.revoked = 0 AND m.ts >= ?`,
    [c.id, since],
  ))!;
  const rows = await db.all<{
    at: string; text: string | null; fromMe: number; mediaType: string | null; name: string | null;
    kind: string | null; seconds: number | null; mediaStatus: string | null; hasText: number | null;
  }>(
    `SELECT m.ts AS at, m.text, m.from_me AS fromMe, m.media_type AS mediaType, p.name AS name,
        md.kind, md.seconds, md.status AS mediaStatus, md.text IS NOT NULL AS hasText
      FROM messages m
      LEFT JOIN people p ON p.client_id = m.client_id AND p.jid = m.sender_jid
      LEFT JOIN media md ON md.message_id = m.id
      WHERE m.client_id = ? AND m.revoked = 0 ORDER BY m.ts DESC, m.id DESC LIMIT ?`,
    [c.id, LATEST_MESSAGES],
  );
  const latest = rows.map((r): ClientMessage => {
    const kind = messageKind(r.kind, r.mediaType);
    const sender = senderLabel(r.name, r.fromMe === 1);
    const audio = kind === 'voice' || kind === 'audio';
    return {
      sender, kind, text: oneLine(r.text), seconds: audio && Number.isInteger(r.seconds) ? r.seconds : null,
      transcribed: audio && r.mediaStatus === 'done' && r.hasText === 1, at: r.at,
    };
  });
  const backfill = (await listBackfills(db)).find((b) => b.clientId === c.id && b.groupId === c.groupId);
  return {
    pending,
    quietMinutes,
    lastBatch: batch ? { at: batch.at, messages: batch.messages, taskChanges } : null,
    taskCount,
    week: { messages: week.messages, people: week.people, files: week.files ?? 0, voice: week.voice ?? 0 },
    latest,
    approvedAt: backfill?.until ?? null,
    history: backfill ? { state: backfill.state, found: backfill.found } : null,
  };
}

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
async function countsByClient(db: Db, now: Date): Promise<Map<number, ClientCounts>> {
  const rows = await db.all<ClientCounts & { id: number }>(`SELECT client_id AS id, ${COUNTS} FROM tasks GROUP BY client_id`, { today: istDate(now), monday: weekStart(now) });
  return new Map(rows.map(({ id, ...c }) => [id, c]));
}

/** One client's counts: its own WHERE client_id = ?, so the tasks_client_status index is used. */
async function countsForClient(db: Db, now: Date, clientId: number): Promise<Map<number, ClientCounts>> {
  const row = (await db.get<{ [K in keyof ClientCounts]: number | null }>(
    `SELECT ${COUNTS} FROM tasks WHERE client_id = @clientId`,
    { today: istDate(now), monday: weekStart(now), clientId },
  ))!;
  // SUM over no rows is NULL.
  return new Map([[clientId, { open: row.open ?? 0, overdue: row.overdue ?? 0, review: row.review ?? 0, doneThisWeek: row.doneThisWeek ?? 0 }]]);
}

/** The latest message time per client, in one statement. */
async function lastActivityByClient(db: Db): Promise<Map<number, string>> {
  const rows = await db.all<{ id: number; ts: string }>('SELECT client_id AS id, MAX(ts) AS ts FROM messages GROUP BY client_id');
  return new Map(rows.map((r) => [r.id, r.ts]));
}

/** Tracker tab names, assigned as the tracker does: in id order over every client, active or not (output/view.ts). */
async function sheetNames(db: Db): Promise<Map<number, string>> {
  const byId = (await listClients(db, false)).sort((a, b) => a.id - b.id);
  const names = uniqueSheetNames(byId.map((c) => c.name));
  return new Map(byId.map((c, i) => [c.id, names[i]!]));
}

/** Unread messages per client, in one statement (the messages_unprocessed index). */
async function pendingByClient(db: Db): Promise<Map<number, number>> {
  const rows = await db.all<{ id: number; n: number }>('SELECT client_id AS id, COUNT(*) AS n FROM messages WHERE processed_at IS NULL AND revoked = 0 GROUP BY client_id');
  return new Map(rows.map((r) => [r.id, r.n]));
}

/** When each client's latest batch that worked finished, in one statement. */
async function lastReadByClient(db: Db): Promise<Map<number, string>> {
  const rows = await db.all<{ id: number; at: string }>("SELECT client_id AS id, MAX(finished_at) AS at FROM batches WHERE status = 'ok' AND finished_at IS NOT NULL GROUP BY client_id");
  return new Map(rows.map((r) => [r.id, r.at]));
}

function card(
  c: ClientRow,
  counts: Map<number, ClientCounts>,
  latest: ReadonlyMap<number, string | null>,
  sheets: Map<number, string>,
  groupNames?: ReadonlyMap<string, string>,
  history: BackfillStatus = null,
  pulse: ClientPulse = { pending: 0, lastReadAt: null, quietMinutes: 4 },
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
    history,
    pulse,
  };
}

/** One card per active client, by name. groupNames: group id → WhatsApp group name, from the last live list. */
export async function clientCards(db: Db, now: Date, groupNames?: ReadonlyMap<string, string>, quietMinutes = 4): Promise<ClientCard[]> {
  const counts = await countsByClient(db, now);
  const latest = await lastActivityByClient(db);
  const sheets = await sheetNames(db);
  const pending = await pendingByClient(db);
  const read = await lastReadByClient(db);
  return Promise.all((await listClients(db, true)).map(async (c) =>
    card(c, counts, latest, sheets, groupNames, await backfillStatus(db, c.id, now), { pending: pending.get(c.id) ?? 0, lastReadAt: read.get(c.id) ?? null, quietMinutes }),
  ));
}

/** The client drawer for an active client; null for an unknown or inactive code. */
export async function clientDetail(db: Db, code: string, now: Date, groupNames?: ReadonlyMap<string, string>, quietMinutes = 4): Promise<ClientDetail | null> {
  const c = await getClientByCode(db, code);
  if (!c || !c.active) return null;
  const activity = await clientActivity(db, c, now, quietMinutes);
  const pulse = { pending: activity.pending, lastReadAt: activity.lastBatch?.at ?? null, quietMinutes };
  const base = card(c, await countsForClient(db, now, c.id), new Map([[c.id, await lastActivity(db, c.id)]]), await sheetNames(db), groupNames, await backfillStatus(db, c.id, now), pulse);
  // Sentiment is shown only while it is switched on: off, none leaves here.
  const moods = await readSentimentEnabled(db);
  const openTasks = (await db.all<ClientOpenTask>(
    `SELECT code, title, assigned_to AS assignedTo, deadline, status, priority_level AS priority, sentiment FROM tasks
      WHERE client_id = ? AND status <> 'done' ORDER BY deadline IS NULL, deadline, id`,
    [c.id],
  )).map((t) => (moods ? t : { ...t, sentiment: null }));
  const meetings = await db.all<ClientMeeting>(
    'SELECT id, started_at AS startedAt, title, status FROM meetings WHERE client_id = ? ORDER BY started_at DESC, id DESC LIMIT ?',
    [c.id, MEETINGS_LIMIT],
  );
  const batch = await db.get<{ startedAt: string; finishedAt: string | null }>(
    "SELECT started_at AS startedAt, finished_at AS finishedAt FROM batches WHERE client_id = ? AND status <> 'failed' ORDER BY id DESC LIMIT 1",
    [c.id],
  );
  const sentiment = moods && c.sentiment ? { mood: c.sentiment, at: c.sentimentAt } : null;
  return { ...base, sentiment, openTasks, meetings, lastSyncAt: batch ? (batch.finishedAt ?? batch.startedAt) : null, activity };
}
