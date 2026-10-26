import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  db.close();
  return file;
}

describe('openSenderSession (service start)', () => {
  it('opens a new or a linked spare-number session', async () => {
    const dir = tempDir();
    const fresh = openSenderSession(senderSessionDbPath(dir), randomBytes(32));
    expect(fresh.ok).toBe(true);
    if (fresh.ok) {
      expect(fresh.auth.hasSession).toBe(false);
      fresh.db.close();
    }
    const master = randomBytes(32);
    const file = await linkedSenderFile(tempDir(), master);
    const linked = openSenderSession(file, master);
    expect(linked.ok).toBe(true);
    if (linked.ok) {
      expect(linked.auth.hasSession).toBe(true);
      linked.db.close();
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
    founder.close();
    const before = readFileSync(sessionDbPath(dir));
    writeFileSync(senderSessionDbPath(dir), Buffer.alloc(4096, 0x41));
    expect(openSenderSession(senderSessionDbPath(dir), master).ok).toBe(false);
    expect(readFileSync(sessionDbPath(dir)).equals(before)).toBe(true);
  });
});
