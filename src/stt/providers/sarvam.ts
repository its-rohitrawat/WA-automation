import { openAsBlob } from 'node:fs';
import { z } from 'zod';
import { longFetch, parseAnswer, requestJson, requestOk, SttHttpError, SttJobError, SttJobLostError, SttNoAnswerError, type HttpFetch } from '../http.ts';
import { modelFor } from '../prices.ts';
import type { AudioPart, ProviderResult, Segment, SttProvider, TranscribeOptions } from '../types.ts';

const JOBS = 'https://api.sarvam.ai/speech-to-text/job/v1';
/** The audio's name inside a job. Sarvam names the result after the input's position ("0.json"). */
const FILE_NAME = 'audio.mp3';

const JobSchema = z.object({ job_id: z.string().min(1) });
const SignedUrls = z.record(z.string(), z.object({ file_url: z.string() }));
const UploadSchema = z.object({ upload_urls: SignedUrls });
const DownloadSchema = z.object({ download_urls: SignedUrls });
const StatusSchema = z.object({
  job_state: z.string(),
  job_details: z
    .array(z.object({ state: z.string().nullish(), outputs: z.array(z.object({ file_name: z.string() })).nullish() }))
    .nullish(),
});
const ResultSchema = z.object({
  transcript: z.string().nullish(),
  timestamps: z
    .object({
      words: z.array(z.string()).nullish(),
      chunks: z.array(z.string()).nullish(),
      start_time_seconds: z.array(z.number()),
      end_time_seconds: z.array(z.number()),
    })
    .nullish(),
  diarized_transcript: z
    .object({
      entries: z.array(
        z.object({
          transcript: z.string(),
          start_time_seconds: z.number(),
          end_time_seconds: z.number(),
          speaker_id: z.union([z.string(), z.number()]),
        }),
      ),
    })
    .nullish(),
});
type SarvamResult = z.output<typeof ResultSchema>;

const FINISHED = new Set(['Completed', 'PartiallyCompleted', 'Failed']);
/** Failed status checks in a row that are tolerated. The job id is kept, so a later run can wait on the job again. */
const MAX_STATUS_MISSES = 5;

export interface SarvamOptions {
  apiKey: string;
  http?: HttpFetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  /** Longest wait for one job's result. */
  maxWaitMs?: number;
}

/**
 * Sarvam saaras:v4 in codemix mode (Hindi in Devanagari, English words in Latin script), through the Batch API: the REST
 * API takes only 30 seconds of audio and has no speaker labels.
 */
export class SarvamProvider implements SttProvider {
  readonly id = 'sarvam' as const;
  /** A batch job takes files of up to 2 hours. */
  readonly maxPartSeconds = 7_200;
  readonly #key: string;
  readonly #http: HttpFetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #pollMs: number;
  readonly #maxWaitMs: number;

  constructor(opts: SarvamOptions) {
    this.#key = opts.apiKey;
    this.#http = opts.http ?? longFetch;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = opts.now ?? Date.now;
    this.#pollMs = opts.pollMs ?? 5_000;
    this.#maxWaitMs = opts.maxWaitMs ?? 3 * 3_600_000;
  }

  async transcribe(audio: AudioPart, opts: TranscribeOptions): Promise<ProviderResult> {
    const { model } = modelFor('sarvam', opts.diarize);
    let jobId = opts.resumeJobId;
    if (!jobId) {
      jobId = await this.#submit(audio, model, opts.diarize);
      opts.onJobId?.(jobId);
    }
    const outputName = await this.#waitForOutput(jobId);
    let raw: unknown;
    try {
      raw = await this.#download(jobId, outputName);
    } catch (e) {
      if (e instanceof SttHttpError) {
        // The job ran and is billed. Refused for good, its result is gone: waiting on the job again would meet the
        // same refusal. Anything else passes: as plain "no answer", the saved job id lets --retry-unknown fetch it again.
        if (refusedForGood(e)) throw new SttJobLostError(`download_http_${e.status}`);
        throw new SttNoAnswerError(`download_http_${e.status}`);
      }
      throw e;
    }
    return { model, segments: toSegments(parseAnswer(ResultSchema, raw, 'unreadable_result'), audio.seconds), billedSeconds: null, raw };
  }

