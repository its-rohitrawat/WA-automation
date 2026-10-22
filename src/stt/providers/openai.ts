import { openAsBlob } from 'node:fs';
import { z } from 'zod';
import { longFetch, parseAnswer, requestJson, type HttpFetch } from '../http.ts';
import { modelFor } from '../prices.ts';
import type { AudioPart, ProviderResult, SttProvider, TranscribeOptions } from '../types.ts';

const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';

const UsageSchema = z.object({ type: z.string(), seconds: z.number().nullish() }).nullish();
const TextSchema = z.object({ text: z.string(), usage: UsageSchema });
const DiarizedSchema = z.object({
  segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string(), speaker: z.string().nullish() })),
  usage: UsageSchema,
});

export interface OpenAiOptions {
  apiKey: string;
  http?: HttpFetch;
  timeoutMs?: number;
}

/**
 * OpenAI transcription. Voice notes use gpt-transcribe with the hints "hi" and "en" for code-switched speech. Meetings
 * use gpt-4o-transcribe-diarize, OpenAI's only model with speaker labels, which shuts down on 2027-02-26.
 */
export class OpenAiProvider implements SttProvider {
  readonly id = 'openai' as const;
  /**
   * A request may carry 25 MB, and the diarize model writes at most 2,000 output tokens per request: 5 minutes of fast
   * Hinglish stays under both. Speaker labels restart in every part.
   */
  readonly maxPartSeconds = 300;
  readonly #key: string;
  readonly #http: HttpFetch;
  readonly #timeoutMs: number;

  constructor(opts: OpenAiOptions) {
    this.#key = opts.apiKey;
    this.#http = opts.http ?? longFetch;
    this.#timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  }

  async transcribe(audio: AudioPart, opts: TranscribeOptions): Promise<ProviderResult> {
    const { model } = modelFor('openai', opts.diarize);
    const form = new FormData();
    form.append('model', model);
    form.append('file', await openAsBlob(audio.path, { type: 'audio/mpeg' }), 'audio.mp3');
    if (opts.diarize) {
      form.append('response_format', 'diarized_json');
      form.append('chunking_strategy', 'auto');
    } else {
      form.append('languages[]', 'hi');
      form.append('languages[]', 'en');
    }
    const raw = await requestJson(this.#http, ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#key}` },
      body: form,
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (opts.diarize) {
      const r = parseAnswer(DiarizedSchema, raw, 'unreadable_result');
      const segments = r.segments
        .map((s) => ({ start: s.start, end: s.end, speaker: s.speaker ?? null, text: s.text.trim() }))
        .filter((s) => s.text !== '');
      return { model, segments, billedSeconds: billedSeconds(r.usage), raw };
    }
    const r = parseAnswer(TextSchema, raw, 'unreadable_result');
    const text = r.text.trim();
    return { model, segments: text ? [{ start: 0, end: audio.seconds, speaker: null, text }] : [], billedSeconds: billedSeconds(r.usage), raw };
  }
}

function billedSeconds(usage: z.output<typeof UsageSchema>): number | null {
  return usage?.type === 'duration' && typeof usage.seconds === 'number' ? usage.seconds : null;
}
