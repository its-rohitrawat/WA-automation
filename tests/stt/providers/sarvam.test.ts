import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { SttHttpError, SttJobError, SttJobLostError, SttNoAnswerError, type HttpFetch } from '../../../src/stt/http.ts';
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

interface FakeOptions {
  states?: string[];
  detailState?: string;
  /** Replaces job_details[0] of every status answer. */
  detail?: Record<string, unknown>;
  /** Answers for the first status checks, before `states`: an HTTP status, or an error the request throws. */
  statusMisses?: (number | Error)[];
  /** HTTP status for the download-files request, or for the blob GET. */
  downloadStatus?: number;
  blobStatus?: number;
  result?: unknown;
  uploadUrl?: string;
}

function fakeSarvam(opts: FakeOptions = {}) {
  const calls: Call[] = [];
  const states = [...(opts.states ?? ['Running', 'Completed'])];
  const misses = [...(opts.statusMisses ?? [])];
  const http: HttpFetch = async (url, init) => {
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : (init.body ?? null);
    calls.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers), body });
    if (url === JOBS) return Response.json({ job_id: 'job-1', job_state: 'Accepted' }, { status: 202 });
    if (url === `${JOBS}/upload-files`) {
      // Like Sarvam, a link for each file name asked for, so a lookup under any other name finds nothing.
      const names = (body as { files: string[] }).files;
      const links = Object.fromEntries(names.map((n) => [n, { file_url: opts.uploadUrl ?? 'https://blob.example/up?sig=1' }]));
      return Response.json({ job_id: 'job-1', upload_urls: links });
    }
    if (url.startsWith('https://blob.example/up')) return new Response(null, { status: 201 });
    if (url === `${JOBS}/job-1/start`) return Response.json({ job_id: 'job-1', job_state: 'Pending' });
    if (url === `${JOBS}/job-1/status`) {
      const miss = misses.shift();
      if (miss instanceof Error) throw miss;
      if (miss !== undefined) return Response.json({ code: 'x' }, { status: miss });
      const state = states.length > 1 ? states.shift()! : states[0]!;
      const detail = opts.detail ?? { state: opts.detailState ?? 'Success', outputs: [{ file_name: '0.json' }] };
      return Response.json({ job_state: state, job_details: [detail] });
    }
    if (url === `${JOBS}/download-files`) {
      if (opts.downloadStatus) return Response.json({ code: 'x' }, { status: opts.downloadStatus });
      return Response.json({ download_urls: { '0.json': { file_url: 'https://blob.example/down?sig=2' } } });
    }
    if (url.startsWith('https://blob.example/down')) {
      if (opts.blobStatus) return new Response('<Error/>', { status: opts.blobStatus });
      return Response.json(opts.result ?? DIARIZED);
    }
    return new Response(null, { status: 404 });
  };
  return { http, calls };
}

