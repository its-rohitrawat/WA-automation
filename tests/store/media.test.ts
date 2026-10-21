import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { syncClients } from '../../src/store/clients.ts';
import { migrate, type Db } from '../../src/store/db.ts';
import {
  deferMedia, dueMediaIds, failMedia, finishMedia, getMedia, getMediaRef, insertMedia, markDownloaded, mediaForMessages, mediaJob, messageRowId,
  type NewMedia,
} from '../../src/store/media.ts';
import { MIGRATIONS } from '../../src/store/migrations.ts';
import { insertMessage } from '../../src/store/messages.ts';
import { MEHTA, NOW, SHARMA, seededDb } from '../helpers/db.ts';

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
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(4);
    expect((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM media').get() as { n: number }).n).toBe(0);
    expect(db.prepare(`SELECT "notnull" AS required, dflt_value AS dflt FROM pragma_table_info('media') WHERE name = 'forwarded'`).get())
      .toEqual({ required: 1, dflt: '0' });
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
    markDownloaded(db, id, { localPath: 'media/SHA/2026-10/A.jpg', sha256: 'ab'.repeat(32), fileSize: 2048, at: NOW });
    expect(getMediaRef(db, id)).toBeNull();
    expect(getMedia(db, id)).toMatchObject({ status: 'pending', hasRef: false, localPath: 'media/SHA/2026-10/A.jpg', fileSize: 2048 });
    finishMedia(db, id, { textKind: 'description', text: 'A blue banner', pageCount: null, note: null, at: NOW });
    expect(getMedia(db, id)).toMatchObject({ status: 'done', textKind: 'description', text: 'A blue banner', textChars: 13, errorCode: null, nextAttemptAt: null });
  });

  it('a deferral keeps the details; a final failure wipes them', () => {
    const db = seededDb();
    const id = insertMedia(db, media(message(db, 'A')));
    deferMedia(db, id, { errorCode: 'spend_cap', nextAttemptAt: '2026-10-19T08:10:00.000Z', countAttempt: false, at: NOW });
    expect(getMedia(db, id)).toMatchObject({ status: 'pending', errorCode: 'spend_cap', attempts: 0, hasRef: true });
    failMedia(db, id, { status: 'unavailable', errorCode: 'expired', at: NOW });
    expect(getMediaRef(db, id)).toBeNull();
    expect(getMedia(db, id)).toMatchObject({ status: 'unavailable', errorCode: 'expired', nextAttemptAt: null });
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
  });

  it('reads only the start of a long file text for the prompt, with the full length', () => {
    const db = seededDb();
    const m1 = message(db, 'A', { mediaType: 'document' });
    const id = insertMedia(db, pdf(m1));
    finishMedia(db, id, { textKind: 'extract', text: 'x'.repeat(1_000_000), pageCount: 200, note: null, at: NOW });
    const row = mediaForMessages(db, [m1], 20_001).get(m1)!;
    expect(row.text).toHaveLength(20_001);
    expect(row.textChars).toBe(1_000_000);
    expect(getMedia(db, id)!.textChars).toBe(1_000_000);
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

  it('drops NUL characters from stored text, which SQLite would take as the end of the text', () => {
    const db = seededDb();
    const m1 = message(db, 'A', { mediaType: 'document' });
    const id = insertMedia(db, pdf(m1));
    finishMedia(db, id, { textKind: 'extract', text: 'Page 1\u0000Total: 42,000', pageCount: 1, note: null, at: NOW });
    expect(getMedia(db, id)).toMatchObject({ text: 'Page 1Total: 42,000', textChars: 19 });
    expect(mediaForMessages(db, [m1], 100).get(m1)).toMatchObject({ text: 'Page 1Total: 42,000', textChars: 19 });
  });
});
