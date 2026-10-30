import { describe, expect, it } from 'vitest';
import {
  closeTask, CorrectionError, countReprocess, editTask, reopenTask, REPROCESS_CONFIRM_ABOVE, reprocess, requestReprocess, setClientPhase, setPersonRole,
  unlockClientPhase, unlockTask,
} from '../../src/cli/corrections.ts';
import { getClient } from '../../src/store/clients.ts';
import type { Db } from '../../src/store/db.ts';
import { getKv } from '../../src/store/kv.ts';
import { insertMessage, listUnprocessed, markProcessed } from '../../src/store/messages.ts';
import { listPeople, upsertPerson } from '../../src/store/people.ts';
import { createTask, getTaskByCode } from '../../src/store/tasks.ts';
import { NOW, seededDb } from '../helpers/db.ts';

const now = new Date('2026-10-19T08:00:00Z');

async function withTask() {
  const db = await seededDb();
  createTask(db, { clientId: 1, side: 'us', title: 'Banner', category: 'design', priority: 'major', assignedTo: null, askedBy: null, raisedOn: '2026-10-10',
    deadline: null, latestProgress: null, sourceQuote: null, sourceDate: null, sourceWaId: null, origin: 'whatsapp' }, NOW);
  return db;
}

interface Ev { op: string; actor: string; detail: unknown; task_id: number | null; client_id: number }
function events(db: Db): Ev[] {
  const rows = db.raw.prepare("SELECT op, actor, detail, task_id, client_id FROM task_events WHERE actor = 'human' ORDER BY id").all() as (Omit<Ev, 'detail'> & { detail: string })[];
  return rows.map((e) => ({ ...e, detail: JSON.parse(e.detail) as unknown }));
}

const rebuilt = (db: Db) => getKv(db, 'rebuild_requested') === now.toISOString();

async function msg(db: Db, waId: string, ts: string, clientId = 1) {
  await insertMessage(db, { waId, clientId, senderJid: 'x', senderNumber: null, senderName: null, fromMe: false, ts, text: 'a', quotedWaId: null, mediaType: null });
}
async function processAll(db: Db, clientId = 1) {
  await markProcessed(db, (await listUnprocessed(db, clientId, 100000)).map((m) => m.id), NOW);
}

describe('task close / reopen', () => {
  it('closes and reopens tasks as a human, with events and a rebuild request', async () => {
    const db = await withTask();
    expect(closeTask(db, 'sha-001', now)).toMatchObject({ status: 'done', closedOn: '2026-10-19', statusLockedAt: now.toISOString() });
    expect(rebuilt(db)).toBe(true);
    expect(reopenTask(db, 'SHA-001', now)).toMatchObject({ status: 'open', closedOn: null, statusLockedAt: now.toISOString() });
    expect(events(db)).toMatchObject([
      { op: 'close_task', task_id: 1, client_id: 1, detail: { status: 'done' } },
      { op: 'reopen_task', task_id: 1, client_id: 1, detail: { status: 'open' } },
    ]);
    expect(() => closeTask(db, 'SHA-999', now)).toThrowError(CorrectionError);
  });

  it('refuses to repeat a status, changing nothing', async () => {
    const db = await withTask();
    expect(() => reopenTask(db, 'SHA-001', now)).toThrowError('Task SHA-001 is already open');
    expect(events(db)).toHaveLength(0);
    expect(getKv(db, 'rebuild_requested')).toBeUndefined();
    closeTask(db, 'SHA-001', now);
    expect(() => closeTask(db, 'SHA-001', now)).toThrowError('Task SHA-001 is already done');
    expect(events(db)).toHaveLength(1);
  });
});

describe('task edit', () => {
  it('edits and locks fields, recording the event', async () => {
    const db = await withTask();
    expect(editTask(db, 'SHA-001', { deadline: '2026-10-25', assignedTo: 'Rahul' }, now)).toMatchObject({ deadline: '2026-10-25', assignedTo: 'Rahul' });
    expect([...(getTaskByCode(db, 'SHA-001')?.lockedFields ?? [])].sort()).toEqual(['assignedTo', 'deadline']);
    expect(events(db)[0]).toMatchObject({ op: 'update_task', detail: { deadline: '2026-10-25', assignedTo: 'Rahul' } });
    expect(rebuilt(db)).toBe(true);
  });

  it('clears optional fields with none or an empty string', async () => {
    const db = await withTask();
    editTask(db, 'SHA-001', { deadline: '2026-10-25', assignedTo: 'Rahul', askedBy: 'Sharma', latestProgress: 'half' }, now);
    expect(editTask(db, 'SHA-001', { deadline: 'none', assignedTo: '', askedBy: ' ', latestProgress: 'NONE' }, now)).toMatchObject({
      deadline: null, assignedTo: null, askedBy: null, latestProgress: null,
    });
  });

  it('matches enums case-insensitively and stores them lower-case', async () => {
    const db = await withTask();
    expect(editTask(db, 'SHA-001', { priority: 'LOW', side: 'Client', category: 'Payment' }, now)).toMatchObject({ priority: 'low', side: 'client', category: 'payment' });
  });

  it('validates values and keeps chat text out of errors', async () => {
    const db = await withTask();
    expect(() => editTask(db, 'SHA-001', { priority: 'urgent' }, now)).toThrowError(/priority must be one of/);
    expect(() => editTask(db, 'SHA-001', { deadline: '25 Oct' }, now)).toThrowError(/YYYY-MM-DD/);
    expect(() => editTask(db, 'SHA-001', {}, now)).toThrowError(/Nothing to change/);
    expect(() => editTask(db, 'SHA-001', { title: 'none' }, now)).toThrowError(/title/);
    expect(() => editTask(db, 'SHA-001', { title: '' }, now)).toThrowError(/title/);
    expect(() => editTask(db, 'SHA-001', { priority: 'secret client words' }, now)).toThrowError(/^(?!.*secret client words)/);
    expect(events(db)).toHaveLength(0);
    expect(getKv(db, 'rebuild_requested')).toBeUndefined();
  });
});

