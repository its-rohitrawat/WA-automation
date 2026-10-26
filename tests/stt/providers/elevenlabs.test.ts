import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { SttHttpError, SttNoAnswerError, type HttpFetch } from '../../../src/stt/http.ts';
import { ElevenLabsProvider } from '../../../src/stt/providers/elevenlabs.ts';
import type { AudioPart } from '../../../src/stt/types.ts';

const ANSWER = {
  language_code: 'hin',
  language_probability: 0.97,
  text: 'Kal meeting hai. Haan theek.',
  audio_duration_secs: 4.2,
  words: [
    { text: 'Kal', start: 0, end: 0.3, type: 'word', speaker_id: 'speaker_0', logprob: -0.1 },
    { text: ' ', start: 0.3, end: 0.35, type: 'spacing', speaker_id: 'speaker_0', logprob: 0 },
    { text: 'meeting', start: 0.35, end: 0.8, type: 'word', speaker_id: 'speaker_0', logprob: -0.1 },
    { text: 'hai.', start: 0.85, end: 1.1, type: 'word', speaker_id: 'speaker_0', logprob: -0.1 },
    { text: 'Haan', start: 1.4, end: 1.7, type: 'word', speaker_id: 'speaker_1', logprob: -0.1 },
    { text: 'theek.', start: 1.75, end: 2.1, type: 'word', speaker_id: 'speaker_1', logprob: -0.1 },
  ],
};

function fake(res: () => Response) {
  const calls: { url: string; method: string; headers: Headers; form: FormData; signal: AbortSignal | null }[] = [];
  const http: HttpFetch = async (url, init) => {
    calls.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers), form: init.body as FormData, signal: init.signal ?? null });
    return res();
  };
  return { http, calls };
}

const saved = (raw: unknown) => ({ model: 'scribe_v2', segments: [], billedSeconds: 4.2, raw });

let audio: AudioPart;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'stt-eleven-'));
  const path = join(dir, 'a.mp3');
  writeFileSync(path, 'fake mp3 bytes');
  audio = { path, seconds: 4.2, offset: 0 };
});

