import { describe, expect, it } from 'vitest';
import { closeTask, CorrectionError, editTask, reopenTask, requestReprocess, setClientPhase, setPersonRole } from '../../src/cli/corrections.ts';
import { getClient } from '../../src/store/clients.ts';
import { getKv } from '../../src/store/kv.ts';
import { insertMessage, listUnprocessed, markProcessed } from '../../src/store/messages.ts';
import { listPeople, upsertPerson } from '../../src/store/people.ts';
import { createTask, getTaskByCode } from '../../src/store/tasks.ts';
import { NOW, seededDb } from '../helpers/db.ts';

const now = new Date('2026-10-19T08:00:00Z');

function withTask() {
  const db = seededDb();
  createTask(db, { clientId: 1, side: 'us', title: 'Banner', category: 'design', priority: 'high', assignedTo: null, askedBy: null, raisedOn: '2026-10-10',
    deadline: null, latestProgress: null, sourceQuote: null, sourceDate: null, sourceWaId: null, origin: 'whatsapp' }, NOW);
  return db;
}

describe('corrections', () => {
  it('closes and reopens tasks as a human, with a rebuild request', () => {
    const db = withTask();
    expect(closeTask(db, 'sha-001', now)).toMatchObject({ status: 'done', closedOn: '2026-10-19', statusLockedAt: now.toISOString() });
    expect(reopenTask(db, 'SHA-001', now)).toMatchObject({ status: 'open', closedOn: null });
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE actor = 'human'").get()).toEqual({ n: 2 });
    expect(getKv(db, 'rebuild_requested')).toBeTruthy();
    expect(() => closeTask(db, 'SHA-999', now)).toThrowError(CorrectionError);
  });

  it('edits and locks fields, validating values', () => {
    const db = withTask();
    expect(editTask(db, 'SHA-001', { deadline: '2026-10-25', assignedTo: 'Rahul' }, now)).toMatchObject({ deadline: '2026-10-25', assignedTo: 'Rahul' });
    expect([...(getTaskByCode(db, 'SHA-001')?.lockedFields ?? [])].sort()).toEqual(['assignedTo', 'deadline']);
    expect(editTask(db, 'SHA-001', { deadline: 'none' }, now).deadline).toBeNull();
    expect(() => editTask(db, 'SHA-001', { priority: 'urgent' }, now)).toThrowError(/priority/);
    expect(() => editTask(db, 'SHA-001', { deadline: '25 Oct' }, now)).toThrowError(/YYYY-MM-DD/);
    expect(() => editTask(db, 'SHA-001', {}, now)).toThrowError(/Nothing to change/);
    expect(() => editTask(db, 'SHA-001', { title: 'none' }, now)).toThrowError(/title/);
  });

  it('keeps chat text out of error messages and writes nothing on a failed edit', () => {
    const db = withTask();
    expect(() => editTask(db, 'SHA-001', { priority: 'secret client words' }, now)).toThrowError(/priority must be one of/);
    try {
      editTask(db, 'SHA-001', { priority: 'secret client words' }, now);
    } catch (e) {
      expect((e as Error).message).not.toContain('secret client words');
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE actor = 'human'").get()).toEqual({ n: 0 });
    expect(getKv(db, 'rebuild_requested')).toBeUndefined();
  });

  it('sets a person role by phone number', () => {
    const db = withTask();
    upsertPerson(db, { clientId: 1, jid: '919800000002@s.whatsapp.net', number: '919800000002', name: 'Rahul', fromMe: false });
    expect(setPersonRole(db, '+91 98000 00002', 'team', undefined, now)).toBe(1);
    expect(listPeople(db, 1)[0]).toMatchObject({ role: 'team', roleSetBy: 'human' });
    expect(() => setPersonRole(db, '+91 1', 'team', undefined, now)).toThrowError(/No one with number/);
    expect(() => setPersonRole(db, '+91 98000 00002', 'boss', undefined, now)).toThrowError(/team or client/);
  });

  it('sets a phase from the client list, case-insensitively', () => {
    const db = withTask();
    setClientPhase(db, 'sha', 'development', now);
    expect(getClient(db, 1)).toMatchObject({ currentPhase: 'Development', phaseLocked: true });
    expect(() => setClientPhase(db, 'SHA', 'Party', now)).toThrowError(/must be one of/);
  });

  it('re-queues messages from a date for the AI', () => {
    const db = withTask();
    insertMessage(db, { waId: 'm1', clientId: 1, senderJid: 'x', senderNumber: null, senderName: null, fromMe: false, ts: '2026-10-12T08:00:00.000Z', text: 'a', quotedWaId: null, mediaType: null });
    markProcessed(db, listUnprocessed(db, 1).map((m) => m.id), NOW);
    expect(requestReprocess(db, 'SHA', '2026-10-11', now)).toBe(1);
    expect(listUnprocessed(db, 1)).toHaveLength(1);
    expect(() => requestReprocess(db, 'SHA', 'yesterday', now)).toThrowError(/YYYY-MM-DD/);
  });
});
