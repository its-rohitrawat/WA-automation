import { getClientByCode, setPhase, type ClientRow } from '../store/clients.ts';
import { tx, type Db } from '../store/db.ts';
import { setKv } from '../store/kv.ts';
import { resetProcessedSince } from '../store/messages.ts';
import { findPeopleByNumber, setRole } from '../store/people.ts';
import {
  CATEGORIES, getTaskByCode, PRIORITIES, recordEvent, setTaskStatus, SIDES, TASK_FIELDS, updateTaskFields, type TaskField, type TaskRow,
} from '../store/tasks.ts';
import { fromIstDate, isIsoDate, istDate } from '../util/time.ts';

/** Messages carry only codes, ids, field names and allowed values. Never chat text. */
export class CorrectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorrectionError';
  }
}

export type EditOptions = Partial<Record<TaskField, string>>;

export function requestRebuild(db: Db, now: Date): void {
  setKv(db, 'rebuild_requested', now.toISOString());
}

function findTask(db: Db, code: string): TaskRow {
  const t = getTaskByCode(db, code.trim().toUpperCase());
  if (!t) throw new CorrectionError(`No task called ${code}`);
  return t;
}

function findClient(db: Db, code: string): ClientRow {
  const c = getClientByCode(db, code.trim().toUpperCase());
  if (!c) throw new CorrectionError(`No client with code ${code}`);
  return c;
}

function humanEvent(db: Db, taskId: number | null, clientId: number, op: string, detail: object, now: Date): void {
  recordEvent(db, { taskId, clientId, actor: 'human', op, detail, reason: 'cli', sourceIds: [], at: now.toISOString() });
}

function setStatusAsHuman(db: Db, code: string, status: 'open' | 'done', now: Date): TaskRow {
  const t = findTask(db, code);
  tx(db, () => {
    setTaskStatus(db, t.id, status, istDate(now), now.toISOString(), 'human');
    humanEvent(db, t.id, t.clientId, status === 'done' ? 'close_task' : 'reopen_task', { status }, now);
    requestRebuild(db, now);
  });
  return findTask(db, t.code);
}

export const closeTask = (db: Db, code: string, now: Date): TaskRow => setStatusAsHuman(db, code, 'done', now);
export const reopenTask = (db: Db, code: string, now: Date): TaskRow => setStatusAsHuman(db, code, 'open', now);

export function editTask(db: Db, code: string, opts: EditOptions, now: Date): TaskRow {
  const t = findTask(db, code);
  const fields: Partial<Record<TaskField, string | null>> = {};
  for (const f of TASK_FIELDS) {
    const raw = opts[f];
    if (raw === undefined) continue;
    const v = raw.trim();
    fields[f] = v.toLowerCase() === 'none' ? null : v;
  }
  if (Object.keys(fields).length === 0) throw new CorrectionError('Nothing to change. Pass at least one option, for example --deadline 2026-10-25');
  const check = (f: 'side' | 'category' | 'priority', allowed: readonly string[]) => {
    if (fields[f] !== undefined && !allowed.includes(fields[f] ?? '')) throw new CorrectionError(`${f} must be one of: ${allowed.join(', ')}`);
  };
  check('side', SIDES);
  check('category', CATEGORIES);
  check('priority', PRIORITIES);
  if (fields.title === null || fields.title === '') throw new CorrectionError('title cannot be empty');
  if (fields.deadline != null && !isIsoDate(fields.deadline)) throw new CorrectionError('deadline must be YYYY-MM-DD, or none');
  tx(db, () => {
    updateTaskFields(db, t.id, fields, now.toISOString(), 'human');
    humanEvent(db, t.id, t.clientId, 'update_task', fields, now);
    requestRebuild(db, now);
  });
  return findTask(db, t.code);
}

export function setPersonRole(db: Db, number: string, role: string, clientCode: string | undefined, now: Date): number {
  if (role !== 'team' && role !== 'client') throw new CorrectionError('role must be team or client');
  const digits = number.replace(/\D/g, '');
  let people = findPeopleByNumber(db, digits);
  if (clientCode) {
    const c = findClient(db, clientCode);
    people = people.filter((p) => p.clientId === c.id);
  }
  if (people.length === 0) throw new CorrectionError(`No one with number ${digits} has posted in an allowed group yet`);
  tx(db, () => {
    for (const p of people) {
      setRole(db, p.clientId, p.jid, role, 'human');
      humanEvent(db, null, p.clientId, 'set_person_role', { number: digits, role }, now);
    }
    requestRebuild(db, now);
  });
  return people.length;
}

export function setClientPhase(db: Db, clientCode: string, phase: string, now: Date): void {
  const c = findClient(db, clientCode);
  const match = c.phases.find((p) => p.toLowerCase() === phase.trim().toLowerCase());
  if (!match) throw new CorrectionError(`Phase must be one of: ${c.phases.join(', ')}`);
  tx(db, () => {
    setPhase(db, c.id, match, 'human');
    humanEvent(db, null, c.id, 'set_phase', { phase: match }, now);
    requestRebuild(db, now);
  });
}

/** Re-queues processed messages from a date onward. Returns how many were queued. */
export function requestReprocess(db: Db, clientCode: string, since: string, now: Date): number {
  if (!isIsoDate(since)) throw new CorrectionError('--since must be YYYY-MM-DD');
  const c = findClient(db, clientCode);
  return tx(db, () => {
    const n = resetProcessedSince(db, c.id, fromIstDate(since).toISOString());
    humanEvent(db, null, c.id, 'reprocess', { since, messages: n }, now);
    requestRebuild(db, now);
    return n;
  });
}