describe('ElevenLabsProvider', () => {
  it('sends Scribe v2 with Hindi, word timings and no audio-event tags', async () => {
    const { http, calls } = fake(() => Response.json(ANSWER));
    await new ElevenLabsProvider({ apiKey: 'test-key', http }).transcribe(audio, { diarize: true });
    expect(calls).toHaveLength(1);
    const { url, headers, form } = calls[0]!;
    expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(headers.get('xi-api-key')).toBe('test-key');
    expect(form.get('model_id')).toBe('scribe_v2');
    expect(form.get('language_code')).toBe('hin');
    expect(form.get('diarize')).toBe('true');
    expect(form.get('timestamps_granularity')).toBe('word');
    expect(form.get('tag_audio_events')).toBe('false');
    expect((form.get('file') as File).name).toBe('audio.mp3');
  });

  it('groups words into segments by speaker and skips spacing', async () => {
    const { http } = fake(() => Response.json(ANSWER));
    const r = await new ElevenLabsProvider({ apiKey: 'k', http }).transcribe(audio, { diarize: true });
    expect(r.model).toBe('scribe_v2');
    expect(r.billedSeconds).toBe(4.2);
    expect(r.segments).toEqual([
      { start: 0, end: 1.1, speaker: 'speaker_0', text: 'Kal meeting hai.' },
      { start: 1.4, end: 2.1, speaker: 'speaker_1', text: 'Haan theek.' },
    ]);
  });

  it('sends diarize=false for voice notes', async () => {
    const { http, calls } = fake(() => Response.json(ANSWER));
    await new ElevenLabsProvider({ apiKey: 'k', http }).transcribe(audio, { diarize: false });
    expect(calls[0]!.form.get('diarize')).toBe('false');
  });

  it('falls back to the text when no word has timings', async () => {
    const { http } = fake(() => Response.json({ text: ' Theek hai ', words: [] }));
    const r = await new ElevenLabsProvider({ apiKey: 'k', http }).transcribe(audio, { diarize: false });
    expect(r.segments).toEqual([{ start: 0, end: 4.2, speaker: null, text: 'Theek hai' }]);
    expect(r.billedSeconds).toBeNull();
  });

  it('keeps a paid answer whose audio duration has an unexpected shape', async () => {
    const { http } = fake(() => Response.json({ ...ANSWER, audio_duration_secs: '4.2s' }));
    const r = await new ElevenLabsProvider({ apiKey: 'k', http }).transcribe(audio, { diarize: true });
    expect(r.segments).toHaveLength(2);
    expect(r.billedSeconds).toBeNull();
  });

  it('an unreadable answer still names the stored copy to delete', async () => {
    const { http } = fake(() => Response.json({ text: 7, words: 'not a list', transcription_id: 'tr-odd' }));
    const err = await new ElevenLabsProvider({ apiKey: 'k', http }).transcribe(audio, { diarize: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SttNoAnswerError);
    expect(err).toMatchObject({ code: 'unreadable_result', forgetRef: 'tr-odd' });
    const none = await new ElevenLabsProvider({ apiKey: 'k', http: fake(() => Response.json({ text: 7 })).http })
      .transcribe(audio, { diarize: true })
      .catch((e: unknown) => e);
    expect(none).toMatchObject({ code: 'unreadable_result', forgetRef: null });
  });

  it('throws SttHttpError on an error status and sends only once', async () => {
    const { http, calls } = fake(() => Response.json({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } }, { status: 401 }));
    const err = await new ElevenLabsProvider({ apiKey: 'k', http }).transcribe(audio, { diarize: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SttHttpError);
    expect(err).toMatchObject({ status: 401, detail: 'invalid_api_key' });
    expect(calls).toHaveLength(1);
  });
});

describe('ElevenLabsProvider.forget', () => {
  it("deletes the account's stored transcript with the key", async () => {
    const { http, calls } = fake(() => new Response(null, { status: 200 }));
    await new ElevenLabsProvider({ apiKey: 'test-key', http }).forget(saved({ ...ANSWER, transcription_id: 'tr/1 x' }));
    expect(calls).toHaveLength(1);
    const { url, method, headers, signal } = calls[0]!;
    expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text/transcripts/tr%2F1%20x');
    expect(method).toBe('DELETE');
    expect(headers.get('xi-api-key')).toBe('test-key');
    expect(signal).not.toBeNull();
  });

  it('sends nothing when the answer has no transcription id', async () => {
    const { http, calls } = fake(() => new Response(null, { status: 200 }));
    const p = new ElevenLabsProvider({ apiKey: 'k', http });
    for (const raw of [ANSWER, { ...ANSWER, transcription_id: '' }, { ...ANSWER, transcription_id: 7 }, null, 'text']) {
      await p.forget(saved(raw));
    }
    expect(calls).toHaveLength(0);
  });

  it('forgetRef gives the transcription id only, and forgetById deletes by it later', async () => {
    const { http, calls } = fake(() => new Response(null, { status: 200 }));
    const p = new ElevenLabsProvider({ apiKey: 'k', http });
    expect(p.forgetRef(saved({ ...ANSWER, transcription_id: 'tr9' }))).toBe('tr9');
    expect(p.forgetRef(saved(ANSWER))).toBeNull();
    await p.forgetById('tr9');
    expect(calls.map((c) => [c.method, c.url])).toEqual([['DELETE', 'https://api.elevenlabs.io/v1/speech-to-text/transcripts/tr9']]);
  });

  it('reports a refused delete as SttHttpError', async () => {
    const { http } = fake(() => Response.json({ detail: { status: 'not_found' } }, { status: 404 }));
    const err = await new ElevenLabsProvider({ apiKey: 'k', http }).forget(saved({ transcription_id: 'tr1' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SttHttpError);
    expect(err).toMatchObject({ status: 404, detail: 'not_found' });
  });
});
