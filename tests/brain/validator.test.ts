import { describe, expect, it } from 'vitest';
import { validateOps, type ValidationState } from '../../src/brain/validator.ts';
import type { PersonRow } from '../../src/store/people.ts';
import type { TaskRow } from '../../src/store/tasks.ts';
import { op } from '../helpers/ai.ts';
import { NOW, SHARMA } from '../helpers/db.ts';
import { SHARMA_PN } from '../helpers/wa.ts';

const task = (o: Partial<TaskRow> = {}): TaskRow => ({
  id: 1, code: 'SHA-012', clientId: 1, side: 'us', title: 'Revise homepage banner', category: 'design', priority: 'high', assignedTo: null,
  askedBy: null, raisedOn: '2026-10-10', deadline: null, latestProgress: null, reminderCount: 0, lastReminderOn: null, status: 'open',
  sourceQuote: null, sourceDate: null, sourceWaId: 'm1', sourceRevoked: false, closedOn: null, origin: 'whatsapp', lockedFields: [],
  statusLockedAt: null, createdAt: NOW, updatedAt: NOW, ...o,
});
const person = (jid: string, roleSetBy: PersonRow['roleSetBy']): PersonRow => ({ id: 1, clientId: 1, jid, number: null, name: 'x', role: 'unknown', roleSetBy });

function state(o: Partial<ValidationState> = {}): ValidationState {
  return {
    clientCode: 'SHA', phases: SHARMA.phases, phaseLocked: false,
    tasksByCode: new Map([['SHA-012', task()]]),
    batchIds: new Set(['n1', 'n2']), contextIds: new Set(['c1']),
    messageTs: new Map([['n1', '2026-10-19T08:00:00.000Z'], ['n2', '2026-10-19T10:00:00.000Z'], ['c1', '2026-10-18T08:00:00.000Z']]),
    peopleByJid: new Map([[SHARMA_PN, person(SHARMA_PN, 'ai')], ['self@founder', person('self@founder', 'system')]]),
    ...o,
  };
}

const addTask = (o = {}) => op({ op: 'add_task', side: 'us', title: 'Banner', category: 'design', priority: 'high', sourceMessageIds: ['n1'], ...o });
const reasons = (ops: Parameters<typeof validateOps>[0], s = state()) => validateOps(ops, s).rejected.map((r) => r.reason);

describe('validateOps', () => {
  it('accepts a valid add_task', () => {
    expect(validateOps([addTask()], state()).accepted).toHaveLength(1);
  });

  it('requires evidence from the new messages', () => {
    expect(reasons([addTask({ sourceMessageIds: ['c1'] })])).toEqual(['no evidence from new messages']);
    expect(reasons([addTask({ sourceMessageIds: [] })])).toEqual(['no source messages']);
    expect(reasons([addTask({ sourceMessageIds: ['zz'] })])).toEqual(['no source messages']);
  });

  it('drops unknown source ids instead of rejecting the operation', () => {
    const { accepted, rejected } = validateOps([addTask({ sourceMessageIds: ['n1', 'zz'] })], state());
    expect(rejected).toEqual([]);
    expect(accepted[0]?.sourceMessageIds).toEqual(['n1']);
  });

  it('accepts ids written with brackets or a prefix', () => {
    const { accepted } = validateOps([addTask({ sourceMessageIds: ['[n1]', 'm:n2'] })], state());
    expect(accepted[0]?.sourceMessageIds).toEqual(['n1', 'n2']);
  });

  it('checks required fields, task codes and dates', () => {
    expect(reasons([addTask({ title: null })])).toEqual(['add_task needs side, title, category and priority']);
    expect(reasons([op({ op: 'close_task', taskCode: 'SHA-999', sourceMessageIds: ['n1'] })])).toEqual(['unknown task code for this client']);
    expect(reasons([addTask({ deadline: '18 Oct' })])).toEqual(['deadline is not YYYY-MM-DD']);
  });

  it('allows add_task to carry an initial status', () => {
    expect(validateOps([addTask({ status: 'done' })], state()).accepted).toHaveLength(1);
  });

  it('strips human-locked fields and rejects an update with nothing left', () => {
    const s = state({ tasksByCode: new Map([['SHA-012', task({ lockedFields: ['title'] })]]) });
    const mixed = validateOps([op({ op: 'update_task', taskCode: 'SHA-012', title: 'New', deadline: '2026-10-25', sourceMessageIds: ['n1'] })], s);
    expect(mixed.accepted[0]).toMatchObject({ title: null, deadline: '2026-10-25' });
    expect(reasons([op({ op: 'update_task', taskCode: 'SHA-012', title: 'New', sourceMessageIds: ['n1'] })], s)).toEqual(['no unlocked fields to change']);
  });

  it('respects done tasks and human status locks', () => {
    const done = state({ tasksByCode: new Map([['SHA-012', task({ status: 'done' })]]) });
    expect(reasons([op({ op: 'close_task', taskCode: 'SHA-012', sourceMessageIds: ['n1'] })], done)).toEqual(['task already done']);
    const locked = state({ tasksByCode: new Map([['SHA-012', task({ statusLockedAt: '2026-10-19T09:00:00.000Z' })]]) });
    expect(reasons([op({ op: 'close_task', taskCode: 'SHA-012', sourceMessageIds: ['n1'] })], locked)).toEqual(['status was set by a human; needs newer evidence']);
    expect(validateOps([op({ op: 'close_task', taskCode: 'SHA-012', sourceMessageIds: ['n2'] })], locked).accepted).toHaveLength(1);
  });

  it('reopens only maybe-done tasks, honouring the human status lock', () => {
    const reopen = (ids: string[]) => op({ op: 'reopen_task', taskCode: 'SHA-012', sourceMessageIds: ids });
    expect(reasons([reopen(['n1'])])).toEqual(['only a maybe-done task can be reopened']);
    const maybe = state({ tasksByCode: new Map([['SHA-012', task({ status: 'maybe_done' })]]) });
    expect(validateOps([reopen(['n1'])], maybe).accepted).toHaveLength(1);
    const locked = state({ tasksByCode: new Map([['SHA-012', task({ status: 'maybe_done', statusLockedAt: '2026-10-19T09:00:00.000Z' })]]) });
    expect(reasons([reopen(['n1'])], locked)).toEqual(['status was set by a human; needs newer evidence']);
    expect(validateOps([reopen(['n2'])], locked).accepted).toHaveLength(1);
  });

  it('checks phases and person roles', () => {
    expect(reasons([op({ op: 'set_phase', phase: 'Party', sourceMessageIds: ['n1'] })])).toEqual(['phase is not one of the client phases']);
    expect(reasons([op({ op: 'set_phase', phase: 'Design', sourceMessageIds: ['n1'] })], state({ phaseLocked: true }))).toEqual(['phase was set by a human']);
    expect(reasons([op({ op: 'set_person_role', personJid: 'self@founder', role: 'client', sourceMessageIds: ['n1'] })])).toEqual(['role was set by a human or is the founder']);
    expect(validateOps([op({ op: 'set_person_role', personJid: SHARMA_PN, role: 'client', sourceMessageIds: ['n1'] })], state()).accepted).toHaveLength(1);
  });

  it('keeps only the last set_status', () => {
    const { accepted } = validateOps([
      op({ op: 'set_status', text: 'first', sourceMessageIds: ['n1'] }),
      addTask(),
      op({ op: 'set_status', text: 'second', sourceMessageIds: ['n2'] }),
    ], state());
    expect(accepted.map((a) => a.text ?? a.op)).toEqual(['add_task', 'second']);
  });
});
