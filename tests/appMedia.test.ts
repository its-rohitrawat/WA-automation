import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type AppMediaDeps } from '../src/app.ts';
import { Reconciler } from '../src/brain/reconciler.ts';
import { readHealthSnapshot } from '../src/health/health.ts';
import { imageEstimateUsd, type Extractor } from '../src/media/extract.ts';
import { MediaDownloadError, type MediaFetcher } from '../src/media/fetch.ts';
import { mediaRefAad, MediaRefSealer } from '../src/media/ref.ts';
import { DriveFileUploader } from '../src/media/uploader.ts';
import type { Prices } from '../src/spend/pricing.ts';
import { SpendGuard } from '../src/spend/spendGuard.ts';
import type { Db } from '../src/store/db.ts';
import { finishMedia, getMedia, insertMedia, markDownloaded, markUploadFailed, messageRowId } from '../src/store/media.ts';
import { insertMessage, markProcessed } from '../src/store/messages.ts';
import { setRole, upsertPerson } from '../src/store/people.ts';
import { systemClock } from '../src/util/clock.ts';
import { createLogger, silentLogger, type Logger } from '../src/util/logger.ts';
import { AllowList } from '../src/wa/allowlist.ts';
import { openSessionDb, useEncryptedAuthState } from '../src/wa/authState.ts';
import { WhatsAppGateway } from '../src/wa/gateway.ts';
import { FakeAi } from './helpers/ai.ts';
import { MEHTA, seededDb, SHARMA } from './helpers/db.ts';
import { FakeDrive } from './helpers/fakeDrive.ts';
import { FakeMediaAi } from './helpers/mediaAi.ts';
import { FakeSocket, SEND_METHODS } from './helpers/fakeSocket.ts';
import { SHARMA_PN, waRaw, waText } from './helpers/wa.ts';

const P: Prices = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 };
const MEDIA_KEY = Buffer.alloc(32, 9);
const MINUTE = 60_000;
const dirs: string[] = [];

interface SetupOptions {
  media?: Partial<AppMediaDeps> | null;
  log?: Logger;
  startedAt?: Date;
  drainMs?: number;
  /** Runs on the database and the data folder before the app is made. */
  prepare?: (db: Db, dataDir: string) => void;
}

function setup(o: SetupOptions = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'wa-app-media-'));
  dirs.push(dataDir);
  const ai = new FakeAi();
  const drive = new FakeDrive();
  const db = seededDb();
  o.prepare?.(db, dataDir);
  const allow = new AllowList([SHARMA.groupId, MEHTA.groupId]);
  const sockets: FakeSocket[] = [];
  const auth = useEncryptedAuthState(openSessionDb(':memory:'), randomBytes(32));
  const gateway = new WhatsAppGateway({
    allow,
    factory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    auth: auth.state,
    saveCreds: auth.saveCreds,
  });
  const fetcher = vi.fn<MediaFetcher>(async () => Buffer.from('jpeg-bytes'));
  const extract = vi.fn<Extractor>(async () => ({ textKind: 'description', text: 'A blue homepage banner. Visible text: SALE 50%', pageCount: null, note: null }));
  const media: AppMediaDeps | undefined =
    o.media === null ? undefined : { sealer: new MediaRefSealer(randomBytes(32)), fetcher, ai: new FakeMediaAi(), extract, ...o.media };
  const app = createApp({
    db, clock: systemClock, log: o.log ?? silentLogger(), gateway, allow, ai, drive, prices: P, spendCapUsd: 15,
    quietMs: 240_000, maxWaitMs: 1_200_000, maxConcurrent: 3, dataDir, freeBytes: () => 500e9, pollMs: 30_000, media, startedAt: o.startedAt,
    drainMs: o.drainMs,
  });
  app.start();
  const sock = sockets[0]!;
  sock.emit('connection.update', { connection: 'open' });
  return { db, ai, drive, app, sock, fetcher, extract, dataDir };
}

