import { mkdirSync, mkdtempSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Ledger, LedgerError, type Attempt, type Outcome } from '../../../src/stt/bakeoff/ledger.ts';

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

  it('moves a failed outcome and its attempt aside on reopen, keeping both on disk', () => {
    const l = new Ledger(dir, { now: () => 1_700_000_000_000 });
    l.begin(attempt({ jobIds: { '0': 'job-1' } }));
    l.finish(outcome({ status: 'failed', error: 'http_500', segments: [] }));
    l.reopen('voice-a', 'sarvam');
    expect(l.state('voice-a', 'sarvam')).toBe('new');
    expect(readdirSync(join(dir, 'results', 'voice-a')).sort()).toEqual([
      'sarvam.failed-1700000000000-0.attempt.json',
      'sarvam.failed-1700000000000-0.json',
    ]);
  });

  it('picks a new name for each reopen, even within one millisecond', () => {
    const l = new Ledger(dir, { now: () => 5 });
    for (let i = 0; i < 2; i++) {
      l.begin(attempt());
      l.finish(outcome({ status: 'failed', error: 'http_500', segments: [] }));
      l.reopen('voice-a', 'sarvam');
    }
    expect(readdirSync(join(dir, 'results', 'voice-a')).sort()).toEqual([
      'sarvam.failed-5-0.attempt.json',
      'sarvam.failed-5-0.json',
      'sarvam.failed-5-1.attempt.json',
      'sarvam.failed-5-1.json',
    ]);
  });

  it('reopens a failed slot that never got an attempt', () => {
    ledger.finish(outcome({ status: 'failed', error: 'audio_split_failed', segments: [] }));
    ledger.reopen('voice-a', 'sarvam');
    expect(ledger.state('voice-a', 'sarvam')).toBe('new');
  });

  it('refuses to reopen a slot that is not failed', () => {
    expect(() => ledger.reopen('voice-a', 'sarvam')).toThrow(LedgerError);
    ledger.begin(attempt());
    expect(() => ledger.reopen('voice-a', 'sarvam')).toThrow(LedgerError);
    ledger.finish(outcome());
    expect(() => ledger.reopen('voice-a', 'sarvam')).toThrow(LedgerError);
    expect(ledger.state('voice-a', 'sarvam')).toBe('done');
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

const errno = (code: string): Error => Object.assign(new Error(code), { code });

describe('Ledger writes', () => {
  it('waits out a file lock on the rename, 100 ms at a time', () => {
    let locked = 3;
    const pauses: number[] = [];
    const l = new Ledger(dir, {
      rename: (from, to) => {
        if (locked-- > 0) throw errno('EPERM');
        renameSync(from, to);
      },
      pause: (ms) => pauses.push(ms),
    });
    l.begin(attempt());
    expect(l.attempt('voice-a', 'sarvam')).toEqual(attempt());
    expect(pauses).toEqual([100, 100, 100]);
  });

  it('gives up after 20 retries with a LedgerError carrying the lock code', () => {
    let tries = 0;
    const pauses: number[] = [];
    const l = new Ledger(dir, {
      rename: () => {
        tries++;
        throw errno('EBUSY');
      },
      pause: (ms) => pauses.push(ms),
    });
    let caught: unknown;
    try {
      l.begin(attempt());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LedgerError);
    expect((caught as LedgerError).code).toBe('EBUSY');
    expect(tries).toBe(21);
    expect(pauses).toHaveLength(20);
  });

  it('does not wait on errors that are not locks', () => {
    const pauses: number[] = [];
    const l = new Ledger(dir, {
      rename: () => {
        throw errno('ENOSPC');
      },
      pause: (ms) => pauses.push(ms),
    });
    expect(() => l.finish(outcome())).toThrow(LedgerError);
    expect(pauses).toEqual([]);
  });

  it('wraps every write failure in a LedgerError', () => {
    writeFileSync(join(dir, 'results'), 'a file where the folder should be');
    expect(() => ledger.begin(attempt())).toThrow(LedgerError);
    expect(() => ledger.savePart('voice-a', 'openai', 0, { model: 'm', segments: [], billedSeconds: null, raw: {} })).toThrow(LedgerError);
    expect(() => ledger.saveJobId('voice-a', 'sarvam', 0, 'job-1')).toThrow(LedgerError);
  });

  it('leaves no temporary file behind', () => {
    ledger.begin(attempt());
    ledger.finish(outcome());
    expect(readdirSync(join(dir, 'results', 'voice-a')).sort()).toEqual(['sarvam.attempt.json', 'sarvam.json']);
  });

  it('names a damaged ledger file instead of guessing its state', () => {
    mkdirSync(join(dir, 'results', 'voice-a'), { recursive: true });
    const path = join(dir, 'results', 'voice-a', 'sarvam.json');
    writeFileSync(path, '{"status": "do');
    let caught: unknown;
    try {
      ledger.state('voice-a', 'sarvam');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LedgerError);
    expect((caught as LedgerError).code).toBe('damaged_file');
    expect((caught as Error).message).toContain(path);
  });
});
