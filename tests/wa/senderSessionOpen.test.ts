import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { senderSessionDbPath, sessionDbPath } from '../../src/config/paths.ts';
import { openSenderSession, openSessionDb, useEncryptedAuthState, useSenderAuthState } from '../../src/wa/authState.ts';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'wa-sender-open-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function linkedSenderFile(dir: string, master: Buffer): Promise<string> {
  const file = senderSessionDbPath(dir);
  const db = openSessionDb(file);
  const a = useSenderAuthState(db, master);
  a.state.creds.me = { id: '919800000099:3@s.whatsapp.net', name: 'S' };
  await a.saveCreds();
  db.raw.close();
  return file;
}

describe('openSenderSession (service start)', () => {
  it('opens a new or a linked spare-number session', async () => {
    const dir = tempDir();
    const fresh = openSenderSession(senderSessionDbPath(dir), randomBytes(32));
    expect(fresh.ok).toBe(true);
    if (fresh.ok) {
      expect(fresh.auth.hasSession).toBe(false);
      fresh.db.raw.close();
    }
    const master = randomBytes(32);
    const file = await linkedSenderFile(tempDir(), master);
    const linked = openSenderSession(file, master);
    expect(linked.ok).toBe(true);
    if (linked.ok) {
      expect(linked.auth.hasSession).toBe(true);
      linked.db.raw.close();
    }
  });

  it('reports a session written with another master key as unreadable, without throwing or changing the file', async () => {
    const file = await linkedSenderFile(tempDir(), randomBytes(32));
    const before = readFileSync(file);
    const r = openSenderSession(file, randomBytes(32));
    expect(r).toEqual({ ok: false, code: 'decrypt_failed' });
    expect(readFileSync(file).equals(before)).toBe(true);
    rmSync(file); // the failed open left no handle on the file
  });

  it('reports a file that is not a SQLite database as unreadable, without throwing or changing the file', () => {
    const dir = tempDir();
    const file = senderSessionDbPath(dir);
    const junk = Buffer.alloc(4096, 0x41);
    writeFileSync(file, junk);
    const r = openSenderSession(file, randomBytes(32));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toMatch(/^SQLITE_/);
    expect(readFileSync(file).equals(junk)).toBe(true);
    rmSync(file);
  });

  it('reports a damaged file as unreadable and not transient: only link-sender --reset fixes it', () => {
    const file = senderSessionDbPath(tempDir());
    writeFileSync(file, Buffer.alloc(4096, 0x41));
    const r = openSenderSession(file, randomBytes(32));
    expect(r).toEqual({ ok: false, code: 'SQLITE_NOTADB' });
    rmSync(file);
  });

  it('a file that is not a database: its -wal and -shm files are left exactly as they are', () => {
    const file = senderSessionDbPath(tempDir());
    writeFileSync(file, Buffer.alloc(4096, 0x41));
    writeFileSync(`${file}-wal`, 'wal bytes');
    writeFileSync(`${file}-shm`, 'shm bytes');
    expect(openSenderSession(file, randomBytes(32))).toEqual({ ok: false, code: 'SQLITE_NOTADB' });
    expect(readFileSync(`${file}-wal`, 'utf8')).toBe('wal bytes');
    expect(readFileSync(`${file}-shm`, 'utf8')).toBe('shm bytes');
  });

  it('a short file without the SQLite header is not a database either', () => {
    const file = senderSessionDbPath(tempDir());
    writeFileSync(file, 'SQLite');
    expect(openSenderSession(file, randomBytes(32))).toEqual({ ok: false, code: 'SQLITE_NOTADB' });
    expect(readFileSync(file, 'utf8')).toBe('SQLite');
  });

  it('a file damaged past its header is reported as damaged, and its -wal file is not deleted', async () => {
    const file = await linkedSenderFile(tempDir(), randomBytes(32));
    const bytes = readFileSync(file);
    bytes.fill(0x41, 100, 4096); // keep the 100-byte database header, break page 1 (the schema)
    writeFileSync(file, bytes);
    writeFileSync(`${file}-wal`, 'wal bytes');
    const r = openSenderSession(file, randomBytes(32));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toMatch(/^SQLITE_(CORRUPT|NOTADB)/);
      expect(r.transient).toBeUndefined();
    }
    expect(readFileSync(`${file}-wal`, 'utf8')).toBe('wal bytes');
    expect(readFileSync(file).equals(bytes)).toBe(true);
  });

  it('reports a read-only file as transient, not damaged, and leaves it as it is', () => {
    const file = senderSessionDbPath(tempDir());
    writeFileSync(file, '');
    chmodSync(file, 0o444);
    try {
      const r = openSenderSession(file, randomBytes(32));
      if (r.ok) r.db.raw.close();
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toMatch(/^SQLITE_READONLY/);
        expect(r.transient).toBe(true);
      }
      expect(readFileSync(file).length).toBe(0);
    } finally {
      chmodSync(file, 0o666);
    }
  });

  it('reports a directory at the session path as transient, not damaged', () => {
    const file = senderSessionDbPath(tempDir());
    mkdirSync(file, { recursive: true });
    const r = openSenderSession(file, randomBytes(32));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toMatch(/^SQLITE_CANTOPEN/);
      expect(r.transient).toBe(true);
    }
  });

  it('throws an error that is neither a SQLite nor a decrypt error, instead of calling the session unreadable', () => {
    const dir = tempDir();
    const notADir = join(dir, 'a-file');
    writeFileSync(notADir, 'x');
    // The parent of the session file is a regular file: opening it fails with a file-system error, not a SQLite one.
    expect(() => openSenderSession(join(notADir, 'sender-session.db'), randomBytes(32))).toThrow();
    // A master key of the wrong type is a programming error: it must surface, not become 'unreadable'.
    const fresh = senderSessionDbPath(tempDir());
    expect(() => openSenderSession(fresh, 'not a key' as unknown as Buffer)).toThrow();
  });

  it('never opens or touches the founder session', async () => {
    const dir = tempDir();
    const master = randomBytes(32);
    const founder = openSessionDb(sessionDbPath(dir));
    const f = useEncryptedAuthState(founder, master);
    f.state.creds.me = { id: '919800000001:1@s.whatsapp.net', name: 'F' };
    await f.saveCreds();
    founder.raw.close();
    const before = readFileSync(sessionDbPath(dir));
    writeFileSync(senderSessionDbPath(dir), Buffer.alloc(4096, 0x41));
    expect(openSenderSession(senderSessionDbPath(dir), master).ok).toBe(false);
    expect(readFileSync(sessionDbPath(dir)).equals(before)).toBe(true);
  });
});
