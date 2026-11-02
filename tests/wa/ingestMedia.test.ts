import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { mediaRefAad, MediaRefSealer } from '../../src/media/ref.ts';
import type { MediaInfo, MediaRef } from '../../src/media/types.ts';
import type { Db, Sql } from '../../src/store/db.ts';
import { getMedia, getMediaRef } from '../../src/store/media.ts';
import { manualClock } from '../../src/util/clock.ts';
import { Ingestor, planMedia } from '../../src/wa/ingest.ts';
import { normalizeMessage } from '../../src/wa/normalize.ts';
import { OTHER_GROUP, row, rows, seeded } from '../helpers/db.ts';
import { waRaw } from '../helpers/wa.ts';

const MEDIA_KEY = Buffer.alloc(32, 9);
const KEY = randomBytes(32);

const image = (id: string, extra: Record<string, unknown> = {}, group?: string) =>
  normalizeMessage(waRaw(id, { imageMessage: { url: 'https://mmg.whatsapp.net/v/t1', directPath: '/v/t1', mediaKey: MEDIA_KEY, mimetype: 'image/jpeg', ...extra } }, group ? { group } : {}))!;

async function setup(withSealer = true) {
  const { db, ids } = await seeded();
  const onNew = vi.fn();
  const onQueued = vi.fn();
  const sealer = new MediaRefSealer(KEY);
  const seal = vi.spyOn(sealer, 'seal');
  const ing = new Ingestor({ db, onNewMessages: onNew, clock: manualClock('2026-10-19T08:00:00Z'), media: withSealer ? { sealer, onQueued } : undefined });
  return { db, sharma: ids.sharma, onNew, onQueued, sealer, seal, ing };
}

