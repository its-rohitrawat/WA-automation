import { clearPhaseLock, getClientByCode, setPhase, type ClientRow } from '../store/clients.ts';
import { tx, type Db } from '../store/db.ts';
import { setKv } from '../store/kv.ts';
import { countProcessedBetween, resetProcessedSince } from '../store/messages.ts';
import { findPeopleByJid, findPeopleByNumber, setRole, type PersonRow } from '../store/people.ts';
import {
  CATEGORIES, clearTaskLocks, getTaskByCode, PRIORITIES, recordEvent, setTaskStatus, SIDES, TASK_FIELDS, updateTaskFields, type TaskField, type TaskRow,
} from '../store/tasks.ts';
import { fromIstDate, isIsoDate, istDate } from '../util/time.ts';

/** Messages carry only codes, ids, field names and allowed values. Never chat text. */
export class CorrectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorrectionError';
  }
}

const ENUM_FIELDS = new Set<TaskField>(['side', 'category', 'priority']);

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

export function humanEvent(db: Db, taskId: number | null, clientId: number, op: string, detail: object, now: Date): void {
  recordEvent(db, { taskId, clientId, actor: 'human', op, detail, reason: 'cli', sourceIds: [], at: now.toISOString() });
}

function setStatusAsHuman(db: Db, code: string, status: 'open' | 'done', now: Date): TaskRow {
  const t = findTask(db, code);
  if (t.status === status) throw new CorrectionError(`Task ${t.code} is already ${status}`);
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
    const empty = v === '' || v.toLowerCase() === 'none';
    fields[f] = empty ? null : ENUM_FIELDS.has(f) ? v.toLowerCase() : v;
  }
  if (Object.keys(fields).length === 0) throw new CorrectionError('Nothing to change. Pass at least one option, for example --deadline 2026-10-25');
  const check = (f: 'side' | 'category' | 'priority', allowed: readonly string[]) => {
    if (fields[f] !== undefined && !allowed.includes(fields[f] ?? '')) throw new CorrectionError(`${f} must be one of: ${allowed.join(', ')}`);
  };
  check('side', SIDES);
  check('category', CATEGORIES);
  check('priority', PRIORITIES);
  if (fields.title === null) throw new CorrectionError('title cannot be empty');
  if (fields.deadline != null && !isIsoDate(fields.deadline)) throw new CorrectionError('deadline must be YYYY-MM-DD, or none');
  tx(db, () => {
    updateTaskFields(db, t.id, fields, now.toISOString(), 'human');
    humanEvent(db, t.id, t.clientId, 'update_task', fields, now);
    requestRebuild(db, now);
  });
  return findTask(db, t.code);
}

export function unlockTask(db: Db, code: string, now: Date): TaskRow {
  const t = findTask(db, code);
  tx(db, () => {
    clearTaskLocks(db, t.id, now.toISOString());
    humanEvent(db, t.id, t.clientId, 'unlock', { lockedFields: t.lockedFields, statusLocked: t.statusLockedAt !== null }, now);
    requestRebuild(db, now);
  });
  return findTask(db, t.code);
}

