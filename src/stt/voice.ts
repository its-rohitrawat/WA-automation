import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { requireKey, type Env } from '../config/env.ts';
import { AudioError, type Ffmpeg } from './audio.ts';
import type { HttpFetch } from './http.ts';
import { costUsd, modelFor } from './prices.ts';
import { ElevenLabsProvider } from './providers/elevenlabs.ts';
import { OpenAiProvider } from './providers/openai.ts';
import { SarvamProvider } from './providers/sarvam.ts';
import type { AudioPart, ProviderId, ProviderResult, SttProvider } from './types.ts';

/*
 * Voice notes and audio files (Phase 2b), the voice-note sibling of the meeting transcriber in src/meetings/transcribe.ts.
 * Same adapters, picked by the same STT_PROVIDER, with speaker labels off and short timeouts.
 * - Every voice note and audio file is converted to MP3 on this PC with ffmpeg first, for every provider (owner decision
 *   in Task 5's review round 1, amending V3 and N2), in a folder of its own named after the media id. The conversion
 *   stops a little past the cap (ffmpeg's -t) and the MP3 ffmpeg wrote is measured, so the note's true length is known
 *   before any money is held. Without ffmpeg nothing is sent. OpenAI notes longer than its 5-minute limit are split there.
 * - Two steps. prepare is free and local: it converts, measures and splits, and refuses a note that measures longer
 *   than allowed (V5), so a low-bitrate file never becomes many paid parts and a local failure books nothing. transcribe
 *   is the paid step, run by the extractor inside one spend hold (withSttHold).
 * - One provider call per part. Nothing is retried and no call is aborted: each call is billed, and the spend hold
 *   books by its outcome. Once a part has been answered, a later part's failure is an SttPartialError, so the hold
 *   books the ceiling for the parts already billed.
 * The sender's MIME type is not used: the format sent is always the literal 'mp3'.
 * Logs: none here. The extractor logs ids, provider, seconds and cost.
 */

/** Voice notes are short: these stay well inside SpendGuard's 45-minute hold and the media queue's 15-minute claim. */
export const VOICE_STT_TIMEOUTS = { elevenlabsMs: 5 * 60_000, openaiMs: 5 * 60_000, sarvamWaitMs: 10 * 60_000 };

/**
 * How long ffmpeg may take to convert one voice note (Task 5 review round 2), instead of toMp3's 60 minutes for meetings.
 * It stays inside the media queue's 15-minute claim (CLAIM_MS in src/media/processor.ts), and the conversion stops at
 * maxSeconds + VOICE_LENGTH_TOLERANCE_S + 1 seconds (at most 606 s of audio decoded with the default cap), so a slow PC
 * still finishes well inside it.
 */
export const VOICE_CONVERT_TIMEOUT_MS = 5 * 60_000;

/**
 * The lowest bitrate assumed from a file's size: a file of n bytes holds at most about n × 8 / 12,000 seconds. Since
 * Task 5's review round 2 it never refuses a file and never sets the hold: it is costUsd's last fallback (when no length
 * was billed or measured) and the CLI's estimate.
 */
const MIN_BITRATE_BPS = 12_000;
export const sizeBoundSeconds = (bytes: number): number => Math.ceil((bytes * 8) / MIN_BITRATE_BPS);

/**
 * How far a measured length may exceed VoiceInput.maxSeconds (the cap) before prepare refuses the note as too_long.
 * ffmpeg's summary rounds, and a conversion can add a few frames of padding.
 */
export const VOICE_LENGTH_TOLERANCE_S = 5;

/**
 * Whether a file can be sent: only when ffmpeg is there, for every provider and every format, since every file is
 * converted first (Task 5 review round 1, amending V3 and N2). The rule behind every transcriber's canSend, exported so
 * `cli transcribe-voice` can apply it without a key or a provider. The provider and MIME type stay as arguments so a
 * caller says what it asks about; neither changes the answer.
 */
export function canSendVoice(_provider: ProviderId, _mimeType: string | null, hasFfmpeg: boolean): boolean {
  return hasFfmpeg;
}

/** The longest provider id for a stored copy that is kept (as for meetings); a longer one is not an id. */
const MAX_REF_LENGTH = 200;

/** One voice note or audio file to transcribe. The file is read from path; nothing the sender named is used. */
export interface VoiceInput {
  /** For logs and the temporary folder only. */
  mediaId: number;
  /** Absolute path of the saved original (DATA_DIR/media/...). */
  path: string;
  /**
   * The cap in seconds (STT_MAX_SECONDS, V5), not the size bound and never the sender's declared length. The conversion
   * stops at this plus VOICE_LENGTH_TOLERANCE_S plus 1 second, and a note ffmpeg measures longer than this plus
   * VOICE_LENGTH_TOLERANCE_S is refused by prepare: the only too_long check (Task 5 review round 2; the file's size
   * refuses nothing). The caller holds the measured length plus VOICE_LENGTH_TOLERANCE_S.
   */
  maxSeconds: number;
}