let audio: AudioPart;
let voiceNote: AudioPart;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'stt-sarvam-'));
  const path = join(dir, 'a.mp3');
  writeFileSync(path, 'fake mp3 bytes');
  audio = { path, seconds: 4.2, offset: 0 };
  const ogg = join(dir, 'a.ogg');
  writeFileSync(ogg, 'fake ogg bytes');
  voiceNote = { path: ogg, seconds: 4.2, offset: 0, format: 'ogg' };
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

  it('names the file audio.mp3 and uploads it as MP3 when the part names no format', async () => {
    const { http, calls } = fakeSarvam();
    await provider(http).transcribe(audio, { diarize: false });
    expect(calls.find((c) => c.url === `${JOBS}/upload-files`)!.body).toEqual({ job_id: 'job-1', files: ['audio.mp3'] });
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.headers.get('content-type')).toBe('audio/mpeg');
    expect((put.body as Blob).type).toBe('audio/mpeg');
  });

  it("names and uploads a voice note in the part's own format, Ogg", async () => {
    const { http, calls } = fakeSarvam();
    const r = await provider(http).transcribe(voiceNote, { diarize: false });
    expect(calls.find((c) => c.url === `${JOBS}/upload-files`)!.body).toEqual({ job_id: 'job-1', files: ['voice.ogg'] });
    // The fake gives a link under voice.ogg only, so reaching the PUT means the lookup used that name.
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toBe('https://blob.example/up?sig=1');
    expect(put.headers.get('content-type')).toBe('audio/ogg');
    expect((put.body as Blob).type).toBe('audio/ogg');
    expect(await (put.body as Blob).text()).toBe('fake ogg bytes');
    expect(r.segments).not.toEqual([]);
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

  it('uses the timestamp chunks when the word list is empty', async () => {
    const result = { transcript: 'x', timestamps: { words: [], chunks: ['Kal milte hain', 'theek hai'], start_time_seconds: [0, 2], end_time_seconds: [1.8, 3] } };
    const { http } = fakeSarvam({ result });
    const r = await provider(http).transcribe(audio, { diarize: false });
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

  it('downloads a completed job whose file entry has no state', async () => {
    const { http, calls } = fakeSarvam({ states: ['Completed'], detail: { outputs: [{ file_name: '0.json' }] } });
    const r = await provider(http).transcribe(audio, { diarize: true });
    expect(calls.some((c) => c.url.startsWith('https://blob.example/down'))).toBe(true);
    expect(r.segments).toHaveLength(2);
  });

  it('still fails a file the job reports as failed', async () => {
    const { http } = fakeSarvam({ states: ['Completed'], detailState: 'Internal Server Error' });
    await expect(provider(http).transcribe(audio, { diarize: true })).rejects.toMatchObject({
      name: 'SttJobError', code: 'internal_server_error',
    });
  });

  it('fails a finished job that names no output file, since waiting again would get the same answer', async () => {
    const { http } = fakeSarvam({ states: ['Completed'], detail: { state: 'Success', outputs: [] } });
    const err = await provider(http).transcribe(audio, { diarize: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SttJobError);
    expect((err as SttJobError).code).toBe('no_output_file');
  });

  it('tolerates four failed status checks in a row', async () => {
    const reset = Object.assign(new Error('x'), { code: 'ECONNRESET' });
    const { http } = fakeSarvam({ statusMisses: [503, 429, 408, reset], states: ['Completed'] });
    const r = await provider(http).transcribe(audio, { diarize: true });
    expect(r.segments).toHaveLength(2);
  });

  it('reports the status as unavailable after five failed checks in a row', async () => {
    const { http } = fakeSarvam({ statusMisses: [503, 503, 500, 429, 408], states: ['Completed'] });
    const err = await provider(http).transcribe(audio, { diarize: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SttNoAnswerError);
    expect((err as SttNoAnswerError).code).toBe('status_unavailable');
  });

  it('stops polling at a definite refusal: the started job is lost, not failed, since it may be billed', async () => {
    const { http, calls } = fakeSarvam({ statusMisses: [404], states: ['Completed'] });
    const err = await provider(http).transcribe(audio, { diarize: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SttJobLostError);
    expect(err).toBeInstanceOf(SttNoAnswerError);
    expect(err).not.toBeInstanceOf(SttHttpError);
    expect((err as SttJobLostError).code).toBe('status_http_404');
    expect(calls.filter((c) => c.url.endsWith('/status'))).toHaveLength(1);
  });

  it('keeps the job when a status check is refused for a bad key, so it can be fetched once the key is fixed', async () => {
    const { http } = fakeSarvam({ statusMisses: [401, 401, 401, 401, 401], states: ['Completed'] });
    const err = await provider(http).transcribe(audio, { diarize: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SttNoAnswerError);
    expect(err).not.toBeInstanceOf(SttJobLostError);
    expect((err as SttNoAnswerError).code).toBe('status_unavailable');
  });

  it('counts a redirect on a status check as a missed check, not as a lost job', async () => {
    const { http } = fakeSarvam({ statusMisses: [302], states: ['Completed'] });
    const r = await provider(http).transcribe(audio, { diarize: true });
    expect(r.segments).toHaveLength(2);
  });

  it('reports a download refused for good as a lost job', async () => {
    const cases = [
      [{ blobStatus: 404 }, 'download_http_404'],
      [{ downloadStatus: 404 }, 'download_http_404'],
      [{ downloadStatus: 403 }, 'download_http_403'],
    ] as const;
    for (const [opts, code] of cases) {
      const { http } = fakeSarvam(opts);
      const err = await provider(http).transcribe(audio, { diarize: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SttJobLostError);
      expect((err as SttJobLostError).code).toBe(code);
    }
  });

  it('reports a passing download problem as plain no answer, so the saved job id can fetch it again for free', async () => {
    const cases = [
      [{ downloadStatus: 503 }, 'download_http_503'],
      [{ blobStatus: 500 }, 'download_http_500'],
      [{ blobStatus: 429 }, 'download_http_429'],
      [{ downloadStatus: 408 }, 'download_http_408'],
      // A bad or revoked key passes once it is fixed; an expired signed link is replaced on the next resume.
      [{ downloadStatus: 401 }, 'download_http_401'],
      [{ blobStatus: 403 }, 'download_http_403'],
    ] as const;
    for (const [opts, code] of cases) {
      const { http } = fakeSarvam(opts);
      const err = await provider(http).transcribe(audio, { diarize: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SttNoAnswerError);
      expect(err).not.toBeInstanceOf(SttJobLostError);
      expect((err as SttNoAnswerError).code).toBe(code);
    }
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
