import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/store/db.ts';
import { insertFound } from '../../src/store/meetings.ts';
import { createTask, getTaskByCode } from '../../src/store/tasks.ts';
import { manualClock } from '../../src/util/clock.ts';
import { AuditLog } from '../../src/web/audit.ts';
import { registerWorkApi } from '../../src/web/routes/work.ts';
import { NOW, row, rows, seeded } from '../helpers/db.ts';
import { bootDashboard, OWNER } from '../helpers/web.ts';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function boot(o: { paused?: boolean; actionCapacity?: number } = {}) {
  const { db, ids } = await seeded();
  const clock = manualClock(NOW);
  await createTask(db, { clientId: ids.sharma, side: 'us', title: 'Banner', category: 'design', priority: 'major', assignedTo: null, askedBy: null, raisedOn: '2026-10-10',
    deadline: null, latestProgress: null, sourceQuote: 'secret words from the chat', sourceDate: '2026-10-10', sourceWaId: null, origin: 'whatsapp' }, NOW);
  const m1 = (await insertFound(db, {
    recording: 'conferenceRecords/a/recordings/b', conference: 'conferenceRecords/a', driveFileId: 'd1', meetingCode: null, title: 'Weekly sync',
    startedAt: NOW, endedAt: null, attendees: [], participants: [], clientId: null, matchKind: null, status: 'unassigned', driveSeconds: 1800, createdAt: NOW,
  }))!;
  const m2 = (await insertFound(db, {
    recording: 'conferenceRecords/c/recordings/d', conference: 'conferenceRecords/c', driveFileId: 'd2', meetingCode: null, title: 'Failed one',
    startedAt: NOW, endedAt: null, attendees: [], participants: [], clientId: ids.sharma, matchKind: 'title', status: 'failed', driveSeconds: 1800, errorCode: 'x', createdAt: NOW,
  }))!;
  const audit = new AuditLog(db, clock);
  const h = await bootDashboard({
    db, clock, actionCapacity: o.actionCapacity,
    mount: (router, x) => registerWorkApi(router, { ...x, db, clock, audit, spend: { isPaused: () => o.paused ?? false } }),
  });
  closers.push(() => h.close());
  return { db, h, m1, m2 };
}

const auditRows = (db: Db) => rows<Record<string, string>>(db, 'SELECT actor, event, kind, detail, request_id AS requestId FROM audit_log ORDER BY id');

describe('work API: reads', () => {
  it('needs a signed-in owner for every read', async () => {
    const { h, m1 } = await boot();
    for (const path of ['/dashboard/api/tasks', '/dashboard/api/tasks/SHA-001', '/dashboard/api/meetings', `/dashboard/api/meetings/${m1}`,
      '/dashboard/api/activity', '/dashboard/api/tracker']) {
      expect((await h.get(path, { cookie: null })).status, path).toBe(401);
    }
  });

  it('lists and details tasks, 404 for an unknown code, 400 naming a bad filter', async () => {
    const { h } = await boot();
    expect(await h.get('/dashboard/api/tasks?status=open')).toMatchObject({ status: 200, json: { total: 1, rows: [{ code: 'SHA-001' }] } });
    expect(await h.get('/dashboard/api/tasks/sha-001')).toMatchObject({ status: 200, json: { code: 'SHA-001', sourceQuote: 'secret words from the chat' } });
    expect(await h.get('/dashboard/api/tasks/SHA-999')).toMatchObject({ status: 404, json: { error: { code: 'not_found' } } });
    expect(await h.get('/dashboard/api/tasks?status=late')).toMatchObject({ status: 400, json: { error: { code: 'bad_request', field: 'status' } } });
    expect((await h.get('/dashboard/api/tasks')).headers['cache-control']).toBe('no-store');
  });

  it('lists and details meetings, and serves activity and the tracker', async () => {
    const { h, m1 } = await boot();
    expect(await h.get('/dashboard/api/meetings?view=attention')).toMatchObject({ status: 200, json: { total: 2 } });
    expect(await h.get(`/dashboard/api/meetings/${m1}`)).toMatchObject({ status: 200, json: { id: m1, status: 'unassigned' } });
    expect((await h.get('/dashboard/api/meetings/99')).status).toBe(404);
    expect(await h.get('/dashboard/api/activity?kind=meet')).toMatchObject({ status: 200, json: { items: expect.any(Array) } });
    expect((await h.get('/dashboard/api/activity?kind=chat')).status).toBe(400);
    expect(await h.get('/dashboard/api/tracker')).toMatchObject({ status: 200, json: { uploaded: false, sheets: expect.any(Array) } });
  });
});

