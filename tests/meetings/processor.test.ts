import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiInvalidOutputError, AiRefusalError } from '../../src/brain/claudeClient.ts';
import type { MeetingAi } from '../../src/brain/meetingClient.ts';
import type { MeetingSummary } from '../../src/brain/meetingSchema.ts';
import { Reconciler, type ReconcilerOptions } from '../../src/brain/reconciler.ts';
import { MeetingDeferral } from '../../src/meetings/audio.ts';
import { GoogleAccessError, GoogleNoAccessError, GoogleTransientError } from '../../src/meetings/googleErrors.ts';
import {
  deferralDueAt, MEETING_CLAIM_MS, MEETING_MAX_ATTEMPTS, MeetingProcessor, STT_UNAVAILABLE_MAX_MS, type MeetingProcessorDeps,
} from '../../src/meetings/processor.ts';
import { meetingTranscriber } from '../../src/meetings/transcribe.ts';
import type { Prices } from '../../src/spend/pricing.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import type { Db } from '../../src/store/db.ts';
import { getKv, setKv } from '../../src/store/kv.ts';
import { advanceStage, getMeeting, insertFound, setSttParts, type MeetingStage, type NewMeeting } from '../../src/store/meetings.ts';
import { listDecisions, listTasks } from '../../src/store/tasks.ts';
import { Ffmpeg } from '../../src/stt/audio.ts';
import { SttHttpError } from '../../src/stt/http.ts';
import { manualClock, type ManualClock } from '../../src/util/clock.ts';
import { createLogger, silentLogger, type Logger } from '../../src/util/logger.ts';
import { FakeAi, op, type FakeResponse } from '../helpers/ai.ts';
import { seededDb } from '../helpers/db.ts';
import { FakeDrive } from '../helpers/fakeDrive.ts';
import { FakeMeetingsApi } from '../helpers/fakeMeetings.ts';
import {
  addRecordingFile, fakeFfmpeg, FakeMeetingAi, FakeSttProvider, gate, queuedMeeting, SAID, SUMMARY_WIRE, type FakeFfmpeg,
} from '../helpers/meetingPipeline.ts';

const P: Prices = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 };
const NOW = '2026-11-01T12:00:00.000Z'; // 17:30 IST
const MINUTE = 60_000;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A logger whose lines go to `onLine` as they are written (synchronously). */
function hookLogger(onLine: (line: { msg: string } & Record<string, unknown>) => void): Logger {
  return createLogger('info', { write: (s: string) => onLine(JSON.parse(s) as { msg: string }) });
}

const addTask = (id: number): FakeResponse => ({
  ops: [op({ op: 'add_task', side: 'client', title: 'Send the logo files', category: 'content', priority: 'medium', deadline: '2026-11-02', sourceMessageIds: [`mtg${id}-a1`] })],
});

interface World {
  dataDir: string;
  db: Db;
  clock: ManualClock;
  spend: SpendGuard;
  api: FakeMeetingsApi;
  drive: FakeDrive;
  ff: FakeFfmpeg;
  stt: FakeSttProvider;
  ai: FakeMeetingAi;
  trackerAi: FakeAi;
  access: boolean[];
  scopes: { ok: boolean };
  id: number;
}

function world(o: { capUsd?: number; meeting?: Partial<NewMeeting> } = {}): World {
  const dataDir = mkdtempSync(join(tmpdir(), 'meet-proc-'));
  dirs.push(dataDir);
  const db = seededDb();
  setKv(db, 'drive_root_id', 'root'); // the publisher has made the WA Agent folder
  const clock = manualClock(NOW);
  const api = new FakeMeetingsApi();
  addRecordingFile(api);
  const id = insertFound(db, queuedMeeting(o.meeting))!;
  return {
    dataDir, db, clock, spend: new SpendGuard({ db, clock, capUsd: o.capUsd ?? 15 }), api, drive: new FakeDrive(), ff: fakeFfmpeg(),
    stt: new FakeSttProvider(), ai: new FakeMeetingAi(), trackerAi: new FakeAi([addTask(id)]), access: [], scopes: { ok: true }, id,
  };
}

