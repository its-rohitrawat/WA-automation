import { mkdtempSync, readdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AudioError } from '../../../src/stt/audio.ts';
import { Ledger, LedgerError, type Outcome } from '../../../src/stt/bakeoff/ledger.ts';
import type { PlanItem } from '../../../src/stt/bakeoff/plan.ts';
import { runPlan, type RunDeps } from '../../../src/stt/bakeoff/runner.ts';
import type { Sample } from '../../../src/stt/bakeoff/samples.ts';
import { SttHttpError, SttJobError, SttJobLostError, SttNoAnswerError } from '../../../src/stt/http.ts';
import { costUsd, modelFor } from '../../../src/stt/prices.ts';
import type { AudioPart, ProviderId, ProviderResult, SttProvider, TranscribeOptions } from '../../../src/stt/types.ts';

type Answer = (call: number, part: AudioPart, opts: TranscribeOptions) => Promise<ProviderResult>;

class FakeProvider implements SttProvider {
  readonly id: ProviderId;
  readonly maxPartSeconds: number;
  readonly calls: { part: AudioPart; opts: TranscribeOptions }[] = [];
  readonly #answer: Answer;

  constructor(id: ProviderId, maxPartSeconds: number, answer?: Answer) {
    this.id = id;
    this.maxPartSeconds = maxPartSeconds;
    this.#answer =
      answer ??
      (async (_call, part) => ({
        model: 'm',
        segments: [{ start: 0, end: part.seconds, speaker: 'A', text: `text of ${basename(part.path)}` }],
        billedSeconds: null,
        raw: {},
      }));
  }

  async transcribe(part: AudioPart, opts: TranscribeOptions): Promise<ProviderResult> {
    this.calls.push({ part, opts });
    return await this.#answer(this.calls.length, part, opts);
  }
}

/** A provider that keeps a copy of each answer, like ElevenLabs, and deletes it on forget. */
class ForgetfulProvider extends FakeProvider {
  readonly forgotten: ProviderResult[] = [];
  readonly #fail: Error | null;

  constructor(id: ProviderId, maxPartSeconds: number, fail: Error | null = null, answer?: Answer) {
    super(id, maxPartSeconds, answer);
    this.#fail = fail;
  }

  async forget(result: ProviderResult): Promise<void> {
    this.forgotten.push(result);
    if (this.#fail) throw this.#fail;
  }
}

const errno = (code: string): Error => Object.assign(new Error(code), { code });

const voice: Sample = { id: 'voice-a', kind: 'voice', path: 'C:\\s\\voice-notes\\a.ogg' };
const meeting: Sample = { id: 'meeting-b', kind: 'meeting', path: 'C:\\s\\meetings\\b.mp4' };

function item(sample: Sample, provider: ProviderId, over: Partial<PlanItem> = {}): PlanItem {
  const diarize = sample.kind === 'meeting';
  return {
    sample,
    seconds: sample.kind === 'meeting' ? 600 : 60,
    provider,
    model: modelFor(provider, diarize).model,
    diarize,
    parts: 1,
    state: 'new',
    action: 'send',
    estimateUsd: 0.01,
    ...over,
  };
}

let dir: string;
let ledger: Ledger;
let lines: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stt-run-'));
  ledger = new Ledger(dir);
  lines = [];
});

const wholeFile = async (i: PlanItem): Promise<AudioPart[]> => [{ path: `${i.sample.id}.mp3`, seconds: i.seconds, offset: 0 }];
const twoParts = async (): Promise<AudioPart[]> => [
  { path: 'p0.mp3', seconds: 300, offset: 0 },
  { path: 'p1.mp3', seconds: 100, offset: 300 },
];

function deps(providers: SttProvider[], over: Partial<RunDeps> = {}): RunDeps {
  return {
    providers: new Map(providers.map((p) => [p.id, p])),
    ledger,
    partsFor: wholeFile,
    inrPerUsd: 90,
    maxUsd: 5,
    forgetRemote: true,
    log: (l) => lines.push(l),
    now: () => 1_000,
    ...over,
  };
}