const shareImage = (sock: FakeSocket, waId = 'IMG1') =>
  sock.emit('messages.upsert', { type: 'notify', messages: [
    waRaw(waId, { imageMessage: { url: 'https://mmg.whatsapp.net/v/t1', directPath: '/v/t1', mediaKey: MEDIA_KEY, mimetype: 'image/jpeg', caption: 'new banner' } }),
  ] });

/** A small real JPEG, so the standard extractor decodes it and goes on to the paid call. */
const REAL_JPEG_SIZE = { width: 64, height: 48 };
const realJpeg = () => sharp({ create: { ...REAL_JPEG_SIZE, channels: 3, background: { r: 30, g: 90, b: 200 } } }).jpeg().toBuffer();
const NOTHING_READ = { textKind: null, text: null, pageCount: null, note: null };
const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const BUDGET_LINE = "⚠️ 1 shared file waiting for today's AI budget (read after midnight IST)";

/** stop() ends with a final upload whose workbook build runs on (fake) timers: advance until it resolves. */
async function stopApp(app: { stop(): Promise<void> }): Promise<void> {
  let done = false;
  const p = app.stop().then(() => {
    done = true;
  });
  for (let i = 0; i < 30 && !done; i++) await vi.advanceTimersByTimeAsync(1_000);
  await p;
}

/** Claude overloaded (529): released, not billed, so the file waits without using an attempt (amendment 10d). */
const overloaded = () => Anthropic.APIError.generate(529, undefined, 'overloaded', new Headers());

/** A promise the test settles by hand. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

/** A pending image of client SHA stored before the app starts, as `cli link` leaves it: sealed details, created at `createdAt`. */
function storedImage(db: Db, sealer: MediaRefSealer, createdAt: string): void {
  insertMessage(db, {
    waId: 'IMG0', clientId: 1, senderJid: SHARMA_PN, senderNumber: '919800000001', senderName: 'Mr. Sharma', fromMe: false, ts: createdAt,
    text: 'old banner', quotedWaId: null, mediaType: 'image',
  });
  const ref = { contentType: 'imageMessage' as const, url: null, directPath: '/v/t0', mediaKey: MEDIA_KEY.toString('base64') };
  insertMedia(db, {
    messageId: messageRowId(db, 1, 'IMG0')!, clientId: 1, kind: 'image', status: 'pending', mimeType: 'image/jpeg', fileName: null, fileSize: 10,
    seconds: null, forwarded: false, refEnc: sealer.seal(ref, mediaRefAad(1, 'IMG0')), errorCode: null, createdAt,
  });
}

/**
 * A PDF of client SHA's client member, read and saved before the app starts, but not yet in Drive. Its message is
 * processed, so no reconcile (and no publish after one) runs in the test. Returns the media id.
 */
function storedClientDoc(db: Db, dataDir: string): number {
  insertMessage(db, {
    waId: 'DOC1', clientId: 1, senderJid: SHARMA_PN, senderNumber: '919800000001', senderName: 'Mr. Sharma', fromMe: false,
    ts: '2026-10-10T08:00:00.000Z', text: null, quotedWaId: null, mediaType: 'document',
  });
  upsertPerson(db, { clientId: 1, jid: SHARMA_PN, number: '919800000001', name: 'Mr. Sharma', fromMe: false });
  setRole(db, 1, SHARMA_PN, 'client', 'human');
  const id = insertMedia(db, {
    messageId: messageRowId(db, 1, 'DOC1')!, clientId: 1, kind: 'document', status: 'pending', mimeType: 'application/pdf', fileName: 'brief.pdf',
    fileSize: 3, seconds: null, forwarded: false, refEnc: null, errorCode: null, createdAt: '2026-10-10T08:00:00.000Z',
  });
  mkdirSync(join(dataDir, 'media', 'SHA', '2026-10'), { recursive: true });
  writeFileSync(join(dataDir, 'media', 'SHA', '2026-10', `DOC1-${id}.pdf`), 'pdf');
  markDownloaded(db, id, { localPath: `media/SHA/2026-10/DOC1-${id}.pdf`, sha256: 'x', fileSize: 3, at: '2026-10-10T08:00:01.000Z' });
  finishMedia(db, id, { textKind: null, text: null, pageCount: null, note: null, at: '2026-10-10T08:00:02.000Z' });
  markProcessed(db, [messageRowId(db, 1, 'DOC1')!], '2026-10-10T08:05:00.000Z');
  return id;
}

