import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FOUNDER_TENANT_ID, parseEnv } from '../../src/config/env.ts';
import { AiKeys } from '../../src/platform/aiKey.ts';
import { ensurePlatformSchema } from '../../src/platform/schema.ts';
import { createTenant, ensureFounderTenant } from '../../src/platform/store.ts';
import { TenantKeys } from '../../src/platform/tenantKeys.ts';
import { crashOwner } from '../../src/runtime/context.ts';
import { buildCustomerRuntime, type CustomerRuntime } from '../../src/runtime/customerRuntime.ts';
import { platformSupervisor, type PlatformSupervisor } from '../../src/runtime/platformSupervisor.ts';
import { openDb, type Db } from '../../src/store/db.ts';
import { manualClock } from '../../src/util/clock.ts';
import { silentLogger } from '../../src/util/logger.ts';
import { openSenderSession, PgSessionDb, SessionDecryptError, useEncryptedAuthState } from '../../src/wa/authState.ts';
import type { WebServer } from '../../src/web/server.ts';
import { SessionStore } from '../../src/web/sessions.ts';
import { startDashboard } from '../../src/web/start.ts';
import { closeWith, FakeSocket } from '../helpers/fakeSocket.ts';

// A customer's own WhatsApp link from the dashboard (S4.6 A, c7's contract in the hookups doc, section 13), with fake
// sockets: no test reaches WhatsApp. Each customer links its own phone, into its own session rows under its own data
// key; another customer's link id is unknown (404); and the link's socket runs in that customer's context (F2).

vi.mock('@anthropic-ai/sdk', () => ({ default: class { models = { list: async () => ({}) }; messages = { create: async () => ({}) }; } }));

const AT = '2026-10-30T10:00:00.000Z';
const OWNER = 'owner@example.com';
const WA_AUTH = `CREATE TABLE wa_auth (phone text NOT NULL, slot text NOT NULL DEFAULT 'live', k text NOT NULL, v blob NOT NULL, PRIMARY KEY (phone, slot, k))`;

function asPostgres(db: Db): Db {
  return { engine: 'postgres', get: (s, p) => db.get(s, p), all: (s, p) => db.all(s, p), run: (s, p) => db.run(s, p), exec: (s) => db.exec(s), tx: (fn) => db.tx(fn), close: async () => {} };
}

