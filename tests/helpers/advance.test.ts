import { describe, expect, it, vi } from 'vitest';
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
});
