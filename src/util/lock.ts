import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export class AlreadyRunningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlreadyRunningError';
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** One WA Agent process per data folder: two copies on one WhatsApp session would fight. */
export function acquireLock(file: string, isAlive: (pid: number) => boolean = pidAlive): { release(): void } {
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return {
        release: () => {
          try {
            if (readFileSync(file, 'utf8') === String(process.pid)) unlinkSync(file);
          } catch {
            // already gone
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(readFileSync(file, 'utf8'));
      if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
        throw new AlreadyRunningError(`Another WA Agent process (pid ${pid}) is running. Stop it first (net stop wa-agent).`);
      }
      unlinkSync(file); // stale lock from a crashed process
    }
  }
  throw new AlreadyRunningError('Could not acquire the WA Agent lock');
}