/** A note made ready to send by prepare, for one transcribe. */
export interface PreparedVoice {
  /** The parts to send, in order: MP3 files in the note's temporary folder. */
  readonly parts: readonly AudioPart[];
  /** The length ffmpeg measured on the MP3 it wrote: trusted, unlike the original's header. */
  readonly measuredSeconds: number;
  /** Removes the note's temporary folder. Safe to call twice; never throws. */
  dispose(): void;
}

export interface VoiceResult {
  provider: ProviderId;
  model: string;
  /** The segments' text joined with spaces, trimmed. Empty when no speech was heard. */
  text: string;
  /** Seconds the provider says it billed, summed over parts; null when any part did not say. */
  billedSeconds: number | null;
  /** The provider's id for its stored copy (ElevenLabs), for N1; null when it keeps none. */
  forgetRef: string | null;
}

/**
 * A later part failed after at least one part was answered (and so billed). It is deliberately not an SttHttpError, even
 * when the cause is one: withSttHold then books the ceiling instead of freeing the hold. `cause` is the part's own error.
 * Not retried: a retry would pay for the answered parts again.
 */
export class SttPartialError extends Error {
  readonly code = 'partial';
  /** How many parts were answered before the failure. */
  readonly partsDone: number;
  constructor(partsDone: number, partCount: number, cause: unknown) {
    super(`A speech part failed after ${partsDone} of ${partCount} parts were answered`, { cause });
    this.name = 'SttPartialError';
    this.partsDone = partsDone;
  }
}

export interface VoiceTranscriber {
  readonly provider: ProviderId;
  /**
   * List-price ceiling for this many seconds of audio, without speaker labels, in US dollars (the spend hold). The caller
   * holds ceilingUsd(prepared.measuredSeconds + VOICE_LENGTH_TOLERANCE_S): the tolerance is headroom over a provider's
   * billed rounding (Task 5 review round 2).
   */
  ceilingUsd(seconds: number): number;
  /**
   * List-price cost of a finished note (V5): the billed seconds when reported, else the measured length, else maxSeconds
   * (the bound). Never the sender's declared length, so a declared 0 cannot lower the booking (Task 5 review round 1).
   * A negative, NaN or infinite length is ignored.
   */
  costUsd(o: { maxSeconds: number; billedSeconds: number | null; measuredSeconds: number | null }): number;
  /** Whether this file can be sent: whether ffmpeg is there, whatever the format (canSendVoice). */
  canSend(mimeType: string | null): boolean;
  /**
   * The free, local step: no provider call. Converts, measures and splits for OpenAI. Throws AudioError('too_long') when
   * the measured length exceeds input.maxSeconds + VOICE_LENGTH_TOLERANCE_S (a conversion stopped by -t does too),
   * AudioError('no_ffmpeg') without ffmpeg, and ffmpeg's own AudioError; the folder is removed first.
   * Run it outside the spend hold.
   */
  prepare(input: VoiceInput): Promise<PreparedVoice>;
  /**
   * The paid step: one provider call per part, in order. Never retried, never aborted. A failure of the first part
   * reaches the caller unchanged; a later one is an SttPartialError. Always disposes the prepared note.
   */
  transcribe(prepared: PreparedVoice): Promise<VoiceResult>;
  readonly canForget: boolean;
  /** Deletes the provider's stored copy named by a forgetRef. Free. */
  forget(ref: string): Promise<void>;
}

/** The list-price hold for a voice note of this many seconds, without speaker labels. Needs no key (for the CLI). */
export function voiceCeilingUsd(provider: ProviderId, seconds: number, inrPerUsd: number): number {
  return costUsd(modelFor(provider, false), seconds, inrPerUsd);
}

/** A length that may be priced: a finite number, not negative. */
const usable = (s: number | null): s is number => s !== null && Number.isFinite(s) && s >= 0;
/** A length ffmpeg may report: a finite number above zero. */
const measurable = (s: number): boolean => Number.isFinite(s) && s > 0;

/** Removes a folder once it is gone; a failure is left for the next call or the next try of the note, never thrown. */
function folderRemover(dir: string): () => void {
  let removed = false;
  return () => {
    if (removed) return;
    try {
      rmSync(dir, { recursive: true, force: true });
      removed = true;
    } catch {
      // left for the next call, or removed before this note is tried again
    }
  };
}