const minutesBefore = (min: number) => new Date(Date.parse('2026-10-19T07:00:00Z') - min * MINUTE);

describe('app with shared files', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T07:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('downloads a shared image right away, and the AI sees its description', async () => {
    const { db, ai, app, sock, fetcher, dataDir } = setup();
    shareImage(sock);
    await vi.waitFor(() => expect(getMedia(db, 1)?.status).toBe('done'));
    expect(fetcher).toHaveBeenCalledTimes(1);
    // Amendment 15d: saved as <message id>-<media id>.<ext>.
    expect(existsSync(join(dataDir, 'media', 'SHA', '2026-10', 'IMG1-1.jpg'))).toBe(true);
    expect(getMedia(db, 1)?.localPath).toBe('media/SHA/2026-10/IMG1-1.jpg');
    await vi.advanceTimersByTimeAsync(240_000);
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]!.user).toContain(': new banner {image: A blue homepage banner. Visible text: SALE 50%}');
    for (const name of SEND_METHODS) expect(sock[name]).not.toHaveBeenCalled();
    await stopApp(app);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uploads a client member’s file into Clients/<Client>/Files', async () => {
    const { db, drive, app, sock } = setup();
    shareImage(sock);
    await vi.waitFor(() => expect(getMedia(db, 1)?.status).toBe('done'));
    setRole(db, 1, SHARMA_PN, 'client', 'human');
    await vi.advanceTimersByTimeAsync(61_000);
    await vi.waitFor(() => expect(getMedia(db, 1)?.driveFileId).toBeTruthy());
    expect(drive.folders).toEqual(['WA Agent', 'Clients', 'Sharma Interiors', 'Files']);
    expect(drive.created.map((f) => f.name)).toContain('image-2026-10-10-1330-1.jpg');
    await stopApp(app);
  });

  it('without the media pipeline, records the file as not downloaded and does not hold up the batch', async () => {
    const { db, ai, app, sock } = setup({ media: null });
    shareImage(sock);
    expect(getMedia(db, 1)).toMatchObject({ status: 'unavailable', errorCode: 'not_downloaded' });
    await vi.advanceTimersByTimeAsync(240_000);
    expect(ai.calls[0]!.user).toContain(': new banner {image, could not be downloaded}');
    expect(app.mediaQueue).toBeUndefined();
    await stopApp(app);
  });

  it('logs no file text, address or media key', async () => {
    const lines: string[] = [];
    const log = createLogger('info', new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } }));
    const fetcher = vi.fn<MediaFetcher>(async () => {
      throw new Error('socket hang up https://mmg.whatsapp.net/v/t1');
    });
    const { db, app, sock } = setup({ log, media: { fetcher } });
    shareImage(sock);
    await vi.waitFor(() => expect(getMedia(db, 1)?.attempts).toBe(1));
    await stopApp(app);
    const out = lines.join('');
    expect(out).toContain('shared file will be retried');
    for (const s of ['mmg.whatsapp.net', '/v/t1', MEDIA_KEY.toString('base64'), 'new banner']) expect(out).not.toContain(s);
  });

  it('stop() waits for a file being read and leaves no timers', async () => {
    const g = gate();
    const extract = vi.fn<Extractor>(async () => {
      await g.promise;
      return { textKind: null, text: null, pageCount: null, note: null };
    });
    const { db, app, sock } = setup({ media: { extract } });
    shareImage(sock);
    await vi.waitFor(() => expect(extract).toHaveBeenCalled());
    let stopped = false;
    const p = app.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stopped).toBe(false);
    g.release();
    for (let i = 0; i < 30 && !stopped; i++) await vi.advanceTimersByTimeAsync(1_000);
    await p;
    expect(getMedia(db, 1)?.status).toBe('done');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop() gives up on a file read that never finishes once drainMs is over', async () => {
    const g = gate();
    const extract = vi.fn<Extractor>(async () => {
      await g.promise;
      return NOTHING_READ;
    });
    const { db, app, sock } = setup({ media: { extract }, drainMs: 5_000 });
    shareImage(sock);
    await vi.waitFor(() => expect(extract).toHaveBeenCalled());
    let stopped = false;
    const p = app.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(stopped).toBe(false);
    // drainMs, then at most 10 s for the last publish and 5 s for WhatsApp: well inside WinSW's stoptimeout.
    for (let i = 0; i < 12 && !stopped; i++) await vi.advanceTimersByTimeAsync(1_000);
    expect(stopped).toBe(true);
    await p;
    expect(getMedia(db, 1)?.status).toBe('pending');
    g.release();
    await vi.waitFor(() => expect(getMedia(db, 1)?.status).toBe('done'));
  });

  it('stop() starts no other file while it waits for the one in flight', async () => {
    const g = gate();
    let n = 0;
    const fetcher = vi.fn<MediaFetcher>(async () => {
      if (++n === 1) await g.promise;
      return Buffer.from('jpeg-bytes');
    });
    const { db, app, sock } = setup({ media: { fetcher, concurrency: 1 } });
    shareImage(sock, 'IMG1');
    shareImage(sock, 'IMG2');
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(app.mediaQueue!.active).toBe(1);
    let stopped = false;
    const p = app.stop().then(() => {
      stopped = true;
    });
    g.release();
    // Saving the download is real file I/O: wait for it, not for fake time.
    await vi.waitFor(() => expect(getMedia(db, 1)?.status).toBe('done'));
    await vi.waitFor(() => expect(app.mediaQueue!.active).toBe(0));
    for (let i = 0; i < 30 && !stopped; i++) await vi.advanceTimersByTimeAsync(1_000);
    await p;
    // The second file is downloaded after the next start, not during the shutdown.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(getMedia(db, 2)).toMatchObject({ status: 'pending', attempts: 0, localPath: null });
  });

  it('reads two files at once by default', async () => {
    const g = gate();
    const fetcher = vi.fn<MediaFetcher>(async () => {
      await g.promise;
      return Buffer.from('jpeg-bytes');
    });
    const { db, app, sock } = setup({ media: { fetcher } });
    for (const id of ['IMG1', 'IMG2', 'IMG3']) shareImage(sock, id);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(app.mediaQueue!.active).toBe(2);
    g.release();
    await vi.waitFor(() => expect([1, 2, 3].map((id) => getMedia(db, id)?.status)).toEqual(['done', 'done', 'done']));
    await stopApp(app);
  });

  it('a file that settles during the shutdown drain is not uploaded during the shutdown (it stays due for the next start)', async () => {
    const g = gate();
    const extract = vi.fn<Extractor>(async () => {
      await g.promise;
      return NOTHING_READ;
    });
    const { db, drive, app, sock } = setup({ media: { extract } });
    await vi.advanceTimersByTimeAsync(1_000); // the first publish creates the Drive root folder
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('T1', 'hello')] });
    setRole(db, 1, SHARMA_PN, 'client', 'human');
    shareImage(sock);
    await vi.waitFor(() => expect(extract).toHaveBeenCalled());
    let stopped = false;
    const p = app.stop().then(() => {
      stopped = true;
    });
    g.release();
    for (let i = 0; i < 30 && !stopped; i++) await vi.advanceTimersByTimeAsync(1_000);
    await p;
    expect(getMedia(db, 1)).toMatchObject({ status: 'done', driveFileId: null });
    expect(drive.created.map((f) => f.name)).toEqual(['Tracker.xlsx']);
    expect(db.prepare('SELECT drive_attempts FROM media').get()).toEqual({ drive_attempts: 0 });
  });
});