describe('work API: changes', () => {
  it('a task action needs the CSRF token and a matching Origin; nothing changes without them', async () => {
    const { db, h } = await boot();
    for (const x of [{ csrf: null }, { csrf: 'A'.repeat(43) }, { origin: null }, { origin: 'https://evil.example' }, { cookie: null }]) {
      const r = await h.post('/dashboard/api/tasks/SHA-001/done', x);
      expect(r.status, JSON.stringify(x)).toBe(x.cookie === null ? 401 : 403);
    }
    expect((await getTaskByCode(db, 'SHA-001'))?.status).toBe('open');
    expect(await auditRows(db)).toEqual([]);
  });

  it('marks a task done, audited with the owner, the code and the request id, never the chat text', async () => {
    const { db, h } = await boot();
    const r = await h.post('/dashboard/api/tasks/SHA-001/done');
    expect(r).toMatchObject({ status: 200, json: { code: 'SHA-001', status: 'done' } });
    expect((await getTaskByCode(db, 'SHA-001'))?.status).toBe('done');
    const audited = await auditRows(db);
    expect(audited).toEqual([{ actor: OWNER, event: 'task.done', kind: 'task', detail: 'Task SHA-001 marked done', requestId: expect.stringMatching(/^[0-9a-f]{12}$/) }]);
    expect(JSON.stringify(audited)).not.toContain('secret');
    expect((await h.post('/dashboard/api/tasks/SHA-001/done')).status).toBe(409);
  });

  it('edits a task from the JSON body, and refuses a bad value with 422 and the field', async () => {
    const { db, h } = await boot();
    expect(await h.post('/dashboard/api/tasks/SHA-001/edit', { body: { deadline: '2026-10-30', assignedTo: 'Rahul' } })).toMatchObject({
      status: 200, json: { deadline: '2026-10-30', owner: 'Rahul' },
    });
    expect(await h.post('/dashboard/api/tasks/SHA-001/edit', { body: { deadline: '2026-02-30' } })).toMatchObject({
      status: 422, json: { error: { code: 'invalid', field: 'deadline' } },
    });
    expect((await h.post('/dashboard/api/tasks/SHA-001/edit')).status).toBe(400); // no JSON body
    expect((await h.post('/dashboard/api/tasks/SHA-001/delete')).status).toBe(400);
    expect((await getTaskByCode(db, 'SHA-001'))?.deadline).toBe('2026-10-30');
  });

  it('assigns a meeting with the cost warning, and refuses a retry at the spend cap', async () => {
    const { h, m1, m2 } = await boot({ paused: true });
    expect(await h.post(`/dashboard/api/meetings/${m1}/assign`, { body: { client: 'SHA' } })).toMatchObject({
      status: 200, json: { meeting: { status: 'queued' }, warning: 'Processing a meeting costs money' },
    });
    expect(await h.post(`/dashboard/api/meetings/${m2}/retry`)).toMatchObject({ status: 409, json: { error: { code: 'conflict' } } });
    expect(await h.post(`/dashboard/api/meetings/${m1}/assign`, { body: { client: 'SHA' } })).toMatchObject({ status: 409 }); // already queued
    expect(await h.post(`/dashboard/api/meetings/${m1}/assign`, { body: { client: 'XYZ' } })).toMatchObject({ status: 422, json: { error: { field: 'client' } } });
  });

  it('counts changes against the action rate limit', async () => {
    const { h } = await boot({ actionCapacity: 1 });
    expect((await h.post('/dashboard/api/tasks/SHA-001/unlock')).status).toBe(200);
    const r = await h.post('/dashboard/api/tasks/SHA-001/unlock');
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBeDefined();
  });
});

describe('work API review fixes', () => {
  it('a meeting action needs the CSRF token and a matching Origin; nothing changes without them', async () => {
    const { db, h, m1 } = await boot();
    for (const x of [{ csrf: null }, { origin: null }, { origin: 'https://evil.example' }, { cookie: null }]) {
      const r = await h.post(`/dashboard/api/meetings/${m1}/skip`, x);
      expect(r.status, JSON.stringify(x)).toBe(x.cookie === null ? 401 : 403);
    }
    expect(await row(db, 'SELECT status FROM meetings WHERE id = ?', [m1])).toEqual({ status: 'unassigned' });
    expect(await auditRows(db)).toEqual([]);
  });

  it('a meeting action is audited with the owner and the request id', async () => {
    const { db, h, m1 } = await boot();
    await h.post(`/dashboard/api/meetings/${m1}/assign`, { body: { client: 'SHA' } });
    expect(await auditRows(db)).toEqual([{ actor: OWNER, event: 'meeting.assign', kind: 'meeting', detail: `Meeting ${m1} assigned to SHA`, requestId: expect.stringMatching(/^[0-9a-f]{12}$/) }]);
  });
});
