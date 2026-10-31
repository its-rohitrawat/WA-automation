import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type AppMeetingsDeps } from '../src/app.ts';
import type { MeetingsHealth } from '../src/meetings/healthTypes.ts';
import { MEETING_STT_PROBLEM_LINES } from '../src/health/health.ts';
import { localMeetingTranscriber } from '../src/meetings/localTranscriber.ts';
import { meetingTranscriber, type MeetingTranscriber } from '../src/meetings/transcribe.ts';
import { MEETING_SCOPES, saveGrantedScopes } from '../src/output/googleAuth.ts';
import type { Prices } from '../src/spend/pricing.ts';
import type { Db } from '../src/store/db.ts';
import { getKv } from '../src/store/kv.ts';
import { deferMeeting, getMeeting, insertFound } from '../src/store/meetings.ts';
import { listTasks } from '../src/store/tasks.ts';
import { Ffmpeg } from '../src/stt/audio.ts';
import { systemClock } from '../src/util/clock.ts';
import { silentLogger } from '../src/util/logger.ts';
import { AllowList } from '../src/wa/allowlist.ts';
import { openSessionDb, useEncryptedAuthState } from '../src/wa/authState.ts';
import { WhatsAppGateway } from '../src/wa/gateway.ts';
import { FakeAi, op } from './helpers/ai.ts';
import { idOf, MEHTA, seededDb, SHARMA } from './helpers/db.ts';
import { FakeDrive } from './helpers/fakeDrive.ts';
import { FakeMeetingsApi } from './helpers/fakeMeetings.ts';
import { FakeSocket } from './helpers/fakeSocket.ts';
import { addRecordingFile, fakeFfmpeg, FakeMeetingAi, FakeSttProvider, FILE_ID, queuedMeeting, STARTED } from './helpers/meetingPipeline.ts';
import { rawOf } from '../src/store/engine/sqlite.ts';

const P: Prices = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 };
const MINUTE = 60_000;
/** For a wait on real work (file I/O, building the workbook): the default 1 s is tight while the whole suite runs. */
const SLOW_IO = { timeout: 10_000 };
const dirs: string[] = [];

interface SetupOptions {
  /** false: MEETINGS_ENABLED off, no meeting dependency at all. */
  meetings?: boolean;
  /** false: the stored sign-in has no meeting scopes. */
  scopes?: boolean;
  drainMs?: number;
  prepare?: (db: Db) => unknown;
  stt?: FakeSttProvider;
  /** Replaces the paid fake transcriber (null: none), built with the test's data folder. */
  transcriber?: (dataDir: string) => MeetingTranscriber | null;
  sttProblem?: AppMeetingsDeps['sttProblem'];
}

/** One finished Sharma recording in Meet, with its invite. */
function addConference(api: FakeMeetingsApi): void {
  api.conferences.push({ name: 'conferenceRecords/c1', space: 'spaces/s1', startTime: STARTED, endTime: '2026-11-01T10:45:00.000Z' });
  api.recordings.set('conferenceRecords/c1', [
    { name: 'conferenceRecords/c1/recordings/r1', state: 'FILE_GENERATED', driveFileId: FILE_ID, startTime: STARTED, endTime: '2026-11-01T10:45:00.000Z' },
  ]);
  api.codes.set('spaces/s1', 'abc-defg-hij');
  api.invites.set('abc-defg-hij', {
    title: 'Sharma Interiors weekly',
    attendees: [{ email: 'owner@studio.example', name: 'Owner', self: true }, { email: 'asha@sharma.example', name: 'Asha Verma', self: false }],
  });
  addRecordingFile(api);
}

