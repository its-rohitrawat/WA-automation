import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FOUNDER_TENANT_ID, parseEnv } from '../../src/config/env.ts';
import { dbGroupsStore } from '../../src/config/groupsStore.ts';
import { AiKeys } from '../../src/platform/aiKey.ts';
import { ensurePlatformSchema } from '../../src/platform/schema.ts';
import { createTenant, ensureFounderTenant } from '../../src/platform/store.ts';
import { TenantKeys } from '../../src/platform/tenantKeys.ts';
import { buildCustomerRuntime, type CustomerRuntime } from '../../src/runtime/customerRuntime.ts';
import { platformSupervisor, type PlatformSupervisor } from '../../src/runtime/platformSupervisor.ts';
import { syncClients } from '../../src/store/clients.ts';
import { openDb, type Db } from '../../src/store/db.ts';
import { manualClock } from '../../src/util/clock.ts';
import { silentLogger } from '../../src/util/logger.ts';
import type { WebServer } from '../../src/web/server.ts';
import { SessionStore } from '../../src/web/sessions.ts';
import { startDashboard } from '../../src/web/start.ts';

// The DATA route sweep (Phase B 4): the founder and two customers, A and B, each with a running full runtime, and C in
// its setup shell. Each session reaches only its own customer's data, and each change touches only its own tenant. No
// server: SQLite stands in for each customer's Postgres Db, and the platform Db says it is Postgres, so sessions keep
// their customer. Every key here is a placeholder; no Claude, WhatsApp or Google call is made.

vi.mock('@anthropic-ai/sdk', () => ({ default: class { models = { list: async () => ({}) }; messages = { create: async () => ({}) }; } }));

const AT = '2026-10-30T10:00:00.000Z';
const OWNER = 'owner@example.com';
const WA_AUTH = `CREATE TABLE wa_auth (phone text NOT NULL, slot text NOT NULL DEFAULT 'live', k text NOT NULL, v blob NOT NULL, PRIMARY KEY (phone, slot, k))`;
const FOUNDER_CLIENT = { groupId: '120363111111111111@g.us', name: 'Sharma Interiors', code: 'SHI' };
const A_CLIENT = { groupId: '120363222222222222@g.us', name: 'Alpha Foods', code: 'ALF' };
const B_CLIENT = { groupId: '120363333333333333@g.us', name: 'Beta Works', code: 'BTW' };

function asPostgres(db: Db): Db {
  return { engine: 'postgres', get: (s, p) => db.get(s, p), all: (s, p) => db.all(s, p), run: (s, p) => db.run(s, p), exec: (s) => db.exec(s), tx: (fn) => db.tx(fn), close: async () => {} };
}

