import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { requireKey, type Env } from '../config/env.ts';
import { AudioError, type Ffmpeg } from './audio.ts';
import type { HttpFetch } from './http.ts';
import { LocalEngine, LocalEngineError, type LocalEngineName, type LocalRunFile } from './local.ts';
import { costUsd, modelFor } from './prices.ts';
import { ElevenLabsProvider } from './providers/elevenlabs.ts';
import { OpenAiProvider } from './providers/openai.ts';
import { SarvamProvider } from './providers/sarvam.ts';
import type { AudioPart, ProviderId, ProviderResult, SttProvider } from './types.ts';

/*
 * Voice notes and audio files (Phase 2b), the voice-note sibling of the meeting transcriber in src/meetings/transcribe.ts.
 * VOICE_STT_PROVIDER picks the transcriber (Phase 2b amendment, 2026-10-26-local-stt.md): 'local', the free engine on
 * this machine (localVoiceTranscriber, below), or a paid adapter, the one STT_PROVIDER names for meetings (the env rule
 * makes them equal: both use STT_API_KEY), with speaker labels off and short timeouts. What follows is the paid path.
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

/** The voice transcriber's provider: a paid adapter's id, or 'local' for the engine on this machine. Meetings keep ProviderId. */
export type VoiceProviderId = ProviderId | 'local';

/**
 * Whether a file can be sent: only when ffmpeg is there, for every provider and every format, since every file is
 * converted first (Task 5 review round 1, amending V3 and N2; for 'local', to the engine's WAV). The rule behind every
 * transcriber's canSend, exported so `cli transcribe-voice` can apply it without a key or a provider. The provider and
 * MIME type stay as arguments so a caller says what it asks about; neither changes the answer.
 */
export function canSendVoice(_provider: VoiceProviderId, _mimeType: string | null, hasFfmpeg: boolean): boolean {
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
  /**
   * Stops the conversion and measuring (Phase 2b final review). The extractor passes the service's stop signal for the
   * local engine only, which turns a stop into LocalEngineError('aborted'): the processor gives the attempt back. A paid
   * note is never given one.
   */
  signal?: AbortSignal;
}

/** A note made ready to send by prepare, for one transcribe. */
export interface PreparedVoice {
  /** The parts to send, in order: MP3 files in the note's temporary folder. Empty for the local engine, which reads wav. */
  readonly parts: readonly AudioPart[];
  /**
   * The local engine's input only (absent for a paid provider): the 16 kHz mono WAV in the note's temporary folder, and
   * its mean volume in dB (null when ffmpeg reported none), for the empty-output rule.
   */
  readonly wav?: { readonly path: string; readonly meanVolumeDb: number | null };
  /** The length ffmpeg measured on the MP3 (or WAV) it wrote: trusted, unlike the original's header. */
  readonly measuredSeconds: number;
  /** Removes the note's temporary folder. Safe to call twice; never throws. */
  dispose(): void;
}

