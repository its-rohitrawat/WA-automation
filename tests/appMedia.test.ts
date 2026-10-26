import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import Anthropic from '@anthropic-ai/sdk';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type AppMediaDeps } from '../src/app.ts';
import { Reconciler } from '../src/brain/reconciler.ts';
import { readHealthSnapshot } from '../src/health/health.ts';
import { imageEstimateUsd, scannedPdfCeilingUsd, type Extractor } from '../src/media/extract.ts';
import { MediaDownloadError, type MediaFetcher } from '../src/media/fetch.ts';
import { mediaRefAad, MediaRefSealer } from '../src/media/ref.ts';
import { DriveFileUploader } from '../src/media/uploader.ts';
import type { Prices } from '../src/spend/pricing.ts';
import { SpendGuard } from '../src/spend/spendGuard.ts';
import type { Db } from '../src/store/db.ts';
import { finishMedia, getMedia, insertMedia, markDownloaded, markUploadFailed, messageRowId } from '../src/store/media.ts';
import { insertMessage, listUnprocessed, markProcessed } from '../src/store/messages.ts';
import { setRole, upsertPerson } from '../src/store/people.ts';
import { LocalEngineError } from '../src/stt/local.ts';
import type { PreparedVoice, VoiceResult } from '../src/stt/voice.ts';
import { systemClock } from '../src/util/clock.ts';
import { createLogger, silentLogger, type Logger } from '../src/util/logger.ts';
import { AllowList } from '../src/wa/allowlist.ts';
import { openSessionDb, useEncryptedAuthState } from '../src/wa/authState.ts';
import { WhatsAppGateway } from '../src/wa/gateway.ts';
import { FakeAi } from './helpers/ai.ts';
import { MEHTA, seededDb, SHARMA } from './helpers/db.ts';
import { FakeDrive } from './helpers/fakeDrive.ts';
import { tinyPdf } from './helpers/files.ts';
import { FakeMediaAi } from './helpers/mediaAi.ts';
import { FakeSocket, SEND_METHODS } from './helpers/fakeSocket.ts';
import { FakeLocalVoiceTranscriber, FakeVoiceTranscriber } from './helpers/voice.ts';
import { SHARMA_PN, waRaw, waText } from './helpers/wa.ts';

/**
 * forgetVoiceCopies runs as it is, unless a test sets `forgetHook.impl` (Task 10: the start and hourly sweeps, and the
 * processor's afterFinish). Every call's options are recorded.
 */
const forgetHook = vi.hoisted(() => ({
  impl: null as null | ((...a: unknown[]) => Promise<number>),
  calls: [] as ({ mediaId?: number } | undefined)[],
}));
vi.mock('../src/media/voiceForget.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/media/voiceForget.ts')>();
  return {
    ...real,
    forgetVoiceCopies: (...args: Parameters<typeof real.forgetVoiceCopies>) => {
      forgetHook.calls.push(args[3]);
      return forgetHook.impl ? forgetHook.impl(...args) : real.forgetVoiceCopies(...args);
    },
  };
});

const P: Prices = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 };
const MEDIA_KEY = Buffer.alloc(32, 9);
const MINUTE = 60_000;
/** For a wait on real work (building the workbook, file I/O): the default 1 s is tight while the whole suite runs. */
const SLOW_IO = { timeout: 10_000 };
const dirs: string[] = [];

