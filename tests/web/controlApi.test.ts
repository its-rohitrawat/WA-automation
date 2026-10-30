import { afterEach, describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/config/env.ts';
import { PrioritySettings } from '../../src/config/prioritySettings.ts';
import { SettingsStore } from '../../src/config/settingsStore.ts';
import { UptimeLog } from '../../src/health/uptimeLog.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import type { Db } from '../../src/store/db.ts';
import { manualClock } from '../../src/util/clock.ts';
import { AuditLog } from '../../src/web/audit.ts';
import { registerControlApi } from '../../src/web/routes/controlScreens.ts';
import { NOW, seededDb } from '../helpers/db.ts';
import { bootDashboard, OWNER } from '../helpers/web.ts';
import { rawOf } from '../../src/store/engine/sqlite.ts';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

const NUMBER = '919812345678';

async function boot(o: { linked?: boolean; secureCookies?: boolean; actionCapacity?: number; auditThrows?: boolean } = {}) {
  const db = await seededDb();
  const clock = manualClock(NOW);
  const real = new AuditLog(db, clock);
  const audit = o.auditThrows ? { record: async () => { throw new Error('disk full'); } } : real;
  const spend = new SpendGuard({ db, clock, capUsd: 10 });
  const uptime = new UptimeLog(db, clock);
  await uptime.start(true);
  const settings = new SettingsStore({ db, env: parseEnv({ REPORT_RECIPIENT: NUMBER }), clock, spareLinked: () => o.linked ?? true });
  let sessions!: Parameters<Parameters<typeof bootDashboard>[0]['mount']>[1]['sessions'];
  const h = await bootDashboard({
    db, clock, actionCapacity: o.actionCapacity,
    mount: (router, x) => {
      sessions = x.sessions;
      registerControlApi(router, {
        ...x, db, clock, audit, spend, voiceLocal: true, uptime: { log: uptime }, isOwner: (e) => e.toLowerCase() === OWNER, settings, priority: new PrioritySettings({ db, clock }), sessions: x.sessions,
        secureFor: () => o.secureCookies ?? false,
      });
    },
  });
  closers.push(() => h.close());
  return { db, h, audit: real, sessions };
}

const auditRows = (db: Db) => rawOf(db).prepare('SELECT actor, event, kind, detail FROM audit_log ORDER BY id').all();
const requestIds = (db: Db) => (rawOf(db).prepare('SELECT request_id AS r FROM audit_log ORDER BY id').all() as { r: string | null }[]).map((x) => x.r);

describe('control API: reads', () => {
  it('needs a signed-in owner', async () => {
    const { h } = await boot();
    for (const path of ['/dashboard/api/usage', '/dashboard/api/uptime', '/dashboard/api/audit', '/dashboard/api/settings', '/dashboard/api/session']) {
      expect((await h.get(path, { cookie: null })).status, path).toBe(401);
    }
  });

  it('serves usage, uptime, audit and the masked settings', async () => {
    const { h } = await boot();
    expect(await h.get('/dashboard/api/usage')).toMatchObject({ status: 200, json: { today: { capUsd: 10 }, days: expect.any(Array) } });
    expect(await h.get('/dashboard/api/uptime')).toMatchObject({ status: 200, json: { source: 'agent', ratios: expect.any(Object) } });
    expect(await h.get('/dashboard/api/audit?kind=config')).toMatchObject({ status: 200, json: { rows: [], next: null } });
    expect((await h.get('/dashboard/api/audit?kind=chat')).status).toBe(400);
    const s = await h.get('/dashboard/api/settings');
    expect(s).toMatchObject({ status: 200, json: { recipientMasked: '…5678' } });
    expect(JSON.stringify(s.json)).not.toContain('9812345678');
  });

  it("gives the owner's own session", async () => {
    const { h } = await boot();
    expect(await h.get('/dashboard/api/session')).toMatchObject({ status: 200, json: { email: OWNER, createdAt: NOW, expiresAt: expect.any(String) } });
  });
});

describe('control API: settings', () => {
  it('changes a setting with CSRF, audits it, and answers with the masked view', async () => {
    const { db, h } = await boot();
    expect((await h.post('/dashboard/api/settings', { body: { key: 'reportDays', value: 'daily' }, csrf: null })).status).toBe(403);
    expect(await h.post('/dashboard/api/settings', { body: { key: 'reportDays', value: 'daily' } })).toMatchObject({ status: 200, json: { reportDays: 'daily' } });
    expect(auditRows(db)).toEqual([{ actor: OWNER, event: 'settings.reportDays', kind: 'config', detail: 'Morning briefing days set to every day' }]);
  });

  it('sets the send time with CSRF, owner-only, checked on the server and audited', async () => {
    const { db, h } = await boot();
    const time = { key: 'reportTime', value: '07:30' };
    expect((await h.post('/dashboard/api/settings', { body: time, csrf: null })).status).toBe(403);
    expect((await h.post('/dashboard/api/settings', { body: time, cookie: null })).status).toBe(401);
    for (const value of ['7:30', '07:30:00', '25:00', 730]) {
      expect(await h.post('/dashboard/api/settings', { body: { key: 'reportTime', value } }), String(value)).toMatchObject({ status: 422, json: { error: { field: 'reportTime' } } });
    }
    expect(auditRows(db)).toEqual([]);
    // 13:30 IST: 07:30 has passed today, so it starts tomorrow. The briefing is off, so there is no next report.
    expect(await h.post('/dashboard/api/settings', { body: time })).toMatchObject({ status: 200, json: { sendAt: '07:30', nextReport: null, source: { reportTime: 'dashboard' } } });
    expect(auditRows(db)).toEqual([{ actor: OWNER, event: 'settings.reportTime', kind: 'config', detail: 'Morning briefing time set to 07:30 IST, from tomorrow' }]);
    expect(await h.get('/dashboard/api/settings')).toMatchObject({ json: { sendAt: '07:30' } });
  });

  it('needs the new number typed twice, and never sends it back', async () => {
    const { db, h } = await boot();
    const other = '917012349999';
    expect(await h.post('/dashboard/api/settings', { body: { key: 'reportRecipient', value: other } })).toMatchObject({ status: 422, json: { error: { field: 'confirm' } } });
    expect(await h.post('/dashboard/api/settings', { body: { key: 'reportRecipient', value: other, confirm: '917012340000' } }))
      .toMatchObject({ status: 422, json: { error: { message: 'The two numbers do not match' } } });
    const ok = await h.post('/dashboard/api/settings', { body: { key: 'reportRecipient', value: other, confirm: '+91 70123 49999' } });
    expect(ok).toMatchObject({ status: 200, json: { recipientMasked: '…9999' } });
    expect(JSON.stringify(ok.json)).not.toContain('7012349999');
    expect(JSON.stringify(auditRows(db))).not.toContain('7012349999');
  });

  it('refuses to switch on before the spare phone is linked, and bad keys or values', async () => {
    const { h } = await boot({ linked: false });
    expect(await h.post('/dashboard/api/settings', { body: { key: 'reportEnabled', value: true, confirm: true } })).toMatchObject({ status: 409, json: { error: { field: 'reportEnabled' } } });
    expect((await h.post('/dashboard/api/settings', { body: { key: 'dailySpendCap', value: 100 } })).status).toBe(422);
    expect((await h.post('/dashboard/api/settings', { body: { key: 'reportDays', value: 'sundays' } })).status).toBe(422);
    expect((await h.post('/dashboard/api/settings', { body: [] })).status).toBe(422);
  });
});

describe('control API: sign out everywhere', () => {
  it('ends every session of the owner, clears the cookie and audits it', async () => {
    const { db, h, sessions } = await boot();
    const second = (await sessions.create(OWNER)).id;
    const r = await h.post('/dashboard/api/session/signout-everywhere');
    expect(r).toMatchObject({ status: 200, json: { ended: 2 } });
    expect(String(r.headers['set-cookie'])).toMatch(/^wa_session=; HttpOnly; SameSite=Lax; Path=\/dashboard; Max-Age=0/);
    expect((await h.get('/dashboard/api/session')).status).toBe(401);
    expect((await h.get('/dashboard/api/session', { cookie: second })).status).toBe(401);
    expect(auditRows(db)).toEqual([{ actor: OWNER, event: 'auth.signout_everywhere', kind: 'auth', detail: 'Signed out everywhere (2 sessions)' }]);
  });

  it('needs CSRF', async () => {
    const { h } = await boot();
    expect((await h.post('/dashboard/api/session/signout-everywhere', { csrf: null })).status).toBe(403);
    expect((await h.get('/dashboard/api/session')).status).toBe(200);
  });
});

describe('control API: priority and sentiment settings', () => {
  const PATH = '/dashboard/api/settings/priority';
  const LISTS = { critical: ['urgent'], major: [], medium: [], low: ['no rush'] };

  it('needs a signed-in owner to read, and answers the lists, the switch and the limits', async () => {
    const { h } = await boot();
    expect((await h.get(PATH, { cookie: null })).status).toBe(401);
    expect(await h.get(PATH)).toMatchObject({
      status: 200, json: { sentimentEnabled: false, keywords: { critical: expect.any(Array) }, source: { priorityKeywords: 'default' }, limits: { perLevel: 30, maxChars: 40 } },
    });
  });

  it('saves keywords and the switch only with the owner, the Origin and CSRF, and audits each', async () => {
    const { db, h } = await boot();
    expect((await h.post(PATH, { cookie: null, body: { key: 'sentimentEnabled', value: true } })).status).toBe(401);
    expect((await h.post(PATH, { origin: 'https://evil.example', body: { key: 'sentimentEnabled', value: true } })).status).toBe(403);
    expect((await h.post(PATH, { csrf: null, body: { key: 'sentimentEnabled', value: true } })).status).toBe(403);
    expect(auditRows(db)).toEqual([]);
    expect(await h.post(PATH, { body: { key: 'priorityKeywords', value: LISTS } })).toMatchObject({ status: 200, json: { keywords: LISTS, source: { priorityKeywords: 'dashboard' } } });
    expect(await h.post(PATH, { body: { key: 'sentimentEnabled', value: true } })).toMatchObject({ status: 200, json: { sentimentEnabled: true } });
    expect(auditRows(db)).toEqual([
      { actor: OWNER, event: 'settings.priorityKeywords', kind: 'config', detail: 'Priority keywords saved (Critical 1, Major 0, Medium 0, Low 1)' },
      { actor: OWNER, event: 'settings.sentimentEnabled', kind: 'config', detail: 'Sentiment analysis switched on' },
    ]);
    expect(requestIds(db).every((r) => typeof r === 'string' && r.length > 0)).toBe(true);
  });

  it('refuses bad keys and values with 422, naming the field', async () => {
    const { db, h } = await boot();
    expect(await h.post(PATH, { body: { key: 'reportEnabled', value: true } })).toMatchObject({ status: 422, json: { error: { field: 'key' } } });
    expect(await h.post(PATH, { body: { key: 'sentimentEnabled', value: 'on' } })).toMatchObject({ status: 422, json: { error: { field: 'sentimentEnabled' } } });
    expect(await h.post(PATH, { body: { key: 'priorityKeywords', value: { ...LISTS, major: ['Urgent'] } } }))
      .toMatchObject({ status: 422, json: { error: { field: 'major', message: 'Major keyword 1 is already in Critical: keep each keyword in one list' } } });
    expect((await h.post(PATH, { body: [] })).status).toBe(422);
    expect((await h.post(PATH, { body: { value: true } })).status).toBe(422);
    expect(auditRows(db)).toEqual([]);
  });
});

describe('control API review fixes', () => {
  const POSTS = ['/dashboard/api/settings', '/dashboard/api/session/signout-everywhere'];

  it('every POST needs an owner, the Origin and the CSRF token, before the body is read', async () => {
    const { db, h } = await boot();
    for (const path of POSTS) {
      expect((await h.post(path, { cookie: null, body: { key: 'reportDays', value: 'daily' } })).status, path).toBe(401);
      expect((await h.post(path, { origin: null, body: { key: 'reportDays', value: 'daily' } })).status, path).toBe(403);
      expect((await h.post(path, { origin: 'https://evil.example', body: { key: 'reportDays', value: 'daily' } })).status, path).toBe(403);
      expect((await h.post(path, { csrf: null, raw: 'not json' })).status, path).toBe(403); // not 400: CSRF comes first
    }
    expect(auditRows(db)).toEqual([]);
    expect((await h.get('/dashboard/api/session')).status).toBe(200);
  });

  it('refuses a body over 16 KiB with 413', async () => {
    const { h } = await boot();
    expect((await h.post('/dashboard/api/settings', { body: { key: 'reportDays', value: 'x'.repeat(17_000) } })).status).toBe(413);
  });

  it('switching the briefing on needs the confirmation; off does not', async () => {
    const { h } = await boot();
    expect(await h.post('/dashboard/api/settings', { body: { key: 'reportEnabled', value: true } })).toMatchObject({ status: 422, json: { error: { field: 'confirm' } } });
    expect(await h.post('/dashboard/api/settings', { body: { key: 'reportEnabled', value: true, confirm: 'yes' } })).toMatchObject({ status: 422 });
    expect(await h.post('/dashboard/api/settings', { body: { key: 'reportEnabled', value: true, confirm: true } })).toMatchObject({ status: 200, json: { reportEnabled: true } });
    expect(await h.post('/dashboard/api/settings', { body: { key: 'reportEnabled', value: false } })).toMatchObject({ status: 200, json: { reportEnabled: false } });
  });

  it('audit rows from settings and sign out carry the request id', async () => {
    const { db, h } = await boot();
    await h.post('/dashboard/api/settings', { body: { key: 'reportDays', value: 'daily' } });
    await h.post('/dashboard/api/session/signout-everywhere');
    expect(requestIds(db)).toEqual([expect.stringMatching(/^[0-9a-f]{12}$/), expect.stringMatching(/^[0-9a-f]{12}$/)]);
  });

  it('the session answer has exactly the email, the two times and the browser label', async () => {
    const { h } = await boot();
    const r = await h.get('/dashboard/api/session');
    expect(Object.keys(r.json as object).sort()).toEqual(['browser', 'createdAt', 'email', 'expiresAt']);
  });

  it('control changes count against the action limit; refused requests do not', async () => {
    const { h } = await boot({ actionCapacity: 1 });
    expect((await h.post('/dashboard/api/settings', { csrf: null, body: { key: 'reportDays', value: 'daily' } })).status).toBe(403);
    expect((await h.post('/dashboard/api/settings', { cookie: null, body: { key: 'reportDays', value: 'daily' } })).status).toBe(401);
    expect((await h.post('/dashboard/api/settings', { body: { key: 'reportDays', value: 'daily' } })).status).toBe(200);
    const r = await h.post('/dashboard/api/session/signout-everywhere');
    expect(r.status).toBe(429);
    expect((await h.get('/dashboard/api/session')).status).toBe(200);
  });

  it('clears the cookie as Secure behind https', async () => {
    const { h } = await boot({ secureCookies: true });
    expect(String((await h.post('/dashboard/api/session/signout-everywhere')).headers['set-cookie'])).toMatch(/Max-Age=0; Secure$/);
  });

  it('ends no session when the audit row cannot be written', async () => {
    const { h } = await boot({ auditThrows: true });
    expect((await h.post('/dashboard/api/session/signout-everywhere')).status).toBe(500);
    expect((await h.get('/dashboard/api/session')).status).toBe(200);
  });
});
