import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { AiInvalidOutputError, AiRefusalError } from '../brain/claudeClient.ts';
import { neverSent, SpendCapReachedError } from '../brain/paidCall.ts';
import { getClient } from '../store/clients.ts';
import type { Db } from '../store/db.ts';
import {
  claimMedia, deferMedia, failMedia, finishMedia, getMedia, getMediaRef, markDownloaded, mediaJob, noteMediaForget, type MediaJob, type MediaKind, type MediaRow,
} from '../store/media.ts';
import { AudioError } from '../stt/audio.ts';
import { SttHttpError, SttJobError, SttNoAnswerError } from '../stt/http.ts';
import { LocalEngineError } from '../stt/local.ts';
import { SttBookingError } from '../stt/paidStt.ts';
import type { ProviderId } from '../stt/types.ts';
import { SttPartialError, type VoiceTranscriber } from '../stt/voice.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { isPaidVoiceError, isScanReadError, voiceCopyOf, type Extraction, type Extractor } from './extract.ts';
import { MediaDownloadError, MediaUnavailableError, type MediaFetcher } from './fetch.ts';
import { ParseError } from './parse/types.ts';
import { extForMime, mediaRelPath } from './paths.ts';
import { mediaRefAad, type MediaRefSealer } from './ref.ts';
import { MEDIA_LIMITS, type MediaRef } from './types.ts';
import { forgetVoiceCopies } from './voiceForget.ts';

export type ProcessOutcome = 'done' | 'failed' | 'unavailable' | 'deferred' | 'skipped';

export interface ProcessResult {
  outcome: ProcessOutcome;
  clientId: number | null;
}

export const MEDIA_MAX_ATTEMPTS = 3;
/**
 * How far the claim before a run moves the file's next attempt (final review FR1). A run that never ended (the process
 * stopped) is tried again after this. It is longer than most runs, but not every one: a scan read gives up after 10
 * minutes, while a Sarvam voice run can take the ffmpeg conversion (up to 5 minutes, VOICE_CONVERT_TIMEOUT_MS), the
 * upload, up to 10 minutes of waiting (VOICE_STT_TIMEOUTS.sarvamWaitMs) and the download: more than 15 minutes. That is
 * safe within one process: the queue keeps the ids it is running in its in-flight set and never starts a second run of
 * one of them, however long the first takes. The claim only matters after a restart, when no run is left in flight.
 */
export const CLAIM_MS = 15 * 60_000;
/**
 * A file whose runs never ended as many times as it may run (maxRuns): each one stopped the process, for example in a
 * decoder.
 */
const CRASHED = 'crashed';
/** Wait after the first and the second failed attempt; the third failure is final. */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000];
/** The wait after the spend cap (spend_cap), or after holds of paid calls in flight (spend_busy). Counts no attempt. */
export const SPEND_RETRY_MS = 10 * 60_000;
/** Only holds of paid calls in flight, not the cap itself, kept the file from its budget (final review FR3c). */
const SPEND_BUSY = 'spend_busy';
/** Claude was busy, down or refused the key, and nothing was billed: waits that grow, then hourly (amendment 10d). */
const AI_UNAVAILABLE = 'ai_unavailable';
/**
 * The waits that grow, then hourly, of a problem that may pass and costs nothing to try again: Claude unavailable
 * (amendment 10d), or a download that cannot reach WhatsApp or a disk that refuses the file (final review FR2).
 */
const GROWING_WAITS_MS = [5, 15, 30, 60].map((m) => m * 60_000);
/**
 * A file still unread because Claude is unavailable, or still not downloaded and saved because of the network or the
 * disk, this long after it arrived (or was queued by `cli transcribe-voice`), or after the service started if that is
 * later (amendment 10f), is given up.
 */
export const AI_UNAVAILABLE_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * The speech provider refused the key (401 or 403): nothing was billed, and only the owner can fix it. Waits like
 * ai_unavailable (10d): the growing waits, no attempt counted, and given up after 24 hours.
 */
const STT_UNAVAILABLE = 'stt_unavailable';
/**
 * A voice note's paid call was answered (and billed) but could not be booked or stored (Task 5 review round 1, Fix 3;
 * or finishMedia failing after it). Failed at once: a retry would pay the provider again.
 */
