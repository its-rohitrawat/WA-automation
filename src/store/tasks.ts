import { nextTaskCode } from './clients.ts';
import type { Db, Sql } from './db.ts';

export const SIDES = ['us', 'client'] as const;
export const CATEGORIES = ['design', 'development', 'content', 'payment', 'approval', 'other'] as const;
/** The priority every screen shows, most urgent first (migration v11). */
export const PRIORITIES = ['critical', 'major', 'medium', 'low'] as const;
/** The first priority column's values (migration v1). Still written, in step with the level: critical and major are high. */
export const LEGACY_PRIORITIES = ['high', 'medium', 'low'] as const;
export const SENTIMENTS = ['positive', 'neutral', 'negative', 'frustrated'] as const;
export type Side = (typeof SIDES)[number];
export type Category = (typeof CATEGORIES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type LegacyPriority = (typeof LEGACY_PRIORITIES)[number];
export type Sentiment = (typeof SENTIMENTS)[number];
/** What set a task's priority: an owner's keyword in its messages, the AI, or a person (which locks it). */
export type PrioritySource = 'keyword' | 'ai' | 'human';
export type Status = 'open' | 'maybe_done' | 'done';

export const legacyPriority = (p: Priority): LegacyPriority => (p === 'critical' || p === 'major' ? 'high' : p);

/** Most urgent first (0 is critical). A task without a level (made before v11) ranks by its old priority: high as major. */
export function priorityRank(t: Pick<TaskRow, 'priority' | 'legacyPriority'>): number {
  const level = t.priority ?? (t.legacyPriority === 'high' ? 'major' : t.legacyPriority);
  return PRIORITIES.indexOf(level);
}

/** Fields the AI may set and a human may lock. Names match the AI operation fields. */
export const TASK_FIELDS = ['title', 'side', 'category', 'priority', 'assignedTo', 'askedBy', 'deadline', 'latestProgress'] as const;
export type TaskField = (typeof TASK_FIELDS)[number];

const COLUMN: Record<TaskField, string> = {
  title: 'title',
  side: 'side',
  category: 'category',
  priority: 'priority_level',
  assignedTo: 'assigned_to',
  askedBy: 'asked_by',
  deadline: 'deadline',
  latestProgress: 'latest_progress',
};

export interface TaskRow {
  id: number;
  code: string;
  clientId: number;
  side: Side;
  title: string;
  category: Category;
  /** null for a task made before priority levels (migration v11) until a keyword, the AI or a person sets one. */
  priority: Priority | null;
  /** The v1 column, kept in step with priority. */
  legacyPriority: LegacyPriority;
  prioritySource: PrioritySource | null;
  /** The owner's keyword that set the priority, when a keyword did. */
  priorityKeyword: string | null;
  /** The client's mood about the task, while sentiment is switched on. */
  sentiment: Sentiment | null;
  assignedTo: string | null;
  askedBy: string | null;
  raisedOn: string;
  deadline: string | null;
  latestProgress: string | null;
  reminderCount: number;
  lastReminderOn: string | null;
  status: Status;
  sourceQuote: string | null;
  sourceDate: string | null;
  sourceWaId: string | null;
  sourceRevoked: boolean;
  closedOn: string | null;
  origin: string;
  lockedFields: TaskField[];
  statusLockedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewTask {
  clientId: number;
  side: Side;
  title: string;
  category: Category;
  priority: Priority;
  /** Default 'ai'. */
  prioritySource?: PrioritySource;
  priorityKeyword?: string | null;
  sentiment?: Sentiment | null;
  assignedTo: string | null;
  askedBy: string | null;
  raisedOn: string;
  deadline: string | null;
  latestProgress: string | null;
  sourceQuote: string | null;
  sourceDate: string | null;
  sourceWaId: string | null;
  origin: string;
  /** The meeting a task came from (origin 'meeting'). */
  meetingId?: number | null;
}

export interface DecisionRow {
  id: number;
  clientId: number;
  text: string;
  decidedOn: string;
  source: 'whatsapp' | 'meeting' | 'human';
  sourceWaId: string | null;
  /** The Doc of the meeting the decision was taken in; null when it is not from a meeting, or the meeting has no Doc. */
  docFileId: string | null;
}

interface RawTask {
  id: number;
  code: string;
  client_id: number;
  side: Side;
  title: string;
  category: Category;
  priority: LegacyPriority;
  priority_level: Priority | null;
  priority_source: PrioritySource | null;
  priority_keyword: string | null;
  sentiment: Sentiment | null;
  assigned_to: string | null;
  asked_by: string | null;
  raised_on: string;
  deadline: string | null;
  latest_progress: string | null;
  reminder_count: number;
  last_reminder_on: string | null;
  status: Status;
  source_quote: string | null;
  source_date: string | null;
  source_wa_id: string | null;
  source_revoked: number;
  closed_on: string | null;
  origin: string;
  locked_fields: string;
  status_locked_at: string | null;
  created_at: string;
  updated_at: string;
}

function toRow(r: RawTask): TaskRow {
  return {
    id: r.id,
    code: r.code,
    clientId: r.client_id,
    side: r.side,
    title: r.title,
    category: r.category,
    priority: r.priority_level,
    legacyPriority: r.priority,
    prioritySource: r.priority_source,
    priorityKeyword: r.priority_keyword,
    sentiment: r.sentiment,
    assignedTo: r.assigned_to,
    askedBy: r.asked_by,
    raisedOn: r.raised_on,
    deadline: r.deadline,
    latestProgress: r.latest_progress,
    reminderCount: r.reminder_count,
    lastReminderOn: r.last_reminder_on,
    status: r.status,
    sourceQuote: r.source_quote,
    sourceDate: r.source_date,
    sourceWaId: r.source_wa_id,
    sourceRevoked: r.source_revoked === 1,
    closedOn: r.closed_on,
    origin: r.origin,
    lockedFields: JSON.parse(r.locked_fields) as TaskField[],
    statusLockedAt: r.status_locked_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function getTaskById(db: Sql, id: number): Promise<TaskRow> {
  const r = await db.get<RawTask>('SELECT * FROM tasks WHERE id = ?', [id]);
  if (!r) throw new Error(`Unknown task id ${id}`);
  return toRow(r);
}

export async function getTaskByCode(db: Sql, code: string): Promise<TaskRow | undefined> {
  const r = await db.get<RawTask>('SELECT * FROM tasks WHERE code = ?', [code]);
  return r ? toRow(r) : undefined;
}

export async function createTask(db: Sql, t: NewTask, now: string): Promise<TaskRow> {
  const code = await nextTaskCode(db, t.clientId);
  const info = await db.get<{ id: number }>(`INSERT INTO tasks (code, client_id, side, title, category, priority, priority_level, priority_source, priority_keyword, sentiment,
        assigned_to, asked_by, raised_on, deadline, latest_progress, source_quote, source_date, source_wa_id, origin, meeting_id, created_at, updated_at)
      VALUES (@code, @clientId, @side, @title, @category, @legacy, @priority, @prioritySource, @priorityKeyword, @sentiment,
        @assignedTo, @askedBy, @raisedOn, @deadline, @latestProgress, @sourceQuote, @sourceDate, @sourceWaId, @origin, @meetingId, @now, @now)
      RETURNING id`, {
      ...t, legacy: legacyPriority(t.priority), prioritySource: t.prioritySource ?? 'ai', priorityKeyword: t.priorityKeyword ?? null,
      sentiment: t.sentiment ?? null, meetingId: t.meetingId ?? null, code, now,
    });
  return getTaskById(db, info!.id);
}

export async function listTasks(db: Sql, clientId: number, statuses?: Status[]): Promise<TaskRow[]> {
  const rows = statuses
    ? (await db.all<RawTask>('SELECT * FROM tasks WHERE client_id = ? AND status IN (SELECT value FROM json_each(?)) ORDER BY id', [clientId, JSON.stringify(statuses)]))
    : (await db.all<RawTask>('SELECT * FROM tasks WHERE client_id = ? ORDER BY id', [clientId]));
  return rows.map(toRow);
}

/**
 * Column names come from the fixed COLUMN map, never from input. A priority also writes the old column in step and what
 * set it: a person, else the owner's keyword when keyword is given, else the AI.
 */
export async function updateTaskFields(
  db: Sql, id: number, fields: Partial<Record<TaskField, string | null>>, now: string, by: 'ai' | 'human', keyword?: string,
): Promise<void> {
  const keys = TASK_FIELDS.filter((k) => k in fields);
  if (keys.length === 0) return;
  const params: Record<string, string | number | null> = { id, now };
  for (const k of keys) params[k] = fields[k] ?? null;
  const sets = keys.map((k) => `${COLUMN[k]} = @${k}`);
  if (keys.includes('priority')) {
    if (!(PRIORITIES as readonly unknown[]).includes(params.priority)) throw new Error('priority must be one of the levels');
    sets.push('priority = @legacy', 'priority_source = @prioritySource', 'priority_keyword = @priorityKeyword');
    params.legacy = legacyPriority(params.priority as Priority);
    params.prioritySource = by === 'human' ? 'human' : keyword !== undefined ? 'keyword' : 'ai';
    params.priorityKeyword = by === 'human' ? null : (keyword ?? null);
  }
  await db.run(`UPDATE tasks SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`, params);
  if (by === 'human') {
    const locked = new Set([...(await getTaskById(db, id)).lockedFields, ...keys]);
    await db.run('UPDATE tasks SET locked_fields = ? WHERE id = ?', [JSON.stringify([...locked]), id]);
  }
}

/** The client's mood about a task, as the AI judged it (only while sentiment is switched on). */
export async function setTaskSentiment(db: Sql, id: number, sentiment: Sentiment, now: string): Promise<void> {
  await db.run('UPDATE tasks SET sentiment = ?, updated_at = ? WHERE id = ?', [sentiment, now, id]);
}

/** A human status change is timestamped; the AI then needs newer evidence to change the status again. */
export async function setTaskStatus(db: Sql, id: number, status: Status, today: string, now: string, by: 'ai' | 'human'): Promise<void> {
  const humanLock = by === 'human' ? ', status_locked_at = @now' : '';
  await db.run(`UPDATE tasks SET status = @status, closed_on = @closedOn, updated_at = @now${humanLock} WHERE id = @id`, {
    id,
    status,
    closedOn: status === 'done' ? today : null,
    now,
  });
}

/**
 * Counts a reminder. The last reminder date never moves back: a file-only re-check dates its reminder by the day its
 * message was sent (amendment 12h), which can be before a reminder already logged from a later message.
 */
export async function logReminder(db: Sql, id: number, onDate: string, now: string): Promise<void> {
  await db.run(`UPDATE tasks SET reminder_count = reminder_count + 1, last_reminder_on = MAX(COALESCE(last_reminder_on, ''), @onDate),
      updated_at = @now WHERE id = @id`, { onDate, now, id });
}

export async function recordEvent(
  db: Sql,
  e: { taskId: number | null; clientId: number; actor: 'ai' | 'human'; op: string; detail: object; reason: string | null; sourceIds: string[]; at: string },
): Promise<void> {
  await db.run('INSERT INTO task_events (task_id, client_id, actor, op, detail, reason, source_ids, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [e.taskId, e.clientId, e.actor, e.op, JSON.stringify(e.detail), e.reason, JSON.stringify(e.sourceIds), e.at]);
}

export async function addDecision(
  db: Sql,
  d: { clientId: number; text: string; decidedOn: string; source: DecisionRow['source']; sourceWaId: string | null; meetingId?: number | null },
  now: string,
): Promise<void> {
  await db.run('INSERT INTO decisions (client_id, text, decided_on, source, source_wa_id, meeting_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [d.clientId, d.text, d.decidedOn, d.source, d.sourceWaId, d.meetingId ?? null, now]);
}

export async function listDecisions(db: Sql, clientId: number, limit = 1000): Promise<DecisionRow[]> {
  return db.all<DecisionRow>(`SELECT d.id, d.client_id AS clientId, d.text, d.decided_on AS decidedOn, d.source, d.source_wa_id AS sourceWaId,
        m.doc_file_id AS docFileId
      FROM decisions d LEFT JOIN meetings m ON m.id = d.meeting_id WHERE d.client_id = ? ORDER BY d.decided_on DESC, d.id DESC LIMIT ?`, [clientId, limit]);
}

/** Every message cited by an applied event of this op (source_ids JSON), for this client. */
async function eventSourceIds(db: Sql, clientId: number, op: string): Promise<string[]> {
  const rows = await db.all<{ ids: string }>('SELECT source_ids AS ids FROM task_events WHERE client_id = ? AND op = ?', [clientId, op]);
  return rows.flatMap((r) => JSON.parse(r.ids) as string[]);
}

/**
 * Every message already used as evidence for a task of this client (any status): each task's source, every message its
 * add_task cited, and every message cited by any other event on a task (reminder, update, status change; AI or human).
 */
export async function taskSourceIds(db: Sql, clientId: number): Promise<Set<string>> {
  const rows = await db.all<{ id: string }>('SELECT source_wa_id AS id FROM tasks WHERE client_id = ? AND source_wa_id IS NOT NULL', [clientId]);
  const onTasks = await db.all<{ ids: string }>('SELECT source_ids AS ids FROM task_events WHERE client_id = ? AND task_id IS NOT NULL', [clientId]);
  return new Set([
    ...rows.map((r) => r.id),
    ...await eventSourceIds(db, clientId, 'add_task'),
    ...onTasks.flatMap((r) => JSON.parse(r.ids) as string[]),
  ]);
}

/** Task code to the message ids already cited by an applied log_reminder event. */
export async function reminderSourceIds(db: Sql, clientId: number): Promise<Map<string, Set<string>>> {
  const rows = await db.all<{ code: string; ids: string }>(`SELECT t.code AS code, e.source_ids AS ids FROM task_events e JOIN tasks t ON t.id = e.task_id WHERE e.client_id = ? AND e.op = 'log_reminder'`, [clientId]);
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = out.get(r.code) ?? new Set<string>();
    for (const id of JSON.parse(r.ids) as string[]) set.add(id);
    out.set(r.code, set);
  }
  return out;
}

export async function decisionSourceIds(db: Sql, clientId: number): Promise<Set<string>> {
  const rows = await db.all<{ id: string }>('SELECT source_wa_id AS id FROM decisions WHERE client_id = ? AND source_wa_id IS NOT NULL', [clientId]);
  return new Set([...rows.map((r) => r.id), ...await eventSourceIds(db, clientId, 'add_decision')]);
}

/** Hands the task back to the AI: clears the field locks and the status lock. */
export async function clearTaskLocks(db: Sql, id: number, now: string): Promise<void> {
  await db.run("UPDATE tasks SET locked_fields = '[]', status_locked_at = NULL, updated_at = ? WHERE id = ?", [now, id]);
}
