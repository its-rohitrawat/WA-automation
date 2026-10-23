import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { MeetingSummary } from '../../src/brain/meetingSchema.ts';
import { migrate, type Db } from '../../src/store/db.ts';
import {
  advanceStage, assignMeeting, claimMeeting, deferMeeting, dueMeetingIds, failMeeting, finishMeeting, getMeeting, getMeetingState, insertFound,
  knownRecordings, lastMeetingByClient, listClientMeetings, listUnassigned, meetingStats, retryMeeting, setSttParts, skipMeeting,
  type MeetingStatus, type NewMeeting, type SttPartRow,
} from '../../src/store/meetings.ts';
import { MIGRATIONS } from '../../src/store/migrations.ts';
import { LATER, NOW, seededDb } from '../helpers/db.ts';

const CONF = 'conferenceRecords/c1';
const LATEST = '2026-10-19T10:00:00.000Z';

let seq = 0;
const meeting = (o: Partial<NewMeeting> = {}): NewMeeting => ({
  recording: `${CONF}/recordings/r${++seq}`,
  conference: CONF,
  driveFileId: `file${seq}`,
  meetingCode: 'abc-defg-hij',
  title: 'Sharma weekly',
  startedAt: '2026-10-18T10:00:00.000Z',
  endedAt: '2026-10-18T10:45:00.000Z',
  attendees: [{ email: 'a@sharma.in', name: 'Mr. Sharma', team: false }],
  participants: ['Mr. Sharma'],
  clientId: 1,
  matchKind: 'title',
  status: 'queued',
  driveSeconds: 2700,
  createdAt: NOW,
  ...o,
});

/** Unassigned and internal meetings have no client; internal ones also keep no title, attendees or names. */
const noClient = (status: 'unassigned' | 'internal' | 'skipped'): Partial<NewMeeting> =>
  status === 'internal'
    ? { status, clientId: null, matchKind: null, title: '', attendees: [], participants: [] }
    : { status, clientId: null, matchKind: null };

const summary = (actions: number): MeetingSummary => ({
  whatHappened: 'We met.',
  discussion: [],
  decisions: [],
  actionItems: Array.from({ length: actions }, (_, i) => ({ side: 'us' as const, task: `Task ${i}`, owner: null, deadline: null, segmentIds: ['s1'] })),
  openQuestions: [],
  conclusion: '',
  speakers: [],
});

const part = (index: number, o: Partial<SttPartRow> = {}): SttPartRow => ({
  index, offset: index * 600, seconds: 600, state: 'todo', jobId: null, booked: 'none', segments: null, billedSeconds: null, ...o,
});

function withStatus(db: Db, status: MeetingStatus, o: Partial<NewMeeting> = {}): number {
  const base = status === 'unassigned' || status === 'internal' || status === 'skipped' ? noClient(status) : { status };
  return insertFound(db, meeting({ ...base, ...o }))!;
}

/** A queued meeting taken to stage doc and finished, as the processor would. */
function doneMeeting(db: Db, o: Partial<NewMeeting> = {}, fields: Parameters<typeof advanceStage>[3] = {}): number {
  const id = withStatus(db, 'queued', o);
  advanceStage(db, id, 'doc', fields, NOW);
  finishMeeting(db, id, { at: NOW });
  return id;
}