/** A processor over the world's fakes: a new one is what a restart makes. */
function processor(w: World, o: Partial<MeetingProcessorDeps> & { exclusive?: ReconcilerOptions['exclusive'] } = {}): MeetingProcessor {
  const { exclusive, ...deps } = o;
  const reconciler = new Reconciler({ db: w.db, ai: w.trackerAi, spend: w.spend, prices: P, clock: w.clock, log: silentLogger(), onChanged: () => {}, exclusive });
  return new MeetingProcessor({
    db: w.db, spend: w.spend, prices: P, clock: w.clock, log: silentLogger(), dataDir: w.dataDir, api: w.api, drive: w.drive, ai: w.ai,
    transcriber: meetingTranscriber(w.stt, 88), ffmpeg: new Ffmpeg('ffmpeg.exe', w.ff.run), maxMinutes: 180, inrPerUsd: 88,
    teamDomains: ['studio.example'], freeBytes: () => 500e9, track: (clientId, m) => reconciler.runMeeting(clientId, m),
    hasMeetingScopes: () => w.scopes.ok, onGoogleAccess: (ok) => w.access.push(ok), ...deps,
  });
}

const row = (w: World) => getMeeting(w.db, w.id)!;
const spendRows = (w: World) => w.db.prepare('SELECT kind, usd, detail FROM spend ORDER BY id').all() as { kind: string; usd: number; detail: string }[];
const later = (w: World, ms: number) => w.clock.advance(ms);
const signal = () => new AbortController().signal;
const audioRel = (id: number) => `meetings/SHA/2026-11/${id}.mp3`;

/** Moves the world's meeting to `stage` with the results the earlier stages would have stored. */
function at(w: World, stage: MeetingStage): void {
  const stages: MeetingStage[] = ['audio', 'transcribed', 'summarised', 'doc'];
  for (const s of stages.slice(0, stages.indexOf(stage) + 1)) {
    if (s === 'audio') {
      mkdirSync(join(w.dataDir, 'meetings', 'SHA', '2026-11'), { recursive: true });
      writeFileSync(join(w.dataDir, ...audioRel(w.id).split('/')), 'mp3-bytes');
      advanceStage(w.db, w.id, 'audio', { audioPath: audioRel(w.id), audioSeconds: 2700 }, NOW);
    }
    if (s === 'transcribed') advanceStage(w.db, w.id, 'transcribed', { transcript: SAID }, NOW);
    if (s === 'summarised') advanceStage(w.db, w.id, 'summarised', { summary: structuredClone(SUMMARY_WIRE) as MeetingSummary }, NOW);
    if (s === 'doc') advanceStage(w.db, w.id, 'doc', { docFileId: 'doc-old' }, NOW);
  }
}

const setAttempts = (w: World, n: number) => w.db.prepare('UPDATE meetings SET attempts = ? WHERE id = ?').run(n, w.id);

