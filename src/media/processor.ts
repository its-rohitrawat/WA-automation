import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { AiInvalidOutputError, AiRefusalError } from '../brain/claudeClient.ts';
import { neverSent, SpendCapReachedError } from '../brain/paidCall.ts';
import { getClient } from '../store/clients.ts';
import type { Db } from '../store/db.ts';
import { claimMedia, deferMedia, failMedia, finishMedia, getMedia, getMediaRef, markDownloaded, mediaJob, type MediaJob, type MediaRow } from '../store/media.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { isScanReadError, type Extractor } from './extract.ts';
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
/**
 * How far the claim before a run moves the file's next attempt (final review FR1): longer than any one run, whose
 * slowest step, a scan read, gives up after 10 minutes. A run that never ended is tried again after this.
 */
export const CLAIM_MS = 15 * 60_000;
/** A file whose runs never ended MEDIA_MAX_ATTEMPTS times: each one stopped the process, for example in a decoder. */
const CRASHED = 'crashed';
/** Wait after the first and the second failed attempt; the third failure is final. */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000];
export const SPEND_RETRY_MS = 10 * 60_000;
/** Claude was busy, down or refused the key, and nothing was billed: waits that grow, then hourly (amendment 10d). */
const AI_UNAVAILABLE = 'ai_unavailable';
/**
 * The waits that grow, then hourly, of a problem that may pass and costs nothing to try again: Claude unavailable
 * (amendment 10d), or a download that cannot reach WhatsApp or a disk that refuses the file (final review FR2).
 */
const GROWING_WAITS_MS = [5, 15, 30, 60].map((m) => m * 60_000);
/**
 * A file still unread because Claude is unavailable, or still not downloaded and saved because of the network or the
 * disk, this long after it arrived, or after the service started if that is later (amendment 10f), is given up.
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
 * A Claude error that was released, not billed: rate limited, a server error or overload, a rejected or revoked key
 * (401, 403: the owner can fix it, and the file should still be read then), or a request that never left this machine.
 * Such a wait does not use up one of the file's attempts (amendment 10d). A timeout after sending may have been billed,
 * so it is not one of these.
 */
function claudeUnavailable(e: unknown): boolean {
  if (e instanceof Anthropic.APIConnectionError) return !(e instanceof Anthropic.APIConnectionTimeoutError) && neverSent(e);
  if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return true;
  return e instanceof Anthropic.APIError && typeof e.status === 'number' && e.status >= 500;
}

/** Error codes of a download or disk problem that waits without counting an attempt (final review FR2). */
const isOutageCode = (code: string | null): boolean => code === 'network' || code === 'timeout' || (code?.startsWith('disk_') ?? false);

/**
 * Errors met while the original was downloaded, saved, or read back from disk: before anything was decoded or paid
 * for. Noted, not wrapped, so the error itself still reaches #settle.
 */
const beforeReading = new WeakSet<object>();

/**
 * A download that could not reach WhatsApp (no network, or too slow: 'network', 'timeout'), or a disk that would not
 * take the original or give it back (full, locked by an antivirus: disk_*). Nothing was decoded or paid for, and it may
 * pass, so it waits without counting an attempt (final review FR2). Other statuses from the media host (http_5xx) keep
 * the counted retries. A disk error after the read started counts: that read could have been paid for.
 */
function outage(e: unknown): boolean {
  if (typeof e !== 'object' || e === null || !beforeReading.has(e)) return false;
  return e instanceof MediaDownloadError ? e.code === 'network' || e.code === 'timeout' : retryCode(e).startsWith('disk_');
}

/**
 * The next of the growing waits while the same kind of problem lasts (`same` tells it by the row's error code). The row
 * keeps no count of these waits, so the last one is read back from the row: deferMedia stores both the time of the
 * deferral (updatedAt) and the next attempt. `row` is the file as it was before the claim.
 */
