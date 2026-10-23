export type ProviderId = 'sarvam' | 'elevenlabs' | 'openai';
export const PROVIDER_IDS: readonly ProviderId[] = ['sarvam', 'elevenlabs', 'openai'];

/** Voice notes are sent without speaker labels; meetings with speaker labels (diarization) on. */
export type SampleKind = 'voice' | 'meeting';

/** One stretch of speech, in seconds from the start of the audio. speaker is null when the provider gave none. */
export interface Segment {
  start: number;
  end: number;
  speaker: string | null;
  text: string;
}

/** Audio as sent to a provider: a mono 16 kHz MP3 made by src/stt/audio.ts. offset is where it starts in the whole file. */
export interface AudioPart {
  path: string;
  seconds: number;
  offset: number;
}

export interface TranscribeOptions {
  diarize: boolean;
  /** A provider job id saved by an earlier run whose answer never arrived: wait for that job instead of sending again. */
  resumeJobId?: string;
  /** Called once the provider has accepted the work and given it an id, before waiting for the result. */
  onJobId?: (id: string) => void;
}

export interface ProviderResult {
  model: string;
  /** Times relative to the start of the part that was sent. */
  segments: Segment[];
  /** Seconds the provider reports as billed, when it reports them. */
  billedSeconds: number | null;
  /** The provider's own JSON, kept only in the private output folder so the report can be rebuilt without paying again. */
  raw: unknown;
}

export interface SttProvider {
  readonly id: ProviderId;
  /** Longest audio one request may carry. Longer files are split into parts of at most this length. */
  readonly maxPartSeconds: number;
  transcribe(audio: AudioPart, opts: TranscribeOptions): Promise<ProviderResult>;
  /** Deletes the provider's own stored copy of this answer. Called only after the answer is saved locally. Free. */
  forget?(result: ProviderResult): Promise<void>;
  /** The provider's id for its stored copy of this answer (an id only, never content), or null when there is none. */
  forgetRef?(result: ProviderResult): string | null;
  /** Deletes the provider's stored copy named by forgetRef, so it can be done later from a stored id. Free. */
  forgetById?(ref: string): Promise<void>;
}
