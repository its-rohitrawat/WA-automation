import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyPlan, SESSION_PLANS, SKIPPED } from '../../src/migrate/plan.ts';
import { ensurePlatformSchema } from '../../src/platform/schema.ts';
import { openDb, type Db } from '../../src/store/db.ts';
import { SqliteDb } from '../../src/store/engine/sqlite.ts';

let db: Db;
beforeEach(async () => {
  db = openDb(':memory:');
  await ensurePlatformSchema(db);
});
afterEach(async () => {
  await db.close();
});

const trackerTables = async (q: Db) =>
  (await q.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")).map((t) => t.name);

describe('the copy plan', () => {
  it('covers every table in a migrated tracker.db: copied, or skipped with a reason', async () => {
    const plan = await copyPlan(db);
    const planned = plan.map((p) => p.table);
    expect([...planned, ...Object.keys(SKIPPED)].sort()).toEqual((await trackerTables(db)).sort());
    expect(plan.every((p) => p.source === 'tracker' && p.target === p.table)).toBe(true);
    expect(Object.values(SKIPPED).every((why) => why.length > 10)).toBe(true);
  });

  it('puts every parent before its children (foreign-key order)', async () => {
    const plan = await copyPlan(db);
    const at = (t: string) => plan.findIndex((p) => p.table === t);
    for (const p of plan) {
      const parents = (await db.all<{ t: string }>(`SELECT "table" AS t FROM pragma_foreign_key_list('${p.table}')`)).map((f) => f.t).filter((t) => t !== p.table);
      for (const parent of parents) expect(at(parent), `${parent} before ${p.table}`).toBeLessThan(at(p.table));
    }
    expect(at('tenants')).toBeLessThan(at('invites'));
    expect(at('clients')).toBeLessThan(at('tasks'));
  });

  it("lists each table's columns in their table order, and marks the platform tables", async () => {
    const plan = await copyPlan(db);
    const clients = plan.find((p) => p.table === 'clients')!;
    expect(clients.columns).toEqual((await db.all<{ name: string }>("SELECT name FROM pragma_table_info('clients') ORDER BY cid")).map((c) => c.name));
    expect(plan.filter((p) => p.platform).map((p) => p.table).sort()).toEqual(['invites', 'memberships', 'platform_audit', 'tenant_keys', 'tenants', 'users']);
    // The wrapped data keys (S4.1) go across as they are: they stay wrapped by the same master key.
    expect(plan.findIndex((p) => p.table === 'tenants')).toBeLessThan(plan.findIndex((p) => p.table === 'tenant_keys'));
    expect(plan.every((p) => Object.keys(p.fixed).length === 0)).toBe(true);
    // Each table's primary key, in key order: the copy checks a platform table by the keys it wrote.
    expect(Object.fromEntries(plan.filter((p) => p.platform).map((p) => [p.table, p.key]))).toEqual({
      tenants: ['id'], users: ['id'], memberships: ['tenant_id', 'user_id'], invites: ['id'], platform_audit: ['id'], tenant_keys: ['tenant_id'],
    });
    expect(plan.find((p) => p.table === 'kv')!.key).toEqual(['k']);
  });

  it('never copies the sign-in sessions or SQLite\'s own migration record', async () => {
    const plan = await copyPlan(db);
    expect(plan.map((p) => p.table)).not.toContain('web_sessions');
    expect(plan.map((p) => p.table)).not.toContain('schema_version');
    expect(Object.keys(SKIPPED).sort()).toEqual(['schema_version', 'web_sessions']);
  });

  it('refuses a foreign-key loop instead of guessing an order', async () => {
    const odd = SqliteDb.open(':memory:');
    await odd.exec('CREATE TABLE a (id INTEGER PRIMARY KEY, b_id INTEGER REFERENCES b (id)); CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a (id));');
    await expect(copyPlan(odd)).rejects.toThrow(/foreign keys loop: a -> b -> a/);
    await odd.close();
  });
});

describe('the WhatsApp session files', () => {
  it('go to wa_auth: each phone, live and backup, keys and values only', () => {
    expect(SESSION_PLANS.map((p) => [p.source, p.table, p.fixed.phone, p.fixed.slot])).toEqual([
      ['session', 'auth', 'founder', 'live'],
      ['session', 'auth_backup', 'founder', 'backup'],
      ['sender', 'auth', 'spare', 'live'],
      ['sender', 'auth_backup', 'spare', 'backup'],
    ]);
    expect(SESSION_PLANS.every((p) => p.target === 'wa_auth' && p.columns.join() === 'k,v' && !p.platform)).toBe(true);
  });
});
