import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../../../src/store/db.ts';
import { PG_LATEST } from '../../../src/store/pg/migrations.ts';
import { founderNumberIn, openPhoneSession, useEncryptedAuthState } from '../../../src/wa/authState.ts';
import { onPg, openTestTenantDb, testPg } from '../../helpers/pg.ts';

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
