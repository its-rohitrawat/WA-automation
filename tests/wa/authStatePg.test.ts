import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/store/db.ts';
import {
  backupAndReset, dropBackup, FounderNumberWatch, founderNumberIn, openPhoneSession, openSenderSession, openSessionDb, PgSessionDb,
  resetSession, restoreBackup, SessionDecryptError, sessionStored, useEncryptedAuthState, useSenderAuthState, type SessionHome,
} from '../../src/wa/authState.ts';

// The WhatsApp sessions on Postgres (S2.6c2, decision A2): one phone's wa_auth rows per PgSessionDb, slot 'live' for
// auth and 'backup' for auth_backup. No server here: the statements are plain SQL, run on an in-memory SQLite table of
// the same shape (S2.7 runs them on Postgres, with tenant_id and RLS).

const key = randomBytes(32);
const WA_AUTH = `CREATE TABLE wa_auth (
  phone text NOT NULL CHECK (phone IN ('founder', 'spare')),
  slot text NOT NULL DEFAULT 'live' CHECK (slot IN ('live', 'backup')),
  k text NOT NULL,
  v blob NOT NULL,
  PRIMARY KEY (phone, slot, k)
)`;

let base: Db | undefined;
afterEach(async () => {
  await base?.close();
  base = undefined;
});

async function home(): Promise<SessionHome & { engine: 'postgres' }> {
  base = openSessionDb(':memory:');
  await base.exec(WA_AUTH);
  return { engine: 'postgres', db: base };
}
const rows = async (phone: string, slot: string) =>
  (await base!.get<{ n: number }>('SELECT COUNT(*) AS n FROM wa_auth WHERE phone = ? AND slot = ?', [phone, slot]))!.n;

