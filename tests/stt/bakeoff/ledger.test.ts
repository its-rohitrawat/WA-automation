import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Ledger, type Attempt, type Outcome } from '../../../src/stt/bakeoff/ledger.ts';

let dir: string;
let ledger: Ledger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stt-ledger-'));
  ledger = new Ledger(dir);
});

const attempt = (over: Partial<Attempt> = {}): Attempt => ({
  sampleId: 'voice-a',
  provider: 'sarvam',
  model: 'saaras:v4',
  startedAt: '2026-10-22T10:00:00.000Z',
  jobIds: {},
  ...over,
});

const outcome = (over: Partial<Outcome> = {}): Outcome => ({
  sampleId: 'voice-a',
  kind: 'voice',
  provider: 'sarvam',
  model: 'saaras:v4',
  status: 'done',
  audioSeconds: 42,
  billedSeconds: null,
  costUsd: 0.004,
  processingSeconds: 12.5,
  parts: 1,
  error: null,
  segments: [{ start: 0, end: 42, speaker: null, text: 'Kal milte hain' }],
  finishedAt: '2026-10-22T10:01:00.000Z',
  ...over,
});

describe('Ledger', () => {
  it('moves a slot from new to unknown to done', () => {
    expect(ledger.state('voice-a', 'sarvam')).toBe('new');
    ledger.begin(attempt());
    expect(ledger.state('voice-a', 'sarvam')).toBe('unknown');
    ledger.finish(outcome());
    expect(ledger.state('voice-a', 'sarvam')).toBe('done');
    expect(ledger.outcome('voice-a', 'sarvam')).toEqual(outcome());
  });

  it('reports a failed outcome as failed', () => {
    ledger.begin(attempt());
    ledger.finish(outcome({ status: 'failed', error: 'http_401', segments: [] }));
    expect(ledger.state('voice-a', 'sarvam')).toBe('failed');
  });

  it('keeps slots of different providers apart', () => {
    ledger.begin(attempt());
    expect(ledger.state('voice-a', 'openai')).toBe('new');
  });

  it('saves job ids on the attempt', () => {
    ledger.begin(attempt());
    ledger.saveJobId('voice-a', 'sarvam', 0, 'job-1');
    expect(ledger.attempt('voice-a', 'sarvam')?.jobIds).toEqual({ '0': 'job-1' });
  });

  it('refuses a job id before the attempt exists', () => {
    expect(() => ledger.saveJobId('voice-a', 'sarvam', 0, 'job-1')).toThrow();
  });

  it('stores and returns each part answer', () => {
    const part = { model: 'm', segments: [], billedSeconds: 30, raw: { ok: true } };
    expect(ledger.part('voice-a', 'openai', 1)).toBeNull();
    ledger.savePart('voice-a', 'openai', 1, part);
    expect(ledger.part('voice-a', 'openai', 1)).toEqual(part);
  });

  it('moves a failed outcome aside on reopen and keeps it on disk', () => {
    ledger.begin(attempt());
    ledger.finish(outcome({ status: 'failed', error: 'http_500', segments: [] }));
    ledger.reopen('voice-a', 'sarvam');
    expect(ledger.outcome('voice-a', 'sarvam')).toBeNull();
    expect(readdirSync(join(dir, 'results', 'voice-a')).some((f) => f.startsWith('sarvam.failed-'))).toBe(true);
  });

  it('lists finished outcomes only', () => {
    ledger.begin(attempt());
    ledger.finish(outcome());
    ledger.begin(attempt({ sampleId: 'meeting-b', provider: 'openai' }));
    ledger.savePart('meeting-b', 'openai', 0, { model: 'm', segments: [], billedSeconds: null, raw: {} });
    expect(ledger.outcomes()).toEqual([outcome()]);
  });

  it('lists nothing before the first run', () => {
    expect(ledger.outcomes()).toEqual([]);
  });
});
