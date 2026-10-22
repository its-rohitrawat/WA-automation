import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { AiInvalidOutputError, AiRefusalError } from '../brain/claudeClient.ts';
import { neverSent, SpendCapReachedError } from '../brain/paidCall.ts';
import { getClient } from '../store/clients.ts';
import type { Db } from '../store/db.ts';
import { deferMedia, failMedia, finishMedia, getMedia, getMediaRef, markDownloaded, mediaJob, type MediaJob, type MediaRow } from '../store/media.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { readAsImage, type Extractor } from './extract.ts';
import { MediaDownloadError, MediaUnavailableError, type MediaFetcher } from './fetch.ts';
import { ParseError } from './parse/types.ts';
import { extForMime, mediaRelPath } from './paths.ts';
import { mediaRefAad, type MediaRefSealer } from './ref.ts';
import { MEDIA_LIMITS, type MediaRef } from './types.ts';

export type ProcessOutcome = 'done' | 'failed' | 'unavailable' | 'deferred' | 'skipped';

export interface ProcessResult {
  outcome: ProcessOutcome;
  clientId: number | null;
}

export const MEDIA_MAX_ATTEMPTS = 3;
/** Wait after the first and the second failed attempt; the third failure is final. */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000];
export const SPEND_RETRY_MS = 10 * 60_000;
/** Claude was busy or down and nothing was billed: waits that grow, then hourly (amendment 10d). */
const AI_UNAVAILABLE = 'ai_unavailable';
const AI_UNAVAILABLE_WAITS_MS = [5, 15, 30, 60].map((m) => m * 60_000);
/**
 * A file still unread because Claude is unavailable this long after it arrived, or after the service started if that
 * is later (amendment 10f), is given up.
 */
export const AI_UNAVAILABLE_MAX_AGE_MS = 24 * 60 * 60_000;

