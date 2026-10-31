import { afterEach, describe, expect, it } from 'vitest';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import type { Db, Sql } from '../../src/store/db.ts';
import type { Params, RunResult } from '../../src/store/engine/types.ts';
import { manualClock } from '../../src/util/clock.ts';
import { onSqlite, seededDb, testDb } from '../helpers/db.ts';

// Real bug 9 (the Postgres conversion): refresh() replaced today's total with the database's sum, so a booking whose
// row was not yet visible dropped out of memory and spend was under-counted until the next refresh: a paid call
// could slip past the cap by one booking. On SQLite's one connection the rows were always in first. Here a Db plays
// Postgres's two cases: a row booked without a handle still being written, and a booking in a transaction still open.

const NOW = '2026-10-19T08:00:00.000Z';
const opened: Db[] = [];
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
});

const isSpendInsert = (sql: string) => /INSERT INTO spend/.test(sql);

/** The Db with its run replaced (each other method goes to the Db itself). */
function withRun(db: Db, run: (sql: string, p?: Params) => Promise<RunResult>, tx?: Db['tx']): Db {
  return {
    engine: db.engine, get: (s, p) => db.get(s, p), all: (s, p) => db.all(s, p), run, exec: (s) => db.exec(s),
    tx: tx ?? ((fn) => db.tx(fn)), close: () => db.close(),
  };
}

/** The Db, with its spend rows written `delayMs` later, as on a busy connection of the pool. */
function slowSpendWrites(db: Db, delayMs: number): Db {
  return withRun(db, async (sql, p) => {
    if (isSpendInsert(sql)) await new Promise((r) => setTimeout(r, delayMs));
    return db.run(sql, p);
  });
}

/**
 * The Db, with a transaction whose spend rows stay out of sight until it commits, as another connection sees an open
 * Postgres transaction: they are written when fn returns and `commit` opens; dropped when fn throws.
 */
function heldTransactions(db: Db, commit: Promise<void>): Db {
  const tx = async <T>(fn: (q: Sql) => Promise<T>): Promise<T> => {
    const held: [string, Params | undefined][] = [];
    const q = withRun(db, async (sql, p) => {
      if (!isSpendInsert(sql)) return db.run(sql, p);
      held.push([sql, p]);
      return { changes: 1 } as RunResult;
    });
    const result = await fn(q);
    await commit;
    for (const [sql, p] of held) await db.run(sql, p);
    return result;
  };
  return withRun(db, (s, p) => db.run(s, p), tx as Db['tx']);
}

async function base() {
  const db = await seededDb();
  opened.push(db);
  return db;
}

describe('refresh never counts less than this guard has booked (real bug 9)', () => {
  it('a booking without a handle whose row is still being written stays counted', async () => {
    const db = slowSpendWrites(await base(), 40);
    const guard = new SpendGuard({ db, clock: manualClock(NOW), capUsd: 1 });
    guard.record('ai', 0.3, 'first');
    await guard.flushed();
    guard.record('ai', 0.2, 'second'); // its row lands 40 ms later
    await guard.refresh(); // must not read the total without it
    expect(guard.spentToday()).toBeCloseTo(0.5);
    expect(guard.canSpend(0.6)).toBe(false);
  });

  it('a booking in a transaction still open while refresh runs stays counted, then the read has it (the open transaction played)', async () => {
    let open!: () => void;
    const commit = new Promise<void>((r) => (open = r));
    const raw = await base();
    const db = heldTransactions(raw, commit);
    const guard = new SpendGuard({ db, clock: manualClock(NOW), capUsd: 1 });
    const change = db.tx(async (q) => guard.record('ai', 0.4, 'in a transaction', q));
    await new Promise((r) => setTimeout(r, 10)); // booked; the transaction is still open
    expect(guard.spentToday()).toBeCloseTo(0.4);
    await guard.refresh(); // its row is not in sight yet
    expect(guard.spentToday()).toBeCloseTo(0.4);
    open();
    await change;
    await guard.refresh();
    expect(guard.spentToday()).toBeCloseTo(0.4); // the committed row is now in the read
  });

  it('a rolled-back booking stays counted until a refresh with no booking since the one before (the safe side)', async () => {
    const db = await base();
    const guard = new SpendGuard({ db, clock: manualClock(NOW), capUsd: 1 });
    await db.tx(async (q) => guard.record('ai', 0.2, 'kept', q));
    await expect(db.tx(async (q) => {
      await guard.record('ai', 0.3, 'rolled back', q);
      throw new Error('the change failed');
    })).rejects.toThrow('the change failed');
    expect(guard.spentToday()).toBeCloseTo(0.5);
    await guard.refresh(); // a booking since the previous refresh: it may still be in an open transaction
    expect(guard.spentToday()).toBeCloseTo(0.5);
    await guard.refresh(); // none since: the read is the truth
    expect(guard.spentToday()).toBeCloseTo(0.2);
  });
});

// Postgres only (S2.7): a transaction really held open on one of the pool's connections while refresh reads on
// another; SQLite has one connection, so a read there always waits for the transaction to end.
describe.runIf(!onSqlite)('refresh during a real open transaction on Postgres (real bug 9)', () => {
  it('the booking stays counted while its transaction is open on another connection, and after it commits', async () => {
    const db = await testDb();
    opened.push(db);
    const guard = new SpendGuard({ db, clock: manualClock(NOW), capUsd: 1 });
    let commit!: () => void;
    const held = new Promise<void>((r) => (commit = r));
    let bookedNow!: () => void;
    const booked = new Promise<void>((r) => (bookedNow = r));
    const change = db.tx(async (q) => {
      await guard.record('ai', 0.4, 'in an open transaction', q);
      bookedNow();
      await held; // the transaction stays open: its row is not visible to another connection
    });
    await booked;
    expect((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM spend WHERE detail = 'in an open transaction'"))!.n).toBe(0);
    await guard.refresh();
    expect(guard.spentToday()).toBeCloseTo(0.4);
    commit();
    await change;
    await guard.refresh();
    expect(guard.spentToday()).toBeCloseTo(0.4);
  });
});
