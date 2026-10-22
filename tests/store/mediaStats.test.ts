import { describe, expect, it } from 'vitest';
import { syncClients } from '../../src/store/clients.ts';
import type { Db } from '../../src/store/db.ts';
import { deferMedia, failMedia, finishMedia, insertMedia, markUploaded, markUploadFailed, mediaStats, messageRowId } from '../../src/store/media.ts';
import { insertMessage } from '../../src/store/messages.ts';
import { MEHTA, NOW, seededDb } from '../helpers/db.ts';

function add(db: Db, waId: string, o: { clientId?: number; createdAt?: string; errorCode?: string } = {}): number {
  const clientId = o.clientId ?? 1;
  insertMessage(db, { waId, clientId, senderJid: 'x', senderNumber: null, senderName: null, fromMe: false, ts: NOW, text: null, quotedWaId: null, mediaType: 'image' });
  return insertMedia(db, {
    messageId: messageRowId(db, clientId, waId)!, clientId, kind: 'image', status: 'pending', mimeType: 'image/jpeg', fileName: null, fileSize: 1, seconds: null,
    forwarded: false, refEnc: null, errorCode: o.errorCode ?? null, createdAt: o.createdAt ?? '2026-10-19T07:55:00.000Z',
  });
}

const ZERO = { pending: 0, stale: 0, spendCap: 0, failedRecent: 0, uploadFailed: 0 };

describe('mediaStats', () => {
  it('counts waiting, long-waiting, budget-waiting and recently failed files and uploads that gave up', () => {
    const db = seededDb();
    add(db, 'A');
    add(db, 'B', { createdAt: '2026-10-19T07:00:00.000Z' });
    add(db, 'C', { createdAt: '2026-10-19T06:00:00.000Z', errorCode: 'spend_cap' });
    failMedia(db, add(db, 'D'), { status: 'failed', errorCode: 'not_pdf', at: '2026-10-19T07:30:00.000Z' });
    failMedia(db, add(db, 'E'), { status: 'failed', errorCode: 'not_pdf', at: '2026-10-17T07:30:00.000Z' });
    const f = add(db, 'F');
    finishMedia(db, f, { textKind: null, text: null, pageCount: null, note: null, at: NOW });
    markUploadFailed(db, f, { failed: true, nextAt: null });
    expect(mediaStats(db, new Date('2026-10-19T08:00:00.000Z'))).toEqual({ pending: 3, stale: 1, spendCap: 1, failedRecent: 1, uploadFailed: 1 });
  });

  it('is all zeros on an empty table', () => {
    expect(mediaStats(seededDb(), new Date(NOW))).toEqual(ZERO);
  });

  it('counts a long wait from the service start when that is later than the file (15a)', () => {
    const db = seededDb();
    add(db, 'A', { createdAt: '2026-10-19T06:00:00.000Z' });
    const startedAt = new Date('2026-10-19T07:45:00.000Z');
    expect(mediaStats(db, new Date('2026-10-19T08:00:00.000Z'), startedAt)).toMatchObject({ pending: 1, stale: 0 });
    expect(mediaStats(db, new Date('2026-10-19T08:14:59.999Z'), startedAt)).toMatchObject({ pending: 1, stale: 0 });
    expect(mediaStats(db, new Date('2026-10-19T08:15:00.001Z'), startedAt)).toMatchObject({ pending: 1, stale: 1 });
  });

  it('takes the wait as a parameter', () => {
    const db = seededDb();
    add(db, 'A', { createdAt: '2026-10-19T07:50:00.000Z' });
    expect(mediaStats(db, new Date(NOW), new Date(0), 5 * 60_000).stale).toBe(1);
    expect(mediaStats(db, new Date(NOW), new Date(0), 15 * 60_000).stale).toBe(0);
  });

  it('counts a file waiting for the daily budget under spendCap, not as waiting too long, until it is tried again (15b)', () => {
    const db = seededDb();
    const id = add(db, 'A', { createdAt: '2026-10-19T06:00:00.000Z' });
    deferMedia(db, id, { errorCode: 'spend_cap', nextAttemptAt: '2026-10-19T08:10:00.000Z', countAttempt: false, at: NOW });
    expect(mediaStats(db, new Date(NOW))).toEqual({ ...ZERO, pending: 1, spendCap: 1 });
    deferMedia(db, id, { errorCode: 'ai_unavailable', nextAttemptAt: '2026-10-19T08:15:00.000Z', countAttempt: false, at: NOW });
    expect(mediaStats(db, new Date(NOW))).toEqual({ ...ZERO, pending: 1, stale: 1 });
    finishMedia(db, id, { textKind: 'description', text: 'x', pageCount: null, note: null, at: NOW });
    expect(mediaStats(db, new Date(NOW))).toEqual(ZERO);
  });

  it('does not count an upload that gave up once the file is in Drive', () => {
    const db = seededDb();
    const id = add(db, 'A');
    finishMedia(db, id, { textKind: null, text: null, pageCount: null, note: null, at: NOW });
    markUploadFailed(db, id, { failed: true, nextAt: null });
    markUploaded(db, id, 'drive-1');
    expect(mediaStats(db, new Date(NOW)).uploadFailed).toBe(0);
  });

  it('leaves out the files of a client no longer on the allow-list, which wait untouched until it is back', () => {
    const db = seededDb();
    add(db, 'A', { clientId: 1, createdAt: '2026-10-19T06:00:00.000Z' });
    add(db, 'B', { clientId: 1, createdAt: '2026-10-19T06:00:00.000Z', errorCode: 'spend_cap' });
    const done = add(db, 'C', { clientId: 1 });
    finishMedia(db, done, { textKind: null, text: null, pageCount: null, note: null, at: NOW });
    markUploadFailed(db, done, { failed: true, nextAt: null });
    failMedia(db, add(db, 'D', { clientId: 1 }), { status: 'failed', errorCode: 'not_pdf', at: NOW });
    add(db, 'M', { clientId: 2 });
    syncClients(db, [MEHTA]);
    expect(mediaStats(db, new Date(NOW))).toEqual({ ...ZERO, pending: 1 });
  });
});
