import { afterEach, describe, expect, it } from 'vitest';
import { Health } from '../../src/health/health.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import type { Db } from '../../src/store/db.ts';
import type { Params, RunResult } from '../../src/store/engine/types.ts';
import { getKv } from '../../src/store/kv.ts';
import { manualClock } from '../../src/util/clock.ts';
import { seededDb } from '../helpers/db.ts';

// Real bug 8 (the Postgres conversion): a change's health snapshot was written without being awaited, each taking the
// snapshot when asked, so on Postgres two writes on the pool's connections could commit out of order and leave an
// older snapshot stored (`cli status` then showed stale health). SQLite's one connection hid it. Here a Db makes the
// first snapshot write the slowest, as a busy connection would: the writes must still land in order.

const NOW = '2026-10-19T08:00:00.000Z';
const opened: Db[] = [];
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
});

/** The Db, with each health write delayed by the next of `delays` (ms) and failed when `fail` says so. */
function slowHealthWrites(db: Db, delays: number[], fail: (n: number) => boolean = () => false): Db & { writes: number } {
  const out = Object.create(db) as Db & { writes: number };
  out.writes = 0;
  out.run = async (sql: string, p?: Params): Promise<RunResult> => {
    if (!/INTO kv/.test(sql) || (p as unknown[] | undefined)?.[0] !== 'health') return db.run(sql, p);
    const n = out.writes++;
    await new Promise((r) => setTimeout(r, delays[n] ?? 0));
    if (fail(n)) throw new Error('write failed');
    return db.run(sql, p);
  };
  return out;
}

async function setup(delays: number[], fail?: (n: number) => boolean) {
  const base = await seededDb();
  opened.push(base);
  const db = slowHealthWrites(base, delays, fail);
  const clock = manualClock(NOW);
  const errors: unknown[] = [];
  const health = new Health({ db, clock, spend: new SpendGuard({ db: base, clock, capUsd: 10 }), freeBytes: () => 200e9, onError: (e) => errors.push(e) });
  return { base, db, health, errors };
}
const stored = async (db: Db) => JSON.parse((await getKv(db, 'health'))!) as { whatsapp: { state: string } };

describe('the health snapshot writes land in order (real bug 8)', () => {
  it('a slow first write never overwrites a newer snapshot: the last stored is the newest', async () => {
    const { base, db, health, errors } = await setup([40, 0, 0]);
    health.setWhatsApp({ state: 'connecting', since: NOW, lastErrorCode: null, credsSaveFailures: 0 }); // write 1: slow
    health.setWhatsApp({ state: 'open', since: NOW, lastErrorCode: null, credsSaveFailures: 0 }); // write 2: fast
    await health.persist(); // every earlier write is in once this resolves
    // A reader comes later: by now any write still in flight (the slow first one, if unchained) would have landed.
    await new Promise((r) => setTimeout(r, 80));
    expect((await stored(base)).whatsapp.state).toBe('open');
    expect(JSON.stringify(await stored(base))).toBe(JSON.stringify(health.snapshot()));
    expect(db.writes).toBeGreaterThanOrEqual(3);
    expect(errors).toEqual([]);
  });

  it('a failed write is told to onError and the next write still lands', async () => {
    const { base, health, errors } = await setup([0, 0, 0], (n) => n === 0);
    health.setWhatsApp({ state: 'connecting', since: NOW, lastErrorCode: null, credsSaveFailures: 0 }); // fails
    health.setWhatsApp({ state: 'open', since: NOW, lastErrorCode: null, credsSaveFailures: 0 });
    await health.persist();
    expect((await stored(base)).whatsapp.state).toBe('open');
    expect(errors).toHaveLength(1);
    // An awaited write that fails is the caller's; the chain goes on after it.
    const failing = await setup([0, 0], (n) => n === 0);
    await expect(failing.health.persist()).rejects.toThrow('write failed');
    await failing.health.persist();
    expect(await getKv(failing.base, 'health')).toBeDefined();
  });
});