describe('task unlock', () => {
  it('clears field and status locks and records an event', async () => {
    const db = await withTask();
    editTask(db, 'SHA-001', { deadline: '2026-10-25' }, now);
    closeTask(db, 'SHA-001', now);
    expect(unlockTask(db, 'sha-001', now)).toMatchObject({ lockedFields: [], statusLockedAt: null, status: 'done' });
    expect(events(db).at(-1)).toMatchObject({ op: 'unlock', task_id: 1, client_id: 1, detail: { lockedFields: ['deadline'], statusLocked: true } });
    expect(rebuilt(db)).toBe(true);
    expect(() => unlockTask(db, 'SHA-999', now)).toThrowError(CorrectionError);
  });
});

describe('person set', () => {
  async function people() {
    const db = await withTask();
    await upsertPerson(db, { clientId: 1, jid: '919800000002@s.whatsapp.net', number: '919800000002', name: 'Rahul', fromMe: false });
    await upsertPerson(db, { clientId: 2, jid: '919800000002@s.whatsapp.net', number: '919800000002', name: 'Rahul', fromMe: false });
    return db;
  }

  it('sets a role by phone number in every client group', async () => {
    const db = await people();
    expect(await setPersonRole(db, '+91 98000-00002', 'Team', undefined, now)).toBe(2);
    expect((await listPeople(db, 1))[0]).toMatchObject({ role: 'team', roleSetBy: 'human' });
    expect((await listPeople(db, 2))[0]).toMatchObject({ role: 'team', roleSetBy: 'human' });
    expect(events(db)).toMatchObject([{ op: 'set_person_role', client_id: 1, detail: { number: '919800000002', role: 'team' } }, { op: 'set_person_role', client_id: 2, detail: { number: '919800000002', role: 'team' } }]);
    expect(rebuilt(db)).toBe(true);
  });

  it('scopes to one client with --client', async () => {
    const db = await people();
    expect(await setPersonRole(db, '919800000002', 'client', 'meh', now)).toBe(1);
    expect((await listPeople(db, 1))[0]).toMatchObject({ role: 'unknown' });
    expect((await listPeople(db, 2))[0]).toMatchObject({ role: 'client', roleSetBy: 'human' });
  });

  it('accepts a WhatsApp id', async () => {
    const db = await people();
    expect(await setPersonRole(db, '919800000002@s.whatsapp.net', 'team', 'SHA', now)).toBe(1);
    expect((await listPeople(db, 1))[0]).toMatchObject({ role: 'team' });
    expect(events(db)[0]).toMatchObject({ detail: { jid: '919800000002@s.whatsapp.net', role: 'team' } });
    await expect(setPersonRole(db, 'nobody@lid', 'team', undefined, now)).rejects.toThrowError('No one with that WhatsApp id has posted in an allowed group yet');
  });

  it('gives clear errors', async () => {
    const db = await people();
    await expect(setPersonRole(db, 'abc', 'team', undefined, now)).rejects.toThrowError(/full phone number with country code/);
    await expect(setPersonRole(db, '+91 1', 'team', undefined, now)).rejects.toThrowError('No one with that number has posted in an allowed group yet');
    await expect(setPersonRole(db, '919800000002', 'boss', undefined, now)).rejects.toThrowError(/team or client/);
    const db2 = await withTask();
    await upsertPerson(db2, { clientId: 2, jid: '919800000003@s.whatsapp.net', number: '919800000003', name: 'X', fromMe: false });
    await expect(setPersonRole(db2, '919800000003', 'team', 'SHA', now)).rejects.toThrowError('That number has posted, but not in client SHA');
    await expect(setPersonRole(db2, '919800000003', 'team', 'ZZZ', now)).rejects.toThrowError(/No client with code/);
  });
});

