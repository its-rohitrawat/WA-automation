import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../../../src/store/db.ts';
import { PG_LATEST } from '../../../src/store/pg/migrations.ts';
import { founderNumberIn, openPhoneSession, useEncryptedAuthState } from '../../../src/wa/authState.ts';
import { onPg, openTestPlatformDb, openTestTenantDb, testPg } from '../../helpers/pg.ts';
import { AuditLog } from '../../../src/web/audit.ts';
import { SessionStore } from '../../../src/web/sessions.ts';
import { startSetupShell } from '../../../src/runtime/setupShell.ts';
import { silentLogger } from '../../../src/util/logger.ts';

// The first tests on a real Postgres (S2.7): only inside npm run test:pg (scripts/test-pg.ts); skipped by npm test.

describe('the test server settings', () => {
  it('are off without TEST_DB_ENGINE, and refused when it is set without the URLs', () => {
    const saved = { ...process.env };
    try {
      delete process.env.TEST_DB_ENGINE;
      expect(testPg()).toBeUndefined();
      process.env.TEST_DB_ENGINE = 'postgres';
      delete process.env.TEST_PG_APP_URL;
      expect(() => testPg()).toThrow(/npm run test:pg/);
    } finally {
      process.env = saved;
    }
  });
});

describe.runIf(onPg)('on the Postgres test server', () => {
  const open: Db[] = [];
  afterEach(async () => {
    for (const db of open.splice(0)) await db.close();
  });
  const tenant = async () => {
    const db = await openTestTenantDb();
    open.push(db);
    return db;
  };

  it('is at the schema version this code needs', async () => {
    const db = await tenant();
    expect((await db.get<{ v: number }>('SELECT wa_schema_version() AS v'))?.v).toBe(PG_LATEST);
  });

  it('two customers never see each other’s rows (RLS), even with the same keys', async () => {
    const a = await tenant();
    const b = await tenant();
    await a.run('INSERT INTO kv (k, v) VALUES (?, ?)', ['probe', 'a']);
    await b.run('INSERT INTO kv (k, v) VALUES (?, ?)', ['probe', 'b']);
    expect(await a.all('SELECT k, v FROM kv')).toEqual([{ k: 'probe', v: 'a' }]);
    expect(await b.all('SELECT k, v FROM kv')).toEqual([{ k: 'probe', v: 'b' }]);
    await a.run('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', ['probe', 'a2']);
    expect(await b.get('SELECT v FROM kv WHERE k = ?', ['probe'])).toEqual({ v: 'b' });
  });

  it('keeps the WhatsApp sessions in wa_auth, per customer and per phone', async () => {
    const key = randomBytes(32);
    const a = await tenant();
    const b = await tenant();
    const founder = await openPhoneSession({ engine: 'postgres', db: a }, 'founder');
    const auth = await useEncryptedAuthState(founder, key);
    auth.state.creds.me = { id: '919800000000:5@s.whatsapp.net', name: 'Founder' };
    await auth.saveCreds();
    expect(await founderNumberIn({ engine: 'postgres', db: a }, key)).toBe('919800000000');
    expect(await founderNumberIn({ engine: 'postgres', db: b }, key)).toBeUndefined(); // another customer's rows
    expect((await useEncryptedAuthState(await openPhoneSession({ engine: 'postgres', db: a }, 'spare'), key)).hasSession).toBe(false);
  });
});

describe.runIf(onPg)('customer sessions on the Postgres test server (S4.8)', () => {
  const open: Db[] = [];
  afterEach(async () => {
    for (const db of open.splice(0)) await db.close();
  });

  it('a session keeps its customer, and P4 refuses one written without a customer', async () => {
    const customer = await openTestTenantDb('session test');
    const platform = openTestPlatformDb();
    open.push(customer, platform);
    const sessions = new SessionStore(platform, { now: () => new Date() });
    const s = await sessions.create('customer@example.com', 'Test', undefined, customer.tenantId);
    expect((await sessions.get(s.id))?.tenantId).toBe(customer.tenantId);
    await expect(
      platform.run("INSERT INTO web_sessions (id_hash, email, csrf_hash, created_at, expires_at, last_seen_at) VALUES ('h', 'e@example.com', 'c', 't', 't', 't')"),
    ).rejects.toThrow(/tenant_id/);
  });

  it('the sign-in audit row lands in the customer’s own tables only (RLS), through forTenant on the shared pool', async () => {
    const a = await openTestTenantDb('a');
    const b = await openTestTenantDb('b');
    open.push(a, b);
    await new AuditLog(a.forTenant(b.tenantId), { now: () => new Date() }).record({ actor: 'x@example.com', event: 'Signed in', kind: 'auth', detail: 'Test' });
    expect((await b.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'Signed in'"))!.n).toBe(1);
    expect((await a.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'Signed in'"))!.n).toBe(0);
  });
});

describe.runIf(onPg)('a customer setup shell on the Postgres test server (S4.5 Phase A)', () => {
  it('reads its facts from its own tables only (RLS): another customer’s groups never count', async () => {
    const a = await openTestTenantDb('shell a');
    const b = await openTestTenantDb('shell b');
    const platform = openTestPlatformDb();
    try {
      await b.run("INSERT INTO clients (code, name, group_id, phases) VALUES ('BBB', 'B client', 'b@g.us', '[]')");
      const shell = await startSetupShell({
        tenantId: a.tenantId, db: a, platform, dataKey: async () => randomBytes(32), keyTester: async () => 'ok',
        clock: { now: () => new Date() }, log: silentLogger(),
      });
      expect(shell.facts().groupsApproved).toBe(0);
      expect(shell.facts().aiKey).toBe('missing');
      await shell.stop();
    } finally {
      for (const db of [a, b, platform]) await db.close();
    }
  });
});
