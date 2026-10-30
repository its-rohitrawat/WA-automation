import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FOUNDER_TENANT_ID, parseEnv } from '../../src/config/env.ts';
import { ensurePlatformSchema } from '../../src/platform/schema.ts';
import { ensureFounderTenant } from '../../src/platform/store.ts';
import { buildCustomerRuntime, type CustomerRuntime } from '../../src/runtime/customerRuntime.ts';
import type { Db } from '../../src/store/db.ts';
import { silentLogger } from '../../src/util/logger.ts';
import type { WebServer } from '../../src/web/server.ts';
import { csrfFor, SessionStore } from '../../src/web/sessions.ts';
import { startDashboard } from '../../src/web/start.ts';
import { seededDb } from '../helpers/db.ts';

// Customer sessions against the real dashboard (S4.8), with no server: the founder's runtime with the platform on, and
// a customer owner signed in. Sessions are kept as on Postgres (web_sessions.tenant_id, through a Db that says it is
// Postgres), on the test SQLite file. Every key here is a placeholder.

const OWNER = 'owner@example.com';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER = '00000000-0000-4000-8000-0000000000c2';
const AT = '2026-10-30T10:00:00.000Z';

/** The test SQLite file as the Postgres platform Db: SessionStore then keeps each session's tenant_id. */
function asPostgres(db: Db): Db {
  return {
    engine: 'postgres',
    get: (s, p) => db.get(s, p),
    all: (s, p) => db.all(s, p),
    run: (s, p) => db.run(s, p),
    exec: (s) => db.exec(s),
    tx: (fn) => db.tx(fn),
    close: async () => {},
  };
}

let dir: string;
let db: Db;
let rt: CustomerRuntime;
let web: WebServer;
let base: string;
let founder: { id: string; csrf: string };
let customer: { id: string; csrf: string };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wa-customer-'));
  const groups = join(dir, 'allowed-groups.json');
  writeFileSync(groups, '[]');
  const env = parseEnv({
    DATA_DIR: dir, GROUPS_FILE: groups, ANTHROPIC_API_KEY: 'placeholder-key', PLATFORM_ENABLED: 'true',
    DASHBOARD_ENABLED: 'true', DASHBOARD_OWNER_EMAILS: OWNER,
    DASHBOARD_GOOGLE_CLIENT_ID: 'placeholder-client', DASHBOARD_GOOGLE_CLIENT_SECRET: 'placeholder-secret',
  });
  db = await seededDb();
  await ensurePlatformSchema(db);
  await ensureFounderTenant(db, { name: 'Your business', at: AT });
  // A customer, its owner and the membership (as a redeemed invite leaves them), and Postgres's web_sessions.tenant_id.
  await db.run("INSERT INTO tenants (id, kind, name, status, created_at, updated_at) VALUES (?, 'customer', 'Acme', 'active', ?, ?)", [CUSTOMER, AT, AT]);
  await db.run('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)', ['00000000-0000-4000-8000-0000000000u1'.replace('u1', 'd1'), CUSTOMER_EMAIL, 'Customer', AT]);
  await db.run("INSERT INTO memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)", [CUSTOMER, '00000000-0000-4000-8000-0000000000d1', AT]);
  await db.exec('ALTER TABLE web_sessions ADD COLUMN tenant_id TEXT');
  const platformDb = asPostgres(db);
  rt = await buildCustomerRuntime({ id: FOUNDER_TENANT_ID, founder: true }, { env, log: silentLogger(), key: randomBytes(32), db, configs: [], platformDb });
  const fakeGoogle = { exchange: () => Promise.reject(new Error('no Google in tests')), verifier: () => Promise.reject(new Error('no Google in tests')) };
  web = (await startDashboard({
    env: { ...env, DASHBOARD_PORT: 0 }, db, platformDb, log: silentLogger(), control: rt.control, platform: rt.platform, customerSessions: true,
    ...rt.agentRoutes, google: fakeGoogle,
  }))!;
  base = `http://127.0.0.1:${web.address()!.port}`;
  const sessions = new SessionStore(platformDb, { now: () => new Date() });
  founder = await sessions.create(OWNER, 'Test');
  customer = await sessions.create(CUSTOMER_EMAIL, 'Test', undefined, CUSTOMER);
}, 60_000);

afterAll(async () => {
  await web?.stop();
  await rt?.stop();
  await db?.close();
  rmSync(dir, { recursive: true, force: true });
});

