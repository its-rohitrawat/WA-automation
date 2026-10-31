import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FOUNDER_TENANT_ID, parseEnv } from '../../src/config/env.ts';
import { ensurePlatformSchema } from '../../src/platform/schema.ts';
import { ensureFounderTenant } from '../../src/platform/store.ts';
import { buildCustomerRuntime, type CustomerRuntime } from '../../src/runtime/customerRuntime.ts';
import { syncClients } from '../../src/store/clients.ts';
import type { Db } from '../../src/store/db.ts';
import type { Sql } from '../../src/store/engine/types.ts';
import { silentLogger } from '../../src/util/logger.ts';
import type { WebServer } from '../../src/web/server.ts';
import { SessionStore } from '../../src/web/sessions.ts';
import { startDashboard } from '../../src/web/start.ts';
import { MEHTA, onSqlite, seededDb, SHARMA } from '../helpers/db.ts';
import { freshPg, type FreshPg } from '../helpers/freshPg.ts';

// The workspace chooser on the real dashboard: a member of two customer workspaces (Acme and Beta) lists and switches
// between them; a member of a third (Gamma) is never shown to it. On SQLite the sessions are kept as on Postgres
// (tenant_id) on test in-memory stores. On Postgres every store is the real one, in a database of this file's own (the
// founder's id and these customers' ids are fixed). Every key here is a placeholder.

const AT = '2026-10-30T10:00:00.000Z';
const OWNER = 'owner@example.com';
const MEMBER = 'member@example.com';
const OTHER = 'other@example.com';
const T = { acme: '00000000-0000-4000-8000-0000000000a1', beta: '00000000-0000-4000-8000-0000000000b2', gamma: '00000000-0000-4000-8000-0000000000c3' };
const NAMES: Record<string, string> = { [T.acme]: 'Acme', [T.beta]: 'Beta', [T.gamma]: 'Gamma' };

/** The customer whose audit rows cannot be written right now (none: ''), on either engine, with no trigger. */
const auditDown = { tenant: '' };
function withAuditSwitch(tenantId: string, db: Db): Db {
  const check = (sql: string) => {
    if (auditDown.tenant === tenantId && /^\s*INSERT INTO audit_log/i.test(sql)) throw new Error('audit down');
  };
  const wrap = (q: Sql): Sql => ({
    get: async (sql, p) => (check(sql), q.get(sql, p)),
    all: async (sql, p) => (check(sql), q.all(sql, p)),
    run: async (sql, p) => (check(sql), q.run(sql, p)),
    exec: (sql) => q.exec(sql),
  }) as Sql;
  return { ...wrap(db), engine: db.engine, tx: (fn) => db.tx((q) => fn(wrap(q))), close: () => db.close() } as Db;
}

/** On SQLite: the test's store as the Postgres platform Db, so SessionStore keeps each session's tenant_id. */
function asPostgres(db: Db): Db {
  return { engine: 'postgres', get: (s, p) => db.get(s, p), all: (s, p) => db.all(s, p), run: (s, p) => db.run(s, p), exec: (s) => db.exec(s), tx: (fn) => db.tx(fn), close: async () => {} };
}

