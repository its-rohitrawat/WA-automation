import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeetingProcessResult } from '../../src/meetings/processor.ts';
import { MeetingQueue } from '../../src/meetings/queue.ts';
import { localMeetingTranscriber } from '../../src/meetings/localTranscriber.ts';
import { meetingTranscriber, type MeetingTranscriber } from '../../src/meetings/transcribe.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import type { Db } from '../../src/store/db.ts';
import { addSttForget, deferMeeting, failMeeting, getMeeting, getMeetingState, insertFound, setSttParts } from '../../src/store/meetings.ts';
import { manualClock } from '../../src/util/clock.ts';
import { silentLogger } from '../../src/util/logger.ts';
import { seededDb } from '../helpers/db.ts';
import { FakeSttProvider, queuedMeeting } from '../helpers/meetingPipeline.ts';

const NOW = '2026-11-01T12:00:00.000Z';
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A processor that records its calls and waits for the test before each one ends. */
class FakeProcessor {
  readonly calls: { id: number; signal: AbortSignal; at: string }[] = [];
  readonly gates: (() => void)[] = [];
  result: (id: number) => MeetingProcessResult | Error = () => ({ outcome: 'done', clientId: 1 });
  /** What the database held when each call started (here: the stuck part's booking). */
  readonly seen: unknown[] = [];
  onCall: (id: number) => void = () => {};
  hold = true;

  async process(id: number, signal: AbortSignal): Promise<MeetingProcessResult> {
    this.calls.push({ id, signal, at: new Date().toISOString() });
    this.onCall(id);
    if (this.hold) await new Promise<void>((r) => this.gates.push(r));
    const r = this.result(id);
    if (r instanceof Error) throw r;
    return r;
  }
}

function setup(o: { meetings?: number; transcriber?: MeetingTranscriber | null } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'meet-queue-'));
  dirs.push(dataDir);
  const db = seededDb();
  const clock = manualClock(NOW);
  const spend = new SpendGuard({ db, clock, capUsd: 15 });
  const ids = Array.from({ length: o.meetings ?? 1 }, (_, i) => insertFound(db, queuedMeeting({ startedAt: `2026-11-01T0${i + 1}:00:00.000Z` }))!);
  const processor = new FakeProcessor();
  const settled: MeetingProcessResult[] = [];
  const stt = new FakeSttProvider();
  const queue = new MeetingQueue({
    db, clock, log: silentLogger(), spend, dataDir, transcriber: o.transcriber === undefined ? meetingTranscriber(stt, 88) : o.transcriber, inrPerUsd: 88, processor,
    onSettled: (r) => settled.push(r),
  });
  return { db, clock, spend, ids, processor, settled, queue, dataDir, stt };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
/** A few turns of the event loop, so a meeting that would wrongly start has had the chance to. */
const ticks = async () => {
  for (let i = 0; i < 5; i++) await flush();
};
const WAIT = { timeout: 10_000 };
const spendRows = (db: Db) => db.prepare('SELECT kind, detail FROM spend ORDER BY id').all();

