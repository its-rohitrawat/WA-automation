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
 * - One provider call per part. Nothing is retried and no call is aborted: each call is billed, and the spend hold
 *   (withSttHold, in the extractor) books by its outcome.
 * The sender's MIME type is only compared, as a lower-cased base type, with the fixed sets below. It never reaches a
 * provider: the format sent is always one of the literals 'ogg' or 'mp3' chosen here.
 * Logs: none here. The extractor logs ids, provider, seconds and cost.
 */

/** Voice notes are short: these stay well inside SpendGuard's 45-minute hold and the media queue's 15-minute claim. */
export const VOICE_STT_TIMEOUTS = { elevenlabsMs: 5 * 60_000, openaiMs: 5 * 60_000, sarvamWaitMs: 10 * 60_000 };

/** The lowest bitrate assumed for the spend hold (V5): a file of n bytes holds at most n × 8 / 12,000 seconds. */
const MIN_BITRATE_BPS = 12_000;
export const sizeBoundSeconds = (bytes: number): number => Math.ceil((bytes * 8) / MIN_BITRATE_BPS);

/** 'Audio/Ogg; codecs=opus' -> 'audio/ogg'. Only ever compared with the sets below. */
const baseMime = (m: string | null): string => ((m ?? '').toLowerCase().split(';')[0] ?? '').trim();
const OGG = new Set(['audio/ogg', 'audio/opus']);
const MP3 = new Set(['audio/mpeg', 'audio/mp3']);

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
  /** Upper bound in seconds, from the file size (V5). Never the sender's declared length. */
  maxSeconds: number;
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

export interface VoiceTranscriber {
  readonly provider: ProviderId;
  /** List-price ceiling for maxSeconds of audio, without speaker labels, in US dollars (the spend hold). */
  ceilingUsd(maxSeconds: number): number;
  /** List-price cost of a finished note (V5): billed seconds when reported, else min(maxSeconds, declared). */
  costUsd(maxSeconds: number, billedSeconds: number | null, declaredSeconds: number | null): number;
  /** Whether this file can be sent: as it is, or converted because ffmpeg is there (N2). */
  canSend(mimeType: string | null): boolean;
  /** One note: one provider call, or one per part for OpenAI notes over 300 s. Never retried, never aborted. */
  transcribe(input: VoiceInput): Promise<VoiceResult>;
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

/** A VoiceTranscriber over any provider, with speaker labels off. Exported for tests (a fake provider and ffmpeg). */
export function voiceTranscriber(provider: SttProvider, o: { inrPerUsd: number; ffmpeg: Ffmpeg | null; tmpDir: string }): VoiceTranscriber {
  const price = modelFor(provider.id, false);
  /** The format a file is sent in as it is, or null when it must be converted first. OpenAI always gets a conversion. */
  const asIs = (mimeType: string | null): AudioFormat | null => {
    if (provider.id === 'openai') return null;
    const base = baseMime(mimeType);
    if (OGG.has(base)) return 'ogg';
    if (MP3.has(base)) return 'mp3';
    return null;
  };
  const send = (part: AudioPart): Promise<ProviderResult> => provider.transcribe(part, { diarize: false });

  return {
    provider: provider.id,
    ceilingUsd: (maxSeconds) => voiceCeilingUsd(provider.id, maxSeconds, o.inrPerUsd),
    costUsd: (maxSeconds, billedSeconds, declaredSeconds) => {
      const seconds = usable(billedSeconds) ? billedSeconds : usable(declaredSeconds) ? Math.min(maxSeconds, declaredSeconds) : maxSeconds;
      return costUsd(price, seconds, o.inrPerUsd);
    },
    canSend: (mimeType) => asIs(mimeType) !== null || o.ffmpeg !== null,
    async transcribe(input) {
      // The folder is named from the numeric id only, never from a path or name the sender gave.
      if (!Number.isSafeInteger(input.mediaId) || input.mediaId < 1) throw new Error('voice transcribe: the media id is not a positive whole number');
      const dir = join(o.tmpDir, `voice-${input.mediaId}`);
      // A folder left by an earlier crash goes first, so no stale conversion or parts are reused.
      rmSync(dir, { recursive: true, force: true });
      const format = asIs(input.mimeType);
      if (format !== null) return combine(provider, [await send({ path: input.path, seconds: input.maxSeconds, offset: 0, format })]);
      if (o.ffmpeg === null) throw new AudioError('no_ffmpeg');
      try {
        mkdirSync(dir, { recursive: true });
        const mp3 = join(dir, 'audio.mp3');
        await o.ffmpeg.toMp3(input.path, mp3);
        // The measured length is used only to split. Spend still uses maxSeconds.
        const whole: AudioPart = { path: mp3, seconds: await o.ffmpeg.seconds(mp3), offset: 0, format: 'mp3' };
        const parts = whole.seconds > provider.maxPartSeconds ? await o.ffmpeg.split(whole, join(dir, 'parts'), provider.maxPartSeconds) : [whole];
        const results: ProviderResult[] = [];
        for (const p of parts) results.push(await send({ path: p.path, seconds: p.seconds, offset: p.offset, format: 'mp3' }));
        return combine(provider, results);
      } finally {
        // Best-effort: a folder that cannot be removed now is removed before this note is tried again, and a failure
        // here must not hide the outcome of a paid call.
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // left for the next try
        }
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
