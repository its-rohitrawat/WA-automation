import { createHash } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export class AlreadyRunningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlreadyRunningError';
  }
}

/** Name of the OS-held lock for a data folder (Windows named pipe, or a unix socket elsewhere). */
export function lockName(dataDir: string): string {
  const id = createHash('sha256').update(resolve(dataDir).toLowerCase()).digest('hex').slice(0, 16);
  return process.platform === 'win32' ? `\\\\.\\pipe\\wa-agent-${id}` : join(tmpdir(), `wa-agent-${id}.sock`);
}

const RUNNING_MSG = 'Another WA Agent process is using this data folder. Stop it first (net stop wa-agent).';

function tryListen(name: string): Promise<net.Server> {
  return new Promise((resolveP, reject) => {
    const server = net.createServer();
    // The lock is the listening endpoint itself. A stray client must never keep release() pending.
    server.on('connection', (s) => s.destroy());
    server.once('error', reject);
    server.listen(name, () => {
      server.removeListener('error', reject);
      server.unref();
      resolveP(server);
    });
  });
}

function socketIsStale(name: string): Promise<boolean> {
  return new Promise((resolveP) => {
    const client = net.connect(name);
    client.once('connect', () => {
      client.destroy();
      resolveP(false);
    });
    client.once('error', (e) => {
      const code = (e as NodeJS.ErrnoException).code;
      resolveP(code === 'ECONNREFUSED' || code === 'ENOENT');
    });
  });
}

/**
 * One WA Agent process per data folder: two copies on one WhatsApp session would fight.
 * The lock is held by the OS and released automatically when the process dies.
 */
export async function acquireLock(dataDir: string): Promise<{ release(): Promise<void> }> {
  const name = lockName(dataDir);
  let server: net.Server;
  try {
    server = await tryListen(name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    if (process.platform === 'win32' || !(await socketIsStale(name))) throw new AlreadyRunningError(RUNNING_MSG);
    try {
      unlinkSync(name);
    } catch {
      // already gone
    }
    try {
      server = await tryListen(name);
    } catch (e2) {
      if ((e2 as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new AlreadyRunningError(RUNNING_MSG);
      throw e2;
    }
  }
  const held = server;
  let closing: Promise<void> | undefined;
  return {
    release: () => {
      closing ??= new Promise<void>((r) => held.close(() => r()));
      return closing;
    },
  };
}
