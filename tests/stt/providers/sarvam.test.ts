import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { SttJobError, SttNoAnswerError, type HttpFetch } from '../../../src/stt/http.ts';
import { SarvamProvider } from '../../../src/stt/providers/sarvam.ts';
import type { AudioPart } from '../../../src/stt/types.ts';

const JOBS = 'https://api.sarvam.ai/speech-to-text/job/v1';
const DIARIZED = {
  transcript: 'Kal ki meeting confirm hai? Haan, 4 baje.',
  diarized_transcript: {
    entries: [
      { transcript: 'Kal ki meeting confirm hai?', start_time_seconds: 0.5, end_time_seconds: 2.5, speaker_id: '0' },
      { transcript: 'Haan, 4 baje.', start_time_seconds: 2.8, end_time_seconds: 4, speaker_id: 1 },
    ],
  },
};

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function fakeSarvam(opts: { states?: string[]; detailState?: string; result?: unknown; uploadUrl?: string } = {}) {
  const calls: Call[] = [];
  const states = [...(opts.states ?? ['Running', 'Completed'])];
  const http: HttpFetch = async (url, init) => {
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : (init.body ?? null);
    calls.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers), body });
    if (url === JOBS) return Response.json({ job_id: 'job-1', job_state: 'Accepted' }, { status: 202 });
    if (url === `${JOBS}/upload-files`) {
      return Response.json({ job_id: 'job-1', upload_urls: { 'audio.mp3': { file_url: opts.uploadUrl ?? 'https://blob.example/up?sig=1' } } });
    }
    if (url.startsWith('https://blob.example/up')) return new Response(null, { status: 201 });
    if (url === `${JOBS}/job-1/start`) return Response.json({ job_id: 'job-1', job_state: 'Pending' });
    if (url === `${JOBS}/job-1/status`) {
      const state = states.length > 1 ? states.shift()! : states[0]!;
      return Response.json({ job_state: state, job_details: [{ state: opts.detailState ?? 'Success', outputs: [{ file_name: '0.json' }] }] });
    }
    if (url === `${JOBS}/download-files`) return Response.json({ download_urls: { '0.json': { file_url: 'https://blob.example/down?sig=2' } } });
    if (url.startsWith('https://blob.example/down')) return Response.json(opts.result ?? DIARIZED);
    return new Response(null, { status: 404 });
  };
  return { http, calls };
}

let audio: AudioPart;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'stt-sarvam-'));
  const path = join(dir, 'a.mp3');
  writeFileSync(path, 'fake mp3 bytes');
  audio = { path, seconds: 4.2, offset: 0 };
});

function provider(http: HttpFetch): SarvamProvider {
  const clock = { t: 0 };
  return new SarvamProvider({
    apiKey: 'test-key',
    http,
    pollMs: 5_000,
    maxWaitMs: 60_000,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
  });
}

describe('SarvamProvider', () => {
  it('runs the batch job and returns diarized segments', async () => {
    const { http, calls } = fakeSarvam();
    const r = await provider(http).transcribe(audio, { diarize: true });
    expect(calls.map((c) => `${c.method} ${c.url.replace(/\?.*$/, '')}`)).toEqual([
      `POST ${JOBS}`,
      `POST ${JOBS}/upload-files`,
      'PUT https://blob.example/up',
      `POST ${JOBS}/job-1/start`,
      `GET ${JOBS}/job-1/status`,
      `GET ${JOBS}/job-1/status`,
      `POST ${JOBS}/download-files`,
      'GET https://blob.example/down',
    ]);
    expect(calls[0]!.body).toEqual({
      job_parameters: { model: 'saaras:v4', mode: 'codemix', language_code: 'hi-IN', with_timestamps: true, with_diarization: true },
    });
    expect(r.model).toBe('saaras:v4');
    expect(r.billedSeconds).toBeNull();
    expect(r.segments).toEqual([
      { start: 0.5, end: 2.5, speaker: 'speaker_0', text: 'Kal ki meeting confirm hai?' },
      { start: 2.8, end: 4, speaker: 'speaker_1', text: 'Haan, 4 baje.' },
    ]);
    expect(r.raw).toEqual(DIARIZED);
  });

  it('sends the API key to Sarvam only, never to the storage links', async () => {
    const { http, calls } = fakeSarvam();
    await provider(http).transcribe(audio, { diarize: true });
    for (const c of calls) {
      expect(c.headers.get('api-subscription-key')).toBe(c.url.startsWith('https://api.sarvam.ai/') ? 'test-key' : null);
    }
  });

  it('uploads the audio with the blob headers', async () => {
    const { http, calls } = fakeSarvam();
    await provider(http).transcribe(audio, { diarize: true });
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.headers.get('x-ms-blob-type')).toBe('BlockBlob');
    expect(put.headers.get('content-type')).toBe('audio/mpeg');
    expect(await (put.body as Blob).text()).toBe('fake mp3 bytes');
  });

  it('uses the timestamps when speaker labels are off', async () => {
    const result = { transcript: 'x', timestamps: { words: ['Kal milte hain', 'theek hai'], start_time_seconds: [0, 2], end_time_seconds: [1.8, 3] } };
    const { http, calls } = fakeSarvam({ result });
    const r = await provider(http).transcribe(audio, { diarize: false });
    expect((calls[0]!.body as { job_parameters: { with_diarization: boolean } }).job_parameters.with_diarization).toBe(false);
    expect(r.segments).toEqual([
      { start: 0, end: 1.8, speaker: null, text: 'Kal milte hain' },
      { start: 2, end: 3, speaker: null, text: 'theek hai' },
    ]);
  });

  it('falls back to the whole transcript without timestamps', async () => {
    const { http } = fakeSarvam({ result: { transcript: ' Sab theek. ' } });
    const r = await provider(http).transcribe(audio, { diarize: false });
    expect(r.segments).toEqual([{ start: 0, end: 4.2, speaker: null, text: 'Sab theek.' }]);
  });

  it('reports the job id once the job has started', async () => {
    const { http, calls } = fakeSarvam();
    const seen: { id: string; callsSoFar: number }[] = [];
    await provider(http).transcribe(audio, { diarize: true, onJobId: (id) => seen.push({ id, callsSoFar: calls.length }) });
    expect(seen).toEqual([{ id: 'job-1', callsSoFar: 4 }]);
  });

  it('waits on a saved job without uploading again', async () => {
    const { http, calls } = fakeSarvam();
    const seen: string[] = [];
    const r = await provider(http).transcribe(audio, { diarize: true, resumeJobId: 'job-1', onJobId: (id) => seen.push(id) });
    expect(calls.some((c) => c.method === 'PUT' || c.url === JOBS)).toBe(false);
    expect(seen).toEqual([]);
    expect(r.segments).toHaveLength(2);
  });

  it('throws SttJobError when the job fails', async () => {
    const { http } = fakeSarvam({ states: ['Failed'], detailState: 'API Error' });
    const err = await provider(http).transcribe(audio, { diarize: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SttJobError);
    expect((err as SttJobError).code).toBe('api_error');
  });

  it('gives up after maxWaitMs and reports that no answer arrived', async () => {
    const { http } = fakeSarvam({ states: ['Running'] });
    const err = await provider(http).transcribe(audio, { diarize: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SttNoAnswerError);
    expect((err as SttNoAnswerError).code).toBe('job_wait_timeout');
  });

  it('refuses a storage link that is not https', async () => {
    const { http, calls } = fakeSarvam({ uploadUrl: 'http://blob.example/up' });
    await expect(provider(http).transcribe(audio, { diarize: true })).rejects.toMatchObject({ code: 'bad_storage_url' });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});
