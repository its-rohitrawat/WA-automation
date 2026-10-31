import { Writable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ClientConfig } from '../../src/config/groups.ts';
import type { DriveVideoInfo, InviteInfo, RecordingRef } from '../../src/meetings/googleApi.ts';
import { GoogleAccessError, GoogleTransientError } from '../../src/meetings/googleErrors.ts';
import {
  buildRow, cleanEmail, cleanNames, inviteFacts, meetingsSince, MeetingWatcher, titleFromFileName, type RowFacts, type WatcherSettings,
} from '../../src/meetings/watcher.ts';
import { getKv } from '../../src/store/kv.ts';
import { syncClients } from '../../src/store/clients.ts';
import type { Db } from '../../src/store/db.ts';
import { getMeeting, insertFound } from '../../src/store/meetings.ts';
import { manualClock, type ManualClock } from '../../src/util/clock.ts';
import { createLogger, silentLogger, type Logger } from '../../src/util/logger.ts';
import { idOf, row, rows as rowsOf, testDb } from '../helpers/db.ts';
import { FakeMeetingsApi } from '../helpers/fakeMeetings.ts';

const PHASES = ['Discovery', 'Design', 'Development', 'Review', 'Launch'];
const SHARMA: ClientConfig = {
  groupId: '120363000000000001@g.us', name: 'Sharma Interiors', code: 'SHA', phases: PHASES, emailDomains: ['sharma.example'], meetingKeywords: ['villa project'],
};
const MEHTA: ClientConfig = {
  groupId: '120363000000000002@g.us', name: 'Mehta Foods', code: 'MEH', phases: PHASES, emailDomains: ['mehtafoods.example'], meetingKeywords: [],
};
const GUPTA: ClientConfig = {
  groupId: '120363000000000003@g.us', name: 'Gupta Traders', code: 'GUP', phases: PHASES, emailDomains: [], meetingKeywords: [],
};

const NOW = '2026-10-23T06:00:00.000Z';
const HOUR = 3_600_000;
const ago = (hours: number): string => new Date(Date.parse(NOW) - hours * HOUR).toISOString();
const SETTINGS: WatcherSettings = { teamDomains: ['studio.example'], maxMinutes: 180, since: '2026-10-01' };

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
    api.invites.set(code, s.invite ?? { title: 'Sharma Interiors review', attendees: [{ email: 'owner@studio.example', name: 'Owner', self: true }, { email: 'Ravi@Sharma.example', name: 'Ravi', self: false }] });
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

const rowCount = async (db: Db): Promise<number> => (await row<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM meetings'))!.n;
const allRows = async (db: Db) => {
  const rows = [];
  for (const r of await rowsOf<{ id: number }>(db, 'SELECT id FROM meetings ORDER BY id')) rows.push((await getMeeting(db, r.id))!);
  return rows;
};

function capture(): { lines: string[]; log: Logger } {
  const lines: string[] = [];
  const sink = new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } });
  return { lines, log: createLogger('debug', sink) };
}

let db: Db;
/** Sharma's and Mehta's real ids in the test running now (on Postgres ids are shared by every customer). */
let ids: { sharma: number; mehta: number };
let api: FakeMeetingsApi;
let clock: ManualClock;
const signal = new AbortController().signal;

function watcher(o: { log?: Logger; settings?: Partial<WatcherSettings>; clients?: ClientConfig[] } = {}): MeetingWatcher {
  return new MeetingWatcher({ db, api, clock, log: o.log ?? silentLogger(), settings: { ...SETTINGS, ...o.settings }, clients: o.clients ?? [SHARMA, MEHTA] });
}

beforeEach(async () => {
  db = await testDb();
  await syncClients(db, [SHARMA, MEHTA]);
  ids = { sharma: await idOf(db, SHARMA.code), mehta: await idOf(db, MEHTA.code) };
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
  it("drops Meet's newer ' - YYYY/MM/DD HH:MM GMT±hh:mm - Recording' suffix", () => {
    expect(titleFromFileName('Sharma Interiors sync - 2026/10/23 10:00 GMT+05:30 - Recording')).toBe('Sharma Interiors sync');
    expect(titleFromFileName('Sharma Interiors sync - 2026/10/23 10:00 GMT+05:30 - Recording.mp4')).toBe('Sharma Interiors sync');
    expect(titleFromFileName('abc-defg-hij - 2026/10/23 04:30 GMT-04:00 - Recording')).toBe('abc-defg-hij');
    expect(titleFromFileName('Weekly - Recording notes')).toBe('Weekly - Recording notes');
  });
});

