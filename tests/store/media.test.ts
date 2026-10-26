import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { syncClients } from '../../src/store/clients.ts';
import { migrate, type Db } from '../../src/store/db.ts';
import {
  claimMedia, countMediaForgetAttempt, deferMedia, deleteMediaForget, dueMediaIds, failMedia, finishMedia, getMedia, getMediaRef, insertMedia, markDownloaded,
  mediaForMessages, mediaJob, mediaStats, mediaSttForgetsGivenUp, messageRowId, pendingMediaForgets, queueVoiceBacklog, voiceBacklog, type MediaKind, type MediaStatus, type NewMedia, type TextKind,
} from '../../src/store/media.ts';
import { MIGRATIONS } from '../../src/store/migrations.ts';
import { applyRevoke, insertMessage, listUnprocessed, markProcessed, markProcessedIfUnchanged, upsertReaction } from '../../src/store/messages.ts';
import { LATER, MEHTA, NOW, SHARMA, seededDb } from '../helpers/db.ts';

function message(db: Db, waId: string, o: { clientId?: number; mediaType?: string | null; ts?: string } = {}): number {
  const clientId = o.clientId ?? 1;
  insertMessage(db, {
    waId, clientId, senderJid: '919800000001@s.whatsapp.net', senderNumber: '919800000001', senderName: 'Mr. Sharma', fromMe: false,
    ts: o.ts ?? '2026-10-10T08:00:00.000Z', text: null, quotedWaId: null, mediaType: o.mediaType === undefined ? 'image' : o.mediaType,
  });
  return messageRowId(db, clientId, waId)!;
}

const media = (messageId: number, o: Partial<NewMedia> = {}): NewMedia => ({
  messageId, clientId: 1, kind: 'image', status: 'pending', mimeType: 'image/jpeg', fileName: null, fileSize: 1000, seconds: null, forwarded: false,
  refEnc: Buffer.from('sealed'), errorCode: null, createdAt: NOW, ...o,
});

const pdf = (messageId: number): NewMedia => media(messageId, { kind: 'document', mimeType: 'application/pdf', fileName: 'brief.pdf' });

