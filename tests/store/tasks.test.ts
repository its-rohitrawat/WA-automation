import { describe, expect, it } from 'vitest';
import { finishBatch, latestBatches, startBatch } from '../../src/store/batches.ts';
import {
  addDecision, createTask, getTaskByCode, listDecisions, listTasks, logReminder, recordEvent, setTaskStatus, taskSourceIds, updateTaskFields, type NewTask,
} from '../../src/store/tasks.ts';
import { LATER, NOW, seededDb } from '../helpers/db.ts';

const newTask = (o: Partial<NewTask> = {}): NewTask => ({
  clientId: 1, side: 'us', title: 'Revise homepage banner', category: 'design', priority: 'high', assignedTo: 'Rahul', askedBy: 'Mr. Sharma',
  raisedOn: '2026-10-10', deadline: '2026-10-18', latestProgress: null, sourceQuote: 'banner thoda bright karo', sourceDate: '2026-10-10',
  sourceWaId: 'm1', origin: 'whatsapp', ...o,
});

describe('tasks repository', () => {
  it('creates tasks with per-client codes', () => {
    const db = seededDb();
    expect(createTask(db, newTask(), NOW)).toMatchObject({ code: 'SHA-001', status: 'open', reminderCount: 0, lockedFields: [], statusLockedAt: null });
    expect(createTask(db, newTask({ clientId: 2 }), NOW).code).toBe('MEH-001');
  });

  it('updates fields, and human edits lock them', () => {
    const db = seededDb();
    const t = createTask(db, newTask(), NOW);
    updateTaskFields(db, t.id, { deadline: '2026-10-25' }, NOW, 'ai');
    expect(getTaskByCode(db, 'SHA-001')).toMatchObject({ deadline: '2026-10-25', lockedFields: [] });
    updateTaskFields(db, t.id, { title: 'Brighter banner' }, LATER, 'human');
    expect(getTaskByCode(db, 'SHA-001')).toMatchObject({ title: 'Brighter banner', lockedFields: ['title'], updatedAt: LATER });
  });

  it('closes and reopens; human status changes are timestamped', () => {
    const db = seededDb();
    const t = createTask(db, newTask(), NOW);
    setTaskStatus(db, t.id, 'done', '2026-10-19', NOW, 'ai');
    expect(getTaskByCode(db, 'SHA-001')).toMatchObject({ status: 'done', closedOn: '2026-10-19', statusLockedAt: null });
    setTaskStatus(db, t.id, 'open', '2026-10-19', LATER, 'human');
    expect(getTaskByCode(db, 'SHA-001')).toMatchObject({ status: 'open', closedOn: null, statusLockedAt: LATER });
  });

  it('counts reminders and filters by status', () => {
    const db = seededDb();
    const a = createTask(db, newTask(), NOW);
    createTask(db, newTask({ title: 'Send logo files', side: 'client' }), NOW);
    logReminder(db, a.id, '2026-10-13', NOW);
    logReminder(db, a.id, '2026-10-17', NOW);
    expect(getTaskByCode(db, 'SHA-001')).toMatchObject({ reminderCount: 2, lastReminderOn: '2026-10-17' });
    setTaskStatus(db, a.id, 'maybe_done', '2026-10-19', NOW, 'ai');
    expect(listTasks(db, 1, ['open']).map((t) => t.code)).toEqual(['SHA-002']);
    expect(listTasks(db, 1).map((t) => t.code)).toEqual(['SHA-001', 'SHA-002']);
  });

  it('never moves the last reminder date back: a file read late can log an older reminder (final review)', () => {
    const db = seededDb();
    const a = createTask(db, newTask(), NOW);
    logReminder(db, a.id, '2026-10-02', NOW);
    logReminder(db, a.id, '2026-10-01', LATER);
    expect(getTaskByCode(db, 'SHA-001')).toMatchObject({ reminderCount: 2, lastReminderOn: '2026-10-02', updatedAt: LATER });
  });

  it('records events and decisions', () => {
    const db = seededDb();
    const t = createTask(db, newTask(), NOW);
    recordEvent(db, { taskId: t.id, clientId: 1, actor: 'ai', op: 'add_task', detail: { code: t.code }, reason: 'asked in chat', sourceIds: ['m1'], at: NOW });
    expect(db.prepare('SELECT actor, op, source_ids FROM task_events').get()).toEqual({ actor: 'ai', op: 'add_task', source_ids: '["m1"]' });
    addDecision(db, { clientId: 1, text: 'Blue theme', decidedOn: '2026-10-14', source: 'whatsapp', sourceWaId: 'm5' }, NOW);
    addDecision(db, { clientId: 1, text: 'Launch 1 Nov', decidedOn: '2026-10-15', source: 'whatsapp', sourceWaId: 'm6' }, NOW);
    expect(listDecisions(db, 1).map((d) => d.text)).toEqual(['Launch 1 Nov', 'Blue theme']);
    expect(listDecisions(db, 1, 1)).toHaveLength(1);
  });

  it('taskSourceIds covers every message any event of a task cited, whatever the op or actor', () => {
    const db = seededDb();
    const t = createTask(db, newTask({ sourceWaId: 'm1' }), NOW);
    const other = createTask(db, newTask({ clientId: 2, sourceWaId: 'z1' }), NOW);
    const ev = (taskId: number | null, clientId: number, actor: 'ai' | 'human', op: string, sourceIds: string[]) =>
      recordEvent(db, { taskId, clientId, actor, op, detail: {}, reason: null, sourceIds, at: NOW });
    ev(t.id, 1, 'ai', 'add_task', ['m1', 'm2']);
    ev(t.id, 1, 'ai', 'log_reminder', ['m3']);
    ev(t.id, 1, 'ai', 'update_task', ['m4']);
    ev(t.id, 1, 'ai', 'mark_maybe_done', ['m5']);
    ev(t.id, 1, 'ai', 'close_task', ['m6']);
    ev(t.id, 1, 'human', 'reopen_task', []);
    ev(null, 1, 'ai', 'add_decision', ['d1']); // not task evidence
    ev(null, 1, 'ai', 'set_status', ['s1']);
    ev(other.id, 2, 'ai', 'log_reminder', ['z2']); // another client
    expect([...taskSourceIds(db, 1)].sort()).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
  });

  it('records batches and reports the latest per client', () => {
    const db = seededDb();
    const a = startBatch(db, 1, 3, NOW);
    finishBatch(db, a, { status: 'ok', errorCode: null, accepted: 2, rejected: 0, at: NOW });
    const b = startBatch(db, 1, 1, LATER);
    finishBatch(db, b, { status: 'failed', errorCode: 'refusal', accepted: null, rejected: null, at: LATER });
    expect(latestBatches(db)).toEqual([{ clientId: 1, status: 'failed', errorCode: 'refusal', finishedAt: LATER }]);
  });
});
