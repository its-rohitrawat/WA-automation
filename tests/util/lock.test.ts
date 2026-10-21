import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { acquireLock, AlreadyRunningError, lockName } from '../../src/util/lock.ts';

const dirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-lock-'));
  dirs.push(dir);
  return dir;
};

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('acquireLock', () => {
  it('refuses a second holder and allows re-acquire after release', async () => {
    const dir = tmpDir();
    const lock = await acquireLock(dir);
    await expect(acquireLock(dir)).rejects.toBeInstanceOf(AlreadyRunningError);
    await lock.release();
    await lock.release(); // safe twice
    const again = await acquireLock(dir);
    await again.release();
  });

  it('release() is not held up by a connected client', async () => {
    const dir = tmpDir();
    const lock = await acquireLock(dir);
    const client = net.connect(lockName(dir));
    client.on('error', () => {});
    await new Promise<void>((r) => client.once('connect', () => r()));
    const outcome = await Promise.race([
      lock.release().then(() => 'released'),
      new Promise<string>((r) => setTimeout(() => r('hung'), 1_000)),
    ]);
    client.destroy();
    expect(outcome).toBe('released');
    const again = await acquireLock(dir);
    await again.release();
  });

  it('locks different folders independently', async () => {
    const a = await acquireLock(tmpDir());
    const b = await acquireLock(tmpDir());
    await a.release();
    await b.release();
  });

  it('lockName is stable per folder and differs between folders', () => {
    const a = tmpDir();
    const b = tmpDir();
    expect(lockName(a)).toBe(lockName(a));
    expect(lockName(a)).not.toBe(lockName(b));
    if (process.platform === 'win32') expect(lockName(a).startsWith('\\\\.\\pipe\\wa-agent-')).toBe(true);
  });

  it('is released when the holding process is killed', async () => {
    const dir = tmpDir();
    const url = pathToFileURL(resolve('src/util/lock.ts')).href;
    const code = `import { acquireLock } from ${JSON.stringify(url)};
await acquireLock(${JSON.stringify(dir)});
console.log('locked');
setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    await new Promise<void>((res, rej) => {
      child.once('error', rej);
      child.stdout.on('data', (d) => {
        if (String(d).includes('locked')) res();
      });
    });
    await expect(acquireLock(dir)).rejects.toBeInstanceOf(AlreadyRunningError);
    child.kill();
    await exited;
    const lock = await acquireLock(dir);
    await lock.release();
  }, 20_000);
});
