import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { backoffMs } from '../../src/runtime/backoff.ts';
import { crashOwner, guarded, tenantContext } from '../../src/runtime/context.ts';

describe('backoffMs', () => {
  it('doubles from 1 s up to 5 minutes', () => {
    expect([1, 2, 3, 9, 10, 20].map(backoffMs)).toEqual([1_000, 2_000, 4_000, 256_000, 300_000, 300_000]);
    expect(backoffMs(0)).toBe(1_000);
  });
});

describe('guarded()', () => {
  it('reports a sync throw and an async rejection to its customer, and keeps both from the caller', async () => {
    const crashes: [string, string][] = [];
    const g = guarded('A', (id, e) => crashes.push([id, (e as Error).message]));
    expect(g(() => { throw new Error('sync'); })()).toBeUndefined();
    await g(async () => { throw new Error('async'); })();
    expect(crashes).toEqual([['A', 'sync'], ['A', 'async']]);
  });

  it('passes arguments and results through when nothing throws', async () => {
    const g = guarded('A', () => { throw new Error('not called'); });
    expect(g((a: number, b: number) => a + b)(2, 3)).toBe(5);
    expect(await g(async (x: string) => x.toUpperCase())('ok')).toBe('OK');
  });
});

describe('tenantContext', () => {
  it("follows a customer's timers and promises", async () => {
    const seen: (string | undefined)[] = [];
    await tenantContext.run('A', async () => {
      setTimeout(() => seen.push(tenantContext.getStore()), 0);
      await Promise.resolve();
      seen.push(tenantContext.getStore());
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual(['A', 'A']);
    expect(crashOwner()).toBeUndefined();
  });

  // The process-wide net (S4.5 step 4) relies on this: Node runs 'uncaughtException' and 'unhandledRejection' in the
  // context of the code that threw. Checked in a child process, so a Node upgrade that changes it fails here.
  it("is still the throwing customer's inside the process's uncaughtException and unhandledRejection handlers", () => {
    const script = `
      import { AsyncLocalStorage } from 'node:async_hooks';
      import { EventEmitter } from 'node:events';
      const als = new AsyncLocalStorage();
      const seen = [];
      process.on('uncaughtException', (e) => seen.push(['exception', e.message, als.getStore() ?? null]));
      process.on('unhandledRejection', (e) => seen.push(['rejection', e.message, als.getStore() ?? null]));
      als.run('A', () => setTimeout(() => { throw new Error('timer'); }, 0));
      als.run('B', () => { Promise.resolve().then(() => { throw new Error('promise'); }); });
      als.run('C', () => { const ee = new EventEmitter(); ee.on('x', () => { throw new Error('event'); }); setImmediate(() => ee.emit('x')); });
      setTimeout(() => console.log(JSON.stringify(seen)), 50);
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
    const seen = JSON.parse(r.stdout.trim()) as [string, string, string | null][];
    expect(seen.sort()).toEqual([['exception', 'event', 'C'], ['exception', 'timer', 'A'], ['rejection', 'promise', 'B']]);
  });
});