const STT_PAID_UNBOOKED = 'stt_paid_unbooked';
/** A later part failed after earlier parts were answered and billed: failed at once, a retry would pay for them again. */
const STT_PARTIAL = 'stt_partial';
/**
 * Tries of a voice note that got no usable answer (SttNoAnswerError, SttJobLostError): each may have been billed, and is
 * booked at the ceiling by withSttHold, so only one more try.
 */
export const STT_NO_ANSWER_MAX_ATTEMPTS = 2;

/**
 * How many runs a file gets in all, counted by its claims: the counted retries stop there, and a pending file claimed
 * this many times by runs that never ended fails as crashed. A voice note or an audio file gets
 * STT_NO_ANSWER_MAX_ATTEMPTS when the voice transcriber is paid (Task 6 review round 1, fix 3): a run that never ended
 * may have been billed (the paid call was sent, and the process stopped before anything was booked), so it gets the same
 * one more try as a call that got no usable answer. Its counted retries (stt_http_<status>, stt_booking, a download
 * error) stop there too, so a run that ends in a deferral always leaves fewer attempts than this, and the crash rule
 * only ever sees runs that never ended. With the local engine, or none (voicePaid false, Phase 2b amendment L2), nothing
 * can be billed, so voice notes and audio files get MEDIA_MAX_ATTEMPTS, as images and documents always do.
 */
const maxRuns = (kind: MediaKind, voicePaid: boolean): number =>
  voicePaid && (kind === 'voice' || kind === 'audio') ? STT_NO_ANSWER_MAX_ATTEMPTS : MEDIA_MAX_ATTEMPTS;

/**
 * The local engine was stopped by the service's stop signal (LocalEngineError('aborted')): free, so the attempt is
 * given back, and the note is tried again this long after (after the restart). At least a minute, longer than a tick,
 * as every real deferral (src/media/queue.ts).
 */
const LOCAL_ABORTED = 'local_aborted';
const LOCAL_ABORTED_RETRY_MS = 60_000;

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
  /**
   * The voice transcriber VOICE_STT_PROVIDER names, if any: only to delete provider copies promptly, a copy noted for a
   * failed call (forgetVoiceCopies, started without waiting) and one finishMedia could not store (below). Never used to
   * transcribe; the extractor holds its own. Without it, noted copies wait for the app's sweep.
   */
  voice?: VoiceTranscriber | null;
  /**
   * Told after finishMedia has stored a file's extraction (and noted its provider copy, if any). The app passes one that
   * runs forgetVoiceCopies for that file when x.forget is set. Called without waiting, and may be async: a sync throw
   * and a rejection are both logged (codes only) and never change the outcome.
   */
  afterFinish?: (mediaId: number, x: Extraction) => void | Promise<void>;
  /**
   * Whether the voice transcriber set up is a paid one (Phase 2b amendment L2): paid, voice notes and audio files get 2
   * runs in all (maxRuns); free, 3. When not given it is derived (review round 1, fix 1): `!voice.costsNothing`, and
   * true (paid, the safe setting) when no voice transcriber is given. A value given always wins.
   */
  voicePaid?: boolean;
}

