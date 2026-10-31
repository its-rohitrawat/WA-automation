import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FOUNDER_TENANT_ID } from '../../src/config/env.ts';
import { ensurePlatformSchema } from '../../src/platform/schema.ts';
import { createTenant, ensureFounderTenant } from '../../src/platform/store.ts';
import { tenantContext } from '../../src/runtime/context.ts';
import { platformSupervisor, type PlatformSupervisor } from '../../src/runtime/platformSupervisor.ts';
import { syncClients } from '../../src/store/clients.ts';
import type { Db } from '../../src/store/db.ts';
import { manualClock } from '../../src/util/clock.ts';
import { silentLogger } from '../../src/util/logger.ts';
import { MEHTA, onSqlite, seededDb, SHARMA } from '../helpers/db.ts';
import { platformTestDb } from '../helpers/platformTestDb.ts';
import { dbGroupsStore } from '../../src/config/groupsStore.ts';

// The Supervisor as main.ts runs it (S4.5 Phase A, S4.9). The stores are laid out as on the Mac: on SQLite one
// in-memory store stands in for the platform tables and one for the customer's own Db; on Postgres they are the real
// ones, in this file's own database, set back to just the founder before each test, since the Supervisor runs every
// customer in tenants. The Supervisor is told it is on Postgres so a customer starts. A customer gets only a setup
// shell: its facts from its own Db, no Claude client, no WhatsApp, no Google, and never the founder's key.

const anthropic = vi.hoisted(() => ({ made: 0 }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor() {
      anthropic.made += 1;
    }
    models = { list: async () => ({}) };
  },
}));

const AT = '2026-10-30T10:00:00.000Z';
const opened: Db[] = [];
let ps: PlatformSupervisor | undefined;
afterEach(async () => {
  await ps?.stop();
  ps = undefined;
  for (const db of opened.splice(0)) await db.close();
});

/** An env that records every setting read: a customer's shell must never reach the founder's key. */
function watchedEnv(engine: 'sqlite' | 'postgres') {
  const read: string[] = [];
  const values: Record<string, unknown> = { DB_ENGINE: engine, PLATFORM_MAX_ACTIVE: 20, PLATFORM_MAX_RSS_MB: 4096, ANTHROPIC_API_KEY: 'sk-ant-founder-placeholder' };
  const env = new Proxy(values, { get: (t, k: string) => (read.push(k), t[k]) }) as never;
  return { env, read };
}

/** The platform tables, and a customer's own Db once the customer exists (see the note at the top). */
async function stores(): Promise<{ platformDb: Db; customerDbOf: (id: string) => Promise<Db> }> {
  if (onSqlite) {
    const platformDb = await seededDb();
    await ensurePlatformSchema(platformDb);
    return { platformDb, customerDbOf: () => seededDb() };
  }
  const t = await platformTestDb(); // this file's database, set back to just the founder
  return {
    platformDb: t.db,
    customerDbOf: async (id) => {
      const db = t.customerDb(id);
      await syncClients(db, [SHARMA, MEHTA]);
      return db;
    },
  };
}

/** `engine`: what the Supervisor is told it runs on (on 'sqlite' only the founder runs). */
async function setup(engine: 'sqlite' | 'postgres' = 'postgres') {
  const { platformDb, customerDbOf } = await stores();
  opened.push(platformDb);
  await ensureFounderTenant(platformDb, { name: 'Your business', at: AT });
  const customer = (await createTenant(platformDb, { name: 'Acme', status: 'active', at: AT })).id;
  const customerDb = await customerDbOf(customer);
  opened.push(customerDb);
  // Its own allow-list, approved through its own groups store (a0's dbGroupsStore): the source a runtime starts from.
  await dbGroupsStore({ db: customerDb, onChange: () => undefined, log: silentLogger() }).apply({ approve: [{ groupId: '120363111111111111@g.us', name: 'Acme Ltd', code: 'ACM' }, { groupId: '120363222222222222@g.us', name: 'Blue Bay', code: 'BLU' }] });
  await customerDb.run('INSERT INTO settings (k, v, updated_at, updated_by) VALUES (?, ?, ?, ?)', ['reportTime', '"07:30"', AT, 'x']);
  const { env, read } = watchedEnv(engine);
  const asked: string[] = [];
  ps = platformSupervisor({
    env, log: silentLogger(), clock: manualClock(AT), platformDb, master: randomBytes(32),
    customerDb: engine === 'postgres' ? (id) => (asked.push(id), customerDb) : undefined,
    rssMb: () => 100, tickMs: 3_600_000,
  });
  return { ps, customer, customerDb, read, asked };
}

