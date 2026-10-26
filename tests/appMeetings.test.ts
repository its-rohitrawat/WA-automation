import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type AppMeetingsDeps } from '../src/app.ts';
import type { MeetingsHealth } from '../src/meetings/healthTypes.ts';
import { meetingTranscriber } from '../src/meetings/transcribe.ts';
import { MEETING_SCOPES, saveGrantedScopes } from '../src/output/googleAuth.ts';
import type { Prices } from '../src/spend/pricing.ts';
import type { Db } from '../src/store/db.ts';
import { getKv } from '../src/store/kv.ts';
import { getMeeting, insertFound } from '../src/store/meetings.ts';
import { listTasks } from '../src/store/tasks.ts';
import { Ffmpeg } from '../src/stt/audio.ts';
import { systemClock } from '../src/util/clock.ts';
import { silentLogger } from '../src/util/logger.ts';
import { AllowList } from '../src/wa/allowlist.ts';
import { openSessionDb, useEncryptedAuthState } from '../src/wa/authState.ts';
import { WhatsAppGateway } from '../src/wa/gateway.ts';
import { FakeAi, op } from './helpers/ai.ts';
import { MEHTA, seededDb, SHARMA } from './helpers/db.ts';
import { FakeDrive } from './helpers/fakeDrive.ts';
import { FakeMeetingsApi } from './helpers/fakeMeetings.ts';
import { FakeSocket } from './helpers/fakeSocket.ts';
import { addRecordingFile, fakeFfmpeg, FakeMeetingAi, FakeSttProvider, FILE_ID, queuedMeeting, STARTED } from './helpers/meetingPipeline.ts';

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
  prepare?: (db: Db) => void;
  stt?: FakeSttProvider;
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

