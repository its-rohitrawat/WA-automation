import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AudioError } from '../../../src/stt/audio.ts';
import { Ledger } from '../../../src/stt/bakeoff/ledger.ts';
import type { PlanItem } from '../../../src/stt/bakeoff/plan.ts';
import { runPlan, type RunDeps } from '../../../src/stt/bakeoff/runner.ts';
import type { Sample } from '../../../src/stt/bakeoff/samples.ts';
import { SttHttpError, SttNoAnswerError } from '../../../src/stt/http.ts';
import { modelFor } from '../../../src/stt/prices.ts';
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
    log: (l) => lines.push(l),
    now: () => 1_000,
    ...over,
  };
}

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
    ledger.begin({ sampleId: 'meeting-b', provider: 'openai', model: 'gpt-4o-transcribe-diarize', startedAt: '2026-10-22T10:00:00.000Z', jobIds: {} });
    ledger.savePart('meeting-b', 'openai', 1, { offset: 250, seconds: 150 }, { model: 'm', segments: [], billedSeconds: 150, raw: {} });
    const p = new FakeProvider('openai', 300);
    const sum = await runPlan([item(meeting, 'openai', { seconds: 400, parts: 2, state: 'unknown' })], deps([p], { partsFor: twoParts }));
    // Part 0 has no saved answer, yet it is not sent either: the mismatch on part 1 is found first.
    expect(p.calls).toHaveLength(0);
    expect(ledger.state('meeting-b', 'openai')).toBe('unknown');
    expect(sum).toMatchObject({ unknown: 1, spentUsd: 0 });
    expect(lines.some((l) => l.includes('part_cache_mismatch'))).toBe(true);
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
