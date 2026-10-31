import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FOUNDER_TENANT_ID, parseEnv, type Env } from '../../src/config/env.ts';
import { TokenStore } from '../../src/output/googleAuth.ts';
import { AiKeys } from '../../src/platform/aiKey.ts';
import { ensurePlatformSchema } from '../../src/platform/schema.ts';
import { createTenant, ensureFounderTenant } from '../../src/platform/store.ts';
import { TenantKeys } from '../../src/platform/tenantKeys.ts';
import { platformSupervisor, type PlatformSupervisor } from '../../src/runtime/platformSupervisor.ts';
import { buildCustomerRuntime, type RuntimeDeps } from '../../src/runtime/customerRuntime.ts';
import { ANTHROPIC_API_URL } from '../../src/brain/anthropicIsolated.ts';
import { DRIVE_SCOPES, type ConsentClient } from '../../src/output/googleAuth.ts';
import { verifyOAuthState } from '../../src/output/oauthState.ts';
import type { OwnerContext } from '../../src/web/routes/context.ts';
import { GoogleConnectRoutes } from '../../src/web/routes/google.ts';
import { syncClients } from '../../src/store/clients.ts';
import type { Db } from '../../src/store/db.ts';
import { manualClock } from '../../src/util/clock.ts';
import { silentLogger } from '../../src/util/logger.ts';
import { MEHTA, onSqlite, seededDb, SHARMA } from '../helpers/db.ts';
import { platformTestDb } from '../helpers/platformTestDb.ts';
import { dbGroupsStore } from '../../src/config/groupsStore.ts';

// A customer's FULL runtime (Phase B 2 and 3). The stores are laid out as on the Mac: on SQLite an in-memory store
// stands in for the platform tables (and the founder's tracker) and one for each customer's own Db, with wa_auth as
// Postgres has it; on Postgres they are the real ones, in this file's own database, set back to just the founder
// before each test, since the Supervisor runs every customer in tenants. The Supervisor is told it is on Postgres. Every key here is a placeholder.

const sdk = vi.hoisted(() => ({ keys: [] as string[], made: [] as Record<string, unknown>[] }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor(o: { apiKey?: string }) {
      sdk.keys.push(String(o?.apiKey));
      sdk.made.push({ ...o });
    }
    models = { list: async () => ({}) };
    messages = { create: async () => ({}) };
  },
}));
const wa = vi.hoisted(() => ({ sockets: 0 }));
vi.mock('baileys', async (importOriginal) => {
  const real = await importOriginal<typeof import('baileys')>();
  return { ...real, default: (...a: Parameters<typeof real.default>) => (wa.sockets += 1, real.default(...a)) };
});

