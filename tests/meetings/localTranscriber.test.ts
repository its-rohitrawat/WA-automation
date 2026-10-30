import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/config/env.ts';
import { MeetingDeferral, MeetingFailure } from '../../src/meetings/audio.ts';
import { MEETING_MAX_ATTEMPTS } from '../../src/meetings/processor.ts';
import { LOCAL_PART_MAX_TRIES } from '../../src/meetings/sttParts.ts';
import {
  createLocalMeetingTranscriber, LOCAL_MEETING_PART_SECONDS, localMeetingTranscriber, type LocalMeetingTranscriber,
} from '../../src/meetings/localTranscriber.ts';
import { bookStuckParts, meetingTranscriber, recoverInflightParts, transcribeMeeting, type TranscribeMeetingDeps } from '../../src/meetings/transcribe.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { Ffmpeg, type RunFile } from '../../src/stt/audio.ts';
import { createLocalEngine, LocalEngine, LocalEngineError, type LocalRunFile } from '../../src/stt/local.ts';
import { createVoiceTranscriber } from '../../src/stt/voice.ts';
import { costUsd, modelFor } from '../../src/stt/prices.ts';
import type { AudioPart, ProviderResult, SttProvider } from '../../src/stt/types.ts';
import type { Db } from '../../src/store/db.ts';
import { advanceStage, getMeeting, insertFound, setSttParts, type NewMeeting, type SttPartRow } from '../../src/store/meetings.ts';
import { manualClock } from '../../src/util/clock.ts';
import { createLogger, silentLogger, type Logger } from '../../src/util/logger.ts';
import { NOW, seededDb } from '../helpers/db.ts';

/*
 * Meetings on the local engine (plan 2026-10-28-meetings-local-stt.md, Task 2), with a fake ffmpeg and a fake engine
 * runner: no real binary, no network.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let seq = 0;
const newMeeting = (): NewMeeting => ({
  recording: `conferenceRecords/c1/recordings/l${++seq}`, conference: 'conferenceRecords/c1', driveFileId: 'fileAbc123', meetingCode: null,
  title: 'Sharma weekly', startedAt: '2026-10-31T20:00:00.000Z', endedAt: null, attendees: [], participants: [], clientId: 1, matchKind: 'title',
  status: 'queued', driveSeconds: null, createdAt: NOW,
});

const banner = (s: number) =>
  `  Duration: ${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}, start: 0\n`;

/**
 * ffmpeg without a program: a segment run writes one MP3 per length (recording its -segment_time); toWav writes a small
 * WAV (recording its input and signal), or, for the call numbered o.hangWavAt (from 0), runs until it is stopped;
 * volumedetect answers o.volumeDb (loud, -20 dB, by default; null: no answer); measuring answers the length a part was
 * written with.
 */
function fakeFfmpeg(lengths: number[], o: { volumeDb?: number | null; hangWavAt?: number } = {}) {
  const written = new Map<string, number>();
  const wavInputs: string[] = [];
  const wavSignals: (AbortSignal | undefined)[] = [];
  const segmentTimes: string[] = [];
  let segments = 0;
  let volumes = 0;
  let onHang: () => void = () => {};
  const wavStarted = new Promise<void>((r) => (onHang = r));
  const run: RunFile = async (_file, args, opts) => {
    const last = args[args.length - 1]!;
    if (args.includes('segment')) {
      segments++;
      segmentTimes.push(args[args.indexOf('-segment_time') + 1]!);
      lengths.forEach((s, i) => {
        const path = last.replace('%03d', String(i).padStart(3, '0'));
        writeFileSync(path, 'part');
        written.set(path, s);
      });
      return { code: 0, stderr: '' };
    }
    if (args.includes('pcm_s16le')) {
      const n = wavInputs.length;
      wavInputs.push(args[args.indexOf('-i') + 1]!);
      wavSignals.push(opts.signal);
      if (n === o.hangWavAt) {
        onHang();
        await new Promise<void>((r) => (opts.signal?.aborted ? r() : opts.signal?.addEventListener('abort', () => r(), { once: true })));
        return { code: -1, stderr: '' };
      }
      writeFileSync(last, 'wav-bytes');
      return { code: 0, stderr: '' };
    }
    if (args.includes('volumedetect')) {
      volumes++;
      const db = o.volumeDb === undefined ? -20 : o.volumeDb;
      return { code: 0, stderr: db === null ? '' : `[Parsed_volumedetect_0 @ 0000abcd] mean_volume: ${db.toFixed(1)} dB\n` };
    }
    const input = args[args.indexOf('-i') + 1]!;
    return { code: 1, stderr: banner(written.get(input) ?? 0) };
  };
  return { run, segmentRuns: () => segments, segmentTimes, wavInputs, wavSignals, volumeRuns: () => volumes, wavStarted };
}

/** One run of the fake engine: the transcript text it writes, or a way to fail. */
type Step = string | { fail: number } | { hang: true } | { wait: Promise<void>; text: string } | { sleepMs: number; text: string };

/** The engine's runner: writes each step's text to the -o file, as transcribe-cli does, and records what it was given. */
function engineRunner(steps: Step[]): { run: LocalRunFile; calls: { file: string; args: readonly string[]; timeoutMs: number; signal: AbortSignal | undefined }[]; started: Promise<void> } {
  const calls: { file: string; args: readonly string[]; timeoutMs: number; signal: AbortSignal | undefined }[] = [];
  let onStart: () => void = () => {};
  const started = new Promise<void>((r) => (onStart = r));
  const run: LocalRunFile = async (file, args, opts) => {
    calls.push({ file, args, timeoutMs: opts.timeoutMs, signal: opts.signal });
    onStart();
    const step = steps.shift() ?? 'namaste';
    // transcribe-cli writes to -o; whisper-cli to <-of>.txt.
    const out = args.includes('-of') ? `${args[args.indexOf('-of') + 1]!}.txt` : args[args.indexOf('-o') + 1]!;
    if (!args.includes('-o') && !args.includes('-of')) throw new Error('the fake engine was given no output file');
    if (typeof step === 'string') {
      writeFileSync(out, `${step}\n`);
      return { code: 0, stderr: '' };
    }
    if ('fail' in step) return { code: step.fail, stderr: 'what was said, echoed' };
    if ('hang' in step) {
      // Runs until it is stopped (an abort or the engine's own timeout).
      await new Promise<void>((r) => (opts.signal?.aborted ? r() : opts.signal?.addEventListener('abort', () => r(), { once: true })));
      return { code: -1, stderr: '' };
    }
    if ('wait' in step) await step.wait;
    else await new Promise((r) => setTimeout(r, step.sleepMs));
    writeFileSync(out, `${step.text}\n`);
    return { code: 0, stderr: '' };
  };
  return { run, calls, started };
}

