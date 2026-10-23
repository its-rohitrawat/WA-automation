import { Writable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ClientConfig } from '../../src/config/groups.ts';
import type { DriveVideoInfo, InviteInfo, RecordingRef } from '../../src/meetings/googleApi.ts';
import { GoogleAccessError, GoogleTransientError } from '../../src/meetings/googleErrors.ts';
import { MeetingWatcher, titleFromFileName, type WatcherSettings } from '../../src/meetings/watcher.ts';
import { syncClients } from '../../src/store/clients.ts';
import { openDb, type Db } from '../../src/store/db.ts';
import { getMeeting, insertFound } from '../../src/store/meetings.ts';
import { manualClock, type ManualClock } from '../../src/util/clock.ts';
import { createLogger, silentLogger, type Logger } from '../../src/util/logger.ts';
import { FakeMeetingsApi } from '../helpers/fakeMeetings.ts';

const PHASES = ['Discovery', 'Design', 'Development', 'Review', 'Launch'];
const SHARMA: ClientConfig = {
  groupId: '120363000000000001@g.us', name: 'Sharma Interiors', code: 'SHA', phases: PHASES, emailDomains: ['sharma.in'], meetingKeywords: ['villa project'],
};
const MEHTA: ClientConfig = {
  groupId: '120363000000000002@g.us', name: 'Mehta Foods', code: 'MEH', phases: PHASES, emailDomains: ['mehtafoods.com'], meetingKeywords: [],
};
const GUPTA: ClientConfig = {
  groupId: '120363000000000003@g.us', name: 'Gupta Traders', code: 'GUP', phases: PHASES, emailDomains: [], meetingKeywords: [],
};

const NOW = '2026-10-23T06:00:00.000Z';
const HOUR = 3_600_000;
const ago = (hours: number): string => new Date(Date.parse(NOW) - hours * HOUR).toISOString();
const SETTINGS: WatcherSettings = { teamDomains: ['studio.in'], maxMinutes: 180, since: '2026-10-01' };

interface ConfSpec {
  id: string;
  start: string;
  end?: string | null;
  recordings?: (Partial<RecordingRef> & { id: string })[];
  code?: string | null;
  invite?: InviteInfo | null;
  names?: string[];
  files?: Record<string, Partial<DriveVideoInfo>>;
}

/** One conference with its space, code, invite, names and Drive files. Recording ids double as file ids unless given. */
function addConference(api: FakeMeetingsApi, s: ConfSpec): void {
  const name = `conferenceRecords/${s.id}`;
  const space = `spaces/${s.id}`;
  api.conferences.push({ name, space, startTime: s.start, endTime: s.end === undefined ? new Date(Date.parse(s.start) + HOUR).toISOString() : s.end });
  const recs = s.recordings ?? [{ id: `${s.id}r1` }];
  api.recordings.set(
    name,
    recs.map((r) => ({
      name: `${name}/recordings/${r.id}`,
      state: r.state ?? 'FILE_GENERATED',
      driveFileId: r.driveFileId === undefined ? `file${r.id}` : r.driveFileId,
      startTime: r.startTime ?? s.start,
      endTime: r.endTime ?? null,
    })),
  );
  const code = s.code === undefined ? `code-${s.id}` : s.code;
  api.codes.set(space, code);
  if (code !== null && s.invite !== null) {
    api.invites.set(code, s.invite ?? { title: 'Sharma Interiors review', attendees: [{ email: 'owner@studio.in', name: 'Owner', self: true }, { email: 'Ravi@Sharma.in', name: 'Ravi', self: false }] });
  }
  if (s.names) api.signedInNames.set(name, s.names);
  for (const r of recs) {
    const fileId = r.driveFileId === undefined ? `file${r.id}` : r.driveFileId;
    if (fileId === null) continue;
    const info = s.files?.[fileId] ?? {};
    api.files.set(fileId, {
      info: { name: 'Recording (2026-10-23 10:00 GMT+05:30).mp4', size: 1000, mimeType: 'video/mp4', durationMs: 45 * 60_000, ...info },
      bytes: Buffer.alloc(0),
    });
  }
}