describe('app media spend (review round 1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T07:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const ledger = (db: Db) => db.prepare('SELECT kind, usd, detail FROM spend ORDER BY id').all() as { kind: string; usd: number; detail: string }[];

  it('paid file reads use the app’s daily cap: an image whose hold does not fit waits for the budget, and Health says so', async () => {
    const ai = new FakeMediaAi();
    const jpeg = await realJpeg();
    const fetcher = vi.fn<MediaFetcher>(async () => jpeg);
    const { db, app, sock } = setup({
      media: { ai, fetcher, extract: undefined }, // the standard extractor
      // Spent today but under the $15 cap: nothing is paused, yet an image's hold (about $0.10) no longer fits.
      prepare: (db) => new SpendGuard({ db, clock: systemClock, capUsd: 15 }).record('ai', 14.99, 'batch 1'),
    });
    shareImage(sock);
    await vi.waitFor(() => expect(getMedia(db, 1)).toMatchObject({ status: 'pending', errorCode: 'spend_cap', attempts: 0 }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(ai.calls).toHaveLength(0);
    expect(ledger(db)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(readHealthSnapshot(db)!.media).toMatchObject({ pending: 1, spendCap: 1 });
    expect(readHealthSnapshot(db)!.line).toEqual({ ok: false, text: BUDGET_LINE });
    await stopApp(app);
  });

  it('a paid file read still running at shutdown is given up after drainMs and booked once, at its estimate', async () => {
    const g = gate();
    const ai = new FakeMediaAi();
    const describeImage = vi.spyOn(ai, 'describeImage').mockImplementation(async () => {
      await g.promise;
      return { text: 'A blue square', usage: ZERO_USAGE, costUsd: 0.01, fallbackUsed: false };
    });
    const jpeg = await realJpeg();
    const fetcher = vi.fn<MediaFetcher>(async () => jpeg);
    const { db, app, sock } = setup({ media: { ai, fetcher, extract: undefined }, drainMs: 5_000 });
    shareImage(sock);
    await vi.waitFor(() => expect(describeImage).toHaveBeenCalled());
    expect(ledger(db)).toEqual([]);
    let stopped = false;
    const p = app.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(stopped).toBe(false);
    for (let i = 0; i < 12 && !stopped; i++) await vi.advanceTimersByTimeAsync(1_000);
    expect(stopped).toBe(true);
    await p;
    const booked = ledger(db);
    expect(booked).toHaveLength(1);
    expect(booked[0]).toMatchObject({ kind: 'ai', detail: 'shutdown before the AI call finished (estimated)' });
    expect(booked[0]!.usd).toBeCloseTo(imageEstimateUsd(REAL_JPEG_SIZE, P), 10);
    // The answer arrives after all: the call is already booked, so it is not booked again.
    g.release();
    await vi.waitFor(() => expect(getMedia(db, 1)?.status).toBe('done'));
    expect(ledger(db)).toEqual(booked);
  });
});

describe('app media wiring (15g)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T07:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('the tick retries a file that is due again, with no new message to kick the queue', async () => {
    const fetcher = vi.fn<MediaFetcher>().mockRejectedValueOnce(new MediaDownloadError('network')).mockResolvedValue(Buffer.from('jpeg-bytes'));
    const { db, app, sock } = setup({ media: { fetcher } });
    shareImage(sock);
    await vi.waitFor(() => expect(getMedia(db, 1)).toMatchObject({ status: 'pending', attempts: 1, errorCode: 'network' }));
    // Retried a minute later, on the first tick after that.
    await vi.advanceTimersByTimeAsync(55_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(40_000);
    await vi.waitFor(() => expect(getMedia(db, 1)?.status).toBe('done'));
    expect(fetcher).toHaveBeenCalledTimes(2);
    await stopApp(app);
  });

  it('the tick re-runs a client waiting for a file Claude cannot read yet, and Health warns about the long wait', async () => {
    const extract = vi.fn<Extractor>(async () => {
      throw overloaded();
    });
    const run = vi.spyOn(Reconciler.prototype, 'run');
    const { db, ai, app, sock } = setup({ media: { extract } });
    shareImage(sock);
    await vi.waitFor(() => expect(getMedia(db, 1)).toMatchObject({ status: 'pending', errorCode: 'ai_unavailable', attempts: 0 }));
    await vi.advanceTimersByTimeAsync(241_000);
    await expect(run.mock.results[0]!.value).resolves.toEqual({ status: 'waiting' });
    expect(ai.calls).toHaveLength(0);
    // A deferred file never settles, so nothing else wakes the client: the tick does, once the 30-minute wait is over.
    await vi.advanceTimersByTimeAsync(36 * MINUTE);
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]!.user).toContain(': new banner {image, still being read}');
    await vi.waitFor(() => expect(app.mediaQueue!.active).toBe(0));
    expect(getMedia(db, 1)).toMatchObject({ status: 'pending', errorCode: 'ai_unavailable' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(readHealthSnapshot(db)!.media).toEqual({ pending: 1, stale: 1, spendCap: 0, failedRecent: 0, uploadFailed: 0 });
    expect(readHealthSnapshot(db)!.line).toEqual({ ok: false, text: '⚠️ 1 shared file waiting over 30 minutes to be read. See docs/SETUP.md.' });
    await vi.waitFor(() => expect(app.mediaQueue!.active).toBe(0));
    await stopApp(app);
  });

  it('a finished file wakes its client’s reconcile', async () => {
    const { db, app, sock } = setup();
    shareImage(sock);
    const notify = vi.spyOn(app.debouncer, 'notify');
    await vi.waitFor(() => expect(getMedia(db, 1)?.status).toBe('done'));
    expect(notify).toHaveBeenCalledWith(1);
    await stopApp(app);
  });

  it('a finished file from a client member is uploaded straight away, without waiting for a tick', async () => {
    const { db, drive, app, sock } = setup();
    await vi.advanceTimersByTimeAsync(1_000); // the first publish creates the Drive root folder
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('T1', 'hello')] });
    setRole(db, 1, SHARMA_PN, 'client', 'human');
    shareImage(sock);
    await vi.waitFor(() => expect(getMedia(db, 1)?.driveFileId).toBeTruthy());
    expect(Date.now()).toBeLessThan(Date.parse('2026-10-19T07:00:29Z')); // before the first tick after start
    expect(drive.created.map((f) => f.name)).toContain('image-2026-10-10-1330-1.jpg');
    await stopApp(app);
  });

  it('the uploader runs after each workbook publish and is stopped at shutdown', async () => {
    const run = vi.spyOn(DriveFileUploader.prototype, 'run');
    const stop = vi.spyOn(DriveFileUploader.prototype, 'stop');
    const { drive, app } = setup();
    const afterStart = run.mock.calls.length; // the start tick
    expect(drive.uploads).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(drive.created.map((f) => f.name)).toEqual(['Tracker.xlsx']);
    expect(run.mock.calls.length).toBe(afterStart + 1);
    expect(stop).not.toHaveBeenCalled();
    await stopApp(app);
    expect(stop).toHaveBeenCalledWith(10_000);
  });

  it('the tick retries a file upload that is due, and the finished upload publishes the workbook', async () => {
    const { db, drive, app } = setup({ prepare: (db, dataDir) => void storedClientDoc(db, dataDir) });
    // Only the client file's first try fails; the tracker uploads go through.
    const createFile = drive.createFile.bind(drive);
    let failures = 1;
    vi.spyOn(drive, 'createFile').mockImplementation(async (name, mime, body, parentId, timeoutMs) => {
      if (name !== 'Tracker.xlsx' && failures-- > 0) throw new Error('Drive unavailable');
      return createFile(name, mime, body, parentId, timeoutMs);
    });
    // The first publish creates the Drive root, then the uploader tries the file.
    await vi.waitFor(() =>
      expect(db.prepare('SELECT drive_file_id, drive_attempts, drive_failed FROM media').get()).toEqual({ drive_file_id: null, drive_attempts: 1, drive_failed: 0 }),
    );
    expect(drive.created.map((f) => f.name)).toEqual(['Tracker.xlsx']);
    // Due again 2 minutes later. Nothing else happens meanwhile: no message, no file, no publish.
    const { nextAt } = db.prepare('SELECT drive_next_at AS nextAt FROM media').get() as { nextAt: string };
    await vi.advanceTimersByTimeAsync(Date.parse(nextAt) - Date.now() - 1_000);
    expect(getMedia(db, 1)?.driveFileId).toBeNull();
    expect(drive.uploads).toBe(1);
    // The first tick after that retries it.
    await vi.advanceTimersByTimeAsync(31_000);
    await vi.waitFor(() => expect(getMedia(db, 1)?.driveFileId).toBeTruthy());
    expect(drive.created.map((f) => f.name)).toEqual(['Tracker.xlsx', 'brief.pdf']);
    // onUploaded schedules a publish, so Files received gets the Drive link without waiting for another change.
    await vi.waitFor(() => expect(drive.updated).toHaveLength(1));
    await stopApp(app);
  });

  it('a start gives uploads that gave up a fresh set of attempts', async () => {
    const { db, drive, app } = setup({
      prepare: (db, dataDir) => markUploadFailed(db, storedClientDoc(db, dataDir), { failed: true, nextAt: null }),
    });
    expect(db.prepare('SELECT drive_failed, drive_attempts FROM media').get()).toEqual({ drive_failed: 0, drive_attempts: 0 });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(getMedia(db, 1)?.driveFileId).toBeTruthy());
    expect(drive.created.map((f) => f.name)).toContain('brief.pdf');
    await stopApp(app);
  });
});