let dir: string;
const opened: Db[] = [];
let founderDb: Db;
let platform: Db;
let ps: PlatformSupervisor;
let founderRt: CustomerRuntime;
let web: WebServer;
let base: string;
const ids = { a: '', b: '', c: '' };
const dbs: Record<string, Db> = {};
type S = { id: string; csrf: string };
const s: Record<'founder' | 'a' | 'b' | 'c' | 'ownerInA', S> = {} as never;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wa-data-'));
  const groups = join(dir, 'allowed-groups.json');
  writeFileSync(groups, `${JSON.stringify({ clients: [{ ...FOUNDER_CLIENT, phases: ['Design'] }] })}\n`);
  const env = parseEnv({
    DATA_DIR: dir, GROUPS_FILE: groups, ANTHROPIC_API_KEY: 'sk-ant-founder-placeholder', DB_ENGINE: 'postgres', PLATFORM_ENABLED: 'true',
    DATABASE_URL: 'postgres://wa_app:placeholder@127.0.0.1:5432/wa_agent', DATABASE_PLATFORM_URL: 'postgres://wa_platform:placeholder@127.0.0.1:5432/wa_agent',
    DASHBOARD_ENABLED: 'true', DASHBOARD_OWNER_EMAILS: OWNER, DASHBOARD_GOOGLE_CLIENT_ID: 'web-client-placeholder', DASHBOARD_GOOGLE_CLIENT_SECRET: 'web-secret-placeholder',
  });
  const master = randomBytes(32);
  founderDb = openDb(':memory:');
  await founderDb.exec(WA_AUTH);
  await ensurePlatformSchema(founderDb);
  await ensureFounderTenant(founderDb, { name: 'Your business', at: AT });
  await founderDb.exec('ALTER TABLE web_sessions ADD COLUMN tenant_id TEXT'); // as Postgres keeps it
  opened.push(founderDb);
  platform = asPostgres(founderDb);
  const tenantKeys = new TenantKeys({ db: platform, master, clock: manualClock(AT) });
  for (const [k, client, keyed] of [['a', A_CLIENT, true], ['b', B_CLIENT, true], ['c', { ...B_CLIENT, name: 'Gamma Ltd', code: 'GAM' }, false]] as const) {
    ids[k] = (await createTenant(platform, { name: `Customer ${k}`, status: 'active', at: AT })).id;
    const db = openDb(':memory:');
    await db.exec(WA_AUTH);
    opened.push(db);
    dbs[ids[k]] = db;
    await dbGroupsStore({ db, onChange: () => undefined, log: silentLogger() }).apply({ approve: [client] });
    if (keyed) {
      await new AiKeys({ db, platform, tenantId: ids[k], dataKey: () => tenantKeys.dataKey(ids[k]), tester: async () => 'ok', clock: manualClock(AT) })
        .set(`sk-ant-customer-${k}-placeholder`, OWNER);
    }
  }
  // Members: a@ of A, b@ of B, c@ of C, and the founder's own email also of A (one person, two workspaces).
  const member = async (email: string, tenantId: string) => {
    const user = `00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`;
    await platform.run('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)', [user, email, null, AT]);
    await platform.run("INSERT INTO memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)", [tenantId, user, AT]);
  };
  await member('a@example.com', ids.a);
  await member('b@example.com', ids.b);
  await member('c@example.com', ids.c);
  await member(OWNER, ids.a);

  ps = platformSupervisor({ env, log: silentLogger(), clock: manualClock(AT), platformDb: platform, master, customerDb: (id) => dbs[id]!, keyTester: async () => 'ok', rssMb: () => 100, tickMs: 3_600_000 });
  founderRt = await buildCustomerRuntime(
    { id: FOUNDER_TENANT_ID, founder: true },
    { env, log: silentLogger(), db: founderDb, key: master, configs: [{ ...FOUNDER_CLIENT, phases: ['Design'], emailDomains: [], meetingKeywords: [] }], platformDb: platform, platformHooks: ps.hooks },
  );
  await ps.start();
  const fakeGoogle = { exchange: () => Promise.reject(new Error('no Google in tests')), verifier: () => Promise.reject(new Error('no Google in tests')) };
  web = (await startDashboard({
    env: { ...env, DASHBOARD_PORT: 0 }, db: founderDb, platformDb: platform, log: silentLogger(), control: founderRt.control, platform: founderRt.platform,
    customerSessions: true, ...founderRt.agentRoutes, tenants: ps.tenants, google: fakeGoogle,
  }))!;
  base = `http://127.0.0.1:${web.address()!.port}`;
  const sessions = new SessionStore(platform, { now: () => new Date() });
  s.founder = await sessions.create(OWNER, 'Test');
  s.ownerInA = await sessions.create(OWNER, 'Test', undefined, ids.a);
  s.a = await sessions.create('a@example.com', 'Test', undefined, ids.a);
  s.b = await sessions.create('b@example.com', 'Test', undefined, ids.b);
  s.c = await sessions.create('c@example.com', 'Test', undefined, ids.c);
}, 60_000);