describe('cleanEmail', () => {
  it('keeps a plain address, lower-cased', () => {
    expect(cleanEmail('Ravi.K+x@Mail.Sharma.EXAMPLE')).toBe('ravi.k+x@mail.sharma.example');
  });
  it('drops anything that is not one plain address', () => {
    for (const e of [
      'ravi@sharma.example\nx@evil.example', 'ra\u200bvi@sharma.example', 'ravi @sharma.example', ' ravi@sharma.example', 'ravi@sharma.example\u0000', '@sharma.example',
      'a@b@sharma.example', 'ravi', 'ravi@', 'ravi@sharma', 'ravi@.sharma.example', 'ravi@sharma..example', `${'a'.repeat(250)}@x.example`,
    ]) {
      expect(cleanEmail(e)).toBeNull();
    }
  });
});

const facts = (o: Partial<RowFacts> = {}): RowFacts => ({
  recording: 'conferenceRecords/c1/recordings/r1', conference: 'conferenceRecords/c1', driveFileId: 'f1', meetingCode: 'abc-defg-hij',
  startedAt: ago(3), endedAt: ago(2), createdAt: NOW, title: 'Sharma Interiors review',
  attendees: [{ email: 'ravi@sharma.example', name: 'Ravi', team: false }], participants: ['Ravi'],
  match: { kind: 'client', clientId: 1, by: 'title' }, durationMs: 45 * 60_000, noAccessCode: null, maxMinutes: 180, ...o,
});
const LONG = 181 * 60_000;
const INTERNAL = { kind: 'internal' } as const;
const NONE = { kind: 'unassigned', reason: 'none' } as const;

describe('buildRow status order', () => {
  it('internal first: minimal data, no_access when the file was refused, even when too long', () => {
    const minimal = { title: '', endedAt: null, attendees: [], participants: [], clientId: null, matchKind: null, driveSeconds: null };
    expect(buildRow(facts({ match: INTERNAL, durationMs: LONG }))).toMatchObject({ ...minimal, status: 'internal', errorCode: null });
    expect(buildRow(facts({ match: INTERNAL, durationMs: LONG })).foundInternal).toBeUndefined();
    expect(buildRow(facts({ match: INTERNAL, durationMs: null, noAccessCode: 'http_404' }))).toMatchObject({
      ...minimal, status: 'no_access', errorCode: 'http_404', foundInternal: true,
    });
  });
  it('then no_access, keeping the client match', () => {
    expect(buildRow(facts({ durationMs: null, noAccessCode: 'http_403' }))).toMatchObject({ status: 'no_access', clientId: 1, matchKind: 'title', errorCode: 'http_403', driveSeconds: null });
    expect(buildRow(facts({ match: NONE, durationMs: null, noAccessCode: 'http_404' }))).toMatchObject({ status: 'no_access', clientId: null });
    expect(buildRow(facts({ match: NONE, durationMs: null, noAccessCode: 'http_404' })).foundInternal).toBeUndefined();
  });
  it('then too_long by Drive length, keeping the client match', () => {
    expect(buildRow(facts({ durationMs: LONG }))).toMatchObject({ status: 'too_long', clientId: 1, driveSeconds: 181 * 60, errorCode: null });
    expect(buildRow(facts({ match: NONE, durationMs: LONG }))).toMatchObject({ status: 'too_long', clientId: null });
  });
  it('then queued for a client, else unassigned; no Drive length is never too long', () => {
    expect(buildRow(facts())).toMatchObject({ status: 'queued', clientId: 1, matchKind: 'title', title: 'Sharma Interiors review', endedAt: ago(2) });
    expect(buildRow(facts({ durationMs: null }))).toMatchObject({ status: 'queued', driveSeconds: null });
    expect(buildRow(facts({ match: { kind: 'unassigned', reason: 'ambiguous' } }))).toMatchObject({ status: 'unassigned', clientId: null, matchKind: null });
  });
});