const failedOutcome = (sample: Sample, provider: ProviderId, error: string): Outcome => ({
  sampleId: sample.id,
  kind: sample.kind,
  provider,
  model: modelFor(provider, sample.kind === 'meeting').model,
  status: 'failed',
  audioSeconds: 60,
  billedSeconds: null,
  costUsd: 0,
  processingSeconds: 1,
  parts: 1,
  error,
  segments: [],
  finishedAt: '2026-10-22T10:00:00.000Z',
});

describe('runPlan', () => {
  it('sends each slot once and records the outcome with its list-price cost', async () => {
    const p = new FakeProvider('elevenlabs', 36_000);
    const sum = await runPlan([item(meeting, 'elevenlabs')], deps([p]));
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]!.opts.diarize).toBe(true);
    const o = ledger.outcome('meeting-b', 'elevenlabs')!;
    expect(o).toMatchObject({ status: 'done', model: 'scribe_v2', audioSeconds: 600, parts: 1, error: null });
    expect(o.costUsd).toBeCloseTo((0.22 * 600) / 3600, 10);
    expect(o.segments).toEqual([{ start: 0, end: 600, speaker: 'A', text: 'text of meeting-b.mp3' }]);
    expect(sum).toMatchObject({ done: 1, failed: 0, unknown: 0, skipped: 0, stoppedAtCap: false });
    expect(sum.spentUsd).toBeCloseTo(o.costUsd, 10);
    expect(lines.join('\n')).not.toContain('text of');
  });

  it('prices billed seconds when the provider reports them', async () => {
    const p = new FakeProvider('openai', 36_000, async () => ({ model: 'm', segments: [], billedSeconds: 300, raw: {} }));
    await runPlan([item(meeting, 'openai')], deps([p]));
    expect(ledger.outcome('meeting-b', 'openai')!.costUsd).toBeCloseTo((0.36 * 300) / 3600, 10);
  });

  it('does nothing for skipped items', async () => {
    const p = new FakeProvider('sarvam', 7_200);
    const sum = await runPlan([item(voice, 'sarvam', { action: 'skip', estimateUsd: 0 })], deps([p]));
    expect(p.calls).toHaveLength(0);
    expect(sum).toMatchObject({ done: 0, spentUsd: 0 });
  });

  it('stops before a slot would pass the spending cap', async () => {
    const p = new FakeProvider('elevenlabs', 36_000);
    const items = [item(voice, 'elevenlabs', { estimateUsd: 1 }), item(meeting, 'elevenlabs', { estimateUsd: 4 })];
    const sum = await runPlan(items, deps([p], { maxUsd: 4 }));
    expect(p.calls).toHaveLength(1);
    expect(sum.stoppedAtCap).toBe(true);
    expect(sum.unsent).toBe(1);
    expect(ledger.state('meeting-b', 'elevenlabs')).toBe('new');
  });

  it('records an error status as failed, never retries, and stops a provider whose key is refused', async () => {
    const p = new FakeProvider('openai', 300, async () => {
      throw new SttHttpError(401, 'invalid_api_key');
    });
    const sum = await runPlan([item(voice, 'openai'), item(meeting, 'openai')], deps([p]));
    expect(p.calls).toHaveLength(1);
    expect(ledger.outcome('voice-a', 'openai')).toMatchObject({ status: 'failed', error: 'http_401 invalid_api_key', costUsd: 0 });
    expect(ledger.state('meeting-b', 'openai')).toBe('new');
    expect(sum).toMatchObject({ failed: 1, skipped: 1 });
    expect(lines.some((l) => l.includes('refused the key'))).toBe(true);
  });

  it('leaves a slot unknown when no answer arrives and counts it as spent', async () => {
    const p = new FakeProvider('openai', 300, async () => {
      throw new SttNoAnswerError('timeout');
    });
    const sum = await runPlan([item(voice, 'openai')], deps([p]));
    expect(ledger.state('voice-a', 'openai')).toBe('unknown');
    expect(sum.unknown).toBe(1);
    expect(sum.spentUsd).toBeCloseTo((0.27 * 60) / 3600, 10);
    expect(lines.some((l) => l.includes('--retry-unknown'))).toBe(true);
  });

  it('saves a job id and waits on it in a later run', async () => {
    const first = new FakeProvider('sarvam', 7_200, async (_c, _p, opts) => {
      opts.onJobId?.('job-9');
      throw new SttNoAnswerError('status_unavailable');
    });
    await runPlan([item(meeting, 'sarvam')], deps([first]));
    expect(ledger.attempt('meeting-b', 'sarvam')?.jobIds).toEqual({ '0': 'job-9' });

    const second = new FakeProvider('sarvam', 7_200);
    await runPlan([item(meeting, 'sarvam', { state: 'unknown', action: 'resume', estimateUsd: 0 })], deps([second]));
    expect(second.calls[0]!.opts.resumeJobId).toBe('job-9');
    expect(ledger.state('meeting-b', 'sarvam')).toBe('done');
    // Waiting on the saved job is not a paid request: only the first run's send is recorded.
    expect(ledger.attempt('meeting-b', 'sarvam')?.sends).toEqual(['1970-01-01T00:00:01.000Z']);
  });

  it('drops the job id of a job the provider no longer has, keeps it as evidence, and leaves the slot unknown', async () => {
    const p = new FakeProvider('sarvam', 7_200, async (_c, _p, opts) => {
      opts.onJobId?.('job-9');
      throw new SttJobLostError('status_http_404');
    });
    const sum = await runPlan([item(meeting, 'sarvam')], deps([p]));
    const attempt = ledger.attempt('meeting-b', 'sarvam')!;
    expect(attempt.jobIds).toEqual({});
    expect(attempt.lostJobIds).toEqual({ '0': 'job-9' });
    expect(attempt.sends).toHaveLength(1);
    expect(ledger.state('meeting-b', 'sarvam')).toBe('unknown');
    // Nothing is left to wait on, so the next plan can only offer a new, paid send.
    expect(ledger.canResume('meeting-b', 'sarvam', 1)).toBe(false);
    expect(sum).toMatchObject({ unknown: 1, failed: 0 });
    // The started job may be billed: it counts as spent.
    expect(sum.spentUsd).toBeCloseTo(costUsd(modelFor('sarvam', true), 600, 90), 10);
    expect(lines.some((l) => l.includes('no answer (status_http_404)'))).toBe(true);
  });

  it('drops a saved job id that cannot be downloaded any more, without a new send', async () => {
    ledger.begin({ sampleId: 'meeting-b', provider: 'sarvam', model: 'saaras:v4', startedAt: '2026-10-22T10:00:00.000Z', jobIds: { '0': 'job-9' }, sends: ['2026-10-22T10:00:01.000Z'] });
    const p = new FakeProvider('sarvam', 7_200, async (_c, _p, opts) => {
      expect(opts.resumeJobId).toBe('job-9');
      throw new SttJobLostError('download_http_404');
    });
    const sum = await runPlan([item(meeting, 'sarvam', { state: 'unknown', action: 'resume', estimateUsd: 0 })], deps([p]));
    expect(ledger.attempt('meeting-b', 'sarvam')).toMatchObject({ jobIds: {}, lostJobIds: { '0': 'job-9' }, sends: ['2026-10-22T10:00:01.000Z'] });
    expect(ledger.state('meeting-b', 'sarvam')).toBe('unknown');
    expect(sum).toMatchObject({ unknown: 1, spentUsd: 0 });
  });

  it('records each paid request on the attempt before making it', async () => {
    let clock = 1_000;
    const seen: string[][] = [];
    const p = new FakeProvider('openai', 300, async () => {
      seen.push([...(ledger.attempt('meeting-b', 'openai')?.sends ?? [])]);
      clock += 1_000;
      return { model: 'm', segments: [], billedSeconds: null, raw: {} };
    });
    await runPlan([item(meeting, 'openai', { seconds: 400, parts: 2 })], deps([p], { partsFor: twoParts, now: () => clock }));
    expect(seen).toEqual([['1970-01-01T00:00:01.000Z'], ['1970-01-01T00:00:01.000Z', '1970-01-01T00:00:02.000Z']]);
    expect(ledger.attempt('meeting-b', 'openai')?.sends).toHaveLength(2);
  });

  it('reuses parts answered in an earlier run', async () => {
    const first = new FakeProvider('openai', 300, async (call, part) => {
      if (call === 2) throw new SttNoAnswerError('timeout');
      return { model: 'm', segments: [{ start: 1, end: 2, speaker: 'A', text: part.path }], billedSeconds: 300, raw: {} };
    });
    await runPlan([item(meeting, 'openai', { seconds: 400, parts: 2 })], deps([first], { partsFor: twoParts }));
    expect(ledger.state('meeting-b', 'openai')).toBe('unknown');

    const second = new FakeProvider('openai', 300, async (_c, part) => ({
      model: 'm',
      segments: [{ start: 1, end: 2, speaker: 'A', text: part.path }],
      billedSeconds: 100,
      raw: {},
    }));
    await runPlan([item(meeting, 'openai', { seconds: 400, parts: 2, state: 'unknown' })], deps([second], { partsFor: twoParts }));
    expect(second.calls.map((c) => c.part.path)).toEqual(['p1.mp3']);
    const o = ledger.outcome('meeting-b', 'openai')!;
    expect(o.billedSeconds).toBe(400);
    expect(o.segments).toEqual([
      { start: 1, end: 2, speaker: 'p1:A', text: 'p0.mp3' },
      { start: 301, end: 302, speaker: 'p2:A', text: 'p1.mp3' },
    ]);
  });

  it('sends nothing when a saved part was cut differently, and leaves the slot unknown', async () => {
    ledger.begin({ sampleId: 'meeting-b', provider: 'openai', model: 'gpt-4o-transcribe-diarize', startedAt: '2026-10-22T10:00:00.000Z', jobIds: {}, sends: [] });
    ledger.savePart('meeting-b', 'openai', 1, { offset: 250, seconds: 150 }, { model: 'm', segments: [], billedSeconds: 150, raw: {} });
    const p = new FakeProvider('openai', 300);
    const sum = await runPlan([item(meeting, 'openai', { seconds: 400, parts: 2, state: 'unknown' })], deps([p], { partsFor: twoParts }));
    // Part 0 has no saved answer, yet it is not sent either: the mismatch on part 1 is found first.
    expect(p.calls).toHaveLength(0);
    expect(ledger.state('meeting-b', 'openai')).toBe('unknown');
    expect(sum).toMatchObject({ unknown: 1, spentUsd: 0 });
    expect(lines.some((l) => l.includes('part_cache_mismatch'))).toBe(true);
  });

  it('sends nothing for a resume when a part has neither a job id nor a saved answer', async () => {
    ledger.begin({ sampleId: 'meeting-b', provider: 'openai', model: 'gpt-4o-transcribe-diarize', startedAt: '2026-10-22T10:00:00.000Z', jobIds: { '0': 'job-0' }, sends: [] });
    const p = new FakeProvider('openai', 300);
    const sum = await runPlan(
      [item(meeting, 'openai', { seconds: 400, parts: 2, state: 'unknown', action: 'resume', estimateUsd: 0 })],
      deps([p], { partsFor: twoParts }),
    );
    expect(p.calls).toHaveLength(0);
    expect(ledger.state('meeting-b', 'openai')).toBe('unknown');
    expect(ledger.attempt('meeting-b', 'openai')?.sends).toEqual([]);
    expect(sum).toMatchObject({ unknown: 1, spentUsd: 0 });
    expect(lines.some((l) => l.includes('resume_part_without_job'))).toBe(true);
  });

  it('fails a slot without sending when the audio cannot be split', async () => {
    const p = new FakeProvider('openai', 300);
    const partsFor = async (): Promise<AudioPart[]> => {
      throw new AudioError('split_failed');
    };
    await runPlan([item(meeting, 'openai')], deps([p], { partsFor }));
    expect(p.calls).toHaveLength(0);
    expect(ledger.outcome('meeting-b', 'openai')).toMatchObject({ status: 'failed', error: 'audio_split_failed' });
    expect(ledger.attempt('meeting-b', 'openai')).toBeNull();
  });

  it('sends a failed slot again on retry and keeps the old outcome on disk', async () => {
    ledger.finish({
      sampleId: 'voice-a', kind: 'voice', provider: 'sarvam', model: 'saaras:v4', status: 'failed', audioSeconds: 60,
      billedSeconds: null, costUsd: 0, processingSeconds: 1, parts: 1, error: 'http_500', segments: [], finishedAt: '2026-10-22T10:00:00.000Z',
    });
    const p = new FakeProvider('sarvam', 7_200);
    await runPlan([item(voice, 'sarvam', { state: 'failed' })], deps([p]));
    expect(ledger.state('voice-a', 'sarvam')).toBe('done');
    expect(readdirSync(join(dir, 'results', 'voice-a')).some((f) => f.startsWith('sarvam.failed-'))).toBe(true);
  });
});

