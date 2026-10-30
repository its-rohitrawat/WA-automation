import { SqliteDb } from '../../src/store/engine/sqlite.ts';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { syncClients } from '../../src/store/clients.ts';
import { migrate, type Db } from '../../src/store/db.ts';
import {
  claimMedia, countMediaForgetAttempt, deferMedia, deleteMediaForget, dueMediaIds, failMedia, finishMedia, getMedia, getMediaRef, insertMedia, markDownloaded,
  failedLocalVoice, mediaForMessages, mediaJob, mediaStats, mediaSttForgetsGivenUp, messageRowId, noteMediaForget, pendingMediaForgets, queueFailedLocalVoice, queueVoiceBacklog, voiceBacklog, type MediaKind, type MediaStatus, type NewMedia, type TextKind,
} from '../../src/store/media.ts';
import { MIGRATIONS } from '../../src/store/migrations.ts';
import { applyRevoke, insertMessage, listUnprocessed, markProcessed, markProcessedIfUnchanged, upsertReaction } from '../../src/store/messages.ts';
import { LATER, MEHTA, NOW, SHARMA, seededDb } from '../helpers/db.ts';

async function message(db: Db, waId: string, o: { clientId?: number; mediaType?: string | null; ts?: string } = {}): Promise<number> {
  const clientId = o.clientId ?? 1;
  await insertMessage(db, {
    waId, clientId, senderJid: '919800000001@s.whatsapp.net', senderNumber: '919800000001', senderName: 'Mr. Sharma', fromMe: false,
    ts: o.ts ?? '2026-10-10T08:00:00.000Z', text: null, quotedWaId: null, mediaType: o.mediaType === undefined ? 'image' : o.mediaType,
  });
  return (await messageRowId(db, clientId, waId))!;
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
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(12); // the latest migration
    expect((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM media').get() as { n: number }).n).toBe(0);
    expect(db.prepare(`SELECT "notnull" AS required, dflt_value AS dflt FROM pragma_table_info('media') WHERE name = 'forwarded'`).get())
      .toEqual({ required: 1, dflt: '0' });
  });

  it('upgrades a version-4 database: its files get requeued_for_text 0 and no message is queued again (12h)', async () => {
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
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(12); // the latest migration
    expect(db.prepare(`SELECT "notnull" AS required, dflt_value AS dflt FROM pragma_table_info('media') WHERE name = 'requeued_for_text'`).get())
      .toEqual({ required: 1, dflt: '0' });
    expect(await getMedia(SqliteDb.wrap(db), 1)).toMatchObject({ status: 'done', text: 'A blue banner', requeuedForText: false });
    expect(db.prepare("SELECT processed_at AS p, version FROM messages WHERE wa_id = 'm1'").get()).toEqual({ p: '2026-10-10T00:05:00Z', version: 0 });
  });

  it('adds version 5 as a new migration after version 4', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(MIGRATIONS[4]!.sql.trim()).toBe('ALTER TABLE media ADD COLUMN requeued_for_text INTEGER NOT NULL DEFAULT 0;');
  });

  it('stores one row per message and reads it back without the sealed details', async () => {
    const db = await seededDb();
    const m1 = await message(db, 'IMG1');
    const id = await insertMedia(db, media(m1));
    const row = (await getMedia(db, id))!;
    expect(row).toMatchObject({
      id, messageId: m1, clientId: 1, kind: 'image', status: 'pending', mimeType: 'image/jpeg', fileSize: 1000, forwarded: false, hasRef: true,
      attempts: 0, localPath: null, text: null, textChars: null, createdAt: NOW, updatedAt: NOW,
    });
    expect(row).not.toHaveProperty('refEnc');
    expect(await getMediaRef(db, id)).toEqual(Buffer.from('sealed'));
    await expect(insertMedia(db, media(m1))).rejects.toThrow(/UNIQUE/);
    // Files that are never downloaded keep the name, length and reason they were recorded with.
    const tooBig = await insertMedia(db, media(await message(db, 'DOC1', { mediaType: 'document' }), {
      kind: 'document', status: 'unavailable', mimeType: 'application/pdf', fileName: 'site plan.pdf', fileSize: 60_000_000, refEnc: null, errorCode: 'too_large',
    }));
    const video = await insertMedia(db, media(await message(db, 'VID1', { mediaType: 'video' }), { kind: 'video', status: 'metadata', mimeType: 'video/mp4', seconds: 42, refEnc: null }));
    expect(await getMedia(db, tooBig)).toMatchObject({
      kind: 'document', status: 'unavailable', fileName: 'site plan.pdf', fileSize: 60_000_000, seconds: null, hasRef: false, errorCode: 'too_large',
    });
    expect(await getMedia(db, video)).toMatchObject({ kind: 'video', status: 'metadata', fileName: null, seconds: 42, hasRef: false, errorCode: null });
  });

  it('refuses a file whose client is not its message\'s client, and stores nothing (T1-09)', async () => {
    const db = await seededDb();
    const sharmaMessage = await message(db, 'A'); // client 1
    await expect(insertMedia(db, media(sharmaMessage, { clientId: 2 }))).rejects.toThrow(/not a message of client 2/);
    await expect(insertMedia(db, media(9999))).rejects.toThrow(/not a message of client 1/); // no such message at all
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM media').get()).toEqual({ n: 0 });
    // The right client still works.
    const id = await insertMedia(db, media(sharmaMessage));
    expect(await getMedia(db, id)).toMatchObject({ messageId: sharmaMessage, clientId: 1 });
  });

  it('refuses an unknown kind, status or text kind', async () => {
    const db = await seededDb();
    await expect(insertMedia(db, media(await message(db, 'K'), { kind: 'gif' as MediaKind }))).rejects.toThrow(/CHECK/);
    await expect(insertMedia(db, media(await message(db, 'S'), { status: 'queued' as MediaStatus }))).rejects.toThrow(/CHECK/);
    const id = await insertMedia(db, media(await message(db, 'T')));
    await expect(finishMedia(db, id, { textKind: 'summary' as TextKind, text: 'x', pageCount: null, note: null, at: NOW })).rejects.toThrow(/CHECK/);
    expect(await getMedia(db, id)).toMatchObject({ status: 'pending', textKind: null });
  });

  it('keeps whether a file was forwarded', async () => {
    const db = await seededDb();
    const f = await message(db, 'FWD');
    const fwd = await insertMedia(db, media(f, { forwarded: true }));
    const own = await insertMedia(db, media(await message(db, 'OWN')));
    expect((await getMedia(db, fwd))!.forwarded).toBe(true);
    expect((await getMedia(db, own))!.forwarded).toBe(false);
    expect((await mediaForMessages(db, [f], 100)).get(f)!.forwarded).toBe(true);
  });

  it('finds the row id of a message', async () => {
    const db = await seededDb();
    const id = await message(db, 'IMG1');
    expect(await messageRowId(db, 1, 'IMG1')).toBe(id);
    expect(await messageRowId(db, 2, 'IMG1')).toBeUndefined();
  });

  it('lists due pending files oldest first, skipping later retries and other statuses', async () => {
    const db = await seededDb();
    const a = await insertMedia(db, media(await message(db, 'A')));
    const b = await insertMedia(db, media(await message(db, 'B')));
    await insertMedia(db, media(await message(db, 'C'), { status: 'metadata', refEnc: null }));
    const d = await insertMedia(db, media(await message(db, 'D')));
    await deferMedia(db, b, { errorCode: 'network', nextAttemptAt: '2026-10-19T08:05:00.000Z', countAttempt: true, at: NOW });
    expect(await dueMediaIds(db, '2026-10-19T08:00:00.000Z', 10)).toEqual([a, d]);
    expect(await dueMediaIds(db, '2026-10-19T08:05:00.000Z', 10)).toEqual([a, b, d]);
    expect(await dueMediaIds(db, '2026-10-19T08:05:00.000Z', 1)).toEqual([a]);
    expect(await getMedia(db, b)).toMatchObject({ attempts: 1, errorCode: 'network', nextAttemptAt: '2026-10-19T08:05:00.000Z' });
  });

  it('lists due files in the order their messages were sent, even when history arrives out of order', async () => {
    const db = await seededDb();
    const late = await insertMedia(db, media(await message(db, 'LATE', { ts: '2026-10-10T09:00:00.000Z' })));
    const early = await insertMedia(db, media(await message(db, 'EARLY', { ts: '2026-10-10T07:00:00.000Z' })));
    const sameTime = await insertMedia(db, media(await message(db, 'SAME', { ts: '2026-10-10T09:00:00.000Z' })));
    expect(await dueMediaIds(db, NOW, 10)).toEqual([early, late, sameTime]);
    expect(await dueMediaIds(db, NOW, 1)).toEqual([early]);
  });

  it('holds back the files of an inactive client until the client is active again', async () => {
    const db = await seededDb();
    const sha = await insertMedia(db, media(await message(db, 'A')));
    const meh = await insertMedia(db, media(await message(db, 'B', { clientId: 2 }), { clientId: 2 }));
    syncClients(db, [SHARMA]); // Mehta's group was taken off the allow-list
    expect(await dueMediaIds(db, NOW, 10)).toEqual([sha]);
    expect(await getMedia(db, meh)).toMatchObject({ status: 'pending', hasRef: true });
    syncClients(db, [SHARMA, MEHTA]);
    expect(await dueMediaIds(db, NOW, 10)).toEqual([sha, meh]);
  });

  it('wipes the sealed details once the original is saved', async () => {
    const db = await seededDb();
    const id = await insertMedia(db, media(await message(db, 'A')));
    await markDownloaded(db, id, { localPath: 'media/SHA/2026-10/A.jpg', sha256: 'ab'.repeat(32), fileSize: 2048, at: LATER });
    expect(await getMediaRef(db, id)).toBeNull();
    expect(await getMedia(db, id)).toMatchObject({
      status: 'pending', hasRef: false, localPath: 'media/SHA/2026-10/A.jpg', sha256: 'ab'.repeat(32), fileSize: 2048, createdAt: NOW, updatedAt: LATER,
    });
    await finishMedia(db, id, { textKind: 'description', text: 'A blue banner', pageCount: null, note: null, at: LATER });
    expect(await getMedia(db, id)).toMatchObject({ status: 'done', textKind: 'description', text: 'A blue banner', textChars: 13, errorCode: null, nextAttemptAt: null });
  });

  it('wipes the sealed details when a file is finished without a saved original', async () => {
    const db = await seededDb();
    const id = await insertMedia(db, media(await message(db, 'A')));
    await finishMedia(db, id, { textKind: null, text: null, pageCount: null, note: null, at: NOW });
    expect(await getMediaRef(db, id)).toBeNull();
    expect(await getMedia(db, id)).toMatchObject({ status: 'done', hasRef: false, localPath: null });
  });

  it('finishing a file clears an earlier deferral', async () => {
    const db = await seededDb();
    const id = await insertMedia(db, media(await message(db, 'A')));
    await deferMedia(db, id, { errorCode: 'spend_cap', nextAttemptAt: '2026-10-19T08:10:00.000Z', countAttempt: false, at: NOW });
    await finishMedia(db, id, { textKind: 'description', text: 'A blue banner', pageCount: null, note: null, at: LATER });
    expect(await getMedia(db, id)).toMatchObject({ status: 'done', errorCode: null, nextAttemptAt: null, updatedAt: LATER });
  });

  it('a deferral keeps the details; a final failure wipes them', async () => {
    const db = await seededDb();
    const id = await insertMedia(db, media(await message(db, 'A')));
    await deferMedia(db, id, { errorCode: 'spend_cap', nextAttemptAt: '2026-10-19T09:10:00.000Z', countAttempt: false, at: LATER });
    expect(await getMedia(db, id)).toMatchObject({ status: 'pending', errorCode: 'spend_cap', attempts: 0, hasRef: true, createdAt: NOW, updatedAt: LATER });
    await failMedia(db, id, { status: 'unavailable', errorCode: 'expired', at: LATER });
    expect(await getMediaRef(db, id)).toBeNull();
    expect(await getMedia(db, id)).toMatchObject({ status: 'unavailable', errorCode: 'expired', nextAttemptAt: null });
  });

  // Final review FR1: the processor claims a file in a committed write before anything is decoded or paid for.
  it('a claim counts the attempt and moves the next attempt ahead, only while the file is pending', async () => {
    const db = await seededDb();
    const id = await insertMedia(db, media(await message(db, 'A')));
    await deferMedia(db, id, { errorCode: 'ai_unavailable', nextAttemptAt: '2026-10-19T08:05:00.000Z', countAttempt: false, at: NOW });
    expect(await claimMedia(db, id, { nextAttemptAt: '2026-10-19T09:15:00.000Z', at: LATER })).toBe(true);
    expect(await getMedia(db, id)).toMatchObject({
      status: 'pending', attempts: 1, nextAttemptAt: '2026-10-19T09:15:00.000Z', errorCode: 'ai_unavailable', hasRef: true, updatedAt: LATER,
    });
    expect(await dueMediaIds(db, '2026-10-19T09:14:59.999Z', 10)).toEqual([]);
    await failMedia(db, id, { status: 'failed', errorCode: 'crashed', at: LATER });
    expect(await claimMedia(db, id, { nextAttemptAt: '2026-10-19T09:30:00.000Z', at: LATER })).toBe(false);
    expect(await getMedia(db, id)).toMatchObject({ status: 'failed', attempts: 1, nextAttemptAt: null });
  });

  it('a deferral can store the attempts exactly, as they were before a claim', async () => {
    const db = await seededDb();
    const id = await insertMedia(db, media(await message(db, 'A')));
    await claimMedia(db, id, { nextAttemptAt: '2026-10-19T08:15:00.000Z', at: NOW });
    await claimMedia(db, id, { nextAttemptAt: '2026-10-19T08:15:00.000Z', at: NOW });
    await deferMedia(db, id, { errorCode: 'spend_cap', nextAttemptAt: '2026-10-19T08:10:00.000Z', attempts: 1, at: NOW });
    expect(await getMedia(db, id)).toMatchObject({ status: 'pending', attempts: 1, errorCode: 'spend_cap', nextAttemptAt: '2026-10-19T08:10:00.000Z' });
    await deferMedia(db, id, { errorCode: 'network', nextAttemptAt: '2026-10-19T08:11:00.000Z', countAttempt: true, at: NOW });
    expect((await getMedia(db, id))!.attempts).toBe(2);
  });

  it('a final failure keeps an original that was already saved', async () => {
    const db = await seededDb();
    const id = await insertMedia(db, pdf(await message(db, 'A', { mediaType: 'document' })));
    await markDownloaded(db, id, { localPath: 'media/SHA/2026-10/A.pdf', sha256: 'cd'.repeat(32), fileSize: 4096, at: NOW });
    await failMedia(db, id, { status: 'failed', errorCode: 'not_pdf', at: LATER });
    expect(await getMediaRef(db, id)).toBeNull();
    expect(await getMedia(db, id)).toMatchObject({
      status: 'failed', errorCode: 'not_pdf', hasRef: false, localPath: 'media/SHA/2026-10/A.pdf', sha256: 'cd'.repeat(32), fileSize: 4096, updatedAt: LATER,
    });
  });

  it('maps files to their messages and gives a job its context', async () => {
    const db = await seededDb();
    const m1 = await message(db, 'A');
    const m2 = await message(db, 'B', { clientId: 2 });
    const t1 = await message(db, 'T', { mediaType: null });
    const id = await insertMedia(db, media(m1));
    await insertMedia(db, media(m2, { clientId: 2 }));
    const map = await mediaForMessages(db, [m1, t1], 100);
    expect([...map.keys()]).toEqual([m1]);
    expect(map.get(m1)!.id).toBe(id);
    expect(await mediaForMessages(db, [], 100)).toEqual(new Map());
    expect(await mediaJob(db, id)).toEqual({ clientId: 1, clientCode: 'SHA', waId: 'A', ts: '2026-10-10T08:00:00.000Z', revoked: false });
    await applyRevoke(db, 1, 'A'); // the sender deleted the message for everyone
    expect((await mediaJob(db, id))!.revoked).toBe(true);
  });

  it('keys files by message row id, which is not the file row id', async () => {
    const db = await seededDb();
    for (const waId of ['T1', 'T2', 'T3']) await message(db, waId, { mediaType: null }); // text messages take the first message row ids
    const mA = await message(db, 'A');
    const mB = await message(db, 'B', { mediaType: 'document' });
    const fileB = await insertMedia(db, pdf(mB)); // B's file is recorded first, so the file row ids run the other way
    const fileA = await insertMedia(db, media(mA));
    const map = await mediaForMessages(db, [mA, mB], 100);
    expect([...map.keys()].sort((x, y) => x - y)).toEqual([mA, mB]);
    expect(map.get(mA)).toMatchObject({ id: fileA, messageId: mA, kind: 'image' });
    expect(map.get(mB)).toMatchObject({ id: fileB, messageId: mB, kind: 'document' });
  });

  it('reads only the start of a long file text for the prompt, with the full length', async () => {
    const db = await seededDb();
    const m1 = await message(db, 'A', { mediaType: 'document' });
    const id = await insertMedia(db, pdf(m1));
    await finishMedia(db, id, { textKind: 'extract', text: 'x'.repeat(1_000_000), pageCount: 250, note: 'first_pages_only', at: NOW });
    const row = (await mediaForMessages(db, [m1], 20_001)).get(m1)!;
    expect(row.text).toHaveLength(20_001);
    expect(row).toMatchObject({ textKind: 'extract', textChars: 1_000_000, pageCount: 250, note: 'first_pages_only' });
    expect(await getMedia(db, id)).toMatchObject({ textChars: 1_000_000, pageCount: 250, note: 'first_pages_only' });
  });

  it('cuts and counts file text by characters, so a cut never splits one', async () => {
    const db = await seededDb();
    const m1 = await message(db, 'A');
    const id = await insertMedia(db, media(m1));
    // The emoji is one character but two UTF-16 code units.
    await finishMedia(db, id, { textKind: 'description', text: 'ab😀cdef', pageCount: null, note: null, at: NOW });
    expect((await mediaForMessages(db, [m1], 4)).get(m1)).toMatchObject({ text: 'ab😀c', textChars: 7 });
    expect((await mediaForMessages(db, [m1], 100)).get(m1)).toMatchObject({ text: 'ab😀cdef', textChars: 7 });
  });

  it('stores NUL characters, which SQLite would take as the end of the text, as spaces so the words around them stay apart', async () => {
    const db = await seededDb();
    const m1 = await message(db, 'A', { mediaType: 'document' });
    const id = await insertMedia(db, pdf(m1));
    await finishMedia(db, id, { textKind: 'extract', text: 'Page 1\u0000Total: 42,000', pageCount: 1, note: null, at: NOW });
    expect(await getMedia(db, id)).toMatchObject({ text: 'Page 1 Total: 42,000', textChars: 20 });
    expect((await mediaForMessages(db, [m1], 100)).get(m1)).toMatchObject({ text: 'Page 1 Total: 42,000', textChars: 20 });
  });
});

