import { describe, expect, it } from 'vitest';
import { ControlError } from '../../src/control/errors.ts';
import { listDashboardMeetings, meetingDetail, meetingDocUrl, parseMeetingList } from '../../src/control/meetingQueries.ts';
import type { Db } from '../../src/store/db.ts';
import { insertFound, type MeetingStage, type MeetingStatus } from '../../src/store/meetings.ts';
import { createTask } from '../../src/store/tasks.ts';
import { NOW, seededDb } from '../helpers/db.ts';

const now = new Date(NOW);
const DOC = 'abcdefghij_KLMNOP-123';

interface Over {
  status?: MeetingStatus;
  stage?: MeetingStage;
  clientId?: number | null;
  title?: string;
  startedAt?: string;
  seconds?: number | null;
  audioSeconds?: number;
  doc?: string;
  summary?: string;
  errorCode?: string;
  nextAttemptAt?: string;
}

let n = 0;
function meeting(db: Db, o: Over = {}): number {
  n++;
  const status = o.status ?? 'done';
  const internal = status === 'internal';
  const id = insertFound(db, {
    recording: `conferenceRecords/c${n}/recordings/r${n}`, conference: `conferenceRecords/c${n}`, driveFileId: `drive${n}`, meetingCode: null,
    title: internal ? '' : (o.title ?? `Meeting ${n}`), startedAt: o.startedAt ?? `2026-10-1${n % 10}T05:00:00.000Z`, endedAt: null,
    attendees: [], participants: [], clientId: o.clientId === undefined ? (status === 'unassigned' || internal ? null : 1) : o.clientId,
    matchKind: 'title', status, driveSeconds: o.seconds === undefined ? 1800 : o.seconds, createdAt: NOW,
  })!;
  db.raw.prepare(`UPDATE meetings SET stage = COALESCE(?, stage), audio_seconds = ?, doc_file_id = ?, summary = ?, error_code = ?, next_attempt_at = ?
    WHERE id = ?`).run(o.stage ?? (status === 'done' ? 'tracked' : null), o.audioSeconds ?? null, o.doc ?? null, o.summary ?? null, o.errorCode ?? null,
    o.nextAttemptAt ?? null, id);
  return id;
}

const SUMMARY = JSON.stringify({
  whatHappened: 'Talked about the <script>logo</script>', discussion: [{ topic: 'Logo', summary: 'Colours' }],
  decisions: [{ text: 'Blue', segmentIds: ['s1'] }],
  actionItems: [{ side: 'us', task: 'Send logo', owner: 'Rahul', deadline: '', segmentIds: ['s1'] }],
  openQuestions: ['Font?'], conclusion: 'Good', speakers: [{ label: 'A', name: 'Rahul' }],
});

const list = async (db: Db, o: Record<string, string> = {}, accountOf?: (c: string) => string | null) =>
  await listDashboardMeetings(db, parseMeetingList(new URLSearchParams(o)), now, accountOf);
const ids = (r: { rows: { id: number }[] }) => r.rows.map((x) => x.id);

describe('parseMeetingList', () => {
  it('defaults to all, and refuses an unknown view', () => {
    expect(parseMeetingList(new URLSearchParams())).toEqual({ view: 'all', limit: 100, offset: 0 });
    expect(() => parseMeetingList(new URLSearchParams({ view: 'late' }))).toThrowError(ControlError);
    expect(() => parseMeetingList(new URLSearchParams({ limit: '0' }))).toThrowError(ControlError);
    expect(parseMeetingList(new URLSearchParams({ limit: '9999' })).limit).toBe(500);
  });
});