const rowCount = (db: Db): number => (db.prepare('SELECT COUNT(*) AS n FROM meetings').get() as { n: number }).n;
const allRows = (db: Db) => (db.prepare('SELECT id FROM meetings ORDER BY id').all() as { id: number }[]).map((r) => getMeeting(db, r.id)!);

function capture(): { lines: string[]; log: Logger } {
  const lines: string[] = [];
  const sink = new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } });
  return { lines, log: createLogger('debug', sink) };
}

let db: Db;
let api: FakeMeetingsApi;
let clock: ManualClock;
const signal = new AbortController().signal;

function watcher(o: { log?: Logger; settings?: Partial<WatcherSettings>; clients?: ClientConfig[] } = {}): MeetingWatcher {
  return new MeetingWatcher({ db, api, clock, log: o.log ?? silentLogger(), settings: { ...SETTINGS, ...o.settings }, clients: o.clients ?? [SHARMA, MEHTA] });
}

beforeEach(() => {
  db = openDb(':memory:');
  syncClients(db, [SHARMA, MEHTA]); // ids 1 and 2
  api = new FakeMeetingsApi();
  clock = manualClock(NOW);
});

describe('titleFromFileName', () => {
  it('drops the trailing date suffix and the extension', () => {
    expect(titleFromFileName('Sharma Interiors sync (2026-10-23 10:00 GMT+05:30).mp4')).toBe('Sharma Interiors sync');
    expect(titleFromFileName('Sharma Interiors sync (2026-10-23 10:00 GMT+5:30)')).toBe('Sharma Interiors sync');
    expect(titleFromFileName('abc-defg-hij (2026-10-23 10:00 GMT)')).toBe('abc-defg-hij');
    expect(titleFromFileName('Plan (v2) review')).toBe('Plan (v2) review');
  });
});

