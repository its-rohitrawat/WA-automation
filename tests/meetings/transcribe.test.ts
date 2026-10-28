import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../../src/config/env.ts';
import { MeetingDeferral } from '../../src/meetings/audio.ts';
import {
  bookStuckParts, createMeetingTranscriber, forgetPending, MAX_FORGET_ATTEMPTS, meetingTranscriber, recoverInflightParts, transcribeMeeting, type MeetingTranscriber,
  type TranscribeMeetingDeps,
} from '../../src/meetings/transcribe.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { Ffmpeg, type RunFile } from '../../src/stt/audio.ts';
import { SttHttpError, SttJobLostError, SttNoAnswerError, type HttpFetch } from '../../src/stt/http.ts';
import { costUsd, modelFor } from '../../src/stt/prices.ts';
import type { AudioPart, ProviderId, ProviderResult, Segment, SttProvider, TranscribeOptions } from '../../src/stt/types.ts';
import type { Db } from '../../src/store/db.ts';
import { advanceStage, failMeeting, getMeeting, insertFound, setSttParts, type NewMeeting, type SttPartRow } from '../../src/store/meetings.ts';
import { manualClock } from '../../src/util/clock.ts';
import { createLogger, silentLogger, type Logger } from '../../src/util/logger.ts';
import { NOW, seededDb } from '../helpers/db.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const INR = 88;
const ceiling = (provider: ProviderId, seconds: number) => costUsd(modelFor(provider, true), seconds, INR);

let seq = 0;
const newMeeting = (): NewMeeting => ({
  recording: `conferenceRecords/c1/recordings/r${++seq}`, conference: 'conferenceRecords/c1', driveFileId: 'fileAbc123', meetingCode: null,
  title: 'Sharma weekly', startedAt: '2026-10-31T20:00:00.000Z', endedAt: null, attendees: [], participants: [], clientId: 1, matchKind: 'title',
  status: 'queued', driveSeconds: null, createdAt: NOW,
});

type Script = (audio: AudioPart, opts: TranscribeOptions) => Promise<ProviderResult>;
let refSeq = 0;
/** The answer keeps a copy at the provider, named by ref (as ElevenLabs does). */
const result = (segments: Segment[], billedSeconds: number | null = null): ProviderResult => ({ model: 'm', segments, billedSeconds, raw: { segments, ref: `tr-${++refSeq}` } });
const said = (text: string, speaker: string | null = 'A'): Segment[] => [{ start: 1, end: 2, speaker, text }];
const ok = (text = 'namaste', billed: number | null = null): Script => async () => result(said(text), billed);
const fail = (e: Error): Script => async () => {
  throw e;
};
/** A Sarvam-style answer: the job is accepted (onJobId) unless it is being resumed, then the script runs. */
const job = (id: string, then: Script = ok()): Script => async (audio, opts) => {
  if (!opts.resumeJobId) opts.onJobId?.(id);
  return await then(audio, opts);
};

class FakeProvider implements SttProvider {
  readonly id: ProviderId;
  readonly maxPartSeconds: number;
  readonly calls: { audio: AudioPart; opts: TranscribeOptions }[] = [];
  script: Script[] = [];
  forgetImpl: (ref: string) => Promise<void> = async () => {};
  readonly forgotten: unknown[] = [];
  constructor(id: ProviderId, maxPartSeconds: number) {
    this.id = id;
    this.maxPartSeconds = maxPartSeconds;
  }
  async transcribe(audio: AudioPart, opts: TranscribeOptions): Promise<ProviderResult> {
    this.calls.push({ audio, opts });
    const next = this.script.shift() ?? ok();
    return await next(audio, opts);
  }
  forgetRef(r: ProviderResult): string | null {
    return (r.raw as { ref?: string }).ref ?? null;
  }
  async forgetById(ref: string): Promise<void> {
    this.forgotten.push(ref);
    await this.forgetImpl(ref);
  }
}

const banner = (s: number) =>
  `  Duration: ${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}, start: 0\n`;

/**
 * ffmpeg for split: segment run n writes one file per length in lengths[n] (the last list again after that); measuring
 * a part returns the length it was written with.
 */
function splitter(lengths: number[], ...later: number[][]): { run: RunFile; segmentRuns: () => number } {
  const runs = [lengths, ...later];
  const written = new Map<string, number>();
  let segments = 0;
  const run: RunFile = async (_file, args) => {
    const last = args[args.length - 1]!;
    if (args.includes('segment')) {
      const these = runs[Math.min(segments, runs.length - 1)]!;
      segments++;
      these.forEach((s, i) => {
        const path = last.replace('%03d', String(i).padStart(3, '0'));
        writeFileSync(path, 'part');
        written.set(path, s);
      });
      return { code: 0, stderr: '' };
    }
    const input = args[args.indexOf('-i') + 1]!;
    return { code: 1, stderr: banner(written.get(input) ?? 0) };
  };
  return { run, segmentRuns: () => segments };
}

function capturingLogger(): { lines: string[]; log: Logger } {
  const lines: string[] = [];
  return { lines, log: createLogger('info', new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } })) };
}

