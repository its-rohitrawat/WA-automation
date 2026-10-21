import { nextTaskCode } from './clients.ts';
import type { Db } from './db.ts';

export const SIDES = ['us', 'client'] as const;
export const CATEGORIES = ['design', 'development', 'content', 'payment', 'approval', 'other'] as const;
export const PRIORITIES = ['high', 'medium', 'low'] as const;
export type Side = (typeof SIDES)[number];
export type Category = (typeof CATEGORIES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type Status = 'open' | 'maybe_done' | 'done';

/** Fields the AI may set and a human may lock. Names match the AI operation fields. */
export const TASK_FIELDS = ['title', 'side', 'category', 'priority', 'assignedTo', 'askedBy', 'deadline', 'latestProgress'] as const;
export type TaskField = (typeof TASK_FIELDS)[number];

const COLUMN: Record<TaskField, string> = {
  title: 'title',
  side: 'side',
  category: 'category',
  priority: 'priority',
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
  priority: Priority;
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
  assignedTo: string | null;
  askedBy: string | null;
  raisedOn: string;
  deadline: string | null;
  latestProgress: string | null;
  sourceQuote: string | null;
  sourceDate: string | null;
  sourceWaId: string | null;
  origin: string;
}

export interface DecisionRow {
  id: number;
  clientId: number;
  text: string;
  decidedOn: string;
  source: 'whatsapp' | 'meeting' | 'human';
  sourceWaId: string | null;
}

interface RawTask {
  id: number;
  code: string;
  client_id: number;
  side: Side;
  title: string;
  category: Category;
  priority: Priority;
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
    priority: r.priority,
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

export function getTaskById(db: Db, id: number): TaskRow {
  const r = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as RawTask | undefined;
  if (!r) throw new Error(`Unknown task id ${id}`);
  return toRow(r);
}

export function getTaskByCode(db: Db, code: string): TaskRow | undefined {
  const r = db.prepare('SELECT * FROM tasks WHERE code = ?').get(code) as RawTask | undefined;
  return r ? toRow(r) : undefined;
}

export function createTask(db: Db, t: NewTask, now: string): TaskRow {
  const code = nextTaskCode(db, t.clientId);
  const info = db
    .prepare(`INSERT INTO tasks (code, client_id, side, title, category, priority, assigned_to, asked_by, raised_on, deadline, latest_progress,
        source_quote, source_date, source_wa_id, origin, created_at, updated_at)
      VALUES (@code, @clientId, @side, @title, @category, @priority, @assignedTo, @askedBy, @raisedOn, @deadline, @latestProgress,
        @sourceQuote, @sourceDate, @sourceWaId, @origin, @now, @now)`)
    .run({ ...t, code, now });
  return getTaskById(db, Number(info.lastInsertRowid));
}

export function listTasks(db: Db, clientId: number, statuses?: Status[]): TaskRow[] {
  const rows = statuses
    ? (db.prepare('SELECT * FROM tasks WHERE client_id = ? AND status IN (SELECT value FROM json_each(?)) ORDER BY id').all(clientId, JSON.stringify(statuses)) as RawTask[])
    : (db.prepare('SELECT * FROM tasks WHERE client_id = ? ORDER BY id').all(clientId) as RawTask[]);
  return rows.map(toRow);
}

/** Column names come from the fixed COLUMN map, never from input. */
export function updateTaskFields(db: Db, id: number, fields: Partial<Record<TaskField, string | null>>, now: string, by: 'ai' | 'human'): void {
  const keys = TASK_FIELDS.filter((k) => k in fields);
  if (keys.length === 0) return;
  const params: Record<string, string | number | null> = { id, now };
  for (const k of keys) params[k] = fields[k] ?? null;
  const sets = keys.map((k) => `${COLUMN[k]} = @${k}`).join(', ');
  db.prepare(`UPDATE tasks SET ${sets}, updated_at = @now WHERE id = @id`).run(params);
  if (by === 'human') {
    const locked = new Set([...getTaskById(db, id).lockedFields, ...keys]);
    db.prepare('UPDATE tasks SET locked_fields = ? WHERE id = ?').run(JSON.stringify([...locked]), id);
  }
}

/** A human status change is timestamped; the AI then needs newer evidence to change the status again. */
export function setTaskStatus(db: Db, id: number, status: Status, today: string, now: string, by: 'ai' | 'human'): void {
  const humanLock = by === 'human' ? ', status_locked_at = @now' : '';
  db.prepare(`UPDATE tasks SET status = @status, closed_on = @closedOn, updated_at = @now${humanLock} WHERE id = @id`).run({
    id,
    status,
    closedOn: status === 'done' ? today : null,
    now,
  });
}

export function logReminder(db: Db, id: number, onDate: string, now: string): void {
  db.prepare('UPDATE tasks SET reminder_count = reminder_count + 1, last_reminder_on = ?, updated_at = ? WHERE id = ?').run(onDate, now, id);
}

export function recordEvent(
  db: Db,
  e: { taskId: number | null; clientId: number; actor: 'ai' | 'human'; op: string; detail: object; reason: string | null; sourceIds: string[]; at: string },
): void {
  db.prepare('INSERT INTO task_events (task_id, client_id, actor, op, detail, reason, source_ids, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    e.taskId,
    e.clientId,
    e.actor,
    e.op,
    JSON.stringify(e.detail),
    e.reason,
    JSON.stringify(e.sourceIds),
    e.at,
  );
}

export function addDecision(
  db: Db,
  d: { clientId: number; text: string; decidedOn: string; source: DecisionRow['source']; sourceWaId: string | null },
  now: string,
): void {
  db.prepare('INSERT INTO decisions (client_id, text, decided_on, source, source_wa_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    d.clientId,
    d.text,
    d.decidedOn,
    d.source,
    d.sourceWaId,
    now,
  );
}

export function listDecisions(db: Db, clientId: number, limit = 1000): DecisionRow[] {
  return db
    .prepare(`SELECT id, client_id AS clientId, text, decided_on AS decidedOn, source, source_wa_id AS sourceWaId
      FROM decisions WHERE client_id = ? ORDER BY decided_on DESC, id DESC LIMIT ?`)
    .all(clientId, limit) as DecisionRow[];
}

/** Every task of this client, any status: the message each one was created from. */
export function taskSourceIds(db: Db, clientId: number): Set<string> {
  const rows = db.prepare('SELECT source_wa_id AS id FROM tasks WHERE client_id = ? AND source_wa_id IS NOT NULL').all(clientId) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/** Task code to the message ids already cited by an applied log_reminder event. */
export function reminderSourceIds(db: Db, clientId: number): Map<string, Set<string>> {
  const rows = db
    .prepare(`SELECT t.code AS code, e.source_ids AS ids FROM task_events e JOIN tasks t ON t.id = e.task_id WHERE e.client_id = ? AND e.op = 'log_reminder'`)
    .all(clientId) as { code: string; ids: string }[];
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = out.get(r.code) ?? new Set<string>();
    for (const id of JSON.parse(r.ids) as string[]) set.add(id);
    out.set(r.code, set);
  }
  return out;
}

export function decisionSourceIds(db: Db, clientId: number): Set<string> {
  const rows = db.prepare('SELECT source_wa_id AS id FROM decisions WHERE client_id = ? AND source_wa_id IS NOT NULL').all(clientId) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/** Hands the task back to the AI: clears the field locks and the status lock. */
export function clearTaskLocks(db: Db, id: number, now: string): void {
  db.prepare("UPDATE tasks SET locked_fields = '[]', status_locked_at = NULL, updated_at = ? WHERE id = ?").run(now, id);
}
