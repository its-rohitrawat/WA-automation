import { AudioError, Ffmpeg } from '../../src/stt/audio.ts';
import type { AudioPart, ProviderId, ProviderResult, SttProvider, TranscribeOptions } from '../../src/stt/types.ts';
import { VOICE_LENGTH_TOLERANCE_S, type PreparedVoice, type VoiceInput, type VoiceResult, type VoiceTranscriber } from '../../src/stt/voice.ts';

type CostArgs = Parameters<VoiceTranscriber['costUsd']>[0];

export interface FakeVoiceOptions {
  provider?: ProviderId;
  /** The list price per second used by ceilingUsd and costUsd. Default $0.0001 (0.06 for 600 seconds). */
  usdPerSecond?: number;
  /** Default: every format can be sent. */
  canSend?: (mimeType: string | null) => boolean;
  /** What prepare measures. Default null (sent as it is, ffmpeg absent). */
  measuredSeconds?: number | null;
  /** Thrown by prepare instead of preparing. */
  prepareError?: Error;
  /** Answers of transcribe, in order (an Error is thrown); after the last one, "namaste". */
  results?: (Partial<VoiceResult> | Error)[];
}

/**
 * A VoiceTranscriber that never runs a program or makes a call. prepare follows the real too_long rule (measured above
 * input.maxSeconds + VOICE_LENGTH_TOLERANCE_S). Unlike the real one, transcribe does not dispose, so `disposals` counts
 * the caller's own calls.
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
    const seconds = a.billedSeconds ?? a.measuredSeconds ?? (a.declaredSeconds === null ? a.maxSeconds : Math.min(a.maxSeconds, a.declaredSeconds));
    return seconds * (this.#o.usdPerSecond ?? 0.0001);
  }

  canSend(mimeType: string | null): boolean {
    return this.#o.canSend?.(mimeType) ?? true;
  }

  async prepare(input: VoiceInput): Promise<PreparedVoice> {
    this.prepared.push(input);
    if (this.#o.prepareError) throw this.#o.prepareError;
    const measured = this.#o.measuredSeconds ?? null;
    if (measured !== null && measured > input.maxSeconds + VOICE_LENGTH_TOLERANCE_S) throw new AudioError('too_long');
    const part: AudioPart = { path: input.path, seconds: measured ?? input.maxSeconds, offset: 0, format: 'ogg' };
    return { parts: [part], measuredSeconds: measured, dispose: () => void this.disposals++ };
  }

  async transcribe(_prepared: PreparedVoice): Promise<VoiceResult> {
    this.transcribed++;
    const next = this.#results.shift();
    if (next instanceof Error) throw next;
    return { provider: this.provider, model: 'm1', text: 'namaste', billedSeconds: null, forgetRef: null, ...next };
  }

  async forget(_ref: string): Promise<void> {}
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

/** An Ffmpeg that never starts a program: it only measures, at a set length. */
export class MeasuringFfmpeg extends Ffmpeg {
  readonly length: number;
  constructor(length: number) {
    super('ffmpeg-never-run', async () => {
      throw new Error('no program is run in these tests');
    });
    this.length = length;
  }
  override async seconds(_input: string): Promise<number> {
    return this.length;
  }
}
