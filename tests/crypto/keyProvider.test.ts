import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DpapiKeyProvider, powershellDpapi, type DpapiRunner } from '../../src/crypto/keyProvider.ts';

// Reversible stand-in for DPAPI so the logic can be tested anywhere.
const fakeDpapi: DpapiRunner = (mode, b64) =>
  mode === 'protect' ? Buffer.from(`P:${b64}`).toString('base64') : Buffer.from(b64, 'base64').toString().slice(2);

describe('DpapiKeyProvider', () => {
  it('creates a 32-byte key once and reuses it', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'wa-key-')), 'keys', 'master.key.dpapi');
    const first = new DpapiKeyProvider(file, fakeDpapi).getKey();
    expect(first).toHaveLength(32);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).not.toContain(first.toString('base64'));
    const second = new DpapiKeyProvider(file, fakeDpapi).getKey();
    expect(second.equals(first)).toBe(true);
  });

  it.runIf(process.platform === 'win32')('round-trips through real Windows DPAPI', () => {
    const secret = Buffer.from('dpapi-check').toString('base64');
    const protectedB64 = powershellDpapi('protect', secret);
    expect(protectedB64).not.toBe(secret);
    expect(powershellDpapi('unprotect', protectedB64)).toBe(secret);
  });
});