/** A VoiceTranscriber over any provider, with speaker labels off. Exported for tests (a fake provider and ffmpeg). */
export function voiceTranscriber(provider: SttProvider, o: { inrPerUsd: number; ffmpeg: Ffmpeg | null; tmpDir: string }): VoiceTranscriber {
  const price = modelFor(provider.id, false);
  const send = (part: AudioPart): Promise<ProviderResult> =>
    provider.transcribe({ path: part.path, seconds: part.seconds, offset: part.offset, format: 'mp3' }, { diarize: false });

  return {
    provider: provider.id,
    ceilingUsd: (seconds) => voiceCeilingUsd(provider.id, seconds, o.inrPerUsd),
    costUsd: ({ maxSeconds, billedSeconds, measuredSeconds }) => {
      const seconds = usable(billedSeconds) ? billedSeconds : usable(measuredSeconds) ? measuredSeconds : maxSeconds;
      return costUsd(price, seconds, o.inrPerUsd);
    },
    canSend: (mimeType) => canSendVoice(provider.id, mimeType, o.ffmpeg !== null),
    async prepare(input) {
      // The folder is named from the numeric id only, never from a path or name the sender gave.
      if (!Number.isSafeInteger(input.mediaId) || input.mediaId < 1) throw new Error('voice prepare: the media id is not a positive whole number');
      if (o.ffmpeg === null) throw new AudioError('no_ffmpeg');
      const ffmpeg = o.ffmpeg;
      const allowed = input.maxSeconds + VOICE_LENGTH_TOLERANCE_S;
      const dir = join(o.tmpDir, `voice-${input.mediaId}`);
      const dispose = folderRemover(dir);
      try {
        // A folder left by an earlier crash goes first, so no stale conversion or parts are reused.
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        const mp3 = join(dir, 'audio.mp3');
        // Stopped one second past what is allowed: a longer note is never converted whole, whatever its header claims.
        await ffmpeg.toMp3(input.path, mp3, undefined, { maxSeconds: allowed + 1, timeoutMs: VOICE_CONVERT_TIMEOUT_MS });
        // The MP3 ffmpeg wrote, so its length can be trusted; the original's header is the sender's.
        const measured = await ffmpeg.seconds(mp3);
        if (!measurable(measured)) throw new AudioError('no_duration');
        // Also refuses a conversion that reached the -t limit: it measures about allowed + 1.
        if (measured > allowed) throw new AudioError('too_long');
        const whole: AudioPart = { path: mp3, seconds: measured, offset: 0, format: 'mp3' };
        const parts = measured > provider.maxPartSeconds ? await ffmpeg.split(whole, join(dir, 'parts'), provider.maxPartSeconds) : [whole];
        return { parts: parts.map((p) => ({ path: p.path, seconds: p.seconds, offset: p.offset, format: 'mp3' })), measuredSeconds: measured, dispose };
      } catch (e) {
        dispose();
        throw e;
      }
    },
    async transcribe(prepared) {
      try {
        const results: ProviderResult[] = [];
        for (const part of prepared.parts) {
          try {
            results.push(await send(part));
          } catch (e) {
            // Nothing answered yet: the error as it is, so an HTTP refusal still frees the hold. Otherwise parts were
            // billed, and the hold must book them.
            if (results.length === 0) throw e;
            throw new SttPartialError(results.length, prepared.parts.length, e);
          }
        }
        return combine(provider, results);
      } finally {
        // Never throws, so it cannot hide the outcome of a paid call.
        prepared.dispose();
      }
    },
    canForget: provider.forgetById !== undefined,
    async forget(ref) {
      await provider.forgetById?.(ref);
    },
  };
}

/** The parts' answers as one note. The provider's own answer (raw) is never kept: only the id of its stored copy. */
function combine(provider: SttProvider, results: ProviderResult[]): VoiceResult {
  const text = results
    .flatMap((r) => r.segments.map((s) => s.text.trim()))
    .filter((t) => t !== '')
    .join(' ');
  const billedSeconds = results.every((r) => usable(r.billedSeconds)) ? results.reduce((sum, r) => sum + r.billedSeconds!, 0) : null;
  // Only ElevenLabs keeps copies, and its notes are never split (its limit is 10 hours), so there is at most one.
  const refs = results.map((r) => provider.forgetRef?.(r) ?? null);
  const forgetRef = refs.find((ref) => ref !== null && ref.length >= 1 && ref.length <= MAX_REF_LENGTH) ?? null;
  return { provider: provider.id, model: results[0]!.model, text, billedSeconds, forgetRef };
}

/**
 * The voice transcriber STT_PROVIDER names, or null when it is 'none'. STT_API_KEY goes to the provider's constructor
 * and nowhere else. deps.ffmpeg is null when there is none (then nothing is sent: canSend is false for every file);
 * deps.tmpDir holds the conversion folders; deps.http replaces the network in tests.
 */
export function createVoiceTranscriber(env: Env, deps: { ffmpeg: Ffmpeg | null; tmpDir: string; http?: HttpFetch }): VoiceTranscriber | null {
  if (env.STT_PROVIDER === 'none') return null;
  const apiKey = requireKey(env, 'STT_API_KEY');
  const http = deps.http ? { http: deps.http } : {};
  let provider: SttProvider;
  switch (env.STT_PROVIDER) {
    case 'sarvam':
      provider = new SarvamProvider({ apiKey, ...http, maxWaitMs: VOICE_STT_TIMEOUTS.sarvamWaitMs });
      break;
    case 'elevenlabs':
      provider = new ElevenLabsProvider({ apiKey, ...http, timeoutMs: VOICE_STT_TIMEOUTS.elevenlabsMs });
      break;
    case 'openai':
      provider = new OpenAiProvider({ apiKey, ...http, timeoutMs: VOICE_STT_TIMEOUTS.openaiMs });
      break;
  }
  return voiceTranscriber(provider, { inrPerUsd: env.INR_PER_USD, ffmpeg: deps.ffmpeg, tmpDir: deps.tmpDir });
}