describe('transcribeMeeting', () => {
  let dataDir: string;
  let db: Db;
  let spend: SpendGuard;
  let id: number;
  let audioAbs: string;
  const clock = manualClock('2026-11-01T10:00:00.000Z');
  const rows = () => db.prepare('SELECT kind, usd, detail FROM spend ORDER BY id').all() as { kind: string; usd: number; detail: string }[];
  const parts = () => getMeeting(db, id)!.sttParts;
  const later = (ms: number) => manualClock(new Date(clock.now().getTime() + ms).toISOString());
  const forgets = () => db.prepare('SELECT * FROM stt_forget ORDER BY id').all() as { id: number; meeting_id: number; provider: string; ref: string; attempts: number }[];
  const partsDir = () => join(dataDir, 'meetings', 'tmp', `${id}-parts`);

  const prepare = (audioSeconds: number) => {
    id = insertFound(db, newMeeting())!;
    const rel = `meetings/SHA/2026-11/${id}.mp3`;
    advanceStage(db, id, 'audio', { audioPath: rel, audioSeconds }, NOW);
    audioAbs = join(dataDir, ...rel.split('/'));
    mkdirSync(join(dataDir, 'meetings', 'SHA', '2026-11'), { recursive: true });
    writeFileSync(audioAbs, 'mp3-bytes');
  };
  const deps = (provider: SttProvider | null, o: Partial<TranscribeMeetingDeps> & { lengths?: number[] } = {}): TranscribeMeetingDeps => ({
    db, spend, transcriber: provider ? meetingTranscriber(provider, INR) : null, ffmpeg: new Ffmpeg('ffmpeg.exe', splitter(o.lengths ?? []).run),
    dataDir, clock, log: silentLogger(), ...o,
  });

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'meet-stt-'));
    dirs.push(dataDir);
    db = seededDb();
    spend = new SpendGuard({ db, clock, capUsd: 5 });
  });

  it('transcribes a meeting in one part and books what the provider billed', async () => {
    prepare(1200);
    const p = new FakeProvider('elevenlabs', 36_000);
    p.script = [ok('namaste', 1201)];
    expect(await transcribeMeeting(id, deps(p))).toEqual({ parts: 1, segments: 1, note: null });
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]!.audio).toEqual({ path: audioAbs, seconds: 1200, offset: 0 });
    expect(p.calls[0]!.opts.diarize).toBe(true);
    const m = getMeeting(db, id)!;
    expect(m.stage).toBe('transcribed');
    expect(m.transcript).toEqual([{ start: 1, end: 2, speaker: 'A', text: 'namaste' }]);
    expect(m.note).toBeNull();
    expect(m.sttParts).toEqual([{ index: 1, provider: 'elevenlabs', file: null, offset: 0, seconds: 1200, state: 'done', jobId: null, booked: 'actual', segments: said('namaste'), billedSeconds: 1201 }]);
    expect(rows()).toEqual([{ kind: 'stt', usd: ceiling('elevenlabs', 1201), detail: `meeting ${id} part 1` }]);
  });

  it('splits a long meeting, moves times by each part offset and labels speakers per part', async () => {
    prepare(900);
    const p = new FakeProvider('openai', 300);
    p.script = [ok('one'), ok('two'), ok('three')];
    const ff = splitter([300, 300, 300]);
    await transcribeMeeting(id, deps(p, { ffmpeg: new Ffmpeg('ffmpeg.exe', ff.run) }));
    expect(p.calls.map((c) => c.audio)).toEqual([
      { path: join(partsDir(), 'part-000.mp3'), seconds: 300, offset: 0 },
      { path: join(partsDir(), 'part-001.mp3'), seconds: 300, offset: 300 },
      { path: join(partsDir(), 'part-002.mp3'), seconds: 300, offset: 600 },
    ]);
    expect(getMeeting(db, id)!.transcript).toEqual([
      { start: 1, end: 2, speaker: 'p1:A', text: 'one' },
      { start: 301, end: 302, speaker: 'p2:A', text: 'two' },
      { start: 601, end: 602, speaker: 'p3:A', text: 'three' },
    ]);
    expect(rows().map((r) => r.detail)).toEqual([1, 2, 3].map((n) => `meeting ${id} part ${n}`));
    expect(rows().every((r) => r.kind === 'stt')).toBe(true);
    expect(existsSync(partsDir())).toBe(false); // the parts folder is removed once the transcript is stored
  });

  it('a failure at part 3 of 5, then a retry: parts 1 and 2 are neither sent nor booked again', async () => {
    prepare(1500);
    const p = new FakeProvider('openai', 300);
    const lengths = [300, 300, 300, 300, 300];
    const ff = splitter(lengths);
    p.script = [ok('1'), ok('2'), fail(new SttHttpError(503))];
    const err = await transcribeMeeting(id, deps(p, { ffmpeg: new Ffmpeg('ffmpeg.exe', ff.run) })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SttHttpError); // 5xx: the processor retries
    expect(parts().map((x) => [x.state, x.booked])).toEqual([['done', 'actual'], ['done', 'actual'], ['todo', 'none'], ['todo', 'none'], ['todo', 'none']]);
    expect(rows()).toHaveLength(2);

    p.script = [ok('3'), ok('4'), ok('5')];
    await transcribeMeeting(id, deps(p, { ffmpeg: new Ffmpeg('ffmpeg.exe', ff.run) }));
    expect(p.calls.map((c) => c.audio.offset)).toEqual([0, 300, 600, 600, 900, 1200]);
    expect(rows().map((r) => r.detail)).toEqual([1, 2, 3, 4, 5].map((n) => `meeting ${id} part ${n}`));
    expect(ff.segmentRuns()).toBe(1); // the finished split is reused
    expect(getMeeting(db, id)!.transcript!.map((s) => s.text)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('crash with an ElevenLabs/OpenAI part in flight: recovery books it once at the ceiling, and the retry sends it again', async () => {
    prepare(1200);
    const p = new FakeProvider('elevenlabs', 36_000);
    const inflight: SttPartRow = { index: 1, provider: 'elevenlabs', file: null, offset: 0, seconds: 1200, state: 'inflight', jobId: null, booked: 'none', segments: null, billedSeconds: null };
    setSttParts(db, id, [inflight], NOW);
    expect(recoverInflightParts(db, spend, INR, silentLogger())).toBe(1);
    expect(recoverInflightParts(db, spend, INR, silentLogger())).toBe(0); // never twice
    expect(rows()).toEqual([{ kind: 'stt', usd: ceiling('elevenlabs', 1200), detail: `meeting ${id} part 1 (unknown, estimated)` }]);
    expect(parts()[0]).toMatchObject({ state: 'unknown', booked: 'ceiling' });

    p.script = [ok('again', 1200)];
    await transcribeMeeting(id, deps(p));
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]!.opts.resumeJobId).toBeUndefined();
    expect(rows()).toHaveLength(2);
    expect(rows()[1]).toEqual({ kind: 'stt', usd: ceiling('elevenlabs', 1200), detail: `meeting ${id} part 1` });
    expect(parts()[0]).toMatchObject({ state: 'done', booked: 'actual' });
  });

  it('a part left in flight is booked once by transcribeMeeting itself when recovery did not run for it', async () => {
    prepare(1200);
    const p = new FakeProvider('openai', 36_000);
    setSttParts(db, id, [{ index: 1, provider: 'openai', file: null, offset: 0, seconds: 1200, state: 'inflight', jobId: null, booked: 'none', segments: null, billedSeconds: null }], NOW);
    p.script = [ok('x', 1200)];
    await transcribeMeeting(id, deps(p));
    expect(rows().map((r) => r.detail)).toEqual([`meeting ${id} part 1 (unknown, estimated)`, `meeting ${id} part 1`]);
    expect(rows().every((r) => r.kind === 'stt')).toBe(true);
  });

  it('crash with a Sarvam job in flight: resumed by its job id with no second booking', async () => {
    prepare(3600);
    const p = new FakeProvider('sarvam', 7200);
    spend.record('stt', ceiling('sarvam', 3600), `meeting ${id} part 1`); // booked at acceptance before the crash
    setSttParts(db, id, [{ index: 1, provider: 'sarvam', file: null, offset: 0, seconds: 3600, state: 'inflight', jobId: 'job-7', booked: 'ceiling', segments: null, billedSeconds: null }], NOW);
    expect(recoverInflightParts(db, spend, INR, silentLogger())).toBe(0);
    p.script = [job('never-used')];
    await transcribeMeeting(id, deps(p));
    expect(p.calls[0]!.opts.resumeJobId).toBe('job-7');
    expect(rows()).toHaveLength(1);
    expect(parts()[0]).toMatchObject({ state: 'done', booked: 'ceiling', jobId: 'job-7' });
  });

  it('Sarvam: the ceiling is booked once, durably, when the job is accepted, and nothing more on success', async () => {
    prepare(3600);
    const p = new FakeProvider('sarvam', 7200);
    let atAcceptance: { part: SttPartRow; rows: unknown[] } | undefined;
    p.script = [
      async (_a, opts) => {
        opts.onJobId!('job-1');
        atAcceptance = { part: parts()[0]!, rows: rows() };
        return result(said('namaste'));
      },
    ];
    await transcribeMeeting(id, deps(p));
    expect(atAcceptance!.part).toMatchObject({ state: 'inflight', jobId: 'job-1', booked: 'ceiling' });
    expect(atAcceptance!.rows).toEqual([{ kind: 'stt', usd: ceiling('sarvam', 3600), detail: `meeting ${id} part 1` }]);
    expect(rows()).toHaveLength(1);
    expect(parts()[0]).toMatchObject({ state: 'done', booked: 'ceiling' });
  });

  it('Sarvam: a part with a job id but nothing booked is booked once at the ceiling before it is resumed', async () => {
    prepare(3600);
    const p = new FakeProvider('sarvam', 7200);
    setSttParts(db, id, [{ index: 1, provider: 'sarvam', file: null, offset: 0, seconds: 3600, state: 'unknown', jobId: 'J1', booked: 'none', segments: null, billedSeconds: null }], NOW);
    let atCall: unknown[] | undefined;
    p.script = [
      async (_a, opts) => {
        atCall = rows(); // booked before the provider is asked
        expect(opts.onJobId).toBeUndefined();
        return result(said('namaste'));
      },
    ];
    await transcribeMeeting(id, deps(p));
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]!.opts.resumeJobId).toBe('J1');
    expect(atCall).toEqual([{ kind: 'stt', usd: ceiling('sarvam', 3600), detail: `meeting ${id} part 1` }]);
    expect(rows()).toEqual([{ kind: 'stt', usd: ceiling('sarvam', 3600), detail: `meeting ${id} part 1` }]);
    expect(parts()[0]).toMatchObject({ state: 'done', booked: 'ceiling', jobId: 'J1' });
  });

  it('Sarvam: a second onJobId for the same job books nothing more', async () => {
    prepare(3600);
    const p = new FakeProvider('sarvam', 7200);
    p.script = [
      async (_a, opts) => {
        opts.onJobId!('J1');
        opts.onJobId!('J1');
        return result(said('namaste'));
      },
    ];
    await transcribeMeeting(id, deps(p));
    expect(rows()).toEqual([{ kind: 'stt', usd: ceiling('sarvam', 3600), detail: `meeting ${id} part 1` }]);
    expect(parts()[0]).toMatchObject({ state: 'done', booked: 'ceiling', jobId: 'J1' });
  });

  it('Sarvam: the cap is checked before a new job is sent', async () => {
    prepare(3600); // ceiling about $0.41
    spend = new SpendGuard({ db, clock, capUsd: 0.3 });
    const p = new FakeProvider('sarvam', 7200);
    const capped = await transcribeMeeting(id, deps(p)).catch((e: unknown) => e);
    expect((capped as MeetingDeferral).code).toBe('spend_cap');
    expect(p.calls).toHaveLength(0);
    expect(parts()[0]).toMatchObject({ state: 'todo', booked: 'none' });

    spend = new SpendGuard({ db, clock, capUsd: 1 });
    spend.reserve(0.7); // another paid call in flight
    const busy = await transcribeMeeting(id, deps(p)).catch((e: unknown) => e);
    expect((busy as MeetingDeferral).code).toBe('spend_busy');
    expect(p.calls).toHaveLength(0);
    expect(rows()).toEqual([]);
  });

  it('Sarvam: a lost job clears its id and stays booked; a later retry sends a new job, booked again', async () => {
    prepare(3600);
    const p = new FakeProvider('sarvam', 7200);
    p.script = [job('job-1', fail(new SttJobLostError('status_http_404')))];
    await expect(transcribeMeeting(id, deps(p))).rejects.toBeInstanceOf(SttJobLostError);
    expect(parts()[0]).toMatchObject({ state: 'unknown', jobId: null, booked: 'ceiling' });
    expect(rows()).toHaveLength(1);

    p.script = [job('job-2')];
    await transcribeMeeting(id, deps(p));
    expect(p.calls[1]!.opts.resumeJobId).toBeUndefined();
    expect(rows().map((r) => r.detail)).toEqual([`meeting ${id} part 1`, `meeting ${id} part 1`]); // a second job is a second charge
    expect(parts()[0]).toMatchObject({ state: 'done', jobId: 'job-2', booked: 'ceiling' });
  });

  it('Sarvam: no answer after the job was accepted books once and the retry waits on the same job', async () => {
    prepare(3600);
    const p = new FakeProvider('sarvam', 7200);
    p.script = [job('job-1', fail(new SttNoAnswerError('job_wait_timeout')))];
    await expect(transcribeMeeting(id, deps(p))).rejects.toBeInstanceOf(SttNoAnswerError);
    expect(parts()[0]).toMatchObject({ state: 'unknown', jobId: 'job-1', booked: 'ceiling' });
    p.script = [job('job-x')];
    await transcribeMeeting(id, deps(p));
    expect(p.calls[1]!.opts.resumeJobId).toBe('job-1');
    expect(rows()).toHaveLength(1);
  });

  it('Sarvam: a refusal before any job id releases the hold and sets the part back to todo', async () => {
    prepare(3600);
    const p = new FakeProvider('sarvam', 7200);
    p.script = [fail(new SttHttpError(503))];
    await expect(transcribeMeeting(id, deps(p))).rejects.toBeInstanceOf(SttHttpError);
    expect(parts()[0]).toMatchObject({ state: 'todo', jobId: null, booked: 'none' });
    expect(rows()).toEqual([]);
    expect(spend.canSpend(4.99)).toBe(true); // no hold left behind
  });

  it('Sarvam: no answer before any job id (the start may have gone through) books the ceiling as unknown', async () => {
    prepare(3600);
    const p = new FakeProvider('sarvam', 7200);
    p.script = [fail(new SttNoAnswerError('timeout'))];
    await expect(transcribeMeeting(id, deps(p))).rejects.toBeInstanceOf(SttNoAnswerError);
    expect(parts()[0]).toMatchObject({ state: 'unknown', jobId: null, booked: 'ceiling' });
    expect(rows()).toEqual([{ kind: 'stt', usd: ceiling('sarvam', 3600), detail: `meeting ${id} part 1 (unknown, estimated)` }]);
  });

  it('Sarvam: a shutdown during the upload books the hold once; the job accepted afterwards is not booked again', async () => {
    prepare(3600);
    const p = new FakeProvider('sarvam', 7200);
    let accept: () => void = () => {};
    const uploading = new Promise<void>((r) => (accept = r));
    let started: () => void = () => {};
    const inCall = new Promise<void>((r) => (started = r));
    p.script = [
      async (_a, opts) => {
        started();
        await uploading;
        opts.onJobId!('job-1');
        return result(said('late'));
      },
    ];
    const run = transcribeMeeting(id, deps(p));
    await inCall;
    expect(spend.settlePending('shutdown (estimated)')).toBe(1);
    expect(parts()[0]).toMatchObject({ state: 'unknown', booked: 'ceiling', jobId: null });
    accept();
    await run;
    expect(rows()).toEqual([{ kind: 'stt', usd: ceiling('sarvam', 3600), detail: 'shutdown (estimated)' }]);
    expect(parts()[0]).toMatchObject({ state: 'done', jobId: 'job-1', booked: 'ceiling' });
  });

  it('ElevenLabs/OpenAI: no answer books the ceiling once as unknown; the retry sends again with a new hold', async () => {
    prepare(1200);
    const p = new FakeProvider('elevenlabs', 36_000);
    p.script = [fail(new SttNoAnswerError('timeout'))];
    await expect(transcribeMeeting(id, deps(p))).rejects.toBeInstanceOf(SttNoAnswerError);
    expect(parts()[0]).toMatchObject({ state: 'unknown', booked: 'ceiling', jobId: null });
    expect(rows()).toEqual([{ kind: 'stt', usd: ceiling('elevenlabs', 1200), detail: `meeting ${id} part 1 (unknown, estimated)` }]);
    p.script = [ok('x', 1200)];
    await transcribeMeeting(id, deps(p));
    expect(rows()).toHaveLength(2);
    expect(parts()[0]).toMatchObject({ state: 'done', booked: 'actual' });
  });

  it('ElevenLabs: an unreadable answer that names its stored copy still gets that copy deleted later', async () => {
    prepare(1200);
    const p = new FakeProvider('elevenlabs', 36_000);
    p.script = [fail(new SttNoAnswerError('unreadable_result', 'tr-lost'))];
    await expect(transcribeMeeting(id, deps(p))).rejects.toBeInstanceOf(SttNoAnswerError);
    expect(parts()[0]).toMatchObject({ state: 'unknown', booked: 'ceiling' });
    expect(forgets()).toMatchObject([{ meeting_id: id, provider: 'elevenlabs', ref: 'tr-lost' }]);
    // A no-answer that names no copy writes no row.
    p.script = [fail(new SttNoAnswerError('timeout'))];
    await expect(transcribeMeeting(id, deps(p))).rejects.toBeInstanceOf(SttNoAnswerError);
    expect(forgets()).toHaveLength(1);
  });

  it('a shutdown during an ElevenLabs call books its hold once as stt; after the restart it is sent again, booked once more', async () => {
    prepare(1200);
    const p = new FakeProvider('elevenlabs', 36_000);
    let started: () => void = () => {};
    const inCall = new Promise<void>((r) => (started = r));
    p.script = [
      async () => {
        started();
        return await new Promise<ProviderResult>(() => {}); // the process exits before an answer
      },
    ];
    void transcribeMeeting(id, deps(p));
    await inCall;
    expect(spend.settlePending('shutdown (estimated)')).toBe(1);
    expect(parts()[0]).toMatchObject({ state: 'unknown', booked: 'ceiling' });

    spend = new SpendGuard({ db, clock, capUsd: 5 }); // the restart
    expect(recoverInflightParts(db, spend, INR, silentLogger())).toBe(0);
    p.script = [ok('x', 1200)];
    await transcribeMeeting(id, deps(p));
    expect(rows().map((r) => [r.kind, r.detail])).toEqual([['stt', 'shutdown (estimated)'], ['stt', `meeting ${id} part 1`]]);
  });

  it('an answer that arrives after the shutdown booking is stored and not booked again', async () => {
    prepare(1200);
    const p = new FakeProvider('elevenlabs', 36_000);
    let answer: (r: ProviderResult) => void = () => {};
    let started: () => void = () => {};
    const inCall = new Promise<void>((r) => (started = r));
    p.script = [
      async () => {
        started();
        return await new Promise<ProviderResult>((r) => (answer = r));
      },
    ];
    const run = transcribeMeeting(id, deps(p));
    await inCall;
    spend.settlePending('shutdown (estimated)');
    answer(result(said('late'), 1200));
    await run;
    expect(rows()).toHaveLength(1);
    expect(parts()[0]).toMatchObject({ state: 'done', booked: 'ceiling' }); // what was booked: the ceiling, at shutdown
    expect(getMeeting(db, id)!.stage).toBe('transcribed');
  });

  it('the last attempt fails with a part stuck, the meeting fails, then the part is booked exactly once', async () => {
    prepare(1200);
    const p = new FakeProvider('elevenlabs', 36_000);
    p.script = [
      async () => {
        db.prepare("UPDATE meetings SET status = 'failed' WHERE id = ?").run(id); // the part write after the call is refused
        return result(said('x'), 1200);
      },
    ];
    await expect(transcribeMeeting(id, deps(p))).rejects.toThrow();
    expect(getMeeting(db, id)!.status).toBe('failed');
    expect(parts()[0]).toMatchObject({ state: 'inflight', booked: 'none' });
    expect(rows()).toEqual([]);
    // The processor, before failMeeting (here the meeting is already failed): booked once, whatever the status.
    expect(bookStuckParts(db, spend, id, { inrPerUsd: INR, clock })).toBe(1);
    expect(bookStuckParts(db, spend, id, { inrPerUsd: INR, clock })).toBe(0);
    expect(recoverInflightParts(db, spend, INR, silentLogger())).toBe(0);
    expect(rows()).toEqual([{ kind: 'stt', usd: ceiling('elevenlabs', 1200), detail: `meeting ${id} part 1 (unknown, estimated)` }]);
    expect(parts()[0]).toMatchObject({ state: 'unknown', booked: 'ceiling' });
  });

  it('recovery at start books a part stuck in a meeting that has since failed', () => {
    prepare(1200);
    setSttParts(db, id, [{ index: 1, provider: 'openai', file: null, offset: 0, seconds: 1200, state: 'inflight', jobId: null, booked: 'none', segments: null, billedSeconds: null }], NOW);
    failMeeting(db, id, { status: 'failed', errorCode: 'attempts', at: NOW });
    expect(recoverInflightParts(db, spend, INR, silentLogger())).toBe(1);
    expect(recoverInflightParts(db, spend, INR, silentLogger())).toBe(0);
    expect(rows()).toEqual([{ kind: 'stt', usd: ceiling('openai', 1200), detail: `meeting ${id} part 1 (unknown, estimated)` }]);
  });

  it('a stuck part is booked at the price of the provider it was sent to, not the one set up now', async () => {
    prepare(3600);
    setSttParts(db, id, [{ index: 1, provider: 'sarvam', file: null, offset: 0, seconds: 3600, state: 'inflight', jobId: null, booked: 'none', segments: null, billedSeconds: null }], NOW);
    const p = new FakeProvider('elevenlabs', 36_000);
    p.script = [ok('x', 3600)];
    await transcribeMeeting(id, deps(p));
    expect(rows()).toEqual([
      { kind: 'stt', usd: ceiling('sarvam', 3600), detail: `meeting ${id} part 1 (unknown, estimated)` },
      { kind: 'stt', usd: ceiling('elevenlabs', 3600), detail: `meeting ${id} part 1` },
    ]);
    expect(parts()[0]).toMatchObject({ provider: 'elevenlabs', state: 'done' });
  });

  it('a new provider with longer parts: done parts are kept, the others go as they are', async () => {
    prepare(900);
    const ff = splitter([300, 300, 300]);
    const openai = new FakeProvider('openai', 300);
    openai.script = [ok('one'), fail(new SttHttpError(503))];
    await expect(transcribeMeeting(id, deps(openai, { ffmpeg: new Ffmpeg('ffmpeg.exe', ff.run) }))).rejects.toBeInstanceOf(SttHttpError);
    const el = new FakeProvider('elevenlabs', 36_000);
    el.script = [ok('two'), ok('three')];
    await transcribeMeeting(id, deps(el, { ffmpeg: new Ffmpeg('ffmpeg.exe', ff.run) }));
    expect(el.calls.map((c) => c.audio)).toEqual([
      { path: join(partsDir(), 'part-001.mp3'), seconds: 300, offset: 300 },
      { path: join(partsDir(), 'part-002.mp3'), seconds: 300, offset: 600 },
    ]);
    expect(parts().map((x) => [x.index, x.provider, x.state])).toEqual([[1, 'openai', 'done'], [2, 'elevenlabs', 'done'], [3, 'elevenlabs', 'done']]);
    expect(getMeeting(db, id)!.transcript!.map((s) => [s.start, s.text])).toEqual([[1, 'one'], [301, 'two'], [601, 'three']]);
    expect(ff.segmentRuns()).toBe(1);
  });

  it('a new provider with shorter parts: a part that is too long is cut again into its own folder', async () => {
    prepare(1200);
    const ff = splitter([600, 600], [300, 300]);
    const sarvam = new FakeProvider('sarvam', 600);
    sarvam.script = [job('job-1'), job('job-2', fail(new SttNoAnswerError('job_wait_timeout')))];
    await expect(transcribeMeeting(id, deps(sarvam, { ffmpeg: new Ffmpeg('ffmpeg.exe', ff.run) }))).rejects.toBeInstanceOf(SttNoAnswerError);
    expect(parts().map((x) => [x.state, x.jobId])).toEqual([['done', 'job-1'], ['unknown', 'job-2']]);

    const openai = new FakeProvider('openai', 300);
    openai.script = [ok('b'), ok('c')];
    await transcribeMeeting(id, deps(openai, { ffmpeg: new Ffmpeg('ffmpeg.exe', ff.run) }));
    const again = join(dataDir, 'meetings', 'tmp', `${id}-parts-1`);
    expect(openai.calls.map((c) => c.audio)).toEqual([
      { path: join(again, 'part-000.mp3'), seconds: 300, offset: 600 },
      { path: join(again, 'part-001.mp3'), seconds: 300, offset: 900 },
    ]);
    expect(parts().map((x) => [x.index, x.provider, x.offset, x.file])).toEqual([
      [1, 'sarvam', 0, `${id}-parts/part-000.mp3`],
      [2, 'openai', 600, `${id}-parts-1/part-000.mp3`],
      [3, 'openai', 900, `${id}-parts-1/part-001.mp3`],
    ]);
    expect(rows()).toHaveLength(4); // two Sarvam jobs at acceptance, two OpenAI parts
    expect(existsSync(again)).toBe(false);
    expect(existsSync(partsDir())).toBe(false);
  });

  it('forgetPending uses each row\'s own provider and skips, without a try, one that is not set up now', async () => {
    prepare(1200);
    const el = new FakeProvider('elevenlabs', 36_000);
    el.forgetImpl = async () => {
      throw new SttNoAnswerError('timeout');
    };
    await transcribeMeeting(id, deps(el));
    db.prepare('UPDATE stt_forget SET attempts = 0, next_try_at = NULL').run();
    const { lines, log } = capturingLogger();
    const openai = new FakeProvider('openai', 300);
    expect(await forgetPending(db, meetingTranscriber(openai, INR), log, { clock })).toBe(0);
    expect(await forgetPending(db, null, log, { clock })).toBe(0);
    expect(openai.forgotten).toEqual([]);
    expect(forgets()[0]).toMatchObject({ provider: 'elevenlabs', attempts: 0 });
    expect(lines.filter((l) => l.includes('"code":"provider_unavailable"') && l.includes(`"meetingId":${id}`))).toHaveLength(2);
    el.forgetImpl = async () => {};
    expect(await forgetPending(db, meetingTranscriber(el, INR), log, { clock })).toBe(1);
  });

  it('a refused key wins over a part record that could not be written after it (stt_unavailable)', async () => {
    prepare(1200);
    const p = new FakeProvider('elevenlabs', 36_000);
    p.script = [
      async () => {
        db.prepare("UPDATE meetings SET status = 'failed' WHERE id = ?").run(id);
        throw new SttHttpError(401);
      },
    ];
    const { lines, log } = capturingLogger();
    const err = await transcribeMeeting(id, deps(p, { log })).catch((e: unknown) => e);
    expect((err as MeetingDeferral).code).toBe('stt_unavailable');
    expect(lines.some((l) => l.includes('"code":"http_401"') && l.includes('"writeCode"'))).toBe(true);
    db.prepare("UPDATE meetings SET status = 'queued' WHERE id = ?").run(id);
    expect(parts()[0]).toMatchObject({ state: 'inflight', booked: 'none' }); // left for bookStuckParts (the safe side)
  });

  it('with no speech-to-text provider the meeting waits (stt_none) and nothing is touched', async () => {
    prepare(1200);
    const err = await transcribeMeeting(id, deps(null)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MeetingDeferral);
    expect((err as MeetingDeferral).code).toBe('stt_none');
    expect(parts()).toEqual([]);
  });

  it.each([401, 403])('a refused key (%i) waits as stt_unavailable, nothing booked, the part back to todo', async (status) => {
    prepare(1200);
    const p = new FakeProvider('elevenlabs', 36_000);
    p.script = [fail(new SttHttpError(status))];
    const err = await transcribeMeeting(id, deps(p)).catch((e: unknown) => e);
    expect((err as MeetingDeferral).code).toBe('stt_unavailable');
    expect(parts()[0]).toMatchObject({ state: 'todo', booked: 'none' });
    expect(rows()).toEqual([]);
  });

  it('429 is thrown as it is, for the processor to retry', async () => {
    prepare(1200);
    const p = new FakeProvider('openai', 36_000);
    p.script = [fail(new SttHttpError(429))];
    const err = await transcribeMeeting(id, deps(p)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SttHttpError);
    expect(parts()[0]).toMatchObject({ state: 'todo', booked: 'none' });
  });

  it('ElevenLabs/OpenAI: the cap (spend_cap) or calls in flight (spend_busy) stop the call and leave the part not in flight', async () => {
    prepare(1200); // ceiling about $0.073
    spend = new SpendGuard({ db, clock, capUsd: 0.05 });
    const p = new FakeProvider('elevenlabs', 36_000);
    expect(((await transcribeMeeting(id, deps(p)).catch((e: unknown) => e)) as MeetingDeferral).code).toBe('spend_cap');
    expect(parts()[0]).toMatchObject({ state: 'todo', booked: 'none' });
    spend = new SpendGuard({ db, clock, capUsd: 0.1 });
    spend.reserve(0.05);
    expect(((await transcribeMeeting(id, deps(p)).catch((e: unknown) => e)) as MeetingDeferral).code).toBe('spend_busy');
    expect(parts()[0]).toMatchObject({ state: 'todo', booked: 'none' });
    expect(p.calls).toHaveLength(0);
  });

  it('forget() runs only after the transcript is stored, and a failing forget does not fail the meeting', async () => {
    prepare(900);
    const p = new FakeProvider('openai', 300);
    const stages: string[] = [];
    let n = 0;
    p.forgetImpl = async () => {
      stages.push(getMeeting(db, id)!.stage);
      if (++n === 2) throw new SttHttpError(500);
    };
    const { lines, log } = capturingLogger();
    await transcribeMeeting(id, deps(p, { lengths: [300, 300, 300], log }));
    expect(stages).toEqual(['transcribed', 'transcribed', 'transcribed']);
    expect(p.forgotten).toHaveLength(3);
    expect(getMeeting(db, id)!.stage).toBe('transcribed');
    expect(lines.some((l) => l.includes('could not be deleted'))).toBe(true);
    // The failed one stays noted, and is deleted by a later forgetPending.
    expect(forgets()).toEqual([expect.objectContaining({ meeting_id: id, provider: 'openai', attempts: 1 })]);
    expect(await forgetPending(db, meetingTranscriber(p, INR), silentLogger(), { clock })).toBe(0); // not before its next try
    expect(await forgetPending(db, meetingTranscriber(p, INR), silentLogger(), { clock: later(16 * 60_000) })).toBe(1);
    expect(forgets()).toEqual([]);
    expect(p.forgotten).toHaveLength(4);
  });

  it('the copy id is stored with the finished part, holds no transcript text, and a crash before forget is caught up later', async () => {
    prepare(1200);
    const p = new FakeProvider('elevenlabs', 36_000);
    p.script = [ok('gopniya baat', 1200)];
    let forgetStarted: () => void = () => {};
    const inForget = new Promise<void>((r) => (forgetStarted = r));
    p.forgetImpl = async () => {
      forgetStarted();
      await new Promise<void>(() => {}); // the process exits during the DELETE
    };
    void transcribeMeeting(id, deps(p));
    await inForget;
    expect(getMeeting(db, id)!.stage).toBe('transcribed');
    const stored = forgets();
    expect(stored).toHaveLength(1);
    expect(Object.keys(stored[0]!).sort()).toEqual(['attempts', 'created_at', 'id', 'meeting_id', 'next_try_at', 'provider', 'ref']);
    expect(JSON.stringify(stored)).not.toContain('gopniya');

    // The restart: forgetPending at processor start deletes it.
    const p2 = new FakeProvider('elevenlabs', 36_000);
    expect(await forgetPending(db, meetingTranscriber(p2, INR), silentLogger(), { clock: later(16 * 60_000) })).toBe(1);
    expect(p2.forgotten).toEqual([stored[0]!.ref]);
    expect(forgets()).toEqual([]);
  });

  it('forgetPending: a 404 counts as deleted; other failures are tried at most MAX_FORGET_ATTEMPTS times', async () => {
    prepare(1200);
    const p = new FakeProvider('elevenlabs', 36_000);
    p.forgetImpl = async () => {
      throw new SttNoAnswerError('timeout');
    };
    await transcribeMeeting(id, deps(p));
    const { lines, log } = capturingLogger();
    const c = manualClock(clock.now().toISOString());
    await forgetPending(db, meetingTranscriber(p, INR), log, { clock: c }); // a restart soon after does not use up a try
    expect(p.forgotten).toHaveLength(1);
    for (let k = 0; k < MAX_FORGET_ATTEMPTS + 2; k++) {
      c.advance(25 * 3_600_000);
      await forgetPending(db, meetingTranscriber(p, INR), log, { clock: c });
    }
    expect(p.forgotten).toHaveLength(MAX_FORGET_ATTEMPTS);
    expect(forgets()[0]).toMatchObject({ attempts: MAX_FORGET_ATTEMPTS });
    expect(lines.some((l) => l.includes('no more tries') && l.includes(`"meetingId":${id}`) && l.includes('"code":"timeout"'))).toBe(true);

    db.prepare('UPDATE stt_forget SET attempts = 0, next_try_at = NULL').run();
    p.forgetImpl = async () => {
      throw new SttHttpError(404);
    };
    expect(await forgetPending(db, meetingTranscriber(p, INR), silentLogger())).toBe(1);
    expect(forgets()).toEqual([]);
  });

  it('a spend write that fails after the call leaves the part inflight with nothing booked; the next run books it once', async () => {
    prepare(1200);
    const p = new FakeProvider('elevenlabs', 36_000);
    p.script = [ok('x', 1200)];
    const broken = new Error('disk I/O error');
    const record = vi.spyOn(spend, 'record').mockImplementationOnce(() => {
      throw broken;
    });
    await expect(transcribeMeeting(id, deps(p))).rejects.toBe(broken);
    record.mockRestore();
    expect(parts()[0]).toMatchObject({ state: 'inflight', booked: 'none' });
    expect(rows()).toEqual([]);
    expect(forgets()).toEqual([]); // the done write went with it

    p.script = [ok('x', 1200)];
    await transcribeMeeting(id, deps(p));
    expect(rows().map((r) => r.detail)).toEqual([`meeting ${id} part 1 (unknown, estimated)`, `meeting ${id} part 1`]);
  });

  it('a part write that fails inside the booking transaction takes the booking with it', async () => {
    prepare(1200);
    const p = new FakeProvider('openai', 36_000);
    p.script = [
      async () => {
        db.prepare("UPDATE meetings SET status = 'failed' WHERE id = ?").run(id); // the part write will be refused
        return result(said('x'), 1200);
      },
    ];
    await expect(transcribeMeeting(id, deps(p))).rejects.toThrow();
    expect(rows()).toEqual([]);
    db.prepare("UPDATE meetings SET status = 'queued' WHERE id = ?").run(id);
    expect(parts()[0]).toMatchObject({ state: 'inflight', booked: 'none' });
    expect(recoverInflightParts(db, spend, INR, silentLogger())).toBe(1);
  });

  it('a part file that is missing before the send is thrown as it is, with nothing sent or booked', async () => {
    prepare(1200);
    rmSync(audioAbs);
    const p = new FakeProvider('elevenlabs', 36_000);
    const err = await transcribeMeeting(id, deps(p)).catch((e: unknown) => e);
    expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
    expect(p.calls).toHaveLength(0);
    expect(rows()).toEqual([]);
    expect(parts()[0]).toMatchObject({ state: 'todo', booked: 'none' });
  });

  it.each([
    ['no segments', []],
    ['only blank text', said('   ')],
  ])('empty speech (%s) still advances, with the note no_speech and an empty transcript', async (_name, segments) => {
    prepare(1200);
    const p = new FakeProvider('elevenlabs', 36_000);
    p.script = [async () => result(segments as Segment[], 1200)];
    expect(await transcribeMeeting(id, deps(p))).toEqual({ parts: 1, segments: 0, note: 'no_speech' });
    const m = getMeeting(db, id)!;
    expect(m.stage).toBe('transcribed');
    expect(m.note).toBe('no_speech');
    expect(m.transcript).toEqual([]);
  });

  it('starts no new part once the stop signal has fired', async () => {
    prepare(1200);
    const p = new FakeProvider('elevenlabs', 36_000);
    const ac = new AbortController();
    const reason = new Error('stop');
    ac.abort(reason);
    await expect(transcribeMeeting(id, deps(p), ac.signal)).rejects.toBe(reason);
    expect(p.calls).toHaveLength(0);
    expect(rows()).toEqual([]);
  });

  it('logs ids, parts, provider, seconds and cost only: never the key or what was said', async () => {
    prepare(1200);
    const KEY = 'sk_test_SECRETKEY_abcdef';
    const sent: { method: string; key: string | null }[] = [];
    let failFirst = true;
    const http: HttpFetch = async (_url, init) => {
      sent.push({ method: init.method ?? 'GET', key: new Headers(init.headers).get('xi-api-key') });
      if (init.method === 'DELETE') return new Response(null, { status: 200 });
      if (failFirst) {
        failFirst = false;
        throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' });
      }
      return Response.json({
        text: 'gopniya baat',
        words: [{ text: 'gopniya', type: 'word', start: 0, end: 1, speaker_id: 'speaker_0' }, { text: 'baat', type: 'word', start: 1, end: 2, speaker_id: 'speaker_0' }],
        audio_duration_secs: 1200,
        transcription_id: 'tr1',
      });
    };
    const t = createMeetingTranscriber(parseEnv({ STT_PROVIDER: 'elevenlabs', STT_API_KEY: KEY }), { http })!;
    const { lines, log } = capturingLogger();
    await expect(transcribeMeeting(id, { ...deps(null, { log }), transcriber: t })).rejects.toBeInstanceOf(SttNoAnswerError);
    await transcribeMeeting(id, { ...deps(null, { log }), transcriber: t });
    expect(getMeeting(db, id)!.transcript!.map((s) => s.text)).toEqual(['gopniya baat']);
    expect(sent.map((s) => s.method)).toEqual(['POST', 'POST', 'DELETE']); // the provider's copy is deleted after storing
    expect(sent.every((s) => s.key === KEY)).toBe(true);
    const all = lines.join('');
    expect(lines.length).toBeGreaterThan(0);
    expect(all).toContain(`"meetingId":${id}`);
    expect(all).not.toContain('SECRETKEY');
    expect(all).not.toContain('gopniya');
    expect(all).not.toContain(dataDir.replaceAll('\\', '\\\\'));
  });
});

