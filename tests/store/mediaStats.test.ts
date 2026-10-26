import { describe, expect, it } from 'vitest';
import { syncClients } from '../../src/store/clients.ts';
import type { Db } from '../../src/store/db.ts';
import {
  deferMedia, failMedia, finishMedia, insertMedia, markDownloaded, markUploaded, markUploadFailed, mediaStats, messageRowId, resetUploadFailures, uploadCandidates,
} from '../../src/store/media.ts';
import { applyRevoke, insertMessage } from '../../src/store/messages.ts';
import { setRole, upsertPerson } from '../../src/store/people.ts';
import { MEHTA, NOW, SHARMA, seededDb } from '../helpers/db.ts';

function add(db: Db, waId: string, o: { clientId?: number; createdAt?: string; errorCode?: string; senderJid?: string } = {}): number {
  const clientId = o.clientId ?? 1;
  insertMessage(db, {
    waId, clientId, senderJid: o.senderJid ?? 'x', senderNumber: null, senderName: null, fromMe: false, ts: NOW, text: null, quotedWaId: null, mediaType: 'image',
  });
  return insertMedia(db, {
    messageId: messageRowId(db, clientId, waId)!, clientId, kind: 'image', status: 'pending', mimeType: 'image/jpeg', fileName: null, fileSize: 1, seconds: null,
    forwarded: false, refEnc: null, errorCode: o.errorCode ?? null, createdAt: o.createdAt ?? '2026-10-19T07:55:00.000Z',
  });
}

const CLIENT_JID = '919800000001@s.whatsapp.net';

/** A saved image from a client member of `clientId` whose Drive upload gave up: one the uploader tries again after a restart. */
function gaveUpUpload(db: Db, waId: string, clientId = 1): number {
  upsertPerson(db, { clientId, jid: CLIENT_JID, number: null, name: null, fromMe: false });
  setRole(db, clientId, CLIENT_JID, 'client', 'human');
  const id = add(db, waId, { clientId, senderJid: CLIENT_JID });
  markDownloaded(db, id, { localPath: `media/x/${waId}-${id}.jpg`, sha256: 'x', fileSize: 1, at: NOW });
  finishMedia(db, id, { textKind: null, text: null, pageCount: null, note: null, at: NOW });
  markUploadFailed(db, id, { failed: true, nextAt: null });
  return id;
}

const ZERO = { pending: 0, stale: 0, spendCap: 0, failedRecent: 0, uploadFailed: 0, sttRefused: 0, voiceFailed: 0 };