const PARAMS: Record<string, string> = { code: 'SHA', id: '00000000-0000-4000-8000-0000000000aa', name: 'publish' };
const pathOf = (pattern: string) => pattern.replace(/:(\w+)/g, (_m, p: string) => PARAMS[p] ?? 'x');

async function call(method: 'GET' | 'POST', path: string, s: { id: string; csrf: string }, extra: { body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    redirect: 'manual',
    signal: AbortSignal.timeout(5000),
    headers: {
      cookie: `wa_session=${s.id}`,
      ...(method === 'POST' ? { origin: base, 'x-csrf-token': s.csrf, 'content-type': 'application/json' } : {}),
      ...extra.headers,
    },
    ...(method === 'POST' ? { body: JSON.stringify(extra.body ?? {}) } : {}),
  });
  const text = await res.text().catch(() => '');
  return { status: res.status, text };
}

/**
 * The only routes a customer owner may get anything but 401, 403 or 503 from, with what they answer here. Every other
 * registered route (Router.routes(), so a new one is covered by itself) must refuse a customer.
 */
const CUSTOMER_ALLOWED: Record<string, number[]> = {
  // The public sign-in (no session needed): to Google and back.
  'GET /dashboard/auth/login': [302],
  'GET /dashboard/auth/callback': [302],
  // Who is signed in, and as what (role owner, platform false).
  'GET /dashboard/api/me': [200],
  // Getting started, and the customer's own Anthropic key (an empty body is invalid; no key store before its runtime).
  'GET /dashboard/api/platform/onboarding': [200],
  'POST /dashboard/api/platform/ai-key': [400],
  'POST /dashboard/api/platform/ai-key/remove': [409],
  // The public sign-up pages (an unknown invite is 404).
  'GET /signup': [200],
  'GET /signup/api/invite': [404],
  'GET /signup/google': [302],
  'GET /signup/callback': [302],
  // Google's return for the founder's reconnect: anyone else is only sent back to /dashboard (checked below).
  'GET /dashboard/connect/google/callback': [302],
};
const REFUSED = [401, 403, 503];

describe('the route sweep: a customer session never gets a founder route (S4.8)', () => {
  it('every registered route refuses a customer (401, 403 or 503), except the listed ones', async () => {
    const routes = web.router.routes();
    expect(routes.length).toBeGreaterThan(50);
    const wrong: string[] = [];
    for (const r of routes) {
      if (r.pattern === '/dashboard/auth/logout') continue; // signing out is checked last
      const key = `${r.method} ${r.pattern}`;
      const a = await call(r.method, pathOf(r.pattern), customer);
      const ok = CUSTOMER_ALLOWED[key] ?? REFUSED;
      if (!ok.includes(a.status)) wrong.push(`${key} -> ${a.status}`);
    }
    expect(wrong).toEqual([]);
    // Every allowed entry is a real route (a stale list would hide nothing, but would no longer describe the code).
    const keys = new Set(routes.map((r) => `${r.method} ${r.pattern}`));
    expect(Object.keys(CUSTOMER_ALLOWED).filter((k) => !keys.has(k))).toEqual([]);
  });

  it('the Google connect callback sends a customer back to /dashboard and nowhere else', async () => {
    const res = await fetch(`${base}/dashboard/connect/google/callback?state=x&code=y`, { redirect: 'manual', headers: { cookie: `wa_session=${customer.id}` } });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/dashboard');
  });

  it('the founder passes the guard on every read: no 401, 403 or 503', async () => {
    const wrong: string[] = [];
    for (const r of web.router.routes()) {
      if (r.method !== 'GET' || r.pattern.startsWith('/signup') || r.pattern.startsWith('/dashboard/auth/')) continue;
      if (r.pattern === '/dashboard/api/whatsapp/link/stream') continue; // an event stream: it stays open
      const a = await call('GET', pathOf(r.pattern), founder);
      if (REFUSED.includes(a.status)) wrong.push(`GET ${r.pattern} -> ${a.status}`);
    }
    expect(wrong).toEqual([]);
  });

  it('/me tells a customer its role and never the platform', async () => {
    const me = JSON.parse((await call('GET', '/dashboard/api/me', customer)).text) as Record<string, unknown>;
    expect([me.email, me.role, me.platform]).toEqual([CUSTOMER_EMAIL, 'owner', false]);
    const f = JSON.parse((await call('GET', '/dashboard/api/me', founder)).text) as Record<string, unknown>;
    expect([f.role, f.platform]).toEqual(['founder', true]);
  });
});