describe('listDashboardMeetings', () => {
  it('filters by view: ready is done, progress is queued, attention is what needs the owner', async () => {
    const db = await seededDb();
    const done = meeting(db, { status: 'done', startedAt: '2026-10-18T05:00:00.000Z' });
    const queued = meeting(db, { status: 'queued', stage: 'audio', startedAt: '2026-10-17T05:00:00.000Z' });
    const unassigned = meeting(db, { status: 'unassigned', startedAt: '2026-10-16T05:00:00.000Z' });
    const tooLong = meeting(db, { status: 'too_long', startedAt: '2026-10-15T05:00:00.000Z' });
    const noAccess = meeting(db, { status: 'no_access', startedAt: '2026-10-14T05:00:00.000Z' });
    const failed = meeting(db, { status: 'failed', startedAt: '2026-10-13T05:00:00.000Z' });
    const skipped = meeting(db, { status: 'skipped', startedAt: '2026-10-12T05:00:00.000Z' });
    const internal = meeting(db, { status: 'internal', startedAt: '2026-10-11T05:00:00.000Z' });
    expect(ids(await list(db, { view: 'ready' }))).toEqual([done]);
    expect(ids(await list(db, { view: 'progress' }))).toEqual([queued]);
    expect(ids(await list(db, { view: 'attention' }))).toEqual([unassigned, tooLong, noAccess, failed]);
    expect(await list(db)).toMatchObject({ total: 8 });
    expect(ids(await list(db))).toEqual([done, queued, unassigned, tooLong, noAccess, failed, skipped, internal]); // newest first
  });

  it('returns the row shape: minutes from the audio length when known, the client, the account label and the doc link', async () => {
    const db = await seededDb();
    const id = meeting(db, { title: 'Weekly <b>sync</b>', seconds: 1800, audioSeconds: 1500, doc: DOC, summary: SUMMARY });
    createTask(db, { clientId: 1, side: 'us', title: 'Send logo', category: 'design', priority: 'medium', assignedTo: null, askedBy: null, raisedOn: '2026-10-18',
      deadline: null, latestProgress: null, sourceQuote: null, sourceDate: null, sourceWaId: null, origin: 'meeting', meetingId: id }, NOW);
    expect((await list(db, {}, (c) => (c === `conferenceRecords/c${n}` ? 'company2' : null))).rows).toEqual([{
      id, title: 'Weekly <b>sync</b>', when: `2026-10-1${n % 10}T05:00:00.000Z`, minutes: 25, account: 'company2',
      client: { code: 'SHA', name: 'Sharma Interiors' }, status: 'done', stageLabel: 'Ready', actionItems: 1,
      docUrl: `https://docs.google.com/document/d/${DOC}/edit`,
    }]);
  });

  it('gives no minutes, client, account or doc when they are not known', async () => {
    const db = await seededDb();
    meeting(db, { status: 'unassigned', seconds: null });
    expect((await list(db)).rows[0]).toMatchObject({ minutes: null, client: null, account: null, docUrl: null, actionItems: 0 });
  });

  it('labels each status and the queued stages in plain words', async () => {
    const db = await seededDb();
    const label = async (o: Over) => {
      const id = meeting(db, o);
      return (await list(db)).rows.find((r) => r.id === id)!.stageLabel;
    };
    expect(await label({ status: 'queued', stage: 'found' })).toBe('Downloading the recording');
    expect(await label({ status: 'queued', stage: 'audio' })).toBe('Transcribing');
    expect(await label({ status: 'queued', stage: 'transcribed' })).toBe('Writing the summary');
    expect(await label({ status: 'queued', stage: 'summarised' })).toBe('Writing the summary doc');
    expect(await label({ status: 'queued', stage: 'doc' })).toBe('Updating the tracker');
    expect(await label({ status: 'queued', stage: 'audio', errorCode: 'spend_cap', nextAttemptAt: '2026-10-19T09:00:00.000Z' })).toBe('Waiting to try again');
    // A deferral already over: the meeting is due, so it shows its stage.
    expect(await label({ status: 'queued', stage: 'audio', errorCode: 'spend_cap', nextAttemptAt: '2026-10-19T07:00:00.000Z' })).toBe('Transcribing');
    expect(await label({ status: 'done' })).toBe('Ready');
    expect(await label({ status: 'unassigned' })).toBe('Needs a client');
    expect(await label({ status: 'internal' })).toBe('Internal, not processed');
    expect(await label({ status: 'skipped' })).toBe('Skipped');
    expect(await label({ status: 'too_long' })).toBe('Too long to process');
    expect(await label({ status: 'no_access' })).toBe('No access to the recording');
    expect(await label({ status: 'failed' })).toBe('Could not be processed');
  });

  it('pages, counting the total before paging', async () => {
    const db = await seededDb();
    const all = [1, 2, 3, 4].map((d) => meeting(db, { startedAt: `2026-10-0${d}T05:00:00.000Z` })).reverse();
    expect(await list(db, { limit: '2', offset: '1' })).toEqual(expect.objectContaining({ total: 4 }));
    expect(ids(await list(db, { limit: '2', offset: '1' }))).toEqual([all[1], all[2]]);
  });
});

