import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../../src/config/env.ts';
import { buildCustomerRuntime, startFounderRuntime, sttEnvFor, type CustomerRuntime } from '../../src/runtime/customerRuntime.ts';
import { GlobalSpend } from '../../src/spend/globalSpend.ts';
import type { Db } from '../../src/store/db.ts';
import { silentLogger } from '../../src/util/logger.ts';
import { istDate } from '../../src/util/time.ts';
import { seededDb, SHARMA } from '../helpers/db.ts';

// One customer's runtime (S4.4), with no network: the dashboard is on and nothing is linked (setup mode), so no
// WhatsApp socket, Google call or Claude call is made. Every key and secret here is a placeholder.

const FOUNDER = '00000000-0000-4000-8000-000000000001';
const CUSTOMER = '00000000-0000-4000-8000-0000000000c2';
let dir: string | undefined;
const opened: Db[] = [];
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close().catch(() => undefined);
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function envFor(over: Record<string, string> = {}) {
  dir = mkdtempSync(join(tmpdir(), 'wa-runtime-'));
  const groups = join(dir, 'allowed-groups.json');
  writeFileSync(groups, '[]');
  return parseEnv({
    DATA_DIR: dir, GROUPS_FILE: groups, ANTHROPIC_API_KEY: 'placeholder-key',
    DASHBOARD_ENABLED: 'true', DASHBOARD_OWNER_EMAILS: 'owner@example.com',
    DASHBOARD_GOOGLE_CLIENT_ID: 'placeholder-client', DASHBOARD_GOOGLE_CLIENT_SECRET: 'placeholder-secret',
    ...over,
  });
}

function fakeShared(over: Record<string, string> = {}) {
  return { env: envFor(over), log: silentLogger(), key: randomBytes(32), tenantId: FOUNDER };
}

describe('startFounderRuntime', () => {
  it('a client code conflict in the groups file at start-up takes the orderly path: caught, closed, released, no unhandled rejection', async () => {
    const db = await seededDb(); // Sharma (SHA) on its group
    const configs = [{ ...SHARMA, code: 'NEW' }]; // the same group with another code
    const rejections: unknown[] = [];
    const onRejection = (r: unknown) => rejections.push(r);
    process.on('unhandledRejection', onRejection);
    const closed: string[] = [];
    const lock = { release: vi.fn(async () => undefined) };
    try {
      await expect(startFounderRuntime({ db, configs, lock, onClose: (name) => closed.push(name), ...fakeShared() }))
        .rejects.toThrow(/Client codes are permanent/);
      await new Promise((r) => setTimeout(r, 20)); // let any stray rejection surface
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(rejections).toEqual([]); // the conflict reached the caller's catch, nothing floated
    expect(closed).toEqual(['session', 'tracker']); // the founder's session, then the tracker, were closed
    expect(lock.release).toHaveBeenCalledTimes(1); // the lock was let go, once
  });

  it('the sync rolls back: the client keeps its code', async () => {
    const db = await seededDb();
    opened.push(db);
    const shared = fakeShared();
    // The same conflict through buildCustomerRuntime, whose caller keeps the tracker open, so its rows can be read.
    await expect(buildCustomerRuntime({ id: FOUNDER, founder: true }, { ...shared, db, configs: [{ ...SHARMA, code: 'NEW' }] }))
      .rejects.toThrow(/Client codes are permanent/);
    expect(await db.all('SELECT code FROM clients ORDER BY id')).toEqual([{ code: 'SHA' }, { code: 'MEH' }]);
  });
});

describe('buildCustomerRuntime', () => {
  it('builds the founder runtime without starting it, starts it, and stops it within 10 s, closing its own databases only', async () => {
    const db = await seededDb();
    opened.push(db);
    const closed: string[] = [];
    const rt: CustomerRuntime = await buildCustomerRuntime({ id: FOUNDER, founder: true }, { ...fakeShared(), db, configs: [], onClose: (n) => closed.push(n) });
    expect(rt.tenantId).toBe(FOUNDER);
    expect(rt.agentRoutes).toBeDefined(); // the dashboard is on
    expect(rt.app.health.isUp()).toBe(false); // nothing started yet
    rt.start();
    const t0 = Date.now();
    await rt.stop();
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(closed).toEqual(['session']); // the tracker is the caller's
    expect(await db.get('SELECT 1 AS ok')).toEqual({ ok: 1 }); // and still open
    await rt.stop(); // a second stop is the same stop
  });

  it('only the founder joins the platform ceiling: a customer runtime’s spend never moves globalSpend.spentToday()', async () => {
    const today = istDate(new Date());
    const founderDb = await seededDb();
    const customerDb = await seededDb();
    opened.push(founderDb, customerDb);
    await founderDb.run('INSERT INTO spend (day, kind, usd, detail, at) VALUES (?, ?, ?, ?, ?)', [today, 'ai', 2, 'founder call', new Date().toISOString()]);
    await customerDb.run('INSERT INTO spend (day, kind, usd, detail, at) VALUES (?, ?, ?, ?, ?)', [today, 'ai', 3, 'customer call', new Date().toISOString()]);
    const globalSpend = new GlobalSpend({ capUsd: 100 });

    const customer = await buildCustomerRuntime({ id: CUSTOMER, founder: false }, { ...fakeShared(), db: customerDb, configs: [], globalSpend });
    expect(globalSpend.spentToday()).toBe(0);
    expect(Object.keys(globalSpend.spentTodayByTenant())).toEqual([]);
    await customer.stop();

    const founder = await buildCustomerRuntime({ id: FOUNDER, founder: true }, { ...fakeShared(), db: founderDb, configs: [], globalSpend });
    expect(globalSpend.spentTodayByTenant()).toEqual({ [FOUNDER]: 2 }); // the founder's own spend only
    expect(globalSpend.spentToday()).toBe(2);
    await founder.stop();
  });
});

describe('sttEnvFor (D2)', () => {
  it('the founder keeps the speech settings as set; a customer never gets the paid one or STT_API_KEY', () => {
    const paid = envFor({ STT_PROVIDER: 'sarvam', VOICE_STT_PROVIDER: 'sarvam', STT_API_KEY: 'placeholder-stt-key' });
    expect(sttEnvFor(paid, true)).toBe(paid);
    const c = sttEnvFor(paid, false);
    expect(c.STT_PROVIDER).toBe('none');
    expect(c.VOICE_STT_PROVIDER).toBe('none');
    expect('STT_API_KEY' in c).toBe(false);
    const local = sttEnvFor(envFor({ STT_PROVIDER: 'local', VOICE_STT_PROVIDER: 'local', STT_LOCAL_BIN: 'C:/stt/bin.exe', STT_LOCAL_MODEL: 'C:/stt/model.bin' }), false);
    expect([local.STT_PROVIDER, local.VOICE_STT_PROVIDER]).toEqual(['local', 'local']);
  });
});
