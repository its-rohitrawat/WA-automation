import { readSentimentEnabled } from '../config/prioritySettings.ts';
import type { Db } from '../store/db.ts';
import { PRIORITIES, TASK_FIELDS, type Category, type Priority, type PrioritySource, type Sentiment, type Side, type TaskField } from '../store/tasks.ts';
import { istDate } from '../util/time.ts';
import { ControlError } from './errors.ts';

// The dashboard's Tasks screen (D4 Task 1): plain parameterised SQL. Titles, quotes and progress notes are untrusted
// text: they go back as JSON strings for the browser to show as text, never as HTML. History is told in fixed words and
// never repeats an event's stored detail, which can hold words from the chat.

export const TASK_STATUSES = ['overdue', 'open', 'review', 'done'] as const;
export type DashboardTaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_DEADLINES = ['past', 'week', 'none'] as const;
export const TASK_SORTS = ['deadline', 'code', 'client', 'owner', 'status', 'priority'] as const;
/** closed=7d: done tasks closed in the last 7 IST days, today included (the Overview's "Done this week", queries.ts). */
export const TASK_CLOSED = ['7d'] as const;
/** removed=1: also the tasks of removed (inactive) clients. Left out, only active clients' tasks: the Overview's scope. */
export const TASK_REMOVED = ['1'] as const;
export type TaskSource = 'whatsapp' | 'meeting' | 'voice' | 'dashboard';

export const TASK_LIMIT_DEFAULT = 100;
export const TASK_LIMIT_MAX = 500;
const TEXT_MAX = 200;