describe('MeetingWatcher.discover', () => {
  it('drops attendee addresses that are not plain, for storing and for matching', async () => {
    addConference(api, {
      id: 'c1',
      start: ago(3),
      invite: {
        title: 'Weekly',
        attendees: [
          { email: 'om@mehtafoods.example\nx@sharma.example', name: 'A', self: false },
          { email: 'ra\u200bvi@sharma.example', name: 'B', self: false },
          { email: 'asha@studio.example', name: 'C', self: false },
          { email: 'x@elsewhere.example', name: 'D', self: false },
        ],
      },
    });
    await watcher().discover(signal);
    const [row] = await allRows(db);
    expect(row!.attendees).toEqual([{ email: 'asha@studio.example', name: 'C', team: true }, { email: 'x@elsewhere.example', name: 'D', team: false }]);
    expect(row).toMatchObject({ status: 'unassigned', clientId: null }); // the dropped addresses match no client
  });

  it('ignores a client email domain that has a team domain under it, logging the client code only', async () => {
    const clash: ClientConfig = { ...MEHTA, emailDomains: ['mehtafoods.example', 'studio.example'] };
    const { lines, log } = capture();
    const w = watcher({ log, clients: [SHARMA, clash], settings: { teamDomains: ['eng.studio.example'] } });
    addConference(api, { id: 'c1', start: ago(3), invite: { title: 'Weekly', attendees: [{ email: 'x@studio.example', name: null, self: false }] } });
    await w.discover(signal);
    expect((await allRows(db))[0]).toMatchObject({ status: 'unassigned', clientId: null });
    const text = lines.join('');
    expect(text).toContain('MEH');
    expect(text).not.toContain('studio.example');
  });


  it('stores a matched meeting once, with its title, attendees and participants', async () => {
    addConference(api, { id: 'c1', start: ago(3), names: ['Ravi Sharma', ' Owner '] });
    const w = watcher();
    expect(await w.discover(signal)).toEqual({ added: 1, skipped: 0, errors: 0 });
    const [row] = await allRows(db);
    expect(row).toMatchObject({
      recording: 'conferenceRecords/c1/recordings/c1r1',
      conference: 'conferenceRecords/c1',
      driveFileId: 'filec1r1',
      meetingCode: 'code-c1',
      title: 'Sharma Interiors review',
      startedAt: ago(3),
      attendees: [{ email: 'owner@studio.example', name: 'Owner', team: true }, { email: 'ravi@sharma.example', name: 'Ravi', team: false }],
      participants: ['Ravi Sharma', 'Owner'],
      clientId: ids.sharma,
      matchKind: 'title',
      status: 'queued',
      driveSeconds: 2700,
      createdAt: NOW,
    });
    expect(api.callsOf('findInvite')).toEqual([['code-c1', ago(3)]]);

    clock.advance(5 * 60_000);
    expect(await w.discover(signal)).toEqual({ added: 0, skipped: 1, errors: 0 });
    expect(await rowCount(db)).toBe(1);
    expect(api.callsOf('videoInfo')).toHaveLength(1); // a known recording is not looked at again
  });

  it('stores two rows for two recordings of one conference', async () => {
    addConference(api, { id: 'c1', start: ago(3), recordings: [{ id: 'a' }, { id: 'b', startTime: ago(2.5) }] });
    expect(await watcher().discover(signal)).toEqual({ added: 2, skipped: 0, errors: 0 });
    const rows = await allRows(db);
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
    const [a, b] = await allRows(db);
    expect(a).toMatchObject({ title: 'Sharma Interiors sync', meetingCode: null, attendees: [], clientId: ids.sharma, matchKind: 'title', status: 'queued' });
    expect(b).toMatchObject({ title: 'Mehta Foods call', clientId: ids.mehta, status: 'queued' });
    expect(api.callsOf('findInvite').map((c) => c[0])).toEqual(['code-c2']); // no code, no invite lookup
  });

  it('cleans and caps titles and names, and drops attendees without an address', async () => {
    const longTitle = `Sharma Interiors\n${'x'.repeat(300)}`;
    addConference(api, {
      id: 'c1',
      start: ago(3),
      invite: { title: longTitle, attendees: [{ email: 'Ravi@Sharma.example', name: `Ra\u200bvi\n${'y'.repeat(150)}`, self: false }, { email: 'board-room', name: 'Board', self: false }] },
      names: ['  ', 'Ravi\tS', 'z'.repeat(150)],
    });
    await watcher().discover(signal);
    const [row] = await allRows(db);
    expect(row!.title.startsWith('Sharma Interiors x')).toBe(true);
    expect([...row!.title]).toHaveLength(200);
    expect(row!.attendees).toHaveLength(1);
    expect(row!.attendees[0]!.email).toBe('ravi@sharma.example');
    expect(row!.attendees[0]!.name!.startsWith('Ravi y')).toBe(true);
    expect([...row!.attendees[0]!.name!]).toHaveLength(100);
    expect(row!.participants).toEqual(['Ravi S', 'z'.repeat(100)]);
  });

  it('matches by domain, and leaves unmatched meetings unassigned', async () => {
    addConference(api, { id: 'c1', start: ago(3), invite: { title: 'Weekly', attendees: [{ email: 'om@mail.mehtafoods.example', name: null, self: false }] } });
    addConference(api, { id: 'c2', start: ago(2), invite: { title: 'Weekly', attendees: [{ email: 'x@elsewhere.example', name: null, self: false }] } });
    await watcher().discover(signal);
    const [a, b] = await allRows(db);
    expect(a).toMatchObject({ clientId: ids.mehta, matchKind: 'domain', status: 'queued' });
    expect(b).toMatchObject({ clientId: null, matchKind: null, status: 'unassigned', title: 'Weekly' });
  });

  it('marks a meeting longer than the limit too_long by Drive length, and keeps its client', async () => {
    addConference(api, { id: 'c1', start: ago(5), files: { filec1r1: { durationMs: 181 * 60_000 } } });
    addConference(api, { id: 'c2', start: ago(4), files: { filec2r1: { durationMs: 180 * 60_000 } } });
    addConference(api, { id: 'c3', start: ago(3), files: { filec3r1: { durationMs: null } } });
    await watcher().discover(signal);
    const [a, b, c] = await allRows(db);
    expect(a).toMatchObject({ status: 'too_long', clientId: ids.sharma, matchKind: 'title', driveSeconds: 181 * 60 });
    expect(b).toMatchObject({ status: 'queued', driveSeconds: 180 * 60 });
    expect(c).toMatchObject({ status: 'queued', driveSeconds: null }); // left to ffmpeg
  });

  it('stores internal meetings with ids, start time and status only', async () => {
    const invite: InviteInfo = { title: 'Team standup', attendees: [{ email: 'owner@studio.example', name: 'Owner', self: true }, { email: 'asha@studio.example', name: 'Asha', self: false }] };
    addConference(api, { id: 'c1', start: ago(3), invite, names: ['Asha'] });
    addConference(api, { id: 'c2', start: ago(2), invite, files: { filec2r1: { durationMs: 400 * 60_000 } } });
    await watcher().discover(signal);
    for (const row of (await allRows(db))) {
      expect(row).toMatchObject({ status: 'internal', title: '', attendees: [], participants: [], clientId: null, matchKind: null, endedAt: null, driveSeconds: null });
    }
    expect(await rowCount(db)).toBe(2);
    expect(api.callsOf('listSignedInNames')).toEqual([]); // names are never read for an internal meeting
  });

  it('lists conferences from now − 72 h when the since date is older', async () => {
    addConference(api, { id: 'old', start: ago(73) });
    addConference(api, { id: 'c1', start: ago(71) });
    await watcher().discover(signal);
    expect(api.callsOf('listConferences')).toEqual([[ago(72), NOW]]);
    expect((await allRows(db)).map((r) => r.conference)).toEqual(['conferenceRecords/c1']);
  });

  it('never fetches conferences before the since date (midnight IST)', async () => {
    addConference(api, { id: 'before', start: '2026-10-21T18:29:00.000Z' });
    addConference(api, { id: 'after', start: '2026-10-21T18:30:00.000Z' });
    await watcher({ settings: { since: '2026-10-22' } }).discover(signal);
    expect(api.callsOf('listConferences')).toEqual([['2026-10-21T18:30:00.000Z', NOW]]);
    expect((await allRows(db)).map((r) => r.conference)).toEqual(['conferenceRecords/after']);
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
      await insertFound(db, {
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
    expect(await rowCount(db)).toBe(0);
    expect(api.callsOf('listRecordings')).toEqual([['conferenceRecords/c1'], ['conferenceRecords/c2']]);
  });

  it('skips only the conference with a transient error, and stores an unreadable file as no_access, logging ids and codes only', async () => {
    addConference(api, { id: 'c1', start: ago(5) });
    addConference(api, { id: 'c2', start: ago(4) });
    addConference(api, { id: 'c3', start: ago(3), recordings: [{ id: 'a' }, { id: 'b' }] });
    api.files.delete('filea'); // GoogleNoAccessError http_404
    const real = api.findInvite.bind(api);
    api.findInvite = async (code, start, s) => {
      if (code === 'code-c1') throw new GoogleTransientError('http_503');
      return real(code, start, s);
    };
    const { lines, log } = capture();
    expect(await watcher({ log }).discover(signal)).toEqual({ added: 3, skipped: 0, errors: 1 });
    const rows = await allRows(db);
    expect(rows.map((r) => [r.recording, r.status])).toEqual([
      ['conferenceRecords/c2/recordings/c2r1', 'queued'],
      ['conferenceRecords/c3/recordings/a', 'no_access'],
      ['conferenceRecords/c3/recordings/b', 'queued'],
    ]);
    expect(rows[1]).toMatchObject({ title: 'Sharma Interiors review', clientId: ids.sharma, matchKind: 'title', driveSeconds: null, errorCode: 'http_404' });
    expect(rows[2]!.errorCode).toBeNull();
    const text = lines.join('');
    expect(text).toContain('conferenceRecords/c1');
    expect(text).toContain('http_503');
    expect(text).toContain('conferenceRecords/c3/recordings/a');
    expect(text).toContain('http_404');
    for (const secret of ['Sharma Interiors review', 'sharma.example', 'Ravi', 'Owner']) expect(text).not.toContain(secret);

    api.findInvite = real;
    clock.advance(5 * 60_000);
    expect(await watcher().discover(signal)).toMatchObject({ added: 1, errors: 0 }); // c1 only: the no_access row is not retried
    expect(api.callsOf('videoInfo').filter((c) => c[0] === 'filea')).toHaveLength(1);
  });

  it('stores an unreadable internal recording as no_access with the minimal data only', async () => {
    const invite: InviteInfo = { title: 'Team standup', attendees: [{ email: 'asha@studio.example', name: 'Asha', self: false }] };
    addConference(api, { id: 'c1', start: ago(3), invite, names: ['Asha'] });
    api.files.delete('filec1r1');
    await watcher().discover(signal);
    expect((await allRows(db))[0]).toMatchObject({
      status: 'no_access', errorCode: 'http_404', title: '', attendees: [], participants: [], clientId: null, matchKind: null, endedAt: null, driveSeconds: null,
    });
  });

  it('gives an unreadable file with no invite an empty title', async () => {
    addConference(api, { id: 'c1', start: ago(3), code: null });
    api.files.delete('filec1r1');
    await watcher().discover(signal);
    expect((await allRows(db))[0]).toMatchObject({ status: 'no_access', title: '', clientId: null, errorCode: 'http_404' });
  });

  it('ignores a client email domain that is, or is under, a team domain, logging the client code only', async () => {
    const clash: ClientConfig = { ...MEHTA, emailDomains: ['mehtafoods.example', 'studio.example', 'eng.studio.example'] };
    const { lines, log } = capture();
    const w = watcher({ log, clients: [SHARMA, clash] });
    addConference(api, { id: 'c1', start: ago(4), invite: { title: 'Weekly', attendees: [{ email: 'x@elsewhere.example', name: null, self: false }, { email: 'dev@eng.studio.example', name: null, self: false }] } });
    addConference(api, { id: 'c2', start: ago(3), invite: { title: 'Weekly', attendees: [{ email: 'om@mehtafoods.example', name: null, self: false }] } });
    await w.discover(signal);
    expect((await allRows(db)).map((r) => [r.status, r.clientId])).toEqual([['unassigned', null], ['queued', ids.mehta]]);
    const text = lines.join('');
    expect(text).toContain('MEH');
    expect(text).not.toContain('studio.example');

    lines.length = 0;
    w.setClients([SHARMA, clash]);
    expect(lines.join('')).toContain('MEH');
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
    expect(await rowCount(db)).toBe(0);
  });

  it('uses clients given later through setClients', async () => {
    addConference(api, { id: 'c1', start: ago(5), invite: { title: 'Gupta Traders intro', attendees: [] } });
    const w = watcher();
    await w.discover(signal);
    expect((await allRows(db))[0]).toMatchObject({ status: 'unassigned' });

    await syncClients(db, [SHARMA, MEHTA, GUPTA]);
    w.setClients([SHARMA, MEHTA, GUPTA]);
    addConference(api, { id: 'c2', start: ago(4), invite: { title: 'Gupta Traders intro', attendees: [] } });
    await w.discover(signal);
    expect((await allRows(db))[1]).toMatchObject({ status: 'queued', clientId: await idOf(db, GUPTA.code), matchKind: 'title' });
  });

  it('ignores a configured client whose tracker row is inactive or missing', async () => {
    await syncClients(db, [MEHTA]); // Sharma becomes inactive
    addConference(api, { id: 'c1', start: ago(5) });
    addConference(api, { id: 'c2', start: ago(4), invite: { title: 'Gupta Traders intro', attendees: [] } });
    await watcher({ clients: [SHARMA, MEHTA, GUPTA] }).discover(signal);
    expect((await allRows(db)).map((r) => r.status)).toEqual(['unassigned', 'unassigned']);
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
      { recording: 'conferenceRecords/c1/recordings/c1r1', startedAt: '2026-09-10T05:00:00.000Z', status: 'queued', clientId: ids.sharma, driveSeconds: 2700, match: 'client' },
      { recording: 'conferenceRecords/c2/recordings/c2r1', startedAt: '2026-09-11T05:00:00.000Z', status: 'queued', clientId: ids.sharma, driveSeconds: null, match: 'client' },
    ]);
    expect(await rowCount(db)).toBe(0);
    expect(api.callsOf('listConferences')).toEqual([['2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z']]);

    const real = await w.backfill('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', signal);
    expect(real.added).toBe(2);
    expect(real.ids).toEqual((await allRows(db)).map((r) => r.id));
    expect(await w.backfill('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', signal)).toMatchObject({ added: 0, skipped: 2, ids: [] });
  });
});

