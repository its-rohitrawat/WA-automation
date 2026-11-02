import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initAuthCreds } from 'baileys';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/store/db.ts';
import {
  backupAndReset, hasSessionRows, openPhoneSession, openSessionDb, PgSessionDb, phoneIdOf, phoneName, phoneNumberIn, phoneSessionKey,
  resetSession, restoreBackup, SessionDecryptError, sessionStored, spareNumberIn, useEncryptedAuthState, useSenderAuthState,
  type Phone, type SessionHome,
} from '../../src/wa/authState.ts';

// Reading phones 2 to 5 (lane C, change 7): each has its own session (a file on SQLite, its own wa_auth rows on
// Postgres) under its own subkey of the workspace key. Phone 1 is today's founder session, exactly as before. The
// Postgres statements run on an in-memory table of wa_auth's shape after P7 (no server here; S2.7 runs the real one).

const key = randomBytes(32);
const WA_AUTH_P7 = `CREATE TABLE wa_auth (
  phone text NOT NULL CHECK (phone IN ('founder', 'phone2', 'phone3', 'phone4', 'phone5', 'spare')),
  slot text NOT NULL DEFAULT 'live' CHECK (slot IN ('live', 'backup')),
  k text NOT NULL,
  v blob NOT NULL,
  PRIMARY KEY (phone, slot, k)
)`;

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

function sqliteHome(): SessionHome & { engine: 'sqlite'; dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'wa-phones-'));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  return { engine: 'sqlite', dataDir };
}
async function pgHome(): Promise<SessionHome & { engine: 'postgres'; db: Db }> {
  const base = openSessionDb(':memory:');
  cleanup.push(() => base.close());
  await base.exec(WA_AUTH_P7);
  return { engine: 'postgres', db: base };
}
async function open(home: SessionHome, phone: Phone): Promise<Db> {
  const db = await openPhoneSession(home, phone);
  cleanup.push(() => db.close());
  return db;
}
/** A linked session for a phone: its creds name the number, sealed as the runtime seals that phone. */
async function link(db: Db, phone: Exclude<Phone, 'spare'>, number: string): Promise<void> {
  const auth = await useEncryptedAuthState(db, phoneSessionKey(key, phone));
  (auth.state.creds as ReturnType<typeof initAuthCreds>).me = { id: `${number}:3@s.whatsapp.net`, name: 'x' };
  await auth.saveCreds();
}