describe('MeetingProcessor: found to done', () => {
  it('takes one meeting through every stage with each result stored, one Doc, the tracker updated and the meeting done', async () => {
    const w = world();
    const r = await processor(w).process(w.id, signal());
    expect(r).toEqual({ outcome: 'done', clientId: 1 });

    const m = row(w);
    expect(m).toMatchObject({ status: 'done', stage: 'tracked', audioPath: audioRel(w.id), audioSeconds: 2700, errorCode: null, nextAttemptAt: null });
    expect(m.transcript).toEqual(SAID);
    expect(m.summary?.actionItems).toHaveLength(1);
    expect(m.summary?.speakers).toEqual([{ label: 'A', name: 'Asha Verma' }]); // an attendee's name only
    expect(m.docFileId).toBe(w.drive.docs[0]!.id);

    // Files: the kept MP3 in the client's month folder; nothing left in tmp.
    expect(existsSync(join(w.dataDir, ...audioRel(w.id).split('/')))).toBe(true);
    expect(readdirSync(join(w.dataDir, 'meetings', 'tmp'))).toEqual([]);
    // One download, one speech call, one summary, one Doc in Clients/Sharma Interiors/Meetings, one tracker call.
    expect(w.api.callsOf('download')).toHaveLength(1);
    expect(w.stt.calls).toHaveLength(1);
    expect(w.stt.calls[0]!.opts.diarize).toBe(true);
    expect(w.ai.calls).toHaveLength(1);
    expect(w.drive.docs).toHaveLength(1);
    expect(w.drive.folders).toEqual(['Clients', 'Sharma Interiors', 'Meetings']);
    expect(w.trackerAi.calls).toHaveLength(1);
    expect(w.stt.forgotten).toEqual(['tr-1']);

    expect(listTasks(w.db, 1).map((t) => ({ title: t.title, origin: t.origin }))).toEqual([{ title: 'Send the logo files', origin: 'meeting' }]);
    expect(w.db.prepare('SELECT meeting_id AS meetingId FROM tasks').all()).toEqual([{ meetingId: w.id }]);
    expect(listDecisions(w.db, 1, 10)).toEqual([]);

    expect(spendRows(w).map((s) => [s.kind, s.detail])).toEqual([
      ['stt', `meeting ${w.id} part 1`],
      ['ai', `meeting ${w.id}`],
      ['ai', `meeting ${w.id}`],
    ]);
    expect(w.access).toEqual([true]);
  });

  it('a meeting with nothing said gets an empty summary and a short Doc, with no Claude call and no tracker call', async () => {
    const w = world();
    w.stt.transcribe = async () => ({ model: 'scribe', segments: [{ start: 0, end: 1, speaker: 'A', text: ' ' }], billedSeconds: null, raw: {} });
    const r = await processor(w).process(w.id, signal());
    expect(r.outcome).toBe('done');
    expect(row(w)).toMatchObject({ status: 'done', note: 'no_speech', transcript: [] });
    expect(w.ai.calls).toHaveLength(0);
    expect(w.trackerAi.calls).toHaveLength(0);
    expect(w.drive.docs).toHaveLength(1);
  });

  it('reads the invite and signed-in names again for an assigned meeting stored without attendees', async () => {
    const w = world({ meeting: { title: '', attendees: [], participants: [], matchKind: 'human' } });
    w.api.invites.set('abc-defg-hij', {
      title: 'Brand review', attendees: [{ email: 'Asha@Sharma.example', name: 'Asha Verma', self: false }, { email: 'ravi@studio.example', name: 'Ravi', self: true }],
    });
    w.api.signedInNames.set('conferenceRecords/c1', ['Asha Verma', 'Guest Person']);
    await processor(w).process(w.id, signal());
    const m = row(w);
    expect(m.title).toBe('Brand review');
    expect(m.attendees).toEqual([
      { email: 'asha@sharma.example', name: 'Asha Verma', team: false },
      { email: 'ravi@studio.example', name: 'Ravi', team: true },
    ]);
    expect(m.participants).toEqual(['Asha Verma', 'Guest Person']);
    expect(w.api.callsOf('findInvite')).toEqual([['abc-defg-hij', w.api.callsOf('findInvite')[0]![1]]]);
    expect(w.drive.docs[0]!.name).toContain('Brand review');
  });

  it.each([
    ['a no-access error on the invite', 'findInvite', new GoogleNoAccessError('http_404'), 'http_404'],
    ['a transient error on the names', 'listSignedInNames', new GoogleTransientError('http_503'), 'http_503'],
    ['a transient error on the file name', 'videoInfo', new GoogleTransientError('timeout'), 'timeout'],
  ] as const)('%s while reading an assigned meeting again: logged, and the meeting goes on with the stored facts', async (_what, method, error, code) => {
    const w = world({ meeting: { title: '', attendees: [], participants: [], matchKind: 'human' } });
    w.api.invites.set('abc-defg-hij', { title: '', attendees: [{ email: 'asha@sharma.example', name: 'Asha Verma', self: false }] });
    if (method === 'videoInfo') {
      // Only the first file-name read fails; prepareAudio's own read then works.
      const real = w.api.videoInfo.bind(w.api);
      let n = 0;
      w.api.videoInfo = async (id, sig) => {
        if (n++ === 0) throw error;
        return await real(id, sig);
      };
    } else {
      w.api.failWith.set(method, error);
    }
    const warned: unknown[] = [];
    const log = hookLogger((l) => l.msg.startsWith('meeting attendees could not be read again') && warned.push(l));
    expect((await processor(w, { log }).process(w.id, signal())).outcome).toBe('done');
    expect(row(w)).toMatchObject({ status: 'done', title: '', attendees: [], participants: [] });
    expect(warned).toEqual([expect.objectContaining({ meetingId: w.id, code })]);
  });

  it('a stop or a sign-in refusal while reading again is not swallowed', async () => {
    const w = world({ meeting: { attendees: [], matchKind: 'human' } });
    w.api.failWith.set('findInvite', new GoogleAccessError('http_401'));
    expect((await processor(w).process(w.id, signal())).outcome).toBe('deferred');
    expect(row(w)).toMatchObject({ errorCode: 'google_auth', stage: 'found' });
  });

  it('reads an assigned meeting again at most once per service run', async () => {
    const w = world({ meeting: { attendees: [], matchKind: 'human' } });
    w.ff.convert = 'fail'; // the audio step fails, so the meeting stays at stage found
    const p = processor(w);
    await p.process(w.id, signal());
    later(w, MINUTE);
    await p.process(w.id, signal());
    expect(w.api.callsOf('findInvite')).toHaveLength(1);
    later(w, 5 * MINUTE);
    await processor(w).process(w.id, signal()); // a restart reads it again
    expect(w.api.callsOf('findInvite')).toHaveLength(2);
  });

  it('a queued meeting at stage tracked is finished as done', async () => {
    const w = world();
    advanceStage(w.db, w.id, 'tracked', { docFileId: 'doc-old' }, NOW);
    expect((await processor(w).process(w.id, signal())).outcome).toBe('done');
    expect(row(w)).toMatchObject({ status: 'done', stage: 'tracked' });
    expect(w.api.calls).toEqual([]);
    expect(w.trackerAi.calls).toEqual([]);
  });

  it('a meeting with attendees is not read again', async () => {
    const w = world();
    await processor(w).process(w.id, signal());
    expect(w.api.callsOf('findInvite')).toEqual([]);
    expect(w.api.callsOf('listSignedInNames')).toEqual([]);
  });
});

