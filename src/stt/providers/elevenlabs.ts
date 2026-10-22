import { openAsBlob } from 'node:fs';
import { z } from 'zod';
import { longFetch, parseAnswer, requestJson, type HttpFetch } from '../http.ts';
import { modelFor } from '../prices.ts';
import { wordsToSegments, type TimedWord } from '../segments.ts';
import type { AudioPart, ProviderResult, Segment, SttProvider, TranscribeOptions } from '../types.ts';

const ENDPOINT = 'https://api.elevenlabs.io/v1/speech-to-text';

const ResultSchema = z.object({
  text: z.string().nullish(),
  words: z
    .array(
      z.object({ text: z.string(), type: z.string(), start: z.number().nullish(), end: z.number().nullish(), speaker_id: z.string().nullish() }),
    )
    .nullish(),
  audio_duration_secs: z.number().nullish(),
});
type ElevenLabsResult = z.output<typeof ResultSchema>;

export interface ElevenLabsOptions {
  apiKey: string;
  http?: HttpFetch;
  timeoutMs?: number;
}

/**
 * ElevenLabs Scribe v2, one synchronous request per file. With language "hin", ElevenLabs keeps English words in Latin
 * script. Audio-event tags such as "(laughter)" are off. Nothing is retried, because each request is billed.
 */
export class ElevenLabsProvider implements SttProvider {
  readonly id = 'elevenlabs' as const;
  /** Files of up to 10 hours are accepted, so a meeting goes in whole and keeps one set of speaker labels. */
  readonly maxPartSeconds = 36_000;
  readonly #key: string;
  readonly #http: HttpFetch;
  readonly #timeoutMs: number;

  constructor(opts: ElevenLabsOptions) {
    this.#key = opts.apiKey;
    this.#http = opts.http ?? longFetch;
    this.#timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  }

  async transcribe(audio: AudioPart, opts: TranscribeOptions): Promise<ProviderResult> {
    const { model } = modelFor('elevenlabs', opts.diarize);
    const form = new FormData();
    form.append('model_id', model);
    form.append('file', await openAsBlob(audio.path, { type: 'audio/mpeg' }), 'audio.mp3');
    form.append('language_code', 'hin');
    form.append('diarize', String(opts.diarize));
    form.append('timestamps_granularity', 'word');
    form.append('tag_audio_events', 'false');
    const raw = await requestJson(this.#http, ENDPOINT, {
      method: 'POST',
      headers: { 'xi-api-key': this.#key },
      body: form,
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const r = parseAnswer(ResultSchema, raw, 'unreadable_result');
    return { model, segments: toSegments(r, audio.seconds), billedSeconds: r.audio_duration_secs ?? null, raw };
  }
}

function toSegments(r: ElevenLabsResult, seconds: number): Segment[] {
  const words: TimedWord[] = (r.words ?? []).flatMap((w) =>
    w.type === 'word' && typeof w.start === 'number' && typeof w.end === 'number'
      ? [{ text: w.text, start: w.start, end: w.end, speaker: w.speaker_id ?? null }]
      : [],
  );
  if (words.length > 0) return wordsToSegments(words);
  const text = (r.text ?? '').trim();
  return text ? [{ start: 0, end: seconds, speaker: null, text }] : [];
}
