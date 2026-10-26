import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proto } from 'baileys';
import { describe, expect, it } from 'vitest';
import { SessionDecryptError, openSessionDb, readFounderNumber, resetSession, useEncryptedAuthState } from '../../src/wa/authState.ts';

const key = randomBytes(32);

describe('encrypted auth state', () => {
  it('starts with fresh credentials and no session', () => {
    const a = useEncryptedAuthState(openSessionDb(':memory:'), key);
    expect(a.hasSession).toBe(false);
    expect(a.state.creds.noiseKey.private).toBeInstanceOf(Uint8Array);
  });

  it('persists credentials encrypted and restores binary fields', async () => {
    const db = openSessionDb(':memory:');
    const a = useEncryptedAuthState(db, key);
    a.state.creds.me = { id: '919800000000:5@s.whatsapp.net', name: 'Founder' };
    await a.saveCreds();
    for (const { v } of db.prepare('SELECT v FROM auth').all() as { v: Buffer }[]) {
      const text = v.toString('latin1');
      for (const marker of ['noiseKey', 'Founder', '"type":"Buffer"']) expect(text).not.toContain(marker);
    }
    const b = useEncryptedAuthState(db, key);
    expect(b.hasSession).toBe(true);
    expect(Buffer.from(b.state.creds.noiseKey.private).equals(Buffer.from(a.state.creds.noiseKey.private))).toBe(true);
  });

  it('stores, reads and rotates signal keys', async () => {
    const a = useEncryptedAuthState(openSessionDb(':memory:'), key);
    await a.state.keys.set({ 'pre-key': { '1': { public: Buffer.from('pub'), private: Buffer.from('priv') } } });
    const got = await a.state.keys.get('pre-key', ['1', '2']);
    expect(Buffer.from(got['1']!.private).toString()).toBe('priv');
    expect(got['2']).toBeUndefined();
    await a.state.keys.set({ 'pre-key': { '1': null } });
    expect(await a.state.keys.get('pre-key', ['1'])).toEqual({});
  });

  it('cannot be opened with a different key', async () => {
    const db = openSessionDb(':memory:');
    await useEncryptedAuthState(db, key).saveCreds();
    expect(() => useEncryptedAuthState(db, randomBytes(32))).toThrow(SessionDecryptError);
  });

  it('keeps no plaintext row names in the database', async () => {
    const db = openSessionDb(':memory:');
    const a = useEncryptedAuthState(db, key);
    await a.saveCreds();
    await a.state.keys.set({ session: { '919800000001.0': Buffer.from('priv') } });
    const rows = db.prepare('SELECT k FROM auth').all() as { k: string }[];
    expect(rows.length).toBe(3);
    for (const { k } of rows) {
      expect(k).toMatch(/^[0-9a-f]{64}$/);
      expect(k).not.toContain('9198');
      expect(k).not.toContain('creds');
    }
  });

  it('encrypts signal key values', async () => {
    const db = openSessionDb(':memory:');
    const a = useEncryptedAuthState(db, key);
    await a.state.keys.set({ 'pre-key': { '1': { public: Buffer.from('pub'), private: Buffer.from('priv') } } });
    const rows = db.prepare('SELECT v FROM auth').all() as { v: Buffer }[];
    expect(rows.length).toBeGreaterThan(1);
    for (const { v } of rows) {
      const text = v.toString('latin1');
      for (const marker of ['priv', '"type":"Buffer"']) expect(text).not.toContain(marker);
    }
  });

  it('round-trips app-state-sync-key as an object with binary keyData', async () => {
    const a = useEncryptedAuthState(openSessionDb(':memory:'), key);
    await a.state.keys.set({
      'app-state-sync-key': { k1: { keyData: Buffer.from('kd'), fingerprint: { rawId: 1, currentIndex: 0 }, timestamp: 5 } },
    });
    const got = await a.state.keys.get('app-state-sync-key', ['k1']);
    expect(got['k1']).toBeInstanceOf(proto.Message.AppStateSyncKeyData);
    expect(got['k1']!.keyData).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(got['k1']!.keyData!).toString()).toBe('kd');
  });

  it('rolls back keys.set when one entry fails', async () => {
    const a = useEncryptedAuthState(openSessionDb(':memory:'), key);
    const bad = { public: Buffer.from('p'), private: BigInt(1) } as unknown as { public: Buffer; private: Buffer };
    await expect(
      a.state.keys.set({ 'pre-key': { '1': { public: Buffer.from('p'), private: Buffer.from('q') }, '2': bad } }),
    ).rejects.toThrow();
    expect(await a.state.keys.get('pre-key', ['1'])).toEqual({});
  });

  it('rejects a blob copied into another row', async () => {
    const db = openSessionDb(':memory:');
    const a = useEncryptedAuthState(db, key);
    await a.saveCreds();
    await a.state.keys.set({
      'pre-key': {
        '1': { public: Buffer.from('p'), private: Buffer.from('q') },
        '2': { public: Buffer.from('r'), private: Buffer.from('s') },
      },
    });
    const rows = db.prepare('SELECT k, v FROM auth').all() as { k: string; v: Buffer }[];
    // a key blob copied over another key row
    db.prepare('UPDATE auth SET v = ? WHERE k = ?').run(rows[2]!.v, rows[3]!.k);
    const outcomes = await Promise.all(
      ['1', '2'].map((id) => Promise.resolve(a.state.keys.get('pre-key', [id])).then(() => 'ok', () => 'err')),
    );
    expect(outcomes).toContain('err');
    // a key blob copied over the creds row
    db.prepare('UPDATE auth SET v = ? WHERE k = ?').run(rows[2]!.v, rows[1]!.k);
    expect(() => useEncryptedAuthState(db, key)).toThrow(SessionDecryptError);
  });

  it('uses WAL for a file-backed session db', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wa-sess-'));
    try {
      const db = openSessionDb(join(dir, 'session.db'));
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('can be reset and then linked again', async () => {
    const db = openSessionDb(':memory:');
    const first = useEncryptedAuthState(db, key);
    first.state.creds.me = { id: '919800000000:5@s.whatsapp.net', name: 'Founder' };
    await first.saveCreds();
    resetSession(db);
    expect((db.prepare('SELECT COUNT(*) AS n FROM auth').get() as { n: number }).n).toBe(0);
    const second = useEncryptedAuthState(db, key);
    expect(second.hasSession).toBe(false);
    second.state.creds.me = { id: '919800000001:5@s.whatsapp.net', name: 'Founder' };
    await second.saveCreds();
    expect(useEncryptedAuthState(db, key).hasSession).toBe(true);
  });

  it('rejects a corrupted canary', async () => {
    const db = openSessionDb(':memory:');
    await useEncryptedAuthState(db, key).saveCreds();
    const first = db.prepare('SELECT k, v FROM auth ORDER BY rowid LIMIT 1').get() as { k: string; v: Buffer };
    const bad = Buffer.from(first.v);
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 0xff;
    db.prepare('UPDATE auth SET v = ? WHERE k = ?').run(bad, first.k);
    expect(() => useEncryptedAuthState(db, key)).toThrow(SessionDecryptError);
  });

  it('leaves the database unchanged when opened with the wrong key', async () => {
    const db = openSessionDb(':memory:');
    await useEncryptedAuthState(db, key).saveCreds();
    const count = () => (db.prepare('SELECT COUNT(*) AS n FROM auth').get() as { n: number }).n;
    const before = count();
    expect(() => useEncryptedAuthState(db, randomBytes(32))).toThrow(SessionDecryptError);
    expect(count()).toBe(before);
  });

  it('does not relabel SQLite errors as decrypt errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wa-sess-'));
    try {
      const db = openSessionDb(join(dir, 'session.db'));
      db.close();
      let thrown: unknown;
      try {
        useEncryptedAuthState(db, key);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();
      expect(thrown).not.toBeInstanceOf(SessionDecryptError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readFounderNumber (link-sender's read of the founder's session)", () => {
  const files = (dir: string) => readdirSync(dir).sort();

  it('reads the linked number without changing session.db or leaving any file beside it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wa-founder-'));
    try {
      const file = join(dir, 'session.db');
      expect(readFounderNumber(file, key)).toBeUndefined(); // no file: nothing is created
      expect(files(dir)).toEqual([]);
      const db = openSessionDb(file);
      const a = useEncryptedAuthState(db, key);
      expect(readFounderNumber(file, key)).toBeUndefined(); // not linked yet
      a.state.creds.me = { id: '919811112222:7@s.whatsapp.net', name: 'Founder' };
      await a.saveCreds();
      // While the writer is open its rows are in the -wal file, and are read from there.
      expect(readFounderNumber(file, key)).toBe('919811112222');
      db.close();
      const before = readFileSync(file);
      expect(files(dir)).toEqual(['session.db']);
      expect(readFounderNumber(file, key)).toBe('919811112222');
      expect(readFounderNumber(file, randomBytes(32))).toBeUndefined(); // another master key cannot read it
      expect(readFileSync(file).equals(before)).toBe(true);
      expect(files(dir)).toEqual(['session.db']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined for a damaged file, and leaves it as it is', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wa-founder-'));
    try {
      const file = join(dir, 'session.db');
      const junk = Buffer.alloc(4096, 0x41);
      writeFileSync(file, junk);
      expect(readFounderNumber(file, key)).toBeUndefined();
      expect(readFileSync(file).equals(junk)).toBe(true);
      expect(files(dir)).toEqual(['session.db']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
