import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { mediaRefAad, MediaRefSealer } from '../../src/media/ref.ts';
import type { MediaInfo, MediaRef } from '../../src/media/types.ts';
import type { Db } from '../../src/store/db.ts';
import { getMedia, getMediaRef } from '../../src/store/media.ts';
import { manualClock } from '../../src/util/clock.ts';
import { Ingestor, planMedia } from '../../src/wa/ingest.ts';
import { normalizeMessage } from '../../src/wa/normalize.ts';
import { OTHER_GROUP, seededDb } from '../helpers/db.ts';
import { waRaw } from '../helpers/wa.ts';

const MEDIA_KEY = Buffer.alloc(32, 9);
const KEY = randomBytes(32);

const image = (id: string, extra: Record<string, unknown> = {}, group?: string) =>
  normalizeMessage(waRaw(id, { imageMessage: { url: 'https://mmg.whatsapp.net/v/t1', directPath: '/v/t1', mediaKey: MEDIA_KEY, mimetype: 'image/jpeg', ...extra } }, group ? { group } : {}))!;

function setup(withSealer = true) {
  const db = seededDb();
  const onNew = vi.fn();
  const onQueued = vi.fn();
  const sealer = new MediaRefSealer(KEY);
  const seal = vi.spyOn(sealer, 'seal');
  const ing = new Ingestor({ db, onNewMessages: onNew, clock: manualClock('2026-10-19T08:00:00Z'), media: withSealer ? { sealer, onQueued } : undefined });
  return { db, onNew, onQueued, sealer, seal, ing };
}

