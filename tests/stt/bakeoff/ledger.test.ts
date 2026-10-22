import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Ledger, LedgerError, type Attempt, type Outcome } from '../../../src/stt/bakeoff/ledger.ts';
import type { AudioPart } from '../../../src/stt/types.ts';

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
  sends: [],
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
    expect(() => ledger.saveJobId('voice-a', 'sarvam', 0, 'job-1')).toThrow(LedgerError);
  });

  it('moves the job id of a lost job to lostJobIds, keeping every earlier one', () => {
    ledger.begin(attempt({ jobIds: { '0': 'job-1', '1': 'job-2' }, sends: ['2026-10-22T10:00:01.000Z'] }));
    ledger.dropJobId('voice-a', 'sarvam', 0);
    expect(ledger.attempt('voice-a', 'sarvam')).toEqual(
      attempt({ jobIds: { '1': 'job-2' }, lostJobIds: { '0': 'job-1' }, sends: ['2026-10-22T10:00:01.000Z'] }),
    );
    expect(ledger.canResume('voice-a', 'sarvam', 2)).toBe(false);
    // Sent again and lost again: the second id is kept beside the first.
    ledger.saveJobId('voice-a', 'sarvam', 0, 'job-3');
    ledger.dropJobId('voice-a', 'sarvam', 0);
    expect(ledger.attempt('voice-a', 'sarvam')?.lostJobIds).toEqual({ '0': 'job-1', '0-2': 'job-3' });
    expect(ledger.attempt('voice-a', 'sarvam')?.jobIds).toEqual({ '1': 'job-2' });
  });

  it('drops nothing for a part without a saved job id, and refuses before the attempt exists', () => {
    expect(() => ledger.dropJobId('voice-a', 'sarvam', 0)).toThrow(LedgerError);
    ledger.begin(attempt({ jobIds: { '1': 'job-2' } }));
    ledger.dropJobId('voice-a', 'sarvam', 0);
    expect(ledger.attempt('voice-a', 'sarvam')).toEqual(attempt({ jobIds: { '1': 'job-2' } }));
  });

  it('records the time of each paid request on the attempt', () => {
    ledger.begin(attempt({ jobIds: { '0': 'job-1' } }));
    ledger.noteSend('voice-a', 'sarvam', '2026-10-22T10:00:01.000Z');
    ledger.noteSend('voice-a', 'sarvam', '2026-10-22T10:05:00.000Z');
    expect(ledger.attempt('voice-a', 'sarvam')).toEqual(attempt({ jobIds: { '0': 'job-1' }, sends: ['2026-10-22T10:00:01.000Z', '2026-10-22T10:05:00.000Z'] }));
  });

  it('can resume for free only when every part has a job id or a saved answer', () => {
    const answer = { model: 'm', segments: [], billedSeconds: null, raw: {} };
    expect(ledger.canResume('meeting-b', 'openai', 1)).toBe(false);
    ledger.begin(attempt({ sampleId: 'meeting-b', provider: 'openai', jobIds: { '0': 'job-0' } }));
    expect(ledger.canResume('meeting-b', 'openai', 1)).toBe(true);
    expect(ledger.canResume('meeting-b', 'openai', 2)).toBe(false);
    ledger.savePart('meeting-b', 'openai', 1, { offset: 300, seconds: 100 }, answer);
    expect(ledger.canResume('meeting-b', 'openai', 2)).toBe(true);
    expect(ledger.canResume('meeting-b', 'openai', 3)).toBe(false);
    expect(ledger.canResume('meeting-b', 'openai', 0)).toBe(false);
  });

  it('refuses to record a send before the attempt exists', () => {
    expect(() => ledger.noteSend('voice-a', 'sarvam', '2026-10-22T10:00:01.000Z')).toThrow(LedgerError);
  });

  it('stores and returns each part answer for the same cut, within 0.01 s', () => {
    const part = { model: 'm', segments: [], billedSeconds: 30, raw: { ok: true } };
    const cut = { offset: 300, seconds: 100 };
    expect(ledger.part('voice-a', 'openai', 1, cut)).toBeNull();
    const audio: AudioPart = { ...cut, path: 'C:\\out\\p1.mp3' };
    ledger.savePart('voice-a', 'openai', 1, audio, part);
    expect(ledger.part('voice-a', 'openai', 1, cut)).toEqual(part);
    expect(ledger.part('voice-a', 'openai', 1, { offset: 300.009, seconds: 99.991 })).toEqual(part);
    // Only the cut is stored with the answer, never the local path.
    expect(JSON.parse(readFileSync(join(dir, 'results', 'voice-a', 'openai.part-1.json'), 'utf8'))).toEqual({ ...cut, result: part });
  });

  it('refuses a saved answer for a part that is now cut differently', () => {
    const part = { model: 'm', segments: [], billedSeconds: 30, raw: {} };
    ledger.savePart('voice-a', 'openai', 1, { offset: 300, seconds: 100 }, part);
    for (const cut of [{ offset: 300, seconds: 90 }, { offset: 290, seconds: 100 }]) {
      let caught: unknown;
      try {
        ledger.part('voice-a', 'openai', 1, cut);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(LedgerError);
      expect((caught as LedgerError).code).toBe('part_cache_mismatch');
    }
  });

  it('refuses a saved part that records no cut', () => {
    mkdirSync(join(dir, 'results', 'voice-a'), { recursive: true });
    writeFileSync(join(dir, 'results', 'voice-a', 'openai.part-0.json'), JSON.stringify({ model: 'm', segments: [], billedSeconds: 1, raw: {} }));
    expect(() => ledger.part('voice-a', 'openai', 0, { offset: 0, seconds: 1 })).toThrow(/cut differently|no cut/);
  });

  it('reopens a failed slot with a fresh attempt, keeping the old outcome and attempt on disk', () => {
    const l = new Ledger(dir, { now: () => 1_700_000_000_000 });
    l.begin(attempt({ jobIds: { '0': 'job-1' } }));
    l.finish(outcome({ status: 'failed', error: 'http_500', segments: [] }));
    const fresh = attempt({ startedAt: '2026-10-22T11:00:00.000Z' });
    l.reopen(fresh);
    // Sent from here on, so it reads unknown until the new outcome is written; never new.
    expect(l.state('voice-a', 'sarvam')).toBe('unknown');
    expect(l.attempt('voice-a', 'sarvam')).toEqual(fresh);
    expect(readdirSync(join(dir, 'results', 'voice-a')).sort()).toEqual([
      'sarvam.attempt.json',
      'sarvam.failed-1700000000000-0.attempt.json',
      'sarvam.failed-1700000000000-0.json',
    ]);
    expect(JSON.parse(readFileSync(join(dir, 'results', 'voice-a', 'sarvam.failed-1700000000000-0.attempt.json'), 'utf8'))).toEqual(attempt({ jobIds: { '0': 'job-1' } }));
  });

  it('picks a new name for each reopen, even within one millisecond', () => {
    const l = new Ledger(dir, { now: () => 5 });
    for (let i = 0; i < 2; i++) {
      l.begin(attempt());
      l.finish(outcome({ status: 'failed', error: 'http_500', segments: [] }));
      l.reopen(attempt());
    }
    expect(readdirSync(join(dir, 'results', 'voice-a')).sort()).toEqual([
      'sarvam.attempt.json',
      'sarvam.failed-5-0.attempt.json',
      'sarvam.failed-5-0.json',
      'sarvam.failed-5-1.attempt.json',
      'sarvam.failed-5-1.json',
    ]);
  });

  it('reopens a failed slot that never got an attempt', () => {
    ledger.finish(outcome({ status: 'failed', error: 'audio_split_failed', segments: [] }));
    ledger.reopen(attempt());
    expect(ledger.state('voice-a', 'sarvam')).toBe('unknown');
  });

  it('refuses to reopen a slot that is not failed, and writes nothing', () => {
    expect(() => ledger.reopen(attempt())).toThrow(LedgerError);
    expect(ledger.state('voice-a', 'sarvam')).toBe('new');
    ledger.begin(attempt({ jobIds: { '0': 'job-1' } }));
    expect(() => ledger.reopen(attempt())).toThrow(LedgerError);
    expect(ledger.attempt('voice-a', 'sarvam')?.jobIds).toEqual({ '0': 'job-1' });
    ledger.finish(outcome());
    expect(() => ledger.reopen(attempt())).toThrow(LedgerError);
    expect(ledger.state('voice-a', 'sarvam')).toBe('done');
  });

  it('records a new failure over an old one, keeping the old outcome and attempt aside', () => {
    const l = new Ledger(dir, { now: () => 7 });
    l.begin(attempt({ jobIds: { '0': 'job-1' } }));
    l.finish(outcome({ status: 'failed', error: 'http_500', segments: [] }));
    l.replaceFailed(outcome({ status: 'failed', error: 'audio_split_failed', segments: [] }));
    expect(l.outcome('voice-a', 'sarvam')).toMatchObject({ status: 'failed', error: 'audio_split_failed' });
    expect(l.attempt('voice-a', 'sarvam')).toBeNull();
    expect(readdirSync(join(dir, 'results', 'voice-a')).sort()).toEqual(['sarvam.failed-7-0.attempt.json', 'sarvam.failed-7-0.json', 'sarvam.json']);
    expect(JSON.parse(readFileSync(join(dir, 'results', 'voice-a', 'sarvam.failed-7-0.json'), 'utf8'))).toMatchObject({ error: 'http_500' });
    // Only a failure replaces a failure, and only on a failed slot.
    expect(() => l.replaceFailed(outcome())).toThrow(LedgerError);
    expect(() => l.replaceFailed(outcome({ sampleId: 'voice-z', status: 'failed', error: 'x', segments: [] }))).toThrow(LedgerError);
    expect(l.state('voice-z', 'sarvam')).toBe('new');
  });

  it('lists finished outcomes only', () => {
    ledger.begin(attempt());
    ledger.finish(outcome());
    ledger.begin(attempt({ sampleId: 'meeting-b', provider: 'openai' }));
    ledger.savePart('meeting-b', 'openai', 0, { offset: 0, seconds: 300 }, { model: 'm', segments: [], billedSeconds: null, raw: {} });
    expect(ledger.outcomes()).toEqual([outcome()]);
  });

  it('lists nothing before the first run', () => {
    expect(ledger.outcomes()).toEqual([]);
  });
});