function nextGrowingWait(row: MediaRow, same: (code: string | null) => boolean): number {
  const first = GROWING_WAITS_MS[0]!;
  if (!same(row.errorCode) || row.nextAttemptAt === null) return first;
  const last = Date.parse(row.nextAttemptAt) - Date.parse(row.updatedAt);
  if (!Number.isFinite(last)) return first;
  return GROWING_WAITS_MS.find((w) => w > last) ?? GROWING_WAITS_MS[GROWING_WAITS_MS.length - 1]!;
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
    if (row.localPath === null && job.revoked) {
      // Deleted for everyone before we fetched it: do not fetch it now.
      failMedia(db, row.id, { status: 'unavailable', errorCode: 'revoked', at: this.#now() });
      return { outcome: 'unavailable', clientId: row.clientId };
    }
    if (row.attempts >= MEDIA_MAX_ATTEMPTS) {
      // Every run that ends in a deferral leaves fewer attempts than this, and the run that reaches it fails the file.
      // So a pending file with this many was claimed by runs that never ended: each one stopped the process (FR1).
      failMedia(db, row.id, { status: 'failed', errorCode: CRASHED, at: this.#now() });
      this.#o.log.warn({ mediaId: row.id, clientId: row.clientId, errorCode: CRASHED, attempts: row.attempts }, 'shared file failed: its runs never ended');
      return { outcome: 'failed', clientId: row.clientId };
    }
    // Final review FR1: claimed in a committed write before anything is downloaded, decoded or paid for. If the write
    // fails, the error propagates and nothing is tried. Outcomes that count nothing give the attempt back (#settle).
    const at = this.#now();
    if (!claimMedia(db, row.id, { nextAttemptAt: new Date(Date.parse(at) + CLAIM_MS).toISOString(), at })) return { outcome: 'skipped', clientId: row.clientId };
    try {
      return { outcome: await this.#run(row, job), clientId: row.clientId };
    } catch (e) {
      return { outcome: this.#settle(row, e), clientId: row.clientId };
    }
  }

  #now(): string {
    return this.#o.clock.now().toISOString();
  }

  /** Whether a file's free waits are over: 24 hours from its arrival, or from the service start if later (10d, 10f, FR2). */
  #waitedTooLong(row: MediaRow, at: string): boolean {
    return Date.parse(at) - Math.max(Date.parse(row.createdAt), this.#startedMs) > AI_UNAVAILABLE_MAX_AGE_MS;
  }

  #abs(rel: string): string {
    return join(this.#o.dataDir, ...rel.split('/'));
  }

  async #run(row: MediaRow, job: MediaJob): Promise<ProcessOutcome> {
    const { db } = this.#o;
    let bytes: Buffer;
    try {
      bytes = row.localPath === null ? await this.#download(row, job) : await readFile(this.#abs(row.localPath));
    } catch (e) {
      if (typeof e === 'object' && e !== null) beforeReading.add(e);
      throw e;
    }
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

  /**
   * Ends a run that threw. `row` is the file as it was before the claim, so a wait that counts nothing stores its
   * attempts exactly as they were then (final review FR1), and the waits of 10d read back the last wait from it.
   * A final failure keeps the attempt the claim counted.
   */
  #settle(row: MediaRow, e: unknown): ProcessOutcome {
    const { db, log } = this.#o;
    const at = this.#now();
    const ids = { mediaId: row.id, clientId: row.clientId };
    if (e instanceof SpendCapReachedError) {
      deferMedia(db, row.id, { errorCode: 'spend_cap', nextAttemptAt: new Date(Date.parse(at) + SPEND_RETRY_MS).toISOString(), attempts: row.attempts, at });
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
      if (this.#waitedTooLong(row, at)) {
        failMedia(db, row.id, { status: 'failed', errorCode: AI_UNAVAILABLE, at });
        log.warn({ ...ids, errorCode: AI_UNAVAILABLE, err: e }, 'shared file not read: Claude unavailable for 24 hours');
        return 'failed';
      }
      const waitMs = nextGrowingWait(row, (code) => code === AI_UNAVAILABLE);
      deferMedia(db, row.id, { errorCode: AI_UNAVAILABLE, nextAttemptAt: new Date(Date.parse(at) + waitMs).toISOString(), attempts: row.attempts, at });
      log.info({ ...ids, errorCode: AI_UNAVAILABLE, waitMinutes: waitMs / 60_000, err: e }, 'Claude unavailable: shared file waits');
      return 'deferred';
    }
    // Final review FR2: a short internet outage, or a full or locked disk, must not lose a file still waiting to be
    // downloaded. It waits like 10d, and the download details are kept until the download has a final answer.
    if (outage(e)) {
      const errorCode = retryCode(e);
      if (this.#waitedTooLong(row, at)) {
        failMedia(db, row.id, { status: 'failed', errorCode, at });
        log.warn({ ...ids, errorCode, err: e }, 'shared file not saved: download or disk still failing after 24 hours');
        return 'failed';
      }
      const waitMs = nextGrowingWait(row, isOutageCode);
      deferMedia(db, row.id, { errorCode, nextAttemptAt: new Date(Date.parse(at) + waitMs).toISOString(), attempts: row.attempts, at });
      log.info({ ...ids, errorCode, waitMinutes: waitMs / 60_000, err: e }, 'download or disk problem: shared file waits');
      return 'deferred';
    }
    // Amendment 10e: every retry of a failed scan read could book up to the whole scan ceiling (about $4) again, so
    // the scan fails for good. Only the spend cap and Claude unavailable (both above) wait. An image keeps its
    // 3 attempts: it books at most about $0.10 a try.
    if (isScanReadError(e)) {
      const errorCode = retryCode(e);
      failMedia(db, row.id, { status: 'failed', errorCode, at });
      log.warn({ ...ids, errorCode }, 'scanned PDF not read: not retried, a retry could pay again');
      return 'failed';
    }
    const errorCode = retryCode(e);
    const attempts = row.attempts + 1; // the attempt the claim counted
    if (attempts >= MEDIA_MAX_ATTEMPTS) {
      failMedia(db, row.id, { status: 'failed', errorCode, at });
      log.warn({ ...ids, errorCode, attempts, err: e }, 'shared file failed after retries');
      return 'failed';
    }
    const delay = RETRY_DELAYS_MS[attempts - 1] ?? 5 * 60_000;
    deferMedia(db, row.id, { errorCode, nextAttemptAt: new Date(Date.parse(at) + delay).toISOString(), attempts, at });
    log.warn({ ...ids, errorCode, attempts, err: e }, 'shared file will be retried');
    return 'deferred';
  }
}