/** Accepts a phone number (any punctuation) or a WhatsApp id (contains @). Returns how many group memberships changed. */
export function setPersonRole(db: Db, who: string, roleInput: string, clientCode: string | undefined, now: Date): number {
  const role = roleInput.trim().toLowerCase();
  if (role !== 'team' && role !== 'client') throw new CorrectionError('role must be team or client');
  const target = who.trim();
  let people: PersonRow[];
  let detailKey: { jid: string } | { number: string };
  if (target.includes('@')) {
    people = findPeopleByJid(db, target);
    detailKey = { jid: target };
  } else {
    const digits = target.replace(/\D/g, '');
    if (digits === '') throw new CorrectionError('Give the full phone number with country code, e.g. 919812345678, or a WhatsApp id');
    // The schema has no link between a LID row and a phone-number row, so only rows that carry this number or its phone id match.
    const byNumber = findPeopleByNumber(db, digits);
    const seen = new Set(byNumber.map((p) => p.id));
    people = [...byNumber, ...findPeopleByJid(db, `${digits}@s.whatsapp.net`).filter((p) => !seen.has(p.id))];
    detailKey = { number: digits };
  }
  if (people.length === 0) throw new CorrectionError(`No one with that ${target.includes('@') ? 'WhatsApp id' : 'number'} has posted in an allowed group yet`);
  if (clientCode) {
    const c = findClient(db, clientCode);
    people = people.filter((p) => p.clientId === c.id);
    if (people.length === 0) throw new CorrectionError(`That number has posted, but not in client ${c.code}`);
  }
  const chosen = people;
  tx(db, () => {
    for (const p of chosen) {
      setRole(db, p.clientId, p.jid, role, 'human');
      humanEvent(db, null, p.clientId, 'set_person_role', { ...detailKey, role }, now);
    }
    requestRebuild(db, now);
  });
  return chosen.length;
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

export function unlockClientPhase(db: Db, clientCode: string, now: Date): void {
  const c = findClient(db, clientCode);
  tx(db, () => {
    clearPhaseLock(db, c.id);
    humanEvent(db, null, c.id, 'unlock_phase', { phase: c.currentPhase }, now);
    requestRebuild(db, now);
  });
}

/** Above this many messages the CLI only previews until --yes is given. */
export const REPROCESS_CONFIRM_ABOVE = 200;

interface ReprocessWindow {
  clientId: number;
  sinceIso: string;
  untilIso: string | undefined;
}

function reprocessWindow(db: Db, clientCode: string, since: string, until: string | undefined): ReprocessWindow {
  if (!isIsoDate(since)) throw new CorrectionError('--since must be YYYY-MM-DD');
  if (until !== undefined) {
    if (!isIsoDate(until)) throw new CorrectionError('--until must be YYYY-MM-DD');
    if (until < since) throw new CorrectionError('--until must be on or after --since');
  }
  const c = findClient(db, clientCode);
  if (!c.active) throw new CorrectionError(`Client ${c.code} is not in the allow-list; nothing to reprocess`);
  // --until covers that whole India-time day, so the limit is the start of the next day.
  const untilIso = until === undefined ? undefined : new Date(fromIstDate(until).getTime() + 86_400_000).toISOString();
  return { clientId: c.id, sinceIso: fromIstDate(since).toISOString(), untilIso };
}

/** How many processed messages a reprocess would queue. Changes nothing. */
export function countReprocess(db: Db, clientCode: string, since: string, until?: string): number {
  const w = reprocessWindow(db, clientCode, since, until);
  return countProcessedBetween(db, w.clientId, w.sinceIso, w.untilIso);
}

/** Re-queues processed messages in the window for the AI. Returns how many were actually re-queued. */
export function requestReprocess(db: Db, clientCode: string, since: string, now: Date, until?: string): number {
  const w = reprocessWindow(db, clientCode, since, until);
  return tx(db, () => {
    const n = resetProcessedSince(db, w.clientId, w.sinceIso, w.untilIso);
    humanEvent(db, null, w.clientId, 'reprocess', { since, until: until ?? null, messages: n }, now);
    requestRebuild(db, now);
    return n;
  });
}

export interface ReprocessResult {
  count: number;
  queued: number;
  needsConfirm: boolean;
  maxCostUsd: number;
}

/** Preview first; only re-queue when the job is small or the operator passed --yes. */
export function reprocess(db: Db, clientCode: string, since: string, until: string | undefined, yes: boolean, now: Date): ReprocessResult {
  const count = countReprocess(db, clientCode, since, until);
  const maxCostUsd = Math.ceil(count / 200) * 0.5;
  if (count === 0) return { count, queued: 0, needsConfirm: false, maxCostUsd };
  if (count > REPROCESS_CONFIRM_ABOVE && !yes) return { count, queued: 0, needsConfirm: true, maxCostUsd };
  return { count, queued: requestReprocess(db, clientCode, since, now, until), needsConfirm: false, maxCostUsd };
}
