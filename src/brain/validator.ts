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
}

export interface Rejection {
  op: AiOp;
  reason: string;
}

const TASK_OPS = new Set<AiOp['op']>(['update_task', 'close_task', 'mark_maybe_done', 'reopen_task', 'log_reminder']);

export function normalizeSourceId(id: string): string {
  return id.trim().replace(/^\[/, '').replace(/\]$/, '').replace(/^(m:|id=)/, '');
}

export function validateOps(ops: AiOp[], s: ValidationState): { accepted: AiOp[]; rejected: Rejection[] } {
  const accepted: AiOp[] = [];
  const rejected: Rejection[] = [];

  for (const raw of ops) {
    // Unknown ids (the model sometimes cites an old one) are dropped, not fatal.
    const ids = raw.sourceMessageIds.map(normalizeSourceId).filter((id) => s.batchIds.has(id) || s.contextIds.has(id));
    const op: AiOp = { ...raw, sourceMessageIds: ids };
    const reject = (reason: string) => rejected.push({ op, reason });

    if (ids.length === 0) { reject('no source messages'); continue; }
    if (!ids.some((id) => s.batchIds.has(id))) { reject('no evidence from new messages'); continue; }
    if (op.deadline !== null && !isIsoDate(op.deadline)) { reject('deadline is not YYYY-MM-DD'); continue; }

    const task = TASK_OPS.has(op.op) && op.taskCode ? s.tasksByCode.get(op.taskCode) : undefined;
    if (TASK_OPS.has(op.op) && !task) { reject('unknown task code for this client'); continue; }

    switch (op.op) {
      case 'add_task':
        if (!op.side || !op.title || !op.category || !op.priority) { reject('add_task needs side, title, category and priority'); continue; }
        if (op.title.length > 200) { reject('title too long'); continue; }
        break;
      case 'update_task': {
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
        break;
      case 'add_decision':
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

  const lastStatus = accepted.map((o) => o.op).lastIndexOf('set_status');
  return { accepted: accepted.filter((o, i) => o.op !== 'set_status' || i === lastStatus), rejected };
}