describe('meetingDocUrl', () => {
  it('builds the link only from a Drive id', () => {
    expect(meetingDocUrl(DOC)).toBe(`https://docs.google.com/document/d/${DOC}/edit`);
    for (const bad of [null, '', 'short', 'a/b/../../evil-id', 'javascript:alert(1)', 'abcdefghij?x=1', 'abcdefghij#x', 'x'.repeat(201)]) {
      expect(meetingDocUrl(bad), String(bad)).toBeNull();
    }
  });

  it('leaves a bad stored id out of the list', async () => {
    const db = await seededDb();
    meeting(db, { doc: 'https://evil.example/x' });
    expect((await list(db)).rows[0]!.docUrl).toBeNull();
  });
});

describe('meetingDetail', () => {
  it('adds the summary and the action items from the tasks made from the meeting', async () => {
    const db = await seededDb();
    const id = meeting(db, { summary: SUMMARY, doc: DOC });
    const other = meeting(db);
    createTask(db, { clientId: 1, side: 'us', title: 'Send logo', category: 'design', priority: 'major', assignedTo: 'Rahul', askedBy: null, raisedOn: '2026-10-18',
      deadline: '2026-10-01', latestProgress: null, sourceQuote: null, sourceDate: null, sourceWaId: null, origin: 'meeting', meetingId: id }, NOW);
    createTask(db, { clientId: 1, side: 'us', title: 'Other', category: 'design', priority: 'major', assignedTo: null, askedBy: null, raisedOn: '2026-10-18',
      deadline: null, latestProgress: null, sourceQuote: null, sourceDate: null, sourceWaId: null, origin: 'meeting', meetingId: other }, NOW);
    const d = (await meetingDetail(db, String(id), now))!;
    expect(d).toMatchObject({ id, status: 'done', docUrl: `https://docs.google.com/document/d/${DOC}/edit` });
    expect(d.summary).toEqual({
      whatHappened: 'Talked about the <script>logo</script>', discussion: [{ topic: 'Logo', summary: 'Colours' }], decisions: ['Blue'],
      openQuestions: ['Font?'], conclusion: 'Good',
    });
    expect(d.actionItems).toBe(1);
    expect(d.actionItemTasks).toEqual([{ code: 'SHA-001', title: 'Send logo', owner: 'Rahul', deadline: '2026-10-01', status: 'overdue' }]);
  });

  it('has no summary when none is stored, or the stored one cannot be read', async () => {
    const db = await seededDb();
    expect((await meetingDetail(db, String(meeting(db, { status: 'queued', stage: 'audio' })), now))!.summary).toBeNull();
    expect((await meetingDetail(db, String(meeting(db, { summary: '{"not":"a summary"}' })), now))!.summary).toBeNull();
    expect((await meetingDetail(db, String(meeting(db, { summary: 'not json' })), now))!.summary).toBeNull();
  });

  it('returns undefined for an unknown or badly formed id', async () => {
    const db = await seededDb();
    meeting(db);
    for (const bad of ['999', '0', '-1', '1.5', 'abc', '1 OR 1=1', '']) expect(await meetingDetail(db, bad, now), bad).toBeUndefined();
  });
});

describe('meeting review fixes', () => {
  it('labels a no-access meeting found as internal like the CLI does', async () => {
    const db = await seededDb();
    const id = meeting(db, { status: 'no_access', clientId: null, title: '' });
    db.raw.prepare("UPDATE meetings SET note = 'found_internal' WHERE id = ?").run(id);
    expect((await list(db)).rows[0]!.stageLabel).toBe('Internal, no access to the recording');
  });

  it('a deferral ending exactly now is due; a future next attempt without an error code shows the stage', async () => {
    const db = await seededDb();
    const due = meeting(db, { status: 'queued', stage: 'audio', errorCode: 'spend_cap', nextAttemptAt: NOW });
    const noCode = meeting(db, { status: 'queued', stage: 'audio', nextAttemptAt: '2026-10-19T09:00:00.000Z' });
    const rows = (await list(db)).rows;
    expect(rows.find((r) => r.id === due)!.stageLabel).toBe('Transcribing');
    expect(rows.find((r) => r.id === noCode)!.stageLabel).toBe('Transcribing');
  });

  it('rounds minutes to the nearest', async () => {
    const db = await seededDb();
    meeting(db, { seconds: 1530 });
    expect((await list(db)).rows[0]!.minutes).toBe(26);
  });

  it('accepts offset 0 and refuses a negative one', () => {
    expect(parseMeetingList(new URLSearchParams({ offset: '0' })).offset).toBe(0);
    expect(() => parseMeetingList(new URLSearchParams({ offset: '-1' }))).toThrowError(ControlError);
  });
});