afterAll(async () => {
  await web?.stop();
  await ps?.stop();
  await founderRt?.stop();
  for (const db of opened) await db.close().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: 'GET' | 'POST', path: string, who: S, body: unknown = {}) {
  const res = await fetch(`${base}${path}`, {
    method, redirect: 'manual', signal: AbortSignal.timeout(5000),
    headers: { cookie: `wa_session=${who.id}`, ...(method === 'POST' ? { origin: base, 'x-csrf-token': who.csrf, 'content-type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, text: await res.text().catch(() => '') };
}

describe('the DATA route sweep: each session reaches only its own customer (Phase B 4)', () => {
  it('the clients list and a client: each sees its own, and another’s code is 404', async () => {
    const mine = { founder: FOUNDER_CLIENT, a: A_CLIENT, b: B_CLIENT } as const;
    for (const who of ['founder', 'a', 'b'] as const) {
      const list = await call('GET', '/dashboard/api/clients', s[who]);
      expect(list.status, who).toBe(200);
      for (const [other, c] of Object.entries(mine)) {
        if (other === who) expect(list.text, who).toContain(c.name);
        else expect(list.text, `${who} sees ${other}`).not.toContain(c.name);
      }
      for (const [other, c] of Object.entries(mine)) {
        const one = await call('GET', `/dashboard/api/clients/${c.code}`, s[who]);
        expect(one.status, `${who} → ${other}'s ${c.code}`).toBe(other === who ? 200 : 404);
      }
    }
  });

  it('a customer whose runtime is not running (C, setup shell) gets 503 from the agent’s routes, never anyone’s data', async () => {
    const r = await call('GET', '/dashboard/api/clients', s.c);
    expect(r.status).toBe(503);
    expect(r.text).not.toMatch(/Sharma|Alpha|Beta/);
  });

  it('settings: a change by A lands in A’s own settings only (its daily Claude limit), never B’s or the founder’s', async () => {
    const r = await call('POST', '/dashboard/api/settings', s.a, { key: 'dailySpendCapUsd', value: 12 });
    expect(r.status).toBe(200);
    const stored = async (db: Db) => (await db.get<{ v: string }>("SELECT v FROM settings WHERE k = 'dailySpendCapUsd'"))?.v;
    expect(await stored(dbs[ids.a]!)).toBe('12');
    expect(await stored(dbs[ids.b]!)).toBeUndefined();
    expect(await stored(founderDb)).toBeUndefined();
    expect((await call('GET', '/dashboard/api/settings', s.b)).text).not.toContain('"dailySpendCapUsd":12');
  });

  it('the audit list: each sees its own rows only', async () => {
    const a = await call('GET', '/dashboard/api/audit', s.a);
    expect(a.status).toBe(200);
    expect(a.text).toContain('Daily Claude limit'); // A's own change above
    expect((await call('GET', '/dashboard/api/audit', s.b)).text).not.toContain('Daily Claude limit');
    expect((await call('GET', '/dashboard/api/audit', s.founder)).text).not.toContain('Daily Claude limit');
  });

  it('sign out everywhere in A ends that email’s A sessions only: the same person’s founder session stays (no unscoped delete)', async () => {
    const r = await call('POST', '/dashboard/api/session/signout-everywhere', s.ownerInA);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ ended: 1 });
    expect((await call('GET', '/dashboard/api/me', s.ownerInA)).status).toBe(401);
    expect((await call('GET', '/dashboard/api/me', s.founder)).status).toBe(200); // the founder's own, untouched
    expect((await call('GET', '/dashboard/api/me', s.a)).status).toBe(200); // another email in A, untouched
  });

  it('no response to A, from ANY route, holds B’s or the founder’s names or group ids', async () => {
    const foreign = [FOUNDER_CLIENT.name, FOUNDER_CLIENT.groupId, B_CLIENT.name, B_CLIENT.groupId, 'Customer b'];
    const leaks: string[] = [];
    for (const r of web.router.routes()) {
      // Signing out, the event stream and the key routes (which really remove A's key and restart it) are checked elsewhere.
      if (r.pattern === '/dashboard/auth/logout' || r.pattern.endsWith('/signout-everywhere') || r.pattern === '/dashboard/api/whatsapp/link/stream' || r.pattern.includes('/ai-key')) continue;
      const path = r.pattern.replace(/:(\w+)/g, (_m, p: string) => (p === 'code' ? A_CLIENT.code : p === 'name' ? 'publish' : 'x'));
      const res = await call(r.method, path, s.a);
      for (const f of foreign) if (res.text.includes(f)) leaks.push(`${r.method} ${r.pattern} -> ${f}`);
    }
    expect(leaks).toEqual([]);
  });
});
