import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface KeyProvider {
  getKey(): Buffer;
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
    'Add-Type -AssemblyName System.Security; ' +
    '$in = [Console]::In.ReadToEnd().Trim(); ' +
    '$bytes = [Convert]::FromBase64String($in); ' +
    `$out = [System.Security.Cryptography.ProtectedData]::${fn}($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
    '[Console]::Out.Write([Convert]::ToBase64String($out))';
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: inputB64,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
};

export class DpapiKeyProvider implements KeyProvider {
  readonly #file: string;
  readonly #run: DpapiRunner;
  #cached: Buffer | undefined;

  constructor(file: string, run: DpapiRunner = powershellDpapi) {
    this.#file = file;
    this.#run = run;
  }

  getKey(): Buffer {
    if (this.#cached) return this.#cached;
    let key: Buffer;
    if (existsSync(this.#file)) {
      key = Buffer.from(this.#run('unprotect', readFileSync(this.#file, 'utf8').trim()), 'base64');
    } else {
      key = randomBytes(32);
      mkdirSync(dirname(this.#file), { recursive: true });
      // 'wx' refuses to overwrite an existing key file.
      writeFileSync(this.#file, this.#run('protect', key.toString('base64')), { flag: 'wx' });
    }
    if (key.length !== 32) throw new Error('Master key file is damaged');
    this.#cached = key;
    return key;
  }
}