interface SetupOptions {
  media?: Partial<AppMediaDeps> | null;
  log?: Logger;
  startedAt?: Date;
  drainMs?: number;
  /** The workbook publish throttle. Default: the publisher's (60 s). */
  publishIntervalMs?: number;
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
    drainMs: o.drainMs, publishIntervalMs: o.publishIntervalMs,
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
    // The error code is written when the run ends (the claim before it counts the attempt already).
    await vi.waitFor(() => expect(getMedia(db, 1)).toMatchObject({ attempts: 1, errorCode: 'unknown' }));
    await stopApp(app);
    const out = lines.join('');
    expect(out).toContain('shared file will be retried');
    for (const s of ['mmg.whatsapp.net', '/v/t1', MEDIA_KEY.toString('base64'), 'new banner']) expect(out).not.toContain(s);
  });

  it('a shared file that cannot be stored is logged without its caption, address, media key or sender', async () => {
    const lines: string[] = [];
    const log = createLogger('info', new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } }));
    const { db, app, sock } = setup({ log });
    db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'cannot store'); END");
    shareImage(sock);
    await stopApp(app);
    const out = lines.join('');
    expect(out).toContain('ingest failed');
    expect(getMedia(db, 1)).toBeUndefined();
    for (const s of ['mmg.whatsapp.net', '/v/t1', MEDIA_KEY.toString('base64'), 'new banner', '919800000001', SHARMA.groupId]) {
      expect(out).not.toContain(s);
    }
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

  it('reads three files at once by default (Phase 2b Task 10)', async () => {
    const g = gate();
    const fetcher = vi.fn<MediaFetcher>(async () => {
      await g.promise;
      return Buffer.from('jpeg-bytes');
    });
    const { db, app, sock } = setup({ media: { fetcher } });
    for (const id of ['IMG1', 'IMG2', 'IMG3', 'IMG4']) shareImage(sock, id);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(app.mediaQueue!.active).toBe(3);
    g.release();
    await vi.waitFor(() => expect([1, 2, 3, 4].map((id) => getMedia(db, id)?.status)).toEqual(['done', 'done', 'done', 'done']));
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
    expect(booked[0]).toMatchObject({ kind: 'ai', detail: 'shutdown before the paid call finished (estimated)' });
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
    const fetcher = vi.fn<MediaFetcher>().mockRejectedValueOnce(new MediaDownloadError('http_503')).mockResolvedValue(Buffer.from('jpeg-bytes'));
    const { db, app, sock } = setup({ media: { fetcher } });
    shareImage(sock);
    await vi.waitFor(() => expect(getMedia(db, 1)).toMatchObject({ status: 'pending', attempts: 1, errorCode: 'http_503' }));
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
    expect(readHealthSnapshot(db)!.media).toEqual({ pending: 1, stale: 1, spendCap: 0, failedRecent: 0, uploadFailed: 0, sttRefused: 0 });
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

  it('a file that settles with no reconcile and no upload to follow still republishes the workbook, for Files received (review round 3)', async () => {
    const sealer = new MediaRefSealer(randomBytes(32));
    const g = gate();
    const extract = vi.fn<Extractor>(async () => {
      await g.promise;
      return NOTHING_READ; // no text, so its message is not queued again
    });
    const run = vi.spyOn(Reconciler.prototype, 'run');
    // A processed message whose file is still pending. Its sender is not a client member, so the file is not uploaded.
    const { db, ai, drive, app } = setup({
      media: { sealer, extract },
      publishIntervalMs: 1_000,
      prepare: (db) => {
        storedImage(db, sealer, '2026-10-19T06:55:00.000Z');
        markProcessed(db, [messageRowId(db, 1, 'IMG0')!], '2026-10-19T06:56:00.000Z');
      },
    });
    await vi.advanceTimersByTimeAsync(1_000); // the first publish
    await vi.waitFor(() => expect(extract).toHaveBeenCalled(), SLOW_IO);
    await vi.advanceTimersByTimeAsync(3_000); // any publish the start scheduled is done
    expect(drive.created.map((f) => f.name)).toEqual(['Tracker.xlsx']);
    const published = drive.updated.length;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(drive.updated).toHaveLength(published); // nothing else is publishing
    g.release();
    await vi.waitFor(() => expect(drive.updated).toHaveLength(published + 1), SLOW_IO);
    expect(Date.now()).toBeLessThan(Date.parse('2026-10-19T07:00:29Z')); // before the first tick after start
    expect(getMedia(db, 1)).toMatchObject({ status: 'done', textKind: null, driveFileId: null });
    expect(listUnprocessed(db, 1)).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(ai.calls).toHaveLength(0);
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

  /** Holds the client file's upload (never the tracker's) until the test releases it. */
  function gateClientUpload(drive: FakeDrive) {
    const g = gate();
    const state = { inFlight: false, release: g.release };
    const createFile = drive.createFile.bind(drive);
    vi.spyOn(drive, 'createFile').mockImplementation(async (name, mime, body, parentId, timeoutMs) => {
      if (name !== 'Tracker.xlsx') {
        state.inFlight = true;
        await g.promise;
      }
      return createFile(name, mime, body, parentId, timeoutMs);
    });
    return state;
  }

  it('stop() waits for the file upload in flight, so its Drive id is saved before stop() returns', async () => {
    let id = 0;
    const { db, drive, app } = setup({ prepare: (db, dataDir) => void (id = storedClientDoc(db, dataDir)) });
    const upload = gateClientUpload(drive);
    // The first publish creates the Drive root, then the uploader starts on the file.
    await vi.waitFor(() => expect(upload.inFlight).toBe(true), SLOW_IO);
    let stopped = false;
    let idWhenStopped: string | null | undefined;
    const p = app.stop().then(() => {
      stopped = true;
      idWhenStopped = getMedia(db, id)?.driveFileId;
    });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(stopped).toBe(false);
    upload.release();
    for (let i = 0; i < 30 && !stopped; i++) await vi.advanceTimersByTimeAsync(1_000);
    await p;
    // Without the wait, the file would reach Drive with no saved id and be uploaded again after the restart.
    expect(idWhenStopped).toBeTruthy();
    expect(drive.created.map((f) => f.name)).toEqual(['Tracker.xlsx', 'brief.pdf']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop() gives up on a file upload that never finishes after 10 s', async () => {
    let id = 0;
    const { db, drive, app } = setup({ prepare: (db, dataDir) => void (id = storedClientDoc(db, dataDir)) });
    const upload = gateClientUpload(drive);
    await vi.waitFor(() => expect(upload.inFlight).toBe(true), SLOW_IO);
    let stopped = false;
    const p = app.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stopped).toBe(true);
    await p;
    expect(getMedia(db, id)?.driveFileId).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    upload.release(); // the late answer still saves its id (the database is open in this test)
    await vi.waitFor(() => expect(getMedia(db, id)?.driveFileId).toBeTruthy(), SLOW_IO);
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

describe('app spend holds (Task 15 review round 3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T07:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const SPEND_LINE = '⚠️ Daily spend cap reached. Paused until midnight IST';

  const sharePdf = (sock: FakeSocket) =>
    sock.emit('messages.upsert', { type: 'notify', messages: [
      waRaw('PDF1', { documentMessage: { url: 'https://mmg.whatsapp.net/v/t2', directPath: '/v/t2', mediaKey: MEDIA_KEY, mimetype: 'application/pdf', fileName: 'quote.pdf' } }),
    ] });

  it('a scan read holding the budget delays another client’s run without the spend-cap line; the run follows within 10 minutes', async () => {
    const g = gate();
    const mediaAi = new FakeMediaAi();
    const readScan = vi.spyOn(mediaAi, 'readScannedPdf').mockImplementation(async () => {
      await g.promise;
      return { text: 'Quotation No. 17', usage: ZERO_USAGE, costUsd: 0.05, fallbackUsed: false };
    });
    const fetcher = vi.fn<MediaFetcher>(async () => tinyPdf([[]])); // one page with no text layer: a scan
    const run = vi.spyOn(Reconciler.prototype, 'run');
    // Under the $15 cap, the scan's hold (about $4.16) fits and leaves $0.10: less than a run's estimate (over $0.32),
    // though what is spent today leaves plenty of room for the run.
    const { db, ai, app, sock } = setup({
      media: { ai: mediaAi, fetcher, extract: undefined }, // the standard extractor
      prepare: (db) => new SpendGuard({ db, clock: systemClock, capUsd: 15 }).record('ai', 15 - scannedPdfCeilingUsd(P) - 0.1, 'earlier runs'),
    });
    sharePdf(sock);
    await vi.waitFor(() => expect(readScan).toHaveBeenCalled(), SLOW_IO);
    // Another client writes. Its run is due four minutes later, while the scan is still being read.
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('M1', 'please send the quote', { group: MEHTA.groupId })] });
    await vi.advanceTimersByTimeAsync(241_000);
    const mehta = run.mock.calls.findIndex(([clientId]) => clientId === 2);
    expect(mehta).toBeGreaterThanOrEqual(0);
    await expect(run.mock.results[mehta]!.value).resolves.toEqual({ status: 'busy' });
    expect(ai.calls).toHaveLength(0);
    expect(app.health.line()).toEqual({ ok: true, text: '✅ Connected · waiting for new messages' });
    await vi.advanceTimersByTimeAsync(30_000); // a tick saves the health report
    expect(readHealthSnapshot(db)!.line.text).not.toBe(SPEND_LINE);
    // The read finishes and frees its hold.
    g.release();
    await vi.waitFor(() => expect(getMedia(db, 1)?.status).toBe('done'));
    expect(app.health.line().text).not.toBe(SPEND_LINE);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(ai.calls.filter((c) => c.user.includes('please send the quote'))).toHaveLength(1);
    expect(listUnprocessed(db, 2)).toEqual([]);
    expect(app.health.line().text).not.toBe(SPEND_LINE);
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
    expect(readHealthSnapshot(db)!.media).toEqual({ pending: 1, stale: expected.stale, spendCap: 0, failedRecent: 0, uploadFailed: 0, sttRefused: 0 });
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
    // 10 s, not the default 1 s: under a busy full suite the first attempt can take longer to settle. The fake clock
    // moves at most 10 s here, far short of the 5-minute ai_unavailable wait, so the expected state cannot change.
    await vi.waitFor(() => expect(getMedia(db, 1)).toMatchObject({ ...expected, errorCode: 'ai_unavailable' }), { timeout: 10_000 });
    await stopApp(app);
  });
});

describe('app health line with fresh file counts (final review)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T07:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const STALE_LINE = '⚠️ 1 shared file waiting over 30 minutes to be read. See docs/SETUP.md.';

  /** Collects the body of every workbook upload (never a client file's), in order. */
  function workbookUploads(drive: FakeDrive): Buffer[] {
    const bodies: Buffer[] = [];
    const createFile = drive.createFile.bind(drive);
    const updateFile = drive.updateFile.bind(drive);
    vi.spyOn(drive, 'createFile').mockImplementation(async (name, mime, body, parentId, timeoutMs) => {
      const id = await createFile(name, mime, body, parentId, timeoutMs);
      if (name === 'Tracker.xlsx') bodies.push(body);
      return id;
    });
    vi.spyOn(drive, 'updateFile').mockImplementation(async (id, mime, body) => {
      await updateFile(id, mime, body);
      bodies.push(body);
    });
    return bodies;
  }

  /** Column-A text of the Overview sheet, where the health line lives. Call with real timers. */
  async function overviewTexts(buf: Buffer): Promise<string[]> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
    const out: string[] = [];
    wb.getWorksheet('Overview')!.eachRow((row) => {
      const v = row.getCell(1).value;
      if (typeof v === 'string') out.push(v);
    });
    return out;
  }

  it('a settled file publishes fresh file counts: its stale warning is gone from the workbook before the next tick', async () => {
    const sealer = new MediaRefSealer(randomBytes(32));
    const g = gate();
    const extract = vi.fn<Extractor>(async () => {
      await g.promise;
      return NOTHING_READ; // no text, so its message is not queued again and no reconcile publishes after it
    });
    // A file waiting over 30 minutes, whose message was already processed. Its sender is not a client member, so no
    // upload publishes after it either.
    const { db, drive, app } = setup({
      media: { sealer, extract },
      publishIntervalMs: 1_000,
      startedAt: minutesBefore(40),
      prepare: (db) => {
        storedImage(db, sealer, minutesBefore(40).toISOString());
        markProcessed(db, [messageRowId(db, 1, 'IMG0')!], minutesBefore(39).toISOString());
      },
    });
    const bodies = workbookUploads(drive);
    await vi.advanceTimersByTimeAsync(1_000); // the first publish
    await vi.waitFor(() => expect(extract).toHaveBeenCalled(), SLOW_IO);
    await vi.advanceTimersByTimeAsync(3_000); // any publish the start scheduled is done
    expect(bodies.length).toBeGreaterThan(0);
    const published = bodies.length;
    g.release();
    await vi.waitFor(() => expect(bodies).toHaveLength(published + 1), SLOW_IO);
    expect(Date.now()).toBeLessThan(Date.parse('2026-10-19T07:00:29Z')); // before the first tick after start
    expect(getMedia(db, 1)).toMatchObject({ status: 'done', textKind: null });
    const before = bodies[published - 1]!;
    const after = bodies[published]!;
    await stopApp(app);

    vi.useRealTimers();
    expect(await overviewTexts(before)).toContain(STALE_LINE);
    const texts = await overviewTexts(after);
    expect(texts).not.toContain(STALE_LINE);
    expect(texts).toContain('✅ Connected · waiting for new messages');
  });

  it('removing a client takes its files out of the health counts before the publish', async () => {
    const sealer = new MediaRefSealer(randomBytes(32));
    const extract = vi.fn<Extractor>(async () => {
      throw overloaded(); // the file waits for Claude and stays pending
    });
    const { db, app } = setup({
      media: { sealer, extract },
      startedAt: minutesBefore(40),
      prepare: (db) => storedImage(db, sealer, minutesBefore(40).toISOString()),
    });
    await vi.waitFor(() => expect(getMedia(db, 1)).toMatchObject({ status: 'pending', errorCode: 'ai_unavailable' }), SLOW_IO);
    expect(app.health.workbookLine().text).toBe(STALE_LINE);

    app.reloadClients([MEHTA]); // Sharma, whose file it is, is removed
    expect(app.health.workbookLine()).toEqual({ ok: true, text: '✅ Connected · waiting for new messages' });
    expect(readHealthSnapshot(db)!.media).toMatchObject({ pending: 0, stale: 0 });
    await stopApp(app);
  });
});

