import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { requireKey, type Env } from '../config/env.ts';
import { AudioError, type Ffmpeg } from './audio.ts';
import type { HttpFetch } from './http.ts';
import { costUsd, modelFor } from './prices.ts';
import { ElevenLabsProvider } from './providers/elevenlabs.ts';
import { OpenAiProvider } from './providers/openai.ts';
import { SarvamProvider } from './providers/sarvam.ts';
import type { AudioFormat, AudioPart, ProviderId, ProviderResult, SttProvider } from './types.ts';

/*
 * Voice notes and audio files (Phase 2b), the voice-note sibling of the meeting transcriber in src/meetings/transcribe.ts.
 * Same adapters, picked by the same STT_PROVIDER, with speaker labels off and short timeouts.
 * - WhatsApp voice notes (Ogg Opus) and MP3 files go to Sarvam and ElevenLabs as they are (V3).
 * - Any other audio, and every file when OpenAI is chosen, is converted to MP3 with ffmpeg first (N2), in a folder of
 *   its own named after the media id; OpenAI notes longer than its 5-minute limit are split there.
 * - Two steps. prepare is free and local: it converts, measures and splits, and refuses a note that measures longer
 *   than allowed (V5), so a low-bitrate file never becomes many paid parts and a local failure books nothing. transcribe
 *   is the paid step, run by the extractor inside one spend hold (withSttHold).
 * - One provider call per part. Nothing is retried and no call is aborted: each call is billed, and the spend hold
 *   books by its outcome. Once a part has been answered, a later part's failure is an SttPartialError, so the hold
 *   books the ceiling for the parts already billed.
 * The sender's MIME type is only compared, as a lower-cased base type, with the fixed sets below. It never reaches a
 * provider: the format sent is always one of the literals 'ogg' or 'mp3' chosen here.
 * Logs: none here. The extractor logs ids, provider, seconds and cost.
 */

/** Voice notes are short: these stay well inside SpendGuard's 45-minute hold and the media queue's 15-minute claim. */
export const VOICE_STT_TIMEOUTS = { elevenlabsMs: 5 * 60_000, openaiMs: 5 * 60_000, sarvamWaitMs: 10 * 60_000 };

/** The lowest bitrate assumed for the spend hold (V5): a file of n bytes holds at most n × 8 / 12,000 seconds. */
const MIN_BITRATE_BPS = 12_000;
export const sizeBoundSeconds = (bytes: number): number => Math.ceil((bytes * 8) / MIN_BITRATE_BPS);

/**
 * How far a measured length may exceed VoiceInput.maxSeconds (the cap) before prepare refuses the note as too_long.
 * ffmpeg's summary rounds, and a conversion can add a few frames of padding.
 */
export const VOICE_LENGTH_TOLERANCE_S = 5;

/** 'Audio/Ogg; codecs=opus' -> 'audio/ogg'. Only ever compared with the sets below. */
const baseMime = (m: string | null): string => ((m ?? '').toLowerCase().split(';')[0] ?? '').trim();
const OGG = new Set(['audio/ogg', 'audio/opus']);
const MP3 = new Set(['audio/mpeg', 'audio/mp3']);

/**
 * The format a file goes in as it is, or null when it must be converted with ffmpeg first. OpenAI always gets a
 * conversion; Sarvam and ElevenLabs take Ogg and MP3 as they are (V3, N2).
 */
function sendAsIs(provider: ProviderId, mimeType: string | null): AudioFormat | null {
  if (provider === 'openai') return null;
  const base = baseMime(mimeType);
  if (OGG.has(base)) return 'ogg';
  if (MP3.has(base)) return 'mp3';
  return null;
}

/**
 * Whether a file can be sent: as it is, or converted because ffmpeg is there (N2). The rule behind every transcriber's
 * canSend, exported so `cli transcribe-voice` can apply it without a key or a provider.
 */
export function canSendVoice(provider: ProviderId, mimeType: string | null, hasFfmpeg: boolean): boolean {
  return sendAsIs(provider, mimeType) !== null || hasFfmpeg;
}

/** The longest provider id for a stored copy that is kept (as for meetings); a longer one is not an id. */
const MAX_REF_LENGTH = 200;

/** One voice note or audio file to transcribe. The file is read from path; nothing the sender named is used. */
export interface VoiceInput {
  /** For logs and the temporary folder only. */
  mediaId: number;
  /** Absolute path of the saved original (DATA_DIR/media/...). */
  path: string;
  /** From the row, e.g. 'audio/ogg; codecs=opus'. Untrusted: only its base type is compared with a fixed list. */
  mimeType: string | null;
  /**
   * The cap in seconds (STT_MAX_SECONDS, V5), not the size bound and never the sender's declared length. A note ffmpeg
   * measures longer than this (plus VOICE_LENGTH_TOLERANCE_S) is refused by prepare. The caller refuses a file whose size
   * bound is above the cap before preparing it, and holds the larger of the bound and the measured length.
   */
  maxSeconds: number;
}

