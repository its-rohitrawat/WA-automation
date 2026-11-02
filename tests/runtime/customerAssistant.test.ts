import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANTHROPIC_API_URL } from '../../src/brain/anthropicIsolated.ts';
import { dbGroupsStore } from '../../src/config/groupsStore.ts';
import { FOUNDER_TENANT_ID, parseEnv } from '../../src/config/env.ts';
import { AiKeys } from '../../src/platform/aiKey.ts';
import { ensurePlatformSchema } from '../../src/platform/schema.ts';
import { createTenant, ensureFounderTenant } from '../../src/platform/store.ts';
import { TenantKeys } from '../../src/platform/tenantKeys.ts';
import { buildCustomerRuntime } from '../../src/runtime/customerRuntime.ts';
import { platformSupervisor, type PlatformSupervisor } from '../../src/runtime/platformSupervisor.ts';
import { syncClients } from '../../src/store/clients.ts';
import type { Db } from '../../src/store/db.ts';
import { manualClock } from '../../src/util/clock.ts';
import { silentLogger } from '../../src/util/logger.ts';
import { createRouter } from '../../src/web/router.ts';
import type { DashboardMount } from '../../src/web/start.ts';
import { MEHTA, onSqlite, seededDb, SHARMA } from '../helpers/db.ts';
import { platformTestDb } from '../helpers/platformTestDb.ts';

// A customer's assistant (November release, piece 3), in its real runtime under the real Supervisor: it is mounted only
// where the founder's switch is on, its Claude client is the customer's own key with the isolated options (never the
// founder's key or environment), and it is told it serves a customer (no Connections or AI usage). The Anthropic SDK is
// a stand-in that records how each client was made; no call reaches Anthropic. The stores are laid out as
// customerFullRuntime.test.ts lays them out. Every key here is a placeholder.

const sdk = vi.hoisted(() => ({ made: [] as Record<string, unknown>[] }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor(o: Record<string, unknown>) {
      sdk.made.push({ ...o });
    }
    models = { list: async () => ({}) };
    messages = { create: async () => ({}) };
    beta = { messages: { stream: () => ({}) } };
  },
}));
/** Every Assistant made, with whether it was told it serves a customer. */
const made = vi.hoisted(() => ({ assistants: [] as { customer: boolean | undefined }[] }));
vi.mock('../../src/assistant/assistant.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/assistant/assistant.ts')>();
  class Recorded extends real.Assistant {
    constructor(d: ConstructorParameters<typeof real.Assistant>[0]) {
      super(d);
      made.assistants.push({ customer: d.customer });
    }
  }
  return { ...real, Assistant: Recorded };
});

const FOUNDER_KEY = 'sk-ant-founder-placeholder-key';
const CUSTOMER_KEY = 'sk-ant-customer-a-placeholder';
const AT = '2026-11-02T10:00:00.000Z';
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

/** The platform tables and a customer's own Db (in-memory stores on SQLite; this file's own Postgres database on pg). */
async function stores(): Promise<{ platformDb: Db; customerDbOf: (id: string) => Promise<Db> }> {
  if (onSqlite) {
    const platformDb = await seededDb();
    await ensurePlatformSchema(platformDb);
    return {
      platformDb,
      customerDbOf: async () => {
        const db = await seededDb();
        await db.exec(WA_AUTH);
        return db;
      },
    };
  }
  const t = await platformTestDb();
  return {
    platformDb: t.db,
    customerDbOf: async (id) => {
      const db = t.customerDb(id);
      await syncClients(db, [SHARMA, MEHTA]);
      return db;
    },
  };
}

