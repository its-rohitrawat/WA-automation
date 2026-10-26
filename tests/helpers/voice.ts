import { writeFileSync } from 'node:fs';
import { AudioError, Ffmpeg } from '../../src/stt/audio.ts';
import type { AudioPart, ProviderId, ProviderResult, SttProvider, TranscribeOptions } from '../../src/stt/types.ts';
import { VOICE_LENGTH_TOLERANCE_S, type PreparedVoice, type VoiceInput, type VoiceResult, type VoiceTranscriber } from '../../src/stt/voice.ts';

type CostArgs = Parameters<VoiceTranscriber['costUsd']>[0];

export interface FakeVoiceOptions {
  provider?: ProviderId;
  /** The list price per second used by ceilingUsd and costUsd. Default $0.0001 (0.06 for 600 seconds). */
  usdPerSecond?: number;
  /** Default: every format can be sent (ffmpeg is there). */
  canSend?: (mimeType: string | null) => boolean;
  /** What prepare measures on the converted MP3. Default 45. */
  measuredSeconds?: number;
  /** Thrown by prepare instead of preparing. */
  prepareError?: Error;
  /** Answers of transcribe, in order (an Error is thrown); after the last one, "namaste". */
  results?: (Partial<VoiceResult> | Error)[];
  /** Thrown by forget, after the ref is noted. */
  forgetError?: Error;
}

/** A length that may be priced, as in src/stt/voice.ts: a finite number, not negative. */
const usable = (s: number | null): s is number => s !== null && Number.isFinite(s) && s >= 0;

/**
 * A VoiceTranscriber that never runs a program or makes a call. prepare follows the real too_long rule (measured above
 * input.maxSeconds + VOICE_LENGTH_TOLERANCE_S) and costUsd the real order (billed, else measured, else maxSeconds, each
 * ignored when negative, NaN or infinite). Unlike the real one, transcribe does not dispose, so `disposals` counts the
 * caller's own calls.
 */
export class FakeVoiceTranscriber implements VoiceTranscriber {
  readonly provider: ProviderId;
  readonly canForget = true;
  /** Every input prepare was given. */
  readonly prepared: VoiceInput[] = [];
  /** How many notes transcribe was asked for (the paid calls). */
  transcribed = 0;
  /** Every costUsd call, with its arguments. */
  readonly costCalls: CostArgs[] = [];
  /** How many times a prepared note was disposed. */
  disposals = 0;
  /** Every ref forget was asked to delete. */
  readonly forgotten: string[] = [];
  readonly #o: FakeVoiceOptions;
  readonly #results: (Partial<VoiceResult> | Error)[];

  constructor(o: FakeVoiceOptions = {}) {
    this.#o = o;
    this.provider = o.provider ?? 'sarvam';
    this.#results = [...(o.results ?? [])];
  }

  ceilingUsd(seconds: number): number {
    return seconds * (this.#o.usdPerSecond ?? 0.0001);
  }

  costUsd(a: CostArgs): number {
    this.costCalls.push(a);
    const seconds = usable(a.billedSeconds) ? a.billedSeconds : usable(a.measuredSeconds) ? a.measuredSeconds : a.maxSeconds;
    return seconds * (this.#o.usdPerSecond ?? 0.0001);
  }

  canSend(mimeType: string | null): boolean {
    return this.#o.canSend?.(mimeType) ?? true;
  }

  async prepare(input: VoiceInput): Promise<PreparedVoice> {
    this.prepared.push(input);
    if (this.#o.prepareError) throw this.#o.prepareError;
    const measured = this.#o.measuredSeconds ?? 45;
    if (measured > input.maxSeconds + VOICE_LENGTH_TOLERANCE_S) throw new AudioError('too_long');
    const part: AudioPart = { path: `${input.path}.mp3`, seconds: measured, offset: 0, format: 'mp3' };
    return { parts: [part], measuredSeconds: measured, dispose: () => void this.disposals++ };
  }

  async transcribe(_prepared: PreparedVoice): Promise<VoiceResult> {
    this.transcribed++;
    const next = this.#results.shift();
    if (next instanceof Error) throw next;
    return { provider: this.provider, model: 'm1', text: 'namaste', billedSeconds: null, forgetRef: null, ...next };
  }

  async forget(ref: string): Promise<void> {
    this.forgotten.push(ref);
    if (this.#o.forgetError) throw this.#o.forgetError;
  }
}

/** A speech provider for the real voiceTranscriber: records each part and always hears "namaste". */
export class HearingProvider implements SttProvider {
  readonly id: ProviderId;
  readonly maxPartSeconds = 7200;
  readonly calls: AudioPart[] = [];
  constructor(id: ProviderId = 'sarvam') {
    this.id = id;
  }
  async transcribe(audio: AudioPart, _opts: TranscribeOptions): Promise<ProviderResult> {
    this.calls.push(audio);
    return { model: 'm1', segments: [{ start: 0, end: 1, speaker: null, text: 'namaste' }], billedSeconds: null, raw: {} };
  }
}

/**
 * An Ffmpeg that never starts a program: toMp3 writes a small file, and the MP3 measures at a set length, cut at the
 * conversion's maxSeconds as the real -t would.
 */
export class MeasuringFfmpeg extends Ffmpeg {
  readonly length: number;
  /** The maxSeconds of every conversion. */
  readonly limits: (number | undefined)[] = [];
  #cutAt = Number.POSITIVE_INFINITY;
  constructor(length: number) {
    super('ffmpeg-never-run', async () => {
      throw new Error('no program is run in these tests');
    });
    this.length = length;
  }
  override async toMp3(_input: string, output: string, _signal?: AbortSignal, opts: { maxSeconds?: number } = {}): Promise<void> {
    this.limits.push(opts.maxSeconds);
    this.#cutAt = opts.maxSeconds ?? Number.POSITIVE_INFINITY;
    writeFileSync(output, 'mp3');
  }
  override async seconds(_input: string): Promise<number> {
    return Math.min(this.length, this.#cutAt);
  }
}