function setup(o: SetupOptions = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'wa-app-meet-'));
  dirs.push(dataDir);
  const ai = new FakeAi([{ ops: [op({ op: 'add_task', side: 'client', title: 'Send the logo files', category: 'content', priority: 'medium', sourceMessageIds: ['mtg1-a1'] })] }]);
  const drive = new FakeDrive();
  const db = seededDb();
  if (o.scopes !== false) saveGrantedScopes(db, [...MEETING_SCOPES, 'https://www.googleapis.com/auth/drive.file'].join(' '));
  o.prepare?.(db);
  const api = new FakeMeetingsApi();
  addConference(api);
  const stt = o.stt ?? new FakeSttProvider();
  const meetingAi = new FakeMeetingAi();
  const ff = fakeFfmpeg();
  const health: (MeetingsHealth | null)[] = [];
  const allow = new AllowList([SHARMA.groupId, MEHTA.groupId]);
  const sockets: FakeSocket[] = [];
  const auth = useEncryptedAuthState(openSessionDb(':memory:'), randomBytes(32));
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
          api, ai: meetingAi, transcriber: meetingTranscriber(stt, 88), ffmpeg: new Ffmpeg('ffmpeg.exe', ff.run),
          settings: { teamDomains: ['studio.example'], pollMinutes: 5, maxMinutes: 180, since: '2026-11-01', inrPerUsd: 88 },
          clients: [SHARMA, MEHTA],
        };
  const app = createApp({
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
function watchSchedules(app: ReturnType<typeof setup>['app'], db: Db): (string | undefined)[] {
  const seen: (string | undefined)[] = [];
  const schedule = app.publisher.schedule.bind(app.publisher);
  vi.spyOn(app.publisher, 'schedule').mockImplementation(() => {
    seen.push(getMeeting(db, 1)?.status);
    schedule();
  });
  return seen;
}

const spendRows = (db: Db) => db.prepare('SELECT kind, detail FROM spend ORDER BY id').all() as { kind: string; detail: string }[];

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
    const { app, api, health, db } = setup({ meetings: false });
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(api.calls).toEqual([]);
    expect(app.meetings).toBeUndefined();
    expect(health.length).toBeGreaterThan(1);
    expect(health.every((h) => h === null)).toBe(true);
    expect(getKv(db, 'meetings_since')).toBeUndefined();
    await stopApp(app);
  });

  it('without the meeting scopes: paused google_scopes, and no Google meeting call even for a queued meeting', async () => {
    const { app, api, health, db } = setup({ scopes: false, prepare: (d) => void insertFound(d, queuedMeeting()) });
    await vi.waitFor(() => expect(getMeeting(db, 1)?.errorCode).toBe('google_scopes'), SLOW_IO);
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(api.calls).toEqual([]);
    expect(health.at(-1)).toMatchObject({ paused: 'google_scopes', sttProvider: 'elevenlabs', stats: { waiting: 1 } });
    await stopApp(app);
  });

  it('finds a recording, takes it to done, updates the tracker and republishes the workbook', async () => {
    const { app, api, db, drive, stt, meetingAi, ai, health } = setup();
    const statusAtSchedule = watchSchedules(app, db);
    // The first Doc may wait for the publisher's first upload to make the WA Agent folder (drive_root, 5 minutes).
    await vi.waitFor(() => expect(['summarised', 'tracked']).toContain(getMeeting(db, 1)?.stage), SLOW_IO);
    await vi.advanceTimersByTimeAsync(6 * MINUTE); // past the wait and the next tick
    await vi.waitFor(() => expect(getMeeting(db, 1)?.status).toBe('done'), SLOW_IO);
    const m = getMeeting(db, 1)!;
    expect(m).toMatchObject({ clientId: 1, matchKind: 'title', stage: 'tracked', title: 'Sharma Interiors weekly' });
    expect(api.callsOf('download')).toHaveLength(1);
    expect(stt.calls).toHaveLength(1);
    expect(meetingAi.calls).toHaveLength(1);
    expect(drive.docs).toHaveLength(1);
    expect(m.docFileId).toBe(drive.docs[0]!.id);
    expect(ai.calls).toHaveLength(1); // the tracker step
    expect(listTasks(db, 1).map((t) => [t.title, t.origin])).toEqual([['Send the logo files', 'meeting']]);
    expect(spendRows(db).map((s) => s.kind)).toEqual(['stt', 'ai', 'ai']);

    // The finished meeting asks for a rebuild.
    expect(statusAtSchedule).toContain('done');
    await vi.waitFor(() => expect(health.at(-1)).toMatchObject({ paused: null, stats: { done: 1, waiting: 0 } }), SLOW_IO);

    // A later discovery pass stores nothing twice.
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(api.callsOf('listConferences').length).toBeGreaterThan(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM meetings').get()).toEqual({ n: 1 });
    await stopApp(app);
  });

  it('a meeting with nothing said is done without a tracker call, and still asks for a rebuild', async () => {
    const stt = new FakeSttProvider();
    stt.transcribe = async () => ({ model: 'scribe', segments: [], billedSeconds: null, raw: {} });
    const { app, db, ai, meetingAi, drive } = setup({ stt });
    const statusAtSchedule = watchSchedules(app, db);
    await vi.waitFor(() => expect(['summarised', 'tracked']).toContain(getMeeting(db, 1)?.stage), SLOW_IO);
    await vi.advanceTimersByTimeAsync(6 * MINUTE);
    await vi.waitFor(() => expect(getMeeting(db, 1)).toMatchObject({ status: 'done', note: 'no_speech' }), SLOW_IO);
    expect(ai.calls).toEqual([]);
    expect(meetingAi.calls).toEqual([]);
    expect(drive.docs).toHaveLength(1);
    expect(statusAtSchedule).toContain('done');
    await stopApp(app);
  });

  it('discovery runs at most every MEETING_POLL_MINUTES', async () => {
    const { app, api } = setup();
    await vi.waitFor(() => expect(api.callsOf('listConferences')).toHaveLength(1), SLOW_IO);
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(api.callsOf('listConferences')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(MINUTE + 30_000);
    expect(api.callsOf('listConferences')).toHaveLength(2);
    await stopApp(app);
  });

  it('stop aborts a download: stop returns well inside the drain and the meeting stays queued, due at the next start', async () => {
    const { app, api, db } = setup({ drainMs: 600_000 });
    const videoInfo = api.videoInfo.bind(api);
    api.videoInfo = async (fileId, s) => {
      const r = await videoInfo(fileId, s);
      // Discovery asks first; the processor's ask comes just before the download, which then hangs.
      if (api.callsOf('videoInfo').length === 2) api.gate = new Promise<void>(() => {});
      return r;
    };
    await vi.waitFor(() => expect(api.callsOf('download')).toHaveLength(1), SLOW_IO);
    const before = Date.now();
    await stopApp(app);
    expect(Date.now() - before).toBeLessThan(200_000); // the drain did not wait out its 600 s
    expect(getMeeting(db, 1)).toMatchObject({ status: 'queued', stage: 'found', errorCode: 'stopped', attempts: 0 });
    expect(spendRows(db)).toEqual([]);
  });

  it('stop lets a speech call finish within the drain and stores it, starting no further stage', async () => {
    const stt = new FakeSttProvider();
    let release!: () => void;
    stt.gate = new Promise<void>((r) => (release = r));
    const { app, db, meetingAi } = setup({ stt });
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
    expect(getMeeting(db, 1)?.stage).toBe('transcribed');
    expect(spendRows(db).map((s) => s.kind)).toEqual(['stt']);
    expect(meetingAi.calls).toEqual([]);
  });

  it('a speech call still running when the drain ends is booked at its ceiling before the database closes', async () => {
    const stt = new FakeSttProvider();
    stt.gate = new Promise<void>(() => {});
    const { app, db } = setup({ stt, drainMs: 20_000 });
    await vi.waitFor(() => expect(stt.calls).toHaveLength(1), SLOW_IO);
    await stopApp(app);
    expect(spendRows(db)).toEqual([expect.objectContaining({ kind: 'stt' })]);
    expect(getMeeting(db, 1)?.sttParts[0]).toMatchObject({ booked: 'ceiling' });
  });

  it('reloadClients passes the new configs to the watcher', async () => {
    const { app } = setup();
    const setClients = vi.spyOn(app.meetings!, 'setClients');
    const next = [{ ...SHARMA, meetingKeywords: ['interiors weekly'] }, MEHTA];
    app.reloadClients(next);
    expect(setClients).toHaveBeenCalledWith(next);
    await stopApp(app);
  });
});