let dir: string;
const opened: Db[] = [];
let ps: PlatformSupervisor;
let founderRt: CustomerRuntime;
let web: WebServer;
let base: string;
let tenantKeys: TenantKeys;
const ids = { a: '', b: '' };
const dbs: Record<string, Db> = {};
/** The fake sockets each customer's runtime made, and whose context each was made in. */
const sockets: Record<string, { sock: FakeSocket; owner: string | undefined }[]> = {};
/** How many spare sockets each customer's runtime made. */
const senders: Record<string, number> = {};
type S = { id: string; csrf: string };
const s: Record<'founder' | 'a' | 'b', S> = {} as never;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wa-link-'));
  const groups = join(dir, 'allowed-groups.json');
  writeFileSync(groups, '{ "clients": [] }\n');
  const env = parseEnv({
    DATA_DIR: dir, GROUPS_FILE: groups, ANTHROPIC_API_KEY: 'sk-ant-founder-placeholder', DB_ENGINE: 'postgres', PLATFORM_ENABLED: 'true',
    DATABASE_URL: 'postgres://wa_app:placeholder@127.0.0.1:5432/wa_agent', DATABASE_PLATFORM_URL: 'postgres://wa_platform:placeholder@127.0.0.1:5432/wa_agent',
    DASHBOARD_ENABLED: 'true', DASHBOARD_OWNER_EMAILS: OWNER, DASHBOARD_GOOGLE_CLIENT_ID: 'web-client-placeholder', DASHBOARD_GOOGLE_CLIENT_SECRET: 'web-secret-placeholder',
  });
  const master = randomBytes(32);
  const founderDb = openDb(':memory:');
  await founderDb.exec(WA_AUTH);
  await ensurePlatformSchema(founderDb);
  await ensureFounderTenant(founderDb, { name: 'Your business', at: AT });
  await founderDb.exec('ALTER TABLE web_sessions ADD COLUMN tenant_id TEXT');
  opened.push(founderDb);
  const platform = asPostgres(founderDb);
  tenantKeys = new TenantKeys({ db: platform, master, clock: manualClock(AT) });
  for (const k of ['a', 'b'] as const) {
    ids[k] = (await createTenant(platform, { name: `Customer ${k}`, status: 'active', at: AT })).id;
    const db = openDb(':memory:');
    await db.exec(WA_AUTH);
    opened.push(db);
    dbs[ids[k]] = db;
    sockets[ids[k]] = [];
    await new AiKeys({ db, platform, tenantId: ids[k], dataKey: () => tenantKeys.dataKey(ids[k]), tester: async () => 'ok', clock: manualClock(AT) })
      .set(`sk-ant-customer-${k}-placeholder`, OWNER);
    const user = `00000000-0000-4000-8000-00000000000${k === 'a' ? '1' : '2'}`.replace(/1$/, k === 'a' ? 'a' : 'b');
    await platform.run('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)', [user, `${k}@example.com`, null, AT]);
    await platform.run("INSERT INTO memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)", [ids[k], user, AT]);
  }
  ps = platformSupervisor({
    env, log: silentLogger(), clock: manualClock(AT), platformDb: platform, master, customerDb: (id) => dbs[id]!, keyTester: async () => 'ok', rssMb: () => 100, tickMs: 3_600_000,
    build: (t, deps) => buildCustomerRuntime(t, {
      ...deps,
      waSockets: {
        gateway: () => {
          const sock = new FakeSocket();
          sockets[t.id]!.push({ sock, owner: crashOwner() });
          return sock;
        },
        // The spare's scan: one QR, then WhatsApp's restart; the second socket opens as the spare number.
        sender: (auth) => {
          const sock = new FakeSocket();
          const first = (senders[t.id] = (senders[t.id] ?? 0) + 1) === 1;
          queueMicrotask(() => {
            if (first) {
              sock.emit('connection.update', { qr: 'qr-placeholder' });
              closeWith(sock, 515);
            } else {
              auth.creds.me = { id: '919800000099:5@s.whatsapp.net', name: 'Spare' };
              sock.emit('connection.update', { connection: 'open' });
            }
          });
          return sock;
        },
      },
    }),
  });
  founderRt = await buildCustomerRuntime({ id: FOUNDER_TENANT_ID, founder: true }, { env, log: silentLogger(), db: founderDb, key: master, configs: [], platformDb: platform });
  await ps.start();
  const fakeGoogle = { exchange: () => Promise.reject(new Error('no Google in tests')), verifier: () => Promise.reject(new Error('no Google in tests')) };
  web = (await startDashboard({
    env: { ...env, DASHBOARD_PORT: 0 }, db: founderDb, platformDb: platform, log: silentLogger(), control: founderRt.control, platform: founderRt.platform,
    customerSessions: true, ...founderRt.agentRoutes, tenants: ps.tenants, google: fakeGoogle,
  }))!;
  base = `http://127.0.0.1:${web.address()!.port}`;
  const sessions = new SessionStore(platform, { now: () => new Date() });
  s.founder = await sessions.create(OWNER, 'Test');
  s.a = await sessions.create('a@example.com', 'Test', undefined, ids.a);
  s.b = await sessions.create('b@example.com', 'Test', undefined, ids.b);
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

const settle = async (until: () => boolean) => {
  for (let i = 0; i < 100 && !until(); i++) await new Promise((r) => setTimeout(r, 20));
};