const mediaIds = (db: Db) => (db.prepare('SELECT id FROM media ORDER BY id').all() as { id: number }[]).map((r) => r.id);
const messageCount = (db: Db) => (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;

describe('Ingestor with shared files', () => {
  it('records a pending image with sealed download details and queues it once', () => {
    const { db, onNew, onQueued, sealer, ing } = setup();
    ing.handle(image('IMG1'));
    ing.handle(image('IMG1'));
    const ids = mediaIds(db);
    expect(ids).toHaveLength(1);
    const row = getMedia(db, ids[0]!)!;
    expect(row).toMatchObject({ clientId: 1, kind: 'image', status: 'pending', mimeType: 'image/jpeg', forwarded: false, hasRef: true, createdAt: '2026-10-19T08:00:00.000Z' });
    expect(sealer.open(getMediaRef(db, row.id)!, mediaRefAad(1, 'IMG1')).mediaKey).toBe(MEDIA_KEY.toString('base64'));
    expect(onQueued).toHaveBeenCalledTimes(1);
    expect(onQueued).toHaveBeenCalledWith(row.id);
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('stores no media key or address in plain text in any column', () => {
    const { db, ing } = setup();
    ing.handle(image('IMG1'));
    const row = db.prepare('SELECT * FROM media').get() as Record<string, unknown>;
    for (const v of Object.values(row)) {
      const s = Buffer.isBuffer(v) ? v.toString('latin1') : String(v);
      expect(s).not.toContain(MEDIA_KEY.toString('base64'));
      expect(s).not.toContain('mmg.whatsapp.net');
      if (Buffer.isBuffer(v)) expect(v.includes(MEDIA_KEY)).toBe(false);
    }
  });

  it('keeps metadata only for videos, stickers and view-once media, and never queues them', () => {
    const { db, onQueued, seal, ing } = setup();
    ing.handle(normalizeMessage(waRaw('V1', { videoMessage: { url: 'u', mediaKey: MEDIA_KEY, seconds: 42, mimetype: 'video/mp4' } }))!);
    ing.handle(normalizeMessage(waRaw('S1', { stickerMessage: { url: 'u', mediaKey: MEDIA_KEY } }))!);
    ing.handle(normalizeMessage(waRaw('O1', { viewOnceMessageV2: { message: { imageMessage: { url: 'u', mediaKey: MEDIA_KEY } } } }))!);
    expect(db.prepare('SELECT kind, status, error_code AS errorCode, seconds, ref_enc AS ref FROM media ORDER BY id').all()).toEqual([
      { kind: 'video', status: 'metadata', errorCode: null, seconds: 42, ref: null },
      { kind: 'sticker', status: 'metadata', errorCode: null, seconds: null, ref: null },
      { kind: 'image', status: 'metadata', errorCode: 'view_once', seconds: null, ref: null },
    ]);
    expect(onQueued).not.toHaveBeenCalled();
    expect(seal).not.toHaveBeenCalled();
  });

  it('marks files it cannot download', () => {
    const { db, ing } = setup();
    ing.handle(image('BIG', { fileLength: 60 * 1024 * 1024 }));
    ing.handle(normalizeMessage(waRaw('NOKEY', { imageMessage: { url: 'u' } }))!);
    expect(db.prepare('SELECT status, error_code AS e FROM media ORDER BY id').all()).toEqual([
      { status: 'unavailable', e: 'too_large' },
      { status: 'unavailable', e: 'no_ref' },
    ]);
  });

  it('refuses download addresses that do not point at WhatsApp, and never seals them (amendment 3a)', () => {
    const { db, onNew, onQueued, seal, ing } = setup();
    ing.handle(normalizeMessage(waRaw('A1', { imageMessage: { url: 'http://192.168.1.1/x', mediaKey: MEDIA_KEY } }))!);
    ing.handle(normalizeMessage(waRaw('A2', { imageMessage: { directPath: '@evil.com/x', mediaKey: MEDIA_KEY } }))!);
    ing.handle(normalizeMessage(waRaw('A3', { documentMessage: { directPath: 'evil.com/x', mediaKey: MEDIA_KEY, fileName: 'a.pdf' } }))!);
    ing.handle(normalizeMessage(waRaw('A4', { audioMessage: { url: 'https://evil.com/x', mediaKey: MEDIA_KEY, ptt: true } }))!);
    // A good url does not make a bad direct path safe: Baileys downloads from the direct path when there is one.
    ing.handle(image('A5', { directPath: '.evil.example/x' }));
    expect(db.prepare('SELECT kind, status, error_code AS e, ref_enc AS r FROM media ORDER BY id').all()).toEqual([
      { kind: 'image', status: 'unavailable', e: 'bad_address', r: null },
      { kind: 'image', status: 'unavailable', e: 'bad_address', r: null },
      { kind: 'document', status: 'unavailable', e: 'bad_address', r: null },
      { kind: 'voice', status: 'unavailable', e: 'bad_address', r: null },
      { kind: 'image', status: 'unavailable', e: 'bad_address', r: null },
    ]);
    expect(seal).not.toHaveBeenCalled();
    expect(onQueued).not.toHaveBeenCalled();
    // The messages themselves are kept.
    expect(messageCount(db)).toBe(5);
    expect(onNew).toHaveBeenCalledTimes(5);
  });

  it('records whether a file was forwarded, and still downloads forwarded files (owner decision D2)', () => {
    const { db, onQueued, ing } = setup();
    ing.handle(image('F1', { contextInfo: { isForwarded: true } }));
    ing.handle(image('F2', { contextInfo: { forwardingScore: 4 } }));
    ing.handle(image('F3'));
    expect(mediaIds(db).map((id) => getMedia(db, id)!).map((r) => [r.forwarded, r.status, r.hasRef])).toEqual([
      [true, 'pending', true],
      [true, 'pending', true],
      [false, 'pending', true],
    ]);
    expect(onQueued).toHaveBeenCalledTimes(3);
  });

  it('without a media pipeline, records the file as not downloaded', () => {
    const { db, ing } = setup(false);
    ing.handle(image('IMG1'));
    expect(db.prepare('SELECT status, error_code AS e, ref_enc AS r FROM media').get()).toEqual({ status: 'unavailable', e: 'not_downloaded', r: null });
  });

  it('stores nothing for a group that is not an active client', () => {
    const { db, onQueued, ing } = setup();
    ing.handle(image('X1', {}, OTHER_GROUP));
    expect(mediaIds(db)).toEqual([]);
    expect(onQueued).not.toHaveBeenCalled();
  });

  it('writes the message and its file row together: when the file row fails, the message is not stored either', () => {
    const { db, onNew, onQueued, ing } = setup();
    db.exec("CREATE TRIGGER block_media BEFORE INSERT ON media BEGIN SELECT RAISE(ABORT, 'blocked'); END");
    expect(() => ing.handle(image('IMG1'))).toThrow('blocked');
    expect(messageCount(db)).toBe(0);
    expect(onNew).not.toHaveBeenCalled();
    expect(onQueued).not.toHaveBeenCalled();
  });

  it('tells the listener about a queued file only after the commit, so a failing listener cannot undo the stored rows', () => {
    const { db, onNew, onQueued, ing } = setup();
    let inTransaction: boolean | undefined;
    onQueued.mockImplementation(() => {
      inTransaction = db.inTransaction;
      throw new Error('listener failed');
    });
    expect(() => ing.handle(image('IMG1'))).toThrow('listener failed');
    expect(inTransaction).toBe(false);
    expect(messageCount(db)).toBe(1);
    expect(getMedia(db, mediaIds(db)[0]!)).toMatchObject({ status: 'pending', hasRef: true });
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('seals only addresses that pass the check: beside a direct path, a url that is not on WhatsApp is dropped, not stored', () => {
    const { db, sealer, ing } = setup();
    ing.handle(image('U1'));
    ing.handle(image('U2', { url: 'https://evil.example/steal' }));
    ing.handle(image('U3', { url: 'https://10.0.0.5:8443/x' }));
    ing.handle(image('U4', { url: `https://mmg.whatsapp.net/${'a'.repeat(3_000)}` }));
    const opened = mediaIds(db).map((id, i) => sealer.open(getMediaRef(db, id)!, mediaRefAad(1, `U${i + 1}`)));
    const mediaKey = MEDIA_KEY.toString('base64');
    expect(opened).toEqual([
      // What WhatsApp sends is kept as it is.
      { contentType: 'imageMessage', url: 'https://mmg.whatsapp.net/v/t1', directPath: '/v/t1', mediaKey },
      { contentType: 'imageMessage', url: null, directPath: '/v/t1', mediaKey },
      { contentType: 'imageMessage', url: null, directPath: '/v/t1', mediaKey },
      { contentType: 'imageMessage', url: null, directPath: '/v/t1', mediaKey },
    ]);
    // The file is still downloaded from the direct path.
    expect(mediaIds(db).map((id) => getMedia(db, id)!.status)).toEqual(['pending', 'pending', 'pending', 'pending']);
  });

  it('refuses an overlong direct path and never seals it', () => {
    const { db, seal, onQueued, ing } = setup();
    ing.handle(image('L1', { directPath: `/${'a'.repeat(10_000)}` }));
    expect(db.prepare('SELECT status, error_code AS e, ref_enc AS r FROM media').get()).toEqual({ status: 'unavailable', e: 'bad_address', r: null });
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