export interface TaskQuery {
  q?: string;
  client?: string;
  status?: DashboardTaskStatus;
  owner?: string;
  deadline?: (typeof TASK_DEADLINES)[number];
  priority?: Priority;
  closed?: (typeof TASK_CLOSED)[number];
  removed?: (typeof TASK_REMOVED)[number];
  sort: (typeof TASK_SORTS)[number];
  dir: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export interface DashboardTaskRow {
  code: string;
  title: string;
  client: { code: string; name: string };
  side: Side;
  owner: string | null;
  askedBy: string | null;
  deadline: string | null;
  /** overdue (not done, deadline before today IST), then done, review (maybe done) and open. */
  status: DashboardTaskStatus;
  overdue: boolean;
  /** null for a task from before priority levels (shown as "—"). */
  priority: Priority | null;
  /** What set it: an owner's keyword, the AI or the owner. */
  prioritySource: PrioritySource | null;
  /** The client's mood about the task; null while sentiment is switched off. */
  sentiment: Sentiment | null;
  category: Category;
  source: TaskSource;
  updatedAt: string;
}

export interface TaskHistoryItem {
  at: string;
  actor: 'agent' | 'owner';
  what: string;
}

export interface DashboardTaskDetail extends DashboardTaskRow {
  /** The owner's keyword that set the priority, when one did. */
  priorityKeyword: string | null;
  sourceQuote: string | null;
  sourceDate: string | null;
  /** The sender deleted the message the task came from (the quote is what was read before that). */
  sourceRevoked: boolean;
  latestProgress: string | null;
  remindedCount: number;
  history: TaskHistoryItem[];
}

function oneOf<T extends string>(field: string, raw: string | null, allowed: readonly T[]): T | undefined {
  if (raw === null || raw === '') return undefined;
  if (!(allowed as readonly string[]).includes(raw)) throw new ControlError(400, `${field} must be one of: ${allowed.join(', ')}`, field);
  return raw as T;
}

function text(field: string, raw: string | null): string | undefined {
  const v = raw?.trim() ?? '';
  if (v === '') return undefined;
  if (v.length > TEXT_MAX) throw new ControlError(400, `${field} must be at most ${TEXT_MAX} characters`, field);
  return v;
}

function whole(field: string, raw: string | null, min: number): number | undefined {
  if (raw === null || raw === '') return undefined;
  if (!/^\d{1,9}$/.test(raw) || Number(raw) < min) throw new ControlError(400, `${field} must be a whole number of at least ${min}`, field);
  return Number(raw);
}

/** Reads and checks the Tasks screen's URL parameters. Throws ControlError (400) naming the bad field. */
export function parseTaskQuery(p: URLSearchParams): TaskQuery {
  const out: TaskQuery = {
    sort: oneOf('sort', p.get('sort'), TASK_SORTS) ?? 'deadline',
    dir: oneOf('dir', p.get('dir'), ['asc', 'desc'] as const) ?? 'asc',
    limit: Math.min(whole('limit', p.get('limit'), 1) ?? TASK_LIMIT_DEFAULT, TASK_LIMIT_MAX),
    offset: whole('offset', p.get('offset'), 0) ?? 0,
  };
  const q = text('q', p.get('q'));
  if (q !== undefined) out.q = q;
  const owner = text('owner', p.get('owner'));
  if (owner !== undefined) out.owner = owner;
  const client = p.get('client')?.trim().toUpperCase() ?? '';
  if (client !== '') {
    if (!/^[A-Z]{3,4}$/.test(client)) throw new ControlError(400, 'client must be a client code of 3 or 4 letters', 'client');
    out.client = client;
  }
  const status = oneOf('status', p.get('status'), TASK_STATUSES);
  if (status) out.status = status;
  const deadline = oneOf('deadline', p.get('deadline'), TASK_DEADLINES);
  if (deadline) out.deadline = deadline;
  const priority = oneOf('priority', p.get('priority'), PRIORITIES);
  if (priority) out.priority = priority;
  const closed = oneOf('closed', p.get('closed'), TASK_CLOSED);
  if (closed) out.closed = closed;
  const removed = oneOf('removed', p.get('removed'), TASK_REMOVED);
  if (removed) out.removed = removed;
  return out;
}

/** "YYYY-MM-DD" plus n days (calendar dates, no time zone involved). */
function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

const STATUS_SQL = `CASE WHEN t.status = 'done' THEN 'done' WHEN t.deadline IS NOT NULL AND t.deadline < @today THEN 'overdue'
  WHEN t.status = 'maybe_done' THEN 'review' ELSE 'open' END`;
const STATUS_RANK_SQL = `CASE ${STATUS_SQL} WHEN 'overdue' THEN 0 WHEN 'open' THEN 1 WHEN 'review' THEN 2 ELSE 3 END`;
/** The number after the dash, so SHA-1000 sorts after SHA-999. */
const CODE_NUMBER_SQL = `CAST(substr(t.code, instr(t.code, '-') + 1) AS INTEGER)`;
/** A meeting's task, a voice note's task (its source message, in the same group, carries a voice note), or WhatsApp. */
const SOURCE_SQL = `CASE WHEN t.origin = 'dashboard' THEN 'dashboard' WHEN t.meeting_id IS NOT NULL OR t.origin = 'meeting' THEN 'meeting'
  WHEN t.source_wa_id IS NOT NULL AND EXISTS (SELECT 1 FROM messages m JOIN media md ON md.message_id = m.id
    WHERE m.client_id = t.client_id AND m.wa_id = t.source_wa_id AND md.kind = 'voice') THEN 'voice'
  ELSE 'whatsapp' END`;

const SELECT_SQL = `SELECT t.code, t.title, c.code AS clientCode, c.name AS clientName, t.side, t.assigned_to AS owner, t.asked_by AS askedBy,
    t.deadline, ${STATUS_SQL} AS status, t.priority_level AS priority, t.priority_source AS prioritySource, t.priority_keyword AS priorityKeyword,
    t.sentiment, t.category, ${SOURCE_SQL} AS source, t.updated_at AS updatedAt,
    t.id, t.source_quote AS sourceQuote, t.source_date AS sourceDate, t.source_revoked AS sourceRevoked, t.latest_progress AS latestProgress,
    t.reminder_count AS remindedCount
  FROM tasks t JOIN clients c ON c.id = t.client_id`;

interface RawRow {
  code: string;
  title: string;
  clientCode: string;
  clientName: string;
  side: Side;
  owner: string | null;
  askedBy: string | null;
  deadline: string | null;
  status: DashboardTaskStatus;
  priority: Priority | null;
  prioritySource: PrioritySource | null;
  priorityKeyword: string | null;
  sentiment: Sentiment | null;
  category: Category;
  source: TaskSource;
  updatedAt: string;
  id: number;
  sourceQuote: string | null;
  sourceDate: string | null;
  sourceRevoked: number;
  latestProgress: string | null;
  remindedCount: number;
}

/** moods: sentiment is switched on; off, no task's mood leaves here. */
function toRow(r: RawRow, moods: boolean): DashboardTaskRow {
  return {
    code: r.code, title: r.title, client: { code: r.clientCode, name: r.clientName }, side: r.side, owner: r.owner, askedBy: r.askedBy,
    deadline: r.deadline, status: r.status, overdue: r.status === 'overdue', priority: r.priority, prioritySource: r.prioritySource,
    sentiment: moods ? r.sentiment : null, category: r.category, source: r.source, updatedAt: r.updatedAt,
  };
}

/** Critical first; a task without a level last (asc). */
const PRIORITY_RANK_SQL = `CASE t.priority_level WHEN 'critical' THEN 0 WHEN 'major' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;

/** The ORDER BY for a sort. dir comes from the parsed filter's fixed list, never from raw input. */
function orderBy(sort: TaskQuery['sort'], dir: 'asc' | 'desc'): string {
  const d = dir === 'desc' ? 'DESC' : 'ASC';
  const tie = `c.code ASC, ${CODE_NUMBER_SQL} ASC, t.id ASC`;
  switch (sort) {
    case 'deadline':
      return `t.deadline IS NULL, t.deadline ${d}, ${tie}`;
    case 'code':
      return `c.code ${d}, ${CODE_NUMBER_SQL} ${d}, t.id ${d}`;
    case 'client':
      return `lower(c.name) ${d}, ${tie}`;
    case 'owner':
      return `t.assigned_to IS NULL, lower(t.assigned_to) ${d}, ${tie}`;
    case 'status':
      return `${STATUS_RANK_SQL} ${d}, ${tie}`;
    case 'priority':
      return `${PRIORITY_RANK_SQL} ${d}, ${tie}`;
  }
}

/** % _ and \ in a search are plain characters (LIKE ... ESCAPE '\'). */
function likePattern(s: string): string {
  return `%${s.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** The Tasks screen's list: every filter, the sort and one page, with the total before paging. */
export async function listDashboardTasks(db: Db, f: TaskQuery, now: Date): Promise<{ total: number; rows: DashboardTaskRow[] }> {
  const today = istDate(now);
  // Active clients only, as the Overview counts, unless the removed clients' tasks are asked for too.
  const where: string[] = f.removed === '1' ? [] : ['c.active = 1'];
  const params: Record<string, string | number> = { today };
  if (f.q !== undefined) {
    where.push(`(t.code LIKE @q ESCAPE '\\' OR t.title LIKE @q ESCAPE '\\' OR c.name LIKE @q ESCAPE '\\' OR t.assigned_to LIKE @q ESCAPE '\\')`);
    params.q = likePattern(f.q);
  }
  if (f.client !== undefined) {
    where.push('c.code = @client');
    params.client = f.client;
  }
  if (f.status !== undefined) {
    where.push(`${STATUS_SQL} = @status`);
    params.status = f.status;
  }
  if (f.owner !== undefined) {
    where.push('lower(t.assigned_to) = lower(@owner)');
    params.owner = f.owner;
  }
  // past is the deadline alone, done tasks included (the status filter's overdue is the not-done ones).
  if (f.deadline === 'past') where.push('t.deadline < @today');
  if (f.deadline === 'none') where.push('t.deadline IS NULL');
  if (f.deadline === 'week') {
    where.push('t.deadline BETWEEN @today AND @weekEnd');
    params.weekEnd = addDays(today, 6);
  }
  if (f.priority !== undefined) {
    where.push('t.priority_level = @priority');
    params.priority = f.priority;
  }
  // The same days as the Overview's count: today and the six before it (IST).
  if (f.closed === '7d') {
    where.push("t.status = 'done' AND t.closed_on BETWEEN @closedFrom AND @today");
    params.closedFrom = addDays(today, -6);
  }
  const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
  const total = (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks t JOIN clients c ON c.id = t.client_id${whereSql}`, params))!.n;
  const rows = await db.all<RawRow>(`${SELECT_SQL}${whereSql} ORDER BY ${orderBy(f.sort, f.dir)} LIMIT @limit OFFSET @offset`, { ...params, limit: f.limit, offset: f.offset });
  const moods = await readSentimentEnabled(db);
  return { total, rows: rows.map((r) => toRow(r, moods)) };
}

/** Plain words for the task fields, as the history and the audit log name them. */
export const FIELD_WORDS: Record<TaskField, string> = {
  title: 'title', side: 'side', category: 'category', priority: 'priority', assignedTo: 'owner', askedBy: 'asked by', deadline: 'deadline',
  latestProgress: 'progress',
};

/** The task fields named in a stored event detail, in the fixed order and words. Anything else in it is ignored. */
function fieldWords(detail: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return '';
  }
  if (typeof parsed !== 'object' || parsed === null) return '';
  const names = TASK_FIELDS.filter((f) => Object.hasOwn(parsed, f)).map((f) => FIELD_WORDS[f]);
  return names.length > 0 ? ` (${names.join(', ')})` : '';
}

const CREATED_FROM: Record<TaskSource, string> = {
  whatsapp: 'Created from WhatsApp', meeting: 'Created from a meeting', voice: 'Created from a voice note', dashboard: 'Added by the owner',
};

function historyWords(op: string, actor: 'agent' | 'owner', detail: string, source: TaskSource): string {
  const by = actor === 'owner' ? ' by the owner' : '';
  switch (op) {
    case 'add_task':
      return CREATED_FROM[source];
    case 'update_task':
      return actor === 'owner' ? `Edited by the owner${fieldWords(detail)}` : `Updated${fieldWords(detail)}`;
    case 'close_task':
      return `Marked done${by}`;
    case 'mark_maybe_done':
      return `Marked maybe done${by}`;
    case 'reopen_task':
      return `Reopened${by}`;
    case 'log_reminder':
      return 'Reminder noted';
    case 'unlock':
      return 'Handed back to the agent by the owner';
    default:
      return actor === 'owner' ? 'Changed by the owner' : 'Changed by the agent';
  }
}

/** One task with its quote, progress, reminders and history; undefined when no task has that code. */
export async function taskDetail(db: Db, rawCode: string, now: Date): Promise<DashboardTaskDetail | undefined> {
  const code = rawCode.trim().toUpperCase();
  if (!/^[A-Z]{3,4}-\d{1,9}$/.test(code)) return undefined;
  const r = await db.get<RawRow>(`${SELECT_SQL} WHERE t.code = @code`, { code, today: istDate(now) });
  if (!r) return undefined;
  const events = await db.all<{ at: string; actor: 'ai' | 'human'; op: string; detail: string }>(
    'SELECT at, actor, op, detail FROM task_events WHERE task_id = ? ORDER BY at, id',
    [r.id],
  );
  return {
    ...toRow(r, await readSentimentEnabled(db)),
    priorityKeyword: r.priorityKeyword,
    sourceQuote: r.sourceQuote,
    sourceDate: r.sourceDate,
    sourceRevoked: r.sourceRevoked === 1,
    latestProgress: r.latestProgress,
    remindedCount: r.remindedCount,
    history: events.map((e) => {
      const actor = e.actor === 'human' ? 'owner' : 'agent';
      return { at: e.at, actor, what: historyWords(e.op, actor, e.detail, r.source) };
    }),
  };
}

/** A meeting's action items: the tasks made from it, by code. */
export async function tasksForMeeting(db: Db, meetingId: number, now: Date): Promise<Pick<DashboardTaskRow, 'code' | 'title' | 'owner' | 'deadline' | 'status'>[]> {
  const rows = await db.all<RawRow>(`${SELECT_SQL} WHERE t.meeting_id = @meetingId ORDER BY ${CODE_NUMBER_SQL}, t.id`, { meetingId, today: istDate(now) });
  return rows.map((r) => ({ code: r.code, title: r.title, owner: r.owner, deadline: r.deadline, status: r.status }));
}