describe('a customer links its own WhatsApp from the dashboard (S4.6 A)', () => {
  it('another customer’s, or the founder’s, link id is unknown (404); its own cancels', async () => {
    const started = await call('POST', '/dashboard/api/whatsapp/link/start', s.a, { target: 'founder', confirm: true });
    expect(started.status).toBe(200);
    const { linkId } = (JSON.parse(started.text) as { data?: { linkId: string }; linkId?: string }).data ?? JSON.parse(started.text);
    expect(linkId).toMatch(/^[0-9a-f]{32}$/);
    for (const who of ['b', 'founder'] as const) {
      expect((await call('POST', '/dashboard/api/whatsapp/link/cancel', s[who], { linkId })).status, who).toBe(404);
      expect((await call('GET', `/dashboard/api/whatsapp/link/stream?id=${linkId}`, s[who])).status, who).toBe(404);
    }
    expect((await call('POST', '/dashboard/api/whatsapp/link/cancel', s.a, { linkId })).status).toBe(200);
    expect(sockets[ids.b]).toEqual([]); // nothing was started for B
  });

  it('the link’s socket is made in the customer’s own context (a stray throw restarts that customer alone, F2)', async () => {
    expect(sockets[ids.a]!.length).toBeGreaterThan(0);
    expect(sockets[ids.a]!.every((x) => x.owner === ids.a)).toBe(true);
  });

  it('a completed link: its facts say linked, and its creds open with its own data key only', async () => {
    const before = sockets[ids.a]!.length;
    const started = await call('POST', '/dashboard/api/whatsapp/link/start', s.a, { target: 'founder', confirm: true });
    expect(started.status).toBe(200);
    await settle(() => sockets[ids.a]!.length > before);
    const sock = sockets[ids.a]!.at(-1)!.sock;
    sock.emit('connection.update', { qr: 'qr-placeholder' });
    sock.emit('connection.update', { connection: 'open' });
    await settle(() => ps.supervisor.facts(ids.a)?.whatsappLinked === true);
    expect(ps.supervisor.facts(ids.a)?.whatsappLinked).toBe(true);
    expect(ps.supervisor.facts(ids.b)?.whatsappLinked).toBe(false);
    // A's session rows: its own phone, in its own Db, sealed with A's data key; B's key cannot open them.
    const rows = new PgSessionDb(dbs[ids.a]!, 'founder');
    await expect(useEncryptedAuthState(rows, await tenantKeys.dataKey(ids.a))).resolves.toBeDefined();
    await expect(useEncryptedAuthState(rows, await tenantKeys.dataKey(ids.b))).rejects.toThrow(SessionDecryptError);
    // B's own rows (its runtime's canary from its start) open with B's key, and hold no linked phone.
    const bAuth = await useEncryptedAuthState(new PgSessionDb(dbs[ids.b]!, 'founder'), await tenantKeys.dataKey(ids.b));
    expect(bAuth.hasSession).toBe(false);
  });

  it('a customer’s spare phone links into its own rows too: its facts say so, and B’s key cannot open them', async () => {
    expect(ps.supervisor.facts(ids.a)?.spareLinked).toBe(false);
    const started = await call('POST', '/dashboard/api/whatsapp/link/start', s.a, { target: 'spare', confirm: true });
    expect(started.status).toBe(200);
    // The sender waits its settle (5 s) after the phone opens, as it does for real.
    for (let i = 0; i < 200 && ps.supervisor.facts(ids.a)?.spareLinked !== true; i++) await new Promise((r) => setTimeout(r, 50));
    expect(ps.supervisor.facts(ids.a)?.spareLinked).toBe(true);
    expect(ps.supervisor.facts(ids.b)?.spareLinked).toBe(false);
    expect(senders[ids.b]).toBeUndefined();
    const home = { engine: 'postgres' as const, db: dbs[ids.a]! };
    const own = await openSenderSession(home, await tenantKeys.dataKey(ids.a));
    expect(own.ok && own.auth.hasSession).toBe(true);
    if (own.ok) await own.db.close();
    expect(await openSenderSession(home, await tenantKeys.dataKey(ids.b))).toEqual({ ok: false, code: 'decrypt_failed' });
  }, 20_000);
});