let dir: string;
let fresh: FreshPg | undefined;
/** The founder's tracker. */
let db: Db;
/** The platform tables (the same store as db on SQLite). */
let platformDb: Db;
let rt: CustomerRuntime;
let web: WebServer;
let base: string;
let sessions: SessionStore;
const customerDbs: Record<string, Db> = {};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wa-workspaces-'));
  const groups = join(dir, 'allowed-groups.json');
  writeFileSync(groups, '[]');
  const env = parseEnv({
    DATA_DIR: dir, GROUPS_FILE: groups, ANTHROPIC_API_KEY: 'placeholder-key', PLATFORM_ENABLED: 'true',
    DASHBOARD_ENABLED: 'true', DASHBOARD_OWNER_EMAILS: OWNER,
    DASHBOARD_GOOGLE_CLIENT_ID: 'placeholder-client', DASHBOARD_GOOGLE_CLIENT_SECRET: 'placeholder-secret',
  });
  let customerDbOf: (id: string) => Promise<Db>;
  if (onSqlite) {
    db = await seededDb();
    await ensurePlatformSchema(db);
    await db.exec('ALTER TABLE web_sessions ADD COLUMN tenant_id TEXT'); // Postgres's web_sessions.tenant_id
    platformDb = asPostgres(db);
    customerDbOf = () => seededDb();
  } else {
    const f = (fresh = await freshPg());
    db = f.tenantDb(FOUNDER_TENANT_ID);
    await syncClients(db, [SHARMA, MEHTA]);
    platformDb = f.platformDb();
    customerDbOf = async (id) => {
      const c = f.tenantDb(id);
      await syncClients(c, [SHARMA, MEHTA]);
      return c;
    };
  }
  await ensureFounderTenant(platformDb, { name: 'Your business', at: AT });
  const users = { [MEMBER]: '00000000-0000-4000-8000-0000000000e1', [OTHER]: '00000000-0000-4000-8000-0000000000e2' };
  for (const [email, id] of Object.entries(users)) await platformDb.run('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)', [id, email, null, AT]);
  for (const [k, id] of Object.entries(T)) {
    await platformDb.run("INSERT INTO tenants (id, kind, name, status, created_at, updated_at) VALUES (?, 'customer', ?, 'active', ?, ?)", [id, NAMES[id], AT, AT]);
    // The member is in Acme (first) and Beta; the other member in Gamma only.
    const who = k === 'gamma' ? users[OTHER]! : users[MEMBER]!;
    const created = k === 'acme' ? '2026-10-30T09:00:00.000Z' : AT;
    await platformDb.run("INSERT INTO memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)", [id, who, created]);
    customerDbs[id] = withAuditSwitch(id, await customerDbOf(id));
  }
  rt = await buildCustomerRuntime({ id: FOUNDER_TENANT_ID, founder: true }, { env, log: silentLogger(), key: randomBytes(32), db, configs: [], platformDb });
  const fakeGoogle = { exchange: () => Promise.reject(new Error('no Google in tests')), verifier: () => Promise.reject(new Error('no Google in tests')) };
  web = (await startDashboard({
    env: { ...env, DASHBOARD_PORT: 0 }, db, platformDb, log: silentLogger(), control: rt.control, platform: rt.platform, customerSessions: true,
    customerDb: (id) => customerDbs[id]!, ...rt.agentRoutes, google: fakeGoogle,
  }))!;
  base = `http://127.0.0.1:${web.address()!.port}`;
  sessions = new SessionStore(platformDb, { now: () => new Date() });
}, 60_000);

afterAll(async () => {
  await web?.stop();
  await rt?.stop();
  for (const d of Object.values(customerDbs)) await d.close();
  await db?.close();
  await fresh?.drop();
  rmSync(dir, { recursive: true, force: true });
});

