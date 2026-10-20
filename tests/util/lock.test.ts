import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { acquireLock, AlreadyRunningError } from '../../src/util/lock.ts';

const dirs: string[] = [];
const tmpLock = () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-lock-'));
  dirs.push(dir);
  return join(dir, 'agent.lock');
};

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('acquireLock', () => {
  it('acquires and releases', () => {
    const file = tmpLock();
    const lock = acquireLock(file);
    expect(existsSync(file)).toBe(true);
    lock.release();
    expect(existsSync(file)).toBe(false);
  });

  it('refuses while another live process holds it', () => {
    const file = tmpLock();
    writeFileSync(file, '424242');
    expect(() => acquireLock(file, () => true)).toThrowError(AlreadyRunningError);
  });

  it('takes over a stale lock', () => {
    const file = tmpLock();
    writeFileSync(file, '424242');
    const lock = acquireLock(file, () => false);
    lock.release();
  });
});