describe('MeetingQueue', () => {
  it('at start books parts left in flight, deletes provider copies and cleans work files before any meeting runs', async () => {
    const { db, ids, processor, queue, dataDir, stt } = setup();
    const id = ids[0]!;
    setSttParts(db, id, [{ index: 0, provider: 'elevenlabs', file: null, offset: 0, seconds: 600, state: 'inflight', jobId: null, booked: 'none', segments: null, billedSeconds: null }], NOW);
    addSttForget(db, { meetingId: id, provider: 'elevenlabs', ref: 'tr-9', at: NOW });
    // A finished meeting's leftover video, and an unrelated file that must stay.
    const done = insertFound(db, queuedMeeting())!;
    failMeeting(db, done, { status: 'failed', errorCode: 'x', at: NOW });
    const tmp = join(dataDir, 'meetings', 'tmp');
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, `${done}.mp4.part`), 'v');
    writeFileSync(join(tmp, 'notes.txt'), 'keep');
    processor.onCall = () => processor.seen.push({ parts: getMeeting(db, id)!.sttParts[0]!.booked, spend: spendRows(db).length, forgotten: [...stt.forgotten] });

    queue.kick(); // before start: nothing runs
    await ticks();
    expect(processor.calls).toEqual([]);

    queue.start();
    await vi.waitFor(() => expect(processor.calls).toHaveLength(1), WAIT);
    expect(processor.seen).toEqual([{ parts: 'ceiling', spend: 1, forgotten: ['tr-9'] }]);
    expect(existsSync(join(tmp, `${done}.mp4.part`))).toBe(false);
    expect(existsSync(join(tmp, 'notes.txt'))).toBe(true);
    processor.gates.shift()!();
    await queue.drain(1_000);
  });

  describe('meetings waiting for speech-to-text (stt_none) after a restart with a transcriber (Task 3)', () => {
    const IN_AN_HOUR = '2026-11-01T13:00:00.000Z';
    const local = () => localMeetingTranscriber({ transcribe: async () => ({ text: 'namaste' }) }, { engine: 'voxtral', ffmpeg: null, tmpDir: tmpdir(), inrPerUsd: 88 });
    /** Meeting ids[0] waits stt_none for an hour, as the processor left it while STT_PROVIDER was none; ids[1] waits low_disk. */
    const waiting = (s: ReturnType<typeof setup>) => {
      deferMeeting(s.db, s.ids[0]!, { errorCode: 'stt_none', nextAttemptAt: IN_AN_HOUR, at: NOW, attempts: 0 });
      deferMeeting(s.db, s.ids[1]!, { errorCode: 'low_disk', nextAttemptAt: IN_AN_HOUR, at: NOW, attempts: 0 });
    };

    it.each([
      ['the local engine', local],
      ['a paid provider', () => meetingTranscriber(new FakeSttProvider(), 88)],
    ])('with %s, they are due at once at start, not an hour later; other waits are kept', async (_name, make) => {
      const s = setup({ meetings: 2, transcriber: make() });
      waiting(s);
      s.queue.start();
      await vi.waitFor(() => expect(s.processor.calls.map((c) => c.id)).toEqual([s.ids[0]]), WAIT);
      expect(getMeetingState(s.db, s.ids[0]!)).toMatchObject({ status: 'queued', attempts: 0, nextAttemptAt: NOW });
      expect(getMeetingState(s.db, s.ids[1]!)).toMatchObject({ errorCode: 'low_disk', nextAttemptAt: IN_AN_HOUR });
      s.processor.gates.shift()!();
      await s.queue.drain(1_000);
    });

    it('with no transcriber (STT_PROVIDER none, or the local engine not set up) they keep waiting their hour', async () => {
      const s = setup({ meetings: 2, transcriber: null });
      waiting(s);
      s.queue.start();
      await ticks();
      await ticks();
      expect(s.processor.calls).toEqual([]);
      expect(getMeetingState(s.db, s.ids[0]!)).toMatchObject({ errorCode: 'stt_none', nextAttemptAt: IN_AN_HOUR });
      await s.queue.drain(1_000);
    });
  });

  it('runs one meeting at a time, oldest first, and goes on to the next when one ends', async () => {
    const { ids, processor, queue, settled } = setup({ meetings: 2 });
    processor.result = (id) => ({ outcome: 'done', clientId: id });
    queue.start();
    await vi.waitFor(() => expect(processor.calls).toHaveLength(1), WAIT);
    queue.kick();
    queue.kick();
    await ticks();
    expect(processor.calls.map((c) => c.id)).toEqual([ids[0]]);
    expect(queue.active).toBe(true);
    // The fake leaves the row queued and due (as a bug would): the queue goes on to the next one, never looping on the first.
    processor.gates.shift()!();
    await vi.waitFor(() => expect(processor.calls.map((c) => c.id)).toEqual([ids[0], ids[1]]), WAIT);
    processor.gates.shift()!();
    await vi.waitFor(() => expect(settled).toHaveLength(2), WAIT);
    await ticks();
    expect(processor.calls).toHaveLength(2);
    queue.kick(); // a new kick tries the still-due meeting again, once
    await vi.waitFor(() => expect(processor.calls.map((c) => c.id)).toEqual([ids[0], ids[1], ids[0]]), WAIT);
    processor.gates.shift()!();
    expect(settled.map((s) => s.clientId)).toEqual(ids);
  });

  it('stop aborts the running meeting and starts nothing more; drain waits for it', async () => {
    const { processor, queue } = setup({ meetings: 2 });
    queue.start();
    await vi.waitFor(() => expect(processor.calls).toHaveLength(1), WAIT);
    const { signal } = processor.calls[0]!;
    expect(signal.aborted).toBe(false);
    queue.stop();
    expect(signal.aborted).toBe(true);
    let drained = false;
    const d = queue.drain(5_000).then(() => {
      drained = true;
    });
    await ticks();
    expect(drained).toBe(false);
    processor.gates.shift()!();
    await d;
    expect(processor.calls).toHaveLength(1);
    queue.kick();
    await ticks();
    expect(processor.calls).toHaveLength(1);
  });

  it('drain gives up after its time and leaves no timer', async () => {
    const { processor, queue } = setup();
    queue.start();
    await vi.waitFor(() => expect(processor.calls).toHaveLength(1), WAIT);
    vi.useFakeTimers();
    queue.stop();
    let drained = false;
    const d = queue.drain(120_000).then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(119_000);
    expect(drained).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await d;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a crashed run (the database failed) is held back, not retried on every kick', async () => {
    const { processor, queue, clock } = setup();
    processor.hold = false;
    processor.result = () => new Error('database is locked');
    queue.start();
    await vi.waitFor(() => expect(processor.calls).toHaveLength(1), WAIT);
    await flush();
    queue.kick();
    await ticks();
    expect(processor.calls).toHaveLength(1);
    clock.advance(15 * 60_000);
    processor.result = () => ({ outcome: 'done', clientId: 1 });
    queue.kick();
    await vi.waitFor(() => expect(processor.calls).toHaveLength(2), WAIT);
  });
});