describe('a file read after its message was processed (12h)', () => {
  /** A message with a pending file, marked processed at NOW (it went ahead with "still being read"). */
  async function processedWithFile(o: Partial<NewMedia> = {}) {
    const db = await seededDb();
    const messageId = await message(db, 'A', { mediaType: o.kind ?? 'image' });
    const id = await insertMedia(db, media(messageId, o));
    await markProcessed(db, [messageId], NOW);
    return { db, id, messageId };
  }
  const stateOf = async (db: Db, messageId: number, id: number) => ({
    ...(db.raw.prepare('SELECT processed_at AS processedAt, version FROM messages WHERE id = ?').get(messageId) as { processedAt: string | null; version: number }),
    requeuedForText: (await getMedia(db, id))!.requeuedForText,
  });

  it.each([
    { textKind: 'description' as const, text: 'A payment receipt. Visible text: Paid ₹42,000', kind: 'image' as const },
    { textKind: 'extract' as const, text: 'Quotation No. 17\nTotal 42,000', kind: 'document' as const },
  ])('a $textKind read late queues the message again: processed_at cleared, version bumped, file flagged', async ({ textKind, text, kind }) => {
    const { db, id, messageId } = await processedWithFile({ kind, mimeType: kind === 'image' ? 'image/jpeg' : 'application/pdf' });
    expect(await stateOf(db, messageId, id)).toEqual({ processedAt: NOW, version: 0, requeuedForText: false });
    await finishMedia(db, id, { textKind, text, pageCount: null, note: null, at: LATER });
    expect(await stateOf(db, messageId, id)).toEqual({ processedAt: null, version: 1, requeuedForText: true });
    expect(await listUnprocessed(db, 1)).toEqual([expect.objectContaining({ id: messageId, requeueReason: null })]);
    expect(await getMedia(db, id)).toMatchObject({ status: 'done', textKind, text, updatedAt: LATER });
  });

  it('re-queues in the same transaction as the finish: a failed re-queue leaves the file pending', async () => {
    const { db, id, messageId } = await processedWithFile();
    db.raw.exec("CREATE TRIGGER fail_requeue BEFORE UPDATE OF processed_at ON messages BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    await expect(finishMedia(db, id, { textKind: 'description', text: 'A receipt', pageCount: null, note: null, at: LATER })).rejects.toThrow(/test failure/);
    expect(await getMedia(db, id)).toMatchObject({ status: 'pending', text: null, requeuedForText: false });
    expect(await stateOf(db, messageId, id)).toEqual({ processedAt: NOW, version: 0, requeuedForText: false });
  });

  it('flags a message already queued again for a reaction, keeping its reaction marker', async () => {
    const { db, id, messageId } = await processedWithFile();
    await upsertReaction(db, { clientId: 1, targetWaId: 'A', reactorJid: 'r1', emoji: '✅', ts: NOW });
    expect(await stateOf(db, messageId, id)).toEqual({ processedAt: null, version: 1, requeuedForText: false });
    await finishMedia(db, id, { textKind: 'description', text: 'A receipt', pageCount: null, note: null, at: LATER });
    expect(await stateOf(db, messageId, id)).toEqual({ processedAt: null, version: 2, requeuedForText: true });
    expect((await listUnprocessed(db, 1))[0]).toMatchObject({ id: messageId, requeueReason: 'reaction' });
  });

  it('does not flag a message that was never processed; only its version moves, so a run holding it notices', async () => {
    const db = await seededDb();
    const messageId = await message(db, 'A');
    const id = await insertMedia(db, media(messageId));
    await finishMedia(db, id, { textKind: 'description', text: 'A receipt', pageCount: null, note: null, at: LATER });
    expect(await stateOf(db, messageId, id)).toEqual({ processedAt: null, version: 1, requeuedForText: false });
    expect(await listUnprocessed(db, 1)).toEqual([expect.objectContaining({ id: messageId, requeueReason: null })]);
  });

  it.each(['voice', 'audio'] as const)('kind %s: a transcript read late queues the message again, exactly as the description of a picture does (V1)', async (kind) => {
    const { db, id, messageId } = await processedWithFile({ kind, mimeType: 'audio/ogg; codecs=opus' });
    await finishMedia(db, id, { textKind: 'extract', text: 'Payment done, please check', pageCount: null, note: null, at: LATER });
    expect(await getMedia(db, id)).toMatchObject({ status: 'done', textKind: 'extract', text: 'Payment done, please check', backlog: false });
    expect(await stateOf(db, messageId, id)).toEqual({ processedAt: null, version: 1, requeuedForText: true });
    expect(await listUnprocessed(db, 1)).toEqual([expect.objectContaining({ id: messageId, requeueReason: null })]);
  });

  it.each(['video', 'sticker'] as const)('kind %s: a file that finishes with text re-queues nothing (M1)', async (kind) => {
    const { db, id, messageId } = await processedWithFile({ kind, mimeType: null });
    await finishMedia(db, id, { textKind: 'extract', text: 'Payment done, please check', pageCount: null, note: null, at: LATER });
    expect(await getMedia(db, id)).toMatchObject({ status: 'done', text: 'Payment done, please check' });
    expect(await stateOf(db, messageId, id)).toEqual({ processedAt: NOW, version: 0, requeuedForText: false });
    expect(await listUnprocessed(db, 1)).toEqual([]);
  });

  it.each(['voice', 'audio'] as const)('kind %s: a transcript of a message never processed moves only its version, as a picture does (V1)', async (kind) => {
    const db = await seededDb();
    const messageId = await message(db, 'A', { mediaType: kind });
    const id = await insertMedia(db, media(messageId, { kind, mimeType: null }));
    await finishMedia(db, id, { textKind: 'extract', text: 'Payment done', pageCount: null, note: null, at: LATER });
    expect(await stateOf(db, messageId, id)).toEqual({ processedAt: null, version: 1, requeuedForText: false });
  });

  it.each(['voice', 'audio'] as const)('kind %s: a backlog transcript is stored for the record and never queues its message again (V6)', async (kind) => {
    const db = await seededDb();
    const messageId = await message(db, 'A', { mediaType: kind });
    const id = await insertMedia(db, media(messageId, { kind, mimeType: null, refEnc: null }));
    await markDownloaded(db, id, { localPath: 'media/SHA/2026-10/A-1.ogg', sha256: 'x', fileSize: 9000, at: NOW });
    await finishMedia(db, id, { textKind: null, text: null, pageCount: null, note: null, at: NOW }); // the 2a backlog: saved, no transcript
    await markProcessed(db, [messageId], NOW);
    expect(await queueVoiceBacklog(db, [id], LATER)).toBe(1);
    await finishMedia(db, id, { textKind: 'extract', text: 'Payment done, please check', pageCount: null, note: null, at: LATER });
    expect(await getMedia(db, id)).toMatchObject({ status: 'done', textKind: 'extract', text: 'Payment done, please check', backlog: true });
    expect(await stateOf(db, messageId, id)).toEqual({ processedAt: NOW, version: 0, requeuedForText: false });
    expect(await listUnprocessed(db, 1)).toEqual([]);
  });

  it.each([
    { why: 'never processed', after: (_db: Db, _messageId: number) => undefined, state: { processedAt: null, version: 1, requeuedForText: false } },
    {
      why: 'queued again for a reaction',
      after: async (db: Db, messageId: number) => {
        await markProcessed(db, [messageId], NOW);
        await upsertReaction(db, { clientId: 1, targetWaId: 'A', reactorJid: 'r@s.whatsapp.net', emoji: '\u{1F44D}', ts: NOW });
      },
      state: { processedAt: null, version: 2, requeuedForText: true }, // the reaction moved the version once, the transcript once
    },
  ])('a 2a file queued while its message is $why is queued as a live file: its transcript is read with the message (review B)', async ({ after, state }) => {
    const db = await seededDb();
    const messageId = await message(db, 'A', { mediaType: 'voice' });
    const id = await insertMedia(db, media(messageId, { kind: 'voice', mimeType: null, refEnc: null }));
    await markDownloaded(db, id, { localPath: 'media/SHA/2026-10/A-1.ogg', sha256: 'x', fileSize: 9000, at: NOW });
    await finishMedia(db, id, { textKind: null, text: null, pageCount: null, note: null, at: NOW });
    await after(db, messageId);
    expect(await queueVoiceBacklog(db, [id], LATER)).toBe(1);
    expect(await getMedia(db, id)).toMatchObject({ status: 'pending', backlog: false });
    await finishMedia(db, id, { textKind: 'extract', text: 'Payment done, please check', pageCount: null, note: null, at: LATER });
    expect(await stateOf(db, messageId, id)).toEqual(state);
    expect((await listUnprocessed(db, 1)).map((m) => m.id)).toEqual([messageId]);
  });

  it('never re-queues a message deleted for everyone', async () => {
    const { db, id, messageId } = await processedWithFile();
    await applyRevoke(db, 1, 'A');
    await finishMedia(db, id, { textKind: 'description', text: 'A receipt', pageCount: null, note: null, at: LATER });
    expect(await stateOf(db, messageId, id)).toEqual({ processedAt: NOW, version: 0, requeuedForText: false });
    expect(await listUnprocessed(db, 1)).toEqual([]);
  });

  it.each([
    ['could not be read', (db: Db, id: number) => failMedia(db, id, { status: 'failed', errorCode: 'not_pdf', at: LATER })],
    ['too large to download', (db: Db, id: number) => failMedia(db, id, { status: 'unavailable', errorCode: 'too_large', at: LATER })],
    ['forwarded, not described', (db: Db, id: number) => finishMedia(db, id, { textKind: null, text: null, pageCount: null, note: 'forwarded_not_described', at: LATER })],
    ['an image too costly to describe', (db: Db, id: number) => finishMedia(db, id, { textKind: null, text: null, pageCount: null, note: 'too_costly', at: LATER })],
    ['an empty description', (db: Db, id: number) => finishMedia(db, id, { textKind: 'description', text: '', pageCount: null, note: null, at: LATER })],
    ['an extract with no text', (db: Db, id: number) => finishMedia(db, id, { textKind: 'extract', text: null, pageCount: 2, note: null, at: LATER })],
    ['text without a text kind', (db: Db, id: number) => finishMedia(db, id, { textKind: null, text: 'x', pageCount: null, note: null, at: LATER })],
  ])('re-queues nothing when the file ends without text: %s', async (_why, end) => {
    const { db, id, messageId } = await processedWithFile();
    end(db, id);
    expect(await stateOf(db, messageId, id)).toEqual({ processedAt: NOW, version: 0, requeuedForText: false });
    expect(await listUnprocessed(db, 1)).toEqual([]);
  });

  it('a view-once file is never read, so it never re-queues its message', async () => {
    const { db, id, messageId } = await processedWithFile({ status: 'metadata', errorCode: 'view_once', refEnc: null });
    expect(await dueMediaIds(db, LATER, 10)).toEqual([]);
    expect(await stateOf(db, messageId, id)).toEqual({ processedAt: NOW, version: 0, requeuedForText: false });
  });

  it('a second finish of the same file does nothing: the version moves once and the first result stays (12h hardening)', async () => {
    const { db, id, messageId } = await processedWithFile();
    await finishMedia(db, id, { textKind: 'description', text: 'A receipt', pageCount: null, note: null, at: LATER });
    expect(await stateOf(db, messageId, id)).toEqual({ processedAt: null, version: 1, requeuedForText: true });
    await finishMedia(db, id, { textKind: 'extract', text: 'Another text', pageCount: 2, note: 'x', at: '2026-10-19T10:00:00.000Z' });
    expect(await stateOf(db, messageId, id)).toEqual({ processedAt: null, version: 1, requeuedForText: true });
    expect(await getMedia(db, id)).toMatchObject({ status: 'done', textKind: 'description', text: 'A receipt', pageCount: null, note: null, updatedAt: LATER });
  });

  it('a second finish after the re-check was processed queues nothing again (12h hardening)', async () => {
    const { db, id, messageId } = await processedWithFile();
    await finishMedia(db, id, { textKind: 'description', text: 'A receipt', pageCount: null, note: null, at: LATER });
    expect(await markProcessedIfUnchanged(db, [{ id: messageId, version: 1, fileShown: true }], LATER)).toBe(0);
    expect(await stateOf(db, messageId, id)).toEqual({ processedAt: LATER, version: 1, requeuedForText: false });
    await finishMedia(db, id, { textKind: 'description', text: 'A receipt', pageCount: null, note: null, at: '2026-10-19T10:00:00.000Z' });
    expect(await stateOf(db, messageId, id)).toEqual({ processedAt: LATER, version: 1, requeuedForText: false });
    expect(await listUnprocessed(db, 1)).toEqual([]);
  });

  it.each([
    ['only spaces', '   \n\t '],
    ['only NULs', '\u0000\u0000\u0000'],
    ['only zero-width characters', '\u200B\u200C\u200D\u2060\uFEFF'],
    ['spaces, NULs and zero-width characters', ' \u0000\u200B \u200D\u0000 '],
  ])('stores text with nothing visible (%s) as no text, and re-queues nothing (12h hardening)', async (_why, text) => {
    const { db, id, messageId } = await processedWithFile({ kind: 'document', mimeType: 'application/pdf' });
    await finishMedia(db, id, { textKind: 'extract', text, pageCount: 1, note: null, at: LATER });
    expect(await getMedia(db, id)).toMatchObject({ status: 'done', textKind: 'extract', text: null, textChars: null, pageCount: 1 });
    expect(await stateOf(db, messageId, id)).toEqual({ processedAt: NOW, version: 0, requeuedForText: false });
    expect(await listUnprocessed(db, 1)).toEqual([]);
  });

  it('keeps text that shows something next to hidden characters, NULs as spaces (12h hardening)', async () => {
    const { db, id, messageId } = await processedWithFile({ kind: 'document', mimeType: 'application/pdf' });
    await finishMedia(db, id, { textKind: 'extract', text: '\u200B\u0000Total 42,000\u200D', pageCount: 1, note: null, at: LATER });
    expect(await getMedia(db, id)).toMatchObject({ text: '\u200B Total 42,000\u200D' });
    expect(await stateOf(db, messageId, id)).toEqual({ processedAt: null, version: 1, requeuedForText: true });
  });

  it('mediaForMessages carries the flag', async () => {
    const { db, id, messageId } = await processedWithFile();
    expect((await mediaForMessages(db, [messageId], 0)).get(messageId)!.requeuedForText).toBe(false);
    await finishMedia(db, id, { textKind: 'description', text: 'A receipt', pageCount: null, note: null, at: LATER });
    expect((await mediaForMessages(db, [messageId], 0)).get(messageId)).toMatchObject({ id, requeuedForText: true, updatedAt: LATER });
  });
});

/** A voice note (or audio file) saved on disk. Pending: about to be transcribed. */
async function savedVoice(db: Db, waId: string, o: { clientId?: number; kind?: MediaKind; fileSize?: number; mimeType?: string; ts?: string } = {}): Promise<number> {
  const clientId = o.clientId ?? 1;
  const kind = o.kind ?? 'voice';
  const id = await insertMedia(db, media(await message(db, waId, { clientId, mediaType: kind, ts: o.ts }), { clientId, kind, mimeType: o.mimeType ?? 'audio/ogg; codecs=opus' }));
  await markDownloaded(db, id, { localPath: `media/x/2026-10/${waId}-${id}.ogg`, sha256: 'x', fileSize: o.fileSize ?? 9000, at: NOW });
  return id;
}

/** A 2a voice note: saved, finished without a transcript (a claim counted one attempt), and its message processed. */
async function backlogVoice(db: Db, waId: string, o: { clientId?: number; kind?: MediaKind; fileSize?: number; mimeType?: string; note?: string | null } = {}): Promise<number> {
  const id = await savedVoice(db, waId, o);
  await claimMedia(db, id, { nextAttemptAt: LATER, at: NOW });
  await finishMedia(db, id, { textKind: null, text: null, pageCount: null, note: o.note ?? null, at: NOW });
  await markProcessed(db, [(await getMedia(db, id))!.messageId], NOW);
  return id;
}

const TRANSCRIPT = { textKind: 'extract' as const, text: 'Payment done, please check', pageCount: null, note: null, at: LATER };
const forgets = (db: Db) =>
  db.raw.prepare('SELECT media_id AS mediaId, provider, ref, created_at AS createdAt, attempts, next_try_at AS nextTryAt FROM media_stt_forget ORDER BY id').all();

describe('finishMedia: the speech provider\'s stored copy of a transcript (N1)', () => {
  // Task 6: the copy an unreadable answer named (Phase 3's M7), noted by the processor when the error ends a run.
  it('noteMediaForget notes a copy without finishing the file, once per provider and ref', async () => {
    const db = await seededDb();
    const id = await savedVoice(db, 'A');
    await noteMediaForget(db, id, { provider: 'elevenlabs', ref: 'tr_9', at: NOW });
    await noteMediaForget(db, id, { provider: 'elevenlabs', ref: 'tr_9', at: LATER });
    expect(await getMedia(db, id)).toMatchObject({ status: 'pending' });
    expect(forgets(db)).toEqual([{ mediaId: id, provider: 'elevenlabs', ref: 'tr_9', createdAt: NOW, attempts: 0, nextTryAt: null }]);
    await expect(noteMediaForget(db, id, { provider: 'elevenlabs', ref: '', at: NOW })).rejects.toThrow();
  });

  it('notes the copy to delete in the same write as the finish', async () => {
    const db = await seededDb();
    const id = await savedVoice(db, 'A');
    await finishMedia(db, id, { ...TRANSCRIPT, forget: { provider: 'elevenlabs', ref: 'tr_1' } });
    expect(await getMedia(db, id)).toMatchObject({ status: 'done', text: 'Payment done, please check' });
    expect(forgets(db)).toEqual([{ mediaId: id, provider: 'elevenlabs', ref: 'tr_1', createdAt: LATER, attempts: 0, nextTryAt: null }]);
  });

  it('a second finish with the same copy notes nothing more; one with another copy notes it, though its transcript is not stored (review F)', async () => {
    const db = await seededDb();
    const id = await savedVoice(db, 'A');
    await finishMedia(db, id, { ...TRANSCRIPT, forget: { provider: 'elevenlabs', ref: 'tr_1' } });
    await finishMedia(db, id, { ...TRANSCRIPT, forget: { provider: 'elevenlabs', ref: 'tr_1' } });
    expect(forgets(db)).toEqual([expect.objectContaining({ mediaId: id, ref: 'tr_1' })]);
    await finishMedia(db, id, { ...TRANSCRIPT, text: 'Another transcript', forget: { provider: 'elevenlabs', ref: 'tr_2' } });
    expect(forgets(db)).toEqual([expect.objectContaining({ mediaId: id, ref: 'tr_1' }), expect.objectContaining({ mediaId: id, ref: 'tr_2', createdAt: LATER })]);
    expect(await getMedia(db, id)).toMatchObject({ status: 'done', text: 'Payment done, please check' });
  });

  it('a finish of a file that already failed still notes its copy (review F)', async () => {
    const db = await seededDb();
    const id = await savedVoice(db, 'A');
    await failMedia(db, id, { status: 'failed', errorCode: 'stt_failed', at: NOW });
    await finishMedia(db, id, { ...TRANSCRIPT, forget: { provider: 'openai', ref: 'resp_1' } });
    expect(await getMedia(db, id)).toMatchObject({ status: 'failed', text: null });
    expect(forgets(db)).toEqual([expect.objectContaining({ mediaId: id, provider: 'openai', ref: 'resp_1' })]);
  });

  it('notes nothing without a copy', async () => {
    const db = await seededDb();
    await finishMedia(db, await savedVoice(db, 'A'), TRANSCRIPT);
    await finishMedia(db, await savedVoice(db, 'B'), { ...TRANSCRIPT, forget: null });
    expect(forgets(db)).toEqual([]);
  });

  it('a copy that cannot be noted leaves the file pending, so the finish and the note never part', async () => {
    const db = await seededDb();
    const id = await savedVoice(db, 'A');
    await expect(finishMedia(db, id, { ...TRANSCRIPT, forget: { provider: 'elevenlabs', ref: '' } })).rejects.toThrow(/CHECK/);
    expect(await getMedia(db, id)).toMatchObject({ status: 'pending', text: null });
    expect(forgets(db)).toEqual([]);
  });
});

describe('the 2a voice backlog (V6, N2)', () => {
  it('lists saved voice notes and audio files that have no transcript, a format_not_supported note included', async () => {
    const db = await seededDb();
    const voice = await backlogVoice(db, 'V', { fileSize: 12_000 });
    const audio = await backlogVoice(db, 'AU', { kind: 'audio', fileSize: 40_000 });
    const m4a = await backlogVoice(db, 'M4A', { kind: 'audio', mimeType: 'audio/mp4', note: 'format_not_supported' });
    const mehta = await backlogVoice(db, 'MV', { clientId: 2, fileSize: 5_000 });
    const ogg = 'audio/ogg; codecs=opus';
    expect(await voiceBacklog(db)).toEqual([
      { id: voice, clientId: 1, fileSize: 12_000, mimeType: ogg },
      { id: audio, clientId: 1, fileSize: 40_000, mimeType: ogg },
      { id: m4a, clientId: 1, fileSize: 9000, mimeType: 'audio/mp4' },
      { id: mehta, clientId: 2, fileSize: 5_000, mimeType: ogg },
    ]);
    expect(await voiceBacklog(db, { clientId: 2 })).toEqual([{ id: mehta, clientId: 2, fileSize: 5_000, mimeType: ogg }]);
    expect((await voiceBacklog(db, { clientId: 1 })).map((r) => r.id)).toEqual([voice, audio, m4a]);
  });

  it('skips files with another note, with text, without a saved file, with an error, still pending, queued, or of another kind', async () => {
    const db = await seededDb();
    await backlogVoice(db, 'LONG', { note: 'too_long' });
    await backlogVoice(db, 'FWD', { note: 'forwarded_not_transcribed' });
    await backlogVoice(db, 'SILENT', { note: 'no_speech' });
    await finishMedia(db, await savedVoice(db, 'DONE'), TRANSCRIPT);
    const unsaved = await insertMedia(db, media(await message(db, 'NOFILE', { mediaType: 'voice' }), { kind: 'voice', mimeType: 'audio/ogg' }));
    await finishMedia(db, unsaved, { textKind: null, text: null, pageCount: null, note: null, at: NOW });
    const withError = await insertMedia(db, media(await message(db, 'ERR', { mediaType: 'voice' }), { kind: 'voice', status: 'done', errorCode: 'x', refEnc: null }));
    await markDownloaded(db, withError, { localPath: 'media/x/2026-10/ERR.ogg', sha256: 'x', fileSize: 9000, at: NOW });
    await savedVoice(db, 'PENDING');
    const queued = await backlogVoice(db, 'QUEUED');
    await queueVoiceBacklog(db, [queued], LATER); // queued, not finished yet: pending
    const image = await insertMedia(db, media(await message(db, 'IMG')));
    await markDownloaded(db, image, { localPath: 'media/x/2026-10/IMG.jpg', sha256: 'x', fileSize: 9000, at: NOW });
    await finishMedia(db, image, { textKind: null, text: null, pageCount: null, note: null, at: NOW });
    const video = await insertMedia(db, media(await message(db, 'VID', { mediaType: 'video' }), { kind: 'video', status: 'done', refEnc: null }));
    await markDownloaded(db, video, { localPath: 'media/x/2026-10/VID.mp4', sha256: 'x', fileSize: 9000, at: NOW });
    expect(await voiceBacklog(db)).toEqual([]);
  });

  it('skips a message deleted for everyone and a client no longer on the allow-list', async () => {
    const db = await seededDb();
    await backlogVoice(db, 'A');
    await applyRevoke(db, 1, 'A');
    const mehta = await backlogVoice(db, 'B', { clientId: 2 });
    expect(await voiceBacklog(db)).toEqual([{ id: mehta, clientId: 2, fileSize: 9000, mimeType: 'audio/ogg; codecs=opus' }]);
    syncClients(db, [SHARMA]);
    expect(await voiceBacklog(db)).toEqual([]);
    syncClients(db, [SHARMA, MEHTA]);
    expect((await voiceBacklog(db)).map((r) => r.id)).toEqual([mehta]);
  });

  it('queues exactly the given files for transcription as backlog, in one write, and says how many', async () => {
    const db = await seededDb();
    const a = await backlogVoice(db, 'A');
    const b = await backlogVoice(db, 'B', { kind: 'audio', note: 'format_not_supported' });
    const c = await backlogVoice(db, 'C');
    expect(await getMedia(db, a)).toMatchObject({ status: 'done', attempts: 1, backlog: false });
    expect(await queueVoiceBacklog(db, [a, b], LATER)).toBe(2);
    for (const id of [a, b]) {
      expect(await getMedia(db, id)).toMatchObject({ status: 'pending', backlog: true, attempts: 0, nextAttemptAt: null, errorCode: null, updatedAt: LATER });
    }
    expect(await getMedia(db, c)).toMatchObject({ status: 'done', backlog: false, attempts: 1 });
    expect(await dueMediaIds(db, LATER, 10)).toEqual([a, b]);
    expect((await voiceBacklog(db)).map((r) => r.id)).toEqual([c]);
    expect(await queueVoiceBacklog(db, [], LATER)).toBe(0);
  });

  it('leaves alone a file that changed since it was listed, or that never qualified', async () => {
    const db = await seededDb();
    const revoked = await backlogVoice(db, 'A');
    const transcribed = await backlogVoice(db, 'B');
    const fine = await backlogVoice(db, 'C');
    const image = await insertMedia(db, media(await message(db, 'IMG')));
    const listed = (await voiceBacklog(db)).map((r) => r.id);
    expect(listed).toEqual([revoked, transcribed, fine]);
    await applyRevoke(db, 1, 'A');
    db.raw.prepare("UPDATE media SET text_kind = 'extract', text = 'Done' WHERE id = ?").run(transcribed);
    expect(await queueVoiceBacklog(db, [...listed, image, 9999], LATER)).toBe(1);
    expect(await getMedia(db, revoked)).toMatchObject({ status: 'done', backlog: false });
    expect(await getMedia(db, transcribed)).toMatchObject({ status: 'done', backlog: false });
    expect(await getMedia(db, fine)).toMatchObject({ status: 'pending', backlog: true });
    expect(await getMedia(db, image)).toMatchObject({ status: 'pending', backlog: false });
  });

  it('getMedia and mediaForMessages read backlog', async () => {
    const db = await seededDb();
    const id = await backlogVoice(db, 'A');
    const messageId = (await getMedia(db, id))!.messageId;
    expect((await getMedia(db, id))!.backlog).toBe(false);
    expect((await mediaForMessages(db, [messageId], 10)).get(messageId)!.backlog).toBe(false);
    await queueVoiceBacklog(db, [id], LATER);
    expect((await getMedia(db, id))!.backlog).toBe(true);
    expect((await mediaForMessages(db, [messageId], 10)).get(messageId)!.backlog).toBe(true);
  });

  it('a queued file counts its waits from the queueing, not from its arrival days before, and is never stale (review A, round 2)', async () => {
    const db = await seededDb();
    const id = await backlogVoice(db, 'A'); // arrived at NOW
    const queuedAt = '2026-10-22T08:00:00.000Z';
    expect(await queueVoiceBacklog(db, [id], queuedAt)).toBe(1);
    expect(await getMedia(db, id)).toMatchObject({ status: 'pending', createdAt: queuedAt, updatedAt: queuedAt });
    expect(await mediaStats(db, new Date(queuedAt))).toMatchObject({ pending: 1, stale: 0 });
    // A long backlog run is not a fault: the file never counts as waiting too long, however long the queue takes.
    expect(await mediaStats(db, new Date('2026-10-22T08:31:00.000Z'))).toMatchObject({ pending: 1, stale: 0 });
  });

  it('a file that finished format_not_supported after it was queued is listed again, and can be queued again (review C)', async () => {
    const db = await seededDb();
    const id = await backlogVoice(db, 'A', { kind: 'audio', mimeType: 'audio/mp4', note: 'format_not_supported' });
    expect(await queueVoiceBacklog(db, [id], LATER)).toBe(1);
    expect(await getMedia(db, id)).toMatchObject({ status: 'pending', backlog: true, note: null });
    expect(await voiceBacklog(db)).toEqual([]);
    await finishMedia(db, id, { textKind: null, text: null, pageCount: null, note: 'format_not_supported', at: LATER }); // still no ffmpeg
    expect(await voiceBacklog(db)).toEqual([{ id, clientId: 1, fileSize: 9000, mimeType: 'audio/mp4' }]);
    expect(await queueVoiceBacklog(db, [id], '2026-10-19T10:00:00.000Z')).toBe(1);
    expect(await getMedia(db, id)).toMatchObject({ status: 'pending', backlog: true, note: null, createdAt: '2026-10-19T10:00:00.000Z' });
  });

  // Phase 2b final review: a backlog file that finished with no transcriber (voice notes switched off while it waited)
  // has no text and no note. It used to be left out for good (backlog = 1); it is listed again.
  it('round trip: queued, then finished with no transcriber, it is listed again and can be queued again', async () => {
    const db = await seededDb();
    const id = await backlogVoice(db, 'A');
    expect((await voiceBacklog(db)).map((r) => r.id)).toEqual([id]);
    expect(await queueVoiceBacklog(db, [id], LATER)).toBe(1);
    expect(await getMedia(db, id)).toMatchObject({ status: 'pending', backlog: true });
    expect(await voiceBacklog(db)).toEqual([]);
    await finishMedia(db, id, { textKind: null, text: null, pageCount: null, note: null, at: LATER }); // no transcriber: as in 2a
    expect(await getMedia(db, id)).toMatchObject({ status: 'done', backlog: true, text: null, textKind: null, note: null });
    expect(await voiceBacklog(db)).toEqual([{ id, clientId: 1, fileSize: 9000, mimeType: 'audio/ogg; codecs=opus' }]);
    expect(await queueVoiceBacklog(db, [id], '2026-10-19T10:00:00.000Z')).toBe(1);
    expect(await getMedia(db, id)).toMatchObject({ status: 'pending', backlog: true, createdAt: '2026-10-19T10:00:00.000Z' });
  });

  it.each([
    ['transcribed', { textKind: 'extract' as const, text: 'Payment done', note: null }],
    ['transcribed as text that shows nothing (stored as no text)', { textKind: 'extract' as const, text: ' ​ ', note: null }],
    ['too_long', { textKind: null, text: null, note: 'too_long' }],
    ['forwarded', { textKind: null, text: null, note: 'forwarded_not_transcribed' }],
    ['no_speech', { textKind: null, text: null, note: 'no_speech' }],
    ['too_costly', { textKind: null, text: null, note: 'too_costly' }],
    ['revoked', { textKind: null, text: null, note: 'revoked' }],
  ])('a queued backlog file that finished %s is never listed again', async (_what, x) => {
    const db = await seededDb();
    const id = await backlogVoice(db, 'A');
    expect(await queueVoiceBacklog(db, [id], LATER)).toBe(1);
    await finishMedia(db, id, { ...x, pageCount: null, at: LATER });
    expect(await getMedia(db, id)).toMatchObject({ status: 'done', backlog: true });
    expect(await voiceBacklog(db)).toEqual([]);
    expect(await queueVoiceBacklog(db, [id], '2026-10-19T10:00:00.000Z')).toBe(0);
  });

  it('a live file transcribed as text that shows nothing is not listed: it was transcribed', async () => {
    const db = await seededDb();
    const id = await savedVoice(db, 'A');
    await finishMedia(db, id, { ...TRANSCRIPT, text: '   ' });
    expect(await getMedia(db, id)).toMatchObject({ status: 'done', textKind: 'extract', text: null });
    expect(await voiceBacklog(db)).toEqual([]);
  });

  it('lists live pending files before backlog files, so a long backlog never holds up a new voice note (review D)', async () => {
    const db = await seededDb();
    const old1 = await backlogVoice(db, 'OLD1');
    const old2 = await backlogVoice(db, 'OLD2');
    expect(await queueVoiceBacklog(db, [old1, old2], NOW)).toBe(2);
    const live = await savedVoice(db, 'NEW', { ts: '2026-10-19T07:59:00.000Z' }); // sent days after the backlog's messages
    expect(await dueMediaIds(db, LATER, 1)).toEqual([live]);
    expect(await dueMediaIds(db, LATER, 10)).toEqual([live, old1, old2]);
  });

  it('lists only voice notes and audio files, or only the other files, when asked (the voice lane, Task 10)', async () => {
    const db = await seededDb();
    const voice = await savedVoice(db, 'V', { ts: '2026-10-19T07:00:00.000Z' });
    const image = await insertMedia(db, media(await message(db, 'I', { mediaType: 'image', ts: '2026-10-19T07:01:00.000Z' })));
    const audio = await savedVoice(db, 'A', { kind: 'audio', mimeType: 'audio/mpeg', ts: '2026-10-19T07:02:00.000Z' });
    const doc = await insertMedia(db, pdf(await message(db, 'D', { mediaType: 'document', ts: '2026-10-19T07:03:00.000Z' })));
    expect(await dueMediaIds(db, LATER, 10)).toEqual([voice, image, audio, doc]);
    expect(await dueMediaIds(db, LATER, 10, { audio: true })).toEqual([voice, audio]);
    expect(await dueMediaIds(db, LATER, 1, { audio: true })).toEqual([voice]);
    expect(await dueMediaIds(db, LATER, 10, { audio: false })).toEqual([image, doc]);
  });
});

// Phase 2b final review: `cli transcribe-voice --failed`, notes that failed on this computer (the local engine or ffmpeg).
describe('voice notes that failed on this computer', () => {
  /** A saved voice note that failed with errorCode at `at` (its message processed, as the tracker went ahead). */
  async function failedVoice(db: Db, waId: string, errorCode: string, o: { clientId?: number; kind?: MediaKind; at?: string } = {}): Promise<number> {
    const id = await savedVoice(db, waId, o);
    await claimMedia(db, id, { nextAttemptAt: LATER, at: NOW });
    await deferMedia(db, id, { errorCode, nextAttemptAt: LATER, attempts: 2, at: NOW });
    await failMedia(db, id, { status: 'failed', errorCode, at: o.at ?? NOW });
    await markProcessed(db, [(await getMedia(db, id))!.messageId], NOW);
    return id;
  }

  it('lists failures of the local engine and of ffmpeg, never of a paid provider, and only voice notes and audio files', async () => {
    const db = await seededDb();
    const empty = await failedVoice(db, 'A', 'local_empty_output');
    const timeout = await failedVoice(db, 'B', 'local_timeout', { kind: 'audio' });
    const exit = await failedVoice(db, 'C', 'local_exit_1');
    const aborted = await failedVoice(db, 'D', 'local_aborted');
    const convert = await failedVoice(db, 'E', 'audio_convert_failed');
    const duration = await failedVoice(db, 'F', 'audio_no_duration');
    const split = await failedVoice(db, 'G', 'audio_split_failed', { clientId: 2 });
    for (const code of ['stt_partial', 'stt_paid_unbooked', 'stt_job_failed', 'stt_http_500', 'stt_unavailable', 'stt_no_answer_lost', 'audio_no_ffmpeg', 'audio_too_long']) {
      await failedVoice(db, `P-${code}`, code);
    }
    // LIKE's underscore is escaped: 'localX...' and 'local' alone are not local_ codes.
    await failedVoice(db, 'X1', 'localXtimeout');
    await failedVoice(db, 'X2', 'local');
    const image = await insertMedia(db, media(await message(db, 'IMG')));
    await markDownloaded(db, image, { localPath: 'media/x/2026-10/IMG.jpg', sha256: 'x', fileSize: 9000, at: NOW });
    await failMedia(db, image, { status: 'failed', errorCode: 'local_timeout', at: NOW });
    expect((await failedLocalVoice(db)).map((r) => r.id)).toEqual([empty, timeout, exit, aborted, convert, duration, split]);
    expect(await failedLocalVoice(db, { clientId: 2 })).toEqual([{ id: split, clientId: 2, fileSize: 9000, mimeType: 'audio/ogg; codecs=opus' }]);
  });

  it('skips a file without its original, a message deleted for everyone, a client no longer on the allow-list, and a pending or done file', async () => {
    const db = await seededDb();
    const unsaved = await insertMedia(db, media(await message(db, 'NOFILE', { mediaType: 'voice' }), { kind: 'voice', mimeType: 'audio/ogg' }));
    await failMedia(db, unsaved, { status: 'failed', errorCode: 'local_timeout', at: NOW });
    await failedVoice(db, 'REV', 'local_timeout');
    await applyRevoke(db, 1, 'REV');
    const pending = await savedVoice(db, 'PEND');
    await deferMedia(db, pending, { errorCode: 'local_timeout', nextAttemptAt: LATER, attempts: 1, at: NOW });
    const mehta = await failedVoice(db, 'M', 'local_timeout', { clientId: 2 });
    expect((await failedLocalVoice(db)).map((r) => r.id)).toEqual([mehta]);
    syncClients(db, [SHARMA]);
    expect(await failedLocalVoice(db)).toEqual([]);
  });

  it('queues them again as queueVoiceBacklog does: pending, attempts 0, no error, note or next attempt, created now, backlog by the same rule', async () => {
    const db = await seededDb();
    const processed = await failedVoice(db, 'A', 'local_empty_output');
    const unprocessed = await failedVoice(db, 'B', 'audio_convert_failed');
    db.raw.prepare('UPDATE messages SET processed_at = NULL WHERE id = ?').run((await getMedia(db, unprocessed))!.messageId);
    const edited = await failedVoice(db, 'C', 'local_timeout');
    db.raw.prepare("UPDATE messages SET requeue_reason = 'edit' WHERE id = ?").run((await getMedia(db, edited))!.messageId);
    const left = await failedVoice(db, 'D', 'local_timeout');
    db.raw.prepare("UPDATE media SET note = 'x' WHERE id = ?").run(processed); // a stray note is cleared too
    const queuedAt = '2026-10-22T08:00:00.000Z';
    expect(await queueFailedLocalVoice(db, [processed, unprocessed, edited], queuedAt)).toBe(3);
    const fresh = { status: 'pending', attempts: 0, errorCode: null, nextAttemptAt: null, note: null, createdAt: queuedAt, updatedAt: queuedAt };
    expect(await getMedia(db, processed)).toMatchObject({ ...fresh, backlog: true });
    expect(await getMedia(db, unprocessed)).toMatchObject({ ...fresh, backlog: false });
    expect(await getMedia(db, edited)).toMatchObject({ ...fresh, backlog: false });
    expect(await getMedia(db, left)).toMatchObject({ status: 'failed', errorCode: 'local_timeout' });
    expect((await failedLocalVoice(db)).map((r) => r.id)).toEqual([left]);
    expect(await queueFailedLocalVoice(db, [], queuedAt)).toBe(0);
    // A queued file is not stale: its waits count from the queueing.
    expect(await mediaStats(db, new Date('2026-10-22T08:10:00.000Z'))).toMatchObject({ pending: 3, stale: 0 });
  });

  it('never queues a file that failed at a paid provider, or one that changed since it was listed', async () => {
    const db = await seededDb();
    const paid = await failedVoice(db, 'A', 'stt_partial');
    const unbooked = await failedVoice(db, 'B', 'stt_paid_unbooked');
    const changed = await failedVoice(db, 'C', 'local_timeout');
    const fine = await failedVoice(db, 'D', 'local_timeout');
    await applyRevoke(db, 1, 'C');
    const image = await insertMedia(db, media(await message(db, 'IMG')));
    await failMedia(db, image, { status: 'failed', errorCode: 'local_timeout', at: NOW });
    expect(await queueFailedLocalVoice(db, [paid, unbooked, changed, fine, image, 9999], LATER)).toBe(1);
    expect(await getMedia(db, paid)).toMatchObject({ status: 'failed', errorCode: 'stt_partial', attempts: 2 });
    expect(await getMedia(db, unbooked)).toMatchObject({ status: 'failed', errorCode: 'stt_paid_unbooked' });
    expect(await getMedia(db, changed)).toMatchObject({ status: 'failed' });
    expect(await getMedia(db, image)).toMatchObject({ status: 'failed' });
    expect(await getMedia(db, fine)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('mediaStats counts them under voiceFailed for 24 hours, of active clients only, and never a paid failure', async () => {
    const db = await seededDb();
    const now = new Date('2026-10-19T08:00:00.000Z');
    await failedVoice(db, 'A', 'local_empty_output', { at: '2026-10-19T07:00:00.000Z' });
    await failedVoice(db, 'B', 'audio_no_duration', { kind: 'audio', at: '2026-10-18T08:00:00.000Z' }); // exactly 24 h ago: counted
    await failedVoice(db, 'C', 'local_timeout', { at: '2026-10-18T07:59:59.999Z' }); // older: not counted
    await failedVoice(db, 'D', 'stt_partial', { at: '2026-10-19T07:00:00.000Z' });
    await failedVoice(db, 'E', 'localXtimeout', { at: '2026-10-19T07:00:00.000Z' });
    await failedVoice(db, 'F', 'local_exit_1', { clientId: 2, at: '2026-10-19T07:00:00.000Z' });
    const image = await insertMedia(db, media(await message(db, 'IMG')));
    await failMedia(db, image, { status: 'failed', errorCode: 'local_timeout', at: '2026-10-19T07:00:00.000Z' });
    expect(await mediaStats(db, now)).toMatchObject({ voiceFailed: 3, failedRecent: 6 });
    syncClients(db, [SHARMA]);
    expect(await mediaStats(db, now)).toMatchObject({ voiceFailed: 2 });
  });
});

describe('the queue of provider copies to delete (N1)', () => {
  const T0 = '2026-10-19T10:00:00.000Z';
  const T1 = '2026-10-19T10:15:00.000Z';
  /** Three transcribed voice notes, each with a copy to delete (ids 1 to 3 in media_stt_forget). */
  async function threeCopies() {
    const db = await seededDb();
    const ids: number[] = [];
    for (const [i, waId] of ['A', 'B', 'C'].entries()) {
      const id = await savedVoice(db, waId);
      await finishMedia(db, id, { ...TRANSCRIPT, forget: { provider: 'elevenlabs', ref: `tr_${i + 1}` } });
      ids.push(id);
    }
    return { db, ids };
  }

  it('lists the copies due, oldest first, and only one file\'s when asked', async () => {
    const { db, ids } = await threeCopies();
    expect(await pendingMediaForgets(db, { nowIso: T0, maxAttempts: 5 })).toEqual([
      { id: 1, mediaId: ids[0], provider: 'elevenlabs', ref: 'tr_1', attempts: 0 },
      { id: 2, mediaId: ids[1], provider: 'elevenlabs', ref: 'tr_2', attempts: 0 },
      { id: 3, mediaId: ids[2], provider: 'elevenlabs', ref: 'tr_3', attempts: 0 },
    ]);
    expect(await pendingMediaForgets(db, { nowIso: T0, maxAttempts: 5, mediaId: ids[1] })).toEqual([
      { id: 2, mediaId: ids[1], provider: 'elevenlabs', ref: 'tr_2', attempts: 0 },
    ]);
  });

  it('counts a try and holds the copy back until its next try is due', async () => {
    const { db } = await threeCopies();
    await countMediaForgetAttempt(db, 2, T1);
    expect(db.raw.prepare('SELECT attempts, next_try_at AS nextTryAt FROM media_stt_forget WHERE id = 2').get()).toEqual({ attempts: 1, nextTryAt: T1 });
    expect((await pendingMediaForgets(db, { nowIso: T0, maxAttempts: 5 })).map((f) => f.id)).toEqual([1, 3]);
    expect(await pendingMediaForgets(db, { nowIso: T1, maxAttempts: 5 })).toEqual([
      expect.objectContaining({ id: 1 }), expect.objectContaining({ id: 2, attempts: 1 }), expect.objectContaining({ id: 3 }),
    ]);
  });

  it('stops listing a copy once its tries are used up', async () => {
    const { db } = await threeCopies();
    for (let i = 0; i < 5; i++) await countMediaForgetAttempt(db, 1, T0);
    expect((await pendingMediaForgets(db, { nowIso: T1, maxAttempts: 5 })).map((f) => f.id)).toEqual([2, 3]);
    expect((await pendingMediaForgets(db, { nowIso: T1, maxAttempts: 6 })).map((f) => f.id)).toEqual([1, 2, 3]);
  });

  it('removes a copy once the provider has deleted it', async () => {
    const { db } = await threeCopies();
    await deleteMediaForget(db, 2);
    expect((await pendingMediaForgets(db, { nowIso: T0, maxAttempts: 5 })).map((f) => f.id)).toEqual([1, 3]);
    expect(forgets(db)).toHaveLength(2);
  });
  it('counts the copies given up: last try used, or a provider that is not set up now (status, Task 9)', async () => {
    const db = await seededDb();
    const add = async (waId: string, provider: 'elevenlabs' | 'openai', ref: string) => {
      const id = await savedVoice(db, waId);
      await finishMedia(db, id, { ...TRANSCRIPT, forget: { provider, ref } });
    };
    expect(await mediaSttForgetsGivenUp(db, { maxAttempts: 5, provider: 'elevenlabs' })).toBe(0);
    await add('A', 'elevenlabs', 'tr_1'); // last try used
    await add('B', 'elevenlabs', 'tr_2'); // still being tried
    await add('C', 'openai', 'tr_3'); // not the provider set up now
    for (let i = 0; i < 5; i++) await countMediaForgetAttempt(db, 1, T0);
    await countMediaForgetAttempt(db, 2, T0);
    expect(await mediaSttForgetsGivenUp(db, { maxAttempts: 5, provider: 'elevenlabs' })).toBe(2);
    expect(await mediaSttForgetsGivenUp(db, { maxAttempts: 6, provider: 'elevenlabs' })).toBe(1);
    expect(await mediaSttForgetsGivenUp(db, { maxAttempts: 5, provider: 'openai' })).toBe(2);
    expect(await mediaSttForgetsGivenUp(db, { maxAttempts: 5, provider: 'none' })).toBe(3);
    // A copy the provider deleted is no longer counted; meeting copies (stt_forget) never are.
    await deleteMediaForget(db, 1);
    expect(await mediaSttForgetsGivenUp(db, { maxAttempts: 5, provider: 'elevenlabs' })).toBe(1);
  });
});