describe('MeetingWatcher.discover', () => {
  it('stores a matched meeting once, with its title, attendees and participants', async () => {
    addConference(api, { id: 'c1', start: ago(3), names: ['Ravi Sharma', ' Owner '] });
    const w = watcher();
    expect(await w.discover(signal)).toEqual({ added: 1, skipped: 0, errors: 0 });
    const [row] = allRows(db);
    expect(row).toMatchObject({
      recording: 'conferenceRecords/c1/recordings/c1r1',
      conference: 'conferenceRecords/c1',
      driveFileId: 'filec1r1',
      meetingCode: 'code-c1',
      title: 'Sharma Interiors review',
      startedAt: ago(3),
      attendees: [{ email: 'owner@studio.in', name: 'Owner', team: true }, { email: 'ravi@sharma.in', name: 'Ravi', team: false }],
      participants: ['Ravi Sharma', 'Owner'],
      clientId: 1,
      matchKind: 'title',
      status: 'queued',
      driveSeconds: 2700,
      createdAt: NOW,
    });
    expect(api.callsOf('findInvite')).toEqual([['code-c1', ago(3)]]);

    clock.advance(5 * 60_000);
    expect(await w.discover(signal)).toEqual({ added: 0, skipped: 1, errors: 0 });
    expect(rowCount(db)).toBe(1);
    expect(api.callsOf('videoInfo')).toHaveLength(1); // a known recording is not looked at again
  });

  it('stores two rows for two recordings of one conference', async () => {
    addConference(api, { id: 'c1', start: ago(3), recordings: [{ id: 'a' }, { id: 'b', startTime: ago(2.5) }] });
    expect(await watcher().discover(signal)).toEqual({ added: 2, skipped: 0, errors: 0 });
    const rows = allRows(db);
    expect(rows.map((r) => [r.recording, r.driveFileId, r.startedAt])).toEqual([
      ['conferenceRecords/c1/recordings/a', 'filea', ago(3)],
      ['conferenceRecords/c1/recordings/b', 'fileb', ago(2.5)],
    ]);
    expect(api.callsOf('findInvite')).toHaveLength(1); // per conference, not per recording
  });

  it('leaves out recordings without a finished file', async () => {
    addConference(api, { id: 'c1', start: ago(1), end: null, recordings: [{ id: 'a', state: 'STARTED', driveFileId: null }, { id: 'b', state: 'FILE_GENERATED', driveFileId: null }] });
    expect(await watcher().discover(signal)).toEqual({ added: 0, skipped: 0, errors: 0 });
    expect(api.callsOf('meetingCode')).toHaveLength(0);
  });

  it('takes the title from the file name when there is no invite, or its title is empty', async () => {
    addConference(api, { id: 'c1', start: ago(3), code: null, files: { filec1r1: { name: 'Sharma Interiors sync (2026-10-23 10:00 GMT+05:30).mp4' } } });
    addConference(api, { id: 'c2', start: ago(2), invite: { title: '  ', attendees: [] }, files: { filec2r1: { name: 'Mehta Foods call (2026-10-23 11:00 GMT+05:30)' } } });
    expect(await watcher().discover(signal)).toEqual({ added: 2, skipped: 0, errors: 0 });
    const [a, b] = allRows(db);
    expect(a).toMatchObject({ title: 'Sharma Interiors sync', meetingCode: null, attendees: [], clientId: 1, matchKind: 'title', status: 'queued' });
    expect(b).toMatchObject({ title: 'Mehta Foods call', clientId: 2, status: 'queued' });
    expect(api.callsOf('findInvite').map((c) => c[0])).toEqual(['code-c2']); // no code, no invite lookup
  });

  it('cleans and caps titles and names, and drops attendees without an address', async () => {
    const longTitle = `Sharma Interiors\n${'x'.repeat(300)}`;
    addConference(api, {
      id: 'c1',
      start: ago(3),
      invite: { title: longTitle, attendees: [{ email: 'Ravi@Sharma.in', name: `Ra​vi\n${'y'.repeat(150)}`, self: false }, { email: 'board-room', name: 'Board', self: false }] },
      names: ['  ', 'Ravi\tS', 'z'.repeat(150)],
    });
    await watcher().discover(signal);
    const [row] = allRows(db);
    expect(row!.title.startsWith('Sharma Interiors x')).toBe(true);
    expect([...row!.title]).toHaveLength(200);
    expect(row!.attendees).toHaveLength(1);
    expect(row!.attendees[0]!.email).toBe('ravi@sharma.in');
    expect(row!.attendees[0]!.name!.startsWith('Ravi y')).toBe(true);
    expect([...row!.attendees[0]!.name!]).toHaveLength(100);
    expect(row!.participants).toEqual(['Ravi S', 'z'.repeat(100)]);
  });

  it('matches by domain, and leaves unmatched meetings unassigned', async () => {
    addConference(api, { id: 'c1', start: ago(3), invite: { title: 'Weekly', attendees: [{ email: 'om@mail.mehtafoods.com', name: null, self: false }] } });
    addConference(api, { id: 'c2', start: ago(2), invite: { title: 'Weekly', attendees: [{ email: 'x@elsewhere.com', name: null, self: false }] } });
    await watcher().discover(signal);
    const [a, b] = allRows(db);
    expect(a).toMatchObject({ clientId: 2, matchKind: 'domain', status: 'queued' });
    expect(b).toMatchObject({ clientId: null, matchKind: null, status: 'unassigned', title: 'Weekly' });
  });

  it('marks a meeting longer than the limit too_long by Drive length, and keeps its client', async () => {
    addConference(api, { id: 'c1', start: ago(5), files: { filec1r1: { durationMs: 181 * 60_000 } } });
    addConference(api, { id: 'c2', start: ago(4), files: { filec2r1: { durationMs: 180 * 60_000 } } });
    addConference(api, { id: 'c3', start: ago(3), files: { filec3r1: { durationMs: null } } });
    await watcher().discover(signal);
    const [a, b, c] = allRows(db);
    expect(a).toMatchObject({ status: 'too_long', clientId: 1, matchKind: 'title', driveSeconds: 181 * 60 });
    expect(b).toMatchObject({ status: 'queued', driveSeconds: 180 * 60 });
    expect(c).toMatchObject({ status: 'queued', driveSeconds: null }); // left to ffmpeg
  });

  it('stores internal meetings with ids, start time and status only', async () => {
    const invite: InviteInfo = { title: 'Team standup', attendees: [{ email: 'owner@studio.in', name: 'Owner', self: true }, { email: 'asha@studio.in', name: 'Asha', self: false }] };
    addConference(api, { id: 'c1', start: ago(3), invite, names: ['Asha'] });
    addConference(api, { id: 'c2', start: ago(2), invite, files: { filec2r1: { durationMs: 400 * 60_000 } } });
    await watcher().discover(signal);
    for (const row of allRows(db)) {
      expect(row).toMatchObject({ status: 'internal', title: '', attendees: [], participants: [], clientId: null, matchKind: null, endedAt: null, driveSeconds: null });
    }
    expect(rowCount(db)).toBe(2);
  });

  it('lists conferences from now − 72 h when the since date is older', async () => {
    addConference(api, { id: 'old', start: ago(73) });
    addConference(api, { id: 'c1', start: ago(71) });
    await watcher().discover(signal);
    expect(api.callsOf('listConferences')).toEqual([[ago(72), NOW]]);
    expect(allRows(db).map((r) => r.conference)).toEqual(['conferenceRecords/c1']);
  });

  it('never fetches conferences before the since date (midnight IST)', async () => {
    addConference(api, { id: 'before', start: '2026-10-21T18:29:00.000Z' });
    addConference(api, { id: 'after', start: '2026-10-21T18:30:00.000Z' });
    await watcher({ settings: { since: '2026-10-22' } }).discover(signal);
    expect(api.callsOf('listConferences')).toEqual([['2026-10-21T18:30:00.000Z', NOW]]);
    expect(allRows(db).map((r) => r.conference)).toEqual(['conferenceRecords/after']);
  });

  it('asks nothing when the since date is still ahead', async () => {
    expect(await watcher({ settings: { since: '2026-10-24' } }).discover(signal)).toEqual({ added: 0, skipped: 0, errors: 0 });
    expect(api.calls).toEqual([]);
  });

  it('skips settled conferences without listing their recordings', async () => {
    for (let i = 0; i < 200; i++) {
      const id = `old${i}`;
      const start = ago(70 - i * 0.2); // all inside the window, all ended more than 24 h ago
      addConference(api, { id, start });
      insertFound(db, {
        recording: `conferenceRecords/${id}/recordings/${id}r1`, conference: `conferenceRecords/${id}`, driveFileId: `file${id}r1`, meetingCode: null,
        title: '', startedAt: start, endedAt: null, attendees: [], participants: [], clientId: null, matchKind: null, status: 'unassigned',
        driveSeconds: null, createdAt: NOW,
      });
    }
    addConference(api, { id: 'fresh', start: ago(3) }); // ended under 24 h ago: still listed
    expect(await watcher().discover(signal)).toEqual({ added: 1, skipped: 200, errors: 0 });
    expect(api.callsOf('listRecordings')).toEqual([['conferenceRecords/fresh']]);
  });

  it('lists recordings again for an old conference with nothing known yet', async () => {
    addConference(api, { id: 'c1', start: ago(60) });
    expect(await watcher().discover(signal)).toEqual({ added: 1, skipped: 0, errors: 0 });
  });

  it('stops the pass on an access error and changes no rows', async () => {
    addConference(api, { id: 'c1', start: ago(5) });
    addConference(api, { id: 'c2', start: ago(4) });
    addConference(api, { id: 'c3', start: ago(3) });
    const real = api.videoInfo.bind(api);
    api.videoInfo = async (fileId, s) => {
      if (fileId === 'filec2r1') throw new GoogleAccessError('http_401');
      return real(fileId, s);
    };
    await expect(watcher().discover(signal)).rejects.toBeInstanceOf(GoogleAccessError);
    expect(rowCount(db)).toBe(0);
    expect(api.callsOf('listRecordings')).toEqual([['conferenceRecords/c1'], ['conferenceRecords/c2']]);
  });

  it('skips only the conference with a transient or no-access error, logging its id and code only', async () => {
    addConference(api, { id: 'c1', start: ago(5) });
    addConference(api, { id: 'c2', start: ago(4) });
    addConference(api, { id: 'c3', start: ago(3) });
    api.files.delete('filec3r1'); // GoogleNoAccessError http_404
    const real = api.findInvite.bind(api);
    api.findInvite = async (code, start, s) => {
      if (code === 'code-c1') throw new GoogleTransientError('http_503');
      return real(code, start, s);
    };
    const { lines, log } = capture();
    expect(await watcher({ log }).discover(signal)).toEqual({ added: 1, skipped: 0, errors: 2 });
    expect(allRows(db).map((r) => r.conference)).toEqual(['conferenceRecords/c2']);
    const text = lines.join('');
    expect(text).toContain('conferenceRecords/c1');
    expect(text).toContain('http_503');
    expect(text).toContain('conferenceRecords/c3');
    expect(text).toContain('http_404');
    for (const secret of ['Sharma Interiors review', 'sharma.in', 'Ravi', 'Owner']) expect(text).not.toContain(secret);
  });

  it('rethrows a stop and stores nothing', async () => {
    addConference(api, { id: 'c1', start: ago(3) });
    const ac = new AbortController();
    const real = api.meetingCode.bind(api);
    api.meetingCode = async (space, s) => {
      ac.abort(new Error('stop'));
      return real(space, s);
    };
    await expect(watcher().discover(ac.signal)).rejects.toThrow('stop');
    expect(rowCount(db)).toBe(0);
  });

  it('uses clients given later through setClients', async () => {
    addConference(api, { id: 'c1', start: ago(5), invite: { title: 'Gupta Traders intro', attendees: [] } });
    const w = watcher();
    await w.discover(signal);
    expect(allRows(db)[0]).toMatchObject({ status: 'unassigned' });

    syncClients(db, [SHARMA, MEHTA, GUPTA]); // id 3
    w.setClients([SHARMA, MEHTA, GUPTA]);
    addConference(api, { id: 'c2', start: ago(4), invite: { title: 'Gupta Traders intro', attendees: [] } });
    await w.discover(signal);
    expect(allRows(db)[1]).toMatchObject({ status: 'queued', clientId: 3, matchKind: 'title' });
  });

  it('ignores a configured client whose tracker row is inactive or missing', async () => {
    syncClients(db, [MEHTA]); // Sharma becomes inactive
    addConference(api, { id: 'c1', start: ago(5) });
    addConference(api, { id: 'c2', start: ago(4), invite: { title: 'Gupta Traders intro', attendees: [] } });
    await watcher({ clients: [SHARMA, MEHTA, GUPTA] }).discover(signal);
    expect(allRows(db).map((r) => r.status)).toEqual(['unassigned', 'unassigned']);
  });
});

