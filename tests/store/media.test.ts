import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { syncClients } from '../../src/store/clients.ts';
import { migrate, type Db } from '../../src/store/db.ts';
import {
  claimMedia, deferMedia, dueMediaIds, failMedia, finishMedia, getMedia, getMediaRef, insertMedia, markDownloaded, mediaForMessages, mediaJob, messageRowId,
  type MediaKind, type MediaStatus, type NewMedia, type TextKind,
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
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(7); // the latest migration
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
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(7); // the latest migration
    expect(db.prepare(`SELECT "notnull" AS required, dflt_value AS dflt FROM pragma_table_info('media') WHERE name = 'requeued_for_text'`).get())
      .toEqual({ required: 1, dflt: '0' });
    expect(getMedia(db, 1)).toMatchObject({ status: 'done', text: 'A blue banner', requeuedForText: false });
    expect(db.prepare("SELECT processed_at AS p, version FROM messages WHERE wa_id = 'm1'").get()).toEqual({ p: '2026-10-10T00:05:00Z', version: 0 });
  });

  it('adds version 5 as a new migration after version 4', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
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

  it.each(['voice', 'audio', 'video', 'sticker'] as const)('kind %s: a file that finishes with text re-queues nothing, as a Phase 2b transcript would (M1)', (kind) => {
    const { db, id, messageId } = processedWithFile({ kind, mimeType: null });
    finishMedia(db, id, { textKind: 'extract', text: 'Payment done, please check', pageCount: null, note: null, at: LATER });
    expect(getMedia(db, id)).toMatchObject({ status: 'done', text: 'Payment done, please check' });
    expect(stateOf(db, messageId, id)).toEqual({ processedAt: NOW, version: 0, requeuedForText: false });
    expect(listUnprocessed(db, 1)).toEqual([]);
  });

  it.each(['voice', 'audio'] as const)('kind %s: a file that finishes with text leaves the version of a message never processed alone (M1)', (kind) => {
    const db = seededDb();
    const messageId = message(db, 'A', { mediaType: kind });
    const id = insertMedia(db, media(messageId, { kind, mimeType: null }));
    finishMedia(db, id, { textKind: 'extract', text: 'Payment done', pageCount: null, note: null, at: LATER });
    expect(stateOf(db, messageId, id)).toEqual({ processedAt: null, version: 0, requeuedForText: false });
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