describe('Ledger retry order', () => {
  /** A ledger whose k-th rename fails as a full disk would: a crash at that point. */
  function crashingAt(k: number): Ledger {
    let renames = 0;
    return new Ledger(dir, {
      rename: (from, to) => {
        if (++renames === k) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
        renameSync(from, to);
      },
    });
  }

  function failedSlot(): void {
    dir = mkdtempSync(join(tmpdir(), 'stt-ledger-'));
    const l = new Ledger(dir);
    l.begin(attempt({ jobIds: { '0': 'job-1' }, sends: ['2026-10-22T10:00:01.000Z'] }));
    l.finish(outcome({ status: 'failed', error: 'http_500', segments: [] }));
  }

  it('never reads new at any point of a reopen, so a plain run cannot send the slot unasked', () => {
    // The three steps of a reopen: the old attempt aside, the fresh attempt written, the old outcome aside.
    for (let k = 1; k <= 3; k++) {
      failedSlot();
      expect(() => crashingAt(k).reopen(attempt({ startedAt: '2026-10-22T11:00:00.000Z' }))).toThrow(LedgerError);
      expect(new Ledger(dir).state('voice-a', 'sarvam')).toBe('failed');
    }
    failedSlot();
    crashingAt(4).reopen(attempt({ startedAt: '2026-10-22T11:00:00.000Z' }));
    expect(new Ledger(dir).state('voice-a', 'sarvam')).toBe('unknown');
  });

  it('reads failed at every point of replacing one failure by another', () => {
    for (let k = 1; k <= 3; k++) {
      failedSlot();
      expect(() => crashingAt(k).replaceFailed(outcome({ status: 'failed', error: 'audio_split_failed', segments: [] }))).toThrow(LedgerError);
      expect(new Ledger(dir).state('voice-a', 'sarvam')).toBe('failed');
    }
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
    expect(() => ledger.savePart('voice-a', 'openai', 0, { offset: 0, seconds: 1 }, { model: 'm', segments: [], billedSeconds: null, raw: {} })).toThrow(LedgerError);
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