export interface VoiceResult {
  /** 'local' for the engine on this machine. */
  provider: VoiceProviderId;
  /** For 'local', the engine's name (STT_LOCAL_ENGINE). */
  model: string;
  /** The segments' text joined with spaces, trimmed. Empty when no speech was heard. */
  text: string;
  /** Seconds the provider says it billed, summed over parts; null when any part did not say (always null for 'local'). */
  billedSeconds: number | null;
  /** The provider's id for its stored copy (ElevenLabs), for N1; null when it keeps none (always null for 'local'). */
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

/** What every voice transcriber does; VoiceTranscriber says whether it is paid or free. */
interface VoiceTranscriberSteps {
  /**
   * List-price ceiling for this many seconds of audio, without speaker labels, in US dollars (the spend hold). The caller
   * holds ceilingUsd(prepared.measuredSeconds + VOICE_LENGTH_TOLERANCE_S): the tolerance is headroom over a provider's
   * billed rounding (Task 5 review round 2). 0 for 'local'.
   */
  ceilingUsd(seconds: number): number;
  /**
   * List-price cost of a finished note (V5): the billed seconds when reported, else the measured length, else maxSeconds
   * (the bound). Never the sender's declared length, so a declared 0 cannot lower the booking (Task 5 review round 1).
   * A negative, NaN or infinite length is ignored. 0 for 'local'.
   */
  costUsd(o: { maxSeconds: number; billedSeconds: number | null; measuredSeconds: number | null }): number;
  /** Whether this file can be sent: whether ffmpeg is there, whatever the format (canSendVoice). */
  canSend(mimeType: string | null): boolean;
  /**
   * The free, local step: no provider call. Converts, measures and splits for OpenAI (for 'local': converts to the
   * engine's WAV, measures it and its mean volume). Throws AudioError('too_long') when the measured length exceeds
   * input.maxSeconds + VOICE_LENGTH_TOLERANCE_S (a conversion stopped by -t does too), AudioError('no_ffmpeg') without
   * ffmpeg, and ffmpeg's own AudioError; the folder is removed first. Run it outside the spend hold.
   */
  prepare(input: VoiceInput): Promise<PreparedVoice>;
  /**
   * Paid: one provider call per part, in order. Never retried, never aborted (the signal is ignored). A failure of the
   * first part reaches the caller unchanged; a later one is an SttPartialError.
   * 'local': one engine run, which the signal stops (LocalEngineError('aborted')); every other failure is a
   * LocalEngineError too, empty_output included (localVoiceTranscriber).
   * Always disposes the prepared note.
   */
  transcribe(prepared: PreparedVoice, signal?: AbortSignal): Promise<VoiceResult>;
  readonly canForget: boolean;
  /** Deletes the provider's stored copy named by a forgetRef. Free. Does nothing for 'local'. */
  forget(ref: string): Promise<void>;
}

/** A paid provider: the extractor runs transcribe inside one spend hold (withSttHold). */
export interface PaidVoiceTranscriber extends VoiceTranscriberSteps {
  readonly provider: ProviderId;
  readonly costsNothing: false;
}

/**
 * The local engine on this machine (Phase 2b amendment L2): it costs nothing, so the extractor runs it with no hold, no
 * too_costly and no spend row. It keeps no copies.
 */
export interface LocalVoiceTranscriber extends VoiceTranscriberSteps {
  readonly provider: 'local';
  readonly costsNothing: true;
  readonly canForget: false;
}

export type VoiceTranscriber = PaidVoiceTranscriber | LocalVoiceTranscriber;

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

/** What convertNote hands on: the note's folder, the converted file, its measured length, and how to remove the folder. */
interface ConvertedNote {
  ffmpeg: Ffmpeg;
  dir: string;
  path: string;
  measured: number;
  dispose: () => void;
}

/**
 * The first half of every prepare, paid or local: converts the note in a folder of its own named after the media id,
 * stopped one second past what is allowed, measures what ffmpeg wrote, and applies the too_long rule. `next` finishes
 * the note from there. On any failure, the folder is removed and the error rethrown.
 */
async function convertNote(
  o: { ffmpeg: Ffmpeg | null; tmpDir: string },
  input: VoiceInput,
  to: 'mp3' | 'wav',
  next: (c: ConvertedNote) => Promise<PreparedVoice>,
): Promise<PreparedVoice> {
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
    const path = join(dir, `audio.${to}`);
    // Stopped one second past what is allowed: a longer note is never converted whole, whatever its header claims.
    const opts = { maxSeconds: allowed + 1, timeoutMs: VOICE_CONVERT_TIMEOUT_MS };
    // input.signal stops ffmpeg (only the local engine's notes are given one, Phase 2b final review).
    if (to === 'mp3') await ffmpeg.toMp3(input.path, path, input.signal, opts);
    else await ffmpeg.toWav(input.path, path, input.signal, opts);
    // The file ffmpeg wrote, so its length can be trusted; the original's header is the sender's.
    const measured = await ffmpeg.seconds(path, input.signal);
    if (!measurable(measured)) throw new AudioError('no_duration');
    // Also refuses a conversion that reached the -t limit: it measures about allowed + 1.
    if (measured > allowed) throw new AudioError('too_long');
    return await next({ ffmpeg, dir, path, measured, dispose });
  } catch (e) {
    dispose();
    throw e;
  }
}

