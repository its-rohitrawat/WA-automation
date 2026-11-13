import { afterEach, describe, expect, it, vi } from 'vitest';
import * as chatPicture from '../../src/output/chatPicture.ts';
import type { Db } from '../../src/store/db.ts';
import { insertFound } from '../../src/store/meetings.ts';
import { insertMessage } from '../../src/store/messages.ts';
import { createTask, getTaskByCode } from '../../src/store/tasks.ts';
import { manualClock } from '../../src/util/clock.ts';
import { AuditLog } from '../../src/web/audit.ts';
import { registerWorkApi } from '../../src/web/routes/work.ts';
import { NOW, row, rows, seeded, SHARMA } from '../helpers/db.ts';

const SHARMA_GROUP = SHARMA.groupId;
import { bootDashboard, OWNER } from '../helpers/web.ts';

vi.mock('../../src/output/chatPicture.ts', async (orig) => {
  const real = await orig<typeof import('../../src/output/chatPicture.ts')>();
  return { ...real, drawChatPicture: vi.fn(real.drawChatPicture) };
});

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function boot(o: { pictureTimeoutMs?: number; groupMembers?: (g: string) => Promise<never[] | null>; connected?: (g: string) => boolean; paused?: boolean; actionCapacity?: number; exportTimeoutMs?: number; failAudit?: { on: boolean }; book?: (() => Promise<Buffer>) | null } = {}) {
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
  const warned: Record<string, unknown>[] = [];
  const h = await bootDashboard({
    db, clock, actionCapacity: o.actionCapacity, moreOwners: ['second@example.com'],
    mount: (router, x) => registerWorkApi(router, {
      ...x, db, clock, audit: o.failAudit ? { record: async (e, q) => { if (o.failAudit!.on) throw new Error('audit down'); await audit.record(e, q); } } : audit, spend: { isPaused: () => o.paused ?? false }, log: { warn: (f: unknown) => { warned.push(f as Record<string, unknown>); } }, ...(o.exportTimeoutMs ? { exportTimeoutMs: o.exportTimeoutMs } : {}), ...(o.pictureTimeoutMs ? { pictureTimeoutMs: o.pictureTimeoutMs } : {}),
      ...(o.groupMembers ? { groupMembers: o.groupMembers, ...(o.connected ? { connected: o.connected } : {}) } : {}),
      ...(o.book === null ? {} : { trackerWorkbook: o.book ?? (async () => Buffer.from('PK-founder-workbook', 'latin1')) }),
    }),
  });
  closers.push(() => h.close());
  return { db, h, m1, m2, clock, warned };
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
    expect(r.headers['retry-after']).toBe('1');
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

describe('work API: the task picture', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  /** A chat task (with its source message and one before it), a meeting task and a dashboard task, for Sharma. */
  async function bootPicture(over: Parameters<typeof boot>[0] = {}) {
    const b = await boot(over);
    const { db } = b;
    const client = (await row<{ id: number }>(db, "SELECT id FROM clients WHERE code = 'SHA'"))!.id;
    for (const [waId, ts, text] of [['W1', '2026-10-10T04:00:00.000Z', 'Hello there'], ['W2', '2026-10-10T04:05:00.000Z', 'Please send the banner']] as const) {
      await insertMessage(db, { waId, clientId: client, senderJid: 'j1', senderNumber: null, senderName: null, fromMe: false, ts, text, quotedWaId: null, mediaType: null });
    }
    const mk = async (extra: Record<string, unknown>) => (await createTask(db, { clientId: client, side: 'us', title: 'T', category: 'design', priority: 'major', assignedTo: null, askedBy: null,
      raisedOn: '2026-10-10', deadline: null, latestProgress: null, sourceQuote: null, sourceDate: null, sourceWaId: null, origin: 'whatsapp', ...extra } as never, NOW)).code;
    const chat = await mk({ sourceWaId: 'W2' });
    const meeting = await mk({ origin: 'meeting', meetingId: b.m2 });
    const dash = await mk({ origin: 'dashboard' });
    const gone = await mk({ sourceWaId: 'NOPE' });
    return { ...b, client, chat, meeting, dash, gone };
  }
  const pic = async (h: Awaited<ReturnType<typeof boot>>['h'], code: string, o: { signedIn?: boolean | string; headers?: Record<string, string> } = {}) => {
    const signedIn = o.signedIn ?? true;
    const id = signedIn ? (await h.sessions.create(typeof signedIn === 'string' ? signedIn : OWNER)).id : null;
    return fetch(`http://127.0.0.1:${h.port}/dashboard/api/tasks/${code}/picture`, { headers: { ...(o.headers ?? {}), ...(id ? { cookie: `wa_session=${id}` } : {}) } });
  };

  it('answers a PNG with the cache and sniffing headers', async () => {
    const { h, chat } = await bootPicture();
    const r = await pic(h, chat);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await r.arrayBuffer()).subarray(0, 4).equals(PNG)).toBe(true);
  }, 30_000);

  it('answers 404 for a meeting task, a dashboard task, an unknown code and a task whose message is not stored', async () => {
    const { h, meeting, dash, gone } = await bootPicture();
    for (const code of [meeting, dash, gone, 'SHA-999', 'bad']) {
      const r = await pic(h, code);
      expect(r.status, code).toBe(404);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe('not_found');
    }
  });

  it('answers 404 for an inactive client', async () => {
    const { db, h, chat } = await bootPicture();
    await db.run("UPDATE clients SET active = 0 WHERE code = 'SHA'");
    expect((await pic(h, chat)).status).toBe(404);
  });

  it('is closed to a signed-out visitor (401) and a cross-site request (403, before the sign-in check)', async () => {
    const { h, chat } = await bootPicture();
    expect((await pic(h, chat, { signedIn: false })).status).toBe(401);
    expect((await pic(h, chat, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await pic(h, chat, { signedIn: false, headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await pic(h, chat, { headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
  }, 30_000);

  it('allows 30 requests a minute per owner, then 429 with Retry-After; another owner is not held back', async () => {
    const { h, chat } = await bootPicture();
    for (let i = 0; i < 30; i++) expect((await pic(h, 'SHA-999')).status).toBe(404);
    const r = await pic(h, chat);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
    expect((await pic(h, chat, { signedIn: 'second@example.com' })).status).toBe(200);
  }, 60_000);

  it('answers 503 with Retry-After when drawing takes too long, logs only the code, and the next picture still works', async () => {
    const { h, chat, warned } = await bootPicture({ pictureTimeoutMs: 1000 });
    vi.mocked(chatPicture.drawChatPicture).mockImplementationOnce(() => new Promise<Buffer>(() => undefined));
    const r = await pic(h, chat);
    expect(r.status).toBe(503);
    expect(r.headers.get('retry-after')).toBe('10');
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('busy');
    expect(warned).toEqual([expect.objectContaining({ code: 'PictureTimeout' })]);
    expect((await pic(h, chat)).status).toBe(200);
  }, 30_000);

  it('reads the group members only while the phone is connected', async () => {
    const calls: string[] = [];
    let connected = false;
    const { db, h, client } = await bootPicture({ groupMembers: async (g) => { calls.push(g); return []; }, connected: () => connected });
    // A message with a tag nobody in the chat is known by: naming it is what asks for the group's members.
    await insertMessage(db, { waId: 'W3', clientId: client, senderJid: 'j1', senderNumber: null, senderName: null, fromMe: false, ts: '2026-10-10T04:06:00.000Z', text: 'ask @919800000077 please', quotedWaId: null, mediaType: null });
    const tagged = (await createTask(db, { clientId: client, side: 'us', title: 'Tag', category: 'design', priority: 'major', assignedTo: null, askedBy: null, raisedOn: '2026-10-10',
      deadline: null, latestProgress: null, sourceQuote: null, sourceDate: null, sourceWaId: 'W3', origin: 'whatsapp' }, NOW)).code;
    expect((await pic(h, tagged)).status).toBe(200);
    expect(calls).toEqual([]); // not connected: WhatsApp is not asked
    connected = true;
    expect((await pic(h, tagged)).status).toBe(200);
    expect(calls).toEqual([SHARMA_GROUP]);
  }, 30_000);

  it('answers 500 with a plain message and logs only the error name when drawing fails', async () => {
    const { h, chat, warned } = await bootPicture();
    vi.mocked(chatPicture.drawChatPicture).mockRejectedValueOnce(Object.assign(new Error('secret words from the chat'), { name: 'SharpFail' }));
    const r = await pic(h, chat);
    expect(r.status).toBe(500);
    const text = await r.text();
    expect(text).not.toMatch(/secret words|SharpFail/);
    expect(JSON.parse(text).error.code).toBe('internal');
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ code: 'SharpFail' });
    expect(JSON.stringify(warned)).not.toMatch(/secret words/);
  });
});

describe('work API: tracker export', () => {
  const PATH = '/dashboard/api/tracker/export';
  /** The raw reply: the shared helper reads bodies as text, which would damage a zip. */
  async function download(h: Awaited<ReturnType<typeof boot>>['h'], signedIn: boolean | string = true, extra: Record<string, string> = {}) {
    const { id } = await h.sessions.create(typeof signedIn === 'string' ? signedIn : OWNER);
    const r = await fetch(`http://127.0.0.1:${h.port}${PATH}`, { headers: { ...extra, ...(signedIn ? { cookie: `wa_session=${id}` } : {}) } });
    return { status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) };
  }

  it('is closed to a signed-out visitor, with no body', async () => {
    const { h } = await boot();
    const r = await download(h, false);
    expect(r.status).toBe(401);
    expect(r.body.subarray(0, 2).toString('latin1')).not.toBe('PK');
  });

  it('sends the workbook with the download headers, named by the IST date', async () => {
    const { h } = await boot();
    const r = await download(h);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="Tracker-2026-10-19.xlsx"');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.body.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('allows one export per 10 seconds per owner', async () => {
    const { h } = await boot();
    expect((await download(h)).status).toBe(200);
    const second = await download(h);
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('10');
    expect(second.body.toString('utf8')).toContain('rate_limited');
  });

  it('allows the next export 10 seconds on, and another owner is not held back by the first', async () => {
    const { h, clock } = await boot();
    expect((await download(h)).status).toBe(200);
    expect((await download(h, 'second@example.com')).status).toBe(200);
    expect((await download(h)).status).toBe(429);
    clock.advance(9_000);
    expect((await download(h)).status).toBe(429);
    clock.advance(1_000);
    expect((await download(h)).status).toBe(200);
  });

  it('a clock that steps back does not hold the owner', async () => {
    const { h, clock } = await boot();
    expect((await download(h)).status).toBe(200);
    clock.advance(-3_600_000);
    expect((await download(h)).status).toBe(200);
    expect((await download(h)).status).toBe(429); // the gap counts again from that export
  });

  it('a build that never finishes ends as a 500 and frees the owner', async () => {
    let hang = true;
    const { h } = await boot({ exportTimeoutMs: 50, book: () => (hang ? new Promise<Buffer>(() => undefined) : Promise.resolve(Buffer.from('PK-x', 'latin1'))) });
    expect((await download(h)).status).toBe(500);
    hang = false;
    expect((await download(h)).status).toBe(200);
  });

  it('an audit failure gives a 500 and no file, and an immediate retry works', async () => {
    const failAudit = { on: true };
    const { db, h } = await boot({ failAudit });
    const r = await download(h);
    expect(r.status).toBe(500);
    expect(r.body.subarray(0, 2).toString('latin1')).not.toBe('PK');
    failAudit.on = false;
    expect((await download(h)).status).toBe(200);
    expect((await auditRows(db)).filter((x) => x.event === 'tracker.export')).toHaveLength(1);
    expect((await download(h)).status).toBe(429);
  });

  it('a failed build does not use up the limit', async () => {
    let fail = true;
    const { h } = await boot({ book: async () => { if (fail) throw new Error('secret failure'); return Buffer.from('PK-x', 'latin1'); } });
    expect((await download(h)).status).toBe(500);
    fail = false;
    expect((await download(h)).status).toBe(200);
    expect((await download(h)).status).toBe(429);
  });

  it('refuses a cross-site request before anything else; same-origin, same-site, none and no header are allowed', async () => {
    const { db, h, clock } = await boot();
    const r = await download(h, true, { 'sec-fetch-site': 'cross-site' });
    expect(r.status).toBe(403);
    expect(r.body.subarray(0, 2).toString('latin1')).not.toBe('PK');
    expect(await auditRows(db)).toEqual([]);
    for (const v of ['same-origin', 'same-site', 'none']) {
      expect((await download(h, true, { 'sec-fetch-site': v })).status, v).toBe(200);
      clock.advance(10_000);
    }
    expect((await download(h)).status).toBe(200);
  });

  it('writes an audit line with the owner and request id and no file content', async () => {
    const { db, h } = await boot();
    await download(h);
    const lines = await auditRows(db);
    expect(lines).toEqual([{ actor: OWNER, event: 'tracker.export', kind: 'ops', detail: 'Tracker exported as an Excel file', requestId: expect.stringMatching(/^[0-9a-f]{12}$/) }]);
    expect(JSON.stringify(lines)).not.toContain('founder-workbook');
  });

  it('answers 503 in plain words without a builder (a setup shell)', async () => {
    const { h } = await boot({ book: null });
    const r = await download(h);
    expect(r.status).toBe(503);
    expect(r.body.toString('utf8')).toContain('not ready');
  });

  it('answers a failed build in plain words, with no error text', async () => {
    const { h } = await boot({ book: async () => { throw new Error('secret failure'); } });
    const r = await download(h);
    expect(r.status).toBe(500);
    expect(r.body.toString('utf8')).not.toContain('secret');
  });
});
