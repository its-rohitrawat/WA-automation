import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiInvalidOutputError, AiRefusalError } from '../../src/brain/claudeClient.ts';
import { SpendCapReachedError } from '../../src/brain/paidCall.ts';
import { createExtractor, scannedPdfCeilingUsd, type Extraction, type Extractor } from '../../src/media/extract.ts';
import { MediaDownloadError, MediaUnavailableError, type MediaFetcher } from '../../src/media/fetch.ts';
import type { PreparedImage } from '../../src/media/image.ts';
import { ParseError, type ParseResult } from '../../src/media/parse/types.ts';
import { mediaRelPath } from '../../src/media/paths.ts';
import { MEDIA_MAX_ATTEMPTS, MediaProcessor, STT_NO_ANSWER_MAX_ATTEMPTS } from '../../src/media/processor.ts';
import { MediaRefSealer } from '../../src/media/ref.ts';
import { MEDIA_LIMITS } from '../../src/media/types.ts';
import type { Prices } from '../../src/spend/pricing.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { syncClients } from '../../src/store/clients.ts';
import type { Db } from '../../src/store/db.ts';
import { dueMediaIds, getMedia, getMediaRef } from '../../src/store/media.ts';
import { applyRevoke } from '../../src/store/messages.ts';
import { AudioError } from '../../src/stt/audio.ts';
import { SttHttpError, SttJobError, SttJobLostError, SttNoAnswerError } from '../../src/stt/http.ts';
import { LocalEngineError } from '../../src/stt/local.ts';
import { SttBookingError } from '../../src/stt/paidStt.ts';
import { SttPartialError, type VoiceTranscriber } from '../../src/stt/voice.ts';
import { manualClock } from '../../src/util/clock.ts';
import { createLogger, silentLogger, type Logger } from '../../src/util/logger.ts';
import { Ingestor } from '../../src/wa/ingest.ts';
import { normalizeMessage } from '../../src/wa/normalize.ts';
import { MEHTA, SHARMA, seededDb } from '../helpers/db.ts';
import { FakeMediaAi } from '../helpers/mediaAi.ts';
import { FakeLocalVoiceTranscriber, FakeVoiceTranscriber } from '../helpers/voice.ts';
import { TS, waRaw } from '../helpers/wa.ts';

/**
 * Lets a test make the next file write stop part way, as a full disk or a failing drive would, and see when a file is
 * synced to disk. The processor writes an original through a file handle from open().
 */
