import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DpapiKeyProvider, MasterKeyError, ownerOnlyFile, powershellDpapi, type DpapiRunner } from '../../src/crypto/keyProvider.ts';

// Reversible stand-in for DPAPI so the logic can be tested anywhere.
const fakeDpapi: DpapiRunner = (mode, b64) =>
  mode === 'protect' ? Buffer.from(`P:${b64}`).toString('base64') : Buffer.from(b64, 'base64').toString().slice(2);

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'wa-key-'));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('DpapiKeyProvider', () => {
  it('creates a 32-byte key once and reuses it', () => {
    const file = join(tempDir(), 'keys', 'master.key.dpapi');
    const first = new DpapiKeyProvider(file, fakeDpapi).getKey();
    expect(first).toHaveLength(32);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).not.toContain(first.toString('base64'));
    const second = new DpapiKeyProvider(file, fakeDpapi).getKey();
    expect(second.equals(first)).toBe(true);
  });

  it('throws MasterKeyError and leaves a damaged key file untouched', () => {
    const dir = tempDir();
    const file = join(dir, 'master.key.dpapi');
    writeFileSync(file, 'garbage');
    const failing: DpapiRunner = () => {
      throw new Error('secret stderr detail');
    };
    let err: unknown;
    try {
      new DpapiKeyProvider(file, failing).getKey();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MasterKeyError);
    expect((err as MasterKeyError).code).toBe('MASTER_KEY_UNREADABLE');
    expect((err as MasterKeyError).message).not.toContain('secret stderr detail');
    expect(readFileSync(file, 'utf8')).toBe('garbage');
  });

  it('rejects a key that is not 32 bytes', () => {
    const file = join(tempDir(), 'master.key.dpapi');
    writeFileSync(file, 'x');
    const short: DpapiRunner = () => Buffer.alloc(16).toString('base64');
    expect(() => new DpapiKeyProvider(file, short).getKey()).toThrowError(
      expect.objectContaining({ code: 'MASTER_KEY_UNREADABLE' }),
    );
  });

  it('wraps create failures', () => {
    const file = join(tempDir(), 'k');
    const failing: DpapiRunner = () => {
      throw new Error('boom');
    };
    expect(() => new DpapiKeyProvider(file, failing).getKey()).toThrowError(
      expect.objectContaining({ code: 'MASTER_KEY_CREATE_FAILED' }),
    );
    expect(existsSync(file)).toBe(false);
  });

  it('returns a copy so callers cannot change the cached key', () => {
    const file = join(tempDir(), 'master.key.dpapi');
    const p = new DpapiKeyProvider(file, fakeDpapi);
    const a = p.getKey();
    const original = Buffer.from(a);
    a.fill(0);
    expect(p.getKey().equals(original)).toBe(true);
  });

  it.runIf(process.platform === 'win32')('round-trips through real Windows DPAPI', () => {
    const secret = Buffer.from('dpapi-check').toString('base64');
    const protectedB64 = powershellDpapi('protect', secret);
    expect(protectedB64).not.toBe(secret);
    expect(powershellDpapi('unprotect', protectedB64)).toBe(secret);
  }, 60_000); // two PowerShell starts can take well over 5 s on a busy PC

  it('keeps a key stored with ownerOnlyFile across providers', () => {
    const file = join(tempDir(), 'keys', 'master.key');
    const first = new DpapiKeyProvider(file, ownerOnlyFile).getKey();
    expect(first).toHaveLength(32);
    expect(new DpapiKeyProvider(file, ownerOnlyFile).getKey().equals(first)).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('defaults to an owner-only key file outside Windows', () => {
    const file = join(tempDir(), 'keys', 'master.key');
    const key = new DpapiKeyProvider(file).getKey();
    expect(key).toHaveLength(32);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
  });
});