describe('meetings store', () => {
  it('records a recording once; the second insert returns null', () => {
    const db = seededDb();
    const m = meeting();
    const id = insertFound(db, m);
    expect(id).toBeTypeOf('number');
    expect(insertFound(db, { ...m, title: 'Other' })).toBeNull();
    expect((db.prepare('SELECT COUNT(*) AS n FROM meetings').get() as { n: number }).n).toBe(1);
    expect(getMeeting(db, id!)).toMatchObject({
      id, recording: m.recording, conference: CONF, driveFileId: m.driveFileId, meetingCode: 'abc-defg-hij', title: 'Sharma weekly',
      startedAt: m.startedAt, endedAt: m.endedAt, attendees: m.attendees, participants: ['Mr. Sharma'], clientId: 1, matchKind: 'title',
      status: 'queued', stage: 'found', driveSeconds: 2700, audioPath: null, audioSeconds: null, sttParts: [], transcript: null, summary: null,
      docFileId: null, note: null, errorCode: null, attempts: 0, nextAttemptAt: null, createdAt: NOW, updatedAt: NOW,
    });
    expect(getMeeting(db, 999)).toBeUndefined();
  });

  it('lists the recordings known for a conference', () => {
    const db = seededDb();
    const a = meeting();
    const b = meeting();
    insertFound(db, a);
    insertFound(db, b);
    insertFound(db, meeting({ conference: 'conferenceRecords/c2', recording: 'conferenceRecords/c2/recordings/x' }));
    expect(knownRecordings(db, CONF)).toEqual(new Set([a.recording, b.recording]));
    expect(knownRecordings(db, 'conferenceRecords/none')).toEqual(new Set());
  });

  it('gives due queued meetings oldest first; deferred ones wait for their time; other statuses never', () => {
    const db = seededDb();
    const late = withStatus(db, 'queued', { startedAt: '2026-10-18T12:00:00.000Z' });
    const early = withStatus(db, 'queued', { startedAt: '2026-10-17T12:00:00.000Z' });
    const deferred = withStatus(db, 'queued', { startedAt: '2026-10-16T12:00:00.000Z' });
    withStatus(db, 'unassigned', { startedAt: '2026-10-15T12:00:00.000Z' });
    withStatus(db, 'failed', { startedAt: '2026-10-15T12:00:00.000Z' });
    deferMeeting(db, deferred, { errorCode: 'spend_cap', nextAttemptAt: LATER, at: NOW });
    expect(dueMeetingIds(db, NOW, 10)).toEqual([early, late]);
    expect(dueMeetingIds(db, NOW, 1)).toEqual([early]);
    expect(dueMeetingIds(db, LATER, 10)).toEqual([deferred, early, late]);
  });

  it('stores Google times in canonical form, so an offset or a fraction of a second sorts by time', () => {
    const db = seededDb();
    // As text, each pair sorts the wrong way round: "10:00:00+05:30" after "05:00:00Z", "00.5Z" before "00Z".
    const ist = withStatus(db, 'queued', { startedAt: '2026-10-18T10:00:00+05:30', endedAt: '2026-10-18T10:45:00+05:30' }); // 04:30Z
    const utc = withStatus(db, 'queued', { startedAt: '2026-10-18T05:00:00Z', endedAt: null });
    const half = withStatus(db, 'queued', { startedAt: '2026-10-18T03:00:00.5Z' });
    const whole = withStatus(db, 'queued', { startedAt: '2026-10-18T03:00:00Z' });
    const nanos = withStatus(db, 'queued', { startedAt: '2026-10-18T03:00:00.123456789Z' });
    expect(getMeeting(db, ist)).toMatchObject({ startedAt: '2026-10-18T04:30:00.000Z', endedAt: '2026-10-18T05:15:00.000Z' });
    expect(getMeeting(db, utc)).toMatchObject({ startedAt: '2026-10-18T05:00:00.000Z', endedAt: null });
    expect(getMeeting(db, nanos)!.startedAt).toBe('2026-10-18T03:00:00.123Z');
    expect(dueMeetingIds(db, NOW, 10)).toEqual([whole, nanos, half, ist, utc]);
    expect(() => insertFound(db, meeting({ startedAt: 'yesterday' }))).toThrow(/startedAt is not a time/);
    expect(() => insertFound(db, meeting({ endedAt: '' }))).toThrow(/endedAt is not a time/);
    expect(() => insertFound(db, meeting({ createdAt: '2026-10-19T08:00:00Z' }))).toThrow(/createdAt is not a canonical ISO time/);
  });

  it('refuses times that are not canonical where they are compared as text', () => {
    const db = seededDb();
    const id = withStatus(db, 'queued');
    expect(() => claimMeeting(db, id, { nextAttemptAt: '2026-10-19T09:00:00Z', at: NOW })).toThrow(/nextAttemptAt is not a canonical ISO time/);
    expect(() => claimMeeting(db, id, { nextAttemptAt: LATER, at: '2026-10-19T13:30:00+05:30' })).toThrow(/at is not a canonical ISO time/);
    expect(() => deferMeeting(db, id, { errorCode: 'spend_cap', nextAttemptAt: '2026-10-19 09:00:00', at: NOW })).toThrow(/nextAttemptAt/);
    expect(() => deferMeeting(db, id, { errorCode: 'spend_cap', nextAttemptAt: LATER, at: 'now' })).toThrow(/at is not a canonical/);
    expect(() => dueMeetingIds(db, '2026-10-19T08:00:00Z', 10)).toThrow(/nowIso/);
    expect(() => meetingStats(db, '2026-10-19T08:00Z')).toThrow(/nowIso/);
    expect(getMeetingState(db, id)).toMatchObject({ attempts: 0, errorCode: null, nextAttemptAt: null, updatedAt: NOW });
  });

  it('claims a due meeting once, counting the attempt and clearing the error code; never one not due or not queued', () => {
    const db = seededDb();
    const id = withStatus(db, 'queued');
    deferMeeting(db, id, { errorCode: 'spend_cap', nextAttemptAt: NOW, at: NOW });
    expect(claimMeeting(db, id, { nextAttemptAt: LATER, at: NOW })).toBe(true);
    expect(claimMeeting(db, id, { nextAttemptAt: LATER, at: NOW })).toBe(false);
    expect(getMeetingState(db, id)).toEqual({
      id, status: 'queued', stage: 'found', attempts: 1, errorCode: null, nextAttemptAt: LATER, clientId: 1, updatedAt: NOW,
    });
    expect(dueMeetingIds(db, NOW, 10)).toEqual([]);
    expect(claimMeeting(db, id, { nextAttemptAt: LATEST, at: LATER })).toBe(true);
    expect(claimMeeting(db, withStatus(db, 'unassigned'), { nextAttemptAt: LATER, at: NOW })).toBe(false);
    expect(getMeetingState(db, 999)).toBeUndefined();
  });

  it('a stage that never finishes runs up the attempt count, claim after claim', () => {
    const db = seededDb();
    const id = withStatus(db, 'queued');
    const FAIL_AT = 3;
    let at = Date.parse(NOW);
    for (let i = 0; i < FAIL_AT; i++) {
      // Each run claims and then stops (no defer, finish or fail); the next one starts once the claim has run out.
      expect(claimMeeting(db, id, { nextAttemptAt: new Date(at + 15 * 60_000).toISOString(), at: new Date(at).toISOString() })).toBe(true);
      at += 16 * 60_000;
    }
    expect(getMeetingState(db, id)).toMatchObject({ status: 'queued', attempts: FAIL_AT });
    // What the processor then does with it.
    failMeeting(db, id, { status: 'failed', errorCode: 'crashed', at: new Date(at).toISOString() });
    expect(getMeetingState(db, id)).toMatchObject({ status: 'failed', errorCode: 'crashed' });
  });

  it('defers counting an attempt, keeping the claim’s count, or putting the count back; fails with a final status', () => {
    const db = seededDb();
    const id = withStatus(db, 'queued');
    expect(claimMeeting(db, id, { nextAttemptAt: LATER, at: NOW })).toBe(true); // attempts 1
    deferMeeting(db, id, { errorCode: 'google_transient', nextAttemptAt: NOW, at: NOW });
    expect(getMeetingState(db, id)).toMatchObject({ errorCode: 'google_transient', attempts: 1 });
    deferMeeting(db, id, { errorCode: 'google_transient', nextAttemptAt: NOW, at: NOW, countAttempt: true });
    expect(getMeetingState(db, id)).toMatchObject({ attempts: 2 });
    expect(claimMeeting(db, id, { nextAttemptAt: LATER, at: NOW })).toBe(true); // attempts 3
    // A spend-cap deferral doesn't count: the processor passes back the count from before its claim.
    deferMeeting(db, id, { errorCode: 'spend_cap', nextAttemptAt: LATER, at: NOW, attempts: 2 });
    expect(getMeeting(db, id)).toMatchObject({ status: 'queued', errorCode: 'spend_cap', attempts: 2, nextAttemptAt: LATER });
    failMeeting(db, id, { status: 'no_access', errorCode: 'drive_404', at: LATER });
    expect(getMeeting(db, id)).toMatchObject({ status: 'no_access', errorCode: 'drive_404', nextAttemptAt: null, updatedAt: LATER });
  });

  it('advances the stage forward only, keeping earlier results and clearing the retry state', () => {
    const db = seededDb();
    const id = withStatus(db, 'queued');
    deferMeeting(db, id, { errorCode: 'ffmpeg', nextAttemptAt: LATER, at: NOW, countAttempt: true });
    advanceStage(db, id, 'audio', { audioPath: 'meetings/1.mp3', audioSeconds: 2650.5 }, NOW);
    expect(getMeeting(db, id)).toMatchObject({ stage: 'audio', audioPath: 'meetings/1.mp3', audioSeconds: 2650.5, errorCode: null, attempts: 0, nextAttemptAt: null });
    const transcript = [{ start: 0, end: 2.5, speaker: 'A', text: 'Namaste' }];
    advanceStage(db, id, 'transcribed', { transcript }, NOW);
    advanceStage(db, id, 'summarised', { summary: summary(2), title: 'Kickoff', attendees: [], participants: ['Rohit'] }, LATER);
    expect(getMeeting(db, id)).toMatchObject({
      stage: 'summarised', audioPath: 'meetings/1.mp3', audioSeconds: 2650.5, transcript, summary: summary(2), title: 'Kickoff', attendees: [],
      participants: ['Rohit'], updatedAt: LATER,
    });
    expect(() => advanceStage(db, id, 'summarised', {}, LATER)).toThrow(/summarised/);
    expect(() => advanceStage(db, id, 'audio', { audioPath: 'other.mp3' }, LATER)).toThrow(/audio/);
    expect(getMeeting(db, id)).toMatchObject({ stage: 'summarised', audioPath: 'meetings/1.mp3' });
    advanceStage(db, id, 'tracked', { docFileId: 'doc1', note: 'transcript_cut' }, LATER);
    expect(getMeeting(db, id)).toMatchObject({ stage: 'tracked', docFileId: 'doc1', note: 'transcript_cut', summary: summary(2) });
    expect(() => advanceStage(db, 999, 'audio', {}, LATER)).toThrow(/999/);
  });

  it('stores only a summary of the shared shape: unknown fields fail loudly', () => {
    const db = seededDb();
    const id = withStatus(db, 'queued');
    const extra = { ...summary(1), mood: 'happy' } as unknown as MeetingSummary;
    expect(() => advanceStage(db, id, 'summarised', { summary: extra }, NOW)).toThrow(/summary value does not have the stored shape/);
    expect(getMeeting(db, id)).toMatchObject({ stage: 'found', summary: null });
    db.prepare('UPDATE meetings SET summary = ? WHERE id = ?').run(JSON.stringify(extra), id);
    expect(() => getMeeting(db, id)).toThrow(new RegExp(`meeting ${id}.*summary`));
  });

  it('stores the speech parts and reads them back', () => {
    const db = seededDb();
    const id = withStatus(db, 'queued');
    const parts = [
      part(0, { state: 'done', booked: 'actual', jobId: 'job-1', segments: [{ start: 0, end: 1, speaker: null, text: 'hi' }], billedSeconds: 600 }),
      part(1, { state: 'inflight', booked: 'ceiling' }),
      part(2),
    ];
    setSttParts(db, id, parts, LATER);
    expect(getMeeting(db, id)).toMatchObject({ sttParts: parts, updatedAt: LATER, stage: 'found' });
  });

  it('finishes a queued meeting at stage doc or later as done and tracked', () => {
    const db = seededDb();
    const id = withStatus(db, 'queued');
    expect(() => finishMeeting(db, id, { at: LATER })).toThrow(new RegExp(`meeting ${id} is not queued at stage doc or later`));
    advanceStage(db, id, 'doc', { docFileId: 'doc1' }, NOW);
    deferMeeting(db, id, { errorCode: 'client_busy', nextAttemptAt: LATER, at: NOW });
    finishMeeting(db, id, { note: 'client_inactive', at: LATER });
    expect(getMeeting(db, id)).toMatchObject({ status: 'done', stage: 'tracked', note: 'client_inactive', errorCode: null, nextAttemptAt: null, updatedAt: LATER });
    const other = withStatus(db, 'queued');
    advanceStage(db, other, 'audio', { note: 'kept' }, NOW);
    advanceStage(db, other, 'doc', {}, NOW);
    finishMeeting(db, other, { at: LATER });
    expect(getMeeting(db, other)).toMatchObject({ status: 'done', stage: 'tracked', note: 'kept' });
  });

  it('processor writes throw on a meeting that is not queued, and change nothing', () => {
    const db = seededDb();
    const done = doneMeeting(db);
    const un = withStatus(db, 'unassigned');
    const before = getMeeting(db, done);
    expect(() => advanceStage(db, un, 'audio', { audioSeconds: 5 }, LATER)).toThrow(new RegExp(`advanceStage: meeting ${un} is not queued`));
    expect(() => deferMeeting(db, un, { errorCode: 'spend_cap', nextAttemptAt: LATER, at: LATER })).toThrow(new RegExp(`deferMeeting: meeting ${un} is not queued`));
    expect(() => deferMeeting(db, 999, { errorCode: 'spend_cap', nextAttemptAt: LATER, at: LATER })).toThrow(/meeting 999 is not queued/);
    expect(() => finishMeeting(db, done, { at: LATER })).toThrow(/is not queued/);
    expect(() => failMeeting(db, done, { status: 'failed', errorCode: 'x', at: LATER })).toThrow(/is not queued/);
    expect(() => setSttParts(db, done, [part(0)], LATER)).toThrow(/is not queued/);
    expect(getMeeting(db, done)).toEqual(before);
    expect(getMeeting(db, un)).toMatchObject({ status: 'unassigned', stage: 'found', audioSeconds: null, errorCode: null, updatedAt: NOW });
  });

  it('assigns only unassigned or internal meetings', () => {
    const db = seededDb();
    const un = withStatus(db, 'unassigned');
    const internal = withStatus(db, 'internal');
    const done = withStatus(db, 'done');
    expect(assignMeeting(db, un, 2, LATER)).toBe(true);
    expect(getMeeting(db, un)).toMatchObject({ status: 'queued', clientId: 2, matchKind: 'human', updatedAt: LATER });
    expect(assignMeeting(db, internal, 1, LATER)).toBe(true);
    expect(getMeeting(db, internal)).toMatchObject({ status: 'queued', clientId: 1, matchKind: 'human', title: '', attendees: [] });
    expect(assignMeeting(db, done, 2, LATER)).toBe(false);
    expect(assignMeeting(db, un, 1, LATER)).toBe(false); // now queued
    expect(getMeeting(db, done)).toMatchObject({ status: 'done', clientId: 1, matchKind: 'title' });
  });

  it('skips only unassigned meetings', () => {
    const db = seededDb();
    const un = withStatus(db, 'unassigned');
    const queued = withStatus(db, 'queued');
    expect(skipMeeting(db, queued, LATER)).toBe(false);
    expect(skipMeeting(db, un, LATER)).toBe(true);
    expect(getMeeting(db, un)).toMatchObject({ status: 'skipped', updatedAt: LATER });
    expect(getMeeting(db, queued)).toMatchObject({ status: 'queued' });
  });

  it('retries only failed or no-access meetings, at their last finished stage', () => {
    const db = seededDb();
    const failed = withStatus(db, 'queued');
    advanceStage(db, failed, 'transcribed', { transcript: [] }, NOW);
    deferMeeting(db, failed, { errorCode: 'claude_5xx', nextAttemptAt: LATER, at: NOW, countAttempt: true });
    failMeeting(db, failed, { status: 'failed', errorCode: 'claude_5xx', at: NOW });
    const noAccess = withStatus(db, 'no_access');
    const tooLong = withStatus(db, 'too_long');
    const queued = withStatus(db, 'queued');
    expect(retryMeeting(db, failed, LATER)).toBe(true);
    expect(getMeeting(db, failed)).toMatchObject({ status: 'queued', stage: 'transcribed', attempts: 0, nextAttemptAt: null, errorCode: null, updatedAt: LATER });
    expect(retryMeeting(db, noAccess, LATER)).toBe(true);
    expect(retryMeeting(db, tooLong, LATER)).toBe(false);
    expect(retryMeeting(db, queued, LATER)).toBe(false);
    expect(getMeeting(db, tooLong)).toMatchObject({ status: 'too_long' });
  });

  it('lists unassigned meetings newest first, with no title or attendees', () => {
    const db = seededDb();
    const old = withStatus(db, 'unassigned', { startedAt: '2026-10-10T10:00:00.000Z', driveSeconds: 100 });
    const recent = withStatus(db, 'unassigned', { startedAt: '2026-10-12T10:00:00.000Z', driveSeconds: null });
    withStatus(db, 'internal');
    db.prepare('UPDATE meetings SET audio_seconds = 95.5 WHERE id = ?').run(old); // the audio's length wins over Drive's
    const rows = listUnassigned(db, 10);
    expect(rows).toEqual([
      { id: recent, startedAt: '2026-10-12T10:00:00.000Z', seconds: null },
      { id: old, startedAt: '2026-10-10T10:00:00.000Z', seconds: 95.5 },
    ]);
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(['id', 'seconds', 'startedAt']);
    expect(listUnassigned(db, 1)).toHaveLength(1);
  });

  it('lists a client’s done meetings newest first with their action item counts', () => {
    const db = seededDb();
    const a = doneMeeting(db, { startedAt: '2026-10-10T10:00:00.000Z', title: 'First' }, { summary: summary(3), docFileId: 'docA' });
    const b = doneMeeting(db, { startedAt: '2026-10-12T10:00:00.000Z', title: 'Second', driveSeconds: null }, { audioSeconds: 600 });
    withStatus(db, 'queued', { startedAt: '2026-10-13T10:00:00.000Z' }); // not done
    withStatus(db, 'done', { clientId: 2, startedAt: '2026-10-14T10:00:00.000Z' }); // other client
    expect(listClientMeetings(db, 1, 10)).toEqual([
      { id: b, startedAt: '2026-10-12T10:00:00.000Z', title: 'Second', seconds: 600, docFileId: null, actionItemCount: 0 },
      { id: a, startedAt: '2026-10-10T10:00:00.000Z', title: 'First', seconds: 2700, docFileId: 'docA', actionItemCount: 3 },
    ]);
    expect(listClientMeetings(db, 1, 1)).toHaveLength(1);
  });

  it('gives each client’s latest done meeting', () => {
    const db = seededDb();
    withStatus(db, 'done', { startedAt: '2026-10-10T10:00:00.000Z' });
    withStatus(db, 'done', { startedAt: '2026-10-12T10:00:00.000Z' });
    withStatus(db, 'queued', { startedAt: '2026-10-15T10:00:00.000Z' });
    withStatus(db, 'done', { clientId: 2, startedAt: '2026-10-11T10:00:00.000Z' });
    withStatus(db, 'skipped', { startedAt: '2026-10-16T10:00:00.000Z' });
    expect(lastMeetingByClient(db)).toEqual(new Map([[1, '2026-10-12T10:00:00.000Z'], [2, '2026-10-11T10:00:00.000Z']]));
  });

  it('counts meetings by status, and waiting deferrals by code, never a claimed one', () => {
    const db = seededDb();
    withStatus(db, 'done');
    withStatus(db, 'done');
    withStatus(db, 'queued');
    const capped = [withStatus(db, 'queued'), withStatus(db, 'queued')];
    const busy = withStatus(db, 'queued');
    const claimed = withStatus(db, 'queued');
    for (const id of capped) deferMeeting(db, id, { errorCode: 'spend_cap', nextAttemptAt: LATER, at: NOW });
    deferMeeting(db, busy, { errorCode: 'client_busy', nextAttemptAt: LATER, at: NOW });
    deferMeeting(db, claimed, { errorCode: 'client_busy', nextAttemptAt: NOW, at: NOW });
    expect(claimMeeting(db, claimed, { nextAttemptAt: LATER, at: NOW })).toBe(true); // running now, not deferred
    withStatus(db, 'unassigned');
    withStatus(db, 'failed');
    withStatus(db, 'no_access');
    withStatus(db, 'too_long');
    withStatus(db, 'internal');
    withStatus(db, 'skipped');
    expect(meetingStats(db, NOW)).toEqual({
      done: 2, waiting: 5, unassigned: 1, failed: 1, noAccess: 1, tooLong: 1, internal: 1, deferred: { spend_cap: 2, client_busy: 1 },
    });
    // Once their time has come they are no longer waiting on a deferral.
    expect(meetingStats(db, LATER).deferred).toEqual({});
    expect(meetingStats(seededDb(), NOW)).toEqual({
      done: 0, waiting: 0, unassigned: 0, failed: 0, noAccess: 0, tooLong: 0, internal: 0, deferred: {},
    });
  });

  it('a bad JSON value fails only its own row, naming the meeting and column but not the content', () => {
    const db = seededDb();
    const good = doneMeeting(db, { startedAt: '2026-10-10T10:00:00.000Z' }, { summary: summary(1) });
    const bad = doneMeeting(db, { startedAt: '2026-10-11T10:00:00.000Z' }, { summary: summary(1) });
    const badSummary = doneMeeting(db, { startedAt: '2026-10-12T10:00:00.000Z' }, { summary: summary(1) });
    const noList = doneMeeting(db, { startedAt: '2026-10-13T10:00:00.000Z' }, { summary: summary(1) });
    db.prepare("UPDATE meetings SET attendees = '[{\"email\": 42, \"secret\": \"Mr Sharma private\"}]' WHERE id = ?").run(bad);
    db.prepare("UPDATE meetings SET summary = '{not json: private words' WHERE id = ?").run(badSummary);
    db.prepare(`UPDATE meetings SET summary = '{"actionItems": "private"}' WHERE id = ?`).run(noList);
    expect(() => getMeeting(db, bad)).toThrow(new RegExp(`meeting ${bad}.*attendees`));
    expect(() => getMeeting(db, bad)).not.toThrow(/private/);
    expect(() => getMeeting(db, badSummary)).toThrow(new RegExp(`meeting ${badSummary}.*summary`));
    expect(() => getMeeting(db, badSummary)).not.toThrow(/private/);
    expect(getMeeting(db, good)).toMatchObject({ id: good });
    // The light state reads no JSON, so the processor loop still sees every row.
    expect(getMeetingState(db, badSummary)).toMatchObject({ id: badSummary, status: 'done', stage: 'tracked' });
    // The list reads only the summary's action items, so the bad attendees row is still listed; the bad summaries are
    // skipped, and the limit counts only listed rows.
    expect(listClientMeetings(db, 1, 10).map((m) => m.id)).toEqual([bad, good]);
    expect(listClientMeetings(db, 1, 1).map((m) => m.id)).toEqual([bad]);
    expect(lastMeetingByClient(db).get(1)).toBe('2026-10-13T10:00:00.000Z');
  });
});