describe('platformSupervisor (S4.5 Phase A)', () => {
  it('the founder is adopted (running, nothing built); a customer gets a setup shell with facts from its own Db', async () => {
    const { ps, customer, asked } = await setup();
    await ps.start();
    expect(ps.supervisor.state(FOUNDER_TENANT_ID)).toBe('running');
    expect(ps.supervisor.state(customer)).toBe('running');
    expect(new Set(asked)).toEqual(new Set([customer])); // only the customer's own Db, only for the customer (its key check and its shell)
    expect(ps.supervisor.facts(customer)).toEqual({
      whatsappLinked: false, spareLinked: false, driveConnected: false, // S4.6 and S4.7
      groupsApproved: 2, reportTimeSet: true, aiKey: 'missing',
    });
    expect(await ps.hooks.probes!.state(customer, 'groups')).toBe('done');
    expect(await ps.hooks.probes!.state(customer, 'key')).toBe('todo');
    expect(ps.hooks.health!.runtime?.(customer)).toBe('running');
    expect(ps.hooks.maxActive).toBe(20);
    expect(ps.hooks.aiKeys!(customer)).not.toBeNull();
    expect(ps.hooks.aiKeys!(FOUNDER_TENANT_ID)).toBeNull(); // the founder's key stays .env-only
  });

  it('a customer shell builds no Claude client, opens no WhatsApp, calls no Google, and never reads the founder’s key', async () => {
    anthropic.made = 0;
    const { ps, customer, read } = await setup();
    await ps.start();
    ps.supervisor.facts(customer);
    await ps.supervisor.settled();
    expect(anthropic.made).toBe(0);
    expect(read).not.toContain('ANTHROPIC_API_KEY');
    // The shell's own code has no WhatsApp, Google or Claude client to call, and no settings to read.
    const src = readFileSync(join(import.meta.dirname, '../../src/runtime/setupShell.ts'), 'utf8');
    for (const banned of ['baileys', 'googleapis', 'google-auth-library', '@anthropic-ai', '../wa/', '../output/', '../brain/', 'process.env', 'Env']) {
      expect(src, banned).not.toContain(banned);
    }
  });

  it('on SQLite only the founder runs: a customer is refused (refused:postgres) and no shell is built', async () => {
    const { ps, customer, asked } = await setup('sqlite');
    await ps.start();
    expect(ps.supervisor.state(FOUNDER_TENANT_ID)).toBe('running');
    expect(ps.supervisor.state(customer)).toBe('refused:postgres');
    expect(asked).toEqual([]);
    expect(ps.hooks.aiKeys!(customer)).toBeNull();
  });

  it('a throw from a customer’s code goes to the Supervisor; the founder’s, or no one’s, keeps today’s exit', async () => {
    const { ps, customer } = await setup();
    await ps.start();
    expect(ps.crashed(new Error('anywhere'))).toBe(false);
    expect(tenantContext.run(FOUNDER_TENANT_ID, () => ps.crashed(new Error('founder')))).toBe(false);
    expect(tenantContext.run(customer, () => ps.crashed(Object.assign(new Error('customer'), { code: 'X' })))).toBe(true);
    await ps.supervisor.settled();
    expect(ps.supervisor.state(customer)).toBe('backoff');
    expect(ps.supervisor.state(FOUNDER_TENANT_ID)).toBe('running');
  });

  it('stop() ends the tick and stops the customers’ shells', async () => {
    const { ps, customer } = await setup();
    await ps.start();
    await ps.stop();
    expect(ps.supervisor.state(customer)).toBe('stopped');
    expect(ps.hooks.aiKeys!(customer)).toBeNull();
  });
});