const mediaIds = async (db: Db) => (await rows<{ id: number }>(db, 'SELECT id FROM media ORDER BY id')).map((r) => r.id);
const messageCount = async (db: Db) => (await row<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM messages'))!.n;

/**
 * The same Db, whose transactions refuse every insert into `table`: the database's own failure mid-write, on either
 * engine, with no trigger (a customer's Db on Postgres runs no DDL).
 */
function refusingInsert(db: Db, table: string): Db {
  const into = new RegExp(`INSERT INTO ${table}\\b`);
  const refuse = (q: Sql): Sql => new Proxy(q, {
    get(t, p) {
      if (p === 'run' || p === 'get' || p === 'all') {
        const f = Reflect.get(t, p) as (sql: string, params?: unknown) => Promise<unknown>;
        return (sql: string, params?: unknown) => (into.test(sql) ? Promise.reject(new Error('blocked')) : f.call(t, sql, params));
      }
      const v = Reflect.get(t, p) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  return new Proxy(db, {
    get(t, p) {
      if (p === 'tx') return <T>(fn: (q: Sql) => Promise<T>) => t.tx((q) => fn(refuse(q)));
      const v = Reflect.get(t, p) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

describe('Ingestor with shared files', () => {
  it('records a pending image with sealed download details and queues it once', async () => {
    const { db, sharma, onNew, onQueued, sealer, ing } = await setup();
    await ing.handle(image('IMG1'));
    await ing.handle(image('IMG1'));
    const ids = await mediaIds(db);
    expect(ids).toHaveLength(1);
    const row = (await getMedia(db, ids[0]!))!;
    expect(row).toMatchObject({ clientId: sharma, kind: 'image', status: 'pending', mimeType: 'image/jpeg', forwarded: false, hasRef: true, createdAt: '2026-10-19T08:00:00.000Z' });
    expect(sealer.open((await getMediaRef(db, row.id))!, mediaRefAad(sharma, 'IMG1')).mediaKey).toBe(MEDIA_KEY.toString('base64'));
    expect(onQueued).toHaveBeenCalledTimes(1);
    expect(onQueued).toHaveBeenCalledWith(row.id);
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('stores no media key or address in plain text in any column', async () => {
    const { db, ing } = await setup();
    await ing.handle(image('IMG1'));
    const stored = (await row<Record<string, unknown>>(db, 'SELECT * FROM media'))!;
    for (const v of Object.values(stored)) {
      const s = Buffer.isBuffer(v) ? v.toString('latin1') : String(v);
      expect(s).not.toContain(MEDIA_KEY.toString('base64'));
      expect(s).not.toContain('mmg.whatsapp.net');
      if (Buffer.isBuffer(v)) expect(v.includes(MEDIA_KEY)).toBe(false);
    }
  });

  it('keeps metadata only for videos, stickers and view-once media, and never queues them', async () => {
    const { db, onQueued, seal, ing } = await setup();
    await ing.handle(normalizeMessage(waRaw('V1', { videoMessage: { url: 'u', mediaKey: MEDIA_KEY, seconds: 42, mimetype: 'video/mp4' } }))!);
    await ing.handle(normalizeMessage(waRaw('S1', { stickerMessage: { url: 'u', mediaKey: MEDIA_KEY } }))!);
    await ing.handle(normalizeMessage(waRaw('O1', { viewOnceMessageV2: { message: { imageMessage: { url: 'u', mediaKey: MEDIA_KEY } } } }))!);
    expect(await rows(db, 'SELECT kind, status, error_code AS errorCode, seconds, ref_enc AS ref FROM media ORDER BY id')).toEqual([
      { kind: 'video', status: 'metadata', errorCode: null, seconds: 42, ref: null },
      { kind: 'sticker', status: 'metadata', errorCode: null, seconds: null, ref: null },
      { kind: 'image', status: 'metadata', errorCode: 'view_once', seconds: null, ref: null },
    ]);
    expect(onQueued).not.toHaveBeenCalled();
    expect(seal).not.toHaveBeenCalled();
  });

  it('marks files it cannot download', async () => {
    const { db, ing } = await setup();
    await ing.handle(image('BIG', { fileLength: 60 * 1024 * 1024 }));
    await ing.handle(normalizeMessage(waRaw('NOKEY', { imageMessage: { url: 'u' } }))!);
    expect(await rows(db, 'SELECT status, error_code AS e FROM media ORDER BY id')).toEqual([
      { status: 'unavailable', e: 'too_large' },
      { status: 'unavailable', e: 'no_ref' },
    ]);
  });

  it('refuses download addresses that do not point at WhatsApp, and never seals them (amendment 3a)', async () => {
    const { db, onNew, onQueued, seal, ing } = await setup();
    await ing.handle(normalizeMessage(waRaw('A1', { imageMessage: { url: 'http://192.168.1.1/x', mediaKey: MEDIA_KEY } }))!);
    await ing.handle(normalizeMessage(waRaw('A2', { imageMessage: { directPath: '@evil.com/x', mediaKey: MEDIA_KEY } }))!);
    await ing.handle(normalizeMessage(waRaw('A3', { documentMessage: { directPath: 'evil.com/x', mediaKey: MEDIA_KEY, fileName: 'a.pdf' } }))!);
    await ing.handle(normalizeMessage(waRaw('A4', { audioMessage: { url: 'https://evil.com/x', mediaKey: MEDIA_KEY, ptt: true } }))!);
    // A good url does not make a bad direct path safe: Baileys downloads from the direct path when there is one.
    await ing.handle(image('A5', { directPath: '.evil.example/x' }));
    expect(await rows(db, 'SELECT kind, status, error_code AS e, ref_enc AS r FROM media ORDER BY id')).toEqual([
      { kind: 'image', status: 'unavailable', e: 'bad_address', r: null },
      { kind: 'image', status: 'unavailable', e: 'bad_address', r: null },
      { kind: 'document', status: 'unavailable', e: 'bad_address', r: null },
      { kind: 'voice', status: 'unavailable', e: 'bad_address', r: null },
      { kind: 'image', status: 'unavailable', e: 'bad_address', r: null },
    ]);
    expect(seal).not.toHaveBeenCalled();
    expect(onQueued).not.toHaveBeenCalled();
    // The messages themselves are kept.
    expect((await messageCount(db))).toBe(5);
    expect(onNew).toHaveBeenCalledTimes(5);
  });

  it('records whether a file was forwarded, and still downloads forwarded files (owner decision D2)', async () => {
    const { db, onQueued, ing } = await setup();
    await ing.handle(image('F1', { contextInfo: { isForwarded: true } }));
    await ing.handle(image('F2', { contextInfo: { forwardingScore: 4 } }));
    await ing.handle(image('F3'));
    expect((await Promise.all((await mediaIds(db)).map(async (id) => (await getMedia(db, id))!))).map((r) => [r.forwarded, r.status, r.hasRef])).toEqual([
      [true, 'pending', true],
      [true, 'pending', true],
      [false, 'pending', true],
    ]);
    expect(onQueued).toHaveBeenCalledTimes(3);
  });

  it('without a media pipeline, records the file as not downloaded', async () => {
    const { db, ing } = await setup(false);
    await ing.handle(image('IMG1'));
    expect(await row(db, 'SELECT status, error_code AS e, ref_enc AS r FROM media')).toEqual({ status: 'unavailable', e: 'not_downloaded', r: null });
  });

  it('stores nothing for a group that is not an active client', async () => {
    const { db, onQueued, ing } = await setup();
    await ing.handle(image('X1', {}, OTHER_GROUP));
    expect((await mediaIds(db))).toEqual([]);
    expect(onQueued).not.toHaveBeenCalled();
  });

  it('writes the message and its file row together: when the file row fails, the message is not stored either', async () => {
    const { db: store, onNew, onQueued } = await setup();
    // The same database, refusing the file row's insert inside the ingest's transaction (no trigger: see refusingInsert).
    const db = store;
    const ing = new Ingestor({ db: refusingInsert(store, 'media'), onNewMessages: onNew, clock: manualClock('2026-10-19T08:00:00Z'), media: { sealer: new MediaRefSealer(KEY), onQueued } });
    await expect(ing.handle(image('IMG1'))).rejects.toThrow('blocked');
    expect((await messageCount(db))).toBe(0);
    expect(onNew).not.toHaveBeenCalled();
    expect(onQueued).not.toHaveBeenCalled();
  });

  it('tells the listener about a queued file only after the commit, so a failing listener cannot undo the stored rows', async () => {
    const { db, onNew, onQueued, ing } = await setup();
    // Inside the ingest's transaction a read on the outer handle is refused (TxMisuseError, on either engine); after the
    // commit it sees the stored file row.
    let seen: Promise<unknown> | undefined;
    onQueued.mockImplementation(() => {
      try {
        seen = db.get('SELECT COUNT(*) AS n FROM media');
      } catch (e) {
        seen = Promise.reject(e);
      }
      throw new Error('listener failed');
    });
    await expect(ing.handle(image('IMG1'))).rejects.toThrow('listener failed');
    expect(await seen).toEqual({ n: 1 });
    expect((await messageCount(db))).toBe(1);
    expect(await getMedia(db, (await mediaIds(db))[0]!)).toMatchObject({ status: 'pending', hasRef: true });
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('seals only addresses that pass the check: beside a direct path, a url that is not on WhatsApp is dropped, not stored', async () => {
    const { db, sharma, sealer, ing } = await setup();
    await ing.handle(image('U1'));
    await ing.handle(image('U2', { url: 'https://evil.example/steal' }));
    await ing.handle(image('U3', { url: 'https://10.0.0.5:8443/x' }));
    await ing.handle(image('U4', { url: `https://mmg.whatsapp.net/${'a'.repeat(3_000)}` }));
    const opened = await Promise.all((await mediaIds(db)).map(async (id, i) => sealer.open((await getMediaRef(db, id))!, mediaRefAad(sharma, `U${i + 1}`))));
    const mediaKey = MEDIA_KEY.toString('base64');
    expect(opened).toEqual([
      // What WhatsApp sends is kept as it is.
      { contentType: 'imageMessage', url: 'https://mmg.whatsapp.net/v/t1', directPath: '/v/t1', mediaKey },
      { contentType: 'imageMessage', url: null, directPath: '/v/t1', mediaKey },
      { contentType: 'imageMessage', url: null, directPath: '/v/t1', mediaKey },
      { contentType: 'imageMessage', url: null, directPath: '/v/t1', mediaKey },
    ]);
    // The file is still downloaded from the direct path.
    expect(await Promise.all((await mediaIds(db)).map(async (id) => (await getMedia(db, id))!.status))).toEqual(['pending', 'pending', 'pending', 'pending']);
  });

  it('refuses an overlong direct path and never seals it', async () => {
    const { db, seal, onQueued, ing } = await setup();
    await ing.handle(image('L1', { directPath: `/${'a'.repeat(10_000)}` }));
    expect(await row(db, 'SELECT status, error_code AS e, ref_enc AS r FROM media')).toEqual({ status: 'unavailable', e: 'bad_address', r: null });
    expect(seal).not.toHaveBeenCalled();
    expect(onQueued).not.toHaveBeenCalled();
  });

  it('planMedia decides from the details alone', () => {
    const seal = vi.fn(() => Buffer.from('sealed'));
    const ref: MediaRef = { contentType: 'documentMessage', url: 'https://mmg.whatsapp.net/d/f', directPath: null, mediaKey: 'k' };
    const info: MediaInfo = { kind: 'document', mimeType: 'application/pdf', fileName: 'a.pdf', fileSize: 10, seconds: null, viewOnce: false, forwarded: false, ref };
    expect(planMedia(info, seal)).toEqual({ status: 'pending', errorCode: null, refEnc: Buffer.from('sealed') });
    expect(seal).toHaveBeenCalledWith(info.ref);
    expect(planMedia({ ...info, kind: 'voice' }, null)).toEqual({ status: 'unavailable', errorCode: 'not_downloaded', refEnc: null });
    // Forwarded files are still downloaded (owner decision D2).
    expect(planMedia({ ...info, forwarded: true }, seal)).toMatchObject({ status: 'pending' });
    // An unsafe address is refused with or without a pipeline, and is never sealed.
    seal.mockClear();
    const bad: MediaInfo = { ...info, ref: { ...ref, url: 'https://evil.com/d/f' } };
    expect(planMedia(bad, seal)).toEqual({ status: 'unavailable', errorCode: 'bad_address', refEnc: null });
    expect(planMedia(bad, null)).toEqual({ status: 'unavailable', errorCode: 'bad_address', refEnc: null });
    expect(seal).not.toHaveBeenCalled();
  });

  it('planMedia downloads a file of exactly 50 MiB, and refuses one byte more without sealing it', () => {
    const seal = vi.fn(() => Buffer.from('sealed'));
    const sized = (fileSize: number): MediaInfo => ({
      kind: 'image', mimeType: 'image/jpeg', fileName: null, fileSize, seconds: null, viewOnce: false, forwarded: false,
      ref: { contentType: 'imageMessage', url: null, directPath: '/v/t1', mediaKey: 'k' },
    });
    expect(planMedia(sized(50 * 1024 * 1024), seal)).toEqual({ status: 'pending', errorCode: null, refEnc: Buffer.from('sealed') });
    expect(seal).toHaveBeenCalledTimes(1);
    seal.mockClear();
    expect(planMedia(sized(50 * 1024 * 1024 + 1), seal)).toEqual({ status: 'unavailable', errorCode: 'too_large', refEnc: null });
    expect(seal).not.toHaveBeenCalled();
  });

  it('planMedia keeps a url beside a direct path only when the url is itself on WhatsApp, and keeps a url used alone', () => {
    const seal = vi.fn((_ref: MediaRef) => Buffer.from('sealed'));
    const ref: MediaRef = { contentType: 'imageMessage', url: 'https://mmg.whatsapp.net/v/t1', directPath: '/v/t1', mediaKey: 'k' };
    const info: MediaInfo = { kind: 'image', mimeType: 'image/jpeg', fileName: null, fileSize: 10, seconds: null, viewOnce: false, forwarded: false, ref };
    for (const r of [ref, { ...ref, url: 'https://evil.example/steal' }, { ...ref, url: '' }, { ...ref, directPath: null }, { ...ref, directPath: '' }]) {
      expect(planMedia({ ...info, ref: r }, seal)).toMatchObject({ status: 'pending' });
    }
    expect(seal.mock.calls.map(([sealed]) => sealed)).toEqual([
      ref,
      { ...ref, url: null },
      { ...ref, url: null },
      { ...ref, directPath: null },
      { ...ref, directPath: '' },
    ]);
  });
});