/** A file that can never be stored safely, for example because a different file already sits at its path. */
export class MediaFailedError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Media failed (${code})`);
    this.name = 'MediaFailedError';
    this.code = code;
  }
}

export interface MediaProcessorOptions {
  db: Db;
  dataDir: string;
  clock: Clock;
  log: Logger;
  sealer: MediaRefSealer;
  fetcher: MediaFetcher;
  extract: Extractor;
  limits?: { maxBytes: number; timeoutMs: number };
  /** When the service started; defaults to the clock's time at construction. Files loaded before it get 24 hours from it. */
  startedAt?: Date;
}

function retryCode(e: unknown): string {
  if (e instanceof MediaDownloadError) return e.code;
  if (e instanceof AiInvalidOutputError) return 'ai_invalid_output';
  if (e instanceof Anthropic.APIConnectionTimeoutError) return 'ai_timeout';
  if (e instanceof Anthropic.APIConnectionError) return 'ai_network';
  if (e instanceof Anthropic.APIError) return `ai_${e.status ?? 'error'}`;
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^E[A-Z]+$/.test(code) ? `disk_${code}` : 'unknown';
}

/**
 * A Claude error that was released, not billed: rate limited, a server error or overload, or a request that never
 * left this machine. Such a wait does not use up one of the file's attempts (amendment 10d). A timeout after sending
 * may have been billed, so it is not one of these.
 */
function claudeUnavailable(e: unknown): boolean {
  if (e instanceof Anthropic.APIConnectionError) return !(e instanceof Anthropic.APIConnectionTimeoutError) && neverSent(e);
  if (e instanceof Anthropic.RateLimitError) return true;
  return e instanceof Anthropic.APIError && typeof e.status === 'number' && e.status >= 500;
}

/**
 * The next wait while Claude stays unavailable. The row keeps no count of these waits, so the last one is read back
 * from the row: deferMedia stores both the time of the deferral (updatedAt) and the next attempt.
 */
function nextUnavailableWait(row: MediaRow): number {
  const first = AI_UNAVAILABLE_WAITS_MS[0]!;
  if (row.errorCode !== AI_UNAVAILABLE || row.nextAttemptAt === null) return first;
  const last = Date.parse(row.nextAttemptAt) - Date.parse(row.updatedAt);
  if (!Number.isFinite(last)) return first;
  return AI_UNAVAILABLE_WAITS_MS.find((w) => w > last) ?? AI_UNAVAILABLE_WAITS_MS[AI_UNAVAILABLE_WAITS_MS.length - 1]!;
}

const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Saves an original at `abs` without ever replacing a file there. The bytes go to a temp file in the same folder,
 * which is then hard-linked into place: a write that stops part way (a full disk, a crash) never leaves a partial
 * original at `abs`, where a later attempt would take it for a different file and fail the row for good.
 */
async function saveOriginal(abs: string, bytes: Buffer, sha256: string): Promise<void> {
  const tmp = `${abs}.${randomUUID()}.part`;
  try {
    await writeFile(tmp, bytes, { flag: 'wx' });
    try {
      await link(tmp, abs); // fails with EEXIST, never replaces
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  } finally {
    // Best effort: a temp file left behind is never read, and must not turn a saved original into a failure.
    await rm(tmp, { force: true }).catch(() => undefined);
  }
  // Left complete by an earlier attempt that stopped before saving its row: reuse it only if it is the same file.
  if (sha256Hex(await readFile(abs)) !== sha256) throw new MediaFailedError('path_conflict');
}

/** Downloads, saves and reads one pending file. Problems with the file never throw; they end in a status. */
export class MediaProcessor {
  readonly #o: MediaProcessorOptions;
  readonly #startedMs: number;

  constructor(o: MediaProcessorOptions) {
    this.#o = o;
    this.#startedMs = (o.startedAt ?? o.clock.now()).getTime();
  }

  async process(mediaId: number): Promise<ProcessResult> {
    const { db } = this.#o;
    const row = getMedia(db, mediaId);
    if (!row || row.status !== 'pending') return { outcome: 'skipped', clientId: row?.clientId ?? null };
    // A client taken off the allow-list: its files wait, untouched, until it is active again (amendment 10a).
    // The queue does not pick them up meanwhile (dueMediaIds), so this cannot loop.
    if (!getClient(db, row.clientId).active) return { outcome: 'skipped', clientId: row.clientId };
    const job = mediaJob(db, mediaId);
    if (!job) {
      // Its message is gone: the file can never be processed, so it must not stay pending (amendment 10b).
      failMedia(db, row.id, { status: 'failed', errorCode: 'no_job', at: this.#now() });
      this.#o.log.warn({ mediaId: row.id, clientId: row.clientId, errorCode: 'no_job' }, 'shared file has no message');
      return { outcome: 'failed', clientId: row.clientId };
    }
    try {
      return { outcome: await this.#run(row, job), clientId: row.clientId };
    } catch (e) {
      return { outcome: this.#settle(row, e), clientId: row.clientId };
    }
  }

  #now(): string {
    return this.#o.clock.now().toISOString();
  }

  #abs(rel: string): string {
    return join(this.#o.dataDir, ...rel.split('/'));
  }

  async #run(row: MediaRow, job: MediaJob): Promise<ProcessOutcome> {
    const { db } = this.#o;
    if (row.localPath === null && job.revoked) {
      // Deleted for everyone before we fetched it: do not fetch it now.
      failMedia(db, row.id, { status: 'unavailable', errorCode: 'revoked', at: this.#now() });
      return 'unavailable';
    }
    const bytes = row.localPath === null ? await this.#download(row, job) : await readFile(this.#abs(row.localPath));
    if (job.revoked) {
      finishMedia(db, row.id, { textKind: null, text: null, pageCount: null, note: 'revoked', at: this.#now() });
      return 'done';
    }
    // The original is saved and hashed already: a DOCX's bytes may be moved to the parser, so nothing reads them after this.
    const x = await this.#o.extract({ mediaId: row.id, kind: row.kind, mimeType: row.mimeType, fileName: row.fileName, forwarded: row.forwarded, bytes });
    finishMedia(db, row.id, { ...x, at: this.#now() });
    return 'done';
  }

  async #download(row: MediaRow, job: MediaJob): Promise<Buffer> {
    const { db, sealer, fetcher } = this.#o;
    const blob = getMediaRef(db, row.id);
    if (!blob) throw new MediaUnavailableError('no_ref');
    let ref: MediaRef;
    try {
      ref = sealer.open(blob, mediaRefAad(row.clientId, job.waId));
    } catch {
      throw new MediaUnavailableError('ref_unreadable');
    }
    const limits = this.#o.limits ?? { maxBytes: MEDIA_LIMITS.maxDownloadBytes, timeoutMs: MEDIA_LIMITS.downloadTimeoutMs };
    const bytes = await fetcher(ref, limits);
    const rel = mediaRelPath({ clientCode: job.clientCode, ts: job.ts, waId: job.waId, mediaId: row.id, ext: extForMime(row.mimeType, row.kind) });
    const abs = this.#abs(rel);
    const sha256 = sha256Hex(bytes);
    await mkdir(dirname(abs), { recursive: true });
    await saveOriginal(abs, bytes, sha256);
    markDownloaded(db, row.id, { localPath: rel, sha256, fileSize: bytes.length, at: this.#now() });
    return bytes;
  }

  #settle(row: MediaRow, e: unknown): ProcessOutcome {
    const { db, log } = this.#o;
    const at = this.#now();
    const ids = { mediaId: row.id, clientId: row.clientId };
    if (e instanceof SpendCapReachedError) {
      deferMedia(db, row.id, { errorCode: 'spend_cap', nextAttemptAt: new Date(Date.parse(at) + SPEND_RETRY_MS).toISOString(), countAttempt: false, at });
      log.info(ids, 'spend cap: shared file waits');
      return 'deferred';
    }
    if (e instanceof MediaUnavailableError) {
      failMedia(db, row.id, { status: 'unavailable', errorCode: e.code, at });
      log.info({ ...ids, errorCode: e.code }, 'shared file could not be downloaded');
      return 'unavailable';
    }
    if (e instanceof ParseError || e instanceof MediaFailedError || e instanceof AiRefusalError) {
      const errorCode = e instanceof AiRefusalError ? 'ai_refusal' : e.code;
      failMedia(db, row.id, { status: 'failed', errorCode, at });
      log.warn({ ...ids, errorCode }, 'shared file could not be read');
      return 'failed';
    }
    if (claudeUnavailable(e)) {
      if (Date.parse(at) - Math.max(Date.parse(row.createdAt), this.#startedMs) > AI_UNAVAILABLE_MAX_AGE_MS) {
        failMedia(db, row.id, { status: 'failed', errorCode: AI_UNAVAILABLE, at });
        log.warn({ ...ids, errorCode: AI_UNAVAILABLE, err: e }, 'shared file not read: Claude unavailable for 24 hours');
        return 'failed';
      }
      const waitMs = nextUnavailableWait(row);
      deferMedia(db, row.id, { errorCode: AI_UNAVAILABLE, nextAttemptAt: new Date(Date.parse(at) + waitMs).toISOString(), countAttempt: false, at });
      log.info({ ...ids, errorCode: AI_UNAVAILABLE, waitMinutes: waitMs / 60_000, err: e }, 'Claude unavailable: shared file waits');
      return 'deferred';
    }
    // Amendment 10e: a connection lost after sending is booked at the whole estimate. For a scan that is the scan
    // ceiling (about $4), booked again by every retry, so the scan fails for good; an image keeps its 3 attempts.
    // A document not read as an image calls Claude only to read a scanned PDF, so this error came from that read.
    if (e instanceof Anthropic.APIConnectionError && row.kind === 'document' && !readAsImage(row)) {
      const errorCode = retryCode(e); // ai_timeout or ai_network
      failMedia(db, row.id, { status: 'failed', errorCode, at });
      log.warn({ ...ids, errorCode }, 'scanned PDF not read: outcome unknown, not retried');
      return 'failed';
    }
    const errorCode = retryCode(e);
    const attempts = row.attempts + 1;
    if (attempts >= MEDIA_MAX_ATTEMPTS) {
      failMedia(db, row.id, { status: 'failed', errorCode, at });
      log.warn({ ...ids, errorCode, attempts, err: e }, 'shared file failed after retries');
      return 'failed';
    }
    const delay = RETRY_DELAYS_MS[attempts - 1] ?? 5 * 60_000;
    deferMedia(db, row.id, { errorCode, nextAttemptAt: new Date(Date.parse(at) + delay).toISOString(), countAttempt: true, at });
    log.warn({ ...ids, errorCode, attempts, err: e }, 'shared file will be retried');
    return 'deferred';
  }
}