describe('MeetingProcessor: resuming', () => {
  // The stop comes right after the stage's result is stored (its log line), as a crash at that moment would.
  const cases: [MeetingStage, string][] = [
    ['audio', 'meeting audio prepared'],
    ['transcribed', 'meeting transcribed'],
    ['summarised', 'meeting summarised'],
    ['doc', 'meeting Doc created'],
  ];
  it.each(cases)('stopped after stage %s, a restart resumes there: no second download, speech booking, summary or Doc', async (stage, line) => {
    const w = world();
    const ctl = new AbortController();
    const first = processor(w, { log: hookLogger((l) => l.msg === line && ctl.abort()) });
    expect((await first.process(w.id, ctl.signal)).outcome).toBe('stopped');
    expect(row(w)).toMatchObject({ status: 'queued', stage, attempts: 0 });

    // The restart: a new processor; the same database, files and Google.
    const r = await processor(w).process(w.id, signal());
    expect(r.outcome).toBe('done');
    expect(row(w)).toMatchObject({ status: 'done', stage: 'tracked' });
    expect(w.api.callsOf('download')).toHaveLength(1);
    expect(w.stt.calls).toHaveLength(1);
    expect(w.ai.calls).toHaveLength(1);
    expect(w.drive.docs).toHaveLength(1);
    expect(w.trackerAi.calls).toHaveLength(1);
    expect(spendRows(w).map((s) => s.kind)).toEqual(['stt', 'ai', 'ai']);
    expect(listTasks(w.db, 1)).toHaveLength(1);
  });

  it('a stage cut off by a crash waits out its claim, with the attempt counted', async () => {
    const w = world();
    at(w, 'transcribed');
    // The crash: the claim was written, then the process died during the summary.
    w.ai.gate = new Promise<void>(() => {});
    void processor(w).process(w.id, signal());
    await w.ai.started;
    expect(row(w)).toMatchObject({ attempts: 1, nextAttemptAt: new Date(Date.parse(NOW) + MEETING_CLAIM_MS).toISOString() });

    const restart = processor(w, { ai: new FakeMeetingAi() });
    expect((await restart.process(w.id, signal())).outcome).toBe('skipped'); // not due yet
    later(w, MEETING_CLAIM_MS);
    expect((await restart.process(w.id, signal())).outcome).toBe('done');
  });

  it(`after ${MEETING_MAX_ATTEMPTS} runs that never ended it fails as crashed, booking a part left in flight first`, async () => {
    const w = world();
    at(w, 'audio');
    setSttParts(w.db, w.id, [{ index: 0, provider: 'elevenlabs', file: null, offset: 0, seconds: 2700, state: 'inflight', jobId: null, booked: 'none', segments: null, billedSeconds: null }], NOW);
    setAttempts(w, MEETING_MAX_ATTEMPTS);
    const r = await processor(w).process(w.id, signal());
    expect(r.outcome).toBe('failed');
    expect(row(w)).toMatchObject({ status: 'failed', errorCode: 'crashed', stage: 'audio' });
    expect(row(w).sttParts[0]).toMatchObject({ state: 'unknown', booked: 'ceiling' });
    expect(spendRows(w)).toEqual([expect.objectContaining({ kind: 'stt', detail: `meeting ${w.id} part 0 (unknown, estimated)` })]);
    expect(w.stt.calls).toHaveLength(0);
  });

  it('books stuck parts before failing: when that booking cannot be written, the meeting is not failed', async () => {
    const w = world();
    at(w, 'audio');
    setSttParts(w.db, w.id, [{ index: 0, provider: 'elevenlabs', file: null, offset: 0, seconds: 2700, state: 'inflight', jobId: null, booked: 'none', segments: null, billedSeconds: null }], NOW);
    setAttempts(w, MEETING_MAX_ATTEMPTS);
    vi.spyOn(w.spend, 'record').mockImplementation(() => {
      throw new Error('database is locked');
    });
    await expect(processor(w).process(w.id, signal())).rejects.toThrow('database is locked');
    expect(row(w).status).toBe('queued');
  });
});