describe('migration 7', () => {
  it('upgrades a version-5 database with data in it: old rows unchanged, new columns null, links valid', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
    for (const m of MIGRATIONS.filter((x) => x.version <= 5)) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version);
    }
    db.prepare("INSERT INTO clients (code, name, group_id, phases) VALUES ('SHA', 'Sharma', '1@g.us', '[]')").run();
    db.prepare("INSERT INTO messages (wa_id, client_id, sender_jid, ts) VALUES ('m1', 1, 'x', '2026-10-10T00:00:00Z')").run();
    db.prepare(`INSERT INTO media (message_id, client_id, kind, status, text_kind, text, created_at, updated_at)
      VALUES (1, 1, 'image', 'done', 'description', 'A blue banner', '2026-10-10T00:00:00Z', '2026-10-10T00:01:00Z')`).run();
    db.prepare(`INSERT INTO tasks (code, client_id, side, title, category, priority, raised_on, created_at, updated_at)
      VALUES ('SHA-001', 1, 'us', 'Send logo', 'design', 'high', '2026-10-10', '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z')`).run();
    db.prepare(`INSERT INTO decisions (client_id, text, decided_on, source, created_at)
      VALUES (1, 'Blue theme', '2026-10-10', 'whatsapp', '2026-10-10T00:00:00Z')`).run();
    const before = {
      tasks: db.prepare('SELECT * FROM tasks').all(),
      decisions: db.prepare('SELECT * FROM decisions').all(),
      media: db.prepare('SELECT * FROM media').all(),
      clients: db.prepare('SELECT * FROM clients').all(),
    };
    migrate(db);
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(7);
    const strip = (rows: unknown[]) => rows.map((r) => {
      const { meeting_id: _m, ...rest } = r as Record<string, unknown>;
      return rest;
    });
    expect(strip(db.prepare('SELECT * FROM tasks').all())).toEqual(before.tasks);
    expect(strip(db.prepare('SELECT * FROM decisions').all())).toEqual(before.decisions);
    expect(db.prepare('SELECT * FROM media').all()).toEqual(before.media);
    expect(db.prepare('SELECT * FROM clients').all()).toEqual(before.clients);
    expect(db.prepare('SELECT meeting_id FROM tasks').get()).toEqual({ meeting_id: null });
    expect(db.prepare('SELECT meeting_id FROM decisions').get()).toEqual({ meeting_id: null });
    expect((db.prepare('SELECT COUNT(*) AS n FROM meetings').get() as { n: number }).n).toBe(0);

    // The new links point at meetings, and the foreign keys hold.
    const id = insertFound(db, meeting({ status: 'done' }))!;
    db.prepare('UPDATE tasks SET meeting_id = ?').run(id);
    db.prepare('UPDATE decisions SET meeting_id = ?').run(id);
    expect(() => db.prepare('UPDATE tasks SET meeting_id = 999').run()).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare('UPDATE decisions SET meeting_id = 999').run()).toThrow(/FOREIGN KEY/);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('a fresh database migrates to 7, with its indexes, and the table refuses unknown statuses and stages', () => {
    const db = seededDb();
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(7);
    expect(MIGRATIONS.map((m) => m.version).at(-1)).toBe(7);
    const idx = (db.prepare("SELECT tbl_name || '.' || name AS n FROM sqlite_master WHERE type = 'index'").all() as { n: string }[]).map((i) => i.n);
    expect(idx).toEqual(expect.arrayContaining([
      'meetings.meetings_due', 'meetings.meetings_conference', 'meetings.meetings_client', 'tasks.tasks_meeting', 'decisions.decisions_meeting',
    ]));
    expect(db.prepare("SELECT name FROM pragma_index_info('meetings_client') ORDER BY seqno").all()).toEqual([
      { name: 'client_id' }, { name: 'status' }, { name: 'started_at' },
    ]);
    expect(() => insertFound(db, meeting({ status: 'pending' as MeetingStatus }))).toThrow(/CHECK/);
    const id = withStatus(db, 'queued');
    expect(() => db.prepare("UPDATE meetings SET stage = 'uploaded' WHERE id = ?").run(id)).toThrow(/CHECK/);
    expect(() => insertFound(db, meeting({ clientId: 999 }))).toThrow(/FOREIGN KEY/);
  });

  it('an internal meeting keeps no title, attendees or names', () => {
    const db = seededDb();
    const internal = { status: 'internal' as const, clientId: null, matchKind: null, title: '', attendees: [], participants: [] };
    expect(insertFound(db, meeting(internal))).toBeTypeOf('number');
    expect(() => insertFound(db, meeting({ ...internal, title: 'Team sync' }))).toThrow(/CHECK/);
    expect(() => insertFound(db, meeting({ ...internal, attendees: [{ email: 'r@us.in', name: null, team: true }] }))).toThrow(/CHECK/);
    expect(() => insertFound(db, meeting({ ...internal, participants: ['Rohit'] }))).toThrow(/CHECK/);
    const queued = withStatus(db, 'queued');
    expect(() => db.prepare("UPDATE meetings SET status = 'internal' WHERE id = ?").run(queued)).toThrow(/CHECK/);
  });
});
