import { describe, expect, it } from 'vitest';
import { validateOps, type ValidationState } from '../../src/brain/validator.ts';
import type { PersonRow } from '../../src/store/people.ts';
import type { TaskRow } from '../../src/store/tasks.ts';
import { op } from '../helpers/ai.ts';
import { NOW, SHARMA } from '../helpers/db.ts';
import { SHARMA_PN } from '../helpers/wa.ts';

const task = (o: Partial<TaskRow> = {}): TaskRow => ({
  id: 1, code: 'SHA-012', clientId: 1, side: 'us', title: 'Revise homepage banner', category: 'design', priority: 'major', legacyPriority: 'high', prioritySource: 'ai', priorityKeyword: null, sentiment: null, assignedTo: null,
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
    taskSourceIds: new Set(['old1']), reminderSourceIds: new Map([['SHA-012', new Set(['old2'])]]), decisionSourceIds: new Set(['old3']), editedIds: new Set(),
    ...o,
  };
}

const addTask = (o = {}) => op({ op: 'add_task', side: 'us', title: 'Banner', category: 'design', priority: 'major', sourceMessageIds: ['n1'], ...o });
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

  const two = (): ValidationState => state({ tasksByCode: new Map([['SHA-001', task({ code: 'SHA-001' })], ['SHA-002', task({ id: 2, code: 'SHA-002' })]]) });
  const remind = (code: string) => op({ op: 'log_reminder', taskCode: code, sourceMessageIds: ['n1'] });

  it('accepts a log_reminder on an open task', () => {
    expect(validateOps([remind('SHA-012')], state()).accepted).toHaveLength(1);
  });

  it('rejects a repeated reminder for the same task in one response', () => {
    const r = validateOps([remind('SHA-001'), remind('SHA-001'), remind('SHA-002')], two());
    expect(r.accepted.map((a) => a.taskCode)).toEqual(['SHA-001', 'SHA-002']);
    expect(r.rejected.map((x) => x.reason)).toEqual(['duplicate reminder in one response']);
  });

  it('rejects a duplicate add_task by side and normalised title', () => {
    expect(reasons([addTask({ title: 'Revise  Banner' }), addTask({ title: 'revise banner' })])).toEqual(['duplicate task in one response']);
    expect(validateOps([addTask({ title: 'Revise Banner' }), addTask({ title: 'revise banner', side: 'client' })], state()).accepted).toHaveLength(2);
  });

  it('rejects over-long fields', () => {
    expect(reasons([addTask({ title: 'a'.repeat(201) })])).toEqual(['field too long']);
    expect(reasons([addTask({ assignedTo: 'a'.repeat(81) })])).toEqual(['field too long']);
    expect(reasons([op({ op: 'update_task', taskCode: 'SHA-012', title: 'a'.repeat(201), sourceMessageIds: ['n1'] })])).toEqual(['field too long']);
    expect(reasons([op({ op: 'update_task', taskCode: 'SHA-012', latestProgress: 'a'.repeat(601), sourceMessageIds: ['n1'] })])).toEqual(['field too long']);
  });

  it('counts code points, not UTF-16 units, for field length', () => {
    expect(validateOps([addTask({ title: '\u{1F600}'.repeat(200) })], state()).accepted).toHaveLength(1);
  });

  it('cuts a long reason to 300 code points', () => {
    expect(validateOps([addTask({ reason: 'r'.repeat(400) })], state()).accepted[0]?.reason).toHaveLength(300);
  });

  it('keeps only the last status op per task and the last set_status, rejecting the rest', () => {
    const ops = [
      op({ op: 'close_task', taskCode: 'SHA-012', sourceMessageIds: ['n1'] }),
      op({ op: 'mark_maybe_done', taskCode: 'SHA-012', sourceMessageIds: ['n1'] }),
      op({ op: 'set_status', text: 'first', sourceMessageIds: ['n1'] }),
      op({ op: 'set_status', text: 'second', sourceMessageIds: ['n2'] }),
    ];
    const r = validateOps(ops, state());
    expect(r.accepted.map((a) => a.text ?? a.op)).toEqual(['mark_maybe_done', 'second']);
    expect(r.rejected.map((x) => [x.op.text ?? x.op.op, x.reason])).toEqual([
      ['close_task', 'superseded by a later operation'],
      ['first', 'superseded by a later operation'],
    ]);
    expect(r.accepted.length + r.rejected.length).toBe(ops.length);
  });

  it('de-duplicates source ids', () => {
    expect(validateOps([addTask({ sourceMessageIds: ['n1', '[n1]', 'm:n1'] })], state()).accepted[0]?.sourceMessageIds).toEqual(['n1']);
  });

  it('rejects a task code from another client', () => {
    expect(reasons([op({ op: 'close_task', taskCode: 'MEH-001', sourceMessageIds: ['n1'] })])).toEqual(['task belongs to another client']);
  });

  it('rejects mark_maybe_done on a maybe-done task', () => {
    const s = state({ tasksByCode: new Map([['SHA-012', task({ status: 'maybe_done' })]]) });
    expect(reasons([op({ op: 'mark_maybe_done', taskCode: 'SHA-012', sourceMessageIds: ['n1'] })], s)).toEqual(['task already maybe done']);
  });

  it('rejects missing or over-long text', () => {
    expect(reasons([op({ op: 'add_decision', sourceMessageIds: ['n1'] })])).toEqual(['text missing or too long']);
    expect(reasons([op({ op: 'set_status', text: 'a'.repeat(601), sourceMessageIds: ['n1'] })])).toEqual(['text missing or too long']);
  });

  it('rejects unknown persons and human-set roles', () => {
    expect(reasons([op({ op: 'set_person_role', personJid: 'nobody@x', role: 'client', sourceMessageIds: ['n1'] })])).toEqual(['unknown person or missing role']);
    const s = state({ peopleByJid: new Map([[SHARMA_PN, person(SHARMA_PN, 'human')]]) });
    expect(reasons([op({ op: 'set_person_role', personJid: SHARMA_PN, role: 'client', sourceMessageIds: ['n1'] })], s)).toEqual(['role was set by a human or is the founder']);
  });

  describe('replay guard', () => {
    const replay = (extra: Partial<ValidationState> = {}) => state({ batchIds: new Set(['n1', 'old1', 'old2', 'old3']), ...extra });
    it('rejects a second task, reminder or decision from the same message', () => {
      expect(reasons([addTask({ sourceMessageIds: ['old1'] })], replay())).toEqual(['task already exists for this message']);
      expect(reasons([op({ op: 'log_reminder', taskCode: 'SHA-012', sourceMessageIds: ['old2'] })], replay())).toEqual(['reminder already counted for this message']);
      expect(reasons([op({ op: 'add_decision', text: 'Blue', sourceMessageIds: ['old3'] })], replay())).toEqual(['decision already recorded for this message']);
    });
    it('accepts a reminder when at least one cited message is new', () => {
      const r = (ids: string[]) => op({ op: 'log_reminder', taskCode: 'SHA-012', sourceMessageIds: ids });
      expect(validateOps([r(['old2', 'n1'])], replay()).accepted).toHaveLength(1);
      expect(reasons([r(['old2'])], replay())).toEqual(['reminder already counted for this message']);
    });
    it('accepts brand-new messages', () => {
      expect(validateOps([addTask({ sourceMessageIds: ['n1'] })], replay()).accepted).toHaveLength(1);
      expect(validateOps([op({ op: 'log_reminder', taskCode: 'SHA-012', sourceMessageIds: ['n1'] })], replay()).accepted).toHaveLength(1);
      expect(validateOps([op({ op: 'add_decision', text: 'Blue', sourceMessageIds: ['n1'] })], replay()).accepted).toHaveLength(1);
    });
    it('lets edit re-checks through', () => {
      const s = replay({ editedIds: new Set(['old1', 'old2', 'old3']) });
      expect(validateOps([addTask({ sourceMessageIds: ['old1'] })], s).accepted).toHaveLength(1);
      expect(validateOps([op({ op: 'log_reminder', taskCode: 'SHA-012', sourceMessageIds: ['old2'] })], s).accepted).toHaveLength(1);
      expect(validateOps([op({ op: 'add_decision', text: 'Blue', sourceMessageIds: ['old3'] })], s).accepted).toHaveLength(1);
    });
    it('judges a reminder only by its guarded (not edited) batch ids', () => {
      const r = (ids: string[]) => op({ op: 'log_reminder', taskCode: 'SHA-012', sourceMessageIds: ids });
      const s = replay({ editedIds: new Set(['n1']) });
      // The edited id is skipped; the only guarded id was already counted.
      expect(reasons([r(['n1', 'old2'])], s)).toEqual(['reminder already counted for this message']);
      // No guarded id at all: an edit re-check alone may count.
      expect(validateOps([r(['n1'])], s).accepted).toHaveLength(1);
      // A context id is not a batch id, so it never makes a reminder look already counted.
      expect(validateOps([r(['n1', 'c1'])], s).accepted).toHaveLength(1);
      // Counted for another task does not count for this one.
      const other = replay({ reminderSourceIds: new Map([['SHA-999', new Set(['old2'])]]) });
      expect(validateOps([r(['old2'])], other).accepted).toHaveLength(1);
    });
  });
});
