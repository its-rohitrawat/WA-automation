import { execFileSync } from 'node:child_process';
import { hkdfSync, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export interface KeyProvider {
  getKey(): Buffer;
}

/** A 32-byte HKDF-SHA256 subkey of the master key. Each use gets its own `info` label, so one subkey never opens another's data. */
export function deriveSubkey(masterKey: Buffer, info: string): Buffer {
  if (masterKey.length !== 32) throw new Error('Master key must be 32 bytes');
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), info, 32));
}

export class StaticKeyProvider implements KeyProvider {
  readonly #key: Buffer;
  constructor(key: Buffer) {
    this.#key = key;
  }
  getKey(): Buffer {
    return this.#key;
  }
}

/** Takes base64 in, returns base64 out. */
export type DpapiRunner = (mode: 'protect' | 'unprotect', inputB64: string) => string;

/** Windows DPAPI via the built-in PowerShell, scoped to the current Windows user. */
export const powershellDpapi: DpapiRunner = (mode, inputB64) => {
  const fn = mode === 'protect' ? 'Protect' : 'Unprotect';
  const script =
    "$ErrorActionPreference = 'Stop'; " +
    'Add-Type -AssemblyName System.Security; ' +
    '$in = [Console]::In.ReadToEnd().Trim(); ' +
    '$bytes = [Convert]::FromBase64String($in); ' +
    `$out = [System.Security.Cryptography.ProtectedData]::${fn}($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
    '[Console]::Out.Write([Convert]::ToBase64String($out))';
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: inputB64,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30_000,
  }).trim();
};

export class MasterKeyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MasterKeyError';
    this.code = code;
  }
}

const UNREADABLE_MSG =
  'The master key file could not be decrypted. It is damaged or was created by a different Windows account; see docs/SETUP.md.';

export class DpapiKeyProvider implements KeyProvider {
  readonly #file: string;
  readonly #run: DpapiRunner;
  #cached: Buffer | undefined;

  constructor(file: string, run: DpapiRunner = powershellDpapi) {
    this.#file = file;
    this.#run = run;
  }

  getKey(): Buffer {
    if (this.#cached) return Buffer.from(this.#cached);
    let key: Buffer;
    if (existsSync(this.#file)) {
      try {
        key = Buffer.from(this.#run('unprotect', readFileSync(this.#file, 'utf8').trim()), 'base64');
      } catch {
        throw new MasterKeyError('MASTER_KEY_UNREADABLE', UNREADABLE_MSG);
      }
      if (key.length !== 32) throw new MasterKeyError('MASTER_KEY_UNREADABLE', UNREADABLE_MSG);
    } else {
      key = randomBytes(32);
      try {
        mkdirSync(dirname(this.#file), { recursive: true });
        const protectedB64 = this.#run('protect', key.toString('base64'));
        // 'wx' refuses to overwrite an existing key file; fsync makes the write durable.
        const fd = openSync(this.#file, 'wx');
        try {
          writeSync(fd, protectedB64);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      } catch {
        throw new MasterKeyError('MASTER_KEY_CREATE_FAILED', 'The master key could not be created.');
      }
    }
    this.#cached = key;
    return Buffer.from(key);
  }
}