describe('MeetingWatcher.backfill', () => {
  it('in a dry run stores nothing and says what would be added', async () => {
    addConference(api, { id: 'c1', start: '2026-09-10T05:00:00.000Z' });
    addConference(api, { id: 'c2', start: '2026-09-11T05:00:00.000Z', files: { filec2r1: { durationMs: null } } });
    const w = watcher();
    const plan = await w.backfill('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', signal, { dryRun: true });
    expect(plan).toMatchObject({ added: 2, skipped: 0, errors: 0, ids: [] });
    expect(plan.found).toEqual([
      { recording: 'conferenceRecords/c1/recordings/c1r1', startedAt: '2026-09-10T05:00:00.000Z', status: 'queued', clientId: 1, driveSeconds: 2700 },
      { recording: 'conferenceRecords/c2/recordings/c2r1', startedAt: '2026-09-11T05:00:00.000Z', status: 'queued', clientId: 1, driveSeconds: null },
    ]);
    expect(rowCount(db)).toBe(0);
    expect(api.callsOf('listConferences')).toEqual([['2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z']]);

    const real = await w.backfill('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', signal);
    expect(real.added).toBe(2);
    expect(real.ids).toEqual(allRows(db).map((r) => r.id));
    expect(await w.backfill('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', signal)).toMatchObject({ added: 0, skipped: 2, ids: [] });
  });
});