/** A WhatsApp voice note of 0:14 (an audioMessage with ptt), from Mr. Sharma in client SHA's group. */
const shareVoice = (sock: FakeSocket, waId = 'VN1') =>
  sock.emit('messages.upsert', { type: 'notify', messages: [
    waRaw(waId, { audioMessage: { url: 'https://mmg.whatsapp.net/v/t9', directPath: '/v/t9', mediaKey: MEDIA_KEY, mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: 14 } }),
  ] });

/** A local transcriber whose runs wait for `g.release`, then answer as the fake does. */
class GatedLocalVoice extends FakeLocalVoiceTranscriber {
  readonly g = gate();
  entered = 0;
  override async transcribe(prepared: PreparedVoice, signal?: AbortSignal): Promise<VoiceResult> {
    this.entered++;
    await this.g.promise;
    return super.transcribe(prepared, signal);
  }
}

/** A local transcriber whose run lasts until the stop signal, then ends as the real engine does (LocalEngineError('aborted')). */
class UntilAbortedLocalVoice extends FakeLocalVoiceTranscriber {
  entered = 0;
  override transcribe(_prepared: PreparedVoice, signal?: AbortSignal): Promise<VoiceResult> {
    this.entered++;
    this.signals.push(signal);
    return new Promise<never>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new LocalEngineError('aborted')), { once: true });
    });
  }
}