describe('MeetingProcessor: deferrals', () => {
  const PRE_CLAIM = 2;
  /** Runs one deferral case: the meeting at `stage` with 2 attempts used, and what it waits for. */
  async function deferred(w: World, p: MeetingProcessor, code: string, waitMs: number | 'midnight') {
    setAttempts(w, PRE_CLAIM);
    const r = await p.process(w.id, signal());
    expect(r.outcome).toBe('deferred');
    const due = waitMs === 'midnight' ? '2026-11-01T18:30:00.000Z' : new Date(Date.parse(NOW) + waitMs).toISOString();
    expect(row(w)).toMatchObject({ status: 'queued', errorCode: code, nextAttemptAt: due, attempts: PRE_CLAIM });
  }

  it('google_scopes: no Google call at all, 15 minutes', async () => {
    const w = world();
    w.scopes.ok = false;
    await deferred(w, processor(w), 'google_scopes', 15 * MINUTE);
    expect(w.api.calls).toEqual([]);
  });

  it('no_ffmpeg at stage found and at stage audio, 60 minutes, nothing downloaded', async () => {
    const w = world();
    await deferred(w, processor(w, { ffmpeg: null }), 'no_ffmpeg', 60 * MINUTE);
    expect(w.api.calls).toEqual([]);
    const w2 = world();
    at(w2, 'audio');
    await deferred(w2, processor(w2, { ffmpeg: null }), 'no_ffmpeg', 60 * MINUTE);
    expect(w2.stt.calls).toEqual([]);
  });

  it('stt_none: found and matched, but nothing downloaded or sent, 60 minutes', async () => {
    const w = world();
    await deferred(w, processor(w, { transcriber: null }), 'stt_none', 60 * MINUTE);
    expect(w.api.calls).toEqual([]);
  });

  it('low_disk, also when free space cannot be read, 60 minutes', async () => {
    const w = world();
    await deferred(w, processor(w, { freeBytes: () => 1e9 }), 'low_disk', 60 * MINUTE);
    const w2 = world();
    await deferred(w2, processor(w2, { freeBytes: () => null }), 'low_disk', 60 * MINUTE);
    expect(w2.api.callsOf('download')).toEqual([]);
  });

  it('stt_unavailable when the speech key is refused, 60 minutes; after 24 hours of it the meeting fails', async () => {
    const w = world();
    at(w, 'audio');
    w.stt.failures = [new SttHttpError(401)];
    const p = processor(w);
    await deferred(w, p, 'stt_unavailable', 60 * MINUTE);
    later(w, STT_UNAVAILABLE_MAX_MS);
    w.stt.failures = [new SttHttpError(403)];
    expect((await p.process(w.id, signal())).outcome).toBe('failed');
    expect(row(w)).toMatchObject({ status: 'failed', errorCode: 'stt_unavailable' });
  });

  it('spend_cap waits for the next IST midnight; spend_busy 10 minutes', async () => {
    const w = world({ capUsd: 0.1 });
    at(w, 'transcribed');
    await deferred(w, processor(w), 'spend_cap', 'midnight');
    expect(w.ai.calls).toEqual([]);

    const w2 = world({ capUsd: 1 });
    at(w2, 'transcribed');
    w2.spend.reserve(0.9); // another paid call in flight
    await deferred(w2, processor(w2), 'spend_busy', 10 * MINUTE);
  });

  it('client_busy while a WhatsApp run of the client is in flight, 1 minute', async () => {
    const w = world();
    at(w, 'doc');
    await deferred(w, processor(w, { exclusive: async () => 'busy' }), 'client_busy', MINUTE);
    expect(w.trackerAi.calls).toEqual([]);
  });

  it('google_auth pauses meetings and waits 15 minutes', async () => {
    const w = world();
    w.api.failWith.set('videoInfo', new GoogleAccessError('http_401'));
    await deferred(w, processor(w), 'google_auth', 15 * MINUTE);
    expect(w.access).toEqual([false]);
  });

  it('drive_root waits 5 minutes for the publisher to make the WA Agent folder', async () => {
    const w = world();
    at(w, 'summarised');
    setKv(w.db, 'drive_root_id', '');
    expect(getKv(w.db, 'drive_root_id')).toBeFalsy();
    await deferred(w, processor(w), 'drive_root', 5 * MINUTE);
    expect(w.drive.docs).toEqual([]);
  });

  it('deferralDueAt: every listed code', () => {
    const t = new Date(NOW);
    const mins = (code: string) => (deferralDueAt(code, t).getTime() - t.getTime()) / MINUTE;
    expect(Object.fromEntries(['spend_busy', 'client_busy', 'stt_none', 'stt_unavailable', 'google_auth', 'google_scopes', 'no_ffmpeg', 'low_disk', 'disk_full', 'disk_busy', 'drive_root', 'other'].map((c) => [c, mins(c)]))).toEqual({
      spend_busy: 10, client_busy: 1, stt_none: 60, stt_unavailable: 60, google_auth: 15, google_scopes: 15, no_ffmpeg: 60, low_disk: 60,
      disk_full: 60, disk_busy: 15, drive_root: 5, other: 60,
    });
    expect(deferralDueAt('spend_cap', t).toISOString()).toBe('2026-11-01T18:30:00.000Z');
    // Just before IST midnight: the very next midnight, not the one after.
    expect(deferralDueAt('spend_cap', new Date('2026-11-01T18:29:00.000Z')).toISOString()).toBe('2026-11-01T18:30:00.000Z');
  });

  it('a deferral from any stage step (MeetingDeferral) restores the attempt', async () => {
    const w = world();
    at(w, 'doc');
    await deferred(w, processor(w, { track: async () => { throw new MeetingDeferral('spend_busy'); } }), 'spend_busy', 10 * MINUTE);
  });
});

