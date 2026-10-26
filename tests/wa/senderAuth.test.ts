import { hkdfSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { senderSessionDbPath, sessionDbPath } from '../../src/config/paths.ts';
import { deriveSubkey } from '../../src/crypto/keyProvider.ts';
import {
  openSessionDb, SENDER_SESSION_INFO, SenderSessionDecryptError, SessionDecryptError, useEncryptedAuthState, useSenderAuthState,
} from '../../src/wa/authState.ts';

const MASTER = randomBytes(32);

describe('sender session store', () => {
  it('lives in its own file next to the founder session', () => {
    expect(senderSessionDbPath('data')).toBe(join('data', 'sender-session.db'));
    expect(senderSessionDbPath('data')).not.toBe(sessionDbPath('data'));
  });

  it('uses its own HKDF subkey of the master key', () => {
    expect(SENDER_SESSION_INFO).toBe('whatsapp-sender-session');
    const sub = deriveSubkey(MASTER, SENDER_SESSION_INFO);
    expect(sub).toHaveLength(32);
    expect(sub.equals(MASTER)).toBe(false);
    expect(sub.equals(deriveSubkey(MASTER, 'whatsapp-media-ref'))).toBe(false);
    expect(deriveSubkey(MASTER, SENDER_SESSION_INFO).equals(sub)).toBe(true);
    for (const size of [0, 16, 31, 33, 64]) {
      expect(() => deriveSubkey(Buffer.alloc(size), SENDER_SESSION_INFO)).toThrow('Master key must be 32 bytes');
    }
  });

  it('derives the subkey as HKDF-SHA256 with an empty salt (pinned, so existing sessions keep opening)', () => {
    const fixedMaster = Buffer.alloc(32, 7);
    const expected = Buffer.from(hkdfSync('sha256', fixedMaster, Buffer.alloc(0), 'whatsapp-sender-session', 32));
    expect(deriveSubkey(fixedMaster, SENDER_SESSION_INFO).equals(expected)).toBe(true);
  });

  it('encrypts the stored rows with exactly HKDF-SHA256(master, empty salt, "whatsapp-sender-session")', async () => {
    const fixedMaster = Buffer.alloc(32, 7);
    const expected = Buffer.from(hkdfSync('sha256', fixedMaster, Buffer.alloc(0), 'whatsapp-sender-session', 32));

    // Written by useSenderAuthState, readable with the pinned subkey.
    const db = openSessionDb(':memory:');
    const a = useSenderAuthState(db, fixedMaster);
    a.state.creds.me = { id: '919800000099:3@s.whatsapp.net', name: 'S' };
    await a.saveCreds();
    const viaExpected = useEncryptedAuthState(db, expected);
    expect(viaExpected.hasSession).toBe(true);
    expect(viaExpected.state.creds.me?.id).toBe('919800000099:3@s.whatsapp.net');
    // Not the media-ref key: the two subsystems never share a key.
    expect(() => useEncryptedAuthState(db, deriveSubkey(fixedMaster, 'whatsapp-media-ref'))).toThrow(SessionDecryptError);

    // Written with the pinned subkey, readable by useSenderAuthState.
    const db2 = openSessionDb(':memory:');
    const b = useEncryptedAuthState(db2, expected);
    b.state.creds.me = { id: '919800000099:3@s.whatsapp.net', name: 'S' };
    await b.saveCreds();
    const viaSender = useSenderAuthState(db2, fixedMaster);
    expect(viaSender.hasSession).toBe(true);
    expect(viaSender.state.creds.me?.id).toBe('919800000099:3@s.whatsapp.net');
  });

  it('persists the spare number session and restores it with the same master key', async () => {
    const db = openSessionDb(':memory:');
    const a = useSenderAuthState(db, MASTER);
    expect(a.hasSession).toBe(false);
    a.state.creds.me = { id: '919800000099:3@s.whatsapp.net', name: 'Spare' };
    await a.saveCreds();
    for (const { v } of db.prepare('SELECT v FROM auth').all() as { v: Buffer }[]) expect(v.toString('latin1')).not.toContain('Spare');
    expect(useSenderAuthState(db, MASTER).hasSession).toBe(true);
  });

  it('cannot be opened with the founder session key, and cannot open the founder session', async () => {
    const senderDb = openSessionDb(':memory:');
    await useSenderAuthState(senderDb, MASTER).saveCreds();
    expect(() => useEncryptedAuthState(senderDb, MASTER)).toThrow(SessionDecryptError);

    const founderDb = openSessionDb(':memory:');
    await useEncryptedAuthState(founderDb, MASTER).saveCreds();
    let thrown: unknown;
    try {
      useSenderAuthState(founderDb, MASTER);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SenderSessionDecryptError);
    expect((thrown as Error).name).toBe('SenderSessionDecryptError');
    expect((thrown as Error).cause).toBeInstanceOf(SessionDecryptError);
  });

  it('does not relabel SQLite errors as decrypt errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wa-sender-sess-'));
    try {
      const db = openSessionDb(join(dir, 'sender-session.db'));
      db.close();
      let thrown: unknown;
      try {
        useSenderAuthState(db, MASTER);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();
      expect(thrown).not.toBeInstanceOf(SenderSessionDecryptError);
      expect(thrown).not.toBeInstanceOf(SessionDecryptError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names link-sender --reset when another master key wrote the file', async () => {
    const db = openSessionDb(':memory:');
    await useSenderAuthState(db, MASTER).saveCreds();
    expect(() => useSenderAuthState(db, randomBytes(32))).toThrow(/link-sender --reset/);
  });
});