function retryCode(e: unknown): string {
  if (e instanceof MediaDownloadError) return e.code;
  if (e instanceof LocalEngineError) return `local_${e.code}`;
  if (e instanceof SttHttpError) return `stt_http_${e.status}`;
  if (e instanceof SttNoAnswerError) return `stt_no_answer_${e.code}`; // its SttJobLostError too
  if (e instanceof SttBookingError) return 'stt_booking';
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

/**
 * finishMedia errors after an extraction whose provider copy could then not be noted: the call was paid and booked, so
 * the file fails at once as stt_paid_unbooked, as isPaidVoiceError's do. Noted, not wrapped, as beforeReading is.
 */
const paidAfterFinish = new WeakSet<object>();

/** Notes a finishMedia error as one after a paid voice call; an error that is not an object is wrapped first. */
function paidFinishFailed(e: unknown): object {
  const err = typeof e === 'object' && e !== null ? e : new Error('A paid voice transcript could not be stored');
  paidAfterFinish.add(err);
  return err;
}

/** Whether a voice note's paid call was answered but its booking or its storing failed: never retried. */
const paidButUnstored = (e: unknown): boolean => isPaidVoiceError(e) || (typeof e === 'object' && e !== null && paidAfterFinish.has(e));

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
 * The bytes are synced to disk before the link (final review FR3b): markDownloaded wipes the download details next, so
 * after a power cut the original must not be zeros or partial with no way to fetch it again.
 */
async function saveOriginal(abs: string, bytes: Buffer, sha256: string): Promise<void> {
  const tmp = `${abs}.${randomUUID()}.part`;
  try {
    const fh = await open(tmp, 'wx');
    try {
      await fh.writeFile(bytes);
      await fh.sync();
    } finally {
      await fh.close(); // before the temp file is removed: Windows cannot delete an open file
    }
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
  /**
   * Ids of files that must never be paid for again (Task 6 review round 1, fix 2): added before the failMedia of
   * stt_paid_unbooked, stt_partial, stt_job_<code> and the final stt_no_answer_<code>. If that write fails, the row stays
   * pending in the database, but this processor never runs it again. Kept in memory only: after a restart the row's
   * claims still count (maxRuns).
   */
  readonly #neverPayAgain = new Set<number>();

  constructor(o: MediaProcessorOptions) {
    this.#o = o;
    this.#startedMs = (o.startedAt ?? o.clock.now()).getTime();
  }

  async process(mediaId: number): Promise<ProcessResult> {
    const { db } = this.#o;
    const row = await getMedia(db, mediaId);
    // Before the claim: a file whose final failure could not be written is never claimed or paid for again (fix 2).
    if (this.#neverPayAgain.has(mediaId)) return { outcome: 'skipped', clientId: row?.clientId ?? null };
    if (!row || row.status !== 'pending') return { outcome: 'skipped', clientId: row?.clientId ?? null };
    // A client taken off the allow-list: its files wait, untouched, until it is active again (amendment 10a).
    // The queue does not pick them up meanwhile (dueMediaIds), so this cannot loop.
    if (!(await getClient(db, row.clientId)).active) return { outcome: 'skipped', clientId: row.clientId };
    const job = await mediaJob(db, mediaId);
    if (!job) {
      // Its message is gone: the file can never be processed, so it must not stay pending (amendment 10b).
      await failMedia(db, row.id, { status: 'failed', errorCode: 'no_job', at: this.#now() });
      this.#o.log.warn({ mediaId: row.id, clientId: row.clientId, errorCode: 'no_job' }, 'shared file has no message');
      return { outcome: 'failed', clientId: row.clientId };
    }
    if (row.localPath === null && job.revoked) {
      // Deleted for everyone before we fetched it: do not fetch it now.
      await failMedia(db, row.id, { status: 'unavailable', errorCode: 'revoked', at: this.#now() });
      return { outcome: 'unavailable', clientId: row.clientId };
    }
    if (row.attempts >= this.#maxRuns(row.kind)) {
      // Every run that ends in a deferral leaves fewer attempts than this, and the run that reaches it fails the file.
      // So a pending file with this many was claimed by runs that never ended: each one stopped the process (FR1). A
      // voice note or audio file gets fewer when its transcriber is paid: such a run may have been billed (maxRuns,
      // review round 1 fix 3).
      await failMedia(db, row.id, { status: 'failed', errorCode: CRASHED, at: this.#now() });
      this.#o.log.warn({ mediaId: row.id, clientId: row.clientId, errorCode: CRASHED, attempts: row.attempts }, 'shared file failed: its runs never ended');
      return { outcome: 'failed', clientId: row.clientId };
    }
    // Final review FR1: claimed in a committed write before anything is downloaded, decoded or paid for. If the write
    // fails, the error propagates and nothing is tried. Outcomes that count nothing give the attempt back (#settle).
    const at = this.#now();
    if (!(await claimMedia(db, row.id, { nextAttemptAt: new Date(Date.parse(at) + CLAIM_MS).toISOString(), at }))) return { outcome: 'skipped', clientId: row.clientId };
    try {
      return { outcome: await this.#run(row, job), clientId: row.clientId };
    } catch (e) {
      return { outcome: await this.#settle(row, e), clientId: row.clientId };
    }
  }

  #now(): string {
    return this.#o.clock.now().toISOString();
  }

  #maxRuns(kind: MediaKind): number {
    return maxRuns(kind, this.#voicePaid);
  }

  /**
   * voicePaid as given, else derived from the voice transcriber (review round 1, fix 1): paid unless it costs nothing,
   * and paid when none is known, the safe setting.
   */
  get #voicePaid(): boolean {
    return this.#o.voicePaid ?? (this.#o.voice ? !this.#o.voice.costsNothing : true);
  }

  /**
   * Whether a file's free waits are over: 24 hours from its arrival (or its queueing by `cli transcribe-voice`), or from
   * the service start if later (10d, 10f, FR2).
   */
  #waitedTooLong(row: MediaRow, at: string): boolean {
    return Date.parse(at) - Math.max(Date.parse(row.createdAt), this.#startedMs) > AI_UNAVAILABLE_MAX_AGE_MS;
  }

  #abs(rel: string): string {
    return join(this.#o.dataDir, ...rel.split('/'));
  }

  async #run(row: MediaRow, job: MediaJob): Promise<ProcessOutcome> {
    const { db } = this.#o;
    let bytes: Buffer;
    let rel: string;
    try {
      if (row.localPath === null) ({ bytes, rel } = await this.#download(row, job));
      else {
        rel = row.localPath;
        bytes = await readFile(this.#abs(rel));
      }
    } catch (e) {
      if (typeof e === 'object' && e !== null) beforeReading.add(e);
      throw e;
    }
    // Read again, not only from the job: the message may have been deleted for everyone during the download (FR3a).
    // A message that is gone counts as deleted.
    const revoked = async (): Promise<boolean> => (await mediaJob(db, row.id))?.revoked ?? true;
    if (job.revoked || (await revoked())) {
      await finishMedia(db, row.id, { textKind: null, text: null, pageCount: null, note: 'revoked', at: this.#now() });
      return 'done';
    }
    // The original is saved and hashed already: a DOCX's bytes may be moved to the parser, so nothing reads them after this.
    // The extractor asks `revoked` again just before a paid call, after the decode (FR3a).
    // A voice note is read from its path by the voice transcriber. Its declared length (row.seconds) is the sender's
    // claim, so it is not passed: it stays on the row for display only (V5, Task 5 review round 1).
    const x = await this.#o.extract({
      mediaId: row.id, kind: row.kind, mimeType: row.mimeType, fileName: row.fileName, forwarded: row.forwarded, bytes, path: this.#abs(rel), revoked,
    });
    try {
      await finishMedia(db, row.id, { ...x, at: this.#now() });
    } catch (e) {
      if (!x.forget) throw e;
      // A paid, booked transcript whose provider copy finishMedia could not note in media_stt_forget: a retry would pay
      // again. The copy is noted on its own and deleted now, best effort, and the file fails at once (#settle).
      await this.#forgetNow(row, x.forget);
      throw paidFinishFailed(e);
    }
    const afterFinish = this.#o.afterFinish;
    if (afterFinish) {
      // Not waited for. Run in a promise, so neither a sync throw nor a rejection can escape (review round 1, fix 4).
      void Promise.resolve()
        .then(() => afterFinish(row.id, x))
        .catch((err: unknown) => {
          this.#o.log.warn({ mediaId: row.id, clientId: row.clientId, errorCode: 'after_finish', err }, 'shared file read; the step after it failed');
        });
    }
    return 'done';
  }

  /**
   * A provider copy finishMedia could not note (review round 1, fix 5). Noted first, on its own, best effort: then a
   * delete that fails leaves a row for the sweep. It is then deleted through the voice transcriber, if it is the
   * provider's and keeps copies: by forgetVoiceCopies for that file when the row was noted (which removes the row once
   * deleted), else directly. Every failure is logged with codes only, or ignored. Free.
   */
  async #forgetNow(row: MediaRow, copy: { provider: ProviderId; ref: string }): Promise<void> {
    const { db, log, clock } = this.#o;
    const noted = await this.#noteCopy(row, copy, this.#now());
    const voice = this.#o.voice ?? null;
    if (voice === null || voice.provider !== copy.provider || !voice.canForget) return;
    if (noted) {
      await forgetVoiceCopies(db, voice, log, { mediaId: row.id, clock }).catch((err: unknown) => {
        log.warn({ mediaId: row.id, clientId: row.clientId, provider: copy.provider, errorCode: 'forget_failed', err }, 'voice note speech copy not deleted yet: left for the sweep');
      });
      return;
    }
    try {
      await voice.forget(copy.ref);
    } catch {
      // the copy stays on the provider's account; the file still fails at once
    }
  }

  /** Notes a provider copy in media_stt_forget (N1), best effort: a failure is logged (codes only). Returns whether it was noted. */
  async #noteCopy(row: MediaRow, copy: { provider: ProviderId; ref: string }, at: string): Promise<boolean> {
    try {
      await noteMediaForget(this.#o.db, row.id, { ...copy, at });
      return true;
    } catch (err) {
      this.#o.log.warn({ mediaId: row.id, clientId: row.clientId, provider: copy.provider, errorCode: 'forget_not_noted', err }, 'voice note speech copy could not be noted for deletion');
      return false;
    }
  }

  /** Downloads and saves the original; returns its bytes and its path relative to the data folder. */
  async #download(row: MediaRow, job: MediaJob): Promise<{ bytes: Buffer; rel: string }> {
    const { db, sealer, fetcher } = this.#o;
    const blob = await getMediaRef(db, row.id);
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
    await markDownloaded(db, row.id, { localPath: rel, sha256, fileSize: bytes.length, at: this.#now() });
    return { bytes, rel };
  }

  /**
   * Ends a run that threw. `row` is the file as it was before the claim, so a wait that counts nothing stores its
   * attempts exactly as they were then (final review FR1), and the waits of 10d read back the last wait from it.
   * A final failure keeps the attempt the claim counted.
   *
   * A voice note's speech errors (Phase 2b), each already booked by withSttHold (or freed, for an HTTP refusal):
   * - paid but not booked or not stored (isPaidVoiceError, or finishMedia failing after it): failed at once,
   *   stt_paid_unbooked. Checked first of all: the error itself may be anything, even a 401 or a spend error;
   * - a later part failed (SttPartialError, also as the cause of an SttBookingError): failed at once, stt_partial.
   *   Checked before the key rule, so a 401 on part 2 does not wait;
   * - the key refused (SttHttpError 401 or 403, also as the cause of an SttBookingError): stt_unavailable, the growing
   *   waits without an attempt, given up after 24 hours (as ai_unavailable, 10d);
   * - a failed job (SttJobError) or ffmpeg failing (AudioError): failed at once, stt_job_<code> or audio_<code>;
   * - no usable answer (SttNoAnswerError, SttJobLostError): one more try, then failed, stt_no_answer_<code>;
   * - any other SttHttpError (stt_http_<status>) or SttBookingError (stt_booking): the counted retries, which for a
   *   voice note or audio file stop at maxRuns (2).
   * The local engine's errors (Phase 2b amendment L2), each free:
   * - stopped by the service's stop signal (LocalEngineError 'aborted'): local_aborted, the attempt given back, tried
   *   again a minute later; failed as local_aborted once the file has waited 24 hours (#waitedTooLong, review round 1);
   * - any other (empty_output, timeout, exit_<n>, no_output): the counted retries, local_<code>, which stop at maxRuns
   *   (3 with voicePaid false).
   * A copy the provider kept although its answer could not be read (voiceCopyOf) is noted first, best effort, and its
   * deletion started without waiting. The never-retry speech failures add the file to #neverPayAgain before failMedia.
   */
  async #settle(row: MediaRow, e: unknown): Promise<ProcessOutcome> {
    const { db, log } = this.#o;
    const at = this.#now();
    const ids = { mediaId: row.id, clientId: row.clientId };
    await this.#noteUnansweredCopy(row, e, at);
    if (paidButUnstored(e)) {
      // The late booking and the copy deletion were already tried (by the extractor, or by #run).
      this.#neverPayAgain.add(row.id);
      await failMedia(db, row.id, { status: 'failed', errorCode: STT_PAID_UNBOOKED, at });
      log.warn({ ...ids, errorCode: STT_PAID_UNBOOKED }, 'voice note paid but not booked: not retried');
      return 'failed';
    }
    if (e instanceof SpendCapReachedError) {
      // Final review FR3c: when only paid calls in flight hold the budget (or the guard closed at shutdown), the file is
      // read within minutes, so it waits as spend_busy. mediaStats counts only spend_cap as waiting for midnight.
      const errorCode = e.busy ? SPEND_BUSY : 'spend_cap';
      await deferMedia(db, row.id, { errorCode, nextAttemptAt: new Date(Date.parse(at) + SPEND_RETRY_MS).toISOString(), attempts: row.attempts, at });
      log.info(ids, e.busy ? 'paid calls in flight hold the budget: shared file waits' : 'spend cap: shared file waits');
      return 'deferred';
    }
    if (e instanceof MediaUnavailableError) {
      await failMedia(db, row.id, { status: 'unavailable', errorCode: e.code, at });
      log.info({ ...ids, errorCode: e.code }, 'shared file could not be downloaded');
      return 'unavailable';
    }
    if (e instanceof ParseError || e instanceof MediaFailedError || e instanceof AiRefusalError) {
      const errorCode = e instanceof AiRefusalError ? 'ai_refusal' : e.code;
      await failMedia(db, row.id, { status: 'failed', errorCode, at });
      log.warn({ ...ids, errorCode }, 'shared file could not be read');
      return 'failed';
    }
    // Speech: an SttBookingError carries the call's own error as its cause, so a refused key stays a refused key.
    const sttCause = e instanceof SttBookingError ? e.cause : e;
    if (sttCause instanceof SttPartialError) return this.#failAtOnce(row, at, STT_PARTIAL, 'voice note part failed after others were answered: not retried', { neverPayAgain: true });
    if (sttCause instanceof SttHttpError && (sttCause.status === 401 || sttCause.status === 403)) {
      return this.#growingWait(row, at, e, {
        errorCode: STT_UNAVAILABLE, waits: 'speech-to-text key refused: voice note waits', gaveUp: 'voice note not transcribed: speech-to-text key refused for 24 hours',
      });
    }
    if (e instanceof SttJobError) return this.#failAtOnce(row, at, `stt_job_${e.code}`, 'voice note job failed at the provider: not retried', { neverPayAgain: true });
    if (e instanceof AudioError) return this.#failAtOnce(row, at, `audio_${e.code}`, 'voice note could not be converted: not retried');
    if (e instanceof LocalEngineError && e.code === 'aborted') {
      // The service is stopping: the free run is simply tried again after the restart, counting nothing. Not forever
      // (review round 1, fix 2): past the 24 hours of the other free waits (#waitedTooLong), the file fails.
      if (this.#waitedTooLong(row, at)) {
        await failMedia(db, row.id, { status: 'failed', errorCode: LOCAL_ABORTED, at });
        log.warn({ ...ids, errorCode: LOCAL_ABORTED }, 'voice note not transcribed: local speech engine stopped for 24 hours');
        return 'failed';
      }
      await deferMedia(db, row.id, { errorCode: LOCAL_ABORTED, nextAttemptAt: new Date(Date.parse(at) + LOCAL_ABORTED_RETRY_MS).toISOString(), attempts: row.attempts, at });
      log.info({ ...ids, errorCode: LOCAL_ABORTED }, 'local speech engine stopped: voice note waits');
      return 'deferred';
    }
    if (e instanceof SttNoAnswerError) return this.#countedRetry(row, at, e, STT_NO_ANSWER_MAX_ATTEMPTS, { neverPayAgain: true });
    if (claudeUnavailable(e)) {
      return this.#growingWait(row, at, e, {
        errorCode: AI_UNAVAILABLE, waits: 'Claude unavailable: shared file waits', gaveUp: 'shared file not read: Claude unavailable for 24 hours',
      });
    }
    // Final review FR2: a short internet outage, or a full or locked disk, must not lose a file still waiting to be
    // downloaded. It waits like 10d, and the download details are kept until the download has a final answer.
    if (outage(e)) {
      return this.#growingWait(row, at, e, {
        errorCode: retryCode(e), same: isOutageCode,
        waits: 'download or disk problem: shared file waits', gaveUp: 'shared file not saved: download or disk still failing after 24 hours',
      });
    }
    // Amendment 10e: every retry of a failed scan read could book up to the whole scan ceiling (about $4) again, so
    // the scan fails for good. Only the spend cap and Claude unavailable (both above) wait. An image keeps its
    // 3 attempts: it books at most about $0.10 a try.
    if (isScanReadError(e)) return this.#failAtOnce(row, at, retryCode(e), 'scanned PDF not read: not retried, a retry could pay again');
    return this.#countedRetry(row, at, e, this.#maxRuns(row.kind));
  }

  /**
   * The copy a voice call's provider kept although its answer could not be read (Phase 3's M7, voiceCopyOf), noted in
   * media_stt_forget so forgetVoiceCopies deletes it (N1). Best effort: a failure is logged (codes only) and changes
   * nothing else. Once noted, it is deleted promptly (review round 1, fix 5): forgetVoiceCopies for this file is started
   * without waiting, when a transcriber that keeps copies is set up (the sweep deletes it otherwise). Its failure is
   * logged with codes only.
   */
  async #noteUnansweredCopy(row: MediaRow, e: unknown, at: string): Promise<void> {
    const copy = voiceCopyOf(e);
    if (copy === null || !(await this.#noteCopy(row, copy, at))) return;
    const { db, log, clock } = this.#o;
    const voice = this.#o.voice ?? null;
    if (voice === null || !voice.canForget) return;
    void forgetVoiceCopies(db, voice, log, { mediaId: row.id, clock }).catch((err: unknown) => {
      log.warn({ mediaId: row.id, clientId: row.clientId, provider: copy.provider, errorCode: 'forget_failed', err }, 'voice note speech copy not deleted yet: left for the sweep');
    });
  }

  /**
   * Fails the file for good, keeping the attempt the claim counted. With neverPayAgain, the file is first added to
   * #neverPayAgain, so a failMedia that throws still never lets this processor run it again (fix 2).
   */
  async #failAtOnce(row: MediaRow, at: string, errorCode: string, message: string, o: { neverPayAgain?: boolean } = {}): Promise<ProcessOutcome> {
    if (o.neverPayAgain) this.#neverPayAgain.add(row.id);
    await failMedia(this.#o.db, row.id, { status: 'failed', errorCode, at });
    this.#o.log.warn({ mediaId: row.id, clientId: row.clientId, errorCode }, message);
    return 'failed';
  }

  /**
   * The waits that grow, then hourly, without counting an attempt, for a problem that may pass and bills nothing:
   * Claude unavailable (10d), a speech key refused (stt_unavailable), a download or disk outage (FR2). One rule for all:
   * given up once the file has waited 24 hours (#waitedTooLong). `same` tells the same problem by the row's error code
   * (by default: the same code), so a different problem starts the waits again.
   */
  async #growingWait(row: MediaRow, at: string, e: unknown, o: { errorCode: string; same?: (code: string | null) => boolean; waits: string; gaveUp: string }): Promise<ProcessOutcome> {
    const { db, log } = this.#o;
    const ids = { mediaId: row.id, clientId: row.clientId };
    if (this.#waitedTooLong(row, at)) {
      await failMedia(db, row.id, { status: 'failed', errorCode: o.errorCode, at });
      log.warn({ ...ids, errorCode: o.errorCode, err: e }, o.gaveUp);
      return 'failed';
    }
    const waitMs = nextGrowingWait(row, o.same ?? ((code) => code === o.errorCode));
    await deferMedia(db, row.id, { errorCode: o.errorCode, nextAttemptAt: new Date(Date.parse(at) + waitMs).toISOString(), attempts: row.attempts, at });
    log.info({ ...ids, errorCode: o.errorCode, waitMinutes: waitMs / 60_000, err: e }, o.waits);
    return 'deferred';
  }

  /**
   * A counted retry after 1, then 5 minutes; failed once the attempts (the claim's included) reach maxAttempts. With
   * neverPayAgain, that final failure first adds the file to #neverPayAgain (fix 2).
   */
  async #countedRetry(row: MediaRow, at: string, e: unknown, maxAttempts: number, o: { neverPayAgain?: boolean } = {}): Promise<ProcessOutcome> {
    const { db, log } = this.#o;
    const ids = { mediaId: row.id, clientId: row.clientId };
    const errorCode = retryCode(e);
    const attempts = row.attempts + 1; // the attempt the claim counted
    if (attempts >= maxAttempts) {
      if (o.neverPayAgain) this.#neverPayAgain.add(row.id);
      await failMedia(db, row.id, { status: 'failed', errorCode, at });
      log.warn({ ...ids, errorCode, attempts, err: e }, 'shared file failed after retries');
      return 'failed';
    }
    const delay = RETRY_DELAYS_MS[attempts - 1] ?? 5 * 60_000;
    await deferMedia(db, row.id, { errorCode, nextAttemptAt: new Date(Date.parse(at) + delay).toISOString(), attempts, at });
    log.warn({ ...ids, errorCode, attempts, err: e }, 'shared file will be retried');
    return 'deferred';
  }
}