async function setup(o: SetupOptions = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'wa-app-meet-'));
  dirs.push(dataDir);
  const ai = new FakeAi([{ ops: [op({ op: 'add_task', side: 'client', title: 'Send the logo files', category: 'content', priority: 'medium', sourceMessageIds: ['mtg1-a1'] })] }]);
  const drive = new FakeDrive();
  const db = await seededDb();
  if (o.scopes !== false) await saveGrantedScopes(db, [...MEETING_SCOPES, 'https://www.googleapis.com/auth/drive.file'].join(' '));
  await o.prepare?.(db);
  const api = new FakeMeetingsApi();
  addConference(api);
  const stt = o.stt ?? new FakeSttProvider();
  const meetingAi = new FakeMeetingAi();
  const ff = fakeFfmpeg();
  const health: (MeetingsHealth | null)[] = [];
  const allow = new AllowList([SHARMA.groupId, MEHTA.groupId]);
  const sockets: FakeSocket[] = [];
  const auth = await useEncryptedAuthState(openSessionDb(':memory:'), randomBytes(32));
  const gateway = new WhatsAppGateway({
    allow,
    factory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    auth: auth.state,
    saveCreds: auth.saveCreds,
  });
  const meetings: AppMeetingsDeps | undefined =
    o.meetings === false
      ? undefined
      : {
          api, ai: meetingAi, transcriber: o.transcriber ? o.transcriber(dataDir) : meetingTranscriber(stt, 88), ffmpeg: new Ffmpeg('ffmpeg.exe', ff.run),
          ...(o.sttProblem !== undefined ? { sttProblem: o.sttProblem } : {}),
          settings: { teamDomains: ['studio.example'], pollMinutes: 5, maxMinutes: 180, since: '2026-11-01', inrPerUsd: 88 },
          clients: [SHARMA, MEHTA],
        };
  const app = await createApp({
    db, clock: systemClock, log: silentLogger(), gateway, allow, ai, drive, prices: P, spendCapUsd: 15,
    quietMs: 240_000, maxWaitMs: 1_200_000, maxConcurrent: 3, dataDir, freeBytes: () => 500e9, pollMs: 30_000, drainMs: o.drainMs,
    ...(meetings ? { meetings } : {}),
    onMeetingsHealth: (m) => health.push(m),
  });
  app.start();
  sockets[0]!.emit('connection.update', { connection: 'open' });
  return { db, ai, drive, app, api, stt, meetingAi, ff, health, dataDir };
}

/** stop() ends with a final upload whose workbook build runs on (fake) timers: advance until it resolves. */
async function stopApp(app: { stop(): Promise<void> }): Promise<void> {
  let done = false;
  const p = app.stop().then(() => {
    done = true;
  });
  for (let i = 0; i < 200 && !done; i++) await vi.advanceTimersByTimeAsync(1_000);
  await p;
}

/** The meeting's status at each publisher.schedule() call (a rebuild request). */
function watchSchedules(app: Awaited<ReturnType<typeof setup>>['app'], db: Db): (string | undefined)[] {
  const seen: (string | undefined)[] = [];
  const schedule = app.publisher.schedule.bind(app.publisher);
  vi.spyOn(app.publisher, 'schedule').mockImplementation(async () => {
    seen.push((await getMeeting(db, 1))?.status);
    schedule();
  });
  return seen;
}

const spendRows = (db: Db) => db.all<{ kind: string; detail: string }>('SELECT kind, detail FROM spend ORDER BY id');