describe('phase set / unlock', () => {
  it('sets a phase case-insensitively, locked, with an event', async () => {
    const db = await withTask();
    setClientPhase(db, 'sha', 'development', now);
    expect(getClient(db, 1)).toMatchObject({ currentPhase: 'Development', phaseLocked: true });
    expect(events(db)[0]).toMatchObject({ op: 'set_phase', task_id: null, client_id: 1, detail: { phase: 'Development' } });
    expect(rebuilt(db)).toBe(true);
    expect(() => setClientPhase(db, 'SHA', 'Party', now)).toThrowError(/must be one of/);
  });

  it('unlocks the phase for the AI', async () => {
    const db = await withTask();
    setClientPhase(db, 'SHA', 'Design', now);
    unlockClientPhase(db, 'sha', now);
    expect(getClient(db, 1)).toMatchObject({ currentPhase: 'Design', phaseLocked: false });
    expect(events(db).at(-1)).toMatchObject({ op: 'unlock_phase', client_id: 1, detail: { phase: 'Design' } });
    expect(rebuilt(db)).toBe(true);
  });
});

describe('reprocess', () => {
  it('re-queues only processed messages in the window', async () => {
    const db = await withTask();
    await msg(db, 'old', '2026-10-05T08:00:00.000Z');
    await msg(db, 'm1', '2026-10-12T08:00:00.000Z');
    await msg(db, 'm2', '2026-10-15T08:00:00.000Z');
    await msg(db, 'late', '2026-10-18T08:00:00.000Z');
    await processAll(db);
    await msg(db, 'fresh', '2026-10-13T08:00:00.000Z'); // never processed: not counted
    expect(await countReprocess(db, 'SHA', '2026-10-11', '2026-10-15')).toBe(2);
    expect(getKv(db, 'rebuild_requested')).toBeUndefined(); // counting changes nothing
    expect(await requestReprocess(db, 'SHA', '2026-10-11', now, '2026-10-15')).toBe(2);
    expect((await listUnprocessed(db, 1)).map((m) => m.waId).sort()).toEqual(['fresh', 'm1', 'm2']);
    expect(events(db)[0]).toMatchObject({ op: 'reprocess', client_id: 1, detail: { since: '2026-10-11', until: '2026-10-15', messages: 2 } });
    expect(rebuilt(db)).toBe(true);
  });

  it('validates dates and the client', async () => {
    const db = await withTask();
    await expect(requestReprocess(db, 'SHA', 'yesterday', now)).rejects.toThrowError(/YYYY-MM-DD/);
    await expect(requestReprocess(db, 'SHA', '2026-10-11', now, 'soon')).rejects.toThrowError(/YYYY-MM-DD/);
    await expect(requestReprocess(db, 'SHA', '2026-10-11', now, '2026-10-10')).rejects.toThrowError(/on or after/);
    await expect(requestReprocess(db, 'ZZZ', '2026-10-11', now)).rejects.toThrowError(/No client/);
    db.raw.prepare('UPDATE clients SET active = 0 WHERE id = 1').run();
    await expect(requestReprocess(db, 'SHA', '2026-10-11', now)).rejects.toThrowError('Client SHA is not in the allow-list; nothing to reprocess');
    await expect(countReprocess(db, 'SHA', '2026-10-11')).rejects.toThrowError(/not in the allow-list/);
  });

  it('previews large jobs and changes nothing without --yes', async () => {
    const db = await withTask();
    const n = REPROCESS_CONFIRM_ABOVE + 1;
    for (let i = 0; i < n; i++) await msg(db, `b${i}`, '2026-10-12T08:00:00.000Z');
    await processAll(db);
    expect(await reprocess(db, 'SHA', '2026-10-11', undefined, false, now)).toEqual({ count: n, queued: 0, needsConfirm: true, maxCostUsd: 1 });
    expect(await listUnprocessed(db, 1, 1000)).toHaveLength(0);
    expect(events(db)).toHaveLength(0);
    expect(getKv(db, 'rebuild_requested')).toBeUndefined();
    expect(await reprocess(db, 'SHA', '2026-10-11', undefined, true, now)).toMatchObject({ queued: n, needsConfirm: false });
    expect(await listUnprocessed(db, 1, 1000)).toHaveLength(n);
  });

  it('re-queues small jobs without --yes and reports zero', async () => {
    const db = await withTask();
    expect(await reprocess(db, 'SHA', '2026-10-11', undefined, false, now)).toMatchObject({ count: 0, queued: 0, needsConfirm: false });
    await msg(db, 'm1', '2026-10-12T08:00:00.000Z');
    await processAll(db);
    expect(await reprocess(db, 'SHA', '2026-10-11', undefined, false, now)).toMatchObject({ count: 1, queued: 1, needsConfirm: false });
  });
});
