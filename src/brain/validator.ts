import type { PersonRow } from '../store/people.ts';
import { TASK_FIELDS, type TaskRow } from '../store/tasks.ts';
import { isIsoDate } from '../util/time.ts';
import type { AiOp } from './schema.ts';

export interface ValidationState {
  clientCode: string;
  phases: string[];
  phaseLocked: boolean;
  /** Open and maybe-done tasks of this client only. */
  tasksByCode: Map<string, TaskRow>;
  batchIds: Set<string>;
  contextIds: Set<string>;
  messageTs: Map<string, string>;
  peopleByJid: Map<string, PersonRow>;
  /** source_wa_id of every task of this client, any status. */
  taskSourceIds: Set<string>;
  /** Task code to the message ids already cited by an applied log_reminder. */
  reminderSourceIds: Map<string, Set<string>>;
  /** source_wa_id of every decision of this client. */
  decisionSourceIds: Set<string>;
  /** Batch messages that are edit or reaction re-checks. */
  requeuedIds: Set<string>;
}

export interface Rejection {
  op: AiOp;
  reason: string;
}

const TASK_OPS = new Set<AiOp['op']>(['update_task', 'close_task', 'mark_maybe_done', 'reopen_task', 'log_reminder']);

const MAX_LEN = { title: 200, assignedTo: 80, askedBy: 80, latestProgress: 600 } as const;
const MAX_REASON = 300;
const STATUS_OPS = new Set<AiOp['op']>(['close_task', 'mark_maybe_done', 'reopen_task']);
const SUPERSEDED = 'superseded by a later operation';

const cp = (s: string): number => [...s].length;
const tooLong = (op: AiOp): boolean =>
  (Object.keys(MAX_LEN) as (keyof typeof MAX_LEN)[]).some((f) => op[f] !== null && cp(op[f]) > MAX_LEN[f]);
const titleKey = (op: AiOp): string => `${op.side}|${(op.title ?? '').toLowerCase().replace(/\s+/g, ' ').trim()}`;

export function normalizeSourceId(id: string): string {
  return id.trim().replace(/^\[/, '').replace(/\]$/, '').replace(/^(m:|id=)/, '');
}

export function validateOps(ops: AiOp[], s: ValidationState): { accepted: AiOp[]; rejected: Rejection[] } {
  const accepted: AiOp[] = [];
  const rejected: Rejection[] = [];
  const addKeys = new Set<string>();
  const remindedCodes = new Set<string>();

  for (const raw of ops) {
    // Unknown ids (the model sometimes cites an old one) are dropped, not fatal.
    const ids = [...new Set(raw.sourceMessageIds.map(normalizeSourceId).filter((id) => s.batchIds.has(id) || s.contextIds.has(id)))];
    const op: AiOp = { ...raw, sourceMessageIds: ids, reason: [...raw.reason].slice(0, MAX_REASON).join('') };
    const reject = (reason: string) => rejected.push({ op, reason });

    if (ids.length === 0) { reject('no source messages'); continue; }
    if (!ids.some((id) => s.batchIds.has(id))) { reject('no evidence from new messages'); continue; }
    if (op.deadline !== null && !isIsoDate(op.deadline)) { reject('deadline is not YYYY-MM-DD'); continue; }

    if (TASK_OPS.has(op.op) && op.taskCode && !op.taskCode.startsWith(`${s.clientCode}-`)) { reject('task belongs to another client'); continue; }

    const task = TASK_OPS.has(op.op) && op.taskCode ? s.tasksByCode.get(op.taskCode) : undefined;
    if (TASK_OPS.has(op.op) && !task) { reject('unknown task code for this client'); continue; }

    // A message that was processed before and comes back without a re-check marker (a reprocess, or a crash before
    // marking) must not produce the same task, reminder or decision again.
    const fresh = ids.filter((id) => s.batchIds.has(id) && !s.requeuedIds.has(id));

    switch (op.op) {
      case 'add_task':
        if (fresh.some((id) => s.taskSourceIds.has(id))) { reject('task already exists for this message'); continue; }
        if (!op.side || !op.title || !op.category || !op.priority) { reject('add_task needs side, title, category and priority'); continue; }
        if (tooLong(op)) { reject('field too long'); continue; }
        if (addKeys.has(titleKey(op))) { reject('duplicate task in one response'); continue; }
        addKeys.add(titleKey(op));
        break;
      case 'update_task': {
        if (tooLong(op)) { reject('field too long'); continue; }
        const locked = new Set(task!.lockedFields);
        const stripped: AiOp = { ...op };
        let changes = 0;
        for (const f of TASK_FIELDS) {
          if (stripped[f] === null) continue;
          if (locked.has(f)) {
            (stripped as unknown as Record<string, unknown>)[f] = null;
            continue;
          }
          changes++;
        }
        if (changes === 0) { reject('no unlocked fields to change'); continue; }
        accepted.push(stripped);
        continue;
      }
      case 'close_task':
      case 'mark_maybe_done':
      case 'reopen_task': {
        if (op.op === 'reopen_task') {
          if (task!.status !== 'maybe_done') { reject('only a maybe-done task can be reopened'); continue; }
        } else {
          if (task!.status === 'done') { reject('task already done'); continue; }
          if (op.op === 'mark_maybe_done' && task!.status === 'maybe_done') { reject('task already maybe done'); continue; }
        }
        const lockedAt = task!.statusLockedAt;
        if (lockedAt && !ids.some((id) => s.batchIds.has(id) && (s.messageTs.get(id) ?? '') > lockedAt)) {
          reject('status was set by a human; needs newer evidence');
          continue;
        }
        break;
      }
      case 'log_reminder':
        if (fresh.some((id) => s.reminderSourceIds.get(op.taskCode!)?.has(id))) { reject('reminder already counted for this message'); continue; }
        if (remindedCodes.has(op.taskCode!)) { reject('duplicate reminder in one response'); continue; }
        remindedCodes.add(op.taskCode!);
        break;
      case 'add_decision':
        if (fresh.some((id) => s.decisionSourceIds.has(id))) { reject('decision already recorded for this message'); continue; }
        if (!op.text || op.text.length > 600) { reject('text missing or too long'); continue; }
        break;
      case 'set_status':
        if (!op.text || op.text.length > 600) { reject('text missing or too long'); continue; }
        break;
      case 'set_phase':
        if (!op.phase || !s.phases.includes(op.phase)) { reject('phase is not one of the client phases'); continue; }
        if (s.phaseLocked) { reject('phase was set by a human'); continue; }
        break;
      case 'set_person_role': {
        const person = op.personJid ? s.peopleByJid.get(op.personJid) : undefined;
        if (!person || !op.role) { reject('unknown person or missing role'); continue; }
        if (person.roleSetBy !== 'ai') { reject('role was set by a human or is the founder'); continue; }
        break;
      }
    }
    accepted.push(op);
  }

  // The last status op per task wins, and the last set_status wins.
  const lastKey = new Map<string, number>();
  accepted.forEach((o, i) => {
    if (STATUS_OPS.has(o.op)) lastKey.set(`task:${o.taskCode}`, i);
    else if (o.op === 'set_status') lastKey.set('set_status', i);
  });
  const kept: AiOp[] = [];
  accepted.forEach((o, i) => {
    const key = STATUS_OPS.has(o.op) ? `task:${o.taskCode}` : o.op === 'set_status' ? 'set_status' : null;
    if (key !== null && lastKey.get(key) !== i) rejected.push({ op: o, reason: SUPERSEDED });
    else kept.push(o);
  });
  return { accepted: kept, rejected };
}
