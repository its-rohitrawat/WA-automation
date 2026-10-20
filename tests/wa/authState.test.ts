import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openSessionDb, useEncryptedAuthState } from '../../src/wa/authState.ts';

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
    const raw = (db.prepare("SELECT v FROM auth WHERE k = 'creds'").get() as { v: Buffer }).v;
    expect(raw.toString('latin1')).not.toContain('noiseKey');
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
    expect(() => useEncryptedAuthState(db, randomBytes(32))).toThrow();
  });
});
