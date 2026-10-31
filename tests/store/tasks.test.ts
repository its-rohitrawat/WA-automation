import { describe, expect, it } from 'vitest';
import { finishBatch, latestBatches, startBatch } from '../../src/store/batches.ts';
import {
  addDecision, createTask, getTaskByCode, listDecisions, listTasks, logReminder, recordEvent, setTaskStatus, taskSourceIds, updateTaskFields, type NewTask,
} from '../../src/store/tasks.ts';
import { LATER, NOW, row, seeded } from '../helpers/db.ts';

/** A task of `clientId` (a real id: on Postgres the ids are not 1 and 2). */
const newTask = (clientId: number, o: Partial<NewTask> = {}): NewTask => ({
  clientId, side: 'us', title: 'Revise homepage banner', category: 'design', priority: 'major', assignedTo: 'Rahul', askedBy: 'Mr. Sharma',
  raisedOn: '2026-10-10', deadline: '2026-10-18', latestProgress: null, sourceQuote: 'banner thoda bright karo', sourceDate: '2026-10-10',
  sourceWaId: 'm1', origin: 'whatsapp', ...o,
});

describe('tasks repository', () => {
  it('creates tasks with per-client codes', async () => {
    const { db, ids } = await seeded();
    expect(await createTask(db, newTask(ids.sharma), NOW)).toMatchObject({ code: 'SHA-001', status: 'open', reminderCount: 0, lockedFields: [], statusLockedAt: null });
    expect((await createTask(db, newTask(ids.mehta), NOW)).code).toBe('MEH-001');
  });

  it('updates fields, and human edits lock them', async () => {
    const { db, ids } = await seeded();
    const t = await createTask(db, newTask(ids.sharma), NOW);
    await updateTaskFields(db, t.id, { deadline: '2026-10-25' }, NOW, 'ai');
    expect(await getTaskByCode(db, 'SHA-001')).toMatchObject({ deadline: '2026-10-25', lockedFields: [] });
    await updateTaskFields(db, t.id, { title: 'Brighter banner' }, LATER, 'human');
    expect(await getTaskByCode(db, 'SHA-001')).toMatchObject({ title: 'Brighter banner', lockedFields: ['title'], updatedAt: LATER });
  });

  it('closes and reopens; human status changes are timestamped', async () => {
    const { db, ids } = await seeded();
    const t = await createTask(db, newTask(ids.sharma), NOW);
    await setTaskStatus(db, t.id, 'done', '2026-10-19', NOW, 'ai');
    expect(await getTaskByCode(db, 'SHA-001')).toMatchObject({ status: 'done', closedOn: '2026-10-19', statusLockedAt: null });
    await setTaskStatus(db, t.id, 'open', '2026-10-19', LATER, 'human');
    expect(await getTaskByCode(db, 'SHA-001')).toMatchObject({ status: 'open', closedOn: null, statusLockedAt: LATER });
  });

  it('counts reminders and filters by status', async () => {
    const { db, ids } = await seeded();
    const a = await createTask(db, newTask(ids.sharma), NOW);
    await createTask(db, newTask(ids.sharma, { title: 'Send logo files', side: 'client' }), NOW);
    await logReminder(db, a.id, '2026-10-13', NOW);
    await logReminder(db, a.id, '2026-10-17', NOW);
    expect(await getTaskByCode(db, 'SHA-001')).toMatchObject({ reminderCount: 2, lastReminderOn: '2026-10-17' });
    await setTaskStatus(db, a.id, 'maybe_done', '2026-10-19', NOW, 'ai');
    expect((await listTasks(db, ids.sharma, ['open'])).map((t) => t.code)).toEqual(['SHA-002']);
    expect((await listTasks(db, ids.sharma)).map((t) => t.code)).toEqual(['SHA-001', 'SHA-002']);
  });

  it('never moves the last reminder date back: a file read late can log an older reminder (final review)', async () => {
    const { db, ids } = await seeded();
    const a = await createTask(db, newTask(ids.sharma), NOW);
    await logReminder(db, a.id, '2026-10-02', NOW);
    await logReminder(db, a.id, '2026-10-01', LATER);
    expect(await getTaskByCode(db, 'SHA-001')).toMatchObject({ reminderCount: 2, lastReminderOn: '2026-10-02', updatedAt: LATER });
  });

  it('records events and decisions', async () => {
    const { db, ids } = await seeded();
    const t = await createTask(db, newTask(ids.sharma), NOW);
    await recordEvent(db, { taskId: t.id, clientId: ids.sharma, actor: 'ai', op: 'add_task', detail: { code: t.code }, reason: 'asked in chat', sourceIds: ['m1'], at: NOW });
    expect(await row(db, 'SELECT actor, op, source_ids FROM task_events')).toEqual({ actor: 'ai', op: 'add_task', source_ids: '["m1"]' });
    await addDecision(db, { clientId: ids.sharma, text: 'Blue theme', decidedOn: '2026-10-14', source: 'whatsapp', sourceWaId: 'm5' }, NOW);
    await addDecision(db, { clientId: ids.sharma, text: 'Launch 1 Nov', decidedOn: '2026-10-15', source: 'whatsapp', sourceWaId: 'm6' }, NOW);
    expect((await listDecisions(db, ids.sharma)).map((d) => d.text)).toEqual(['Launch 1 Nov', 'Blue theme']);
    expect(await listDecisions(db, ids.sharma, 1)).toHaveLength(1);
  });

  it('taskSourceIds covers every message any event of a task cited, whatever the op or actor', async () => {
    const { db, ids } = await seeded();
    const t = await createTask(db, newTask(ids.sharma, { sourceWaId: 'm1' }), NOW);
    const other = await createTask(db, newTask(ids.mehta, { sourceWaId: 'z1' }), NOW);
    const ev = (taskId: number | null, clientId: number, actor: 'ai' | 'human', op: string, sourceIds: string[]) =>
      recordEvent(db, { taskId, clientId, actor, op, detail: {}, reason: null, sourceIds, at: NOW });
    await ev(t.id, ids.sharma, 'ai', 'add_task', ['m1', 'm2']);
    await ev(t.id, ids.sharma, 'ai', 'log_reminder', ['m3']);
    await ev(t.id, ids.sharma, 'ai', 'update_task', ['m4']);
    await ev(t.id, ids.sharma, 'ai', 'mark_maybe_done', ['m5']);
    await ev(t.id, ids.sharma, 'ai', 'close_task', ['m6']);
    await ev(t.id, ids.sharma, 'human', 'reopen_task', []);
    await ev(null, ids.sharma, 'ai', 'add_decision', ['d1']); // not task evidence
    await ev(null, ids.sharma, 'ai', 'set_status', ['s1']);
    await ev(other.id, ids.mehta, 'ai', 'log_reminder', ['z2']); // another client
    expect([...await taskSourceIds(db, ids.sharma)].sort()).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
  });

  it('records batches and reports the latest per client', async () => {
    const { db, ids } = await seeded();
    const a = await startBatch(db, ids.sharma, 3, NOW);
    await finishBatch(db, a, { status: 'ok', errorCode: null, accepted: 2, rejected: 0, at: NOW });
    const b = await startBatch(db, ids.sharma, 1, LATER);
    await finishBatch(db, b, { status: 'failed', errorCode: 'refusal', accepted: null, rejected: null, at: LATER });
    expect(await latestBatches(db)).toEqual([{ clientId: ids.sharma, status: 'failed', errorCode: 'refusal', finishedAt: LATER }]);
  });
});