function capturingLogger(): { lines: string[]; log: Logger } {
  const lines: string[] = [];
  return { lines, log: createLogger('info', new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } })) };
}

describe('the local meeting transcriber', () => {
  let dataDir: string;
  let db: Db;
  let spend: SpendGuard;
  let id: number;
  const clock = manualClock('2026-11-01T10:00:00.000Z');
  const rows = () => db.raw.prepare('SELECT kind, usd, detail FROM spend ORDER BY id').all() as { kind: string; usd: number; detail: string }[];
  const parts = async () => (await getMeeting(db, id))!.sttParts;
  const partsDir = () => join(dataDir, 'meetings', 'tmp', `${id}-parts`);
  const work = () => join(dataDir, 'tmp', 'local');
  const BIN = () => join(dataDir, 'engine', 'transcribe-cli');
  const MODEL = () => join(dataDir, 'engine', 'voxtral.gguf');
  const env = (over: Record<string, string> = {}) =>
    parseEnv({ STT_PROVIDER: 'local', STT_LOCAL_BIN: BIN(), STT_LOCAL_MODEL: MODEL(), STT_LOCAL_THREADS: '6', STT_LOCAL_TIMEOUT_SECONDS: '900', ...over });

  const prepare = async (audioSeconds: number) => {
    id = (await insertFound(db, newMeeting()))!;
    const rel = `meetings/SHA/2026-11/${id}.mp3`;
    await advanceStage(db, id, 'audio', { audioPath: rel, audioSeconds }, NOW);
    mkdirSync(join(dataDir, 'meetings', 'SHA', '2026-11'), { recursive: true });
    writeFileSync(join(dataDir, ...rel.split('/')), 'mp3-bytes');
  };
  const audioAbs = () => join(dataDir, 'meetings', 'SHA', '2026-11', `${id}.mp3`);

  /** A transcriber built from the settings, over the fakes. */
  const fromEnv = (ff: ReturnType<typeof fakeFfmpeg>, steps: Step[], over: Record<string, string> = {}) => {
    const engine = engineRunner(steps);
    const t = createLocalMeetingTranscriber(env(over), { ffmpeg: new Ffmpeg('ffmpeg.exe', ff.run), tmpDir: work(), localRun: engine.run, inrPerUsd: 88 });
    return { t, engine };
  };
  /** A transcriber over an engine with a short timeout of its own (the setting's least is a minute). */
  const withTimeout = (ff: ReturnType<typeof fakeFfmpeg>, steps: Step[], timeoutMs: number) => {
    const engine = engineRunner(steps);
    const e = new LocalEngine({ engine: 'voxtral', bin: BIN(), model: MODEL(), threads: 6, timeoutMs, language: 'hi', tmpDir: work(), run: engine.run, killGraceMs: 10 });
    const t = localMeetingTranscriber(e, { engine: 'voxtral', ffmpeg: new Ffmpeg('ffmpeg.exe', ff.run), tmpDir: work(), inrPerUsd: 88 });
    return { t, engine };
  };
  const deps = (t: LocalMeetingTranscriber | ReturnType<typeof meetingTranscriber>, ff: ReturnType<typeof fakeFfmpeg>, o: Partial<TranscribeMeetingDeps> = {}): TranscribeMeetingDeps => ({
    db, spend, transcriber: t, ffmpeg: new Ffmpeg('ffmpeg.exe', ff.run), dataDir, clock, log: silentLogger(), ...o,
  });

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'meet-local-'));
    dirs.push(dataDir);
    db = await seededDb();
    spend = new SpendGuard({ db, clock, capUsd: 5 });
  });

  it('is free and keeps no copies: provider local, ten-minute parts, a zero ceiling and cost, no forget', () => {
    const { t } = fromEnv(fakeFfmpeg([]), []);
    expect(t.provider).toBe('local');
    expect(t.maxPartSeconds).toBe(600);
    expect(LOCAL_MEETING_PART_SECONDS).toBe(600);
    expect(t.partCeilingUsd(10_800)).toBe(0);
    expect(t.partCostUsd(600, null)).toBe(0);
    expect(t.partCostUsd(600, 600)).toBe(0);
    expect(t.canForget).toBe(false);
    expect(t.inrPerUsd).toBe(88);
  });

  it('prices: local costs nothing, and modelFor names the engine', () => {
    expect(modelFor('local', true)).toMatchObject({ perHour: 0 });
    expect(modelFor('local', false)).toMatchObject({ perHour: 0 });
    expect(modelFor('local', true, 'voxtral').model).toBe('local:voxtral');
    expect(costUsd(modelFor('local', true), 10_800, 88)).toBe(0);
  });

  it('a 25-minute meeting gives 3 parts, each turned into a WAV and run on the engine, merged in order with no speaker', async () => {
    await prepare(1500);
    const ff = fakeFfmpeg([500, 500, 500]);
    const { t, engine } = fromEnv(ff, ['pehla hissa', 'doosra  hissa', 'teesra hissa']);
    expect(await transcribeMeeting(id, deps(t, ff))).toEqual({ parts: 3, segments: 3, note: null });
    expect(ff.segmentTimes).toEqual(['500.000']); // three equal parts of at most ten minutes
    expect(ff.volumeRuns()).toBe(0); // only an empty transcript is measured
    expect(ff.wavInputs).toEqual([0, 1, 2].map((n) => join(partsDir(), `part-00${n}.mp3`)));
    // Exactly the voice notes' arguments, each run on its own WAV in a work folder of its own.
    expect(engine.calls).toHaveLength(3);
    for (const c of engine.calls) {
      const wav = c.args[c.args.length - 1]!;
      expect(c.file).toBe(BIN());
      expect(c.args).toEqual(['-m', MODEL(), '--threads', '6', '-q', '-o', join(wav, '..', 'transcript.txt'), '-l', 'hi', wav]);
      expect(wav.startsWith(work())).toBe(true);
    }
    expect(new Set(engine.calls.map((c) => c.args[c.args.length - 1])).size).toBe(3);
    const m = (await getMeeting(db, id))!;
    expect(m.stage).toBe('transcribed');
    expect(m.transcript).toEqual([
      { start: 0, end: 500, speaker: null, text: 'pehla hissa' },
      { start: 500, end: 1000, speaker: null, text: 'doosra hissa' },
      { start: 1000, end: 1500, speaker: null, text: 'teesra hissa' },
    ]);
    expect(m.sttParts.map((p) => [p.index, p.provider, p.state, p.booked, p.jobId])).toEqual([
      [1, 'local', 'done', 'none', null], [2, 'local', 'done', 'none', null], [3, 'local', 'done', 'none', null],
    ]);
    // No spend rows, no hold left, no work folder or parts folder left behind.
    expect(rows()).toEqual([]);
    expect(spend.canSpend(4.99)).toBe(true);
    expect(readdirSync(work())).toEqual([]);
    expect(existsSync(partsDir())).toBe(false);
  });

  it('a 3-hour meeting becomes 18 ten-minute parts', async () => {
    await prepare(10_800);
    const ff = fakeFfmpeg(Array.from({ length: 18 }, () => 600));
    const { t, engine } = fromEnv(ff, Array.from({ length: 18 }, (_, i) => `hissa ${i + 1}`));
    expect(await transcribeMeeting(id, deps(t, ff))).toEqual({ parts: 18, segments: 18, note: null });
    expect(ff.segmentTimes).toEqual(['600.000']); // ten-minute parts
    expect(engine.calls).toHaveLength(18);
    expect((await getMeeting(db, id))!.transcript!.map((s) => s.start)).toEqual(Array.from({ length: 18 }, (_, i) => i * 600));
    expect(rows()).toEqual([]);
  });

  it('a short meeting is one part: the kept MP3 itself goes to the WAV conversion', async () => {
    await prepare(420);
    const ff = fakeFfmpeg([]);
    const { t } = fromEnv(ff, ['chhoti baat']);
    await transcribeMeeting(id, deps(t, ff));
    expect(ff.segmentRuns()).toBe(0);
    expect(ff.wavInputs).toEqual([audioAbs()]);
    expect((await getMeeting(db, id))!.transcript).toEqual([{ start: 0, end: 420, speaker: null, text: 'chhoti baat' }]);
  });

  it('each part gets its own timeout, STT_LOCAL_TIMEOUT_SECONDS, not one for the whole meeting', async () => {
    await prepare(1500);
    const ff = fakeFfmpeg([500, 500, 500]);
    const { t, engine } = fromEnv(ff, ['a', 'b', 'c'], { STT_LOCAL_TIMEOUT_SECONDS: '1200' });
    await transcribeMeeting(id, deps(t, ff));
    expect(engine.calls.map((c) => c.timeoutMs)).toEqual([1_200_000, 1_200_000, 1_200_000]);
  });

  it('three parts that together run longer than the timeout all finish: the clock starts again for each part', async () => {
    await prepare(1500);
    const ff = fakeFfmpeg([500, 500, 500]);
    const { t } = withTimeout(ff, [{ sleepMs: 120, text: 'a' }, { sleepMs: 120, text: 'b' }, { sleepMs: 120, text: 'c' }], 300);
    await transcribeMeeting(id, deps(t, ff));
    expect((await getMeeting(db, id))!.transcript!.map((s) => s.text)).toEqual(['a', 'b', 'c']);
  });

  it('a part that times out is stopped and set back to todo; the retry runs only that part and the ones after it', async () => {
    await prepare(1500);
    const ff = fakeFfmpeg([500, 500, 500]);
    const { t, engine } = withTimeout(ff, ['one', { hang: true }], 50);
    const err = await transcribeMeeting(id, deps(t, ff)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalEngineError);
    expect((err as LocalEngineError).code).toBe('timeout');
    expect(engine.calls[1]!.signal?.aborted).toBe(true); // the engine was stopped
    expect((await parts()).map((p) => [p.state, p.booked])).toEqual([['done', 'none'], ['todo', 'none'], ['todo', 'none']]);
    expect(rows()).toEqual([]);
    expect(readdirSync(work())).toEqual([]);

    const again = withTimeout(ff, ['two', 'three'], 50);
    await transcribeMeeting(id, deps(again.t, ff));
    expect(again.engine.calls).toHaveLength(2);
    expect((await getMeeting(db, id))!.transcript!.map((s) => s.text)).toEqual(['one', 'two', 'three']);
    expect(ff.segmentRuns()).toBe(1); // the finished split is reused
    expect(rows()).toEqual([]);
  });

  it('an engine failure (exit code) is thrown for the processor to retry, with the part back to todo and nothing booked', async () => {
    await prepare(420);
    const ff = fakeFfmpeg([]);
    const { t } = fromEnv(ff, [{ fail: 3 }]);
    const err = await transcribeMeeting(id, deps(t, ff)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalEngineError);
    expect((err as LocalEngineError).code).toBe('exit_3');
    expect((err as Error).message).not.toContain('echoed');
    expect((await parts())[0]).toMatchObject({ state: 'todo', booked: 'none' });
    expect(rows()).toEqual([]);
  });

  it('a crash mid-part: recovery books nothing and sets only that part to run again; done parts are kept', async () => {
    await prepare(1500);
    // The split a first run made, part 1 done and part 2 cut off by the crash.
    mkdirSync(partsDir(), { recursive: true });
    for (const n of [0, 1, 2]) writeFileSync(join(partsDir(), `part-00${n}.mp3`), 'part');
    writeFileSync(join(partsDir(), '.done'), '');
    const row = (index: number, state: SttPartRow['state'], segments: SttPartRow['segments'] = null): SttPartRow => ({
      index, provider: 'local', file: `${id}-parts/part-00${index - 1}.mp3`, offset: (index - 1) * 500, seconds: 500, state, jobId: null, booked: 'none', segments, billedSeconds: null,
    });
    await setSttParts(db, id, [row(1, 'done', [{ start: 0, end: 500, speaker: null, text: 'pehle' }]), row(2, 'inflight'), row(3, 'todo')], NOW);

    expect(await recoverInflightParts(db, spend, 88, silentLogger())).toBe(0); // nothing booked
    expect(rows()).toEqual([]);
    expect((await parts()).map((p) => p.state)).toEqual(['done', 'todo', 'todo']);

    const ff = fakeFfmpeg([500, 500, 500]);
    const { t, engine } = fromEnv(ff, ['phir se', 'aakhri']);
    await transcribeMeeting(id, deps(t, ff));
    expect(engine.calls).toHaveLength(2);
    expect(ff.wavInputs).toEqual([join(partsDir(), 'part-001.mp3'), join(partsDir(), 'part-002.mp3')]);
    expect((await getMeeting(db, id))!.transcript!.map((s) => s.text)).toEqual(['pehle', 'phir se', 'aakhri']);
    expect(rows()).toEqual([]);
  });

  it('a local part left in flight is set to run again by transcribeMeeting itself, and bookStuckParts books nothing for it', async () => {
    await prepare(420);
    await setSttParts(db, id, [{ index: 1, provider: 'local', file: null, offset: 0, seconds: 420, state: 'inflight', jobId: null, booked: 'none', segments: null, billedSeconds: null }], NOW);
    expect(await bookStuckParts(db, spend, id, { inrPerUsd: 88 })).toBe(0);
    expect((await parts())[0]).toMatchObject({ state: 'todo', booked: 'none' });
    await setSttParts(db, id, [{ ...(await parts())[0]!, state: 'inflight' }], NOW);
    const ff = fakeFfmpeg([]);
    const { t, engine } = fromEnv(ff, ['dobara']);
    await transcribeMeeting(id, deps(t, ff));
    expect(engine.calls).toHaveLength(1);
    expect(rows()).toEqual([]);
  });

  it('a stuck paid part next to a stuck local part: only the paid one is booked', async () => {
    await prepare(1200);
    await setSttParts(db, id, [
      { index: 1, provider: 'openai', file: null, offset: 0, seconds: 600, state: 'inflight', jobId: null, booked: 'none', segments: null, billedSeconds: null },
      { index: 2, provider: 'local', file: null, offset: 600, seconds: 600, state: 'inflight', jobId: null, booked: 'none', segments: null, billedSeconds: null },
    ], NOW);
    expect(await bookStuckParts(db, spend, id, { inrPerUsd: 88 })).toBe(1);
    expect(rows()).toEqual([{ kind: 'stt', usd: costUsd(modelFor('openai', true), 600, 88), detail: `meeting ${id} part 1 (unknown, estimated)` }]);
    expect((await parts()).map((p) => [p.state, p.booked])).toEqual([['unknown', 'ceiling'], ['todo', 'none']]);
  });

  it('a switch from a paid provider: a part it left in flight is booked once at its price, then transcribed again for free', async () => {
    await prepare(1200);
    await setSttParts(db, id, [{ index: 1, provider: 'elevenlabs', file: null, offset: 0, seconds: 1200, state: 'inflight', jobId: null, booked: 'none', segments: null, billedSeconds: null }], NOW);
    const ff = fakeFfmpeg([600, 600]);
    const { t, engine } = fromEnv(ff, ['ek', 'do']);
    await transcribeMeeting(id, deps(t, ff));
    expect(engine.calls).toHaveLength(2); // planned again into ten-minute parts
    expect(rows()).toEqual([{ kind: 'stt', usd: costUsd(modelFor('elevenlabs', true), 1200, 88), detail: `meeting ${id} part 1 (unknown, estimated)` }]);
    expect((await parts()).map((p) => p.provider)).toEqual(['local', 'local']);
  });

  it.each([
    ['the cap is reached (spend_cap)', () => spend.record('ai', 5.5, 'earlier today')],
    ['holds of paid calls fill the cap (spend_busy)', () => spend.reserve(4.999, 'ai')],
  ] as const)('the spend cap does not stop a local meeting: %s', async (_name, fill) => {
    fill();
    expect(spend.canSpend(0.01)).toBe(false); // a paid call would wait
    await prepare(1500);
    const ff = fakeFfmpeg([500, 500, 500]);
    const { t } = fromEnv(ff, ['a', 'b', 'c']);
    await transcribeMeeting(id, deps(t, ff));
    expect((await getMeeting(db, id))!.stage).toBe('transcribed');
    expect(rows().filter((r) => r.kind === 'stt')).toEqual([]);
  });

  it('a stop during a part stops the engine, sets the part back to todo and throws the stop; the next run re-runs that part', async () => {
    await prepare(1500);
    const ff = fakeFfmpeg([500, 500, 500]);
    const { t, engine } = fromEnv(ff, ['one', { hang: true }]);
    const ctl = new AbortController();
    const reason = new Error('stop');
    const run = transcribeMeeting(id, deps(t, ff), ctl.signal);
    await engine.started;
    await new Promise<void>((r) => {
      const tick = () => (engine.calls.length >= 2 ? r() : setTimeout(tick, 5));
      tick();
    });
    ctl.abort(reason);
    await expect(run).rejects.toBe(reason);
    expect(engine.calls[1]!.signal?.aborted).toBe(true);
    expect(ff.wavSignals.every((s) => s !== undefined)).toBe(true); // the conversion takes the stop too
    expect((await parts()).map((p) => p.state)).toEqual(['done', 'todo', 'todo']);
    expect(readdirSync(work())).toEqual([]);

    const again = fromEnv(ff, ['two', 'three']);
    await transcribeMeeting(id, deps(again.t, ff));
    expect(again.engine.calls).toHaveLength(2);
    expect((await getMeeting(db, id))!.transcript!.map((s) => s.text)).toEqual(['one', 'two', 'three']);
  });

  it('nothing heard in every silent part: the meeting advances with the note no_speech (whisper markers count as nothing)', async () => {
    await prepare(1500);
    const ff = fakeFfmpeg([500, 500, 500], { volumeDb: -91 });
    const { t } = fromEnv(ff, ['', '[BLANK_AUDIO]', ' (silence) '], { STT_LOCAL_ENGINE: 'whisper', STT_LOCAL_LANGUAGE: 'en' });
    expect(await transcribeMeeting(id, deps(t, ff))).toEqual({ parts: 3, segments: 0, note: 'no_speech' });
    expect((await getMeeting(db, id))!.transcript).toEqual([]);
    expect(ff.volumeRuns()).toBe(3);
  });

  it('a silent part with nothing heard gives no segment; the others are kept', async () => {
    await prepare(1500);
    const ff = fakeFfmpeg([500, 500, 500], { volumeDb: -91 });
    const { t } = fromEnv(ff, ['shuru', '', 'ant']);
    await transcribeMeeting(id, deps(t, ff));
    expect((await getMeeting(db, id))!.transcript).toEqual([
      { start: 0, end: 500, speaker: null, text: 'shuru' },
      { start: 1000, end: 1500, speaker: null, text: 'ant' },
    ]);
  });

  it.each([
    ['a loud part (-20 dB)', -20],
    ['a part just above the silence line (-49.9 dB)', -49.9],
    ['a part whose volume is unknown', null],
  ] as const)('an empty transcript of %s is empty_output: thrown, the part back to todo, nothing booked or lost', async (_name, volumeDb) => {
    await prepare(1500);
    const ff = fakeFfmpeg([500, 500, 500], { volumeDb });
    const { t } = fromEnv(ff, ['shuru', '']);
    const err = await transcribeMeeting(id, deps(t, ff)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalEngineError);
    expect((err as LocalEngineError).code).toBe('empty_output');
    expect((await parts()).map((p) => [p.state, p.booked])).toEqual([['done', 'none'], ['todo', 'none'], ['todo', 'none']]);
    expect((await getMeeting(db, id))!.stage).toBe('audio');
    expect(rows()).toEqual([]);
    expect(readdirSync(work())).toEqual([]);

    // The retry runs that part again; this time the engine hears it.
    const again = fromEnv(ff, ['beech', 'ant']);
    await transcribeMeeting(id, deps(again.t, ff));
    expect((await getMeeting(db, id))!.transcript!.map((s) => s.text)).toEqual(['shuru', 'beech', 'ant']);
    expect(rows()).toEqual([]);
  });

  it('whisper markers on a loud part are empty_output too, never no_speech', async () => {
    await prepare(420);
    const ff = fakeFfmpeg([], { volumeDb: -18 });
    const { t } = fromEnv(ff, ['[BLANK_AUDIO]'], { STT_LOCAL_ENGINE: 'whisper', STT_LOCAL_LANGUAGE: 'en' });
    const err = await transcribeMeeting(id, deps(t, ff)).catch((e: unknown) => e);
    expect((err as LocalEngineError).code).toBe('empty_output');
    expect((await parts())[0]).toMatchObject({ state: 'todo', booked: 'none' });
  });

  it('a stop during the WAV conversion throws the stop, sets the part back to todo and books nothing', async () => {
    await prepare(1500);
    const ff = fakeFfmpeg([500, 500, 500], { hangWavAt: 1 });
    const { t, engine } = fromEnv(ff, ['one']);
    const ctl = new AbortController();
    const reason = new Error('stop');
    const run = transcribeMeeting(id, deps(t, ff), ctl.signal);
    await ff.wavStarted;
    ctl.abort(reason);
    await expect(run).rejects.toBe(reason);
    expect(engine.calls).toHaveLength(1); // the engine never ran for the part being converted
    expect((await parts()).map((p) => [p.state, p.booked])).toEqual([['done', 'none'], ['todo', 'none'], ['todo', 'none']]);
    expect(rows()).toEqual([]);
    expect(readdirSync(work())).toEqual([]);
  });

  it('a switch from Sarvam with a job accepted and booked: not booked again, and run locally after the done paid part', async () => {
    await prepare(1200);
    mkdirSync(partsDir(), { recursive: true });
    for (const n of [0, 1]) writeFileSync(join(partsDir(), `part-00${n}.mp3`), 'part');
    writeFileSync(join(partsDir(), '.done'), '');
    const sarvam = (index: number, o: Partial<SttPartRow>): SttPartRow => ({
      index, provider: 'sarvam', file: `${id}-parts/part-00${index - 1}.mp3`, offset: (index - 1) * 600, seconds: 600,
      state: 'todo', jobId: null, booked: 'none', segments: null, billedSeconds: null, ...o,
    });
    await setSttParts(db, id, [
      sarvam(1, { state: 'done', booked: 'actual', segments: [{ start: 0, end: 600, speaker: 'A', text: 'pehle Sarvam ne suna' }], billedSeconds: 600 }),
      sarvam(2, { state: 'inflight', jobId: 'job-2', booked: 'ceiling' }),
    ], NOW);
    spend.record('stt', 0.12, `meeting ${id} part 2 (job accepted)`);
    await spend.flushed();
    const before = rows();
    expect(before).toHaveLength(1);

    const ff = fakeFfmpeg([600, 600]);
    const { t, engine } = fromEnv(ff, ['phir local ne']);
    await transcribeMeeting(id, deps(t, ff));
    expect(engine.calls).toHaveLength(1);
    expect(ff.wavInputs).toEqual([join(partsDir(), 'part-001.mp3')]);
    await spend.flushed();
    expect(rows()).toEqual(before); // nothing booked again, nothing new
    expect((await getMeeting(db, id))!.transcript).toEqual([
      { start: 0, end: 600, speaker: 'p1:A', text: 'pehle Sarvam ne suna' },
      { start: 600, end: 1200, speaker: null, text: 'phir local ne' },
    ]);
  });

  it('one engine shared with voice notes: a voice note and a meeting part run one after the other, never at once', async () => {
    await prepare(420);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const runner = engineRunner([{ wait: gate, text: 'voice note' }, 'meeting part']);
    let running = 0;
    let most = 0;
    const counted: LocalRunFile = async (file, args, opts) => {
      running++;
      most = Math.max(most, running);
      try {
        return await runner.run(file, args, opts);
      } finally {
        running--;
      }
    };
    const shared = createLocalEngine(env(), { tmpDir: join(dataDir, 'tmp'), localRun: counted, setting: 'STT_PROVIDER' });
    const ff = fakeFfmpeg([]);
    const ffmpeg = new Ffmpeg('ffmpeg.exe', ff.run);
    const voiceEnv = parseEnv({ VOICE_STT_PROVIDER: 'local', STT_LOCAL_BIN: BIN(), STT_LOCAL_MODEL: MODEL() });
    const voice = createVoiceTranscriber(voiceEnv, { ffmpeg, tmpDir: join(dataDir, 'tmp', 'voice'), localEngine: shared })!;
    const meeting = createLocalMeetingTranscriber(env(), { ffmpeg, tmpDir: work(), inrPerUsd: 88, localEngine: shared });

    // The voice note's run starts first and is held; the meeting part waits for it in the engine's line.
    mkdirSync(join(dataDir, 'tmp', 'voice', 'voice-1'), { recursive: true });
    const wav = join(dataDir, 'tmp', 'voice', 'voice-1', 'audio.wav');
    writeFileSync(wav, 'wav');
    const note = voice.transcribe({ parts: [], wav: { path: wav, meanVolumeDb: -20 }, measuredSeconds: 5, dispose: () => {} });
    await runner.started;
    const m = transcribeMeeting(id, deps(meeting, ff));
    await new Promise((r) => setTimeout(r, 30));
    expect(runner.calls).toHaveLength(1);
    release();
    expect((await note).text).toBe('voice note');
    await m;
    expect(runner.calls).toHaveLength(2);
    expect(most).toBe(1);
    expect((await getMeeting(db, id))!.transcript).toEqual([{ start: 0, end: 420, speaker: null, text: 'meeting part' }]);
  });

  it('without ffmpeg the meeting waits (no_ffmpeg), with nothing run or booked', async () => {
    await prepare(420);
    const engine = engineRunner([]);
    const t = createLocalMeetingTranscriber(env(), { ffmpeg: null, tmpDir: work(), localRun: engine.run, inrPerUsd: 88 });
    const err = await transcribeMeeting(id, deps(t, fakeFfmpeg([]))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MeetingDeferral);
    expect((err as MeetingDeferral).code).toBe('no_ffmpeg');
    expect(engine.calls).toEqual([]);
    expect((await parts())[0]).toMatchObject({ state: 'todo' });
  });

  it('work folders an earlier run left behind are removed before a new part', async () => {
    mkdirSync(join(work(), 'meeting-part-old'), { recursive: true });
    writeFileSync(join(work(), 'meeting-part-old', 'audio.wav'), 'old');
    mkdirSync(join(work(), 'voice-7'), { recursive: true }); // not a meeting's: left alone
    await prepare(420);
    const ff = fakeFfmpeg([]);
    const { t } = fromEnv(ff, ['naya']);
    await transcribeMeeting(id, deps(t, ff));
    expect(readdirSync(work())).toEqual(['voice-7']);
  });

  it('the sweep never follows a link: a junction named like a work folder is left, and so is what it points to', async () => {
    const outside = join(dataDir, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'keep.txt'), 'keep');
    mkdirSync(work(), { recursive: true });
    symlinkSync(outside, join(work(), 'meeting-part-link'), 'junction');
    writeFileSync(join(work(), 'meeting-part-file'), 'a file, not a folder');
    await prepare(420);
    const ff = fakeFfmpeg([]);
    const { t } = fromEnv(ff, ['naya']);
    await transcribeMeeting(id, deps(t, ff));
    expect(readdirSync(outside)).toEqual(['keep.txt']);
    expect(readdirSync(work()).sort()).toEqual(['meeting-part-file', 'meeting-part-link']);
  });

  it('the sweep lists nothing when the work folder itself is a link', async () => {
    const real = join(dataDir, 'real-work');
    mkdirSync(join(real, 'meeting-part-old'), { recursive: true });
    writeFileSync(join(real, 'meeting-part-old', 'audio.wav'), 'old');
    mkdirSync(join(dataDir, 'tmp'), { recursive: true });
    symlinkSync(real, work(), 'junction');
    await prepare(420);
    const ff = fakeFfmpeg([]);
    const { t } = fromEnv(ff, ['naya']);
    await transcribeMeeting(id, deps(t, ff));
    expect(readdirSync(real)).toEqual(['meeting-part-old']);
    expect((await getMeeting(db, id))!.stage).toBe('transcribed');
  });

  it('the sweep lists nothing when the folder above the work folder (DATA_DIR/tmp) is a link', async () => {
    const real = join(dataDir, 'real-tmp');
    mkdirSync(join(real, 'local', 'meeting-part-old'), { recursive: true });
    writeFileSync(join(real, 'local', 'meeting-part-old', 'audio.wav'), 'old');
    symlinkSync(real, join(dataDir, 'tmp'), 'junction');
    await prepare(420);
    const ff = fakeFfmpeg([]);
    const { t } = fromEnv(ff, ['naya']);
    await transcribeMeeting(id, deps(t, ff));
    expect(readdirSync(join(real, 'local'))).toEqual(['meeting-part-old']);
    expect((await getMeeting(db, id))!.stage).toBe('transcribed');
  });

  it('logs the meeting id, part, provider, seconds and duration only: never what was said or a path', async () => {
    await prepare(1500);
    const ff = fakeFfmpeg([500, 500, 500]);
    const { t } = withTimeout(ff, ['gopniya baat', { fail: 2 }], 60_000);
    const { lines, log } = capturingLogger();
    await expect(transcribeMeeting(id, deps(t, ff, { log }))).rejects.toBeInstanceOf(LocalEngineError);
    const again = withTimeout(ff, ['doosri gupt baat', 'teesri gupt baat'], 60_000);
    await transcribeMeeting(id, deps(again.t, ff, { log }));
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const done = parsed.filter((l) => l['msg'] === 'meeting speech part transcribed');
    expect(done).toHaveLength(3);
    for (const l of done) {
      expect(l).toMatchObject({ meetingId: id, provider: 'local', seconds: 500 });
      expect(typeof l['part']).toBe('number');
      expect(typeof l['durationMs']).toBe('number');
      expect(l['costUsd']).toBeUndefined();
    }
    expect(parsed.find((l) => l['msg'] === 'meeting speech part failed')).toMatchObject({ meetingId: id, part: 2, provider: 'local', code: 'exit_2' });
    const all = lines.join('');
    expect(all).not.toContain('gopniya');
    expect(all).not.toContain('gupt');
    expect(all).not.toContain('echoed');
    expect(all).not.toContain(dataDir.replaceAll('\\', '\\\\'));
    expect(all).not.toContain('transcribe-cli');
    expect(all).not.toContain('voxtral.gguf');
  });

  it('paid providers are unchanged: a paid transcriber is never given the stop signal', async () => {
    await prepare(420);
    const seen: unknown[] = [];
    const provider: SttProvider = {
      id: 'openai',
      maxPartSeconds: 300 * 10,
      async transcribe(_a: AudioPart, opts): Promise<ProviderResult> {
        seen.push(opts);
        return { model: 'm', segments: [{ start: 0, end: 1, speaker: 'A', text: 'x' }], billedSeconds: 420, raw: {} };
      },
    };
    const ff = fakeFfmpeg([]);
    await transcribeMeeting(id, deps(meetingTranscriber(provider, 88), ff), new AbortController().signal);
    expect(seen).toEqual([{ diarize: true }]);
    expect(rows()).toHaveLength(1);
  });

  describe('parts the engine cannot hear (review fixes 1 and 2)', () => {
    const attemptsOf = () => (db.raw.prepare('SELECT attempts FROM meetings WHERE id = ?').get(id) as { attempts: number }).attempts;
    const setAttempts = (n: number) => db.raw.prepare('UPDATE meetings SET attempts = ? WHERE id = ?').run(n, id);
    /** One run of the stage over a fresh fake engine; what it threw, or its result. */
    const runWith = async (ff: ReturnType<typeof fakeFfmpeg>, steps: Step[], timeoutMs?: number) => {
      const { t } = timeoutMs === undefined ? fromEnv(ff, steps) : withTimeout(ff, steps, timeoutMs);
      return transcribeMeeting(id, deps(t, ff)).catch((e: unknown) => e);
    };
    /** The first LOCAL_PART_MAX_TRIES - 1 tries of a part, each failing with `step`. */
    const failTries = async (ff: ReturnType<typeof fakeFfmpeg>, first: Step[], step: Step, timeoutMs?: number) => {
      for (let n = 1; n < LOCAL_PART_MAX_TRIES; n++) await runWith(ff, n === 1 ? [...first, step] : [step], timeoutMs);
    };

    it('a part gets as many tries as a meeting stage has attempts', () => {
      expect(LOCAL_PART_MAX_TRIES).toBe(MEETING_MAX_ATTEMPTS);
    });

    it('a loud part the engine never hears is given up on its last try: done with no text, noted, and the meeting goes on', async () => {
      await prepare(1500);
      const ff = fakeFfmpeg([500, 500, 500]);
      for (const [n, steps] of [[1, ['shuru', '']], [2, ['']], [3, ['']]] as const) {
        expect(((await runWith(ff, [...steps])) as LocalEngineError).code).toBe('empty_output');
        expect((await parts())[1]).toMatchObject({ state: 'todo', booked: 'none', tries: n });
      }
      expect(await runWith(ff, ['', 'ant'])).toEqual({ parts: 3, segments: 2, note: 'unheard_parts' });
      const m = (await getMeeting(db, id))!;
      expect(m.stage).toBe('transcribed');
      expect(m.note).toBe('unheard_parts');
      expect(m.transcript!.map((s) => s.text)).toEqual(['shuru', 'ant']);
      expect(m.sttParts[1]).toMatchObject({ state: 'done', booked: 'none', segments: [], unheard: true, tries: LOCAL_PART_MAX_TRIES });
      expect(m.sttParts[0]!.unheard).toBeUndefined();
      expect(m.sttParts[2]!.unheard).toBeUndefined();
      expect(rows()).toEqual([]);
    });

    it('timeouts and exit codes on the same part count together, and give it up the same way once a part was heard', async () => {
      await prepare(1500);
      const ff = fakeFfmpeg([500, 500, 500]);
      expect(((await runWith(ff, ['shuru', { hang: true }], 50)) as LocalEngineError).code).toBe('timeout');
      expect(((await runWith(ff, [{ fail: 3 }], 50)) as LocalEngineError).code).toBe('exit_3');
      expect(((await runWith(ff, [{ hang: true }], 50)) as LocalEngineError).code).toBe('timeout');
      expect((await parts())[1]).toMatchObject({ state: 'todo', tries: 3 });
      expect(await runWith(ff, [{ fail: 3 }, 'ant'], 50)).toEqual({ parts: 3, segments: 2, note: 'unheard_parts' });
      expect((await parts())[1]).toMatchObject({ state: 'done', segments: [], unheard: true });
    });

    it('loud audio with no words before anything was heard is given up too: it is not taken for a broken engine', async () => {
      await prepare(1500);
      const ff = fakeFfmpeg([500, 500, 500]);
      await failTries(ff, [], '');
      expect(await runWith(ff, ['', 'beech', 'ant'])).toEqual({ parts: 3, segments: 2, note: 'unheard_parts' });
      expect((await parts()).map((p) => p.unheard ?? false)).toEqual([true, false, false]);
    });

    it.each([
      ['an exit code', { fail: 139 } as Step],
      ['a timeout', { hang: true } as Step],
    ] as const)('%s on every try of the first part, with nothing heard yet, fails the meeting (local_engine_failed), the part ready to run again', async (_name, step) => {
      await prepare(1500);
      const ff = fakeFfmpeg([500, 500, 500]);
      await failTries(ff, [], step, 50);
      expect((await parts())[0]).toMatchObject({ state: 'todo', tries: LOCAL_PART_MAX_TRIES - 1 });
      const err = await runWith(ff, [step], 50);
      expect(err).toBeInstanceOf(MeetingFailure);
      expect(err).toMatchObject({ status: 'failed', code: 'local_engine_failed' });
      // A `meeting retry` once the engine is fixed starts the part's tries again.
      expect((await parts())[0]).toMatchObject({ state: 'todo', booked: 'none', segments: null });
      expect((await parts())[0]!.tries).toBeUndefined();
      expect((await parts()).some((p) => p.unheard)).toBe(false);
      expect((await getMeeting(db, id))!.stage).toBe('audio');
      expect(rows()).toEqual([]);
    });

    it('a meeting where nothing is heard but a part was given up fails (nothing_heard), its parts ready to run again', async () => {
      await prepare(420);
      const ff = fakeFfmpeg([]);
      await failTries(ff, [], '');
      const err = await runWith(ff, ['']);
      expect(err).toBeInstanceOf(MeetingFailure);
      expect(err).toMatchObject({ status: 'failed', code: 'nothing_heard' });
      expect((await parts())[0]).toMatchObject({ state: 'todo', booked: 'none', segments: null });
      expect((await parts())[0]!.tries).toBeUndefined();
      expect((await parts())[0]!.unheard).toBeUndefined();
      expect((await getMeeting(db, id))!.stage).toBe('audio');
    });

    it('silent parts and a given-up part with nothing else heard also fail as nothing_heard, never no_speech', async () => {
      await prepare(1500);
      // Parts 1 and 2 silent (done, no segment); part 3 fails its first try, then is loud with no words.
      const sil = fakeFfmpeg([500, 500, 500], { volumeDb: -91 });
      await runWith(sil, ['', '', { fail: 1 }]);
      expect((await parts()).map((p) => [p.state, p.tries])).toEqual([['done', undefined], ['done', undefined], ['todo', 1]]);
      const ff = fakeFfmpeg([500, 500, 500]);
      for (let n = 2; n < LOCAL_PART_MAX_TRIES; n++) await runWith(ff, ['']);
      expect(await runWith(ff, [''])).toMatchObject({ code: 'nothing_heard' });
      expect((await parts()).map((p) => p.state)).toEqual(['done', 'done', 'todo']);
    });

    it('a stop or a crash is not a try of the part', async () => {
      await prepare(1500);
      const ff = fakeFfmpeg([500, 500, 500]);
      await runWith(ff, ['shuru', '']);
      expect((await parts())[1]).toMatchObject({ state: 'todo', tries: 1 });
      const { t, engine } = fromEnv(ff, [{ hang: true }]);
      const ctl = new AbortController();
      const run = transcribeMeeting(id, deps(t, ff), ctl.signal);
      await engine.started;
      ctl.abort(new Error('stop'));
      await run.catch(() => undefined);
      expect((await parts())[1]).toMatchObject({ state: 'todo', tries: 1 });
      await setSttParts(db, id, (await parts()).map((p, i) => (i === 1 ? { ...p, state: 'inflight' } : p)), NOW);
      expect(await bookStuckParts(db, spend, id, { inrPerUsd: 88 })).toBe(0);
      expect((await parts())[1]).toMatchObject({ state: 'todo', tries: 1 });
    });

    it('a finished part resets the meeting attempts to the run in hand, so failures spread over many parts never add up', async () => {
      await prepare(1500);
      const ff = fakeFfmpeg([500, 500, 500]);
      setAttempts(3);
      await runWith(ff, ['shuru', '']);
      expect(attemptsOf()).toBe(1);
      setAttempts(3);
      await runWith(ff, ['']); // part 2's 2nd try; no part finished: nothing reset
      expect(attemptsOf()).toBe(3);
      await runWith(ff, ['']); // its 3rd try
      expect((await parts())[1]).toMatchObject({ state: 'todo', tries: 3 });
      await runWith(ff, ['', { fail: 1 }]); // its last try gives it up (a finished part), then part 3 fails
      expect((await parts())[1]).toMatchObject({ state: 'done', unheard: true });
      expect(attemptsOf()).toBe(1);
    });

    it('a switch to a paid provider sends the parts left to do with their tries cleared', async () => {
      await prepare(1500);
      const ff = fakeFfmpeg([500, 500, 500]);
      await runWith(ff, ['shuru', '']);
      const provider: SttProvider = {
        id: 'openai',
        maxPartSeconds: 3000,
        async transcribe(): Promise<ProviderResult> {
          return { model: 'm', segments: [{ start: 0, end: 1, speaker: 'A', text: 'x' }], billedSeconds: 500, raw: {} };
        },
      };
      await transcribeMeeting(id, deps(meetingTranscriber(provider, 88), ff));
      expect((await parts()).map((p) => [p.provider, p.tries, p.unheard])).toEqual([['local', undefined, undefined], ['openai', undefined, undefined], ['openai', undefined, undefined]]);
    });

    it('the log line for a part given up has its number and code only', async () => {
      await prepare(1500);
      const ff = fakeFfmpeg([500, 500, 500]);
      await failTries(ff, ['shuru'], '');
      const { lines, log } = capturingLogger();
      const { t } = fromEnv(ff, ['']);
      await transcribeMeeting(id, deps(t, ff, { log })).catch(() => undefined);
      const out = lines.join('');
      expect(out).toContain('meeting speech part given up');
      expect(out).toContain('"code":"empty_output"');
      expect(out).not.toContain(dataDir);
    });
  });
});
