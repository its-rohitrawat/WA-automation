import { afterEach, describe, expect, it, vi } from 'vitest';
import { DbWork } from './advance.ts';
import { testDb } from './db.ts';

describe('DbWork', () => {
  it('a spy on the wrapped Db’s tx calls through once (no stack overflow), and the transaction is counted', async () => {
    const work = new DbWork();
    const db = work.wrap(await testDb());
    const tx = vi.spyOn(db, 'tx');
    await expect(db.tx(async (q) => (await q.get<{ n: number }>('SELECT 1 AS n'))?.n)).resolves.toBe(1);
    expect(tx).toHaveBeenCalledTimes(1);
    await work.quiet(); // nothing left in flight
    await db.close();
  });

  it('quiet() waits for a statement in flight', async () => {
    const work = new DbWork();
    const db = work.wrap(await testDb());
    let done = false;
    void db.get('SELECT 1 AS n').then(() => void (done = true));
    await work.quiet();
    expect(done).toBe(true);
    await db.close();
  });

  describe('until()', () => {
    afterEach(() => vi.useRealTimers());

    it('advances fake time while the promise is pending, and returns what it resolves to', async () => {
      vi.useFakeTimers();
      const work = new DbWork();
      const late = new Promise<string>((r) => setTimeout(() => r('done'), 3_000));
      await expect(work.until(late, { fakeMs: 10_000, stepMs: 1_000, realCapMs: 1_000, label: 'late' })).resolves.toBe('done');
    });

    it('fires the timers due at once with the clock held, after its fake time is spent', async () => {
      vi.useFakeTimers();
      const work = new DbWork();
      const start = Date.now();
      // Real I/O first (a real pause, as a file write), then a timer due at once: what settle() is for.
      const p = new Promise<void>((r) => void work.settle(1).then(() => setTimeout(r, 0)));
      await work.until(p, { fakeMs: 0, stepMs: 1_000, realCapMs: 2_000, label: 'p' });
      expect(Date.now()).toBe(start); // the clock never moved
    });

    it('fails loudly, naming the label, when the promise never settles', async () => {
      vi.useFakeTimers();
      const work = new DbWork();
      await expect(work.until(new Promise(() => {}), { fakeMs: 2_000, stepMs: 1_000, realCapMs: 200, label: 'stop()' }))
        .rejects.toThrow('stop() never finished: still pending after 2000 ms of fake time and 200 ms of real waits');
    });
  });
});