describe('reading phones 1 to 5', () => {
  it('phone 1 is the founder session; 2 to 5 are phone2 to phone5; nothing else is a phone', () => {
    expect([1, 2, 3, 4, 5].map((n) => phoneName(n))).toEqual(['founder', 'phone2', 'phone3', 'phone4', 'phone5']);
    expect(['founder', 'phone2', 'phone5'].map((p) => phoneIdOf(p as Exclude<Phone, 'spare'>))).toEqual([1, 2, 5]);
    for (const bad of [0, 6, 1.5, -1, Number.NaN, '2', null, undefined]) expect(() => phoneName(bad as number), String(bad)).toThrow();
  });

  it('PgSessionDb takes the five reading phones and the spare, and nothing else', async () => {
    const { db } = await pgHome();
    for (const p of ['founder', 'phone2', 'phone3', 'phone4', 'phone5', 'spare']) expect(new PgSessionDb(db, p as Phone).phone).toBe(p);
    for (const bad of ['phone1', 'phone6', "founder' OR '1'='1", '', 'Phone2']) expect(() => new PgSessionDb(db, bad as Phone), bad).toThrow();
  });

  it('on SQLite each phone has its own file: session.db for phone 1, session-<n>.db for 2 to 5', async () => {
    const h = sqliteHome();
    for (const p of ['founder', 'phone2', 'phone5'] as const) expect(await sessionStored(h, p)).toBe(false);
    await open(h, 'phone3');
    expect(existsSync(join(h.dataDir, 'session-3.db'))).toBe(true);
    expect(await sessionStored(h, 'phone3')).toBe(true);
    expect(await sessionStored(h, 'founder')).toBe(false); // phone 3's file is not phone 1's
    await open(h, 'founder');
    expect(existsSync(join(h.dataDir, 'session.db'))).toBe(true);
  });

  for (const engine of ['sqlite', 'postgres'] as const) {
    it(`${engine}: phone 1 is sealed with the workspace key itself, as today: no relink`, async () => {
      const h = engine === 'sqlite' ? sqliteHome() : await pgHome();
      const db = await open(h, 'founder');
      expect(phoneSessionKey(key, 'founder').equals(key)).toBe(true);
      await link(db, 'founder', '919800000001');
      // Today's code opens phone 1 with the key itself: the same session, no new scan.
      expect((await useEncryptedAuthState(db, key)).hasSession).toBe(true);
      expect(await phoneNumberIn(h, key, 'founder')).toBe('919800000001');
    });

    it(`${engine}: phones 2 to 5 each have their own subkey; one phone's rows do not open as another's`, async () => {
      const h = engine === 'sqlite' ? sqliteHome() : await pgHome();
      const keys = (['founder', 'phone2', 'phone3', 'phone4', 'phone5'] as const).map((p) => phoneSessionKey(key, p).toString('hex'));
      expect(new Set(keys).size).toBe(5);
      const two = await open(h, 'phone2');
      await link(two, 'phone2', '919800000002');
      expect(await phoneNumberIn(h, key, 'phone2')).toBe('919800000002');
      expect(await phoneNumberIn(h, key, 'phone3')).toBeUndefined();
      // Phone 2's rows, opened with phone 3's key (as if copied there), or with the workspace key itself: refused.
      await expect(useEncryptedAuthState(two, phoneSessionKey(key, 'phone3'))).rejects.toBeInstanceOf(SessionDecryptError);
      await expect(useEncryptedAuthState(two, key)).rejects.toBeInstanceOf(SessionDecryptError);
    });

    it(`${engine}: a reset, backup or restore on phone 3 leaves phones 1 and 2 and the spare as they were`, async () => {
      const h = engine === 'sqlite' ? sqliteHome() : await pgHome();
      const one = await open(h, 'founder');
      const two = await open(h, 'phone2');
      const three = await open(h, 'phone3');
      const spare = await open(h, 'spare');
      await link(one, 'founder', '919800000001');
      await link(two, 'phone2', '919800000002');
      await link(three, 'phone3', '919800000003');
      await useEncryptedAuthState(spare, randomBytes(32));
      await backupAndReset(three);
      expect(await hasSessionRows(three)).toBe(false);
      for (const db of [one, two, spare]) expect(await hasSessionRows(db)).toBe(true);
      expect(await restoreBackup(three)).toBe(true);
      expect(await phoneNumberIn(h, key, 'phone3')).toBe('919800000003');
      await resetSession(three);
      expect(await hasSessionRows(three)).toBe(false);
      for (const db of [one, two, spare]) expect(await hasSessionRows(db)).toBe(true);
      expect(await phoneNumberIn(h, key, 'founder')).toBe('919800000001');
      expect(await phoneNumberIn(h, key, 'phone2')).toBe('919800000002');
    });
  }
});

describe('the spare’s number, for the reading phones to refuse (security review N7)', () => {
  for (const engine of ['sqlite', 'postgres'] as const) {
    it(`${engine}: read as the spare's session is sealed (its own subkey), writing nothing; none when not linked`, async () => {
      const h = engine === 'sqlite' ? sqliteHome() : await pgHome();
      expect(await spareNumberIn(h, key)).toBeUndefined();
      if (h.engine === 'sqlite') expect(existsSync(join(h.dataDir, 'sender-session.db'))).toBe(false); // nothing made
      const spare = await open(h, 'spare');
      expect(await hasSessionRows(spare)).toBe(false);
      const auth = await useSenderAuthState(spare, key);
      (auth.state.creds as ReturnType<typeof initAuthCreds>).me = { id: '919800000009:4@s.whatsapp.net', name: 'x' };
      await auth.saveCreds();
      expect(await spareNumberIn(h, key)).toBe('919800000009');
      expect(await spareNumberIn(h, randomBytes(32))).toBeUndefined(); // another key: not readable, not a number
      // A reading phone's rows are not the spare's.
      await link(await open(h, 'phone2'), 'phone2', '919800000002');
      expect(await spareNumberIn(h, key)).toBe('919800000009');
    });
  }
});