type S = { id: string; csrf: string };
async function call(method: 'GET' | 'POST', path: string, s: S, body: unknown = {}, o: { csrf?: boolean } = {}) {
  const res = await fetch(`${base}${path}`, {
    method, redirect: 'manual', signal: AbortSignal.timeout(5000),
    headers: {
      cookie: `wa_session=${s.id}`,
      ...(method === 'POST' ? { origin: base, 'content-type': 'application/json', ...(o.csrf === false ? {} : { 'x-csrf-token': s.csrf }) } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, text: await res.text(), cookie: res.headers.get('set-cookie') };
}
const json = (t: string) => JSON.parse(t) as Record<string, unknown>;
const newId = (cookie: string | null) => /wa_session=([^;]+)/.exec(cookie ?? '')?.[1];
const auditOf = (id: string) => customerDbs[id]!.all<{ event: string; detail: string }>("SELECT event, detail FROM audit_log WHERE kind = 'auth' ORDER BY id");

describe('the workspace chooser (a member of several customer workspaces)', () => {
  it('/me gives a member a count only: 2 for the member of Acme and Beta, 1 for Gamma’s; the founder’s /me is unchanged', async () => {
    const member = await sessions.create(MEMBER, 'Test', undefined, T.acme);
    const me = json((await call('GET', '/dashboard/api/me', member)).text);
    expect(me.workspaces).toBe(2);
    expect(JSON.stringify(me)).not.toMatch(/Acme|Beta|Gamma/);
    expect(json((await call('GET', '/dashboard/api/me', await sessions.create(OTHER, 'Test', undefined, T.gamma))).text).workspaces).toBe(1);
    expect(json((await call('GET', '/dashboard/api/me', await sessions.create(OWNER, 'Test'))).text)).not.toHaveProperty('workspaces');
  });

  it('lists only the member’s own workspaces, first one first, never another customer’s; the founder gets none', async () => {
    const member = await sessions.create(MEMBER, 'Test', undefined, T.acme);
    const r = await call('GET', '/dashboard/api/workspaces', member);
    expect(r.status).toBe(200);
    expect(json(r.text)).toEqual({ workspaces: [{ id: T.acme, name: 'Acme', current: true }, { id: T.beta, name: 'Beta', current: false }] });
    expect(r.text).not.toContain('Gamma');
    expect(r.text).not.toContain(T.gamma);
    const other = await call('GET', '/dashboard/api/workspaces', await sessions.create(OTHER, 'Test', undefined, T.gamma));
    expect(json(other.text)).toEqual({ workspaces: [{ id: T.gamma, name: 'Gamma', current: true }] });
    expect((await call('GET', '/dashboard/api/workspaces', await sessions.create(OWNER, 'Test'))).status).toBe(403);
  });

  it('a workspace the member is not in is unknown (404), a bad id 400, no CSRF token 403; the session stays as it was', async () => {
    const member = await sessions.create(MEMBER, 'Test', undefined, T.acme);
    expect((await call('POST', '/dashboard/api/workspaces/switch', member, { tenantId: T.gamma })).status).toBe(404);
    expect((await call('POST', '/dashboard/api/workspaces/switch', member, { tenantId: '00000000-0000-4000-8000-0000000000ff' })).status).toBe(404);
    expect((await call('POST', '/dashboard/api/workspaces/switch', member, { tenantId: FOUNDER_TENANT_ID })).status).toBe(404);
    expect((await call('POST', '/dashboard/api/workspaces/switch', member, { tenantId: 'acme' })).status).toBe(400);
    expect((await call('POST', '/dashboard/api/workspaces/switch', member, { tenantId: T.beta }, { csrf: false })).status).toBe(403);
    const still = json((await call('GET', '/dashboard/api/workspaces', member)).text);
    expect((still.workspaces as { current: boolean; id: string }[]).find((w) => w.current)?.id).toBe(T.acme);
    expect((await call('POST', '/dashboard/api/workspaces/switch', await sessions.create(OWNER, 'Test'), { tenantId: T.acme })).status).toBe(403);
  });

  it('switching makes a new session in that workspace and ends the old one, audit rows first, naming no workspace', async () => {
    const member = await sessions.create(MEMBER, 'Test', undefined, T.acme);
    const before = { acme: (await auditOf(T.acme)).length, beta: (await auditOf(T.beta)).length };
    expect(json((await call('POST', '/dashboard/api/workspaces/switch', member, { tenantId: T.acme })).text)).toEqual({ switched: false });
    const r = await call('POST', '/dashboard/api/workspaces/switch', member, { tenantId: T.beta });
    expect(r.status).toBe(200);
    expect(json(r.text)).toEqual({ switched: true });
    const id = newId(r.cookie);
    expect(id).toBeDefined();
    expect(id).not.toBe(member.id);
    expect(r.cookie).toMatch(/HttpOnly/);
    // The old session is gone; the new one is Beta's (the tenant only ever from the session).
    expect((await call('GET', '/dashboard/api/me', member)).status).toBe(401);
    expect((await sessions.get(id!))?.tenantId).toBe(T.beta);
    const acme = (await auditOf(T.acme)).slice(before.acme);
    const beta = (await auditOf(T.beta)).slice(before.beta);
    expect(acme.map((a) => a.event)).toEqual(['Signed out']);
    expect(beta.map((a) => a.event)).toEqual(['Signed in']);
    expect(acme[0]!.detail).toMatch(/switched to another workspace$/);
    expect(beta[0]!.detail).toMatch(/switched from another workspace$/);
    for (const a of [...acme, ...beta]) expect(a.detail).not.toMatch(/Acme|Beta|Gamma/);
    expect(await auditOf(T.gamma)).toEqual([]);
  });

  it('a switch whose audit row cannot be written makes no new session and keeps the old one', async () => {
    const member = await sessions.create(MEMBER, 'Test', undefined, T.acme);
    auditDown.tenant = T.beta;
    try {
      const r = await call('POST', '/dashboard/api/workspaces/switch', member, { tenantId: T.beta });
      expect(r.status).toBe(500);
      expect(newId(r.cookie)).toBeUndefined();
      expect((await call('GET', '/dashboard/api/me', member)).status).toBe(200);
    } finally {
      auditDown.tenant = '';
    }
  });

  it('a workspace the member has left drops out of the list and the count, and cannot be switched to', async () => {
    const member = await sessions.create(MEMBER, 'Test', undefined, T.acme);
    const row = (await platformDb.get<{ user_id: string; created_at: string }>('SELECT user_id, created_at FROM memberships WHERE tenant_id = ?', [T.beta]))!;
    await platformDb.run('DELETE FROM memberships WHERE tenant_id = ?', [T.beta]);
    try {
      expect(json((await call('GET', '/dashboard/api/workspaces', member)).text)).toEqual({ workspaces: [{ id: T.acme, name: 'Acme', current: true }] });
      expect(json((await call('GET', '/dashboard/api/me', member)).text).workspaces).toBe(1);
      expect((await call('POST', '/dashboard/api/workspaces/switch', member, { tenantId: T.beta })).status).toBe(404);
    } finally {
      await platformDb.run("INSERT INTO memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)", [T.beta, row.user_id, row.created_at]);
    }
  });
});
