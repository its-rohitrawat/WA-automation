import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../../src/crypto/envelope.ts';

describe('envelope encryption', () => {
  const key = randomBytes(32);

  it('round-trips data', () => {
    const blob = encrypt(key, Buffer.from('hello'));
    expect(decrypt(key, blob).toString()).toBe('hello');
  });

  it('does not store plaintext', () => {
    expect(encrypt(key, Buffer.from('very-recognisable-marker')).toString('latin1')).not.toContain('very-recognisable-marker');
  });

  it('fails with the wrong key or tampered data', () => {
    const blob = encrypt(key, Buffer.from('hello'));
    expect(() => decrypt(randomBytes(32), blob)).toThrow();
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(() => decrypt(key, tampered)).toThrow();
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => encrypt(randomBytes(16), Buffer.from('x'))).toThrowError(/32 bytes/);
  });

  it('rejects a blob that is too short', () => {
    expect(() => decrypt(key, Buffer.alloc(17))).toThrowError(/too short/);
  });

  it('rejects tampering of the version byte, IV and tag', () => {
    const blob = encrypt(key, Buffer.from('hello'));
    for (const i of [0, 1, 12, 13, 28]) {
      const t = Buffer.from(blob);
      t[i] = (t[i] ?? 0) ^ 1;
      expect(() => decrypt(key, t)).toThrow();
    }
  });
});