const disk = vi.hoisted(() => ({ failNextWrite: false, onSync: undefined as (() => void) | undefined }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const fh = await real.open(...args);
      return new Proxy(fh, {
        get(target, prop) {
          if (prop === 'writeFile') {
            return async (data: Buffer) => {
              if (disk.failNextWrite) {
                disk.failNextWrite = false;
                await target.writeFile(data.subarray(0, Math.floor(data.length / 2))); // the file is created and half written, then the write fails
                throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
              }
              return target.writeFile(data);
            };
          }
          if (prop === 'sync') {
            return async () => {
              disk.onSync?.();
              return target.sync();
            };
          }
          const v: unknown = Reflect.get(target, prop, target);
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
    },
  };
});

const MEDIA_KEY = Buffer.alloc(32, 9);
const dirs: string[] = [];
afterEach(() => {
  disk.failNextWrite = false;
  disk.onSync = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type ImageExtras = { viewOnce?: boolean; contextInfo?: { isForwarded?: boolean; forwardingScore?: number } };
type SetupOptions = {
  fetcher?: MediaFetcher;
  extract?: Extractor;
  /** An extractor built on the processor's own database, for example one whose SpendGuard books there. */
  extractFor?: (db: Db) => Extractor;
  log?: Logger;
  limits?: { maxBytes: number; timeoutMs: number };
  startedAt?: Date;
  voice?: VoiceTranscriber | null;
  afterFinish?: (mediaId: number, x: Extraction) => void | Promise<void>;
  voicePaid?: boolean;
};

function setup(o: SetupOptions = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'wa-media-'));
  dirs.push(dataDir);
  const db = seededDb();
  const clock = manualClock('2026-10-19T08:00:00Z');
  const sealer = new MediaRefSealer(Buffer.alloc(32, 5));
  const ing = new Ingestor({ db, onNewMessages: () => {}, clock, media: { sealer } });
  const fetcher = vi.fn<MediaFetcher>(o.fetcher ?? (async () => Buffer.from('jpeg-bytes')));
  const extract = vi.fn<Extractor>(o.extractFor?.(db) ?? o.extract ?? (async () => ({ textKind: 'description', text: 'A blue banner with the new logo', pageCount: null, note: null })));
  const more = { limits: o.limits, startedAt: o.startedAt, voice: o.voice, afterFinish: o.afterFinish, voicePaid: o.voicePaid };
  const p = new MediaProcessor({ db, dataDir, clock, log: o.log ?? silentLogger(), sealer, fetcher, extract, ...more });
  const ingest = (waId: string, message: Parameters<typeof waRaw>[1]): number => {
    ing.handle(normalizeMessage(waRaw(waId, message))!);
    return (db.raw.prepare('SELECT id FROM media ORDER BY id DESC LIMIT 1').get() as { id: number }).id;
  };
  const share = (waId = 'IMG1', extras: ImageExtras = {}): number =>
    ingest(waId, { imageMessage: { url: 'https://mmg.whatsapp.net/v/x', directPath: '/v/x', mediaKey: MEDIA_KEY, mimetype: 'image/jpeg', caption: 'new banner', ...extras } });
  /** A file shared as a document, such as a PDF. */
  const shareFile = (waId: string, mimetype: string, fileName: string): number =>
    ingest(waId, { documentMessage: { url: 'https://mmg.whatsapp.net/v/x', directPath: '/v/x', mediaKey: MEDIA_KEY, mimetype, fileName } });
  /** A WhatsApp voice note (an audioMessage with ptt). */
  const shareVoice = (waId = 'PTT1'): number =>
    ingest(waId, { audioMessage: { url: 'https://mmg.whatsapp.net/v/x', directPath: '/v/x', mediaKey: MEDIA_KEY, mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: 14 } });
  /** An audio file that is not a voice note (an audioMessage without ptt). */
  const shareAudio = (waId = 'AUD1'): number =>
    ingest(waId, { audioMessage: { url: 'https://mmg.whatsapp.net/v/x', directPath: '/v/x', mediaKey: MEDIA_KEY, mimetype: 'audio/mpeg', ptt: false, seconds: 40 } });
  /** A fresh processor on the same database and folder, as after a restart of the service. */
  const restart = (log: Logger = silentLogger()): MediaProcessor => new MediaProcessor({ db, dataDir, clock, log, sealer, fetcher, extract, ...more });
  return { db, dataDir, clock, p, fetcher, extract, share, shareFile, shareVoice, shareAudio, restart };
}

/** From now on the database refuses every update of a file and every spend booking, as on a full disk. Reads still work. */
const refuseWrites = (db: Db): void => {
  db.raw.exec(`CREATE TRIGGER IF NOT EXISTS refuse_media BEFORE UPDATE ON media BEGIN SELECT RAISE(ABORT, 'disk full'); END;
    CREATE TRIGGER IF NOT EXISTS refuse_spend BEFORE INSERT ON spend BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
};

/** Where a shared file is saved, built only by mediaRelPath. waRaw's default timestamp is 10 Oct 2026, so client SHA's 2026-10 folder. */
const rel = (mediaId: number, waId = 'IMG1', ext = 'jpg'): string => mediaRelPath({ clientCode: 'SHA', ts: new Date(TS * 1000).toISOString(), waId, mediaId, ext });
const saved = (dataDir: string, relPath: string): string => join(dataDir, ...relPath.split('/'));

/** Claude errors as the SDK throws them. */
const status = (code: number) => Anthropic.APIError.generate(code, undefined, 'error from the API', new Headers());
const connectionLost = (socketCode: string) =>
  new Anthropic.APIConnectionError({ message: 'Connection error.', cause: Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket'), { code: socketCode }) }) });

const MINUTE = 60_000;
const at = (ms: number) => new Date(Date.parse('2026-10-19T08:00:00Z') + ms).toISOString();

describe('MediaProcessor', () => {
  it('downloads, saves the original under its message and row id, wipes the details and stores the description', async () => {
    const { db, dataDir, p, fetcher, extract, share } = setup();
    const id = share();
    expect(await p.process(id)).toEqual({ outcome: 'done', clientId: 1 });
    expect(fetcher).toHaveBeenCalledWith(
      { contentType: 'imageMessage', url: 'https://mmg.whatsapp.net/v/x', directPath: '/v/x', mediaKey: MEDIA_KEY.toString('base64') },
      { maxBytes: MEDIA_LIMITS.maxDownloadBytes, timeoutMs: MEDIA_LIMITS.downloadTimeoutMs },
    );
    expect(readFileSync(saved(dataDir, rel(id)), 'utf8')).toBe('jpeg-bytes');
    expect(extract).toHaveBeenCalledWith({
      mediaId: id, kind: 'image', mimeType: 'image/jpeg', fileName: null, forwarded: false, bytes: Buffer.from('jpeg-bytes'), path: saved(dataDir, rel(id)),
      revoked: expect.any(Function),
    });
    expect(getMediaRef(db, id)).toBeNull();
    expect(getMedia(db, id)).toMatchObject({ status: 'done', localPath: rel(id), fileSize: 10, textKind: 'description', text: 'A blue banner with the new logo' });
    expect(getMedia(db, id)!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await p.process(id)).toEqual({ outcome: 'skipped', clientId: 1 });
  });

  it('downloads within the limits it was given', async () => {
    const { p, fetcher, share } = setup({ limits: { maxBytes: 1234, timeoutMs: 5678 } });
    await p.process(share());
    expect(fetcher).toHaveBeenCalledWith(expect.anything(), { maxBytes: 1234, timeoutMs: 5678 });
  });

  it('a save that stops part way leaves nothing at the path, and the next attempt saves the whole file', async () => {
    const { db, dataDir, clock, p, fetcher, share } = setup();
    const id = share();
    const folder = dirname(saved(dataDir, rel(id)));
    disk.failNextWrite = true;
    expect((await p.process(id)).outcome).toBe('deferred');
    // A full disk may pass: the file waits without counting an attempt (final review FR2).
    expect(getMedia(db, id)).toMatchObject({ status: 'pending', attempts: 0, errorCode: 'disk_ENOSPC', nextAttemptAt: at(5 * MINUTE), localPath: null, hasRef: true });
    expect(readdirSync(folder)).toEqual([]); // no partial original and no temp file left behind
    clock.advance(5 * MINUTE);
    expect((await p.process(id)).outcome).toBe('done');
    expect(getMedia(db, id)).toMatchObject({ status: 'done', localPath: rel(id), fileSize: 10, errorCode: null });
    expect(readFileSync(saved(dataDir, rel(id)), 'utf8')).toBe('jpeg-bytes');
    expect(readdirSync(folder)).toEqual([basename(saved(dataDir, rel(id)))]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  // Final review FR3b: a power cut after markDownloaded must not leave a zero-filled original whose download details are gone.
  it('syncs the original to disk before it is put in place and its download details are wiped', async () => {
    const { db, dataDir, p, share } = setup();
    const id = share();
    const atSync: { hasRef: boolean; inPlace: boolean }[] = [];
    disk.onSync = () => atSync.push({ hasRef: getMediaRef(db, id) !== null, inPlace: existsSync(saved(dataDir, rel(id))) });
    expect((await p.process(id)).outcome).toBe('done');
    expect(atSync).toEqual([{ hasRef: true, inPlace: false }]);
    expect(getMediaRef(db, id)).toBeNull();
    expect(readFileSync(saved(dataDir, rel(id)), 'utf8')).toBe('jpeg-bytes');
  });

  it('saves under the row id when the message id is unsafe as a file name', async () => {
    const { dataDir, p, share } = setup();
    const id = share('AB:CD');
    await p.process(id);
    expect(rel(id, 'AB:CD')).toMatch(new RegExp(`/m${id}\\.jpg$`));
    expect(existsSync(saved(dataDir, rel(id, 'AB:CD')))).toBe(true);
  });

  it('marks an expired file unavailable and keeps nothing', async () => {
    const { db, dataDir, p, share } = setup({ fetcher: async () => { throw new MediaUnavailableError('expired'); } });
    const id = share();
    expect(await p.process(id)).toEqual({ outcome: 'unavailable', clientId: 1 });
    expect(getMedia(db, id)).toMatchObject({ status: 'unavailable', errorCode: 'expired', hasRef: false, localPath: null });
    expect(existsSync(join(dataDir, 'media'))).toBe(false);
  });

  it('retries a server error from WhatsApp\'s media host after 1 and 5 minutes, then gives up', async () => {
    const { db, clock, p, fetcher, share } = setup({ fetcher: async () => { throw new MediaDownloadError('http_503'); } });
    const id = share();
    expect((await p.process(id)).outcome).toBe('deferred');
    expect(getMedia(db, id)).toMatchObject({ status: 'pending', attempts: 1, errorCode: 'http_503', nextAttemptAt: '2026-10-19T08:01:00.000Z', hasRef: true });
    clock.advance(60_000);
    expect((await p.process(id)).outcome).toBe('deferred');
    expect(getMedia(db, id)).toMatchObject({ attempts: 2, nextAttemptAt: '2026-10-19T08:06:00.000Z' });
    clock.advance(300_000);
    expect((await p.process(id)).outcome).toBe('failed');
    expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: 'http_503', hasRef: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  // Final review FR2: a short internet outage must not lose files still waiting to download. WhatsApp keeps them for
  // weeks, but a final failure wipes the download details, so they could never be fetched again.
  describe('while the internet or the disk is out', () => {
    const locked = () => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    it.each([
      ['no network', () => new MediaDownloadError('network'), 'network'],
      ['a download that times out', () => new MediaDownloadError('timeout'), 'timeout'],
      ['a file locked on disk', locked, 'disk_EBUSY'],
    ])('%s waits 5, 15, 30 and 60 minutes, then hourly, without counting an attempt, and keeps the download details', async (_name, error, code) => {
      const { db, clock, p, fetcher, extract, share } = setup({ fetcher: async () => { throw error(); } });
      const id = share();
      let elapsed = 0;
      for (const wait of [5, 15, 30, 60, 60, 60]) {
        expect(await p.process(id)).toEqual({ outcome: 'deferred', clientId: 1 });
        expect(getMedia(db, id)).toMatchObject({ status: 'pending', attempts: 0, errorCode: code, nextAttemptAt: at(elapsed + wait * MINUTE), hasRef: true, localPath: null });
        elapsed += wait * MINUTE;
        clock.advance(wait * MINUTE);
      }
      expect(fetcher).toHaveBeenCalledTimes(6);
      expect(extract).not.toHaveBeenCalled();
    });

    it('a file still failing to download 24 hours after it arrived fails then, and only then loses its download details', async () => {
      const { db, clock, p, share } = setup({ fetcher: async () => { throw new MediaDownloadError('network'); } });
      const id = share();
      clock.advance(24 * 60 * MINUTE); // exactly 24 hours: still waits
      expect((await p.process(id)).outcome).toBe('deferred');
      expect(getMedia(db, id)).toMatchObject({ status: 'pending', errorCode: 'network', attempts: 0, hasRef: true });
      clock.advance(5 * MINUTE);
      expect(await p.process(id)).toEqual({ outcome: 'failed', clientId: 1 });
      expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: 'network', nextAttemptAt: null, hasRef: false });
    });

    it('counts the 24 hours from the service start for a file saved before it (10f)', async () => {
      const startedAt = new Date(Date.parse('2026-10-19T08:00:00Z') + 3 * 24 * 60 * MINUTE);
      const { db, clock, p, share } = setup({ fetcher: async () => { throw new MediaDownloadError('timeout'); }, startedAt });
      const id = share(); // created 3 days before the start
      clock.set(startedAt.toISOString());
      expect(await p.process(id)).toEqual({ outcome: 'deferred', clientId: 1 });
      clock.advance(24 * 60 * MINUTE + 1);
      expect(await p.process(id)).toEqual({ outcome: 'failed', clientId: 1 });
      expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: 'timeout', hasRef: false });
    });

    it('a 7-minute outage during a backlog loses nothing: every file is read once the line is back', async () => {
      let down = false;
      const { db, clock, p, fetcher, share } = setup({
        fetcher: async () => {
          if (down) throw new MediaDownloadError('network');
          return Buffer.from('jpeg-bytes');
        },
      });
      const ids = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'].map((w) => share(w));
      // As the queue runs: on every 30-second tick, the two oldest due files. The line drops a minute in, for 7 minutes.
      for (let t = 0; t <= 2 * 60 * MINUTE; t += 30_000) {
        down = t >= MINUTE && t < 8 * MINUTE;
        for (const id of dueMediaIds(db, clock.now().toISOString(), 2)) await p.process(id);
        clock.advance(30_000);
      }
      for (const id of ids) expect(getMedia(db, id)).toMatchObject({ status: 'done', text: 'A blue banner with the new logo', hasRef: false });
      expect(fetcher.mock.calls.length).toBeLessThan(30);
    });

    it('a disk error while reading, after the file was saved, still counts an attempt: a read could have been paid for', async () => {
      const { db, p, share } = setup({ extract: async () => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); } });
      const id = share();
      expect((await p.process(id)).outcome).toBe('deferred');
      expect(getMedia(db, id)).toMatchObject({ status: 'pending', attempts: 1, errorCode: 'disk_EBUSY', nextAttemptAt: at(MINUTE) });
    });
  });

  it('waits for the daily budget without counting an attempt, and does not download twice', async () => {
    let capped = true;
    const { db, clock, p, fetcher, share } = setup({
      extract: async () => {
        if (capped) throw new SpendCapReachedError();
        return { textKind: 'description', text: 'A receipt', pageCount: null, note: null };
      },
    });
    const id = share();
    expect((await p.process(id)).outcome).toBe('deferred');
    expect(getMedia(db, id)).toMatchObject({
      status: 'pending', attempts: 0, errorCode: 'spend_cap', nextAttemptAt: '2026-10-19T08:10:00.000Z', localPath: rel(id), hasRef: false,
    });
    capped = false;
    clock.advance(600_000);
    expect((await p.process(id)).outcome).toBe('done');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(getMedia(db, id)).toMatchObject({ status: 'done', text: 'A receipt', errorCode: null });
  });

  // Final review FR3c: only holds of paid calls still in flight are in the way, not the cap itself.
  it('waits 10 minutes as spend_busy, without counting an attempt, when only paid calls in flight hold the budget', async () => {
    let busy = true;
    const { db, clock, p, share } = setup({
      extract: async () => {
        if (busy) throw new SpendCapReachedError({ busy: true });
        return { textKind: 'description', text: 'A receipt', pageCount: null, note: null };
      },
    });
    const id = share();
    expect((await p.process(id)).outcome).toBe('deferred');
    expect(getMedia(db, id)).toMatchObject({ status: 'pending', attempts: 0, errorCode: 'spend_busy', nextAttemptAt: at(10 * MINUTE), localPath: rel(id) });
    busy = false;
    clock.advance(10 * MINUTE);
    expect((await p.process(id)).outcome).toBe('done');
    expect(getMedia(db, id)).toMatchObject({ status: 'done', text: 'A receipt', errorCode: null });
  });

  it('tells a scan in flight holding the budget (spend_busy) from the daily cap (spend_cap), with the real extractor', async () => {
    const P: Prices = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 };
    const ai = new FakeMediaAi();
    let spend!: SpendGuard;
    const prepareImage = async (): Promise<PreparedImage> => ({ data: Buffer.from('small'), mediaType: 'image/jpeg', width: 10, height: 10 });
    const { db, p, share } = setup({
      extractFor: (d) => {
        spend = new SpendGuard({ db: d, clock: manualClock('2026-10-19T08:00:00Z'), capUsd: 15 });
        return createExtractor({ ai, spend, prices: P, prepareImage });
      },
    });
    spend.record('ai', 10.8, 'earlier calls');
    const hold = spend.reserve(scannedPdfCeilingUsd(P)); // a scan being read holds about $4.16
    expect(hold).not.toBeNull();
    const a = share('IMG1');
    expect((await p.process(a)).outcome).toBe('deferred');
    expect(getMedia(db, a)).toMatchObject({ errorCode: 'spend_busy', attempts: 0 });
    spend.settle(hold!, 'ai', 4.15, 'media 99'); // the scan cost about that after all: now the cap itself is in the way
    const b = share('IMG2');
    expect((await p.process(b)).outcome).toBe('deferred');
    expect(getMedia(db, b)).toMatchObject({ errorCode: 'spend_cap', attempts: 0 });
    expect(ai.calls).toEqual([]);
  });

  it('a file it cannot read fails for good but keeps the original', async () => {
    const { db, dataDir, p, share } = setup({ extract: async () => { throw new ParseError('not_pdf'); } });
    const id = share();
    expect((await p.process(id)).outcome).toBe('failed');
    expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: 'not_pdf', localPath: rel(id) });
    expect(existsSync(saved(dataDir, rel(id)))).toBe(true);
  });

  it('does not download a file whose message was deleted for everyone', async () => {
    const { db, p, fetcher, share } = setup();
    const id = share();
    applyRevoke(db, 1, 'IMG1');
    expect((await p.process(id)).outcome).toBe('unavailable');
    expect(getMedia(db, id)).toMatchObject({ errorCode: 'revoked', hasRef: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not read a saved file whose message was deleted for everyone while it waited, but keeps the original', async () => {
    const { db, dataDir, clock, p, fetcher, extract, share } = setup({ extract: async () => { throw new SpendCapReachedError(); } });
    const id = share();
    expect((await p.process(id)).outcome).toBe('deferred');
    applyRevoke(db, 1, 'IMG1');
    clock.advance(10 * MINUTE);
    expect(await p.process(id)).toEqual({ outcome: 'done', clientId: 1 });
    expect(getMedia(db, id)).toMatchObject({ status: 'done', note: 'revoked', text: null, textKind: null, localPath: rel(id) });
    expect(extract).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(existsSync(saved(dataDir, rel(id)))).toBe(true);
  });

  // Final review FR3a: the revoke is read again after the download and just before the paid call.
  describe('a file deleted for everyone while it is downloaded or decoded', () => {
    const P: Prices = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 };

    it('is not read when the delete arrives during its download, but its original is kept', async () => {
      let db!: Db;
      const s = setup({
        fetcher: async () => {
          applyRevoke(db, 1, 'IMG1'); // the client deletes it for everyone while it downloads
          return Buffer.from('jpeg-bytes');
        },
      });
      db = s.db;
      const id = s.share();
      expect(await s.p.process(id)).toEqual({ outcome: 'done', clientId: 1 });
      expect(getMedia(db, id)).toMatchObject({ status: 'done', note: 'revoked', text: null, textKind: null, localPath: rel(id), hasRef: false });
      expect(s.extract).not.toHaveBeenCalled();
      expect(existsSync(saved(s.dataDir, rel(id)))).toBe(true);
    });

    it.each([
      ['an image, while it is decoded', 'image'],
      ['a scanned PDF, while its text layer is checked', 'pdf'],
    ] as const)('%s, is never sent to Claude', async (_name, kind) => {
      const ai = new FakeMediaAi();
      let db!: Db;
      const revoke = (waId: string) => applyRevoke(db, 1, waId);
      const prepareImage = async (): Promise<PreparedImage> => {
        revoke('IMG1');
        return { data: Buffer.from('small'), mediaType: 'image/jpeg', width: 10, height: 10 };
      };
      const parse = async (): Promise<ParseResult> => {
        revoke('DOC1');
        return { text: '', pageCount: 2 };
      };
      let spend!: SpendGuard;
      const s = setup({
        fetcher: async () => (kind === 'pdf' ? Buffer.from('%PDF-1.4 scanned pages') : Buffer.from('jpeg-bytes')),
        extractFor: (d) => {
          spend = new SpendGuard({ db: d, clock: manualClock('2026-10-19T08:00:00Z'), capUsd: 15 });
          return createExtractor({ ai, spend, prices: P, prepareImage, parse });
        },
      });
      db = s.db;
      const id = kind === 'pdf' ? s.shareFile('DOC1', 'application/pdf', 'scan.pdf') : s.share('IMG1');
      expect(await s.p.process(id)).toEqual({ outcome: 'done', clientId: 1 });
      expect(getMedia(db, id)).toMatchObject({ status: 'done', note: 'revoked', text: null, textKind: null, pageCount: null });
      expect(ai.calls).toEqual([]);
      expect(spend.spentToday()).toBe(0);
    });
  });

  it.each([
    ['cannot be opened', 'ref_unreadable', (db: Db, id: number) => {
      const blob = getMediaRef(db, id)!;
      blob.writeUInt8(blob.readUInt8(blob.length - 1) ^ 1, blob.length - 1); // one flipped bit: the seal no longer opens
      db.raw.prepare('UPDATE media SET ref_enc = ? WHERE id = ?').run(blob, id);
    }],
    ['is missing', 'no_ref', (db: Db, id: number) => db.raw.prepare('UPDATE media SET ref_enc = NULL WHERE id = ?').run(id)],
  ])('marks a file unavailable when its download details %s', async (_name, code, spoil) => {
    const { db, p, fetcher, share } = setup();
    const id = share();
    spoil(db, id);
    expect(await p.process(id)).toEqual({ outcome: 'unavailable', clientId: 1 });
    expect(getMedia(db, id)).toMatchObject({ status: 'unavailable', errorCode: code, hasRef: false, localPath: null });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('never overwrites a different file at the same path, but reuses an identical one', async () => {
    const a = setup();
    const idA = a.share();
    mkdirSync(dirname(saved(a.dataDir, rel(idA))), { recursive: true });
    writeFileSync(saved(a.dataDir, rel(idA)), 'other-bytes');
    expect((await a.p.process(idA)).outcome).toBe('failed');
    expect(getMedia(a.db, idA)).toMatchObject({ errorCode: 'path_conflict', localPath: null });
    expect(readFileSync(saved(a.dataDir, rel(idA)), 'utf8')).toBe('other-bytes');

    const b = setup();
    const idB = b.share();
    mkdirSync(dirname(saved(b.dataDir, rel(idB))), { recursive: true });
    writeFileSync(saved(b.dataDir, rel(idB)), 'jpeg-bytes');
    expect((await b.p.process(idB)).outcome).toBe('done');
    expect(getMedia(b.db, idB)).toMatchObject({ status: 'done', localPath: rel(idB) });
  });

  describe('logs ids and codes only: no description, caption, address, key or error text', () => {
    /** Error text that echoes the caption, as an API error could. */
    const ERROR_TEXT = 'the model saw: new banner';
    const fails = (e: () => Error) => async (): Promise<never> => { throw e(); };
    let downloadFailed = false;
    const failsOnce: MediaFetcher = async () => {
      if (!downloadFailed) {
        downloadFailed = true;
        throw new MediaDownloadError('network');
      }
      return Buffer.from('jpeg-bytes');
    };
    const cases: [string, Omit<SetupOptions, 'log'>, number[], string][] = [
      ['a download retried, then read', { fetcher: failsOnce }, [0, MINUTE], 'done'],
      ['an expired file', { fetcher: fails(() => new MediaUnavailableError('expired')) }, [0], 'unavailable'],
      ['a file it cannot read', { extract: fails(() => new ParseError('not_pdf')) }, [0], 'failed'],
      ['a refusal', { extract: fails(() => new AiRefusalError(null, { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 })) }, [0], 'failed'],
      ['the spend cap', { extract: fails(() => new SpendCapReachedError()) }, [0], 'deferred'],
      ['Claude unavailable', { extract: fails(() => Anthropic.APIError.generate(529, undefined, ERROR_TEXT, new Headers())) }, [0], 'deferred'],
      ['Claude unavailable for 24 hours', { extract: fails(() => Anthropic.APIError.generate(529, undefined, ERROR_TEXT, new Headers())) }, [25 * 60 * MINUTE], 'failed'],
      ['the last of 3 attempts', { extract: fails(() => new AiInvalidOutputError(ERROR_TEXT, null)) }, [0, MINUTE, 5 * MINUTE], 'failed'],
    ];
    it.each(cases)('%s', async (_name, o, waits, outcome) => {
      downloadFailed = false;
      const lines: string[] = [];
      const log = createLogger('info', new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } }));
      const { clock, p, share } = setup({ ...o, log });
      const id = share();
      let last = '';
      for (const wait of waits) {
        clock.advance(wait);
        last = (await p.process(id)).outcome;
      }
      expect(last).toBe(outcome);
      const out = lines.join('');
      expect(out).toContain(`"mediaId":${id}`);
      for (const secret of ['A blue banner', 'new banner', ERROR_TEXT, 'mmg.whatsapp.net', '/v/x', MEDIA_KEY.toString('base64')]) expect(out).not.toContain(secret);
      for (const line of lines) {
        const entry = JSON.parse(line) as Record<string, unknown>;
        for (const key of Object.keys(entry)) expect(['level', 'time', 'msg', 'mediaId', 'clientId', 'errorCode', 'attempts', 'waitMinutes', 'err']).toContain(key);
        if (entry.err !== undefined) for (const key of Object.keys(entry.err as object)) expect(['type', 'code', 'stack']).toContain(key);
      }
    });
  });

  // Amendment 10a.
  it('leaves the file of an inactive client pending, untouched, until the client is active again', async () => {
    const { db, p, fetcher, extract, share } = setup();
    const id = share();
    syncClients(db, [MEHTA]); // Sharma is no longer in the allow-list
    expect(await p.process(id)).toEqual({ outcome: 'skipped', clientId: 1 });
    expect(getMedia(db, id)).toMatchObject({ status: 'pending', attempts: 0, errorCode: null, nextAttemptAt: null, hasRef: true, localPath: null });
    expect(fetcher).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();

    syncClients(db, [SHARMA, MEHTA]);
    expect(await p.process(id)).toEqual({ outcome: 'done', clientId: 1 });
  });

  // Amendment 10b.
  it('fails a file whose message is missing instead of leaving it pending', async () => {
    const { db, p, fetcher, share } = setup();
    const id = share();
    db.raw.pragma('foreign_keys = OFF');
    db.raw.prepare("DELETE FROM messages WHERE wa_id = 'IMG1'").run();
    db.raw.pragma('foreign_keys = ON');
    expect(await p.process(id)).toEqual({ outcome: 'failed', clientId: 1 });
    expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: 'no_job', hasRef: false, nextAttemptAt: null });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await p.process(id)).toEqual({ outcome: 'skipped', clientId: 1 });
  });

  // Owner decision D1.
  it('never downloads view-once media', async () => {
    const { db, dataDir, p, fetcher, extract, share } = setup();
    const id = share('VO1', { viewOnce: true });
    expect(getMedia(db, id)).toMatchObject({ status: 'metadata', errorCode: 'view_once', hasRef: false });
    expect(await p.process(id)).toEqual({ outcome: 'skipped', clientId: 1 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
    expect(existsSync(join(dataDir, 'media'))).toBe(false);
  });

  // Owner decision D2.
  it.each([{ isForwarded: true }, { forwardingScore: 3 }])('tells the extractor a file was forwarded (%o)', async (contextInfo) => {
    const { p, extract, share } = setup();
    const id = share('FW1', { contextInfo });
    await p.process(id);
    expect(extract).toHaveBeenCalledWith(expect.objectContaining({ mediaId: id, forwarded: true }));
  });

  it('saves a forwarded image but never sends it to Claude (with the real extractor)', async () => {
    const ai = new FakeMediaAi();
    const db0 = seededDb();
    const spend = new SpendGuard({ db: db0, clock: manualClock('2026-10-19T08:00:00Z'), capUsd: 15 });
    const P: Prices = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 };
    const prepareImage = vi.fn(async (): Promise<PreparedImage> => ({ data: Buffer.from('small'), mediaType: 'image/jpeg', width: 10, height: 10 }));
    const { db, dataDir, p, share } = setup({ extract: createExtractor({ ai, spend, prices: P, prepareImage }) });
    const id = share('FW2', { contextInfo: { isForwarded: true } });
    expect(await p.process(id)).toEqual({ outcome: 'done', clientId: 1 });
    expect(getMedia(db, id)).toMatchObject({ status: 'done', forwarded: true, note: 'forwarded_not_described', text: null, localPath: rel(id, 'FW2') });
    expect(readFileSync(saved(dataDir, rel(id, 'FW2')), 'utf8')).toBe('jpeg-bytes');
    expect(ai.calls).toEqual([]);
    expect(prepareImage).not.toHaveBeenCalled();
    expect(spend.spentToday()).toBe(0);
  });

  // Amendment 10d: errors Claude did not bill (busy, down, or the request never left) do not use up the 3 attempts.
  describe('while Claude is unavailable', () => {
    it.each([
      ['529 overloaded', () => status(529)],
      ['500 server error', () => status(500)],
      ['429 rate limit', () => status(429)],
      // A rejected or revoked key: unbilled, and the owner can fix it, after which the file is still read.
      ['401 rejected key', () => status(401)],
      ['403 permission denied', () => status(403)],
      ['connection refused before sending', () => connectionLost('ECONNREFUSED')],
    ])('a %s waits 5, 15, 30 and 60 minutes, then hourly, without counting an attempt', async (_name, error) => {
      const { db, clock, p, fetcher, extract, share } = setup({ extract: async () => { throw error(); } });
      const id = share();
      let elapsed = 0;
      for (const wait of [5, 15, 30, 60, 60, 60]) {
        expect(await p.process(id)).toEqual({ outcome: 'deferred', clientId: 1 });
        expect(getMedia(db, id)).toMatchObject({ status: 'pending', attempts: 0, errorCode: 'ai_unavailable', nextAttemptAt: at(elapsed + wait * MINUTE), localPath: rel(id) });
        elapsed += wait * MINUTE;
        clock.advance(wait * MINUTE);
      }
      expect(fetcher).toHaveBeenCalledTimes(1); // downloaded once, then read from disk
      expect(extract).toHaveBeenCalledTimes(6);
    });

    it('gives up once the file is more than 24 hours old, and keeps the original', async () => {
      const { db, dataDir, clock, p, share } = setup({ extract: async () => { throw status(529); } });
      const id = share();
      clock.advance(24 * 60 * MINUTE); // exactly 24 hours: still waits
      expect((await p.process(id)).outcome).toBe('deferred');
      expect(getMedia(db, id)).toMatchObject({ status: 'pending', errorCode: 'ai_unavailable', attempts: 0 });
      clock.advance(5 * MINUTE);
      expect(await p.process(id)).toEqual({ outcome: 'failed', clientId: 1 });
      expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: 'ai_unavailable', nextAttemptAt: null, localPath: rel(id) });
      expect(existsSync(saved(dataDir, rel(id)))).toBe(true);
    });

    // Amendment 10f: a file loaded before the service started (cli link) still gets 24 hours, counted from the start.
    it('counts the 24 hours from the service start for a file saved before it', async () => {
      const startedAt = new Date(Date.parse('2026-10-19T08:00:00Z') + 3 * 24 * 60 * MINUTE);
      const { db, clock, p, share } = setup({ extract: async () => { throw status(529); }, startedAt });
      const id = share(); // created 3 days before the start
      clock.set(startedAt.toISOString());
      expect(await p.process(id)).toEqual({ outcome: 'deferred', clientId: 1 });
      expect(getMedia(db, id)).toMatchObject({ status: 'pending', errorCode: 'ai_unavailable', attempts: 0 });
      clock.advance(24 * 60 * MINUTE); // exactly 24 hours after the start: still waits
      expect((await p.process(id)).outcome).toBe('deferred');
      clock.advance(5 * MINUTE);
      expect(await p.process(id)).toEqual({ outcome: 'failed', clientId: 1 });
      expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: 'ai_unavailable', nextAttemptAt: null });
    });

    it('reads the file once Claude is back', async () => {
      let down = true;
      const { db, clock, p, share } = setup({
        extract: async () => {
          if (down) throw status(529);
          return { textKind: 'description', text: 'A receipt', pageCount: null, note: null };
        },
      });
      const id = share();
      expect((await p.process(id)).outcome).toBe('deferred');
      down = false;
      clock.advance(5 * MINUTE);
      expect((await p.process(id)).outcome).toBe('done');
      // The waits counted nothing; the run that read it counts one attempt.
      expect(getMedia(db, id)).toMatchObject({ status: 'done', text: 'A receipt', errorCode: null, attempts: 1 });
    });

    it('starts the waits again at 5 minutes after a different problem', async () => {
      const errors: Error[] = [status(529), status(529), new SpendCapReachedError(), status(529)];
      const { db, clock, p, share } = setup({ extract: async () => { throw errors.shift()!; } });
      const id = share();
      await p.process(id); // 5 minutes
      clock.advance(5 * MINUTE);
      await p.process(id); // 15 minutes
      expect(getMedia(db, id)!.nextAttemptAt).toBe(at(20 * MINUTE));
      clock.advance(15 * MINUTE);
      await p.process(id); // spend cap: 10 minutes
      expect(getMedia(db, id)).toMatchObject({ errorCode: 'spend_cap', nextAttemptAt: at(30 * MINUTE) });
      clock.advance(10 * MINUTE);
      await p.process(id);
      expect(getMedia(db, id)).toMatchObject({ errorCode: 'ai_unavailable', nextAttemptAt: at(35 * MINUTE), attempts: 0 });
    });

    it('books nothing for a 529 from the real extractor', async () => {
      const ai = new FakeMediaAi([status(529)]);
      const db0 = seededDb();
      const spend = new SpendGuard({ db: db0, clock: manualClock('2026-10-19T08:00:00Z'), capUsd: 15 });
      const P: Prices = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 };
      const prepareImage = async (): Promise<PreparedImage> => ({ data: Buffer.from('small'), mediaType: 'image/jpeg', width: 10, height: 10 });
      const { db, p, share } = setup({ extract: createExtractor({ ai, spend, prices: P, prepareImage }) });
      const id = share();
      expect((await p.process(id)).outcome).toBe('deferred');
      expect(getMedia(db, id)).toMatchObject({ errorCode: 'ai_unavailable', attempts: 0 });
      expect(ai.calls).toHaveLength(1);
      expect(spend.spentToday()).toBe(0);
    });
  });

  describe('Claude errors that count an attempt', () => {
    it.each([
      ['400 bad request', () => status(400), 'ai_400'],
      ['404 not found', () => status(404), 'ai_404'],
      ['timeout after sending', () => new Anthropic.APIConnectionTimeoutError(), 'ai_timeout'],
      // A timeout may have been billed whatever its cause says (amendment 10d).
      ['timeout whose cause looks never sent', () => Object.assign(new Anthropic.APIConnectionTimeoutError(), { cause: Object.assign(new Error('socket'), { code: 'ECONNREFUSED' }) }), 'ai_timeout'],
      ['connection reset after sending', () => connectionLost('ECONNRESET'), 'ai_network'],
      ['invalid output', () => new AiInvalidOutputError('bad json', null), 'ai_invalid_output'],
    ])('a %s is retried after 1 minute and counts an attempt', async (_name, error, code) => {
      const { db, p, share } = setup({ extract: async () => { throw error(); } });
      const id = share();
      expect((await p.process(id)).outcome).toBe('deferred');
      expect(getMedia(db, id)).toMatchObject({ status: 'pending', attempts: 1, errorCode: code, nextAttemptAt: at(MINUTE) });
    });
  });

  // Amendment 10e: a failed paid read can be booked at up to its whole estimate, and so can each retry. For a scan that
  // is the scan ceiling (about $4), so a scan is not read again; an image books at most about $0.10 a try, so it keeps
  // its 3 attempts. Only Claude unavailable (10d) and the spend cap still wait.
  describe('a paid read that fails', () => {
    const P: Prices = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 };
    const PDF = Buffer.from('%PDF-1.4 scanned pages');
    /** The real extractor with a fake Claude; the parser finds no text layer, so every PDF is a scan. */
    const realExtractor = (ai: FakeMediaAi) => {
      const spend = new SpendGuard({ db: seededDb(), clock: manualClock('2026-10-19T08:00:00Z'), capUsd: 15 });
      const parse = async (): Promise<ParseResult> => ({ text: '', pageCount: 2 });
      const prepareImage = async (): Promise<PreparedImage> => ({ data: Buffer.from('small'), mediaType: 'image/jpeg', width: 10, height: 10 });
      return { spend, extract: createExtractor({ ai, spend, prices: P, parse, prepareImage }) };
    };
    /** Each is booked at the whole estimate: the outcome is unknown, or invalid output that carries no cost. */
    const failures: [string, () => Error, string][] = [
      ['a timeout', () => new Anthropic.APIConnectionTimeoutError(), 'ai_timeout'],
      ['a connection reset after sending', () => connectionLost('ECONNRESET'), 'ai_network'],
      ['invalid output', () => new AiInvalidOutputError('bad json', null), 'ai_invalid_output'],
      ['an unknown error', () => new Error('something broke'), 'unknown'],
    ];

    it.each(failures)('a scanned PDF whose read ends in %s fails for good: read once and booked once', async (_name, error, code) => {
      const ai = new FakeMediaAi([error()]); // a second read would succeed
      const { spend, extract } = realExtractor(ai);
      const lines: string[] = [];
      const log = createLogger('info', new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } }));
      const { db, dataDir, clock, p, shareFile } = setup({ fetcher: async () => PDF, extract, log });
      const id = shareFile('DOC1', 'application/pdf', 'site-plan-scan.pdf');
      expect(await p.process(id)).toEqual({ outcome: 'failed', clientId: 1 });
      expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: code, attempts: 1, nextAttemptAt: null, localPath: rel(id, 'DOC1', 'pdf') });
      expect(existsSync(saved(dataDir, rel(id, 'DOC1', 'pdf')))).toBe(true);
      clock.advance(10 * MINUTE);
      expect(await p.process(id)).toEqual({ outcome: 'skipped', clientId: 1 });
      expect(ai.calls).toEqual([{ kind: 'pdf', bytes: PDF }]);
      expect(spend.spentToday()).toBeCloseTo(scannedPdfCeilingUsd(P), 9);
      // One warn line with ids and the code only: no file name, no error text.
      expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([{ level: 40, time: expect.any(Number), msg: expect.any(String), mediaId: id, clientId: 1, errorCode: code }]);
      expect(lines.join('')).not.toContain('site-plan-scan');
    });

    const images: [string, (s: ReturnType<typeof setup>) => number][] = [
      ['an image', (s) => s.share()],
      ['an image shared as a document', (s) => s.shareFile('DOC2', 'image/jpeg', 'photo.jpg')],
    ];
    it.each(images.flatMap(([kind, shareIt]) => failures.map(([name, error, code]) => [kind, name, shareIt, error, code] as const)))(
      '%s whose read ends in %s counts an attempt and is read again',
      async (_kind, _name, shareIt, error, code) => {
        const ai = new FakeMediaAi([error()]);
        const s = setup({ extract: realExtractor(ai).extract });
        const id = shareIt(s);
        expect((await s.p.process(id)).outcome).toBe('deferred');
        expect(getMedia(s.db, id)).toMatchObject({ status: 'pending', attempts: 1, errorCode: code, nextAttemptAt: at(MINUTE) });
        s.clock.advance(MINUTE);
        expect((await s.p.process(id)).outcome).toBe('done');
        expect(getMedia(s.db, id)).toMatchObject({ status: 'done', textKind: 'description', errorCode: null });
        expect(ai.calls.map((c) => c.kind)).toEqual(['image', 'image']);
      },
    );

    const files: [string, (s: ReturnType<typeof setup>) => number, 'pdf' | 'image'][] = [
      ['a scanned PDF', (s) => s.shareFile('DOC1', 'application/pdf', 'scan.pdf'), 'pdf'],
      ['an image', (s) => s.share(), 'image'],
    ];
    const unbilled: [string, number][] = [['a 529', 529], ['a 401 (rejected key)', 401], ['a 403 (permission denied)', 403]];
    it.each(files.flatMap(([file, shareIt, kind]) => unbilled.map(([name, code]) => [file, name, shareIt, kind, code] as const)))(
      '%s still waits, unbilled, on %s, and is read once Claude accepts the call',
      async (_file, _name, shareIt, kind, code) => {
        const ai = new FakeMediaAi([status(code)]);
        const { spend, extract } = realExtractor(ai);
        const s = setup({ fetcher: async () => (kind === 'pdf' ? PDF : Buffer.from('jpeg-bytes')), extract });
        const id = shareIt(s);
        expect((await s.p.process(id)).outcome).toBe('deferred');
        expect(getMedia(s.db, id)).toMatchObject({ status: 'pending', errorCode: 'ai_unavailable', attempts: 0, nextAttemptAt: at(5 * MINUTE) });
        expect(spend.spentToday()).toBe(0);
        s.clock.advance(5 * MINUTE);
        expect((await s.p.process(id)).outcome).toBe('done');
        expect(getMedia(s.db, id)).toMatchObject({ status: 'done', errorCode: null, attempts: 1 }); // the wait counted nothing
        expect(ai.calls.map((c) => c.kind)).toEqual([kind, kind]);
      },
    );

    it('a scanned PDF still waits for the daily budget, without calling Claude', async () => {
      const ai = new FakeMediaAi();
      const { spend, extract } = realExtractor(ai);
      spend.record('ai', 12, 'earlier calls'); // the scan ceiling (about $4) no longer fits under the $15 cap
      const { db, p, shareFile } = setup({ fetcher: async () => PDF, extract });
      const id = shareFile('DOC1', 'application/pdf', 'scan.pdf');
      expect((await p.process(id)).outcome).toBe('deferred');
      expect(getMedia(db, id)).toMatchObject({ status: 'pending', errorCode: 'spend_cap', attempts: 0 });
      expect(ai.calls).toEqual([]);
    });
  });

  // Final review FR1: before a file is downloaded, decoded or paid for, the processor claims it in a committed write: the
  // attempt is counted and the next attempt moves 15 minutes ahead. A database that cannot be written then stops the run
  // before anything is paid, and a run that never ends (the process stopped) still uses up one of the file's attempts.
  describe('claims a file before decoding or paying for it (final review FR1)', () => {
    const P: Prices = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 };
    /** The real extractor with a fake Claude; its SpendGuard books in the processor's database. */
    const paid = (ai: FakeMediaAi) => {
      const prepareImage = vi.fn(async (): Promise<PreparedImage> => ({ data: Buffer.from('small'), mediaType: 'image/jpeg', width: 10, height: 10 }));
      const extractFor = (db: Db) => createExtractor({ ai, spend: new SpendGuard({ db, clock: manualClock('2026-10-19T08:00:00Z'), capUsd: 15 }), prices: P, prepareImage });
      return { prepareImage, extractFor };
    };

    it('when the claim cannot be written, nothing is downloaded, decoded or sent to Claude, and the error propagates', async () => {
      const ai = new FakeMediaAi([status(529)]);
      const x = paid(ai);
      const s = setup({ extractFor: x.extractFor });
      const saved = s.share('IMG1');
      expect((await s.p.process(saved)).outcome).toBe('deferred'); // downloaded, then Claude was busy
      const fresh = s.share('IMG2');
      refuseWrites(s.db);
      s.clock.advance(5 * MINUTE);
      await expect(s.p.process(saved)).rejects.toThrow('disk full');
      await expect(s.p.process(fresh)).rejects.toThrow('disk full');
      expect(ai.calls).toHaveLength(1); // the first, busy, call only
      expect(x.prepareImage).toHaveBeenCalledTimes(1);
      expect(s.fetcher).toHaveBeenCalledTimes(1); // IMG2 was never downloaded
      expect(getMedia(s.db, saved)).toMatchObject({ status: 'pending', attempts: 0, errorCode: 'ai_unavailable', nextAttemptAt: at(5 * MINUTE) });
      expect(getMedia(s.db, fresh)).toMatchObject({ status: 'pending', attempts: 0, hasRef: true, localPath: null });
    });

    it('a run that never ends is tried again 15 minutes later, after a restart too; after 3 such runs the file fails as crashed', async () => {
      const lines: string[] = [];
      const log = createLogger('info', new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } }));
      // A decode or read that takes the whole process down never returns.
      const s = setup({ extract: () => new Promise<Extraction>(() => {}) });
      const id = s.share();
      for (let run = 1; run <= MEDIA_MAX_ATTEMPTS; run++) {
        // Each run is a fresh start of the service: nothing about the earlier runs is kept in memory.
        void s.restart().process(id);
        await vi.waitFor(() => expect(s.extract).toHaveBeenCalledTimes(run));
        expect(getMedia(s.db, id)).toMatchObject({ status: 'pending', attempts: run, nextAttemptAt: at(run * 15 * MINUTE), localPath: rel(id) });
        s.clock.advance(15 * MINUTE);
      }
      expect(await s.restart(log).process(id)).toEqual({ outcome: 'failed', clientId: 1 });
      expect(getMedia(s.db, id)).toMatchObject({ status: 'failed', errorCode: 'crashed', attempts: MEDIA_MAX_ATTEMPTS, nextAttemptAt: null, localPath: rel(id) });
      expect(s.extract).toHaveBeenCalledTimes(MEDIA_MAX_ATTEMPTS);
      expect(s.fetcher).toHaveBeenCalledTimes(1);
      expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([
        { level: 40, time: expect.any(Number), msg: expect.any(String), mediaId: id, clientId: 1, errorCode: 'crashed', attempts: MEDIA_MAX_ATTEMPTS },
      ]);
    });

    it('waits that count nothing (Claude unavailable, the spend cap, paid calls in flight) leave the attempts exactly as they were before the claim', async () => {
      const invalid = () => new AiInvalidOutputError('bad json', null);
      const errors: Error[] = [invalid(), status(529), new SpendCapReachedError(), status(401), invalid(), new SpendCapReachedError({ busy: true }), invalid()];
      const { db, clock, p, share } = setup({ extract: async () => { throw errors.shift()!; } });
      const id = share();
      const seen: [string | null, number][] = [];
      while (errors.length > 0) {
        await p.process(id);
        const row = getMedia(db, id)!;
        seen.push([row.errorCode, row.attempts]);
        clock.advance(60 * MINUTE);
      }
      expect(seen).toEqual([
        ['ai_invalid_output', 1], ['ai_unavailable', 1], ['spend_cap', 1], ['ai_unavailable', 1], ['ai_invalid_output', 2], ['spend_busy', 2], ['ai_invalid_output', 3],
      ]);
      expect(getMedia(db, id)!.status).toBe('failed'); // the third counted attempt, not the seventh run
    });
  });

  it('a refusal from Claude fails for good and is not retried: it was billed', async () => {
    const usage = { inputTokens: 1200, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
    const { db, dataDir, clock, p, fetcher, extract, share } = setup({ extract: async () => { throw new AiRefusalError(null, usage); } });
    const id = share();
    expect(await p.process(id)).toEqual({ outcome: 'failed', clientId: 1 });
    expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: 'ai_refusal', attempts: 1, nextAttemptAt: null, localPath: rel(id) });
    expect(existsSync(saved(dataDir, rel(id)))).toBe(true);
    clock.advance(10 * MINUTE);
    expect(await p.process(id)).toEqual({ outcome: 'skipped', clientId: 1 });
    expect(extract).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

// Phase 2b Task 6: how a voice note's speech-to-text errors end. Each is booked already by withSttHold (or freed, for an
// HTTP refusal); the processor only decides whether the file waits, is tried again, or fails.
describe('MediaProcessor: voice notes', () => {
  const VOICE_REL = (id: number) => mediaRelPath({ clientCode: 'SHA', ts: new Date(TS * 1000).toISOString(), waId: 'PTT1', mediaId: id, ext: 'ogg' });
  const throwing = (e: () => unknown): Extractor => async () => {
    throw e();
  };
  const forgetRows = (db: Db) => db.raw.prepare('SELECT media_id AS mediaId, provider, ref, attempts FROM media_stt_forget ORDER BY id').all();
  const TRANSCRIPT: Extraction = { textKind: 'extract', text: 'payment bhej diya', pageCount: null, note: null, forget: { provider: 'elevenlabs', ref: 'tr_1' } };
  /** media_stt_forget refuses every new row from now on, so finishMedia with a forget throws; failMedia still works. */
  const refuseCopies = (db: Db): void => {
    db.raw.exec(`CREATE TRIGGER refuse_forget BEFORE INSERT ON media_stt_forget BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
  };
  /** As src/stt/http.ts throws it with Phase 3's M7: an unreadable answer that still names its copy. */
  const unreadable = (ref: string): SttNoAnswerError => Object.assign(new SttNoAnswerError('unreadable_body'), { forgetRef: ref });
  const P: Prices = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 };
  /** The real extractor over a fake transcriber, booking on its own database. */
  const realExtractor = (v: VoiceTranscriber) => {
    const spend = new SpendGuard({ db: seededDb(), clock: manualClock('2026-10-19T08:00:00Z'), capUsd: 15 });
    return { spend, extract: createExtractor({ ai: new FakeMediaAi(), spend, prices: P, voice: v }) };
  };

  it('passes the saved path to the extractor, after the download and for a file already saved', async () => {
    const errors: unknown[] = [new SttNoAnswerError('timeout')];
    const { dataDir, clock, p, extract, shareVoice } = setup({
      extract: async () => {
        if (errors.length > 0) throw errors.shift();
        return { ...TRANSCRIPT, forget: null };
      },
    });
    const id = shareVoice();
    expect((await p.process(id)).outcome).toBe('deferred');
    clock.advance(MINUTE);
    expect((await p.process(id)).outcome).toBe('done');
    const path = saved(dataDir, VOICE_REL(id));
    expect(extract.mock.calls.map((c) => c[0].path)).toEqual([path, path]);
    // No declared length: the row's seconds is the sender's claim (V5).
    expect(Object.keys(extract.mock.calls[0]![0])).not.toContain('declaredSeconds');
    expect(extract.mock.calls[0]![0]).toMatchObject({ kind: 'voice', mimeType: 'audio/ogg; codecs=opus' });
  });

  describe('a paid voice call left unbooked', () => {
    it('fails at once as stt_paid_unbooked, never retried: a retry would pay again', async () => {
      const v = new FakeVoiceTranscriber({ provider: 'elevenlabs', results: [{ billedSeconds: 12, forgetRef: 'tr_1' }] });
      const { spend, extract } = realExtractor(v);
      vi.spyOn(spend, 'settle').mockImplementation((rid) => {
        spend.release(rid);
        throw new Error('database is locked');
      });
      const { db, clock, p, shareVoice } = setup({ extract });
      const id = shareVoice();
      expect(await p.process(id)).toEqual({ outcome: 'failed', clientId: 1 });
      expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: 'stt_paid_unbooked', attempts: 1, nextAttemptAt: null, localPath: VOICE_REL(id) });
      clock.advance(60 * MINUTE);
      expect(await p.process(id)).toEqual({ outcome: 'skipped', clientId: 1 });
      expect(v.transcribed).toBe(1);
      expect(v.forgotten).toEqual(['tr_1']); // the extractor already deleted the copy
    });

    // Checked before the key rule: the paid error may itself be anything, here an SttHttpError(401) from pricing.
    it('wins over the key-refused rule when the error is itself a 401', async () => {
      class PricingRefused extends FakeVoiceTranscriber {
        override costUsd(): number {
          throw new SttHttpError(401);
        }
      }
      const v = new PricingRefused({ provider: 'elevenlabs' });
      const { db, p, shareVoice } = setup({ extract: realExtractor(v).extract });
      const id = shareVoice();
      expect((await p.process(id)).outcome).toBe('failed');
      expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: 'stt_paid_unbooked', attempts: 1 });
      expect(v.transcribed).toBe(1);
    });

    // Review round 1, 6a: the paid rule is checked before the spend rules too.
    it.each([false, true])('wins over the spend rules when the error is itself a SpendCapReachedError (busy: %s)', async (busy) => {
      class PricingCapped extends FakeVoiceTranscriber {
        override costUsd(): number {
          throw new SpendCapReachedError({ busy });
        }
      }
      const v = new PricingCapped({ provider: 'elevenlabs' });
      const { db, p, shareVoice } = setup({ extract: realExtractor(v).extract });
      const id = shareVoice();
      expect((await p.process(id)).outcome).toBe('failed');
      expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: 'stt_paid_unbooked', attempts: 1, nextAttemptAt: null });
      expect(v.transcribed).toBe(1);
    });

    // Review round 1, fix 1: the call failed in a way that may have been billed, then its booking failed.
    it.each([
      ['no answer', () => new SttNoAnswerError('timeout')],
      ['a failed job', () => new SttJobError('failed')],
      ['a later part failing', () => new SttPartialError(1, 2, new SttHttpError(500))],
    ])('a booking that failed after %s is booked late and fails at once', async (_name, error) => {
      const v = new FakeVoiceTranscriber({ provider: 'elevenlabs', results: [error(), error()] });
      const { spend, extract } = realExtractor(v);
      vi.spyOn(spend, 'settle').mockImplementationOnce((rid) => {
        spend.release(rid);
        throw new Error('database is locked');
      });
      const record = vi.spyOn(spend, 'record');
      const { db, clock, p, shareVoice } = setup({ extract });
      const id = shareVoice();
      expect(await p.process(id)).toEqual({ outcome: 'failed', clientId: 1 });
      expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: 'stt_paid_unbooked', attempts: 1, nextAttemptAt: null });
      expect(record).toHaveBeenCalledExactlyOnceWith('stt', v.ceilingUsd(50), `media ${id} (booked late)`);
      clock.advance(60 * MINUTE);
      expect((await p.process(id)).outcome).toBe('skipped');
      expect(v.transcribed).toBe(1);
    });

    it('a booking that failed after a refused key (401) is unchanged: never billed, it waits as stt_unavailable', async () => {
      const v = new FakeVoiceTranscriber({ provider: 'elevenlabs', results: [new SttHttpError(401)] });
      const { spend, extract } = realExtractor(v);
      vi.spyOn(spend, 'release').mockImplementationOnce(() => {
        throw new Error('database is locked');
      });
      const record = vi.spyOn(spend, 'record');
      const { db, p, shareVoice } = setup({ extract });
      const id = shareVoice();
      expect((await p.process(id)).outcome).toBe('deferred');
      expect(getMedia(db, id)).toMatchObject({ status: 'pending', errorCode: 'stt_unavailable', attempts: 0 });
      expect(record).not.toHaveBeenCalled();
    });
  });

  // Review round 1, fix 2: when the final failure itself cannot be written, the row is still pending in the database,
  // but this processor never runs it again: every such run could pay the provider again.
  describe('a never-retry failure that cannot be written', () => {
    const refuseFail = (db: Db): void => {
      db.raw.exec(`CREATE TRIGGER refuse_fail BEFORE UPDATE OF status ON media WHEN NEW.status = 'failed' BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
    };

    it('stt_paid_unbooked: the error propagates, and the next run of the file makes no extractor call', async () => {
      const v = new FakeVoiceTranscriber({ provider: 'elevenlabs', results: [{ billedSeconds: 12 }] });
      const { spend, extract } = realExtractor(v);
      vi.spyOn(spend, 'settle').mockImplementation((rid) => {
        spend.release(rid);
        throw new Error('database is locked');
      });
      const s = setup({ extract });
      const id = s.shareVoice();
      refuseFail(s.db);
      await expect(s.p.process(id)).rejects.toThrow('disk full');
      expect(getMedia(s.db, id)).toMatchObject({ status: 'pending', attempts: 1 });
      s.clock.advance(60 * MINUTE);
      expect(await s.p.process(id)).toEqual({ outcome: 'skipped', clientId: 1 });
      expect(s.extract).toHaveBeenCalledTimes(1);
      expect(v.transcribed).toBe(1);
      expect(getMedia(s.db, id)).toMatchObject({ status: 'pending', attempts: 1 }); // not claimed again
    });

    it.each([
      ['stt_partial', () => new SttPartialError(1, 2, new SttHttpError(500))],
      ['stt_job_failed', () => new SttJobError('failed')],
    ])('%s: the next run makes no extractor call', async (_code, error) => {
      const s = setup({ extract: throwing(error) });
      const id = s.shareVoice();
      refuseFail(s.db);
      await expect(s.p.process(id)).rejects.toThrow('disk full');
      s.clock.advance(60 * MINUTE);
      expect((await s.p.process(id)).outcome).toBe('skipped');
      expect(s.extract).toHaveBeenCalledTimes(1);
    });

    it('the final no-answer: the next run makes no extractor call', async () => {
      const s = setup({ extract: throwing(() => new SttNoAnswerError('timeout')) });
      const id = s.shareVoice();
      expect((await s.p.process(id)).outcome).toBe('deferred'); // the one retry
      refuseFail(s.db);
      s.clock.advance(MINUTE);
      await expect(s.p.process(id)).rejects.toThrow('disk full');
      s.clock.advance(60 * MINUTE);
      expect((await s.p.process(id)).outcome).toBe('skipped');
      expect(s.extract).toHaveBeenCalledTimes(2);
    });

    it('a failure that may be retried is not held back', async () => {
      const s = setup({ extract: throwing(() => new SttHttpError(500)) });
      const id = s.shareVoice();
      refuseFail(s.db); // a deferral is not a status change, so it is still written
      expect((await s.p.process(id)).outcome).toBe('deferred');
      s.clock.advance(MINUTE);
      await expect(s.p.process(id)).rejects.toThrow('disk full'); // the final stt_http_500
      s.clock.advance(60 * MINUTE);
      await expect(s.p.process(id)).rejects.toThrow('disk full'); // the crash rule's failure: not skipped
      expect(s.extract).toHaveBeenCalledTimes(2);
    });
  });

  // Review round 1, fix 3: a run that never ended may have been paid for, so a voice note or audio file gets
  // STT_NO_ANSWER_MAX_ATTEMPTS runs in all, crashed or not. Images and documents keep MEDIA_MAX_ATTEMPTS.
  it.each([
    ['a voice note', 'voice'],
    ['an audio file', 'audio'],
  ] as const)('%s whose runs never end fails as crashed after 2 runs, not 3', async (_name, kind) => {
    const s = setup({ extract: () => new Promise<Extraction>(() => {}) });
    const id = kind === 'voice' ? s.shareVoice() : s.shareAudio();
    expect(getMedia(s.db, id)!.kind).toBe(kind);
    for (let run = 1; run <= STT_NO_ANSWER_MAX_ATTEMPTS; run++) {
      void s.restart().process(id);
      await vi.waitFor(() => expect(s.extract).toHaveBeenCalledTimes(run));
      expect(getMedia(s.db, id)).toMatchObject({ status: 'pending', attempts: run });
      s.clock.advance(15 * MINUTE);
    }
    expect(await s.restart().process(id)).toEqual({ outcome: 'failed', clientId: 1 });
    expect(getMedia(s.db, id)).toMatchObject({ status: 'failed', errorCode: 'crashed', attempts: STT_NO_ANSWER_MAX_ATTEMPTS });
    expect(s.extract).toHaveBeenCalledTimes(STT_NO_ANSWER_MAX_ATTEMPTS);
  });

  describe('finishMedia throws after a transcript that has a copy to delete', () => {
    it('deletes the copy at once, best effort, and fails the file as stt_paid_unbooked', async () => {
      const v = new FakeVoiceTranscriber({ provider: 'elevenlabs' });
      const afterFinish = vi.fn();
      const { db, clock, p, extract, shareVoice } = setup({ extract: async () => TRANSCRIPT, voice: v, afterFinish });
      const id = shareVoice();
      refuseCopies(db);
      expect(await p.process(id)).toEqual({ outcome: 'failed', clientId: 1 });
      expect(v.forgotten).toEqual(['tr_1']);
      expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: 'stt_paid_unbooked', attempts: 1, text: null, nextAttemptAt: null });
      expect(afterFinish).not.toHaveBeenCalled();
      clock.advance(60 * MINUTE);
      expect((await p.process(id)).outcome).toBe('skipped');
      expect(extract).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['the deletion fails', () => new FakeVoiceTranscriber({ provider: 'elevenlabs', forgetError: new Error('forget failed') }), ['tr_1']],
      // Another provider's id is never sent to it.
      ['the transcriber is of another provider', () => new FakeVoiceTranscriber({ provider: 'openai' }), []],
      ['no transcriber is given', () => null, null],
    ])('fails the file the same when %s', async (_name, voice, forgotten) => {
      const v = voice();
      const { db, p, shareVoice } = setup({ extract: async () => TRANSCRIPT, voice: v });
      const id = shareVoice();
      refuseCopies(db);
      expect((await p.process(id)).outcome).toBe('failed');
      expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: 'stt_paid_unbooked' });
      expect(v?.forgotten ?? null).toEqual(forgotten);
    });

    // Review round 1, fix 5: noted first, then deleted, so a failed delete leaves a row for the sweep.
    describe('when the copy can still be noted', () => {
      const refuseFinish = (db: Db): void => {
        db.raw.exec(`CREATE TRIGGER refuse_finish BEFORE UPDATE OF status ON media WHEN NEW.status = 'done' BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
      };

      it('notes the copy, deletes it and removes its row', async () => {
        const v = new FakeVoiceTranscriber({ provider: 'elevenlabs' });
        const { db, p, shareVoice } = setup({ extract: async () => TRANSCRIPT, voice: v });
        const id = shareVoice();
        refuseFinish(db);
        expect((await p.process(id)).outcome).toBe('failed');
        expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: 'stt_paid_unbooked' });
        expect(v.forgotten).toEqual(['tr_1']);
        expect(forgetRows(db)).toEqual([]);
      });

      it('a delete that fails leaves the row, counted, for the sweep', async () => {
        const v = new FakeVoiceTranscriber({ provider: 'elevenlabs', forgetError: new SttHttpError(500) });
        const { db, p, shareVoice } = setup({ extract: async () => TRANSCRIPT, voice: v });
        const id = shareVoice();
        refuseFinish(db);
        expect((await p.process(id)).outcome).toBe('failed');
        expect(v.forgotten).toEqual(['tr_1']);
        expect(forgetRows(db)).toEqual([{ mediaId: id, provider: 'elevenlabs', ref: 'tr_1', attempts: 1 }]);
      });

      // Review round 1, 6b.
      it('a transcriber that keeps no copies is never asked; the file still fails as stt_paid_unbooked', async () => {
        const v = new FakeVoiceTranscriber({ provider: 'elevenlabs' });
        Object.defineProperty(v, 'canForget', { value: false });
        const forget = vi.spyOn(v, 'forget');
        const { db, p, shareVoice } = setup({ extract: async () => TRANSCRIPT, voice: v });
        const id = shareVoice();
        refuseFinish(db);
        expect((await p.process(id)).outcome).toBe('failed');
        expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: 'stt_paid_unbooked' });
        expect(forget).not.toHaveBeenCalled();
        expect(forgetRows(db)).toEqual([{ mediaId: id, provider: 'elevenlabs', ref: 'tr_1', attempts: 0 }]);
      });

      it('with copies refused too, a transcriber that keeps no copies is never asked', async () => {
        const v = new FakeVoiceTranscriber({ provider: 'elevenlabs' });
        Object.defineProperty(v, 'canForget', { value: false });
        const forget = vi.spyOn(v, 'forget');
        const { db, p, shareVoice } = setup({ extract: async () => TRANSCRIPT, voice: v });
        const id = shareVoice();
        refuseCopies(db);
        expect((await p.process(id)).outcome).toBe('failed');
        expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: 'stt_paid_unbooked' });
        expect(forget).not.toHaveBeenCalled();
      });
    });

    it('a finish without a copy that throws keeps the old rule (a counted retry)', async () => {
      const { db, p, shareVoice } = setup({ extract: async () => ({ ...TRANSCRIPT, forget: null }) });
      const id = shareVoice();
      db.raw.exec(`CREATE TRIGGER refuse_finish BEFORE UPDATE OF status ON media WHEN NEW.status = 'done' BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
      expect((await p.process(id)).outcome).toBe('deferred');
      expect(getMedia(db, id)).toMatchObject({ status: 'pending', errorCode: 'unknown', attempts: 1 });
    });
  });

  // 10d for speech: a refused key bills nothing and only the owner can fix it.
  describe('a refused speech key', () => {
    it.each([
      ['401', () => new SttHttpError(401, 'invalid_api_key')],
      ['403', () => new SttHttpError(403)],
      ['a booking that failed after a 401', () => new SttBookingError(new Error('database is locked'), new SttHttpError(401))],
    ])('(%s) waits 5, 15, 30 and 60 minutes, then hourly, as stt_unavailable, without counting an attempt', async (_name, error) => {
      const { db, clock, p, extract, shareVoice } = setup({ extract: throwing(error) });
      const id = shareVoice();
      let elapsed = 0;
      for (const wait of [5, 15, 30, 60, 60, 60]) {
        expect(await p.process(id)).toEqual({ outcome: 'deferred', clientId: 1 });
        expect(getMedia(db, id)).toMatchObject({ status: 'pending', attempts: 0, errorCode: 'stt_unavailable', nextAttemptAt: at(elapsed + wait * MINUTE) });
        elapsed += wait * MINUTE;
        clock.advance(wait * MINUTE);
      }
      expect(extract).toHaveBeenCalledTimes(6);
    });

    it('fails the file as stt_unavailable once it is more than 24 hours old', async () => {
      const { db, clock, p, shareVoice } = setup({ extract: throwing(() => new SttHttpError(401)) });
      const id = shareVoice();
      clock.advance(24 * 60 * MINUTE); // exactly 24 hours: still waits
      expect((await p.process(id)).outcome).toBe('deferred');
      expect(getMedia(db, id)).toMatchObject({ status: 'pending', errorCode: 'stt_unavailable', attempts: 0 });
      clock.advance(5 * MINUTE);
      expect(await p.process(id)).toEqual({ outcome: 'failed', clientId: 1 });
      expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: 'stt_unavailable', nextAttemptAt: null, localPath: VOICE_REL(id) });
    });

    it('counts the 24 hours from the service start for a file saved before it', async () => {
      const startedAt = new Date(Date.parse('2026-10-19T08:00:00Z') + 3 * 24 * 60 * MINUTE);
      const { db, clock, p, shareVoice } = setup({ extract: throwing(() => new SttHttpError(403)), startedAt });
      const id = shareVoice();
      clock.set(startedAt.toISOString());
      expect((await p.process(id)).outcome).toBe('deferred');
      clock.advance(24 * 60 * MINUTE + 1);
      expect((await p.process(id)).outcome).toBe('failed');
      expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: 'stt_unavailable' });
    });

    it('keeps its waits apart from ai_unavailable: a change of problem starts again at 5 minutes', async () => {
      const errors: unknown[] = [new SttHttpError(401), new SttHttpError(401), status(529), new SttHttpError(401)];
      const { db, clock, p, shareVoice } = setup({ extract: async () => { throw errors.shift(); } });
      const id = shareVoice();
      await p.process(id);
      clock.advance(5 * MINUTE);
      await p.process(id);
      expect(getMedia(db, id)).toMatchObject({ errorCode: 'stt_unavailable', nextAttemptAt: at(20 * MINUTE) });
      clock.advance(15 * MINUTE);
      await p.process(id);
      expect(getMedia(db, id)).toMatchObject({ errorCode: 'ai_unavailable', nextAttemptAt: at(25 * MINUTE) });
      clock.advance(5 * MINUTE);
      await p.process(id);
      expect(getMedia(db, id)).toMatchObject({ errorCode: 'stt_unavailable', nextAttemptAt: at(30 * MINUTE), attempts: 0 });
    });
  });

  describe('errors that fail at once', () => {
    it.each([
      ['a failed job', () => new SttJobError('failed'), 'stt_job_failed'],
      ['ffmpeg failing', () => new AudioError('ffmpeg_failed'), 'audio_ffmpeg_failed'],
      ['ffmpeg finding no length', () => new AudioError('no_duration'), 'audio_no_duration'],
      ['a later part failing', () => new SttPartialError(1, 2, new SttHttpError(500)), 'stt_partial'],
      // Checked before the key rule: every wait's retry would pay for the answered parts again.
      ['a later part refused with 401', () => new SttPartialError(1, 2, new SttHttpError(401)), 'stt_partial'],
      ['a booking that failed after a later part failed', () => new SttBookingError(new Error('database is locked'), new SttPartialError(1, 2, new SttHttpError(401))), 'stt_partial'],
    ])('%s fails at once, with no retry', async (_name, error, code) => {
      const { db, clock, p, extract, shareVoice } = setup({ extract: throwing(error) });
      const id = shareVoice();
      expect(await p.process(id)).toEqual({ outcome: 'failed', clientId: 1 });
      expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: code, attempts: 1, nextAttemptAt: null, localPath: VOICE_REL(id) });
      clock.advance(60 * MINUTE);
      expect((await p.process(id)).outcome).toBe('skipped');
      expect(extract).toHaveBeenCalledTimes(1);
    });
  });

  describe('no usable answer', () => {
    it.each([
      ['a timeout', () => new SttNoAnswerError('timeout'), 'stt_no_answer_timeout'],
      ['a lost job', () => new SttJobLostError('http_404'), 'stt_no_answer_http_404'],
    ])('%s is tried once more after 1 minute, then fails', async (_name, error, code) => {
      const { db, clock, p, extract, shareVoice } = setup({ extract: throwing(error) });
      const id = shareVoice();
      expect((await p.process(id)).outcome).toBe('deferred');
      expect(getMedia(db, id)).toMatchObject({ status: 'pending', attempts: 1, errorCode: code, nextAttemptAt: at(MINUTE) });
      clock.advance(MINUTE);
      expect(await p.process(id)).toEqual({ outcome: 'failed', clientId: 1 });
      expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: code, attempts: STT_NO_ANSWER_MAX_ATTEMPTS, nextAttemptAt: null });
      expect(extract).toHaveBeenCalledTimes(2);
    });

    it('notes in media_stt_forget the copy an unreadable answer named, once, with the provider that made it', async () => {
      const v = new FakeVoiceTranscriber({ provider: 'elevenlabs', results: [unreadable('tr_9'), unreadable('tr_9')] });
      const { db, clock, p, shareVoice } = setup({ extract: realExtractor(v).extract });
      const id = shareVoice();
      expect((await p.process(id)).outcome).toBe('deferred');
      expect(getMedia(db, id)).toMatchObject({ status: 'pending', errorCode: 'stt_no_answer_unreadable_body', attempts: 1 });
      expect(forgetRows(db)).toEqual([{ mediaId: id, provider: 'elevenlabs', ref: 'tr_9', attempts: 0 }]);
      clock.advance(MINUTE);
      expect((await p.process(id)).outcome).toBe('failed');
      expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: 'stt_no_answer_unreadable_body' });
      expect(forgetRows(db)).toHaveLength(1);
    });

    it('notes the copy of a booking that failed after an unreadable answer, and fails at once as stt_paid_unbooked', async () => {
      const v = new FakeVoiceTranscriber({ provider: 'elevenlabs', results: [unreadable('tr_9')] });
      const { spend, extract } = realExtractor(v);
      vi.spyOn(spend, 'settle').mockImplementationOnce((rid) => {
        spend.release(rid);
        throw new Error('database is locked');
      });
      const { db, p, shareVoice } = setup({ extract });
      const id = shareVoice();
      expect((await p.process(id)).outcome).toBe('failed');
      expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: 'stt_paid_unbooked', attempts: 1 });
      expect(forgetRows(db)).toEqual([{ mediaId: id, provider: 'elevenlabs', ref: 'tr_9', attempts: 0 }]);
    });

    // Review round 1, 6c: the id is found two causes deep, noted, and (fix 5) deleted at once through the transcriber.
    it('notes and deletes the copy of a booking that failed after a later part failed after an unreadable answer', async () => {
      const v = new FakeVoiceTranscriber({ provider: 'elevenlabs', results: [new SttPartialError(1, 2, unreadable('tr_9'))] });
      const { spend, extract } = realExtractor(v);
      vi.spyOn(spend, 'settle').mockImplementationOnce((rid) => {
        spend.release(rid);
        throw new Error('database is locked');
      });
      const { db, p, shareVoice } = setup({ extract, voice: v });
      const id = shareVoice();
      expect((await p.process(id)).outcome).toBe('failed');
      expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: 'stt_paid_unbooked', attempts: 1 });
      await vi.waitFor(() => expect(forgetRows(db)).toEqual([]));
      expect(v.forgotten).toEqual(['tr_9']);
    });

    // Review round 1, fix 5: a noted copy is deleted promptly, not only by the sweep.
    it('deletes a noted copy at once when the transcriber is set up, without waiting for it', async () => {
      const v = new FakeVoiceTranscriber({ provider: 'elevenlabs', results: [unreadable('tr_9')] });
      const { db, p, shareVoice } = setup({ extract: realExtractor(v).extract, voice: v });
      const id = shareVoice();
      expect((await p.process(id)).outcome).toBe('deferred');
      await vi.waitFor(() => expect(v.forgotten).toEqual(['tr_9']));
      await vi.waitFor(() => expect(forgetRows(db)).toEqual([]));
    });

    it('a deletion that fails leaves the row, counted, for the sweep; the outcome is the same', async () => {
      const v = new FakeVoiceTranscriber({ provider: 'elevenlabs', results: [unreadable('tr_9')], forgetError: new SttHttpError(500) });
      const { db, p, shareVoice } = setup({ extract: realExtractor(v).extract, voice: v });
      const id = shareVoice();
      expect((await p.process(id)).outcome).toBe('deferred');
      await vi.waitFor(() => expect(forgetRows(db)).toEqual([{ mediaId: id, provider: 'elevenlabs', ref: 'tr_9', attempts: 1 }]));
      expect(getMedia(db, id)).toMatchObject({ status: 'pending', errorCode: 'stt_no_answer_unreadable_body', attempts: 1 });
    });

    it('a transcriber that keeps no copies is not asked: the row waits for one that does', async () => {
      const v = new FakeVoiceTranscriber({ provider: 'elevenlabs', results: [unreadable('tr_9')] });
      Object.defineProperty(v, 'canForget', { value: false });
      const { db, p, shareVoice } = setup({ extract: realExtractor(v).extract, voice: v });
      const id = shareVoice();
      expect((await p.process(id)).outcome).toBe('deferred');
      await new Promise((r) => setTimeout(r, 20));
      expect(v.forgotten).toEqual([]);
      expect(forgetRows(db)).toEqual([{ mediaId: id, provider: 'elevenlabs', ref: 'tr_9', attempts: 0 }]);
    });

    it('a copy that cannot be noted changes nothing else', async () => {
      const v = new FakeVoiceTranscriber({ provider: 'elevenlabs', results: [unreadable('tr_9')] });
      const { db, p, shareVoice } = setup({ extract: realExtractor(v).extract });
      const id = shareVoice();
      refuseCopies(db);
      expect((await p.process(id)).outcome).toBe('deferred');
      expect(getMedia(db, id)).toMatchObject({ status: 'pending', errorCode: 'stt_no_answer_unreadable_body', attempts: 1 });
      expect(forgetRows(db)).toEqual([]);
    });
  });

  describe('errors that count an attempt', () => {
    it.each([
      ['429', () => new SttHttpError(429), 'stt_http_429'],
      ['500', () => new SttHttpError(500), 'stt_http_500'],
      ['400', () => new SttHttpError(400, 'bad_request'), 'stt_http_400'],
      ['a booking that failed after no answer', () => new SttBookingError(new Error('database is locked'), new SttNoAnswerError('timeout')), 'stt_booking'],
      ['a booking that failed after a failed job', () => new SttBookingError(new Error('database is locked'), new SttJobError('failed')), 'stt_booking'],
    ])('%s is retried once after 1 minute, then fails: a voice note gets 2 runs in all (review round 1, fix 3)', async (_name, error, code) => {
      const { db, clock, p, extract, shareVoice } = setup({ extract: throwing(error) });
      const id = shareVoice();
      expect((await p.process(id)).outcome).toBe('deferred');
      expect(getMedia(db, id)).toMatchObject({ status: 'pending', attempts: 1, errorCode: code, nextAttemptAt: at(MINUTE) });
      clock.advance(MINUTE);
      expect(await p.process(id)).toEqual({ outcome: 'failed', clientId: 1 });
      expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: code, attempts: STT_NO_ANSWER_MAX_ATTEMPTS });
      expect(extract).toHaveBeenCalledTimes(2);
    });
  });

  it('the spend cap still waits as before, counting nothing', async () => {
    const { db, p, shareVoice } = setup({ extract: throwing(() => new SpendCapReachedError({ busy: true })) });
    const id = shareVoice();
    expect((await p.process(id)).outcome).toBe('deferred');
    expect(getMedia(db, id)).toMatchObject({ status: 'pending', errorCode: 'spend_busy', attempts: 0, nextAttemptAt: at(10 * MINUTE) });
  });

  // Phase 2b amendment L2: the local engine costs nothing, so its failures are retried freely, and a stop gives the try back.
  describe('the local engine', () => {
    it.each([
      ['an empty transcript of sound', 'empty_output', 'local_empty_output'],
      ['a timeout', 'timeout', 'local_timeout'],
      ['an exit code', 'exit_1', 'local_exit_1'],
      ['a program that did not start', 'exit_-1', 'local_exit_-1'],
      ['no transcript file', 'no_output', 'local_no_output'],
    ])('%s is a counted retry after 1, then 5 minutes, failed after 3 attempts when the voice transcriber is free', async (_name, engineCode, code) => {
      const { db, clock, p, extract, shareVoice } = setup({ extract: throwing(() => new LocalEngineError(engineCode)), voicePaid: false });
      const id = shareVoice();
      expect((await p.process(id)).outcome).toBe('deferred');
      expect(getMedia(db, id)).toMatchObject({ status: 'pending', attempts: 1, errorCode: code, nextAttemptAt: at(MINUTE) });
      clock.advance(MINUTE);
      expect((await p.process(id)).outcome).toBe('deferred');
      expect(getMedia(db, id)).toMatchObject({ status: 'pending', attempts: 2, errorCode: code, nextAttemptAt: at(6 * MINUTE) });
      clock.advance(5 * MINUTE);
      expect(await p.process(id)).toEqual({ outcome: 'failed', clientId: 1 });
      expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: code, attempts: MEDIA_MAX_ATTEMPTS, nextAttemptAt: null });
      expect(extract).toHaveBeenCalledTimes(3);
    });

    it('an audio file gets the same 3 attempts', async () => {
      const { db, clock, p, extract, shareAudio } = setup({ extract: throwing(() => new LocalEngineError('timeout')), voicePaid: false });
      const id = shareAudio();
      for (const wait of [MINUTE, 5 * MINUTE]) {
        expect((await p.process(id)).outcome).toBe('deferred');
        clock.advance(wait);
      }
      expect((await p.process(id)).outcome).toBe('failed');
      expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: 'local_timeout', attempts: 3 });
      expect(extract).toHaveBeenCalledTimes(3);
    });

    it('a retried note that the engine then transcribes is done, and nothing is booked', async () => {
      const v = new FakeLocalVoiceTranscriber({ results: [new LocalEngineError('empty_output'), new LocalEngineError('empty_output'), { text: 'kal milte hain' }] });
      const spendDb = seededDb();
      const spend = new SpendGuard({ db: spendDb, clock: manualClock('2026-10-19T08:00:00Z'), capUsd: 15 });
      const extract = createExtractor({ ai: new FakeMediaAi(), spend, prices: P, voice: v });
      const { db, clock, p, shareVoice } = setup({ extract, voice: v, voicePaid: false });
      const id = shareVoice();
      expect((await p.process(id)).outcome).toBe('deferred');
      clock.advance(MINUTE);
      expect((await p.process(id)).outcome).toBe('deferred');
      clock.advance(5 * MINUTE);
      expect((await p.process(id)).outcome).toBe('done');
      expect(getMedia(db, id)).toMatchObject({ status: 'done', textKind: 'extract', text: 'kal milte hain', note: null });
      expect(v.transcribed).toBe(3);
      expect(forgetRows(db)).toEqual([]);
      expect(spendDb.raw.prepare('SELECT COUNT(*) AS n FROM spend').get()).toEqual({ n: 0 });
    });

    it('an abort (the service stopping) gives the attempt back: it waits 1 minute and counts nothing, however often', async () => {
      const { db, clock, p, extract, shareVoice } = setup({ extract: throwing(() => new LocalEngineError('aborted')), voicePaid: false });
      const id = shareVoice();
      for (let run = 1; run <= 5; run++) {
        expect((await p.process(id)).outcome).toBe('deferred');
        expect(getMedia(db, id)).toMatchObject({ status: 'pending', attempts: 0, errorCode: 'local_aborted', nextAttemptAt: at(run * MINUTE) });
        clock.advance(MINUTE);
      }
      expect(extract).toHaveBeenCalledTimes(5);
    });

    it('an abort after a counted failure keeps its count', async () => {
      const errors = [new LocalEngineError('timeout'), new LocalEngineError('aborted')];
      const { db, clock, p, shareVoice } = setup({
        extract: async () => {
          throw errors.shift() ?? new LocalEngineError('timeout');
        },
        voicePaid: false,
      });
      const id = shareVoice();
      expect((await p.process(id)).outcome).toBe('deferred');
      clock.advance(MINUTE);
      expect((await p.process(id)).outcome).toBe('deferred');
      expect(getMedia(db, id)).toMatchObject({ status: 'pending', attempts: 1, errorCode: 'local_aborted' });
    });

    it.each(['voice', 'audio'] as const)('with voicePaid false, a %s file whose runs never end fails as crashed after 3 runs, as images do', async (kind) => {
      const s = setup({ extract: () => new Promise<Extraction>(() => {}), voicePaid: false });
      const id = kind === 'voice' ? s.shareVoice() : s.shareAudio();
      for (let run = 1; run <= MEDIA_MAX_ATTEMPTS; run++) {
        void s.restart().process(id);
        await vi.waitFor(() => expect(s.extract).toHaveBeenCalledTimes(run));
        expect(getMedia(s.db, id)).toMatchObject({ status: 'pending', attempts: run });
        s.clock.advance(15 * MINUTE);
      }
      expect(await s.restart().process(id)).toEqual({ outcome: 'failed', clientId: 1 });
      expect(getMedia(s.db, id)).toMatchObject({ status: 'failed', errorCode: 'crashed', attempts: MEDIA_MAX_ATTEMPTS });
      expect(s.extract).toHaveBeenCalledTimes(MEDIA_MAX_ATTEMPTS);
    });

    it('by default (voicePaid true, the safe setting) a voice note keeps 2 runs: a LocalEngineError then fails after 2 attempts', async () => {
      const { db, clock, p, extract, shareVoice } = setup({ extract: throwing(() => new LocalEngineError('timeout')) });
      const id = shareVoice();
      expect((await p.process(id)).outcome).toBe('deferred');
      clock.advance(MINUTE);
      expect((await p.process(id)).outcome).toBe('failed');
      expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: 'local_timeout', attempts: STT_NO_ANSWER_MAX_ATTEMPTS });
      expect(extract).toHaveBeenCalledTimes(2);
    });

    // Review round 1, fix 1: voicePaid unset is derived from the voice transcriber, paid-safe when none is known.
    describe('voicePaid unset is derived from the voice transcriber', () => {
      const runsUntilFailed = async (voice: VoiceTranscriber | null | undefined): Promise<number> => {
        const { db, clock, p, extract, shareVoice } = setup({ extract: throwing(() => new LocalEngineError('timeout')), ...(voice !== undefined ? { voice } : {}) });
        const id = shareVoice();
        for (let i = 0; i < 5 && (await p.process(id)).outcome === 'deferred'; i++) clock.advance(5 * MINUTE);
        expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: 'local_timeout' });
        return extract.mock.calls.length;
      };

      it('a local (free) voice transcriber gives 3 runs', async () => {
        expect(await runsUntilFailed(new FakeLocalVoiceTranscriber())).toBe(MEDIA_MAX_ATTEMPTS);
      });

      it('a paid voice transcriber gives 2 runs', async () => {
        expect(await runsUntilFailed(new FakeVoiceTranscriber())).toBe(STT_NO_ANSWER_MAX_ATTEMPTS);
      });

      it.each([['null', null], ['not given', undefined]] as const)('no voice transcriber (%s) gives 2 runs, the paid-safe setting', async (_name, voice) => {
        expect(await runsUntilFailed(voice)).toBe(STT_NO_ANSWER_MAX_ATTEMPTS);
      });

      it('an explicit voicePaid still wins over the transcriber', async () => {
        const a = setup({ extract: throwing(() => new LocalEngineError('timeout')), voice: new FakeLocalVoiceTranscriber(), voicePaid: true });
        const ida = a.shareVoice();
        expect((await a.p.process(ida)).outcome).toBe('deferred');
        a.clock.advance(MINUTE);
        expect((await a.p.process(ida)).outcome).toBe('failed');
        const b = setup({ extract: throwing(() => new LocalEngineError('timeout')), voice: new FakeVoiceTranscriber(), voicePaid: false });
        const idb = b.shareVoice();
        expect((await b.p.process(idb)).outcome).toBe('deferred');
        b.clock.advance(MINUTE);
        expect((await b.p.process(idb)).outcome).toBe('deferred');
        b.clock.advance(5 * MINUTE);
        expect((await b.p.process(idb)).outcome).toBe('failed');
        expect(getMedia(b.db, idb)).toMatchObject({ attempts: MEDIA_MAX_ATTEMPTS });
      });

      it('a local voice transcriber with voicePaid unset: a voice note whose runs never end fails as crashed after 3 runs', async () => {
        const s = setup({ extract: () => new Promise<Extraction>(() => {}), voice: new FakeLocalVoiceTranscriber() });
        const id = s.shareVoice();
        for (let run = 1; run <= MEDIA_MAX_ATTEMPTS; run++) {
          void s.restart().process(id);
          await vi.waitFor(() => expect(s.extract).toHaveBeenCalledTimes(run));
          s.clock.advance(15 * MINUTE);
        }
        expect(await s.restart().process(id)).toEqual({ outcome: 'failed', clientId: 1 });
        expect(getMedia(s.db, id)).toMatchObject({ status: 'failed', errorCode: 'crashed', attempts: MEDIA_MAX_ATTEMPTS });
      });
    });

    // Review round 1, fix 2: local_aborted waits, but not forever (the 24-hour rule of the other free waits).
    describe('an abort has an age limit', () => {
      it('under 24 hours from arrival it still waits, counting nothing', async () => {
        const { db, clock, p, extract, shareVoice } = setup({ extract: throwing(() => new LocalEngineError('aborted')), voicePaid: false });
        const id = shareVoice();
        clock.advance(24 * 60 * MINUTE); // exactly 24 hours: still waits
        expect((await p.process(id)).outcome).toBe('deferred');
        expect(getMedia(db, id)).toMatchObject({ status: 'pending', attempts: 0, errorCode: 'local_aborted', nextAttemptAt: at(24 * 60 * MINUTE + MINUTE) });
        expect(extract).toHaveBeenCalledTimes(1);
      });

      it('over 24 hours from arrival it fails as local_aborted', async () => {
        const { db, clock, p, shareVoice } = setup({ extract: throwing(() => new LocalEngineError('aborted')), voicePaid: false });
        const id = shareVoice();
        expect((await p.process(id)).outcome).toBe('deferred');
        clock.advance(24 * 60 * MINUTE + 1);
        expect(await p.process(id)).toEqual({ outcome: 'failed', clientId: 1 });
        expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: 'local_aborted', nextAttemptAt: null });
      });

      it('counts the 24 hours from the service start for a file saved before it', async () => {
        const startedAt = new Date(Date.parse('2026-10-19T08:00:00Z') + 3 * 24 * 60 * MINUTE);
        const { db, clock, p, shareVoice } = setup({ extract: throwing(() => new LocalEngineError('aborted')), voicePaid: false, startedAt });
        const id = shareVoice();
        clock.set(startedAt.toISOString());
        expect((await p.process(id)).outcome).toBe('deferred');
        clock.advance(24 * 60 * MINUTE + 1);
        expect((await p.process(id)).outcome).toBe('failed');
        expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: 'local_aborted' });
      });
    });

    it('voicePaid false leaves images at 3 attempts', async () => {
      const { db, clock, p, share } = setup({ extract: throwing(() => new AiInvalidOutputError('not json', null)), voicePaid: false });
      const id = share();
      for (const wait of [MINUTE, 5 * MINUTE]) {
        expect((await p.process(id)).outcome).toBe('deferred');
        clock.advance(wait);
      }
      expect((await p.process(id)).outcome).toBe('failed');
      expect(getMedia(db, id)).toMatchObject({ errorCode: 'ai_invalid_output', attempts: MEDIA_MAX_ATTEMPTS });
    });

    it('logs ids and codes only', async () => {
      const lines: string[] = [];
      const log = createLogger('info', new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } }));
      const a = setup({ extract: throwing(() => new LocalEngineError('aborted')), voicePaid: false, log });
      await a.p.process(a.shareVoice());
      const b = setup({ extract: throwing(() => new LocalEngineError('empty_output')), voicePaid: false, log });
      await b.p.process(b.shareVoice());
      const logged = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(logged.map((l) => l.errorCode)).toEqual(['local_aborted', 'local_empty_output']);
      for (const l of logged) {
        expect(Object.keys(l).filter((k) => !['level', 'time', 'msg', 'mediaId', 'clientId', 'errorCode', 'attempts', 'err'].includes(k))).toEqual([]);
      }
    });
  });

  describe('afterFinish', () => {
    it('is told the file and its extraction once the transcript and its copy are stored', async () => {
      const seen: unknown[] = [];
      const s = setup({ extract: async () => TRANSCRIPT, afterFinish: (mediaId, x) => void seen.push({ mediaId, x, status: getMedia(s.db, mediaId)?.status, copies: forgetRows(s.db).length }) });
      const id = s.shareVoice();
      expect((await s.p.process(id)).outcome).toBe('done');
      expect(seen).toEqual([{ mediaId: id, x: TRANSCRIPT, status: 'done', copies: 1 }]);
    });

    it('is called for any file read, with or without a copy', async () => {
      const afterFinish = vi.fn();
      const { p, share } = setup({ afterFinish });
      const id = share();
      await p.process(id);
      expect(afterFinish).toHaveBeenCalledExactlyOnceWith(id, { textKind: 'description', text: 'A blue banner with the new logo', pageCount: null, note: null });
    });

    it('a failure in it never changes the outcome', async () => {
      const { db, p, shareVoice } = setup({
        extract: async () => TRANSCRIPT,
        afterFinish: () => {
          throw new Error('forget run failed');
        },
      });
      const id = shareVoice();
      expect(await p.process(id)).toEqual({ outcome: 'done', clientId: 1 });
      expect(getMedia(db, id)).toMatchObject({ status: 'done', text: 'payment bhej diya', errorCode: null });
    });

    // Review round 1, fix 4: it may be async; neither a sync throw nor a rejection escapes, and both are logged.
    it.each([
      ['throws', (): void => {
        throw new Error('forget run failed');
      }],
      ['rejects', async (): Promise<void> => {
        throw new Error('forget run failed');
      }],
    ] as const)('one that %s is logged with codes only and never changes the outcome', async (_name, afterFinish) => {
      const lines: string[] = [];
      const log = createLogger('info', new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } }));
      const { db, p, shareVoice } = setup({ extract: async () => TRANSCRIPT, afterFinish, log });
      const id = shareVoice();
      expect(await p.process(id)).toEqual({ outcome: 'done', clientId: 1 });
      await vi.waitFor(() => expect(lines.some((l) => l.includes('"errorCode":"after_finish"'))).toBe(true));
      expect(getMedia(db, id)).toMatchObject({ status: 'done', errorCode: null });
      expect(lines.join('')).not.toContain('forget run failed');
    });

    it('is not waited for', async () => {
      let release: (() => void) | undefined;
      const afterFinish = vi.fn(() => new Promise<void>((r) => (release = r)));
      const { p, shareVoice } = setup({ extract: async () => TRANSCRIPT, afterFinish });
      expect((await p.process(shareVoice())).outcome).toBe('done');
      await vi.waitFor(() => expect(afterFinish).toHaveBeenCalledTimes(1));
      release?.();
    });
  });

  it('logs ids and codes only: no transcript, copy id or error text', async () => {
    const cases: (() => Error)[] = [
      () => new SttHttpError(401, 'invalid_api_key'),
      () => new SttHttpError(500),
      () => unreadable('tr_secret_9'),
      () => new SttPartialError(1, 2, unreadable('tr_secret_9')),
      () => new SttJobError('failed'),
      () => new AudioError('ffmpeg_failed'),
    ];
    for (const error of cases) {
      const lines: string[] = [];
      const log = createLogger('info', new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } }));
      const v = new FakeVoiceTranscriber({ provider: 'elevenlabs', results: [error()] });
      const { p, shareVoice } = setup({ extract: realExtractor(v).extract, log });
      await p.process(shareVoice());
      const out = lines.join('');
      expect(out).toContain('"errorCode"');
      for (const secret of ['tr_secret_9', 'payment', 'namaste', 'invalid_api_key', 'mmg.whatsapp.net']) expect(out).not.toContain(secret);
      for (const line of lines) {
        const entry = JSON.parse(line) as Record<string, unknown>;
        for (const key of Object.keys(entry)) expect(['level', 'time', 'msg', 'mediaId', 'clientId', 'errorCode', 'attempts', 'waitMinutes', 'provider', 'err']).toContain(key);
        if (entry.err !== undefined) for (const key of Object.keys(entry.err as object)) expect(['type', 'code', 'stack']).toContain(key);
      }
    }
  });
});
