import { describe, expect, it } from 'vitest';
import { assignMeetingToClient, retryMeetingById, skipMeetingById } from '../../src/cli/meetings.ts';
import { ControlError, type AuditEntry } from '../../src/control/errors.ts';
import { MEETING_COST_WARNING, runMeetingAction } from '../../src/control/meetingActions.ts';
import type { Db } from '../../src/store/db.ts';
import { getKv } from '../../src/store/kv.ts';
import { insertFound, type MeetingStatus } from '../../src/store/meetings.ts';
import { idOf, NOW, onSqlite, rows, seededDb } from '../helpers/db.ts';

const now = new Date('2026-10-19T08:00:00Z');
const OWNER = 'owner@example.com';

async function withMeeting(status: MeetingStatus, client: 'SHA' | null = null): Promise<{ db: Db; id: string }> {
  const db = await seededDb();
  const clientId = client === null ? null : await idOf(db, client);
  const id = await insertFound(db, {
    recording: 'conferenceRecords/a/recordings/b', conference: 'conferenceRecords/a', driveFileId: 'drive1', meetingCode: null,
    title: status === 'internal' ? '' : 'Weekly sync', startedAt: NOW, endedAt: null, attendees: [], participants: [], clientId,
    matchKind: clientId === null ? null : 'title', status, driveSeconds: 1800, errorCode: status === 'failed' ? 'stt_failed' : null, createdAt: NOW,
  });
  return { db, id: String(id) };
}

async function state(db: Db) {
  const meetings = await rows<{ id: number } & Record<string, unknown>>(db, 'SELECT m.*, c.code AS client_code FROM meetings m LEFT JOIN clients c ON c.id = m.client_id');
  // The meeting's own id, in an event's detail too, is this customer's: another customer's copy has another one.
  const own = (detail: unknown) => meetings.reduce((d, m) => d.split(`"meetingId":${m.id}`).join('"meetingId":"<own>"'), String(detail));
  return {
    meetings: meetings.map(({ id: _id, tenant_id: _t, client_id: _c, ...r }) => r),
    events: (await rows<{ detail: unknown }>(db, 'SELECT e.task_id, c.code AS client_code, e.actor, e.op, e.detail, e.reason, e.at FROM task_events e LEFT JOIN clients c ON c.id = e.client_id ORDER BY e.id'))
      .map((e) => ({ ...e, detail: own(e.detail) })),
    rebuild: await getKv(db, 'rebuild_requested'),
  };
}

const notPaused = { isPaused: () => false };
const paused = { isPaused: () => true };

async function run(db: Db, id: string, action: string, body?: unknown, spend = notPaused) {
  const audits: AuditEntry[] = [];
  const result = await runMeetingAction(db, { id, action, body }, { actor: OWNER, now, audit: async (_q, e) => { audits.push(e); }, spend });
  return { result, audits };
}

async function refusal(fn: () => unknown): Promise<ControlError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ControlError) return e;
    throw e;
  }
  throw new Error('expected a ControlError');
}

describe('runMeetingAction matches the CLI', () => {
  it('assign', async () => {
    const web = await withMeeting('unassigned');
    const cli = await withMeeting('unassigned');
    const { result, audits } = await run(web.db, web.id, 'assign', { client: 'sha' });
    await assignMeetingToClient(cli.db, cli.id, 'SHA', now);
    expect(await state(web.db)).toEqual(await state(cli.db));
    expect(result.meeting).toMatchObject({ id: Number(web.id), status: 'queued', client: { code: 'SHA' } });
    expect(result.warning).toBe(MEETING_COST_WARNING); // assigning queues the meeting for paid processing
    expect(audits).toEqual([{ actor: OWNER, event: 'meeting.assign', kind: 'meeting', detail: `Meeting ${web.id} assigned to SHA` }]);
  });

  it('skip', async () => {
    const web = await withMeeting('unassigned');
    const cli = await withMeeting('unassigned');
    const { result, audits } = await run(web.db, web.id, 'skip');
    await skipMeetingById(cli.db, cli.id, now);
    expect(await state(web.db)).toEqual(await state(cli.db));
    expect(result.meeting.status).toBe('skipped');
    expect(audits).toEqual([{ actor: OWNER, event: 'meeting.skip', kind: 'meeting', detail: `Meeting ${web.id} skipped` }]);
  });

  it('retry, with the cost warning', async () => {
    const web = await withMeeting('failed', 'SHA');
    const cli = await withMeeting('failed', 'SHA');
    const { result, audits } = await run(web.db, web.id, 'retry');
    await retryMeetingById(cli.db, cli.id, now);
    expect(await state(web.db)).toEqual(await state(cli.db));
    expect(result).toMatchObject({ meeting: { status: 'queued' }, warning: MEETING_COST_WARNING });
    expect(MEETING_COST_WARNING).toBe('Processing a meeting costs money');
    expect(audits).toEqual([{ actor: OWNER, event: 'meeting.retry', kind: 'meeting', detail: `Meeting ${web.id} queued again` }]);
  });

  it('retry of a meeting without a client puts it back to unassigned, as the CLI does', async () => {
    const web = await withMeeting('no_access');
    const cli = await withMeeting('no_access');
    const { result, audits } = await run(web.db, web.id, 'retry');
    await retryMeetingById(cli.db, cli.id, now);
    expect(await state(web.db)).toEqual(await state(cli.db));
    expect(result.meeting.status).toBe('unassigned');
    expect(audits[0]!.detail).toBe(`Meeting ${web.id} has no client, so it is unassigned again`);
  });

  it('never puts the title in the audit line', async () => {
    const m = await withMeeting('unassigned');
    const { audits } = await run(m.db, m.id, 'assign', { client: 'SHA' });
    expect(JSON.stringify(audits)).not.toContain('Weekly');
  });
});