  async #submit(audio: AudioPart, model: string, diarize: boolean): Promise<string> {
    const params = { model, mode: 'codemix', language_code: 'hi-IN', with_timestamps: true, with_diarization: diarize };
    const { job_id: jobId } = parseAnswer(JobSchema, await this.#post('', { job_parameters: params }), 'unreadable_job');
    const urls = parseAnswer(UploadSchema, await this.#post('/upload-files', { job_id: jobId, files: [FILE_NAME] }), 'unreadable_upload_urls');
    // The signed storage link carries its own permission; the API key is never sent there.
    await requestOk(this.#http, storageUrl(urls.upload_urls[FILE_NAME]?.file_url), {
      method: 'PUT',
      headers: { 'x-ms-blob-type': 'BlockBlob', 'content-type': 'audio/mpeg' },
      body: await openAsBlob(audio.path, { type: 'audio/mpeg' }),
      signal: AbortSignal.timeout(15 * 60_000),
    });
    await requestOk(this.#http, `${JOBS}/${jobId}/start`, { method: 'POST', headers: this.#headers(false), signal: AbortSignal.timeout(60_000) });
    return jobId;
  }

  async #waitForOutput(jobId: string): Promise<string> {
    const deadline = this.#now() + this.#maxWaitMs;
    let misses = 0;
    for (;;) {
      let status: z.output<typeof StatusSchema> | null = null;
      try {
        status = parseAnswer(StatusSchema, await this.#get(`/${jobId}/status`), 'unreadable_status');
        misses = 0;
      } catch (e) {
        // A definite refusal (a job Sarvam no longer knows) will not pass by asking again. The job was started and may
        // be billed, so it is never "failed": it is a lost job, whose id is dropped so the next plan warns of a new send.
        if (e instanceof SttHttpError && refusedForGood(e)) throw new SttJobLostError(`status_http_${e.status}`);
        // A status check is free, so a few failures in a row are tolerated.
        if (++misses >= MAX_STATUS_MISSES) throw new SttNoAnswerError('status_unavailable');
      }
      if (status && FINISHED.has(status.job_state)) {
        const detail = status.job_details?.[0];
        const name = detail?.outputs?.[0]?.file_name;
        // A completed job may list its file without a state of its own; only a state other than Success is a failure.
        const fileFailed = detail?.state != null && detail.state !== 'Success';
        if (status.job_state === 'Failed' || fileFailed) throw new SttJobError(codeOf(detail?.state ?? status.job_state));
        // Finished yet naming no result: the same job would answer the same way, so this is a failure of the job.
        if (!name) throw new SttJobError('no_output_file');
        return name;
      }
      if (this.#now() >= deadline) throw new SttNoAnswerError('job_wait_timeout');
      await this.#sleep(this.#pollMs);
    }
  }

  async #download(jobId: string, name: string): Promise<unknown> {
    const urls = parseAnswer(DownloadSchema, await this.#post('/download-files', { job_id: jobId, files: [name] }), 'unreadable_download_urls');
    try {
      return await requestJson(this.#http, storageUrl(urls.download_urls[name]?.file_url), { method: 'GET', signal: AbortSignal.timeout(5 * 60_000) });
    } catch (e) {
      // A 403 from the signed link usually means it expired; a later resume asks Sarvam for a fresh one.
      if (e instanceof SttHttpError && e.status === 403) throw new SttNoAnswerError('download_http_403');
      throw e;
    }
  }

  #headers(json: boolean): Record<string, string> {
    return json ? { 'api-subscription-key': this.#key, 'content-type': 'application/json' } : { 'api-subscription-key': this.#key };
  }

  async #post(path: string, body: unknown): Promise<unknown> {
    return await requestJson(this.#http, `${JOBS}${path}`, {
      method: 'POST',
      headers: this.#headers(true),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  }

  async #get(path: string): Promise<unknown> {
    return await requestJson(this.#http, `${JOBS}${path}`, { method: 'GET', headers: this.#headers(false), signal: AbortSignal.timeout(60_000) });
  }
}

/**
 * A 4xx that asking again will not change. 401 (a bad or revoked key) passes once the key is fixed, so the job stays
 * waitable; 408 (request timeout) and 429 (too many requests) pass with time.
 */
function refusedForGood(e: SttHttpError): boolean {
  return e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 408 && e.status !== 429;
}

/** Storage links come from Sarvam's answer; only https links are followed. */
function storageUrl(value: string | undefined): string {
  const url = value ? URL.parse(value) : null;
  if (!url || url.protocol !== 'https:') throw new SttNoAnswerError('bad_storage_url');
  return url.href;
}

/** "API Error" -> "api_error". */
function codeOf(state: string): string {
  return state.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'failed';
}

/** Sarvam numbers speakers ("0", 1); a bare number would read like a time in the report. */
function speakerLabel(id: string | number): string {
  const s = String(id);
  return /^\d+$/.test(s) ? `speaker_${s}` : s;
}

function toSegments(r: SarvamResult, seconds: number): Segment[] {
  const entries = r.diarized_transcript?.entries ?? [];
  if (entries.length > 0) {
    return entries
      .map((e) => ({ start: e.start_time_seconds, end: e.end_time_seconds, speaker: speakerLabel(e.speaker_id), text: e.transcript.trim() }))
      .filter((s) => s.text !== '');
  }
  const t = r.timestamps;
  // An empty word list falls through to the chunks.
  const texts = t?.words?.length ? t.words : (t?.chunks ?? []);
  if (t && texts.length > 0) {
    return texts
      .map((text, i) => ({ start: t.start_time_seconds[i] ?? 0, end: t.end_time_seconds[i] ?? seconds, speaker: null, text: text.trim() }))
      .filter((s) => s.text !== '');
  }
  const text = (r.transcript ?? '').trim();
  return text ? [{ start: 0, end: seconds, speaker: null, text }] : [];
}