describe('meetingsSince (M3)', () => {
  it('is MEETINGS_SINCE when set, else the IST day meetings were first seen on, kept across restarts', async () => {
    const db = await testDb();
    expect(await meetingsSince(db, '2026-09-01', new Date('2026-10-23T06:00:00.000Z'))).toBe('2026-09-01');
    expect(await getKv(db, 'meetings_since')).toBeUndefined();
    // 20:00 UTC on 23 Oct is 01:30 on 24 Oct in India.
    expect(await meetingsSince(db, undefined, new Date('2026-10-23T20:00:00.000Z'))).toBe('2026-10-24');
    expect(await meetingsSince(db, undefined, new Date('2026-11-05T06:00:00.000Z'))).toBe('2026-10-24');
  });
});

describe('inviteFacts and cleanNames', () => {
  it('clean an invite and names as discovery stores them', () => {
    const f = inviteFacts({ title: '  Brand\nreview\u202e ', attendees: [{ email: 'A@Sharma.example', name: ' Asha ', self: false }, { email: 'not an email', name: 'X', self: false }] }, ['studio.example']);
    expect(f.title).toBe('Brand review');
    expect(f.attendees).toEqual([{ email: 'a@sharma.example', name: 'Asha', team: false }]);
    expect(f.invited).toEqual([{ email: 'a@sharma.example', name: ' Asha ', self: false }]);
    expect(inviteFacts(null, [])).toEqual({ invited: [], attendees: [], title: '' });
    expect(cleanNames(['Asha', ' Asha ', '', 'Ravi'])).toEqual(['Asha', 'Ravi']);
  });
});