describe('the customer comes from the session record only (S4.8)', () => {
  const FOUNDER_HINTS = { tenantId: FOUNDER_TENANT_ID, tenant_id: FOUNDER_TENANT_ID, tenant: FOUNDER_TENANT_ID };

  it('another customer’s id in the query, a header or the body changes nothing', async () => {
    const q = `?tenantId=${FOUNDER_TENANT_ID}&tenant_id=${FOUNDER_TENANT_ID}`;
    const headers = { 'x-tenant-id': FOUNDER_TENANT_ID, 'x-tenant': FOUNDER_TENANT_ID };
    // Getting started stays the customer's own workspace.
    const onboarding = await call('GET', `/dashboard/api/platform/onboarding${q}`, customer, { headers });
    expect(onboarding.status).toBe(200);
    expect(onboarding.text).toContain('Acme');
    expect(onboarding.text).not.toContain('Your business');
    // The founder's data stays refused, however the request names the founder.
    for (const path of ['/dashboard/api/clients', '/dashboard/api/status', '/dashboard/api/platform/customers']) {
      expect((await call('GET', `${path}${q}`, customer, { headers })).status, path).not.toBe(200);
    }
    // The key route acts on the customer's own workspace (not ready yet), never the founder's (which is .env-only).
    // A body that names a customer is refused outright (the body schema is strict).
    const named = await call('POST', `/dashboard/api/platform/ai-key${q}`, customer, { body: { key: 'sk-ant-placeholder-placeholder-placeholder', ...FOUNDER_HINTS }, headers });
    expect(named.status).toBe(400);
    // With the founder named in the query and headers only, it acts on the customer's own workspace (not ready yet),
    // never the founder's (whose key is .env-only: founder_env).
    const key = await call('POST', `/dashboard/api/platform/ai-key${q}`, customer, { body: { key: 'sk-ant-placeholder-placeholder-placeholder' }, headers });
    expect(key.status).toBe(409);
    expect(key.text).toContain('not_ready');
    expect(key.text).not.toContain('founder_env');
  });
});

describe('change routes: the CSRF token is the session’s, and the role still decides (S4.8)', () => {
  it('a customer’s own valid token cannot drive a founder change route: 403, and 503 on the agent’s routes', async () => {
    for (const path of ['/dashboard/api/platform/invites', '/dashboard/api/settings', '/dashboard/api/session/signout-everywhere', '/dashboard/api/actions/publish']) {
      expect((await call('POST', path, customer)).status, path).toBe(403);
    }
    expect((await call('POST', '/dashboard/api/groups/apply', customer)).status).toBe(503);
  });

  it('a token from another session is refused (403 csrf), either way round', async () => {
    const mixed = [{ id: customer.id, csrf: founder.csrf }, { id: founder.id, csrf: customer.csrf }];
    for (const s of mixed) {
      const r = await call('POST', '/dashboard/api/platform/ai-key', s, { body: {} });
      expect(r.status).toBe(403);
      expect(r.text).toContain('csrf');
    }
    expect(csrfFor(customer.id)).toBe(customer.csrf);
  });
});

describe('the membership decides, at every request (S4.8)', () => {
  it('a membership lookup that fails (the platform tables unreadable) is a 503, never the founder; the session is kept', async () => {
    await db.exec('ALTER TABLE memberships RENAME TO memberships_away');
    try {
      expect((await call('GET', '/dashboard/api/me', customer)).status).toBe(503);
      expect((await call('GET', '/dashboard/api/status', customer)).status).toBe(503);
    } finally {
      await db.exec('ALTER TABLE memberships_away RENAME TO memberships');
    }
    expect((await call('GET', '/dashboard/api/me', customer)).status).toBe(200);
  });

  it('a removed membership signs the customer out at the next request, for good', async () => {
    const sessions = new SessionStore(asPostgres(db), { now: () => new Date() });
    const s = await sessions.create(CUSTOMER_EMAIL, 'Test', undefined, CUSTOMER);
    expect((await call('GET', '/dashboard/api/me', s)).status).toBe(200);
    await db.run('DELETE FROM memberships WHERE tenant_id = ?', [CUSTOMER]);
    expect((await call('GET', '/dashboard/api/me', s)).status).toBe(401);
    await db.run("INSERT INTO memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)", [CUSTOMER, '00000000-0000-4000-8000-0000000000d1', AT]);
    expect((await call('GET', '/dashboard/api/me', s)).status).toBe(401); // the session was ended, not just refused
  });

  it('a customer signs out like the founder: 204, and the session is gone', async () => {
    expect((await call('POST', '/dashboard/auth/logout', customer)).status).toBe(204);
    expect((await call('GET', '/dashboard/api/me', customer)).status).toBe(401);
  });
});