describe('app voice notes (Phase 2b Task 10)', () => {
  const HOUR = 60 * MINUTE;
  const ledger = (db: Db) => db.prepare('SELECT kind FROM spend ORDER BY id').all() as { kind: string }[];
  const sweeps = () => forgetHook.calls.filter((o) => o?.mediaId === undefined).length;
  const capture = () => {
    const lines: string[] = [];
    const log = createLogger('info', new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } }));
    return { log, out: () => lines.join('') };
  };
  const NOT_SET_UP = '⚠️ Voice notes are not being transcribed: the local speech engine is not set up (STT_LOCAL_BIN)';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T07:00:00Z'));
    forgetHook.impl = null;
    forgetHook.calls.length = 0;
  });
  afterEach(() => {
    forgetHook.impl = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('a voice note flows end to end through the local engine: the prompt holds the transcript, and nothing is booked', async () => {
    const voice = new FakeLocalVoiceTranscriber({ results: [{ text: 'payment bhej diya' }] });
    const { db, ai, app, sock } = setup({ media: { voice, maxVoiceSeconds: 300, extract: undefined } });
    shareVoice(sock);
    await vi.waitFor(() => expect(getMedia(db, 1)).toMatchObject({ status: 'done', kind: 'voice', text: 'payment bhej diya' }), SLOW_IO);
    expect(voice.prepared[0]!.maxSeconds).toBe(300); // maxVoiceSeconds reaches the extractor
    expect(voice.signals[0]).toBeInstanceOf(AbortSignal); // the stop signal reaches the local run
    expect(voice.signals[0]!.aborted).toBe(false);
    expect(voice.priced).toBe(0);
    expect(ledger(db)).toEqual([]); // free: no spend row
    await vi.advanceTimersByTimeAsync(240_000);
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]!.user).toContain('{voice note, 0:14, transcript: payment bhej diya}');
    expect(ledger(db).map((r) => r.kind)).toEqual(['ai']); // only the reconcile
    await stopApp(app);
  });

  it('with a paid transcriber, the note is booked as speech-to-text', async () => {
    const voice = new FakeVoiceTranscriber({ provider: 'sarvam', results: [{ text: 'kal tak bhej dena' }] });
    const { db, app, sock } = setup({ media: { voice, extract: undefined } });
    shareVoice(sock);
    await vi.waitFor(() => expect(getMedia(db, 1)).toMatchObject({ status: 'done', text: 'kal tak bhej dena' }), SLOW_IO);
    expect(voice.transcribed).toBe(1);
    expect(ledger(db).map((r) => r.kind)).toEqual(['stt']);
    await stopApp(app);
  });

  it('without a voice transcriber, a voice note finishes without text, as in 2a', async () => {
    const { db, ai, app, sock } = setup({ media: { extract: undefined } });
    shareVoice(sock);
    await vi.waitFor(() => expect(getMedia(db, 1)).toMatchObject({ status: 'done', text: null, note: null }), SLOW_IO);
    await vi.advanceTimersByTimeAsync(240_000);
    expect(ai.calls[0]!.user).toContain('{voice note, 0:14, not transcribed}');
    await stopApp(app);
  });

  it('the local engine gets 3 runs (voicePaid false): a note whose runs all fail fails after the third', async () => {
    const voice = new FakeLocalVoiceTranscriber({ results: [new LocalEngineError('timeout'), new LocalEngineError('timeout'), new LocalEngineError('timeout')] });
    const { db, app, sock } = setup({ media: { voice, extract: undefined } });
    shareVoice(sock);
    await vi.waitFor(() => expect(getMedia(db, 1)).toMatchObject({ status: 'pending', attempts: 1, errorCode: 'local_timeout' }), SLOW_IO);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    await vi.waitFor(() => expect(getMedia(db, 1)).toMatchObject({ status: 'pending', attempts: 2 }), SLOW_IO);
    await vi.advanceTimersByTimeAsync(6 * MINUTE);
    await vi.waitFor(() => expect(getMedia(db, 1)).toMatchObject({ status: 'failed', attempts: 3, errorCode: 'local_timeout' }), SLOW_IO);
    expect(voice.transcribed).toBe(3);
    await stopApp(app);
  });

  it('a paid transcriber keeps the paid path’s 2 runs (voicePaid true)', async () => {
    const voice = new FakeVoiceTranscriber({ provider: 'sarvam', results: [new LocalEngineError('exit_1'), new LocalEngineError('exit_1'), new LocalEngineError('exit_1')] });
    const { db, app, sock } = setup({ media: { voice, extract: undefined } });
    shareVoice(sock);
    await vi.waitFor(() => expect(getMedia(db, 1)).toMatchObject({ status: 'pending', attempts: 1 }), SLOW_IO);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    await vi.waitFor(() => expect(getMedia(db, 1)).toMatchObject({ status: 'failed', attempts: 2 }), SLOW_IO);
    expect(voice.transcribed).toBe(2);
    await stopApp(app);
  });

  it('with the local engine, one voice note at a time takes a media slot: images use the others', async () => {
    const g = gate();
    const fetcher = vi.fn<MediaFetcher>(async () => {
      await g.promise;
      return Buffer.from('bytes');
    });
    const voice = new FakeLocalVoiceTranscriber();
    const { app, sock } = setup({ media: { voice, fetcher, extract: undefined } });
    for (const id of ['VN1', 'VN2', 'VN3']) shareVoice(sock, id);
    for (const id of ['IMG1', 'IMG2']) shareImage(sock, id);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.map(([ref]) => ref.contentType).sort()).toEqual(['audioMessage', 'imageMessage', 'imageMessage']);
    expect(app.mediaQueue!.active).toBe(3);
    g.release();
    await vi.waitFor(() => expect(app.mediaQueue!.active).toBe(0), SLOW_IO);
    await stopApp(app);
  });

  it('with a paid transcriber there is no voice lane: voice notes may take every slot', async () => {
    const g = gate();
    const fetcher = vi.fn<MediaFetcher>(async () => {
      await g.promise;
      return Buffer.from('bytes');
    });
    const { app, sock } = setup({ media: { voice: new FakeVoiceTranscriber(), fetcher, extract: undefined } });
    for (const id of ['VN1', 'VN2', 'VN3']) shareVoice(sock, id);
    shareImage(sock, 'IMG1');
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(fetcher.mock.calls.map(([ref]) => ref.contentType)).toEqual(['audioMessage', 'audioMessage', 'audioMessage']);
    g.release();
    await vi.waitFor(() => expect(app.mediaQueue!.active).toBe(0), SLOW_IO);
    await stopApp(app);
  });

  it('stop() aborts a local run in flight before the drain: the note waits for the restart, its attempt given back', async () => {
    const voice = new UntilAbortedLocalVoice();
    const { db, app, sock } = setup({ media: { voice, extract: undefined }, drainMs: 60_000 });
    shareVoice(sock);
    await vi.waitFor(() => expect(voice.entered).toBe(1), SLOW_IO);
    expect(voice.signals[0]!.aborted).toBe(false);
    let stopped = false;
    const p = app.stop().then(() => {
      stopped = true;
    });
    expect(voice.signals[0]!.aborted).toBe(true);
    // Not the 60 s drain: the run ends at once; then the last publish and WhatsApp's close.
    for (let i = 0; i < 20 && !stopped; i++) await vi.advanceTimersByTimeAsync(1_000);
    expect(stopped).toBe(true);
    await p;
    expect(getMedia(db, 1)).toMatchObject({ status: 'pending', attempts: 0, errorCode: 'local_aborted' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('start() sweeps the voice copies once for all rows, then hourly; stop() ends the hourly sweep', async () => {
    const { app } = setup();
    expect(sweeps()).toBe(1);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(sweeps()).toBe(2);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(sweeps()).toBe(3);
    await stopApp(app);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3 * HOUR);
    expect(sweeps()).toBe(3);
  });

  it('the sweep goes through the voice transcriber: a due copy is deleted at start', async () => {
    const voice = new FakeVoiceTranscriber({ provider: 'elevenlabs' });
    const { db, app } = setup({
      media: { voice },
      prepare: (db) => {
        insertMessage(db, {
          waId: 'V0', clientId: 1, senderJid: SHARMA_PN, senderNumber: '1', senderName: 'A', fromMe: false, ts: '2026-10-19T06:00:00.000Z', text: null,
          quotedWaId: null, mediaType: 'voice',
        });
        const mediaId = insertMedia(db, {
          messageId: messageRowId(db, 1, 'V0')!, clientId: 1, kind: 'voice', status: 'done', mimeType: 'audio/ogg', fileName: null, fileSize: 9000, seconds: 12,
          forwarded: false, refEnc: null, errorCode: null, createdAt: '2026-10-19T06:00:00.000Z',
        });
        db.prepare('INSERT INTO media_stt_forget (media_id, provider, ref, created_at, attempts) VALUES (?, ?, ?, ?, 0)').run(mediaId, 'elevenlabs', 'tr-old', '2026-10-19T06:00:00.000Z');
      },
    });
    await vi.waitFor(() => expect(voice.forgotten).toEqual(['tr-old']));
    expect(db.prepare('SELECT COUNT(*) AS n FROM media_stt_forget').get()).toEqual({ n: 0 });
    await stopApp(app);
  });

  it('a sweep that fails, at start or hourly, sync or async, is logged with a code only and never thrown', async () => {
    const { log, out } = capture();
    const boom = () => Object.assign(new Error('database is locked at C:\\secret\\tracker.db'), { code: 'SQLITE_BUSY' });
    let n = 0;
    forgetHook.impl = () => {
      if (++n === 1) throw boom(); // a sync throw at start
      return Promise.reject(boom());
    };
    const { app } = setup({ log });
    expect(sweeps()).toBe(1);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(sweeps()).toBe(2);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(sweeps()).toBe(3); // a failed sweep does not stop the next one
    await stopApp(app);
    expect(out().match(/voice copy sweep failed/g)?.length).toBe(3);
    expect(out()).toContain('"code":"SQLITE_BUSY"');
    expect(out()).not.toContain('secret');
    expect(out()).not.toContain('database is locked');
  });

  it('an hourly sweep is skipped while the previous one still runs', async () => {
    const g = gate();
    forgetHook.impl = async () => {
      await g.promise;
      return 0;
    };
    const { app } = setup();
    expect(sweeps()).toBe(1);
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(sweeps()).toBe(1);
    g.release();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(sweeps()).toBe(2);
    await stopApp(app);
  });

  it('without the media pipeline nothing is swept', async () => {
    const { app } = setup({ media: null });
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(forgetHook.calls).toEqual([]);
    await stopApp(app);
  });

  it('afterFinish deletes the copy a paid transcript left, for that file only', async () => {
    const voice = new FakeVoiceTranscriber({ provider: 'elevenlabs', results: [{ text: 'theek hai', forgetRef: 'tr-1' }] });
    const { db, app, sock } = setup({ media: { voice, extract: undefined } });
    shareVoice(sock);
    await vi.waitFor(() => expect(getMedia(db, 1)?.status).toBe('done'), SLOW_IO);
    await vi.waitFor(() => expect(voice.forgotten).toEqual(['tr-1']));
    expect(forgetHook.calls.some((o) => o?.mediaId === 1)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM media_stt_forget').get()).toEqual({ n: 0 });
    await stopApp(app);
  });

  it('afterFinish is not asked to delete anything for a local transcript (it keeps no copies)', async () => {
    const voice = new FakeLocalVoiceTranscriber();
    const { db, app, sock } = setup({ media: { voice, extract: undefined } });
    shareVoice(sock);
    await vi.waitFor(() => expect(getMedia(db, 1)?.status).toBe('done'), SLOW_IO);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(forgetHook.calls.some((o) => o?.mediaId !== undefined)).toBe(false);
    await stopApp(app);
  });

  it('an afterFinish whose delete fails is logged with a code only; the file stays done and the copy stays noted', async () => {
    const { log, out } = capture();
    forgetHook.impl = (...a: unknown[]) =>
      (a[3] as { mediaId?: number } | undefined)?.mediaId === undefined
        ? Promise.resolve(0)
        : Promise.reject(Object.assign(new Error('C:\\secret'), { code: 'SQLITE_BUSY' }));
    const voice = new FakeVoiceTranscriber({ provider: 'elevenlabs', results: [{ text: 'theek hai', forgetRef: 'tr-1' }] });
    const { db, app, sock } = setup({ log, media: { voice, extract: undefined } });
    shareVoice(sock);
    await vi.waitFor(() => expect(getMedia(db, 1)?.status).toBe('done'), SLOW_IO);
    await vi.waitFor(() => expect(out()).toContain('voice note speech copy not deleted yet'));
    expect(out()).toContain('"code":"SQLITE_BUSY"');
    expect(out()).not.toContain('secret');
    expect(db.prepare('SELECT COUNT(*) AS n FROM media_stt_forget').get()).toEqual({ n: 1 }); // left for the sweep
    await stopApp(app);
  });

  it('start() removes leftover voice-<digits> folders in DATA_DIR/tmp/voice, before the queue starts, and nothing else', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'wa-app-media-outside-'));
    dirs.push(outside);
    writeFileSync(join(outside, 'keep.txt'), 'keep');
    const { dataDir, app } = setup({
      prepare: (_db, dataDir) => {
        const voiceDir = join(dataDir, 'tmp', 'voice');
        for (const d of ['voice-12', 'voice-7', 'voice-12x', 'voice-', 'other', join('other', 'voice-4')]) mkdirSync(join(voiceDir, d), { recursive: true });
        writeFileSync(join(voiceDir, 'voice-12', 'audio.wav'), 'client audio');
        writeFileSync(join(voiceDir, 'voice-99'), 'a file, not a folder');
        writeFileSync(join(voiceDir, 'notes.txt'), 'x');
        mkdirSync(join(dataDir, 'tmp', 'meetings', 'voice-3'), { recursive: true });
        symlinkSync(outside, join(voiceDir, 'voice-55'), 'junction'); // a link is never followed, nor removed
      },
    });
    // Synchronously inside start(), so before the first tick starts any file.
    const voiceDir = join(dataDir, 'tmp', 'voice');
    expect(readdirSync(voiceDir).sort()).toEqual(['notes.txt', 'other', 'voice-', 'voice-12x', 'voice-55', 'voice-99']);
    expect(existsSync(join(voiceDir, 'other', 'voice-4'))).toBe(true);
    expect(existsSync(join(dataDir, 'tmp', 'meetings', 'voice-3'))).toBe(true);
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    unlinkSync(join(voiceDir, 'voice-55')); // the link only, before the folders are cleaned up
    await stopApp(app);
  });

  it('a folder sweep that cannot run is logged with a code only; a missing folder is not a failure', async () => {
    const { log, out } = capture();
    const { app, dataDir } = setup({
      log,
      prepare: (_db, dataDir) => {
        mkdirSync(join(dataDir, 'tmp'), { recursive: true });
        writeFileSync(join(dataDir, 'tmp', 'voice'), 'not a folder');
      },
    });
    expect(out()).toContain('leftover voice folders not removed');
    expect(out()).toContain('"code":"voice_tmp_not_plain_folder"');
    expect(out()).not.toContain(dataDir.replaceAll('\\', '\\\\'));
    await stopApp(app);
    const quiet = capture();
    const second = setup({ log: quiet.log });
    expect(quiet.out()).not.toContain('leftover voice folders not removed');
    await stopApp(second.app);
  });

  it('the voice problem found at start reaches the health line', async () => {
    const { db, app } = setup({ media: { voiceProblem: 'local_not_set_up_bin' } });
    expect(readHealthSnapshot(db)!.voiceProblem).toBe('local_not_set_up_bin');
    expect(readHealthSnapshot(db)!.line.text).toBe(NOT_SET_UP);
    await stopApp(app);
    const other = setup({ media: { voiceProblem: 'no_ffmpeg' } });
    expect(readHealthSnapshot(other.db)!.line.text).toBe('⚠️ Voice notes are not being transcribed: ffmpeg not found');
    await stopApp(other.app);
  });

  /** Makes `link` a junction (Windows) or symlink to `target`; false where links cannot be made here. */
  const tryLink = (target: string, link: string): boolean => {
    try {
      symlinkSync(target, link, 'junction');
      return true;
    } catch {
      return false;
    }
  };

  it.for([
    ['DATA_DIR/tmp', ['tmp']],
    ['DATA_DIR/tmp/voice', ['tmp', 'voice']],
  ] as const)('the folder sweep is skipped, logging a code, when %s is a link or junction: nothing behind it is touched', async ([, parts], ctx) => {
    const outside = mkdtempSync(join(tmpdir(), 'wa-app-media-outside-'));
    dirs.push(outside);
    // The link's target, laid out as the part of DATA_DIR/tmp/voice it stands for.
    const behind = parts.length === 1 ? join(outside, 'voice') : outside;
    mkdirSync(join(behind, 'voice-1'), { recursive: true });
    writeFileSync(join(behind, 'voice-1', 'audio.wav'), 'someone else’s audio');
    const { log, out } = capture();
    let linked = false;
    let link = '';
    const { app } = setup({
      log,
      prepare: (_db, dataDir) => {
        if (parts.length === 2) mkdirSync(join(dataDir, 'tmp'), { recursive: true });
        link = join(dataDir, ...parts);
        linked = tryLink(outside, link);
      },
    });
    if (!linked) {
      await stopApp(app);
      ctx.skip();
      return;
    }
    expect(existsSync(join(behind, 'voice-1', 'audio.wav'))).toBe(true);
    expect(out()).toContain('leftover voice folders not removed');
    expect(out()).toContain('"code":"voice_tmp_not_plain_folder"');
    expect(out()).not.toContain('outside');
    unlinkSync(link); // the link only, before the folders are cleaned up
    await stopApp(app);
    expect(existsSync(join(behind, 'voice-1', 'audio.wav'))).toBe(true);
  });

  it('without a voice transcriber (VOICE_STT_PROVIDER none), a voice note gets 3 runs, as in 2a', async () => {
    const fetcher = vi.fn<MediaFetcher>(async () => {
      throw new MediaDownloadError('http_503');
    });
    const { db, app, sock } = setup({ media: { voice: null, fetcher, extract: undefined } });
    shareVoice(sock);
    await vi.waitFor(() => expect(getMedia(db, 1)).toMatchObject({ status: 'pending', attempts: 1, errorCode: 'http_503' }), SLOW_IO);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    await vi.waitFor(() => expect(getMedia(db, 1)).toMatchObject({ status: 'pending', attempts: 2 }), SLOW_IO);
    await vi.advanceTimersByTimeAsync(6 * MINUTE);
    await vi.waitFor(() => expect(getMedia(db, 1)).toMatchObject({ status: 'failed', attempts: 3, errorCode: 'http_503' }), SLOW_IO);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await stopApp(app);
  });

  it('the hourly sweep warns provider_unavailable once per leftover copy, not every hour', async () => {
    const { log, out } = capture();
    const { app } = setup({
      log,
      media: { voice: new FakeLocalVoiceTranscriber() }, // switched to local: the elevenlabs copy cannot be deleted now
      prepare: (db) => {
        insertMessage(db, {
          waId: 'V0', clientId: 1, senderJid: SHARMA_PN, senderNumber: '1', senderName: 'A', fromMe: false, ts: '2026-10-19T06:00:00.000Z', text: null,
          quotedWaId: null, mediaType: 'voice',
        });
        const mediaId = insertMedia(db, {
          messageId: messageRowId(db, 1, 'V0')!, clientId: 1, kind: 'voice', status: 'done', mimeType: 'audio/ogg', fileName: null, fileSize: 9000, seconds: 12,
          forwarded: false, refEnc: null, errorCode: null, createdAt: '2026-10-19T06:00:00.000Z',
        });
        db.prepare('INSERT INTO media_stt_forget (media_id, provider, ref, created_at, attempts) VALUES (?, ?, ?, ?, 0)').run(mediaId, 'elevenlabs', 'tr-old', '2026-10-19T06:00:00.000Z');
      },
    });
    await vi.advanceTimersByTimeAsync(3 * HOUR);
    expect(sweeps()).toBe(4);
    expect(out().match(/"code":"provider_unavailable"/g)?.length).toBe(1);
    await stopApp(app);
  });

  /** Runs app.stop() and reports whether it has resolved. */
  const stopping = (app: { stop(): Promise<void> }) => {
    const s = { done: false, p: Promise.resolve() };
    s.p = app.stop().then(() => {
      s.done = true;
    });
    return s;
  };

  it('stop() waits for a copy sweep in flight before it returns (so before the database closes)', async () => {
    const g = gate();
    let sweepDone = false;
    forgetHook.impl = async () => {
      await g.promise;
      sweepDone = true;
      return 0;
    };
    const { app } = setup();
    const s = stopping(app);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(s.done).toBe(false);
    g.release();
    for (let i = 0; i < 30 && !s.done; i++) await vi.advanceTimersByTimeAsync(1_000);
    await s.p;
    expect(sweepDone).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop() waits for an afterFinish delete in flight', async () => {
    const g = gate();
    let deleteDone = false;
    forgetHook.impl = async (...a: unknown[]) => {
      if ((a[3] as { mediaId?: number } | undefined)?.mediaId === undefined) return 0;
      await g.promise;
      deleteDone = true;
      return 1;
    };
    const voice = new FakeVoiceTranscriber({ provider: 'elevenlabs', results: [{ text: 'theek hai', forgetRef: 'tr-1' }] });
    const { db, app, sock } = setup({ media: { voice, extract: undefined } });
    shareVoice(sock);
    await vi.waitFor(() => expect(getMedia(db, 1)?.status).toBe('done'), SLOW_IO);
    await vi.waitFor(() => expect(forgetHook.calls.some((o) => o?.mediaId === 1)).toBe(true));
    const s = stopping(app);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(s.done).toBe(false);
    g.release();
    for (let i = 0; i < 30 && !s.done; i++) await vi.advanceTimersByTimeAsync(1_000);
    await s.p;
    expect(deleteDone).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop() waits for a copy deletion at most 5 s, then logs a code and goes on', async () => {
    const { log, out } = capture();
    forgetHook.impl = () => new Promise<number>(() => {}); // never ends
    const { app } = setup({ log });
    const s = stopping(app);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(s.done).toBe(false);
    for (let i = 0; i < 30 && !s.done; i++) await vi.advanceTimersByTimeAsync(1_000);
    await s.p;
    expect(s.done).toBe(true);
    expect(out()).toContain('"code":"forget_in_flight"');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a late transcript (12h): a note still being transcribed when its message was processed re-queues the message as a re-check', async () => {
    const voice = new GatedLocalVoice({ results: [{ text: 'payment kal tak ho jayega' }] });
    const { db, ai, app, sock } = setup({ media: { voice, extract: undefined } });
    shareVoice(sock);
    await vi.waitFor(() => expect(voice.entered).toBe(1), SLOW_IO);
    // V1: the note blocks its client's update for 30 minutes, then the update goes on without it.
    await vi.advanceTimersByTimeAsync(36 * MINUTE); // the wait, then the debouncer's quiet time
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]!.user).toContain('{voice note, 0:14, being transcribed}');
    expect(ai.calls[0]!.user).not.toContain('(re-check: file now read)');
    expect(listUnprocessed(db, 1)).toEqual([]);
    voice.g.release();
    await vi.waitFor(() => expect(getMedia(db, 1)).toMatchObject({ status: 'done', text: 'payment kal tak ho jayega' }), SLOW_IO);
    await vi.waitFor(() => expect(listUnprocessed(db, 1)).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(241_000);
    expect(ai.calls).toHaveLength(2);
    expect(ai.calls[1]!.user).toContain('(re-check: file now read)');
    expect(ai.calls[1]!.user).toContain('{voice note, 0:14, transcript: payment kal tak ho jayega}');
    await stopApp(app);
  });
});
