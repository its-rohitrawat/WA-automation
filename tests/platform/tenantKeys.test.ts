import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTenant, ensureFounderTenant, FOUNDER_TENANT_ID } from '../../src/platform/store.ts';
import { TenantKeys } from '../../src/platform/tenantKeys.ts';
import type { Db } from '../../src/store/db.ts';
import { platformTestDb, type PlatformTestDb } from '../helpers/platformTestDb.ts';
import { manualClock } from '../../src/util/clock.ts';

const clock = manualClock('2026-10-30T06:00:00.000Z');
let store: PlatformTestDb;
let db: Db;
let A: string;
let B: string;

beforeEach(async () => {
  store = await platformTestDb();
  db = store.db;
  await ensureFounderTenant(db, { name: 'Your studio', at: clock.now().toISOString() });
  A = (await createTenant(db, { name: 'Alpha One', status: 'onboarding', at: clock.now().toISOString() })).id;
  B = (await createTenant(db, { name: 'Beta Two', status: 'onboarding', at: clock.now().toISOString() })).id;
});
afterEach(async () => {
  await store.close();
});

describe('customer data keys', () => {
  it("the founder's data key is the master key, so today's secrets stay readable; nothing is stored for it", async () => {
    const master = randomBytes(32);
    const keys = new TenantKeys({ db, master, clock });
    expect((await keys.dataKey(FOUNDER_TENANT_ID)).equals(master)).toBe(true);
    expect(await db.all('SELECT tenant_id FROM tenant_keys')).toEqual([]);
  });

  it('each customer gets their own 32-byte key, stored only wrapped, and the same key comes back', async () => {
    const master = randomBytes(32);
    const keys = new TenantKeys({ db, master, clock });
    const a = await keys.dataKey(A);
    const b = await keys.dataKey(B);
    expect(a).toHaveLength(32);
    expect(a.equals(b)).toBe(false);
    expect(a.equals(master)).toBe(false);
    expect((await keys.dataKey(A)).equals(a)).toBe(true);
    expect((await new TenantKeys({ db, master, clock }).dataKey(A)).equals(a)).toBe(true); // after a restart
    const row = await db.get<{ wrapped: Buffer; created_at: string }>('SELECT wrapped, created_at FROM tenant_keys WHERE tenant_id = ?', [A]);
    expect(row!.wrapped.includes(a)).toBe(false);
    expect(row!.created_at).toBe('2026-10-30T06:00:00.000Z');
  });

  it('hands out copies: changing a returned key changes nothing inside', async () => {
    const master = randomBytes(32);
    const keys = new TenantKeys({ db, master, clock });
    const a = await keys.dataKey(A);
    const before = Buffer.from(a);
    a.fill(0);
    expect((await keys.dataKey(A)).equals(before)).toBe(true);
    (await keys.dataKey(FOUNDER_TENANT_ID)).fill(0);
    expect((await keys.dataKey(FOUNDER_TENANT_ID)).equals(master)).toBe(true);
  });

  it("a wrapped key moved to another customer's row does not open (the customer id is the AAD)", async () => {
    const master = randomBytes(32);
    await new TenantKeys({ db, master, clock }).dataKey(A);
    await new TenantKeys({ db, master, clock }).dataKey(B);
    await db.run('UPDATE tenant_keys SET wrapped = (SELECT wrapped FROM tenant_keys WHERE tenant_id = ?) WHERE tenant_id = ?', [A, B]);
    await expect(new TenantKeys({ db, master, clock }).dataKey(B)).rejects.toThrow(/cannot be opened/);
  });

  it('another master key opens nothing, and the error names no key', async () => {
    await new TenantKeys({ db, master: randomBytes(32), clock }).dataKey(A);
    const e: unknown = await new TenantKeys({ db, master: randomBytes(32), clock }).dataKey(A).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toBe("This customer's data key cannot be opened with this Mac's master key.");
  });

  it('two starts at once make one key, and both get it', async () => {
    const master = randomBytes(32);
    const [x, y] = await Promise.all([new TenantKeys({ db, master, clock }).dataKey(A), new TenantKeys({ db, master, clock }).dataKey(A)]);
    expect(x.equals(y)).toBe(true);
    expect(await db.all('SELECT tenant_id FROM tenant_keys')).toHaveLength(1);
  });

  it('refuses an id that is not a customer, and a master key of the wrong size', async () => {
    const keys = new TenantKeys({ db, master: randomBytes(32), clock });
    await expect(keys.dataKey('not-an-id')).rejects.toThrow(/customer id/);
    await expect(keys.dataKey('00000000-0000-4000-8000-00000000000f')).rejects.toThrow(/no such customer/);
    expect(() => new TenantKeys({ db, master: randomBytes(16), clock })).toThrow(/32 bytes/);
  });
});