describe('app with meetings', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('meetings off: no meeting call of any kind, and Health is told null', async () => {
    const { app, api, health, db } = await setup({ meetings: false });
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(api.calls).toEqual([]);
    expect(app.meetings).toBeUndefined();
    expect(health.length).toBeGreaterThan(1);
    expect(health.every((h) => h === null)).toBe(true);
    expect(await getKv(db, 'meetings_since')).toBeUndefined();
    await stopApp(app);
  });

  it('without the meeting scopes: paused google_scopes, and no Google meeting call even for a queued meeting', async () => {
    const { app, api, health, db } = await setup({ scopes: false, prepare: async (d) => insertFound(d, queuedMeeting({ clientId: await idOf(d, 'SHA') })) });
    await vi.waitFor(async () => expect((await getMeeting(db, 1))?.errorCode).toBe('google_scopes'), SLOW_IO);
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(api.calls).toEqual([]);
    expect(health.at(-1)).toMatchObject({ paused: 'google_scopes', sttProvider: 'elevenlabs', stats: { waiting: 1 } });
    await stopApp(app);
  });

  it('without the meeting scopes the health line shows the meeting access warning', async () => {
    const { app } = await setup({ scopes: false });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(app.health.line().text).toContain('Meetings paused: Google sign-in needs meeting access');
    await stopApp(app);
  });

  it('finds a recording, takes it to done, updates the tracker and republishes the workbook', async () => {
    const { app, api, db, drive, stt, meetingAi, ai, health } = await setup();
    const statusAtSchedule = watchSchedules(app, db);
    // The first Doc may wait for the publisher's first upload to make the WA Agent folder (drive_root, 5 minutes).
    await vi.waitFor(async () => expect(['summarised', 'tracked']).toContain((await getMeeting(db, 1))?.stage), SLOW_IO);
    await vi.advanceTimersByTimeAsync(6 * MINUTE); // past the wait and the next tick
    await vi.waitFor(async () => expect((await getMeeting(db, 1))?.status).toBe('done'), SLOW_IO);
    const m = (await getMeeting(db, 1))!;
    expect(m).toMatchObject({ clientId: 1, matchKind: 'title', stage: 'tracked', title: 'Sharma Interiors weekly' });
    expect(api.callsOf('download')).toHaveLength(1);
    expect(stt.calls).toHaveLength(1);
    expect(meetingAi.calls).toHaveLength(1);
    expect(drive.docs).toHaveLength(1);
    expect(m.docFileId).toBe(drive.docs[0]!.id);
    expect(ai.calls).toHaveLength(1); // the tracker step
    expect((await listTasks(db, 1)).map((t) => [t.title, t.origin])).toEqual([['Send the logo files', 'meeting']]);
    expect((await spendRows(db)).map((s) => s.kind)).toEqual(['stt', 'ai', 'ai']);

    // The finished meeting asks for a rebuild.
    expect(statusAtSchedule).toContain('done');
    await vi.waitFor(() => expect(health.at(-1)).toMatchObject({ paused: null, stats: { done: 1, waiting: 0 } }), SLOW_IO);

    // A later discovery pass stores nothing twice.
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(api.callsOf('listConferences').length).toBeGreaterThan(1);
    expect(rawOf(db).prepare('SELECT COUNT(*) AS n FROM meetings').get()).toEqual({ n: 1 });
    await stopApp(app);
  });

  it.each([
    ['with action items (the tracker step asks)', false],
    ['with nothing said (only the meeting service asks)', true],
  ])('a finished meeting’s rebuild carries the meeting counts of now, not those of the last tick: %s', async (_name, silent) => {
    const stt = new FakeSttProvider();
    if (silent) stt.transcribe = async () => ({ model: 'scribe', segments: [], billedSeconds: null, raw: {} });
    const { app, db } = await setup({ stt });
    // At each rebuild request: the meeting's status, and the done count the workbook's health would be built with.
    const seen: { status: string | undefined; done: number | undefined }[] = [];
    const schedule = app.publisher.schedule.bind(app.publisher);
    vi.spyOn(app.publisher, 'schedule').mockImplementation(async () => {
      seen.push({ status: (await getMeeting(db, 1))?.status, done: app.health.snapshot().meetings?.stats.done });
      schedule();
    });
    await vi.waitFor(async () => expect(['summarised', 'tracked']).toContain((await getMeeting(db, 1))?.stage), SLOW_IO);
    await vi.advanceTimersByTimeAsync(6 * MINUTE);
    await vi.waitFor(async () => expect((await getMeeting(db, 1))?.status).toBe('done'), SLOW_IO);
    // Every request after the finish (the tracker step's, the service's) comes before any tick could refresh the counts.
    const afterDone = seen.filter((x) => x.status === 'done');
    expect(afterDone.length).toBeGreaterThanOrEqual(1);
    expect(afterDone.every((x) => x.done === 1)).toBe(true);
    await stopApp(app);
  });

  it('a meeting with nothing said is done without a tracker call, and still asks for a rebuild', async () => {
    const stt = new FakeSttProvider();
    stt.transcribe = async () => ({ model: 'scribe', segments: [], billedSeconds: null, raw: {} });
    const { app, db, ai, meetingAi, drive } = await setup({ stt });
    const statusAtSchedule = watchSchedules(app, db);
    await vi.waitFor(async () => expect(['summarised', 'tracked']).toContain((await getMeeting(db, 1))?.stage), SLOW_IO);
    await vi.advanceTimersByTimeAsync(6 * MINUTE);
    await vi.waitFor(async () => expect(await getMeeting(db, 1)).toMatchObject({ status: 'done', note: 'no_speech' }), SLOW_IO);
    expect(ai.calls).toEqual([]);
    expect(meetingAi.calls).toEqual([]);
    expect(drive.docs).toHaveLength(1);
    expect(statusAtSchedule).toContain('done');
    await stopApp(app);
  });

  it('discovery runs at most every MEETING_POLL_MINUTES', async () => {
    const { app, api } = await setup();
    await vi.waitFor(() => expect(api.callsOf('listConferences')).toHaveLength(1), SLOW_IO);
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(api.callsOf('listConferences')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(MINUTE + 30_000);
    expect(api.callsOf('listConferences')).toHaveLength(2);
    await stopApp(app);
  });

  it('stop aborts a download: stop returns well inside the drain and the meeting stays queued, due at the next start', async () => {
    const { app, api, db } = await setup({ drainMs: 600_000 });
    const videoInfo = api.videoInfo.bind(api);
    api.videoInfo = async (fileId, s) => {
      const r = await videoInfo(fileId, s);
      // Discovery asks first; the processor's ask comes just before the download, which then hangs.
      if (api.callsOf('videoInfo').length === 2) api.gate = new Promise<void>(() => {});
      return r;
    };
    await vi.waitFor(() => expect(api.callsOf('download')).toHaveLength(1), SLOW_IO);
    // Stop finishes within advances adding up to 60 s, far under the 600 s drain: the download was aborted.
    let done = false;
    const stop = app.stop().then(() => {
      done = true;
    });
    for (let i = 0; i < 60 && !done; i++) await vi.advanceTimersByTimeAsync(1_000);
    expect(done).toBe(true);
    await stop;
    expect(await getMeeting(db, 1)).toMatchObject({ status: 'queued', stage: 'found', errorCode: 'stopped', attempts: 0 });
    expect(await spendRows(db)).toEqual([]);
  });

  it('stop lets a speech call finish within the drain and stores it, starting no further stage', async () => {
    const stt = new FakeSttProvider();
    let release!: () => void;
    stt.gate = new Promise<void>((r) => (release = r));
    const { app, db, meetingAi } = await setup({ stt });
    await vi.waitFor(() => expect(stt.calls).toHaveLength(1), SLOW_IO);
    let done = false;
    const stop = app.stop().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(done).toBe(false); // the drain waits for the speech call
    release();
    for (let i = 0; i < 200 && !done; i++) await vi.advanceTimersByTimeAsync(1_000);
    await stop;
    expect((await getMeeting(db, 1))?.stage).toBe('transcribed');
    expect((await spendRows(db)).map((s) => s.kind)).toEqual(['stt']);
    expect(meetingAi.calls).toEqual([]);
  });

  it('a speech call still running when the drain ends is booked at its ceiling before the database closes', async () => {
    const stt = new FakeSttProvider();
    stt.gate = new Promise<void>(() => {});
    const { app, db } = await setup({ stt, drainMs: 20_000 });
    await vi.waitFor(() => expect(stt.calls).toHaveLength(1), SLOW_IO);
    await stopApp(app);
    expect(await spendRows(db)).toEqual([expect.objectContaining({ kind: 'stt' })]);
    expect((await getMeeting(db, 1))?.sttParts[0]).toMatchObject({ booked: 'ceiling' });
  });

  describe('STT_PROVIDER=local (plan 2026-10-28-meetings-local-stt.md, Task 3)', () => {
    /** The local transcriber on a fake engine (each ten-minute part says something new) and a fake WAV conversion. */
    const local = (said: { n: number }) => (dataDir: string) =>
      localMeetingTranscriber(
        { transcribe: async () => ({ text: `part ${++said.n}: logo files kal tak bhej dijiye` }) },
        {
          engine: 'voxtral', inrPerUsd: 88, tmpDir: join(dataDir, 'tmp', 'meetings-local'),
          ffmpeg: new Ffmpeg('ffmpeg.exe', async (_file, args) => {
            writeFileSync(args[args.length - 1]!, 'wav-bytes');
            return { code: 0, stderr: '' };
          }),
        },
      );
    /** The recording discovery finds, already stored and waiting for speech-to-text for another hour (STT_PROVIDER was none). */
    const waitingForStt = async (db: Db) => {
      const id = (await insertFound(db, queuedMeeting({ clientId: await idOf(db, 'SHA'), recording: 'conferenceRecords/c1/recordings/r1', title: 'Sharma Interiors weekly' })))!;
      await deferMeeting(db, id, { errorCode: 'stt_none', nextAttemptAt: '2026-11-01T13:00:00.000Z', at: '2026-11-01T12:00:00.000Z', attempts: 0 });
    };

    it('a meeting waiting with stt_none is processed after the restart, not an hour later: free, speaker-less lines to Claude and the Doc', async () => {
      const said = { n: 0 };
      const { app, db, meetingAi, drive, health } = await setup({ prepare: waitingForStt, transcriber: local(said) });
      await vi.waitFor(async () => expect(['summarised', 'tracked']).toContain((await getMeeting(db, 1))?.stage), SLOW_IO);
      await vi.advanceTimersByTimeAsync(6 * MINUTE); // past the Doc's wait for the WA Agent folder
      await vi.waitFor(async () => expect((await getMeeting(db, 1))?.status).toBe('done'), SLOW_IO);
      expect(Date.now()).toBeLessThan(Date.parse('2026-11-01T13:00:00.000Z'));
      expect(rawOf(db).prepare('SELECT COUNT(*) AS n FROM meetings').get()).toEqual({ n: 1 });

      // 45 minutes in five ten-minute-or-less parts, no speech spend: only the summary and the tracker step are booked.
      const m = (await getMeeting(db, 1))!;
      expect(said.n).toBe(5);
      expect(m.sttParts.map((p) => [p.provider, p.booked])).toEqual(Array.from({ length: 5 }, () => ['local', 'none']));
      expect(m.transcript!.map((x) => [x.start, x.speaker])).toEqual([[0, null], [540, null], [1080, null], [1620, null], [2160, null]]);
      expect((await spendRows(db)).map((r) => r.kind)).toEqual(['ai', 'ai']);

      // Claude gets plain lines with times and the "Speaker" label for unlabelled speech: never null or undefined.
      const user = meetingAi.calls[0]!.user;
      const lines = user.slice(user.indexOf('<transcript>\n') + 13, user.indexOf('\n</transcript>')).split('\n');
      expect(lines).toEqual([
        '[s1 0:00] Speaker: part 1: logo files kal tak bhej dijiye',
        '[s2 9:00] Speaker: part 2: logo files kal tak bhej dijiye',
        '[s3 18:00] Speaker: part 3: logo files kal tak bhej dijiye',
        '[s4 27:00] Speaker: part 4: logo files kal tak bhej dijiye',
        '[s5 36:00] Speaker: part 5: logo files kal tak bhej dijiye',
      ]);
      expect(user).not.toMatch(/\bnull\b|\bundefined\b/i);
      // The Doc's transcript too.
      const html = drive.docs[0]!.html;
      expect(html).toContain('<p>9:00 Speaker: part 2: logo files kal tak bhej dijiye</p>');
      expect(html).not.toMatch(/\bnull\b|\bundefined\b/i);

      await vi.waitFor(() => expect(health.at(-1)).toMatchObject({ sttProvider: 'local', stats: { done: 1 } }), SLOW_IO);
      expect(health.at(-1)!.sttProblem).toBeUndefined();
      await stopApp(app);
    });

    it('the local engine not set up: meetings wait (stt_none), and Health says the local speech engine is not set up', async () => {
      const { app, db, health } = await setup({ transcriber: () => null, sttProblem: 'local_not_set_up_model' });
      await vi.waitFor(async () => expect(await getMeeting(db, 1)).toMatchObject({ status: 'queued', errorCode: 'stt_none' }), SLOW_IO);
      await vi.waitFor(() => expect(health.at(-1)).toMatchObject({ sttProvider: 'local', sttProblem: 'local_not_set_up_model' }), SLOW_IO);
      expect(app.health.line()).toEqual({ ok: false, text: MEETING_STT_PROBLEM_LINES.local_not_set_up_model });
      expect(await spendRows(db)).toEqual([]);
      await stopApp(app);
    });
  });

  it('reloadClients passes the new configs to the watcher', async () => {
    const { app } = await setup();
    const setClients = vi.spyOn(app.meetings!, 'setClients');
    const next = [{ ...SHARMA, meetingKeywords: ['interiors weekly'] }, MEHTA];
    await app.reloadClients(next);
    expect(setClients).toHaveBeenCalledWith(next);
    await stopApp(app);
  });
});