describe('wa_auth sessions', () => {
  it('the two phones share the table and never each other’s rows; a reset clears one phone only', async () => {
    const h = await home();
    const founder = await openPhoneSession(h, 'founder');
    const spare = await openPhoneSession(h, 'spare');
    const a = await useEncryptedAuthState(founder, key);
    a.state.creds.me = { id: '919800000000:5@s.whatsapp.net', name: 'Founder' };
    await a.saveCreds();
    await a.state.keys.set({ 'pre-key': { '1': { public: Buffer.alloc(32, 1), private: Buffer.alloc(32, 2) } } });
    const s = await useSenderAuthState(spare, key);
    await s.saveCreds();
    expect(await rows('founder', 'live')).toBe(3); // canary, creds, one key
    expect(await rows('spare', 'live')).toBe(2);

    expect((await useEncryptedAuthState(founder, key)).hasSession).toBe(true);
    expect((await useSenderAuthState(spare, key)).hasSession).toBe(false); // the spare's own subkey, its own rows
    await resetSession(spare);
    expect(await rows('spare', 'live')).toBe(0);
    expect(await rows('founder', 'live')).toBe(3);
    await expect(useEncryptedAuthState(founder, randomBytes(32))).rejects.toThrow(SessionDecryptError);
    await founder.close(); // the shared Db stays open
    expect(await rows('founder', 'live')).toBe(3);
  });

  it('a link’s backup lives in the backup slot: reset, restore, drop; an unfinished one comes back on open', async () => {
    const h = await home();
    const founder = await openPhoneSession(h, 'founder');
    const a = await useEncryptedAuthState(founder, key);
    a.state.creds.me = { id: '919800000000:5@s.whatsapp.net', name: 'Founder' };
    await a.saveCreds();

    await backupAndReset(founder);
    expect([await rows('founder', 'live'), await rows('founder', 'backup')]).toEqual([0, 3]); // canary, creds, the marker
    expect(await restoreBackup(founder)).toBe(true);
    expect([await rows('founder', 'live'), await rows('founder', 'backup')]).toEqual([2, 0]);
    expect(await restoreBackup(founder)).toBe(false);

    await backupAndReset(founder);
    await (await useEncryptedAuthState(founder, key)).saveCreds(); // the new link's first rows
    await dropBackup(founder); // kept
    expect([await rows('founder', 'live'), await rows('founder', 'backup')]).toEqual([2, 0]);
    expect((await useEncryptedAuthState(founder, key)).hasSession).toBe(false);

    // A link that never finished: the next open restores the rows from before it.
    const b = await useEncryptedAuthState(founder, key);
    b.state.creds.me = { id: '919800000001:5@s.whatsapp.net', name: 'Founder' };
    await b.saveCreds();
    await backupAndReset(founder);
    const reopened = await openPhoneSession(h, 'founder');
    expect((await useEncryptedAuthState(reopened, key)).hasSession).toBe(true);
    expect(await rows('founder', 'backup')).toBe(0);
  });

  it('sessionStored, openSenderSession and founderNumberIn read without creating a session', async () => {
    const h = await home();
    expect(await sessionStored(h, 'spare')).toBe(false);
    expect(await founderNumberIn(h, key)).toBeUndefined();
    expect(await rows('founder', 'live')).toBe(0); // nothing was written by the reads

    const opened = await openSenderSession(h, key);
    expect(opened.ok).toBe(true);
    expect(await sessionStored(h, 'spare')).toBe(true); // its canary
    expect(await openSenderSession(h, randomBytes(32))).toEqual({ ok: false, code: 'decrypt_failed' });

    const a = await useEncryptedAuthState(await openPhoneSession(h, 'founder'), key);
    a.state.creds.me = { id: '919811112222:7@s.whatsapp.net', name: 'Founder' };
    await a.saveCreds();
    expect(await founderNumberIn(h, key)).toBe('919811112222');
    expect(await founderNumberIn(h, randomBytes(32))).toBeUndefined();
  });

  it('PgSessionDb names a phone, takes no multi-statement SQL, and reports each committed write only', async () => {
    const h = await home();
    expect(() => new PgSessionDb(h.db, 'other' as 'founder')).toThrow(/founder or the spare/);
    let changes = 0;
    const db = new PgSessionDb(h.db, 'founder', { onChange: () => changes++ });
    await expect(db.exec()).rejects.toThrow(/multi-statement/);
    await db.run("INSERT INTO wa_auth (phone, slot, k, v) VALUES ('founder', 'live', 'a', x'00')");
    await db.tx(async (q) => {
      await q.run("INSERT INTO wa_auth (phone, slot, k, v) VALUES ('founder', 'live', 'b', x'00')");
      await q.run("INSERT INTO wa_auth (phone, slot, k, v) VALUES ('founder', 'live', 'c', x'00')");
    });
    expect(changes).toBe(2); // one run, one transaction
    await expect(db.tx(async () => { throw new Error('rolled back'); })).rejects.toThrow('rolled back');
    expect(changes).toBe(2);
  });
});

describe('FounderNumberWatch', () => {
  it('reads at start and after each refresh; a reset keeps the last number (still refused)', async () => {
    const h = await home();
    const errors: unknown[] = [];
    const watch = new FounderNumberWatch(h, key, (e) => errors.push(e));
    const founder = await openPhoneSession(h, 'founder', { onChange: watch.refresh });
    await watch.start();
    expect(watch.current()).toBeUndefined();

    const a = await useEncryptedAuthState(founder, key);
    a.state.creds.me = { id: '919800000000:5@s.whatsapp.net', name: 'Founder' };
    await a.saveCreds(); // a committed write: refresh() runs
    await watch.settled();
    expect(watch.current()).toBe('919800000000');

    // A relink to another number, several writes in a row: one read at a time, and the last write is seen.
    await backupAndReset(founder);
    const b = await useEncryptedAuthState(founder, key);
    b.state.creds.me = { id: '919800000009:5@s.whatsapp.net', name: 'Founder' };
    await b.saveCreds();
    await b.saveCreds();
    await dropBackup(founder);
    await watch.settled();
    expect(watch.current()).toBe('919800000009');

    await resetSession(founder);
    await watch.settled();
    expect(watch.current()).toBe('919800000009');
    expect(errors).toEqual([]);
  });
});