describe('media store', () => {
  it('upgrades a version-3 database and keeps its messages', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
    for (const m of MIGRATIONS.filter((x) => x.version <= 3)) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version);
    }
    db.prepare("INSERT INTO clients (code, name, group_id, phases) VALUES ('SHA', 'Sharma', '1@g.us', '[]')").run();
    db.prepare("INSERT INTO messages (wa_id, client_id, sender_jid, ts) VALUES ('m1', 1, 'x', '2026-10-10T00:00:00Z')").run();
    migrate(db);
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(8); // the latest migration
    expect((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM media').get() as { n: number }).n).toBe(0);
    expect(db.prepare(`SELECT "notnull" AS required, dflt_value AS dflt FROM pragma_table_info('media') WHERE name = 'forwarded'`).get())
      .toEqual({ required: 1, dflt: '0' });
  });

  it('upgrades a version-4 database: its files get requeued_for_text 0 and no message is queued again (12h)', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
    for (const m of MIGRATIONS.filter((x) => x.version <= 4)) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version);
    }
    db.prepare("INSERT INTO clients (code, name, group_id, phases) VALUES ('SHA', 'Sharma', '1@g.us', '[]')").run();
    db.prepare("INSERT INTO messages (wa_id, client_id, sender_jid, ts, processed_at) VALUES ('m1', 1, 'x', '2026-10-10T00:00:00Z', '2026-10-10T00:05:00Z')").run();
    db.prepare(`INSERT INTO media (message_id, client_id, kind, status, text_kind, text, created_at, updated_at)
      VALUES (1, 1, 'image', 'done', 'description', 'A blue banner', '2026-10-10T00:00:00Z', '2026-10-10T00:01:00Z')`).run();
    migrate(db);
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(8); // the latest migration
    expect(db.prepare(`SELECT "notnull" AS required, dflt_value AS dflt FROM pragma_table_info('media') WHERE name = 'requeued_for_text'`).get())
      .toEqual({ required: 1, dflt: '0' });
    expect(getMedia(db, 1)).toMatchObject({ status: 'done', text: 'A blue banner', requeuedForText: false });
    expect(db.prepare("SELECT processed_at AS p, version FROM messages WHERE wa_id = 'm1'").get()).toEqual({ p: '2026-10-10T00:05:00Z', version: 0 });
  });

  it('adds version 5 as a new migration after version 4', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(MIGRATIONS[4]!.sql.trim()).toBe('ALTER TABLE media ADD COLUMN requeued_for_text INTEGER NOT NULL DEFAULT 0;');
  });

  it('stores one row per message and reads it back without the sealed details', () => {
    const db = seededDb();
    const m1 = message(db, 'IMG1');
    const id = insertMedia(db, media(m1));
    const row = getMedia(db, id)!;
    expect(row).toMatchObject({
      id, messageId: m1, clientId: 1, kind: 'image', status: 'pending', mimeType: 'image/jpeg', fileSize: 1000, forwarded: false, hasRef: true,
      attempts: 0, localPath: null, text: null, textChars: null, createdAt: NOW, updatedAt: NOW,
    });
    expect(row).not.toHaveProperty('refEnc');
    expect(getMediaRef(db, id)).toEqual(Buffer.from('sealed'));
    expect(() => insertMedia(db, media(m1))).toThrow(/UNIQUE/);
    // Files that are never downloaded keep the name, length and reason they were recorded with.
    const tooBig = insertMedia(db, media(message(db, 'DOC1', { mediaType: 'document' }), {
      kind: 'document', status: 'unavailable', mimeType: 'application/pdf', fileName: 'site plan.pdf', fileSize: 60_000_000, refEnc: null, errorCode: 'too_large',
    }));
    const video = insertMedia(db, media(message(db, 'VID1', { mediaType: 'video' }), { kind: 'video', status: 'metadata', mimeType: 'video/mp4', seconds: 42, refEnc: null }));
    expect(getMedia(db, tooBig)).toMatchObject({
      kind: 'document', status: 'unavailable', fileName: 'site plan.pdf', fileSize: 60_000_000, seconds: null, hasRef: false, errorCode: 'too_large',
    });
    expect(getMedia(db, video)).toMatchObject({ kind: 'video', status: 'metadata', fileName: null, seconds: 42, hasRef: false, errorCode: null });
  });

  it('refuses a file whose client is not its message\'s client, and stores nothing (T1-09)', () => {
    const db = seededDb();
    const sharmaMessage = message(db, 'A'); // client 1
    expect(() => insertMedia(db, media(sharmaMessage, { clientId: 2 }))).toThrow(/not a message of client 2/);
    expect(() => insertMedia(db, media(9999))).toThrow(/not a message of client 1/); // no such message at all
    expect(db.prepare('SELECT COUNT(*) AS n FROM media').get()).toEqual({ n: 0 });
    // The right client still works.
    const id = insertMedia(db, media(sharmaMessage));
    expect(getMedia(db, id)).toMatchObject({ messageId: sharmaMessage, clientId: 1 });
  });

  it('refuses an unknown kind, status or text kind', () => {
    const db = seededDb();
    expect(() => insertMedia(db, media(message(db, 'K'), { kind: 'gif' as MediaKind }))).toThrow(/CHECK/);
    expect(() => insertMedia(db, media(message(db, 'S'), { status: 'queued' as MediaStatus }))).toThrow(/CHECK/);
    const id = insertMedia(db, media(message(db, 'T')));
    expect(() => finishMedia(db, id, { textKind: 'summary' as TextKind, text: 'x', pageCount: null, note: null, at: NOW })).toThrow(/CHECK/);
    expect(getMedia(db, id)).toMatchObject({ status: 'pending', textKind: null });
  });

  it('keeps whether a file was forwarded', () => {
    const db = seededDb();
    const f = message(db, 'FWD');
    const fwd = insertMedia(db, media(f, { forwarded: true }));
    const own = insertMedia(db, media(message(db, 'OWN')));
    expect(getMedia(db, fwd)!.forwarded).toBe(true);
    expect(getMedia(db, own)!.forwarded).toBe(false);
    expect(mediaForMessages(db, [f], 100).get(f)!.forwarded).toBe(true);
  });

  it('finds the row id of a message', () => {
    const db = seededDb();
    const id = message(db, 'IMG1');
    expect(messageRowId(db, 1, 'IMG1')).toBe(id);
    expect(messageRowId(db, 2, 'IMG1')).toBeUndefined();
  });

  it('lists due pending files oldest first, skipping later retries and other statuses', () => {
    const db = seededDb();
    const a = insertMedia(db, media(message(db, 'A')));
    const b = insertMedia(db, media(message(db, 'B')));
    insertMedia(db, media(message(db, 'C'), { status: 'metadata', refEnc: null }));
    const d = insertMedia(db, media(message(db, 'D')));
    deferMedia(db, b, { errorCode: 'network', nextAttemptAt: '2026-10-19T08:05:00.000Z', countAttempt: true, at: NOW });
    expect(dueMediaIds(db, '2026-10-19T08:00:00.000Z', 10)).toEqual([a, d]);
    expect(dueMediaIds(db, '2026-10-19T08:05:00.000Z', 10)).toEqual([a, b, d]);
    expect(dueMediaIds(db, '2026-10-19T08:05:00.000Z', 1)).toEqual([a]);
    expect(getMedia(db, b)).toMatchObject({ attempts: 1, errorCode: 'network', nextAttemptAt: '2026-10-19T08:05:00.000Z' });
  });

  it('lists due files in the order their messages were sent, even when history arrives out of order', () => {
    const db = seededDb();
    const late = insertMedia(db, media(message(db, 'LATE', { ts: '2026-10-10T09:00:00.000Z' })));
    const early = insertMedia(db, media(message(db, 'EARLY', { ts: '2026-10-10T07:00:00.000Z' })));
    const sameTime = insertMedia(db, media(message(db, 'SAME', { ts: '2026-10-10T09:00:00.000Z' })));
    expect(dueMediaIds(db, NOW, 10)).toEqual([early, late, sameTime]);
    expect(dueMediaIds(db, NOW, 1)).toEqual([early]);
  });

  it('holds back the files of an inactive client until the client is active again', () => {
    const db = seededDb();
    const sha = insertMedia(db, media(message(db, 'A')));
    const meh = insertMedia(db, media(message(db, 'B', { clientId: 2 }), { clientId: 2 }));
    syncClients(db, [SHARMA]); // Mehta's group was taken off the allow-list
    expect(dueMediaIds(db, NOW, 10)).toEqual([sha]);
    expect(getMedia(db, meh)).toMatchObject({ status: 'pending', hasRef: true });
    syncClients(db, [SHARMA, MEHTA]);
    expect(dueMediaIds(db, NOW, 10)).toEqual([sha, meh]);
  });

  it('wipes the sealed details once the original is saved', () => {
    const db = seededDb();
    const id = insertMedia(db, media(message(db, 'A')));
    markDownloaded(db, id, { localPath: 'media/SHA/2026-10/A.jpg', sha256: 'ab'.repeat(32), fileSize: 2048, at: LATER });
    expect(getMediaRef(db, id)).toBeNull();
    expect(getMedia(db, id)).toMatchObject({
      status: 'pending', hasRef: false, localPath: 'media/SHA/2026-10/A.jpg', sha256: 'ab'.repeat(32), fileSize: 2048, createdAt: NOW, updatedAt: LATER,
    });
    finishMedia(db, id, { textKind: 'description', text: 'A blue banner', pageCount: null, note: null, at: LATER });
    expect(getMedia(db, id)).toMatchObject({ status: 'done', textKind: 'description', text: 'A blue banner', textChars: 13, errorCode: null, nextAttemptAt: null });
  });

  it('wipes the sealed details when a file is finished without a saved original', () => {
    const db = seededDb();
    const id = insertMedia(db, media(message(db, 'A')));
    finishMedia(db, id, { textKind: null, text: null, pageCount: null, note: null, at: NOW });
    expect(getMediaRef(db, id)).toBeNull();
    expect(getMedia(db, id)).toMatchObject({ status: 'done', hasRef: false, localPath: null });
  });

  it('finishing a file clears an earlier deferral', () => {
    const db = seededDb();
    const id = insertMedia(db, media(message(db, 'A')));
    deferMedia(db, id, { errorCode: 'spend_cap', nextAttemptAt: '2026-10-19T08:10:00.000Z', countAttempt: false, at: NOW });
    finishMedia(db, id, { textKind: 'description', text: 'A blue banner', pageCount: null, note: null, at: LATER });
    expect(getMedia(db, id)).toMatchObject({ status: 'done', errorCode: null, nextAttemptAt: null, updatedAt: LATER });
  });

  it('a deferral keeps the details; a final failure wipes them', () => {
    const db = seededDb();
    const id = insertMedia(db, media(message(db, 'A')));
    deferMedia(db, id, { errorCode: 'spend_cap', nextAttemptAt: '2026-10-19T09:10:00.000Z', countAttempt: false, at: LATER });
    expect(getMedia(db, id)).toMatchObject({ status: 'pending', errorCode: 'spend_cap', attempts: 0, hasRef: true, createdAt: NOW, updatedAt: LATER });
    failMedia(db, id, { status: 'unavailable', errorCode: 'expired', at: LATER });
    expect(getMediaRef(db, id)).toBeNull();
    expect(getMedia(db, id)).toMatchObject({ status: 'unavailable', errorCode: 'expired', nextAttemptAt: null });
  });

  // Final review FR1: the processor claims a file in a committed write before anything is decoded or paid for.
  it('a claim counts the attempt and moves the next attempt ahead, only while the file is pending', () => {
    const db = seededDb();
    const id = insertMedia(db, media(message(db, 'A')));
    deferMedia(db, id, { errorCode: 'ai_unavailable', nextAttemptAt: '2026-10-19T08:05:00.000Z', countAttempt: false, at: NOW });
    expect(claimMedia(db, id, { nextAttemptAt: '2026-10-19T09:15:00.000Z', at: LATER })).toBe(true);
    expect(getMedia(db, id)).toMatchObject({
      status: 'pending', attempts: 1, nextAttemptAt: '2026-10-19T09:15:00.000Z', errorCode: 'ai_unavailable', hasRef: true, updatedAt: LATER,
    });
    expect(dueMediaIds(db, '2026-10-19T09:14:59.999Z', 10)).toEqual([]);
    failMedia(db, id, { status: 'failed', errorCode: 'crashed', at: LATER });
    expect(claimMedia(db, id, { nextAttemptAt: '2026-10-19T09:30:00.000Z', at: LATER })).toBe(false);
    expect(getMedia(db, id)).toMatchObject({ status: 'failed', attempts: 1, nextAttemptAt: null });
  });

  it('a deferral can store the attempts exactly, as they were before a claim', () => {
    const db = seededDb();
    const id = insertMedia(db, media(message(db, 'A')));
    claimMedia(db, id, { nextAttemptAt: '2026-10-19T08:15:00.000Z', at: NOW });
    claimMedia(db, id, { nextAttemptAt: '2026-10-19T08:15:00.000Z', at: NOW });
    deferMedia(db, id, { errorCode: 'spend_cap', nextAttemptAt: '2026-10-19T08:10:00.000Z', attempts: 1, at: NOW });
    expect(getMedia(db, id)).toMatchObject({ status: 'pending', attempts: 1, errorCode: 'spend_cap', nextAttemptAt: '2026-10-19T08:10:00.000Z' });
    deferMedia(db, id, { errorCode: 'network', nextAttemptAt: '2026-10-19T08:11:00.000Z', countAttempt: true, at: NOW });
    expect(getMedia(db, id)!.attempts).toBe(2);
  });

  it('a final failure keeps an original that was already saved', () => {
    const db = seededDb();
    const id = insertMedia(db, pdf(message(db, 'A', { mediaType: 'document' })));
    markDownloaded(db, id, { localPath: 'media/SHA/2026-10/A.pdf', sha256: 'cd'.repeat(32), fileSize: 4096, at: NOW });
    failMedia(db, id, { status: 'failed', errorCode: 'not_pdf', at: LATER });
    expect(getMediaRef(db, id)).toBeNull();
    expect(getMedia(db, id)).toMatchObject({
      status: 'failed', errorCode: 'not_pdf', hasRef: false, localPath: 'media/SHA/2026-10/A.pdf', sha256: 'cd'.repeat(32), fileSize: 4096, updatedAt: LATER,
    });
  });

  it('maps files to their messages and gives a job its context', () => {
    const db = seededDb();
    const m1 = message(db, 'A');
    const m2 = message(db, 'B', { clientId: 2 });
    const t1 = message(db, 'T', { mediaType: null });
    const id = insertMedia(db, media(m1));
    insertMedia(db, media(m2, { clientId: 2 }));
    const map = mediaForMessages(db, [m1, t1], 100);
    expect([...map.keys()]).toEqual([m1]);
    expect(map.get(m1)!.id).toBe(id);
    expect(mediaForMessages(db, [], 100)).toEqual(new Map());
    expect(mediaJob(db, id)).toEqual({ clientId: 1, clientCode: 'SHA', waId: 'A', ts: '2026-10-10T08:00:00.000Z', revoked: false });
    applyRevoke(db, 1, 'A'); // the sender deleted the message for everyone
    expect(mediaJob(db, id)!.revoked).toBe(true);
  });

  it('keys files by message row id, which is not the file row id', () => {
    const db = seededDb();
    for (const waId of ['T1', 'T2', 'T3']) message(db, waId, { mediaType: null }); // text messages take the first message row ids
    const mA = message(db, 'A');
    const mB = message(db, 'B', { mediaType: 'document' });
    const fileB = insertMedia(db, pdf(mB)); // B's file is recorded first, so the file row ids run the other way
    const fileA = insertMedia(db, media(mA));
    const map = mediaForMessages(db, [mA, mB], 100);
    expect([...map.keys()].sort((x, y) => x - y)).toEqual([mA, mB]);
    expect(map.get(mA)).toMatchObject({ id: fileA, messageId: mA, kind: 'image' });
    expect(map.get(mB)).toMatchObject({ id: fileB, messageId: mB, kind: 'document' });
  });

  it('reads only the start of a long file text for the prompt, with the full length', () => {
    const db = seededDb();
    const m1 = message(db, 'A', { mediaType: 'document' });
    const id = insertMedia(db, pdf(m1));
    finishMedia(db, id, { textKind: 'extract', text: 'x'.repeat(1_000_000), pageCount: 250, note: 'first_pages_only', at: NOW });
    const row = mediaForMessages(db, [m1], 20_001).get(m1)!;
    expect(row.text).toHaveLength(20_001);
    expect(row).toMatchObject({ textKind: 'extract', textChars: 1_000_000, pageCount: 250, note: 'first_pages_only' });
    expect(getMedia(db, id)).toMatchObject({ textChars: 1_000_000, pageCount: 250, note: 'first_pages_only' });
  });

  it('cuts and counts file text by characters, so a cut never splits one', () => {
    const db = seededDb();
    const m1 = message(db, 'A');
    const id = insertMedia(db, media(m1));
    // The emoji is one character but two UTF-16 code units.
    finishMedia(db, id, { textKind: 'description', text: 'ab😀cdef', pageCount: null, note: null, at: NOW });
    expect(mediaForMessages(db, [m1], 4).get(m1)).toMatchObject({ text: 'ab😀c', textChars: 7 });
    expect(mediaForMessages(db, [m1], 100).get(m1)).toMatchObject({ text: 'ab😀cdef', textChars: 7 });
  });

  it('stores NUL characters, which SQLite would take as the end of the text, as spaces so the words around them stay apart', () => {
    const db = seededDb();
    const m1 = message(db, 'A', { mediaType: 'document' });
    const id = insertMedia(db, pdf(m1));
    finishMedia(db, id, { textKind: 'extract', text: 'Page 1\u0000Total: 42,000', pageCount: 1, note: null, at: NOW });
    expect(getMedia(db, id)).toMatchObject({ text: 'Page 1 Total: 42,000', textChars: 20 });
    expect(mediaForMessages(db, [m1], 100).get(m1)).toMatchObject({ text: 'Page 1 Total: 42,000', textChars: 20 });
  });
});