describe('mediaStats', () => {
  it('counts waiting, long-waiting, budget-waiting and recently failed files and uploads that gave up', () => {
    const db = seededDb();
    add(db, 'A');
    add(db, 'B', { createdAt: '2026-10-19T07:00:00.000Z' });
    add(db, 'C', { createdAt: '2026-10-19T06:00:00.000Z', errorCode: 'spend_cap' });
    failMedia(db, add(db, 'D'), { status: 'failed', errorCode: 'not_pdf', at: '2026-10-19T07:30:00.000Z' });
    failMedia(db, add(db, 'E'), { status: 'failed', errorCode: 'not_pdf', at: '2026-10-17T07:30:00.000Z' });
    gaveUpUpload(db, 'F');
    expect(mediaStats(db, new Date('2026-10-19T08:00:00.000Z'))).toEqual({ pending: 3, stale: 1, spendCap: 1, failedRecent: 1, uploadFailed: 1, sttRefused: 0, voiceFailed: 0 });
  });

  it('counts pending files waiting because the speech-to-text key was refused (sttRefused), of active clients only', () => {
    const db = seededDb();
    const a = add(db, 'A', { errorCode: 'stt_unavailable' });
    add(db, 'B', { errorCode: 'stt_unavailable' });
    add(db, 'C', { errorCode: 'ai_unavailable' });
    add(db, 'D', { clientId: 2, errorCode: 'stt_unavailable' });
    failMedia(db, add(db, 'E'), { status: 'failed', errorCode: 'stt_unavailable', at: NOW }); // given up: no longer waiting for the key (review G)
    expect(mediaStats(db, new Date(NOW))).toEqual({ ...ZERO, pending: 4, failedRecent: 1, sttRefused: 3 });
    finishMedia(db, a, { textKind: 'extract', text: 'Payment done', pageCount: null, note: null, at: NOW });
    expect(mediaStats(db, new Date(NOW))).toEqual({ ...ZERO, pending: 3, failedRecent: 1, sttRefused: 2 });
    syncClients(db, [SHARMA]);
    expect(mediaStats(db, new Date(NOW))).toEqual({ ...ZERO, pending: 2, failedRecent: 1, sttRefused: 1 });
  });

  it('counts a file waiting for the speech-to-text key under sttRefused, not as waiting too long, so Health shows the key line (review E)', () => {
    const db = seededDb();
    add(db, 'A', { createdAt: '2026-10-19T06:00:00.000Z', errorCode: 'stt_unavailable' });
    add(db, 'B', { createdAt: '2026-10-19T06:00:00.000Z', errorCode: 'ai_unavailable' });
    expect(mediaStats(db, new Date(NOW))).toEqual({ ...ZERO, pending: 2, stale: 1, sttRefused: 1 });
  });

  it('never counts a queued backlog file as waiting too long: a long backlog run is not a fault (review round 2)', () => {
    const db = seededDb();
    const id = add(db, 'A', { createdAt: '2026-10-19T06:00:00.000Z' });
    db.prepare('UPDATE media SET backlog = 1 WHERE id = ?').run(id);
    add(db, 'B', { createdAt: '2026-10-19T06:00:00.000Z' });
    expect(mediaStats(db, new Date(NOW))).toEqual({ ...ZERO, pending: 2, stale: 1 });
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

  // Final review FR3c: a file waiting only for paid calls in flight is read within minutes, not after midnight.
  it('does not count a file waiting for paid calls in flight (spend_busy) under spendCap', () => {
    const db = seededDb();
    const id = add(db, 'A', { createdAt: '2026-10-19T07:55:00.000Z' });
    deferMedia(db, id, { errorCode: 'spend_busy', nextAttemptAt: '2026-10-19T08:10:00.000Z', countAttempt: false, at: NOW });
    expect(mediaStats(db, new Date(NOW))).toEqual({ ...ZERO, pending: 1 });
    expect(mediaStats(db, new Date('2026-10-19T08:30:00.000Z'))).toEqual({ ...ZERO, pending: 1, stale: 1 });
  });

  it('does not count an upload that gave up once the file is in Drive', () => {
    const db = seededDb();
    const id = gaveUpUpload(db, 'A');
    expect(mediaStats(db, new Date(NOW)).uploadFailed).toBe(1);
    markUploaded(db, id, 'drive-1');
    expect(mediaStats(db, new Date(NOW)).uploadFailed).toBe(0);
  });

  it('does not count an upload that gave up once its message is deleted for everyone (D3)', () => {
    const db = seededDb();
    gaveUpUpload(db, 'A');
    gaveUpUpload(db, 'B');
    expect(mediaStats(db, new Date(NOW)).uploadFailed).toBe(2);
    applyRevoke(db, 1, 'A');
    expect(mediaStats(db, new Date(NOW)).uploadFailed).toBe(1);
  });

  it('does not count an upload that gave up while its sender is not a client member', () => {
    const db = seededDb();
    gaveUpUpload(db, 'A');
    setRole(db, 1, CLIENT_JID, 'team', 'human');
    expect(mediaStats(db, new Date(NOW)).uploadFailed).toBe(0);
    setRole(db, 1, CLIENT_JID, 'client', 'human');
    expect(mediaStats(db, new Date(NOW)).uploadFailed).toBe(1);
  });

  it('counts exactly the uploads that gave up and that a restart tries again', () => {
    const db = seededDb();
    gaveUpUpload(db, 'A');
    gaveUpUpload(db, 'B');
    applyRevoke(db, 1, 'B');
    const counted = mediaStats(db, new Date(NOW)).uploadFailed;
    resetUploadFailures(db);
    expect(uploadCandidates(db, NOW, 10)).toHaveLength(counted);
    expect(counted).toBe(1);
  });

  it('leaves out the files of a client no longer on the allow-list, which wait untouched until it is back', () => {
    const db = seededDb();
    add(db, 'A', { clientId: 1, createdAt: '2026-10-19T06:00:00.000Z' });
    add(db, 'B', { clientId: 1, createdAt: '2026-10-19T06:00:00.000Z', errorCode: 'spend_cap' });
    gaveUpUpload(db, 'C', 1);
    failMedia(db, add(db, 'D', { clientId: 1 }), { status: 'failed', errorCode: 'not_pdf', at: NOW });
    add(db, 'M', { clientId: 2 });
    syncClients(db, [MEHTA]);
    expect(mediaStats(db, new Date(NOW))).toEqual({ ...ZERO, pending: 1 });
  });
});
