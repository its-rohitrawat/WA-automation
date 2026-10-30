import { clearPhaseLock, getClientByCode, setPhase, type ClientRow } from '../store/clients.ts';
import type { Db, Sql } from '../store/db.ts';
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

export async function requestRebuild(db: Sql, now: Date): Promise<void> {
  await setKv(db, 'rebuild_requested', now.toISOString());
}

/** Runs fn in the caller's transaction q, or in a new one: a dashboard action writes its audit line in the same transaction. */
function inTx<T>(db: Db, q: Sql | undefined, fn: (q: Sql) => Promise<T>): Promise<T> {
  return q ? fn(q) : db.tx(fn);
}

async function findTask(db: Sql, code: string): Promise<TaskRow> {
  const t = await getTaskByCode(db, code.trim().toUpperCase());
  if (!t) throw new CorrectionError(`No task called ${code}`);
  return t;
}

async function findClient(db: Db, code: string): Promise<ClientRow> {
  const c = await getClientByCode(db, code.trim().toUpperCase());
  if (!c) throw new CorrectionError(`No client with code ${code}`);
  return c;
}

export async function humanEvent(db: Sql, taskId: number | null, clientId: number, op: string, detail: object, now: Date): Promise<void> {
  await recordEvent(db, { taskId, clientId, actor: 'human', op, detail, reason: 'cli', sourceIds: [], at: now.toISOString() });
}

async function setStatusAsHuman(db: Db, code: string, status: 'open' | 'done', now: Date, q?: Sql): Promise<TaskRow> {
  const t = await findTask(q ?? db, code);
  if (t.status === status) throw new CorrectionError(`Task ${t.code} is already ${status}`);
  await inTx(db, q, async (q) => {
    await setTaskStatus(q, t.id, status, istDate(now), now.toISOString(), 'human');
    await humanEvent(q, t.id, t.clientId, status === 'done' ? 'close_task' : 'reopen_task', { status }, now);
    await requestRebuild(q, now);
  });
  return findTask(q ?? db, t.code);
}

/** q: the caller's transaction, when the change is part of a larger one (src/control/taskActions.ts). */
export const closeTask = (db: Db, code: string, now: Date, q?: Sql): Promise<TaskRow> => setStatusAsHuman(db, code, 'done', now, q);
export const reopenTask = (db: Db, code: string, now: Date, q?: Sql): Promise<TaskRow> => setStatusAsHuman(db, code, 'open', now, q);

export async function editTask(db: Db, code: string, opts: EditOptions, now: Date, q?: Sql): Promise<TaskRow> {
  const t = await findTask(q ?? db, code);
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
  await inTx(db, q, async (q) => {
    await updateTaskFields(q, t.id, fields, now.toISOString(), 'human');
    await humanEvent(q, t.id, t.clientId, 'update_task', fields, now);
    await requestRebuild(q, now);
  });
  return findTask(q ?? db, t.code);
}

export async function unlockTask(db: Db, code: string, now: Date, q?: Sql): Promise<TaskRow> {
  const t = await findTask(q ?? db, code);
  await inTx(db, q, async (q) => {
    await clearTaskLocks(q, t.id, now.toISOString());
    await humanEvent(q, t.id, t.clientId, 'unlock', { lockedFields: t.lockedFields, statusLocked: t.statusLockedAt !== null }, now);
    await requestRebuild(q, now);
  });
  return findTask(q ?? db, t.code);
}

/** Accepts a phone number (any punctuation) or a WhatsApp id (contains @). Returns how many group memberships changed. */
export async function setPersonRole(db: Db, who: string, roleInput: string, clientCode: string | undefined, now: Date): Promise<number> {
  const role = roleInput.trim().toLowerCase();
  if (role !== 'team' && role !== 'client') throw new CorrectionError('role must be team or client');
  const target = who.trim();
  let people: PersonRow[];
  let detailKey: { jid: string } | { number: string };
  if (target.includes('@')) {
    people = await findPeopleByJid(db, target);
    detailKey = { jid: target };
  } else {
    const digits = target.replace(/\D/g, '');
    if (digits === '') throw new CorrectionError('Give the full phone number with country code, e.g. 919812345678, or a WhatsApp id');
    // The schema has no link between a LID row and a phone-number row, so only rows that carry this number or its phone id match.
    const byNumber = await findPeopleByNumber(db, digits);
    const seen = new Set(byNumber.map((p) => p.id));
    people = [...byNumber, ...(await findPeopleByJid(db, `${digits}@s.whatsapp.net`)).filter((p) => !seen.has(p.id))];
    detailKey = { number: digits };
  }
  if (people.length === 0) throw new CorrectionError(`No one with that ${target.includes('@') ? 'WhatsApp id' : 'number'} has posted in an allowed group yet`);
  if (clientCode) {
    const c = await findClient(db, clientCode);
    people = people.filter((p) => p.clientId === c.id);
    if (people.length === 0) throw new CorrectionError(`That number has posted, but not in client ${c.code}`);
  }
  const chosen = people;
  await db.tx(async (q) => {
    for (const p of chosen) {
      await setRole(q, p.clientId, p.jid, role, 'human');
      await humanEvent(q, null, p.clientId, 'set_person_role', { ...detailKey, role }, now);
    }
    await requestRebuild(q, now);
  });
  return chosen.length;
}