describe('createMeetingTranscriber', () => {
  const env = (provider: string) => parseEnv({ STT_PROVIDER: provider, STT_API_KEY: 'test-key', INR_PER_USD: '88' });

  it('is null when speech-to-text is off', () => {
    expect(createMeetingTranscriber(parseEnv({}))).toBeNull();
  });

  it('with local, needs no STT_API_KEY and builds no paid provider (meetings keep waiting until the local transcriber is wired)', () => {
    const local = parseEnv({ STT_PROVIDER: 'local', STT_LOCAL_BIN: '/opt/stt/bin/transcribe-cli', STT_LOCAL_MODEL: '/opt/stt/models/m.gguf' });
    expect(local.STT_API_KEY).toBeUndefined();
    expect(createMeetingTranscriber(local)).toBeNull();
  });

  it.each([
    ['sarvam', 7200],
    ['elevenlabs', 36_000],
    ['openai', 300],
  ] as const)('builds %s with its part length and list-price ceiling', (provider, maxPartSeconds) => {
    const t = createMeetingTranscriber(env(provider)) as MeetingTranscriber;
    expect(t.provider).toBe(provider);
    expect(t.maxPartSeconds).toBe(maxPartSeconds);
    expect(t.partCeilingUsd(3600)).toBeCloseTo(ceiling(provider, 3600), 9);
  });

  it('converts Sarvam rupees at INR_PER_USD and prices billed seconds when they are given', () => {
    const sarvam = createMeetingTranscriber(env('sarvam'))!;
    expect(sarvam.partCeilingUsd(3600)).toBeCloseTo(36 / 88, 9);
    const el = createMeetingTranscriber(env('elevenlabs'))!;
    expect(el.partCostUsd(300, 310)).toBeCloseTo((0.22 * 310) / 3600, 9);
    expect(el.partCostUsd(300, null)).toBeCloseTo((0.22 * 300) / 3600, 9);
    expect(el.partCostUsd(300, Number.NaN)).toBeCloseTo((0.22 * 300) / 3600, 9);
  });
});