/** One active customer with its own key, under the Supervisor; `assistantOn` is the founder's switch. */
async function setup(o: { assistantOn: boolean }) {
  dir = mkdtempSync(join(tmpdir(), 'wa-cust-asst-'));
  const groups = join(dir, 'allowed-groups.json');
  writeFileSync(groups, '[]');
  const env = parseEnv({
    DATA_DIR: dir, GROUPS_FILE: groups, ANTHROPIC_API_KEY: FOUNDER_KEY, DB_ENGINE: 'postgres',
    DATABASE_URL: 'postgres://wa_app:placeholder@127.0.0.1:5432/wa_agent', DATABASE_PLATFORM_URL: 'postgres://wa_platform:placeholder@127.0.0.1:5432/wa_agent',
    DASHBOARD_ENABLED: 'true', DASHBOARD_OWNER_EMAILS: 'owner@example.com', PLATFORM_ENABLED: 'true', DASHBOARD_ASSISTANT: o.assistantOn ? 'true' : 'false',
  });
  const master = randomBytes(32);
  const { platformDb, customerDbOf } = await stores();
  opened.push(platformDb);
  await ensureFounderTenant(platformDb, { name: 'Your business', at: AT });
  const id = (await createTenant(platformDb, { name: 'Acme', status: 'active', at: AT })).id;
  const db = await customerDbOf(id);
  opened.push(db);
  await dbGroupsStore({ db, onChange: () => undefined, log: silentLogger() }).apply({ approve: [{ groupId: '120363111111111111@g.us', name: 'Acme Ltd', code: 'ACM' }] });
  const tenantKeys = new TenantKeys({ db: platformDb, master, clock: manualClock(AT) });
  await new AiKeys({ db, platform: platformDb, tenantId: id, dataKey: () => tenantKeys.dataKey(id), tester: async () => 'ok', clock: manualClock(AT) })
    .set(CUSTOMER_KEY, 'owner@example.com');
  sdk.made.length = 0;
  made.assistants.length = 0;
  ps = platformSupervisor({
    env, log: silentLogger(), clock: manualClock(AT), platformDb, master, customerDb: (x) => (x === id ? db : (undefined as unknown as Db)),
    keyTester: async () => 'ok', rssMb: () => 100, tickMs: 3_600_000, build: (t, deps) => buildCustomerRuntime(t, deps),
  });
  await ps.start();
  return { ps, id };
}

/** The customer runtime's dashboard routes, mounted on a router of their own: what a customer's session reaches. */
function mountedRoutes(id: string): string[] {
  const entry = ps!.tenants.get(id);
  if (!entry) return [];
  const router = createRouter();
  const stub = <T>(o: object) => o as unknown as T;
  const m: DashboardMount = {
    router, guard: stub({}), sessions: stub({ onEnd: () => {} }), audit: entry.audit, actions: stub({ hit: () => {} }),
    secureFor: () => false, port: () => undefined, audited: stub(async () => undefined),
  };
  entry.mount(m);
  return router.routes().map((r) => `${r.method} ${r.pattern}`);
}

describe('a customer\'s assistant (November release, piece 3)', () => {
  it('with the founder\'s switch on, an active customer with its own key has the assistant: its routes, its key, isolated, told it serves a customer', async () => {
    const { ps, id } = await setup({ assistantOn: true });
    expect(ps.supervisor.state(id)).toBe('running');
    const routes = mountedRoutes(id);
    for (const r of ['GET /dashboard/api/assistant', 'POST /dashboard/api/assistant/ask', 'GET /dashboard/api/assistant/chats/:id']) expect(routes, r).toContain(r);
    expect(made.assistants).toEqual([{ customer: true }]);
    // Every Claude client of the customer, the assistant's among them, is its own key with the isolated options.
    const clients = sdk.made.filter((c) => c.apiKey === CUSTOMER_KEY);
    expect(clients.length).toBeGreaterThan(0);
    for (const c of clients) expect(c).toMatchObject({ authToken: null, baseURL: ANTHROPIC_API_URL });
    expect(sdk.made.map((c) => c.apiKey)).not.toContain(FOUNDER_KEY);
    expect(ps.supervisor.state(FOUNDER_TENANT_ID)).toBe('running');
  });

  it('with the founder\'s switch off, no customer has the assistant: no routes, no assistant, one Claude client fewer', async () => {
    const off = await setup({ assistantOn: false });
    const offClients = sdk.made.filter((c) => c.apiKey === CUSTOMER_KEY).length;
    const offRoutes = mountedRoutes(off.id);
    expect(offRoutes.filter((r) => r.includes('/assistant'))).toEqual([]);
    expect(made.assistants).toEqual([]);
    await ps!.stop();
    ps = undefined;
    for (const db of opened.splice(0)) await db.close();
    rmSync(dir!, { recursive: true, force: true });
    const on = await setup({ assistantOn: true });
    expect(mountedRoutes(on.id)).toContain('POST /dashboard/api/assistant/ask');
    expect(sdk.made.filter((c) => c.apiKey === CUSTOMER_KEY).length).toBe(offClients + 1);
  });
});