const FOUNDER_KEY = 'sk-ant-founder-placeholder-key';
const AT = '2026-10-30T10:00:00.000Z';
const WA_AUTH = `CREATE TABLE wa_auth (phone text NOT NULL, slot text NOT NULL DEFAULT 'live', k text NOT NULL, v blob NOT NULL, PRIMARY KEY (phone, slot, k))`;
let dir: string | undefined;
const opened: Db[] = [];
let ps: PlatformSupervisor | undefined;
afterEach(async () => {
  await ps?.stop();
  ps = undefined;
  for (const db of opened.splice(0)) await db.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** The platform tables, the founder's tracker, and a customer's own Db once the customer exists (see the note at the top). */
async function stores(): Promise<{ platformDb: Db; founderDb: Db; customerDbOf: (id: string) => Promise<Db> }> {
  if (onSqlite) {
    const platformDb = await seededDb(); // the founder's own tracker too: its Google token goes here
    await ensurePlatformSchema(platformDb);
    const customerDbOf = async () => {
      const db = await seededDb(); // its own two groups
      await db.exec(WA_AUTH);
      return db;
    };
    return { platformDb, founderDb: platformDb, customerDbOf };
  }
  const t = await platformTestDb(); // this file's database, set back to just the founder
  const customerDbOf = async (id: string) => {
    const db = t.customerDb(id);
    await syncClients(db, [SHARMA, MEHTA]); // its own two groups
    return db;
  };
  return { platformDb: t.db, founderDb: t.customerDb(FOUNDER_TENANT_ID), customerDbOf };
}

/** `noStateKey`: the Supervisor gets no Google state key. Returns `built`: each customer runtime's deps, by customer id. */
async function setup(o: { keyFor: ('a' | 'b')[]; noStateKey?: boolean }) {
  dir = mkdtempSync(join(tmpdir(), 'wa-full-'));
  const groups = join(dir, 'allowed-groups.json');
  writeFileSync(groups, '[]');
  const founderEnv = parseEnv({
    DATA_DIR: dir, GROUPS_FILE: groups, ANTHROPIC_API_KEY: FOUNDER_KEY, DB_ENGINE: 'postgres',
    DATABASE_URL: 'postgres://wa_app:placeholder@127.0.0.1:5432/wa_agent', DATABASE_PLATFORM_URL: 'postgres://wa_platform:placeholder@127.0.0.1:5432/wa_agent',
    DASHBOARD_ENABLED: 'true', DASHBOARD_OWNER_EMAILS: 'owner@example.com',
    DASHBOARD_GOOGLE_CLIENT_ID: 'web-client-placeholder', DASHBOARD_GOOGLE_CLIENT_SECRET: 'web-secret-placeholder', PLATFORM_ENABLED: 'true',
  });
  const read: string[] = [];
  const env = new Proxy(founderEnv, { get: (t, k: string) => (read.push(k), (t as Record<string, unknown>)[k]) }) as Env;
  const master = randomBytes(32);
  const { platformDb, founderDb, customerDbOf } = await stores();
  opened.push(platformDb);
  if (founderDb !== platformDb) opened.push(founderDb);
  await ensureFounderTenant(platformDb, { name: 'Your business', at: AT });
  await new TokenStore(founderDb, master).save('founder-refresh-token-placeholder');
  const ids = { a: (await createTenant(platformDb, { name: 'Acme', status: 'active', at: AT })).id, b: (await createTenant(platformDb, { name: 'Blue', status: 'active', at: AT })).id };
  const dbs: Record<string, Db> = {};
  const tenantKeys = new TenantKeys({ db: platformDb, master, clock: manualClock(AT) });
  for (const k of ['a', 'b'] as const) {
    const db = await customerDbOf(ids[k]);
    // Its own allow-list, approved through its own groups store (a0's dbGroupsStore): the source a runtime starts from.
    await dbGroupsStore({ db, onChange: () => undefined, log: silentLogger() }).apply({ approve: [{ groupId: '120363111111111111@g.us', name: 'Acme Ltd', code: 'ACM' }, { groupId: '120363222222222222@g.us', name: 'Blue Bay', code: 'BLU' }] });
    opened.push(db);
    dbs[ids[k]] = db;
    if (o.keyFor.includes(k)) {
      await new AiKeys({ db, platform: platformDb, tenantId: ids[k], dataKey: () => tenantKeys.dataKey(ids[k]), tester: async () => 'ok', clock: manualClock(AT) })
        .set(`sk-ant-customer-${k}-placeholder`, 'owner@example.com');
    }
  }
  const before = readdirSync(dir).sort();
  read.length = 0;
  sdk.keys.length = 0;
  sdk.made.length = 0;
  wa.sockets = 0;
  const stateKey = randomBytes(32);
  const built = new Map<string, RuntimeDeps>();
  ps = platformSupervisor({
    env, log: silentLogger(), clock: manualClock(AT), platformDb, master, customerDb: (id) => dbs[id]!, keyTester: async () => 'ok', rssMb: () => 100, tickMs: 3_600_000,
    ...(o.noStateKey ? {} : { oauthStateKey: stateKey }),
    build: async (t, deps) => (built.set(t.id, deps), buildCustomerRuntime(t, deps)),
  });
  return { ps, ids, dbs, read, before, tenantKeys, dir, stateKey, built, founderDb, master };
}

describe('a customer’s full runtime (Phase B 2 and 3)', () => {
  it('an active customer with its own key runs its full runtime: its groups, its key, no WhatsApp socket while unlinked, no Drive', async () => {
    const { ps, ids } = await setup({ keyFor: ['a'] });
    await ps.start();
    expect(ps.supervisor.state(ids.a)).toBe('running');
    expect(ps.supervisor.facts(ids.a)).toEqual({
      whatsappLinked: false, spareLinked: false, driveConnected: false, groupsApproved: 2, reportTimeSet: false, aiKey: 'configured',
    });
    // B has no key yet: its setup shell.
    expect(ps.supervisor.facts(ids.b)?.aiKey).toBe('missing');
    expect(sdk.keys.length).toBeGreaterThan(0); // A's Claude clients were built…
    expect(sdk.keys.every((k) => k === 'sk-ant-customer-a-placeholder')).toBe(true); // …with A's key only
    expect(wa.sockets).toBe(0); // never a fresh pairing: unlinked means no socket
  });

  it('never reads the founder’s key or groups file, and writes nothing in the founder’s data folder but tenants/', async () => {
    const { ps, read, before, dir } = await setup({ keyFor: ['a', 'b'] });
    await ps.start();
    expect(read).not.toContain('ANTHROPIC_API_KEY');
    expect(read).not.toContain('GROUPS_FILE');
    expect(sdk.keys).not.toContain(FOUNDER_KEY);
    expect(readdirSync(dir).sort()).toEqual([...new Set([...before, 'tenants'])].sort());
  });

  it('two customers run in different data folders with different keys', async () => {
    const { ps, ids, tenantKeys, dir } = await setup({ keyFor: ['a', 'b'] });
    await ps.start();
    expect([ps.supervisor.state(ids.a), ps.supervisor.state(ids.b)]).toEqual(['running', 'running']);
    expect(readdirSync(resolve(dir, 'tenants')).sort()).toEqual([ids.a, ids.b].sort());
    expect((await tenantKeys.dataKey(ids.a)).equals(await tenantKeys.dataKey(ids.b))).toBe(false);
    expect(new Set(sdk.keys)).toEqual(new Set(['sk-ant-customer-a-placeholder', 'sk-ant-customer-b-placeholder']));
  });

  it('a customer never loads the founder’s Google token: its Drive stays off until it connects its own', async () => {
    const { ps, ids, dbs } = await setup({ keyFor: ['a'] });
    await ps.start();
    expect(ps.supervisor.facts(ids.a)?.driveConnected).toBe(false);
    // The founder's token is in the founder's tracker; the customer's own tables hold none.
    expect(await dbs[ids.a]!.get("SELECT k FROM kv WHERE k LIKE 'google%'")).toBeUndefined();
    expect(ps.supervisor.state(FOUNDER_TENANT_ID)).toBe('running'); // adopted, untouched
  });
});

describe('restart and the Google hooks (c7’s Supervisor.restart, a0’s S4.7 A1)', () => {
  it('a key added turns the setup shell into the full runtime on restart; removed, back to the shell', async () => {
    const { ps, ids } = await setup({ keyFor: [] });
    await ps.start();
    expect(ps.supervisor.facts(ids.a)?.aiKey).toBe('missing');
    await ps.hooks.aiKeys!(ids.a)!.set('sk-ant-customer-a-placeholder', 'owner@example.com');
    ps.hooks.restart!(ids.a);
    await ps.supervisor.settled();
    expect(ps.supervisor.state(ids.a)).toBe('running');
    expect(ps.supervisor.facts(ids.a)).toMatchObject({ aiKey: 'configured', groupsApproved: 2 });
    expect(sdk.keys).toContain('sk-ant-customer-a-placeholder');
    await ps.hooks.aiKeys!(ids.a)!.remove('owner@example.com');
    ps.hooks.restart!(ids.a);
    await ps.supervisor.settled();
    expect(ps.supervisor.facts(ids.a)?.aiKey).toBe('missing'); // its setup shell again
    expect(ps.supervisor.state(ids.b)).toBe('running'); // B untouched throughout
  });

  it('the Google resolver gives a running customer’s own Db and data key, and nothing for anyone else', async () => {
    const { ps, ids, dbs, tenantKeys } = await setup({ keyFor: ['a'] });
    await ps.start();
    const a = await ps.google!.customer(ids.a);
    expect(a?.db).toBe(dbs[ids.a]);
    expect(a?.key.equals(await tenantKeys.dataKey(ids.a))).toBe(true);
    expect(await ps.google!.customer('00000000-0000-4000-8000-0000000000ff')).toBeNull(); // not running
    await ps.stop();
    expect(await ps.google!.customer(ids.a)).toBeNull(); // stopped
  });

  it('every Claude client of a customer is isolated from the founder’s environment (review B)', async () => {
    const { ps, ids } = await setup({ keyFor: ['a'] });
    await ps.start();
    expect(ps.supervisor.state(ids.a)).toBe('running');
    const customers = sdk.made.filter((o) => o.apiKey === 'sk-ant-customer-a-placeholder');
    expect(customers.length).toBeGreaterThan(0);
    for (const o of customers) expect(o).toMatchObject({ authToken: null, baseURL: ANTHROPIC_API_URL });
  });
});

describe('an active customer connects its own Google (review B S6)', () => {
  /** Google's consent and token endpoints, faked: Drive granted, a refresh token answered. Every value is a placeholder. */
  const fakeGoogle = (): ((redirectUri: string) => ConsentClient) => () => ({
    generateCodeVerifierAsync: async () => ({ codeVerifier: 'verifier-placeholder', codeChallenge: 'challenge-placeholder' }),
    generateAuthUrl: (opts) => `https://accounts.google.com/o/oauth2/v2/auth?state=${opts.state}`,
    getToken: async () => ({ tokens: { refresh_token: 'customer-refresh-placeholder', scope: DRIVE_SCOPES[0]! } }),
  });
  /** The customer's own dashboard routes for Google, as its runtime builds them: its Db, and the hooks it was given. */
  const routesOf = (deps: RuntimeDeps) => new GoogleConnectRoutes({
    db: deps.db, hub: undefined as never, publicUrl: 'https://waagent.example', web: { clientId: 'web-id', clientSecret: 'web-secret' },
    meetingsEnabled: false, invitesGmail: false, audit: async () => undefined, log: silentLogger(), clock: manualClock(AT), createClient: fakeGoogle(),
    ...deps.googleHooks,
  });
  const ownerOf = (tenantId: string): OwnerContext => ({ actor: 'owner@customer.example', sessionId: 'session-c', requestId: 'cccccccccccc', role: 'owner', tenantId });
  const stateIn = (r: { body: unknown }) => new URL((r.body as { url: string }).url).searchParams.get('state')!;

  it('its runtime gets the hooks, its resolver pinned to it: connect gives a consent URL with a state signed for it', async () => {
    const { ps, ids, dbs, built, stateKey, tenantKeys } = await setup({ keyFor: ['a', 'b'] });
    await ps.start();
    const deps = built.get(ids.a)!;
    expect(deps.googleHooks?.stateKey?.equals(stateKey)).toBe(true);
    const own = await deps.googleHooks!.customer!(ids.a);
    expect(own?.db).toBe(dbs[ids.a]);
    expect(own?.key.equals(await tenantKeys.dataKey(ids.a))).toBe(true);
    expect(ps.supervisor.state(ids.b)).toBe('running');
    expect(await deps.googleHooks!.customer!(ids.b)).toBeNull(); // another running customer: never
    expect(await deps.googleHooks!.customer!(FOUNDER_TENANT_ID)).toBeNull();
    const r = await routesOf(deps).connect(ownerOf(ids.a), { account: 'main' });
    expect(r.status).toBe(200);
    expect(verifyOAuthState(stateKey, stateIn(r), new Date(AT))).toEqual({ tenantId: ids.a, account: 'main' });
  });

  it('the callback stores its token in its own Db under its data key only, and restarts it; the founder’s stays as it was', async () => {
    const { ps, ids, dbs, built, tenantKeys, founderDb, master } = await setup({ keyFor: ['a'] });
    await ps.start();
    const first = built.get(ids.a)!;
    const routes = routesOf(first);
    const r = await routes.connect(ownerOf(ids.a), { account: 'main' });
    expect(await routes.callback(ownerOf(ids.a), { state: stateIn(r), code: 'code-placeholder' })).toEqual({ status: 302, location: '/dashboard/connections?connected=main' });
    expect(await new TokenStore(dbs[ids.a]!, await tenantKeys.dataKey(ids.a)).load()).toBe('customer-refresh-placeholder');
    await expect(new TokenStore(dbs[ids.a]!, master).load()).rejects.toThrow(); // not under the founder's key
    expect(await new TokenStore(founderDb, master).load()).toBe('founder-refresh-token-placeholder');
    await ps.supervisor.settled();
    expect(built.get(ids.a)).not.toBe(first); // built again: its hub opens with the new token
    expect(ps.supervisor.state(ids.a)).toBe('running');
  });

  it('without the state key: no hooks anywhere, so its connect is refused (403), never signed with an empty key', async () => {
    const { ps, ids, built } = await setup({ keyFor: ['a'], noStateKey: true });
    await ps.start();
    expect(ps.google).toBeUndefined(); // the founder's routes get none either (main.ts), so a setup shell's connect is refused too
    const deps = built.get(ids.a)!;
    expect(deps.googleHooks).toBeUndefined();
    expect((await routesOf(deps).connect(ownerOf(ids.a), { account: 'main' })).status).toBe(403);
  });
});
