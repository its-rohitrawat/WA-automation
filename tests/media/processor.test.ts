import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpendCapReachedError } from '../../src/brain/paidCall.ts';
import { createExtractor, type Extractor } from '../../src/media/extract.ts';
import { MediaDownloadError, MediaUnavailableError, type MediaFetcher } from '../../src/media/fetch.ts';
import type { PreparedImage } from '../../src/media/image.ts';
import { ParseError } from '../../src/media/parse/types.ts';
import { mediaRelPath } from '../../src/media/paths.ts';
import { MediaProcessor } from '../../src/media/processor.ts';
import { MediaRefSealer } from '../../src/media/ref.ts';
import { MEDIA_LIMITS } from '../../src/media/types.ts';
import type { Prices } from '../../src/spend/pricing.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { syncClients } from '../../src/store/clients.ts';
import { getMedia, getMediaRef } from '../../src/store/media.ts';
import { applyRevoke } from '../../src/store/messages.ts';
import { manualClock } from '../../src/util/clock.ts';
import { createLogger, silentLogger, type Logger } from '../../src/util/logger.ts';
import { Ingestor } from '../../src/wa/ingest.ts';
import { normalizeMessage } from '../../src/wa/normalize.ts';
import { MEHTA, SHARMA, seededDb } from '../helpers/db.ts';
import { FakeMediaAi } from '../helpers/mediaAi.ts';
import { TS, waRaw } from '../helpers/wa.ts';

const MEDIA_KEY = Buffer.alloc(32, 9);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type ImageExtras = { viewOnce?: boolean; contextInfo?: { isForwarded?: boolean; forwardingScore?: number } };

function setup(o: { fetcher?: MediaFetcher; extract?: Extractor; log?: Logger } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'wa-media-'));
  dirs.push(dataDir);
  const db = seededDb();
  const clock = manualClock('2026-10-19T08:00:00Z');
  const sealer = new MediaRefSealer(Buffer.alloc(32, 5));
  const ing = new Ingestor({ db, onNewMessages: () => {}, clock, media: { sealer } });
  const fetcher = vi.fn<MediaFetcher>(o.fetcher ?? (async () => Buffer.from('jpeg-bytes')));
  const extract = vi.fn<Extractor>(o.extract ?? (async () => ({ textKind: 'description', text: 'A blue banner with the new logo', pageCount: null, note: null })));
  const p = new MediaProcessor({ db, dataDir, clock, log: o.log ?? silentLogger(), sealer, fetcher, extract });
  const share = (waId = 'IMG1', extras: ImageExtras = {}): number => {
    ing.handle(
      normalizeMessage(
        waRaw(waId, { imageMessage: { url: 'https://mmg.whatsapp.net/v/x', directPath: '/v/x', mediaKey: MEDIA_KEY, mimetype: 'image/jpeg', caption: 'new banner', ...extras } }),
      )!,
    );
    return (db.prepare('SELECT id FROM media ORDER BY id DESC LIMIT 1').get() as { id: number }).id;
  };
  return { db, dataDir, clock, p, fetcher, extract, share };
}

/** Where a shared image is saved, built only by mediaRelPath. waRaw's default timestamp is 10 Oct 2026, so client SHA's 2026-10 folder. */
const rel = (mediaId: number, waId = 'IMG1'): string => mediaRelPath({ clientCode: 'SHA', ts: new Date(TS * 1000).toISOString(), waId, mediaId, ext: 'jpg' });
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
    expect(extract).toHaveBeenCalledWith({ mediaId: id, kind: 'image', mimeType: 'image/jpeg', fileName: null, forwarded: false, bytes: Buffer.from('jpeg-bytes') });
    expect(getMediaRef(db, id)).toBeNull();
    expect(getMedia(db, id)).toMatchObject({ status: 'done', localPath: rel(id), fileSize: 10, textKind: 'description', text: 'A blue banner with the new logo' });
    expect(getMedia(db, id)!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await p.process(id)).toEqual({ outcome: 'skipped', clientId: 1 });
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

  it('retries a network problem after 1 and 5 minutes, then gives up', async () => {
    const { db, clock, p, fetcher, share } = setup({ fetcher: async () => { throw new MediaDownloadError('network'); } });
    const id = share();
    expect((await p.process(id)).outcome).toBe('deferred');
    expect(getMedia(db, id)).toMatchObject({ status: 'pending', attempts: 1, errorCode: 'network', nextAttemptAt: '2026-10-19T08:01:00.000Z', hasRef: true });
    clock.advance(60_000);
    expect((await p.process(id)).outcome).toBe('deferred');
    expect(getMedia(db, id)).toMatchObject({ attempts: 2, nextAttemptAt: '2026-10-19T08:06:00.000Z' });
    clock.advance(300_000);
    expect((await p.process(id)).outcome).toBe('failed');
    expect(getMedia(db, id)).toMatchObject({ status: 'failed', errorCode: 'network', hasRef: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
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

  it('logs ids and codes only: no description, caption, address or key', async () => {
    const lines: string[] = [];
    const log = createLogger('info', new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } }));
    let fail = true;
    const { p, share } = setup({
      log,
      fetcher: async () => {
        if (fail) {
          fail = false;
          throw new MediaDownloadError('network');
        }
        return Buffer.from('jpeg-bytes');
      },
    });
    const id = share();
    await p.process(id);
    await p.process(id);
    const out = lines.join('');
    expect(out).toContain(`"mediaId":${id}`);
    for (const secret of ['A blue banner', 'new banner', 'mmg.whatsapp.net', MEDIA_KEY.toString('base64')]) expect(out).not.toContain(secret);
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
    db.pragma('foreign_keys = OFF');
    db.prepare("DELETE FROM messages WHERE wa_id = 'IMG1'").run();
    db.pragma('foreign_keys = ON');
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
      expect(getMedia(db, id)).toMatchObject({ status: 'done', text: 'A receipt', errorCode: null, attempts: 0 });
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
      ['401 bad key', () => status(401), 'ai_401'],
      ['400 bad request', () => status(400), 'ai_400'],
      ['timeout after sending', () => new Anthropic.APIConnectionTimeoutError(), 'ai_timeout'],
      ['connection reset after sending', () => connectionLost('ECONNRESET'), 'ai_network'],
    ])('a %s is retried after 1 minute and counts an attempt', async (_name, error, code) => {
      const { db, p, share } = setup({ extract: async () => { throw error(); } });
      const id = share();
      expect((await p.process(id)).outcome).toBe('deferred');
      expect(getMedia(db, id)).toMatchObject({ status: 'pending', attempts: 1, errorCode: code, nextAttemptAt: at(MINUTE) });
    });
  });
});