describe('runPlan safety', () => {
  it('writes the attempt before the paid request and each part before the next one', async () => {
    const p = new FakeProvider('openai', 300, async (call, part) => {
      expect(ledger.attempt('meeting-b', 'openai')).not.toBeNull();
      if (call === 2) expect(ledger.part('meeting-b', 'openai', 0, { offset: 0, seconds: 300 })).not.toBeNull();
      return { model: 'm', segments: [{ start: 0, end: 1, speaker: 'A', text: part.path }], billedSeconds: null, raw: {} };
    });
    const sum = await runPlan([item(meeting, 'openai', { seconds: 400, parts: 2 })], deps([p], { partsFor: twoParts }));
    expect(p.calls).toHaveLength(2);
    expect(sum.done).toBe(1);
    expect(ledger.state('meeting-b', 'openai')).toBe('done');
  });

  it('counts an unknown slot as spent toward the cap', async () => {
    const p = new FakeProvider('openai', 36_000, async () => {
      throw new SttNoAnswerError('timeout');
    });
    const items = [
      item(voice, 'openai', { seconds: 3_600, estimateUsd: 0.27 }),
      item(meeting, 'openai', { seconds: 600, estimateUsd: 0.2 }),
    ];
    const sum = await runPlan(items, deps([p], { maxUsd: 0.4 }));
    expect(p.calls).toHaveLength(1);
    expect(sum.spentUsd).toBeCloseTo(0.27, 10);
    expect(sum).toMatchObject({ unknown: 1, stoppedAtCap: true, unsent: 1 });
    expect(ledger.state('meeting-b', 'openai')).toBe('new');
  });

  it.each([402, 403, 429])('stops a provider that answers %i', async (status) => {
    const p = new FakeProvider('openai', 300, async () => {
      throw new SttHttpError(status, 'insufficient_quota');
    });
    const sum = await runPlan([item(voice, 'openai'), item(meeting, 'openai')], deps([p]));
    expect(p.calls).toHaveLength(1);
    expect(ledger.outcome('voice-a', 'openai')).toMatchObject({ status: 'failed', error: `http_${status} insufficient_quota` });
    expect(ledger.state('meeting-b', 'openai')).toBe('new');
    expect(sum).toMatchObject({ failed: 1, skipped: 1 });
  });

  it('keeps going with a provider after a 400 for one file', async () => {
    const p = new FakeProvider('openai', 300, async (call) => {
      if (call === 1) throw new SttHttpError(400, 'invalid_value');
      return { model: 'm', segments: [], billedSeconds: null, raw: {} };
    });
    const sum = await runPlan([item(voice, 'openai'), item(meeting, 'openai')], deps([p]));
    expect(p.calls).toHaveLength(2);
    expect(sum).toMatchObject({ failed: 1, done: 1, skipped: 0 });
  });

  it('records a failed provider job as job_<code>', async () => {
    const p = new FakeProvider('sarvam', 7_200, async () => {
      throw new SttJobError('no_output_file');
    });
    const sum = await runPlan([item(meeting, 'sarvam')], deps([p]));
    expect(ledger.outcome('meeting-b', 'sarvam')).toMatchObject({ status: 'failed', error: 'job_no_output_file' });
    expect(sum.failed).toBe(1);
  });

  it('treats any other error from a provider as unknown, logging only its type', async () => {
    const p = new FakeProvider('openai', 300, async () => {
      throw new Error('provider text that must not be logged');
    });
    const sum = await runPlan([item(voice, 'openai')], deps([p]));
    expect(ledger.state('voice-a', 'openai')).toBe('unknown');
    expect(sum.unknown).toBe(1);
    expect(sum.spentUsd).toBeCloseTo((0.27 * 60) / 3600, 10);
    expect(lines.some((l) => l.includes('no answer (Error)'))).toBe(true);
    expect(lines.join('\n')).not.toContain('must not be logged');
  });

  it('skips a slot whose state changed since the plan was made', async () => {
    ledger.begin({ sampleId: 'voice-a', provider: 'sarvam', model: 'saaras:v4', startedAt: '2026-10-22T10:00:00.000Z', jobIds: {}, sends: [] });
    ledger.finish({ ...failedOutcome(voice, 'sarvam', 'x'), status: 'done', error: null });
    const p = new FakeProvider('sarvam', 7_200);
    const sum = await runPlan([item(voice, 'sarvam')], deps([p]));
    expect(p.calls).toHaveLength(0);
    expect(sum).toMatchObject({ skipped: 1, done: 0 });
    expect(lines).toContain('skip     voice-a sarvam: its state is now done; make a new plan');
  });

  it('cuts the audio before touching the ledger, then moves a failed outcome aside and begins', async () => {
    ledger.finish(failedOutcome(voice, 'sarvam', 'http_500'));
    const seen: string[] = [];
    const partsFor = async (i: PlanItem): Promise<AudioPart[]> => {
      seen.push(`cut while ${ledger.state('voice-a', 'sarvam')}`);
      return await wholeFile(i);
    };
    const p = new FakeProvider('sarvam', 7_200, async () => {
      seen.push(`sent while ${ledger.state('voice-a', 'sarvam')}`);
      return { model: 'm', segments: [], billedSeconds: null, raw: {} };
    });
    await runPlan([item(voice, 'sarvam', { state: 'failed' })], deps([p], { partsFor }));
    expect(seen).toEqual(['cut while failed', 'sent while unknown']);
    expect(ledger.state('voice-a', 'sarvam')).toBe('done');
  });

  it('keeps an unknown slot unknown, with its attempt, when its audio cannot be cut', async () => {
    const before = { sampleId: 'voice-a', provider: 'openai' as const, model: 'gpt-transcribe', startedAt: '2026-10-22T10:00:00.000Z', jobIds: {}, sends: ['2026-10-22T10:00:01.000Z'] };
    ledger.begin(before);
    const p = new FakeProvider('openai', 300);
    const partsFor = async (): Promise<AudioPart[]> => {
      throw new AudioError('split_failed');
    };
    const sum = await runPlan([item(voice, 'openai', { state: 'unknown' })], deps([p], { partsFor }));
    expect(p.calls).toHaveLength(0);
    expect(ledger.state('voice-a', 'openai')).toBe('unknown');
    expect(ledger.attempt('voice-a', 'openai')).toEqual(before);
    expect(sum).toMatchObject({ unknown: 1, failed: 0, spentUsd: 0 });
    expect(lines.some((l) => l.includes('audio_split_failed'))).toBe(true);
  });

  it('keeps the earlier failure aside when a failed slot cannot be cut again', async () => {
    ledger.finish(failedOutcome(voice, 'sarvam', 'http_500'));
    const partsFor = async (): Promise<AudioPart[]> => {
      throw new AudioError('split_failed');
    };
    await runPlan([item(voice, 'sarvam', { state: 'failed' })], deps([new FakeProvider('sarvam', 7_200)], { partsFor }));
    expect(ledger.outcome('voice-a', 'sarvam')).toMatchObject({ status: 'failed', error: 'audio_split_failed' });
    expect(readdirSync(join(dir, 'results', 'voice-a')).filter((f) => f.startsWith('sarvam.failed-'))).toHaveLength(1);
  });

  it('fails a slot whose audio gives no parts, without sending', async () => {
    const p = new FakeProvider('openai', 300);
    await runPlan([item(voice, 'openai')], deps([p], { partsFor: async () => [] }));
    expect(p.calls).toHaveLength(0);
    expect(ledger.outcome('voice-a', 'openai')).toMatchObject({ status: 'failed', error: 'audio_no_parts' });
    expect(ledger.attempt('voice-a', 'openai')).toBeNull();
  });

  it('keeps waiting when a job id cannot be saved, with a warning', async () => {
    let attemptWrites = 0;
    const flaky = new Ledger(dir, {
      rename: (from, to) => {
        // The third write of the attempt is saveJobId's: begin and the send record come first.
        if (to.endsWith('.attempt.json') && ++attemptWrites === 3) throw errno('ENOSPC');
        renameSync(from, to);
      },
    });
    const p = new FakeProvider('sarvam', 7_200, async (_c, _p, opts) => {
      opts.onJobId?.('job-1');
      return { model: 'm', segments: [], billedSeconds: null, raw: {} };
    });
    const sum = await runPlan([item(meeting, 'sarvam')], deps([p], { ledger: flaky }));
    expect(sum.done).toBe(1);
    expect(flaky.state('meeting-b', 'sarvam')).toBe('done');
    expect(lines).toContain('warning  meeting-b sarvam: could not save the job id (ENOSPC); still waiting');
  });

  it('stops the whole run, sending nothing, when the attempt cannot be written', async () => {
    const broken = new Ledger(dir, {
      rename: () => {
        throw errno('ENOSPC');
      },
    });
    const p = new FakeProvider('openai', 300);
    await expect(runPlan([item(voice, 'openai'), item(meeting, 'openai')], deps([p], { ledger: broken }))).rejects.toBeInstanceOf(LedgerError);
    expect(p.calls).toHaveLength(0);
  });

  it('stops the whole run when an answer cannot be saved', async () => {
    const broken = new Ledger(dir, {
      rename: (from, to) => {
        if (to.includes('.part-')) throw errno('ENOSPC');
        renameSync(from, to);
      },
    });
    const p = new FakeProvider('openai', 300);
    await expect(runPlan([item(voice, 'openai'), item(meeting, 'openai')], deps([p], { ledger: broken }))).rejects.toBeInstanceOf(LedgerError);
    expect(p.calls).toHaveLength(1);
    // The paid request went out and its answer is not on disk: the slot stays unknown, never "new".
    expect(broken.state('voice-a', 'openai')).toBe('unknown');
  });

  it('deletes the provider copy once per fresh part, after saving it', async () => {
    const p = new ForgetfulProvider('elevenlabs', 300, null, async (_c, part) => {
      return { model: 'm', segments: [], billedSeconds: null, raw: { transcription_id: part.path } };
    });
    // Part 0 was answered in an earlier run; only part 1 is fresh.
    ledger.begin({ sampleId: 'meeting-b', provider: 'elevenlabs', model: 'scribe_v2', startedAt: '2026-10-22T10:00:00.000Z', jobIds: {}, sends: [] });
    ledger.savePart('meeting-b', 'elevenlabs', 0, { offset: 0, seconds: 300 }, { model: 'm', segments: [], billedSeconds: null, raw: { transcription_id: 'old' } });
    const original = p.forget.bind(p);
    p.forget = async (r) => {
      expect(ledger.part('meeting-b', 'elevenlabs', 1, { offset: 300, seconds: 100 })).not.toBeNull();
      await original(r);
    };
    await runPlan([item(meeting, 'elevenlabs', { seconds: 400, parts: 2, state: 'unknown' })], deps([p], { partsFor: twoParts }));
    expect(p.forgotten.map((r) => r.raw)).toEqual([{ transcription_id: 'p1.mp3' }]);
    expect(ledger.state('meeting-b', 'elevenlabs')).toBe('done');
  });

  it('keeps the provider copy when asked to', async () => {
    const p = new ForgetfulProvider('elevenlabs', 36_000);
    await runPlan([item(voice, 'elevenlabs')], deps([p], { forgetRemote: false }));
    expect(p.forgotten).toEqual([]);
    expect(ledger.state('voice-a', 'elevenlabs')).toBe('done');
  });

  it('only warns when the provider copy cannot be deleted', async () => {
    const p = new ForgetfulProvider('elevenlabs', 36_000, new SttHttpError(404, 'not_found'));
    const sum = await runPlan([item(voice, 'elevenlabs'), item(meeting, 'elevenlabs')], deps([p]));
    expect(p.forgotten).toHaveLength(2);
    expect(sum).toMatchObject({ done: 2, failed: 0, unknown: 0 });
    expect(lines).toContain("warning  voice-a elevenlabs: could not delete the provider's stored copy (http_404)");
  });
});