/** A VoiceTranscriber over any provider, with speaker labels off. Exported for tests (a fake provider and ffmpeg). */
export function voiceTranscriber(provider: SttProvider, o: { inrPerUsd: number; ffmpeg: Ffmpeg | null; tmpDir: string }): PaidVoiceTranscriber {
  const price = modelFor(provider.id, false);
  const send = (part: AudioPart): Promise<ProviderResult> =>
    provider.transcribe({ path: part.path, seconds: part.seconds, offset: part.offset, format: 'mp3' }, { diarize: false });

  return {
    provider: provider.id,
    costsNothing: false,
    ceilingUsd: (seconds) => voiceCeilingUsd(provider.id, seconds, o.inrPerUsd),
    costUsd: ({ maxSeconds, billedSeconds, measuredSeconds }) => {
      const seconds = usable(billedSeconds) ? billedSeconds : usable(measuredSeconds) ? measuredSeconds : maxSeconds;
      return costUsd(price, seconds, o.inrPerUsd);
    },
    canSend: (mimeType) => canSendVoice(provider.id, mimeType, o.ffmpeg !== null),
    prepare: (input) =>
      convertNote(o, input, 'mp3', async ({ ffmpeg, dir, path: mp3, measured, dispose }) => {
        const whole: AudioPart = { path: mp3, seconds: measured, offset: 0, format: 'mp3' };
        const parts = measured > provider.maxPartSeconds ? await ffmpeg.split(whole, join(dir, 'parts'), provider.maxPartSeconds) : [whole];
        return { parts: parts.map((p) => ({ path: p.path, seconds: p.seconds, offset: p.offset, format: 'mp3' })), measuredSeconds: measured, dispose };
      }),
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
 * A mean volume at or below this is silence (Phase 2b amendment, PC test): an empty transcript of it is "no speech".
 * Above it, or unknown, an empty transcript is the engine's failure (empty_output), retried: a note is never lost quietly.
 */
export const LOCAL_SILENCE_DB = -50;

/** Whether a note's mean volume is silence. Unknown (null) is not: the note is retried rather than lost. */
const silent = (meanVolumeDb: number | null): boolean => meanVolumeDb !== null && meanVolumeDb <= LOCAL_SILENCE_DB;

/**
 * A transcript made only of whisper's non-speech markers, such as "[BLANK_AUDIO]", "[ Silence ]", "(silence)" or
 * "[MUSIC]" (review round 1, fix 4): one or more [...] or (...) groups and spaces, nothing else. Text with any word
 * outside a group is real text, kept as it is.
 */
const ONLY_MARKERS = /^\s*(?:(?:\[[^[\]]*\]|\([^()]*\))\s*)+$/;

/**
 * The local engine as a VoiceTranscriber (Phase 2b amendment L2). It costs nothing: ceilingUsd and costUsd are 0, and
 * the extractor holds no money for it. It keeps no copies, so forget does nothing. canSend is whether ffmpeg is there
 * (the engine's files are checked when the service starts, Task 10).
 * - prepare converts the note to a 16 kHz mono WAV (voice-<id>/audio.wav), stopped and measured as for the paid path,
 *   with the same too_long rule, then measures its mean volume. input.signal stops each ffmpeg step; a stop is
 *   LocalEngineError('aborted') (Phase 2b final review).
 * - tmpDir is resolved to an absolute path first (review round 1), as the engine takes absolute paths only.
 * - transcribe runs the engine once, in the note's folder, stopped by the signal. For whisper, a transcript made only of
 *   its non-speech markers ([BLANK_AUDIO], [ Silence ], (silence), [MUSIC], ...) counts as empty (review round 1).
 *   EMPTY-OUTPUT RULE: an empty transcript of a note that is not silent (mean volume above LOCAL_SILENCE_DB, or
 *   unknown) is LocalEngineError('empty_output'), retried by the processor; of a silent note it is '' (no speech).
 * Nothing is logged here. Exported for tests (a fake engine and ffmpeg).
 */
export function localVoiceTranscriber(
  engine: Pick<LocalEngine, 'transcribe'>,
  given: { engine: LocalEngineName; ffmpeg: Ffmpeg | null; tmpDir: string },
): LocalVoiceTranscriber {
  // Absolute (review round 1, fix 3): the engine refuses a WAV path that is not.
  const o = { ...given, tmpDir: resolve(given.tmpDir) };
  return {
    provider: 'local',
    costsNothing: true,
    ceilingUsd: () => 0,
    costUsd: () => 0,
    canSend: (mimeType) => canSendVoice('local', mimeType, o.ffmpeg !== null),
    // The stop signal (input.signal) stops the conversion and the measuring too (Phase 2b final review), so a note being
    // converted never holds up the shutdown. A stop is LocalEngineError('aborted'), as for a stopped run: free, so the
    // processor gives the attempt back. Any other failure is thrown as it is (convertNote removed the folder).
    async prepare(input) {
      try {
        return await convertNote(o, input, 'wav', async ({ ffmpeg, path, measured, dispose }) => {
          const meanVolumeDb = await ffmpeg.meanVolumeDb(path, input.signal);
          return { parts: [], wav: { path, meanVolumeDb }, measuredSeconds: measured, dispose };
        });
      } catch (e) {
        if (input.signal?.aborted) throw new LocalEngineError('aborted');
        throw e;
      }
    },
    async transcribe(prepared, signal) {
      try {
        const wav = prepared.wav;
        if (wav === undefined) throw new Error('local voice transcribe: the note was not prepared for the local engine');
        const ran = await engine.transcribe(wav.path, { workDir: dirname(wav.path), ...(signal ? { signal } : {}) });
        // whisper writes a marker for silence, never an empty file: such a transcript is empty, before the rule below.
        const text = o.engine === 'whisper' && ONLY_MARKERS.test(ran.text) ? '' : ran.text;
        if (text === '' && !silent(wav.meanVolumeDb)) throw new LocalEngineError('empty_output');
        return { provider: 'local', model: o.engine, text, billedSeconds: null, forgetRef: null };
      } finally {
        prepared.dispose();
      }
    },
    canForget: false,
    async forget() {
      // The local engine keeps no copies.
    },
  };
}

/**
 * The voice transcriber VOICE_STT_PROVIDER names, or null when it is 'none' (STT_PROVIDER no longer decides voice
 * notes; it stays the meetings' setting).
 * - 'local': the engine STT_LOCAL_ENGINE, STT_LOCAL_BIN, STT_LOCAL_MODEL, STT_LOCAL_THREADS, STT_LOCAL_TIMEOUT_SECONDS
 *   and STT_LOCAL_LANGUAGE set, working inside deps.tmpDir; deps.localRun replaces its runner in tests. No key.
 * - a paid provider: the env rule makes it equal STT_PROVIDER, whose key STT_API_KEY goes to the provider's constructor
 *   and nowhere else; deps.http replaces the network in tests.
 * deps.ffmpeg is null when there is none (then nothing is sent: canSend is false for every file); deps.tmpDir holds the
 * conversion folders.
 */
export function createVoiceTranscriber(
  env: Env,
  deps: { ffmpeg: Ffmpeg | null; tmpDir: string; http?: HttpFetch; localRun?: LocalRunFile },
): VoiceTranscriber | null {
  const choice = env.VOICE_STT_PROVIDER;
  if (choice === 'none') return null;
  if (choice === 'local') {
    const bin = env.STT_LOCAL_BIN;
    const model = env.STT_LOCAL_MODEL;
    // parseEnv refuses this already; checked again for an Env built by hand (defence in depth).
    if (bin === undefined || model === undefined) throw new Error('STT_LOCAL_BIN and STT_LOCAL_MODEL are required when VOICE_STT_PROVIDER is local');
    // Absolute (review round 1, fix 3), so a relative tmpDir cannot break the engine's absolute-path rule.
    const tmpDir = resolve(deps.tmpDir);
    const engine = new LocalEngine({
      engine: env.STT_LOCAL_ENGINE,
      bin,
      model,
      threads: env.STT_LOCAL_THREADS,
      timeoutMs: env.STT_LOCAL_TIMEOUT_SECONDS * 1000,
      language: env.STT_LOCAL_LANGUAGE,
      tmpDir,
      ...(deps.localRun ? { run: deps.localRun } : {}),
    });
    return localVoiceTranscriber(engine, { engine: env.STT_LOCAL_ENGINE, ffmpeg: deps.ffmpeg, tmpDir });
  }
  // parseEnv refuses this already; checked again because STT_API_KEY is the meetings' provider's key.
  if (choice !== env.STT_PROVIDER) throw new Error('VOICE_STT_PROVIDER must be local, none or the same as STT_PROVIDER');
  const apiKey = requireKey(env, 'STT_API_KEY');
  const http = deps.http ? { http: deps.http } : {};
  let provider: SttProvider;
  switch (choice) {
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