describe('app start time (15a, 15f)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T07:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it.each([
    ['started 40 minutes ago: the wait is over', minutesBefore(40), { blocks: false, stale: 1 }],
    ['no start time given: the wait counts from now', undefined, { blocks: true, stale: 0 }],
  ])('the reconciler and the health counts share the start time (%s)', async (_name, startedAt, expected) => {
    const sealer = new MediaRefSealer(randomBytes(32));
    const g = gate();
    const fetcher = vi.fn<MediaFetcher>(async () => {
      await g.promise; // the file stays pending while the test looks
      return Buffer.from('jpeg-bytes');
    });
    const { db, ai, app } = setup({ startedAt, media: { sealer, fetcher }, prepare: (db) => storedImage(db, sealer, minutesBefore(120).toISOString()) });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(readHealthSnapshot(db)!.media).toEqual({ pending: 1, stale: expected.stale, spendCap: 0, failedRecent: 0, uploadFailed: 0 });
    await vi.advanceTimersByTimeAsync(241_000);
    if (expected.blocks) expect(ai.calls).toHaveLength(0);
    else expect(ai.calls[0]!.user).toContain(': old banner {image, still being read}');
    g.release();
    await vi.waitFor(() => expect(getMedia(db, 1)?.status).toBe('done'));
    await stopApp(app);
  });

  it.each([
    ['started 25 hours ago: Claude has been unavailable too long', minutesBefore(25 * 60), { status: 'failed' }],
    ['no start time given: 24 hours from now', undefined, { status: 'pending' }],
  ])('the processor shares the start time (%s)', async (_name, startedAt, expected) => {
    const sealer = new MediaRefSealer(randomBytes(32));
    const extract = vi.fn<Extractor>(async () => {
      throw overloaded();
    });
    const { db, app } = setup({ startedAt, media: { sealer, extract }, prepare: (db) => storedImage(db, sealer, minutesBefore(26 * 60).toISOString()) });
    await vi.waitFor(() => expect(getMedia(db, 1)).toMatchObject({ ...expected, errorCode: 'ai_unavailable' }));
    await stopApp(app);
  });
});