describe('runMeetingAction refusals', () => {
  it('refuses a retry while the daily spend cap is reached, changing and auditing nothing', async () => {
    const { db, id } = await withMeeting('failed', 'SHA');
    const before = await state(db);
    const audits: AuditEntry[] = [];
    const e = await refusal(async () => await runMeetingAction(db, { id, action: 'retry' }, { actor: OWNER, now, audit: async (_q, x) => { audits.push(x); }, spend: paused }));
    expect(e).toMatchObject({ status: 409, message: "Today's AI spending limit is reached. Try again after midnight IST." });
    expect(await state(db)).toEqual(before);
    expect(audits).toEqual([]);
  });

  it('assign and skip still work at the cap: the pipeline itself waits for the budget', async () => {
    const a = await withMeeting('unassigned');
    const b = await withMeeting('unassigned');
    expect((await run(a.db, a.id, 'skip', undefined, paused)).result.meeting.status).toBe('skipped');
    expect((await run(b.db, b.id, 'assign', { client: 'SHA' }, paused)).result.meeting.status).toBe('queued');
  });

  it('404 for an unknown or badly formed id', async () => {
    const { db } = await withMeeting('unassigned');
    expect(await refusal(async () => await run(db, '9', 'skip'))).toMatchObject({ status: 404, message: 'No meeting 9' });
    for (const bad of ['0', 'x', '1 OR 1=1', '']) expect((await refusal(async () => await run(db, bad, 'skip'))).status, bad).toBe(404);
  });

  it('400 for an unknown action', async () => {
    const { db, id } = await withMeeting('unassigned');
    expect(await refusal(async () => await run(db, id, 'delete'))).toMatchObject({ status: 400, field: 'action' });
  });

  it('409 when the meeting is not in a state that allows it', async () => {
    const { db, id } = await withMeeting('done', 'SHA');
    const before = await state(db);
    expect(await refusal(async () => await run(db, id, 'skip'))).toMatchObject({ status: 409 });
    expect(await refusal(async () => await run(db, id, 'retry'))).toMatchObject({ status: 409 });
    expect(await refusal(async () => await run(db, id, 'assign', { client: 'SHA' }))).toMatchObject({ status: 409 });
    expect(await state(db)).toEqual(before);
  });

  it('422 for a bad, unknown or inactive client', async () => {
    const { db, id } = await withMeeting('unassigned');
    for (const body of [undefined, null, {}, { client: 5 }, { client: 'SH' }, { client: 'SHA1' }, [], 'SHA']) {
      expect(await refusal(async () => await run(db, id, 'assign', body)), JSON.stringify(body)).toMatchObject({ status: 422, field: 'client' });
    }
    expect(await refusal(async () => await run(db, id, 'assign', { client: 'XYZ' }))).toMatchObject({ status: 422, field: 'client', message: 'No client with code XYZ' });
    await db.run("UPDATE clients SET active = 0 WHERE code = 'MEH'");
    expect(await refusal(async () => await run(db, id, 'assign', { client: 'MEH' }))).toMatchObject({ status: 422, field: 'client' });
  });

  it('rolls the change back when the audit cannot be written', async () => {
    const { db, id } = await withMeeting('unassigned');
    const before = await state(db);
    await expect(runMeetingAction(db, { id, action: 'skip' }, { actor: OWNER, now, audit: async () => { throw new Error('disk full'); }, spend: notPaused }))
      .rejects.toThrowError('disk full');
    expect(await state(db)).toEqual(before);
  });
});

describe('runMeetingAction review fixes', () => {
  it('a skip carries no cost warning', async () => {
    const { db, id } = await withMeeting('unassigned');
    expect((await run(db, id, 'skip')).result.warning).toBeUndefined();
  });

  // SQLite only (S2.7): another writer is played by a SQLite trigger (a customer's Db cannot make one on Postgres); the
  // action's own SQL runs on Postgres in the tests above.
  it.runIf(onSqlite)("puts a meeting that changed meanwhile in the dashboard's words", async () => {
    const { db, id } = await withMeeting('unassigned');
    // As if another writer took the meeting between the check and the change.
    await db.exec('CREATE TRIGGER grab BEFORE UPDATE ON meetings BEGIN SELECT RAISE(IGNORE); END');
    const e = await refusal(async () => await run(db, id, 'skip'));
    expect(e).toMatchObject({ status: 409, message: `Meeting ${id} changed meanwhile; refresh the list and try again` });
  });
});