describe('a file read after its message was processed (12h)', () => {
  /** A message with a pending file, marked processed at NOW (it went ahead with "still being read"). */
  function processedWithFile(o: Partial<NewMedia> = {}) {
    const db = seededDb();
    const messageId = message(db, 'A', { mediaType: o.kind ?? 'image' });
    const id = insertMedia(db, media(messageId, o));
    markProcessed(db, [messageId], NOW);
    return { db, id, messageId };
  }
  const stateOf = (db: Db, messageId: number, id: number) => ({
    ...(db.prepare('SELECT processed_at AS processedAt, version FROM messages WHERE id = ?').get(messageId) as { processedAt: string | null; version: number }),
    requeuedForText: getMedia(db, id)!.requeuedForText,
  });

  it.each([
    { textKind: 'description' as const, text: 'A payment receipt. Visible text: Paid ₹42,000', kind: 'image' as const },
    { textKind: 'extract' as const, text: 'Quotation No. 17\nTotal 42,000', kind: 'document' as const },
  ])('a $textKind read late queues the message again: processed_at cleared, version bumped, file flagged', ({ textKind, text, kind }) => {
    const { db, id, messageId } = processedWithFile({ kind, mimeType: kind === 'image' ? 'image/jpeg' : 'application/pdf' });
    expect(stateOf(db, messageId, id)).toEqual({ processedAt: NOW, version: 0, requeuedForText: false });
    finishMedia(db, id, { textKind, text, pageCount: null, note: null, at: LATER });
    expect(stateOf(db, messageId, id)).toEqual({ processedAt: null, version: 1, requeuedForText: true });
    expect(listUnprocessed(db, 1)).toEqual([expect.objectContaining({ id: messageId, requeueReason: null })]);
    expect(getMedia(db, id)).toMatchObject({ status: 'done', textKind, text, updatedAt: LATER });
  });

  it('re-queues in the same transaction as the finish: a failed re-queue leaves the file pending', () => {
    const { db, id, messageId } = processedWithFile();
    db.exec("CREATE TRIGGER fail_requeue BEFORE UPDATE OF processed_at ON messages BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    expect(() => finishMedia(db, id, { textKind: 'description', text: 'A receipt', pageCount: null, note: null, at: LATER })).toThrow(/test failure/);
    expect(getMedia(db, id)).toMatchObject({ status: 'pending', text: null, requeuedForText: false });
    expect(stateOf(db, messageId, id)).toEqual({ processedAt: NOW, version: 0, requeuedForText: false });
  });

  it('flags a message already queued again for a reaction, keeping its reaction marker', () => {
    const { db, id, messageId } = processedWithFile();
    upsertReaction(db, { clientId: 1, targetWaId: 'A', reactorJid: 'r1', emoji: '✅', ts: NOW });
    expect(stateOf(db, messageId, id)).toEqual({ processedAt: null, version: 1, requeuedForText: false });
    finishMedia(db, id, { textKind: 'description', text: 'A receipt', pageCount: null, note: null, at: LATER });
    expect(stateOf(db, messageId, id)).toEqual({ processedAt: null, version: 2, requeuedForText: true });
    expect(listUnprocessed(db, 1)[0]).toMatchObject({ id: messageId, requeueReason: 'reaction' });
  });

  it('does not flag a message that was never processed; only its version moves, so a run holding it notices', () => {
    const db = seededDb();
    const messageId = message(db, 'A');
    const id = insertMedia(db, media(messageId));
    finishMedia(db, id, { textKind: 'description', text: 'A receipt', pageCount: null, note: null, at: LATER });
    expect(stateOf(db, messageId, id)).toEqual({ processedAt: null, version: 1, requeuedForText: false });
    expect(listUnprocessed(db, 1)).toEqual([expect.objectContaining({ id: messageId, requeueReason: null })]);
  });

  it.each(['voice', 'audio'] as const)('kind %s: a transcript read late queues the message again, exactly as the description of a picture does (V1)', (kind) => {
    const { db, id, messageId } = processedWithFile({ kind, mimeType: 'audio/ogg; codecs=opus' });
    finishMedia(db, id, { textKind: 'extract', text: 'Payment done, please check', pageCount: null, note: null, at: LATER });
    expect(getMedia(db, id)).toMatchObject({ status: 'done', textKind: 'extract', text: 'Payment done, please check', backlog: false });
    expect(stateOf(db, messageId, id)).toEqual({ processedAt: null, version: 1, requeuedForText: true });
    expect(listUnprocessed(db, 1)).toEqual([expect.objectContaining({ id: messageId, requeueReason: null })]);
  });

  it.each(['video', 'sticker'] as const)('kind %s: a file that finishes with text re-queues nothing (M1)', (kind) => {
    const { db, id, messageId } = processedWithFile({ kind, mimeType: null });
    finishMedia(db, id, { textKind: 'extract', text: 'Payment done, please check', pageCount: null, note: null, at: LATER });
    expect(getMedia(db, id)).toMatchObject({ status: 'done', text: 'Payment done, please check' });
    expect(stateOf(db, messageId, id)).toEqual({ processedAt: NOW, version: 0, requeuedForText: false });
    expect(listUnprocessed(db, 1)).toEqual([]);
  });

  it.each(['voice', 'audio'] as const)('kind %s: a transcript of a message never processed moves only its version, as a picture does (V1)', (kind) => {
    const db = seededDb();
    const messageId = message(db, 'A', { mediaType: kind });
    const id = insertMedia(db, media(messageId, { kind, mimeType: null }));
    finishMedia(db, id, { textKind: 'extract', text: 'Payment done', pageCount: null, note: null, at: LATER });
    expect(stateOf(db, messageId, id)).toEqual({ processedAt: null, version: 1, requeuedForText: false });
  });

  it.each(['voice', 'audio'] as const)('kind %s: a backlog transcript is stored for the record and never queues its message again (V6)', (kind) => {
    const db = seededDb();
    const messageId = message(db, 'A', { mediaType: kind });
    const id = insertMedia(db, media(messageId, { kind, mimeType: null, refEnc: null }));
    markDownloaded(db, id, { localPath: 'media/SHA/2026-10/A-1.ogg', sha256: 'x', fileSize: 9000, at: NOW });
    finishMedia(db, id, { textKind: null, text: null, pageCount: null, note: null, at: NOW }); // the 2a backlog: saved, no transcript
    markProcessed(db, [messageId], NOW);
    expect(queueVoiceBacklog(db, [id], LATER)).toBe(1);
    finishMedia(db, id, { textKind: 'extract', text: 'Payment done, please check', pageCount: null, note: null, at: LATER });
    expect(getMedia(db, id)).toMatchObject({ status: 'done', textKind: 'extract', text: 'Payment done, please check', backlog: true });
    expect(stateOf(db, messageId, id)).toEqual({ processedAt: NOW, version: 0, requeuedForText: false });
    expect(listUnprocessed(db, 1)).toEqual([]);
  });

  it.each([
    { why: 'never processed', after: (_db: Db, _messageId: number) => undefined, state: { processedAt: null, version: 1, requeuedForText: false } },
    {
      why: 'queued again for a reaction',
      after: (db: Db, messageId: number) => {
        markProcessed(db, [messageId], NOW);
        upsertReaction(db, { clientId: 1, targetWaId: 'A', reactorJid: 'r@s.whatsapp.net', emoji: '\u{1F44D}', ts: NOW });
      },
      state: { processedAt: null, version: 2, requeuedForText: true }, // the reaction moved the version once, the transcript once
    },
  ])('a 2a file queued while its message is $why is queued as a live file: its transcript is read with the message (review B)', ({ after, state }) => {
    const db = seededDb();
    const messageId = message(db, 'A', { mediaType: 'voice' });
    const id = insertMedia(db, media(messageId, { kind: 'voice', mimeType: null, refEnc: null }));
    markDownloaded(db, id, { localPath: 'media/SHA/2026-10/A-1.ogg', sha256: 'x', fileSize: 9000, at: NOW });
    finishMedia(db, id, { textKind: null, text: null, pageCount: null, note: null, at: NOW });
    after(db, messageId);
    expect(queueVoiceBacklog(db, [id], LATER)).toBe(1);
    expect(getMedia(db, id)).toMatchObject({ status: 'pending', backlog: false });
    finishMedia(db, id, { textKind: 'extract', text: 'Payment done, please check', pageCount: null, note: null, at: LATER });
    expect(stateOf(db, messageId, id)).toEqual(state);
    expect(listUnprocessed(db, 1).map((m) => m.id)).toEqual([messageId]);
  });

  it('never re-queues a message deleted for everyone', () => {
    const { db, id, messageId } = processedWithFile();
    applyRevoke(db, 1, 'A');
    finishMedia(db, id, { textKind: 'description', text: 'A receipt', pageCount: null, note: null, at: LATER });
    expect(stateOf(db, messageId, id)).toEqual({ processedAt: NOW, version: 0, requeuedForText: false });
    expect(listUnprocessed(db, 1)).toEqual([]);
  });

  it.each([
    ['could not be read', (db: Db, id: number) => failMedia(db, id, { status: 'failed', errorCode: 'not_pdf', at: LATER })],
    ['too large to download', (db: Db, id: number) => failMedia(db, id, { status: 'unavailable', errorCode: 'too_large', at: LATER })],
    ['forwarded, not described', (db: Db, id: number) => finishMedia(db, id, { textKind: null, text: null, pageCount: null, note: 'forwarded_not_described', at: LATER })],
    ['an image too costly to describe', (db: Db, id: number) => finishMedia(db, id, { textKind: null, text: null, pageCount: null, note: 'too_costly', at: LATER })],
    ['an empty description', (db: Db, id: number) => finishMedia(db, id, { textKind: 'description', text: '', pageCount: null, note: null, at: LATER })],
    ['an extract with no text', (db: Db, id: number) => finishMedia(db, id, { textKind: 'extract', text: null, pageCount: 2, note: null, at: LATER })],
    ['text without a text kind', (db: Db, id: number) => finishMedia(db, id, { textKind: null, text: 'x', pageCount: null, note: null, at: LATER })],
  ])('re-queues nothing when the file ends without text: %s', (_why, end) => {
    const { db, id, messageId } = processedWithFile();
    end(db, id);
    expect(stateOf(db, messageId, id)).toEqual({ processedAt: NOW, version: 0, requeuedForText: false });
    expect(listUnprocessed(db, 1)).toEqual([]);
  });

  it('a view-once file is never read, so it never re-queues its message', () => {
    const { db, id, messageId } = processedWithFile({ status: 'metadata', errorCode: 'view_once', refEnc: null });
    expect(dueMediaIds(db, LATER, 10)).toEqual([]);
    expect(stateOf(db, messageId, id)).toEqual({ processedAt: NOW, version: 0, requeuedForText: false });
  });

  it('a second finish of the same file does nothing: the version moves once and the first result stays (12h hardening)', () => {
    const { db, id, messageId } = processedWithFile();
    finishMedia(db, id, { textKind: 'description', text: 'A receipt', pageCount: null, note: null, at: LATER });
    expect(stateOf(db, messageId, id)).toEqual({ processedAt: null, version: 1, requeuedForText: true });
    finishMedia(db, id, { textKind: 'extract', text: 'Another text', pageCount: 2, note: 'x', at: '2026-10-19T10:00:00.000Z' });
    expect(stateOf(db, messageId, id)).toEqual({ processedAt: null, version: 1, requeuedForText: true });
    expect(getMedia(db, id)).toMatchObject({ status: 'done', textKind: 'description', text: 'A receipt', pageCount: null, note: null, updatedAt: LATER });
  });

  it('a second finish after the re-check was processed queues nothing again (12h hardening)', () => {
    const { db, id, messageId } = processedWithFile();
    finishMedia(db, id, { textKind: 'description', text: 'A receipt', pageCount: null, note: null, at: LATER });
    expect(markProcessedIfUnchanged(db, [{ id: messageId, version: 1, fileShown: true }], LATER)).toBe(0);
    expect(stateOf(db, messageId, id)).toEqual({ processedAt: LATER, version: 1, requeuedForText: false });
    finishMedia(db, id, { textKind: 'description', text: 'A receipt', pageCount: null, note: null, at: '2026-10-19T10:00:00.000Z' });
    expect(stateOf(db, messageId, id)).toEqual({ processedAt: LATER, version: 1, requeuedForText: false });
    expect(listUnprocessed(db, 1)).toEqual([]);
  });

  it.each([
    ['only spaces', '   \n\t '],
    ['only NULs', '\u0000\u0000\u0000'],
    ['only zero-width characters', '\u200B\u200C\u200D\u2060\uFEFF'],
    ['spaces, NULs and zero-width characters', ' \u0000\u200B \u200D\u0000 '],
  ])('stores text with nothing visible (%s) as no text, and re-queues nothing (12h hardening)', (_why, text) => {
    const { db, id, messageId } = processedWithFile({ kind: 'document', mimeType: 'application/pdf' });
    finishMedia(db, id, { textKind: 'extract', text, pageCount: 1, note: null, at: LATER });
    expect(getMedia(db, id)).toMatchObject({ status: 'done', textKind: 'extract', text: null, textChars: null, pageCount: 1 });
    expect(stateOf(db, messageId, id)).toEqual({ processedAt: NOW, version: 0, requeuedForText: false });
    expect(listUnprocessed(db, 1)).toEqual([]);
  });

  it('keeps text that shows something next to hidden characters, NULs as spaces (12h hardening)', () => {
    const { db, id, messageId } = processedWithFile({ kind: 'document', mimeType: 'application/pdf' });
    finishMedia(db, id, { textKind: 'extract', text: '\u200B\u0000Total 42,000\u200D', pageCount: 1, note: null, at: LATER });
    expect(getMedia(db, id)).toMatchObject({ text: '\u200B Total 42,000\u200D' });
    expect(stateOf(db, messageId, id)).toEqual({ processedAt: null, version: 1, requeuedForText: true });
  });

  it('mediaForMessages carries the flag', () => {
    const { db, id, messageId } = processedWithFile();
    expect(mediaForMessages(db, [messageId], 0).get(messageId)!.requeuedForText).toBe(false);
    finishMedia(db, id, { textKind: 'description', text: 'A receipt', pageCount: null, note: null, at: LATER });
    expect(mediaForMessages(db, [messageId], 0).get(messageId)).toMatchObject({ id, requeuedForText: true, updatedAt: LATER });
  });
});

/** A voice note (or audio file) saved on disk. Pending: about to be transcribed. */
function savedVoice(db: Db, waId: string, o: { clientId?: number; kind?: MediaKind; fileSize?: number; mimeType?: string; ts?: string } = {}): number {
  const clientId = o.clientId ?? 1;
  const kind = o.kind ?? 'voice';
  const id = insertMedia(db, media(message(db, waId, { clientId, mediaType: kind, ts: o.ts }), { clientId, kind, mimeType: o.mimeType ?? 'audio/ogg; codecs=opus' }));
  markDownloaded(db, id, { localPath: `media/x/2026-10/${waId}-${id}.ogg`, sha256: 'x', fileSize: o.fileSize ?? 9000, at: NOW });
  return id;
}

/** A 2a voice note: saved, finished without a transcript (a claim counted one attempt), and its message processed. */
function backlogVoice(db: Db, waId: string, o: { clientId?: number; kind?: MediaKind; fileSize?: number; mimeType?: string; note?: string | null } = {}): number {
  const id = savedVoice(db, waId, o);
  claimMedia(db, id, { nextAttemptAt: LATER, at: NOW });
  finishMedia(db, id, { textKind: null, text: null, pageCount: null, note: o.note ?? null, at: NOW });
  markProcessed(db, [getMedia(db, id)!.messageId], NOW);
  return id;
}

const TRANSCRIPT = { textKind: 'extract' as const, text: 'Payment done, please check', pageCount: null, note: null, at: LATER };
const forgets = (db: Db) =>
  db.prepare('SELECT media_id AS mediaId, provider, ref, created_at AS createdAt, attempts, next_try_at AS nextTryAt FROM media_stt_forget ORDER BY id').all();

describe('finishMedia: the speech provider\'s stored copy of a transcript (N1)', () => {
  it('notes the copy to delete in the same write as the finish', () => {
    const db = seededDb();
    const id = savedVoice(db, 'A');
    finishMedia(db, id, { ...TRANSCRIPT, forget: { provider: 'elevenlabs', ref: 'tr_1' } });
    expect(getMedia(db, id)).toMatchObject({ status: 'done', text: 'Payment done, please check' });
    expect(forgets(db)).toEqual([{ mediaId: id, provider: 'elevenlabs', ref: 'tr_1', createdAt: LATER, attempts: 0, nextTryAt: null }]);
  });

  it('a second finish with the same copy notes nothing more; one with another copy notes it, though its transcript is not stored (review F)', () => {
    const db = seededDb();
    const id = savedVoice(db, 'A');
    finishMedia(db, id, { ...TRANSCRIPT, forget: { provider: 'elevenlabs', ref: 'tr_1' } });
    finishMedia(db, id, { ...TRANSCRIPT, forget: { provider: 'elevenlabs', ref: 'tr_1' } });
    expect(forgets(db)).toEqual([expect.objectContaining({ mediaId: id, ref: 'tr_1' })]);
    finishMedia(db, id, { ...TRANSCRIPT, text: 'Another transcript', forget: { provider: 'elevenlabs', ref: 'tr_2' } });
    expect(forgets(db)).toEqual([expect.objectContaining({ mediaId: id, ref: 'tr_1' }), expect.objectContaining({ mediaId: id, ref: 'tr_2', createdAt: LATER })]);
    expect(getMedia(db, id)).toMatchObject({ status: 'done', text: 'Payment done, please check' });
  });

  it('a finish of a file that already failed still notes its copy (review F)', () => {
    const db = seededDb();
    const id = savedVoice(db, 'A');
    failMedia(db, id, { status: 'failed', errorCode: 'stt_failed', at: NOW });
    finishMedia(db, id, { ...TRANSCRIPT, forget: { provider: 'openai', ref: 'resp_1' } });
    expect(getMedia(db, id)).toMatchObject({ status: 'failed', text: null });
    expect(forgets(db)).toEqual([expect.objectContaining({ mediaId: id, provider: 'openai', ref: 'resp_1' })]);
  });

  it('notes nothing without a copy', () => {
    const db = seededDb();
    finishMedia(db, savedVoice(db, 'A'), TRANSCRIPT);
    finishMedia(db, savedVoice(db, 'B'), { ...TRANSCRIPT, forget: null });
    expect(forgets(db)).toEqual([]);
  });

  it('a copy that cannot be noted leaves the file pending, so the finish and the note never part', () => {
    const db = seededDb();
    const id = savedVoice(db, 'A');
    expect(() => finishMedia(db, id, { ...TRANSCRIPT, forget: { provider: 'elevenlabs', ref: '' } })).toThrow(/CHECK/);
    expect(getMedia(db, id)).toMatchObject({ status: 'pending', text: null });
    expect(forgets(db)).toEqual([]);
  });
});

describe('the 2a voice backlog (V6, N2)', () => {
  it('lists saved voice notes and audio files that have no transcript, a format_not_supported note included', () => {
    const db = seededDb();
    const voice = backlogVoice(db, 'V', { fileSize: 12_000 });
    const audio = backlogVoice(db, 'AU', { kind: 'audio', fileSize: 40_000 });
    const m4a = backlogVoice(db, 'M4A', { kind: 'audio', mimeType: 'audio/mp4', note: 'format_not_supported' });
    const mehta = backlogVoice(db, 'MV', { clientId: 2, fileSize: 5_000 });
    const ogg = 'audio/ogg; codecs=opus';
    expect(voiceBacklog(db)).toEqual([
      { id: voice, clientId: 1, fileSize: 12_000, mimeType: ogg },
      { id: audio, clientId: 1, fileSize: 40_000, mimeType: ogg },
      { id: m4a, clientId: 1, fileSize: 9000, mimeType: 'audio/mp4' },
      { id: mehta, clientId: 2, fileSize: 5_000, mimeType: ogg },
    ]);
    expect(voiceBacklog(db, { clientId: 2 })).toEqual([{ id: mehta, clientId: 2, fileSize: 5_000, mimeType: ogg }]);
    expect(voiceBacklog(db, { clientId: 1 }).map((r) => r.id)).toEqual([voice, audio, m4a]);
  });

  it('skips files with another note, with text, without a saved file, with an error, still pending, already queued, or of another kind', () => {
    const db = seededDb();
    backlogVoice(db, 'LONG', { note: 'too_long' });
    backlogVoice(db, 'FWD', { note: 'forwarded_not_transcribed' });
    finishMedia(db, savedVoice(db, 'DONE'), TRANSCRIPT);
    const unsaved = insertMedia(db, media(message(db, 'NOFILE', { mediaType: 'voice' }), { kind: 'voice', mimeType: 'audio/ogg' }));
    finishMedia(db, unsaved, { textKind: null, text: null, pageCount: null, note: null, at: NOW });
    const withError = insertMedia(db, media(message(db, 'ERR', { mediaType: 'voice' }), { kind: 'voice', status: 'done', errorCode: 'x', refEnc: null }));
    markDownloaded(db, withError, { localPath: 'media/x/2026-10/ERR.ogg', sha256: 'x', fileSize: 9000, at: NOW });
    savedVoice(db, 'PENDING');
    const queued = backlogVoice(db, 'QUEUED');
    queueVoiceBacklog(db, [queued], LATER);
    finishMedia(db, queued, { textKind: null, text: null, pageCount: null, note: null, at: LATER }); // queued once, still no transcript
    const image = insertMedia(db, media(message(db, 'IMG')));
    markDownloaded(db, image, { localPath: 'media/x/2026-10/IMG.jpg', sha256: 'x', fileSize: 9000, at: NOW });
    finishMedia(db, image, { textKind: null, text: null, pageCount: null, note: null, at: NOW });
    const video = insertMedia(db, media(message(db, 'VID', { mediaType: 'video' }), { kind: 'video', status: 'done', refEnc: null }));
    markDownloaded(db, video, { localPath: 'media/x/2026-10/VID.mp4', sha256: 'x', fileSize: 9000, at: NOW });
    expect(voiceBacklog(db)).toEqual([]);
  });

  it('skips a message deleted for everyone and a client no longer on the allow-list', () => {
    const db = seededDb();
    backlogVoice(db, 'A');
    applyRevoke(db, 1, 'A');
    const mehta = backlogVoice(db, 'B', { clientId: 2 });
    expect(voiceBacklog(db)).toEqual([{ id: mehta, clientId: 2, fileSize: 9000, mimeType: 'audio/ogg; codecs=opus' }]);
    syncClients(db, [SHARMA]);
    expect(voiceBacklog(db)).toEqual([]);
    syncClients(db, [SHARMA, MEHTA]);
    expect(voiceBacklog(db).map((r) => r.id)).toEqual([mehta]);
  });

  it('queues exactly the given files for transcription as backlog, in one write, and says how many', () => {
    const db = seededDb();
    const a = backlogVoice(db, 'A');
    const b = backlogVoice(db, 'B', { kind: 'audio', note: 'format_not_supported' });
    const c = backlogVoice(db, 'C');
    expect(getMedia(db, a)).toMatchObject({ status: 'done', attempts: 1, backlog: false });
    expect(queueVoiceBacklog(db, [a, b], LATER)).toBe(2);
    for (const id of [a, b]) {
      expect(getMedia(db, id)).toMatchObject({ status: 'pending', backlog: true, attempts: 0, nextAttemptAt: null, errorCode: null, updatedAt: LATER });
    }
    expect(getMedia(db, c)).toMatchObject({ status: 'done', backlog: false, attempts: 1 });
    expect(dueMediaIds(db, LATER, 10)).toEqual([a, b]);
    expect(voiceBacklog(db).map((r) => r.id)).toEqual([c]);
    expect(queueVoiceBacklog(db, [], LATER)).toBe(0);
  });

  it('leaves alone a file that changed since it was listed, or that never qualified', () => {
    const db = seededDb();
    const revoked = backlogVoice(db, 'A');
    const transcribed = backlogVoice(db, 'B');
    const fine = backlogVoice(db, 'C');
    const image = insertMedia(db, media(message(db, 'IMG')));
    const listed = voiceBacklog(db).map((r) => r.id);
    expect(listed).toEqual([revoked, transcribed, fine]);
    applyRevoke(db, 1, 'A');
    db.prepare("UPDATE media SET text_kind = 'extract', text = 'Done' WHERE id = ?").run(transcribed);
    expect(queueVoiceBacklog(db, [...listed, image, 9999], LATER)).toBe(1);
    expect(getMedia(db, revoked)).toMatchObject({ status: 'done', backlog: false });
    expect(getMedia(db, transcribed)).toMatchObject({ status: 'done', backlog: false });
    expect(getMedia(db, fine)).toMatchObject({ status: 'pending', backlog: true });
    expect(getMedia(db, image)).toMatchObject({ status: 'pending', backlog: false });
  });

  it('getMedia and mediaForMessages read backlog', () => {
    const db = seededDb();
    const id = backlogVoice(db, 'A');
    const messageId = getMedia(db, id)!.messageId;
    expect(getMedia(db, id)!.backlog).toBe(false);
    expect(mediaForMessages(db, [messageId], 10).get(messageId)!.backlog).toBe(false);
    queueVoiceBacklog(db, [id], LATER);
    expect(getMedia(db, id)!.backlog).toBe(true);
    expect(mediaForMessages(db, [messageId], 10).get(messageId)!.backlog).toBe(true);
  });

  it('a queued file counts its waits from the queueing, not from its arrival days before, and is never stale (review A, round 2)', () => {
    const db = seededDb();
    const id = backlogVoice(db, 'A'); // arrived at NOW
    const queuedAt = '2026-10-22T08:00:00.000Z';
    expect(queueVoiceBacklog(db, [id], queuedAt)).toBe(1);
    expect(getMedia(db, id)).toMatchObject({ status: 'pending', createdAt: queuedAt, updatedAt: queuedAt });
    expect(mediaStats(db, new Date(queuedAt))).toMatchObject({ pending: 1, stale: 0 });
    // A long backlog run is not a fault: the file never counts as waiting too long, however long the queue takes.
    expect(mediaStats(db, new Date('2026-10-22T08:31:00.000Z'))).toMatchObject({ pending: 1, stale: 0 });
  });

  it('a file that finished format_not_supported after it was queued is listed again, and can be queued again (review C)', () => {
    const db = seededDb();
    const id = backlogVoice(db, 'A', { kind: 'audio', mimeType: 'audio/mp4', note: 'format_not_supported' });
    expect(queueVoiceBacklog(db, [id], LATER)).toBe(1);
    expect(getMedia(db, id)).toMatchObject({ status: 'pending', backlog: true, note: null });
    expect(voiceBacklog(db)).toEqual([]);
    finishMedia(db, id, { textKind: null, text: null, pageCount: null, note: 'format_not_supported', at: LATER }); // still no ffmpeg
    expect(voiceBacklog(db)).toEqual([{ id, clientId: 1, fileSize: 9000, mimeType: 'audio/mp4' }]);
    expect(queueVoiceBacklog(db, [id], '2026-10-19T10:00:00.000Z')).toBe(1);
    expect(getMedia(db, id)).toMatchObject({ status: 'pending', backlog: true, note: null, createdAt: '2026-10-19T10:00:00.000Z' });
  });

  it('lists live pending files before backlog files, so a long backlog never holds up a new voice note (review D)', () => {
    const db = seededDb();
    const old1 = backlogVoice(db, 'OLD1');
    const old2 = backlogVoice(db, 'OLD2');
    expect(queueVoiceBacklog(db, [old1, old2], NOW)).toBe(2);
    const live = savedVoice(db, 'NEW', { ts: '2026-10-19T07:59:00.000Z' }); // sent days after the backlog's messages
    expect(dueMediaIds(db, LATER, 1)).toEqual([live]);
    expect(dueMediaIds(db, LATER, 10)).toEqual([live, old1, old2]);
  });
});

describe('the queue of provider copies to delete (N1)', () => {
  const T0 = '2026-10-19T10:00:00.000Z';
  const T1 = '2026-10-19T10:15:00.000Z';
  /** Three transcribed voice notes, each with a copy to delete (ids 1 to 3 in media_stt_forget). */
  function threeCopies() {
    const db = seededDb();
    const ids = ['A', 'B', 'C'].map((waId, i) => {
      const id = savedVoice(db, waId);
      finishMedia(db, id, { ...TRANSCRIPT, forget: { provider: 'elevenlabs', ref: `tr_${i + 1}` } });
      return id;
    });
    return { db, ids };
  }

  it('lists the copies due, oldest first, and only one file\'s when asked', () => {
    const { db, ids } = threeCopies();
    expect(pendingMediaForgets(db, { nowIso: T0, maxAttempts: 5 })).toEqual([
      { id: 1, mediaId: ids[0], provider: 'elevenlabs', ref: 'tr_1', attempts: 0 },
      { id: 2, mediaId: ids[1], provider: 'elevenlabs', ref: 'tr_2', attempts: 0 },
      { id: 3, mediaId: ids[2], provider: 'elevenlabs', ref: 'tr_3', attempts: 0 },
    ]);
    expect(pendingMediaForgets(db, { nowIso: T0, maxAttempts: 5, mediaId: ids[1] })).toEqual([
      { id: 2, mediaId: ids[1], provider: 'elevenlabs', ref: 'tr_2', attempts: 0 },
    ]);
  });

  it('counts a try and holds the copy back until its next try is due', () => {
    const { db } = threeCopies();
    countMediaForgetAttempt(db, 2, T1);
    expect(db.prepare('SELECT attempts, next_try_at AS nextTryAt FROM media_stt_forget WHERE id = 2').get()).toEqual({ attempts: 1, nextTryAt: T1 });
    expect(pendingMediaForgets(db, { nowIso: T0, maxAttempts: 5 }).map((f) => f.id)).toEqual([1, 3]);
    expect(pendingMediaForgets(db, { nowIso: T1, maxAttempts: 5 })).toEqual([
      expect.objectContaining({ id: 1 }), expect.objectContaining({ id: 2, attempts: 1 }), expect.objectContaining({ id: 3 }),
    ]);
  });

  it('stops listing a copy once its tries are used up', () => {
    const { db } = threeCopies();
    for (let i = 0; i < 5; i++) countMediaForgetAttempt(db, 1, T0);
    expect(pendingMediaForgets(db, { nowIso: T1, maxAttempts: 5 }).map((f) => f.id)).toEqual([2, 3]);
    expect(pendingMediaForgets(db, { nowIso: T1, maxAttempts: 6 }).map((f) => f.id)).toEqual([1, 2, 3]);
  });

  it('removes a copy once the provider has deleted it', () => {
    const { db } = threeCopies();
    deleteMediaForget(db, 2);
    expect(pendingMediaForgets(db, { nowIso: T0, maxAttempts: 5 }).map((f) => f.id)).toEqual([1, 3]);
    expect(forgets(db)).toHaveLength(2);
  });
  it('counts the copies given up: last try used, or a provider that is not set up now (status, Task 9)', () => {
    const db = seededDb();
    const add = (waId: string, provider: 'elevenlabs' | 'openai', ref: string) => {
      const id = savedVoice(db, waId);
      finishMedia(db, id, { ...TRANSCRIPT, forget: { provider, ref } });
    };
    expect(mediaSttForgetsGivenUp(db, { maxAttempts: 5, provider: 'elevenlabs' })).toBe(0);
    add('A', 'elevenlabs', 'tr_1'); // last try used
    add('B', 'elevenlabs', 'tr_2'); // still being tried
    add('C', 'openai', 'tr_3'); // not the provider set up now
    for (let i = 0; i < 5; i++) countMediaForgetAttempt(db, 1, T0);
    countMediaForgetAttempt(db, 2, T0);
    expect(mediaSttForgetsGivenUp(db, { maxAttempts: 5, provider: 'elevenlabs' })).toBe(2);
    expect(mediaSttForgetsGivenUp(db, { maxAttempts: 6, provider: 'elevenlabs' })).toBe(1);
    expect(mediaSttForgetsGivenUp(db, { maxAttempts: 5, provider: 'openai' })).toBe(2);
    expect(mediaSttForgetsGivenUp(db, { maxAttempts: 5, provider: 'none' })).toBe(3);
    // A copy the provider deleted is no longer counted; meeting copies (stt_forget) never are.
    deleteMediaForget(db, 1);
    expect(mediaSttForgetsGivenUp(db, { maxAttempts: 5, provider: 'elevenlabs' })).toBe(1);
  });
});
