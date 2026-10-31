import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_KEY_TRIES_PER_HOUR, AiKeys, modelsListTester, type KeyCheck, type KeyTester } from '../../src/platform/aiKey.ts';
import { PlatformError } from '../../src/platform/errors.ts';
import { createTenant } from '../../src/platform/store.ts';
import type { Db } from '../../src/store/db.ts';
import { manualClock, type ManualClock } from '../../src/util/clock.ts';
import { platformTestDb, type PlatformTestDb } from '../helpers/platformTestDb.ts';

// Only obvious fakes: no real key appears anywhere in this file, and the tester is a fake (nothing calls Anthropic).
const FAKE = 'sk-ant-test-0000';
const OTHER = 'sk-ant-test-1111';

let store: PlatformTestDb;
/** The platform tables (platform_audit, tenants). */
let db: Db;
/** The customer's own tables (kv): the same store on SQLite, its own Db on Postgres. */
let mine: Db;
let clock: ManualClock;
let tenantId: string;
let dataKey: Buffer;

beforeEach(async () => {
  store = await platformTestDb({ tracker: true });
  db = store.db;
  clock = manualClock('2026-10-30T06:00:00.000Z');
  tenantId = (await createTenant(db, { name: 'Kapoor Design Studio', status: 'onboarding', at: clock.now().toISOString() })).id;
  mine = store.customerDb(tenantId);
  dataKey = randomBytes(32);
});
afterEach(async () => {
  await store.close();
});

const keys = (tester: KeyTester = async () => 'ok', key = dataKey) => new AiKeys({ db: mine, platform: db, tenantId, dataKey: async () => key, tester, clock });
const answer = (c: KeyCheck): KeyTester => async () => c;
const refusal = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a refusal'); }, (e: unknown) => e as PlatformError);
const everything = async () => JSON.stringify([await mine.all('SELECT * FROM kv'), await db.all('SELECT * FROM platform_audit')]);

describe("the customer's Anthropic key", () => {
  it('is tested before it is stored, stored only encrypted, and reported only as configured', async () => {
    const tester = vi.fn(answer('ok'));
    const k = keys(tester);
    expect(await k.state()).toBe('missing');
    expect(await k.set(`  ${FAKE}\n`, 'owner@kapoor.example')).toBe('configured');
    expect(tester).toHaveBeenCalledWith(FAKE); // trimmed
    expect(await k.state()).toBe('configured');
    expect(await everything()).not.toContain(FAKE);
    expect(await k.load()).toBe(FAKE);
  });

  it('opens only with this customer\'s data key', async () => {
    await keys().set(FAKE, 'owner@kapoor.example');
    await expect(keys(answer('ok'), randomBytes(32)).load()).rejects.toThrow(/cannot be opened/);
  });

  it('a refused key is not stored, and the refusal does not echo it', async () => {
    const e = await refusal(keys(answer('refused')).set(FAKE, 'owner@kapoor.example'));
    expect(e).toBeInstanceOf(PlatformError);
    expect(e).toMatchObject({ status: 400, code: 'key_refused' });
    expect(e.message).not.toContain('sk-ant');
    expect(await keys().state()).toBe('missing');
  });

  it('when Anthropic does not answer (or the tester throws), nothing is stored and it says to try again', async () => {
    expect(await refusal(keys(answer('unreachable')).set(FAKE, 'a@b.example'))).toMatchObject({ status: 503, code: 'anthropic_unreachable' });
    expect(await refusal(keys(async () => { throw new Error(`boom ${FAKE}`); }).set(FAKE, 'a@b.example'))).toMatchObject({ status: 503 });
    expect(await keys().state()).toBe('missing');
    expect(await everything()).not.toContain(FAKE);
  });

  it('text that is not an Anthropic key is refused without calling out', async () => {
    const tester = vi.fn(answer('ok'));
    for (const bad of ['hello', 'sk-ant-', 'sk-ant-has space', `sk-ant-${'x'.repeat(400)}`, '']) {
      const e = await refusal(keys(tester).set(bad, 'a@b.example'));
      expect(e).toMatchObject({ status: 400, code: 'bad_key' });
    }
    expect(tester).not.toHaveBeenCalled();
  });

  it('replacing keeps only the new key; remove deletes it', async () => {
    const k = keys();
    await k.set(FAKE, 'owner@kapoor.example');
    await k.set(OTHER, 'owner@kapoor.example');
    expect(await k.load()).toBe(OTHER);
    expect(await k.remove('owner@kapoor.example')).toBe('missing');
    expect(await k.state()).toBe('missing');
    expect(await k.load()).toBeNull();
  });

  it('every attempt is audited without the key: set, refused, unreachable, removed', async () => {
    await keys().set(FAKE, 'owner@kapoor.example', 'req-1');
    await refusal(keys(answer('refused')).set(OTHER, 'owner@kapoor.example'));
    await refusal(keys(answer('unreachable')).set(OTHER, 'owner@kapoor.example'));
    await keys().remove('owner@kapoor.example');
    const rows = await db.all<{ actor: string; event: string; tenant_id: string; detail: string; request_id: string | null }>('SELECT actor, event, tenant_id, detail, request_id FROM platform_audit ORDER BY id');
    expect(rows.map((r) => r.event)).toEqual(['ai_key.set', 'ai_key.refused', 'ai_key.unreachable', 'ai_key.removed']);
    expect(rows.every((r) => r.tenant_id === tenantId && r.detail === '' && r.actor === 'owner@kapoor.example')).toBe(true);
    expect(rows[0]!.request_id).toBe('req-1');
  });

  it(`allows ${AI_KEY_TRIES_PER_HOUR} tries an hour per customer`, async () => {
    const k = keys(answer('refused'));
    for (let i = 0; i < AI_KEY_TRIES_PER_HOUR; i++) await refusal(k.set(FAKE, 'a@b.example'));
    const tester = vi.fn(answer('ok'));
    expect(await refusal(keys(tester).set(FAKE, 'a@b.example'))).toMatchObject({ status: 429, code: 'too_many' });
    expect(tester).not.toHaveBeenCalled();
    clock.advance(3_600_001);
    expect(await keys(tester).set(FAKE, 'a@b.example')).toBe('configured');
  });
});

describe('the models-list tester (the free call the Settings check already uses)', () => {
  const client = (list: () => Promise<unknown>) => ({ models: { list: vi.fn(list) } });

  it('ok when the list comes back; one try, with a timeout', async () => {
    const c = client(async () => ({ data: [] }));
    expect(await modelsListTester(() => c)(FAKE)).toBe('ok');
    expect(c.models.list).toHaveBeenCalledWith({ limit: 1 }, expect.objectContaining({ maxRetries: 0, timeout: 10_000 }));
  });

  it('refused on 401 or 403; unreachable on anything else', async () => {
    const status = (s: number) => client(async () => { throw Object.assign(new Error('x'), { status: s }); });
    expect(await modelsListTester(() => status(401))(FAKE)).toBe('refused');
    expect(await modelsListTester(() => status(403))(FAKE)).toBe('refused');
    expect(await modelsListTester(() => status(500))(FAKE)).toBe('unreachable');
    expect(await modelsListTester(() => client(async () => { throw new TypeError('fetch failed'); }))(FAKE)).toBe('unreachable');
  });

  it('builds its client with the key it is testing', async () => {
    const make = vi.fn(() => client(async () => ({})));
    await modelsListTester(make)(FAKE);
    expect(make).toHaveBeenCalledWith(FAKE);
  });
});
