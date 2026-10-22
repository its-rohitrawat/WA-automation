import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { HttpFetch } from '../../../src/stt/http.ts';
import { OpenAiProvider } from '../../../src/stt/providers/openai.ts';
import type { AudioPart } from '../../../src/stt/types.ts';

function fake(answer: unknown) {
  const calls: { url: string; headers: Headers; form: FormData }[] = [];
  const http: HttpFetch = async (url, init) => {
    calls.push({ url, headers: new Headers(init.headers), form: init.body as FormData });
    return Response.json(answer);
  };
  return { http, calls };
}

let audio: AudioPart;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'stt-openai-'));
  const path = join(dir, 'a.mp3');
  writeFileSync(path, 'fake mp3 bytes');
  audio = { path, seconds: 42, offset: 0 };
});

describe('OpenAiProvider', () => {
  it('sends voice notes to gpt-transcribe with Hindi and English hints', async () => {
    const { http, calls } = fake({ text: ' Kal 4 baje call karte hain. ', languages: [{ code: 'hi' }] });
    const r = await new OpenAiProvider({ apiKey: 'test-key', http }).transcribe(audio, { diarize: false });
    const { url, headers, form } = calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(headers.get('authorization')).toBe('Bearer test-key');
    expect(form.get('model')).toBe('gpt-transcribe');
    expect(form.getAll('languages[]')).toEqual(['hi', 'en']);
    expect(form.has('language')).toBe(false);
    expect(form.has('response_format')).toBe(false);
    expect((form.get('file') as File).name).toBe('audio.mp3');
    expect(r).toMatchObject({ model: 'gpt-transcribe', billedSeconds: null });
    expect(r.segments).toEqual([{ start: 0, end: 42, speaker: null, text: 'Kal 4 baje call karte hain.' }]);
  });

  it('sends meetings to the diarize model and keeps its speakers', async () => {
    const { http, calls } = fake({
      task: 'transcribe',
      duration: 27.4,
      text: 'A: Namaste\nB: Haan ji',
      segments: [
        { type: 'transcript.text.segment', id: 'seg_001', start: 0, end: 4.7, text: ' Namaste ', speaker: 'A' },
        { type: 'transcript.text.segment', id: 'seg_002', start: 4.7, end: 6, text: 'Haan ji', speaker: 'B' },
      ],
      usage: { type: 'duration', seconds: 27 },
    });
    const r = await new OpenAiProvider({ apiKey: 'k', http }).transcribe(audio, { diarize: true });
    const { form } = calls[0]!;
    expect(form.get('model')).toBe('gpt-4o-transcribe-diarize');
    expect(form.get('response_format')).toBe('diarized_json');
    expect(form.get('chunking_strategy')).toBe('auto');
    expect(form.has('languages[]')).toBe(false);
    expect(r.billedSeconds).toBe(27);
    expect(r.segments).toEqual([
      { start: 0, end: 4.7, speaker: 'A', text: 'Namaste' },
      { start: 4.7, end: 6, speaker: 'B', text: 'Haan ji' },
    ]);
  });

  it('keeps a paid answer whose usage field has an unexpected shape', async () => {
    const text = fake({ text: 'Theek hai', usage: { seconds: 5 } });
    const r = await new OpenAiProvider({ apiKey: 'k', http: text.http }).transcribe(audio, { diarize: false });
    expect(r.segments).toEqual([{ start: 0, end: 42, speaker: null, text: 'Theek hai' }]);
    expect(r.billedSeconds).toBeNull();
    const diarized = fake({ segments: [{ start: 0, end: 2, text: 'Haan', speaker: 'A' }], usage: 'duration' });
    const d = await new OpenAiProvider({ apiKey: 'k', http: diarized.http }).transcribe(audio, { diarize: true });
    expect(d.segments).toEqual([{ start: 0, end: 2, speaker: 'A', text: 'Haan' }]);
    expect(d.billedSeconds).toBeNull();
  });

  it('caps each request at 5 minutes of audio', () => {
    expect(new OpenAiProvider({ apiKey: 'k' }).maxPartSeconds).toBe(300);
  });
});