/** A note made ready to send by prepare, for one transcribe. */
export interface PreparedVoice {
  /** The parts to send, in order: the original as it is, or MP3 files in the note's temporary folder. */
  readonly parts: readonly AudioPart[];
  /** The length ffmpeg measured; null when the file goes as it is and ffmpeg is absent or could not measure it. */
  readonly measuredSeconds: number | null;
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
   * holds ceilingUsd(Math.max(bound, prepared.measuredSeconds ?? 0)), so a measured length up to the tolerance is covered.
   */
  ceilingUsd(seconds: number): number;
  /**
   * List-price cost of a finished note (V5): the billed seconds when reported, else the measured length, else
   * min(maxSeconds, declared), else maxSeconds. A negative, NaN or infinite length is ignored.
   */
  costUsd(o: { maxSeconds: number; billedSeconds: number | null; declaredSeconds: number | null; measuredSeconds: number | null }): number;
  /** Whether this file can be sent: as it is, or converted because ffmpeg is there (N2). */
  canSend(mimeType: string | null): boolean;
  /**
   * The free, local step: no provider call. Picks the format, converts, measures and splits for OpenAI. Throws
   * AudioError('too_long') when the measured length exceeds input.maxSeconds + VOICE_LENGTH_TOLERANCE_S, AudioError
   * ('no_ffmpeg') when a conversion is needed without ffmpeg, and ffmpeg's own AudioError; the folder is removed first.
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
  const asIs = (mimeType: string | null): AudioFormat | null => sendAsIs(provider.id, mimeType);
  const send = (part: AudioPart): Promise<ProviderResult> =>
    provider.transcribe({ path: part.path, seconds: part.seconds, offset: part.offset, format: part.format ?? 'mp3' }, { diarize: false });
  const tooLong = (measured: number | null, input: VoiceInput): boolean =>
    measured !== null && measured > input.maxSeconds + VOICE_LENGTH_TOLERANCE_S;

  return {
    provider: provider.id,
    ceilingUsd: (seconds) => voiceCeilingUsd(provider.id, seconds, o.inrPerUsd),
    costUsd: ({ maxSeconds, billedSeconds, declaredSeconds, measuredSeconds }) => {
      const seconds = usable(billedSeconds)
        ? billedSeconds
        : usable(measuredSeconds)
          ? measuredSeconds
          : usable(declaredSeconds) ? Math.min(maxSeconds, declaredSeconds) : maxSeconds;
      return costUsd(price, seconds, o.inrPerUsd);
    },
    canSend: (mimeType) => canSendVoice(provider.id, mimeType, o.ffmpeg !== null),
    async prepare(input) {
      // The folder is named from the numeric id only, never from a path or name the sender gave.
      if (!Number.isSafeInteger(input.mediaId) || input.mediaId < 1) throw new Error('voice prepare: the media id is not a positive whole number');
      const format = asIs(input.mimeType);
      if (format !== null) {
        // Sent as it is, with no folder. ffmpeg, when there, only measures the original: a file it cannot measure
        // still goes (V3), held at the size bound.
        let measured: number | null = null;
        if (o.ffmpeg !== null) {
          try {
            const s = await o.ffmpeg.seconds(input.path);
            measured = measurable(s) ? s : null;
          } catch {
            measured = null;
          }
        }
        if (tooLong(measured, input)) throw new AudioError('too_long');
        const part: AudioPart = { path: input.path, seconds: measured ?? input.maxSeconds, offset: 0, format };
        return { parts: [part], measuredSeconds: measured, dispose: () => {} };
      }
      if (o.ffmpeg === null) throw new AudioError('no_ffmpeg');
      const ffmpeg = o.ffmpeg;
      const dir = join(o.tmpDir, `voice-${input.mediaId}`);
      const dispose = folderRemover(dir);
      try {
        // A folder left by an earlier crash goes first, so no stale conversion or parts are reused.
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        const mp3 = join(dir, 'audio.mp3');
        await ffmpeg.toMp3(input.path, mp3);
        const measured = await ffmpeg.seconds(mp3);
        if (!measurable(measured)) throw new AudioError('no_duration');
        if (tooLong(measured, input)) throw new AudioError('too_long');
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
 * and nowhere else. deps.ffmpeg is null when there is none (then only Ogg and MP3 go, to Sarvam or ElevenLabs);
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