describe('MeetingProcessor: failures', () => {
  it('a transient error retries after 1, 5 and 30 minutes, then fails, booking a part left in flight first', async () => {
    const w = world();
    w.ff.convert = 'fail';
    // A part some earlier run left in flight (never sent again while the audio step fails).
    setSttParts(w.db, w.id, [{ index: 0, provider: 'elevenlabs', file: null, offset: 0, seconds: 2700, state: 'inflight', jobId: null, booked: 'none', segments: null, billedSeconds: null }], NOW);
    const p = processor(w);
    for (const [n, wait] of [[1, 1], [2, 5], [3, 30]] as const) {
      expect((await p.process(w.id, signal())).outcome).toBe('deferred');
      expect(row(w)).toMatchObject({ status: 'queued', errorCode: 'convert_failed', attempts: n });
      expect(row(w).nextAttemptAt).toBe(new Date(w.clock.now().getTime() + wait * MINUTE).toISOString());
      expect(spendRows(w)).toEqual([]);
      later(w, wait * MINUTE);
    }
    expect((await p.process(w.id, signal())).outcome).toBe('failed');
    expect(row(w)).toMatchObject({ status: 'failed', errorCode: 'convert_failed', stage: 'found' });
    expect(row(w).sttParts[0]).toMatchObject({ booked: 'ceiling' });
    expect(spendRows(w).map((s) => s.kind)).toEqual(['stt']);
    expect(w.ff.conversions).toBe(4);
    // Every attempt downloaded afresh and left nothing behind.
    expect(readdirSync(join(w.dataDir, 'meetings', 'tmp'))).toEqual([]);
  });

  it('a 503 from the speech provider is retried and then succeeds, booking speech once', async () => {
    const w = world();
    at(w, 'audio');
    w.stt.failures = [new SttHttpError(503)];
    const p = processor(w);
    expect((await p.process(w.id, signal())).outcome).toBe('deferred');
    expect(row(w)).toMatchObject({ errorCode: 'http_503', attempts: 1 });
    later(w, MINUTE);
    expect((await p.process(w.id, signal())).outcome).toBe('done');
    expect(spendRows(w).filter((s) => s.kind === 'stt')).toHaveLength(1);
  });

  it('a file Google will not open is no_access; a too-long measured recording is too_long with its audio kept', async () => {
    const w = world();
    w.api.failWith.set('download', new GoogleNoAccessError('http_403'));
    expect((await processor(w).process(w.id, signal())).outcome).toBe('failed');
    expect(row(w)).toMatchObject({ status: 'no_access', errorCode: 'http_403' });

    const w2 = world();
    w2.ff.seconds = 200 * 60;
    expect((await processor(w2).process(w2.id, signal())).outcome).toBe('failed');
    expect(row(w2)).toMatchObject({ status: 'too_long', errorCode: 'too_long_measured', audioSeconds: 12_000 });
    expect(w2.stt.calls).toEqual([]);
  });

  it('an invalid summary twice (summarizeMeeting tried once more) fails at once after exactly 2 booked calls', async () => {
    const w = world();
    at(w, 'transcribed');
    const invalid = () => new AiInvalidOutputError('bad', { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, 0.03);
    const ai = new FakeMeetingAi([invalid(), invalid(), {}]);
    expect((await processor(w, { ai }).process(w.id, signal())).outcome).toBe('failed');
    expect(row(w)).toMatchObject({ status: 'failed', errorCode: 'ai_invalid_output', stage: 'transcribed' });
    expect(ai.calls).toHaveLength(2);
    expect(spendRows(w).map((r) => r.kind)).toEqual(['ai', 'ai']);
  });

  it('an invalid tracker answer twice fails at once after exactly 2 booked calls', async () => {
    const w = world();
    at(w, 'doc');
    const invalid = () => new AiInvalidOutputError('bad', { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, 0.02);
    w.trackerAi = new FakeAi([invalid(), invalid(), addTask(w.id)]);
    expect((await processor(w).process(w.id, signal())).outcome).toBe('failed');
    expect(row(w)).toMatchObject({ status: 'failed', errorCode: 'ai_invalid_output', stage: 'doc' });
    expect(w.trackerAi.calls).toHaveLength(2);
    expect(spendRows(w).map((r) => r.kind)).toEqual(['ai', 'ai']);
    expect(listTasks(w.db, 1)).toEqual([]);
  });

  it('a row missing what its stage needs is retried with a real code, and a plain Error is stored as unknown', async () => {
    const w = world();
    advanceStage(w.db, w.id, 'doc', { docFileId: 'doc-old' }, NOW); // no summary stored
    expect((await processor(w).process(w.id, signal())).outcome).toBe('deferred');
    expect(row(w)).toMatchObject({ errorCode: 'no_summary', attempts: 1 });

    const w2 = world();
    at(w2, 'doc');
    expect((await processor(w2, { track: async () => { throw new Error('boom'); } }).process(w2.id, signal())).outcome).toBe('deferred');
    expect(row(w2)).toMatchObject({ errorCode: 'unknown', attempts: 1 });
  });

  it('a refused summary fails at once: a retry would pay again', async () => {
    const w = world();
    at(w, 'transcribed');
    const ai: MeetingAi = { summarize: async () => { throw new AiRefusalError('cyber', { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, 0.02); } };
    expect((await processor(w, { ai }).process(w.id, signal())).outcome).toBe('failed');
    expect(row(w)).toMatchObject({ status: 'failed', errorCode: 'ai_refusal', stage: 'transcribed' });
  });

  it('a meeting that is not queued is left alone', async () => {
    const w = world({ meeting: { status: 'unassigned', clientId: null, matchKind: null } });
    expect((await processor(w).process(w.id, signal())).outcome).toBe('skipped');
    expect(w.api.calls).toEqual([]);
    expect(row(w).attempts).toBe(0);
  });
});

describe('MeetingProcessor: stopping', () => {
  it('a stop aborts the download: the meeting is left queued and due at once, with its attempt given back and no work file', async () => {
    const w = world();
    const videoInfo = w.api.videoInfo.bind(w.api);
    w.api.videoInfo = async (fileId, s) => {
      const r = await videoInfo(fileId, s);
      w.api.gate = new Promise<void>(() => {}); // the download hangs
      return r;
    };
    const ctl = new AbortController();
    const run = processor(w).process(w.id, ctl.signal);
    await vi.waitFor(() => expect(w.api.callsOf('download')).toHaveLength(1));
    ctl.abort();
    expect((await run).outcome).toBe('stopped');
    expect(row(w)).toMatchObject({ status: 'queued', stage: 'found', attempts: 0, errorCode: 'stopped', nextAttemptAt: NOW });
    expect(readdirSync(join(w.dataDir, 'meetings', 'tmp'))).toEqual([]);
  });

  it('a stop aborts ffmpeg', async () => {
    const w = world();
    w.ff.convert = 'hang';
    const ctl = new AbortController();
    const run = processor(w).process(w.id, ctl.signal);
    await w.ff.hung;
    ctl.abort();
    expect((await run).outcome).toBe('stopped');
    expect(w.ff.opts.every((o) => o.signal === ctl.signal)).toBe(true);
  });

  it('a stop lets a speech call finish and be stored, then runs no further stage', async () => {
    const w = world();
    at(w, 'audio');
    const g = gate();
    w.stt.gate = g.promise;
    const ctl = new AbortController();
    const run = processor(w).process(w.id, ctl.signal);
    await w.stt.started;
    ctl.abort();
    g.open();
    expect((await run).outcome).toBe('stopped');
    expect(row(w).stage).toBe('transcribed');
    expect(spendRows(w).map((s) => s.kind)).toEqual(['stt']);
    expect(w.ai.calls).toEqual([]);
  });

  it('a stop lets a Claude summary finish and be stored, then makes no Doc', async () => {
    const w = world();
    at(w, 'transcribed');
    const g = gate();
    w.ai.gate = g.promise;
    const ctl = new AbortController();
    const run = processor(w).process(w.id, ctl.signal);
    await w.ai.started;
    ctl.abort();
    g.open();
    expect((await run).outcome).toBe('stopped');
    expect(row(w).stage).toBe('summarised');
    expect(spendRows(w).map((s) => s.kind)).toEqual(['ai']);
    expect(w.drive.docs).toEqual([]);
  });

  it('a speech call still running when the drain ends is booked by settlePending', async () => {
    const w = world();
    at(w, 'audio');
    w.stt.gate = new Promise<void>(() => {});
    const ctl = new AbortController();
    void processor(w).process(w.id, ctl.signal);
    await w.stt.started;
    ctl.abort();
    expect(w.spend.settlePending('shutdown before the paid call finished (estimated)')).toBe(1);
    expect(spendRows(w).map((s) => s.kind)).toEqual(['stt']);
    expect(row(w).sttParts[0]).toMatchObject({ booked: 'ceiling' });
  });
});