export async function setClientPhase(db: Db, clientCode: string, phase: string, now: Date): Promise<void> {
  const c = await findClient(db, clientCode);
  const match = c.phases.find((p) => p.toLowerCase() === phase.trim().toLowerCase());
  if (!match) throw new CorrectionError(`Phase must be one of: ${c.phases.join(', ')}`);
  await db.tx(async (q) => {
    await setPhase(q, c.id, match, 'human');
    await humanEvent(q, null, c.id, 'set_phase', { phase: match }, now);
    await requestRebuild(q, now);
  });
}

export async function unlockClientPhase(db: Db, clientCode: string, now: Date): Promise<void> {
  const c = await findClient(db, clientCode);
  await db.tx(async (q) => {
    await clearPhaseLock(q, c.id);
    await humanEvent(q, null, c.id, 'unlock_phase', { phase: c.currentPhase }, now);
    await requestRebuild(q, now);
  });
}

/** Above this many messages the CLI only previews until --yes is given. */
export const REPROCESS_CONFIRM_ABOVE = 200;

interface ReprocessWindow {
  clientId: number;
  sinceIso: string;
  untilIso: string | undefined;
}

async function reprocessWindow(db: Db, clientCode: string, since: string, until: string | undefined): Promise<ReprocessWindow> {
  if (!isIsoDate(since)) throw new CorrectionError('--since must be YYYY-MM-DD');
  if (until !== undefined) {
    if (!isIsoDate(until)) throw new CorrectionError('--until must be YYYY-MM-DD');
    if (until < since) throw new CorrectionError('--until must be on or after --since');
  }
  const c = await findClient(db, clientCode);
  if (!c.active) throw new CorrectionError(`Client ${c.code} is not in the allow-list; nothing to reprocess`);
  // --until covers that whole India-time day, so the limit is the start of the next day.
  const untilIso = until === undefined ? undefined : new Date(fromIstDate(until).getTime() + 86_400_000).toISOString();
  return { clientId: c.id, sinceIso: fromIstDate(since).toISOString(), untilIso };
}

/** How many processed messages a reprocess would queue. Changes nothing. */
export async function countReprocess(db: Db, clientCode: string, since: string, until?: string): Promise<number> {
  const w = await reprocessWindow(db, clientCode, since, until);
  return countProcessedBetween(db, w.clientId, w.sinceIso, w.untilIso);
}

/** Re-queues processed messages in the window for the AI. Returns how many were actually re-queued. */
export async function requestReprocess(db: Db, clientCode: string, since: string, now: Date, until?: string): Promise<number> {
  const w = await reprocessWindow(db, clientCode, since, until);
  return db.tx(async (q) => {
    const n = await resetProcessedSince(q, w.clientId, w.sinceIso, w.untilIso);
    await humanEvent(q, null, w.clientId, 'reprocess', { since, until: until ?? null, messages: n }, now);
    await requestRebuild(q, now);
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
export async function reprocess(db: Db, clientCode: string, since: string, until: string | undefined, yes: boolean, now: Date): Promise<ReprocessResult> {
  const count = await countReprocess(db, clientCode, since, until);
  const maxCostUsd = Math.ceil(count / 200) * 0.5;
  if (count === 0) return { count, queued: 0, needsConfirm: false, maxCostUsd };
  if (count > REPROCESS_CONFIRM_ABOVE && !yes) return { count, queued: 0, needsConfirm: true, maxCostUsd };
  return { count, queued: await requestReprocess(db, clientCode, since, now, until), needsConfirm: false, maxCostUsd };
}
