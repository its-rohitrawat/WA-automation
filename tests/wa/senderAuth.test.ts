import { randomBytes } from 'node:crypto';
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
    expect(sub.equals(deriveSubkey(MASTER, 'media-ref'))).toBe(false);
    expect(deriveSubkey(MASTER, SENDER_SESSION_INFO).equals(sub)).toBe(true);
    expect(() => deriveSubkey(Buffer.alloc(16), SENDER_SESSION_INFO)).toThrow('Master key must be 32 bytes');
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
    expect(() => useSenderAuthState(founderDb, MASTER)).toThrow(SenderSessionDecryptError);
  });

  it('names link-sender --reset when another master key wrote the file', async () => {
    const db = openSessionDb(':memory:');
    await useSenderAuthState(db, MASTER).saveCreds();
    expect(() => useSenderAuthState(db, randomBytes(32))).toThrow(/link-sender --reset/);
  });
});
