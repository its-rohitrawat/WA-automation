import { describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../../src/config/env.ts';
import { FALLBACK_PRICES, costUsd, estimateCostUsd, pricesFromEnv, type Prices } from '../../src/spend/pricing.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { manualClock } from '../../src/util/clock.ts';
import { row, rows, seededDb } from '../helpers/db.ts';

const P: Prices = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 };

describe('pricing', () => {
  it('prices token usage', () => {
    const usd = costUsd({ inputTokens: 10_000, outputTokens: 2_000, cacheCreationInputTokens: 1_000, cacheReadInputTokens: 5_000 }, P);
    expect(usd).toBeCloseTo(0.04 + 0.04 + 0.005 + 0.001, 6);
  });

  it('estimates conservatively from prompt size', () => {
    expect(estimateCostUsd(3000, P)).toBeCloseTo((1500 * 4 + 16_000 * 20) / 1e6, 6);
  });

  it('exposes fallback prices', () => {
    expect(FALLBACK_PRICES).toEqual({ inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5 });
  });

  it('reads prices from the environment', () => {
    expect(pricesFromEnv(parseEnv({}))).toEqual(P);
  });
});

describe('SpendGuard: today in memory (S1.5)', () => {
  const NOW = '2026-10-19T10:00:00.000Z'; // 15:30 IST on the 19th

  it('keeps today in memory: the checks stay synchronous, and refresh picks up another writer', async () => {
    const db = await seededDb();
    const guard = await SpendGuard.open({ db, clock: manualClock(NOW), capUsd: 1 });
    guard.record('ai', 0.4, 'batch 1');
    expect(guard.spentToday()).toBe(0.4);
    expect(guard.reserve(0.7)).toBeNull(); // 0.4 + 0.7 > 1
    // Another process (the CLI) books spend: this guard sees it after a refresh, not before.
    await db.run('INSERT INTO spend (day, kind, usd, detail, at) VALUES (?, ?, ?, ?, ?)', ['2026-10-19', 'stt', 0.5, 'cli', NOW]);
    expect(guard.spentToday()).toBe(0.4);
    await guard.refresh();
    expect(guard.spentToday()).toBeCloseTo(0.9);
    expect(guard.spentTodayByKind()).toEqual({ ai: 0.4, stt: 0.5 });
    expect(guard.isPaused()).toBe(false);
  });

  it('open() loads what was booked before it was made; new starts at zero (S1.15)', async () => {
    const db = await seededDb();
    const earlier = new SpendGuard({ db, clock: manualClock(NOW), capUsd: 1 });
    earlier.record('stt', 0.25, 'earlier run');
    await earlier.flushed();
    expect((await SpendGuard.open({ db, clock: manualClock(NOW), capUsd: 1 })).spentTodayByKind()).toEqual({ ai: 0, stt: 0.25 });
    expect(new SpendGuard({ db, clock: manualClock(NOW), capUsd: 1 }).spentToday()).toBe(0);
  });

  it('a booking without a handle is counted at once, written behind the call, and flushed() waits for it (S1.15)', async () => {
    const db = await seededDb();
    const guard = await SpendGuard.open({ db, clock: manualClock(NOW), capUsd: 1 });
    guard.record('ai', 0.3, 'batch 1');
    expect(guard.spentToday()).toBeCloseTo(0.3);
    await guard.flushed();
    expect(await db.all('SELECT usd FROM spend')).toEqual([{ usd: 0.3 }]);
    // A refresh right after a booking reads it: the row went to the queue first.
    guard.record('ai', 0.2, 'batch 2');
    await guard.refresh();
    expect(guard.spentToday()).toBeCloseTo(0.5);
  });

  it('a failed write is told to onError and stays counted (the safe side)', async () => {
    const db = await seededDb();
    const errors: unknown[] = [];
    const guard = await SpendGuard.open({ db, clock: manualClock(NOW), capUsd: 1, onError: (err) => errors.push(err) });
    vi.spyOn(db, 'run').mockRejectedValueOnce(new Error('database is locked'));
    guard.record('ai', 0.4, 'batch 1');
    await guard.flushed();
    expect(errors).toHaveLength(1);
    expect(guard.spentToday()).toBeCloseTo(0.4);
  });

  it('with a transaction handle, the booking commits or rolls back with the change; memory over-counts until a refresh', async () => {
    const db = await seededDb();
    const guard = new SpendGuard({ db, clock: manualClock(NOW), capUsd: 1 });
    await db.tx(async (q) => guard.record('ai', 0.2, 'kept', q));
    await expect(db.tx(async (q) => {
      await guard.record('ai', 0.3, 'rolled back', q);
      throw new Error('the change failed');
    })).rejects.toThrow('the change failed');
    expect(await db.all('SELECT usd FROM spend ORDER BY id')).toEqual([{ usd: 0.2 }]);
    expect(guard.spentToday()).toBeCloseTo(0.5); // the safe side under a cap
    await guard.refresh();
    await guard.refresh(); // a rollback looks like an open transaction to the first refresh
    expect(guard.spentToday()).toBeCloseTo(0.2);
  });

  it('settle with a handle books through it and frees the hold even when the write fails', async () => {
    const db = await seededDb();
    const guard = new SpendGuard({ db, clock: manualClock(NOW), capUsd: 1 });
    const a = guard.reserve(0.5)!;
    await db.tx(async (q) => guard.settle(a, 'ai', 0.1, 'call a', q));
    const b = guard.reserve(0.5)!;
    await expect(db.tx(async (q) => {
      await guard.settle(b, 'ai', 0.1, 'call b', q);
      throw new Error('rolled back');
    })).rejects.toThrow('rolled back');
    await guard.refresh();
    await guard.refresh(); // a rollback looks like an open transaction to the first refresh
    expect(guard.spentToday()).toBeCloseTo(0.1);
    expect(guard.canSpend(0.9)).toBe(true); // both holds are gone
  });

  it('a new IST day starts at zero without a read', async () => {
    const db = await seededDb();
    const clock = manualClock('2026-10-19T18:00:00.000Z'); // 23:30 IST
    const guard = new SpendGuard({ db, clock, capUsd: 1 });
    guard.record('ai', 1, 'all of it');
    expect(guard.isPaused()).toBe(true);
    clock.set('2026-10-19T18:31:00.000Z'); // 00:01 IST on the 20th
    expect(guard.spentToday()).toBe(0);
    expect(guard.isPaused()).toBe(false);
  });
});

describe('SpendGuard', () => {
  it('sums spend per India day and enforces the cap', async () => {
    const clock = manualClock('2026-10-19T10:00:00Z');
    const guard = new SpendGuard({ db: await seededDb(), clock, capUsd: 1 });
    guard.record('ai', 0.6, 'batch 1');
    expect(guard.spentToday()).toBeCloseTo(0.6);
    expect(guard.canSpend(0.3)).toBe(true);
    expect(guard.canSpend(0.5)).toBe(false);
    expect(guard.isPaused()).toBe(false);
    guard.record('ai', 0.5, 'batch 2');
    expect(guard.isPaused()).toBe(true);
    clock.set('2026-10-19T19:00:00Z'); // 00:30 IST the next day
    expect(guard.spentToday()).toBe(0);
    expect(guard.isPaused()).toBe(false);
  });

  const make = async (cap = 1, start = '2026-10-19T10:00:00Z') => {
    const clock = manualClock(start);
    return { clock, guard: new SpendGuard({ db: await seededDb(), clock, capUsd: cap }) };
  };

  it('treats spend exactly at the cap correctly', async () => {
    const { guard } = await make();
    guard.record('ai', 0.6, 'a');
    expect(guard.canSpend(0.4)).toBe(true);
    expect(guard.canSpend(0.41)).toBe(false);
    guard.record('ai', 0.4, 'b');
    expect(guard.isPaused()).toBe(true);
    expect(guard.canSpend(0)).toBe(false);
  });

  it('switches day at midnight IST', async () => {
    const { clock, guard } = await make(1, '2026-10-19T18:29:59Z');
    guard.record('ai', 0.5, 'a');
    expect(guard.spentToday()).toBeCloseTo(0.5);
    clock.set('2026-10-19T18:30:00Z');
    expect(guard.spentToday()).toBe(0);
  });

  it.each([NaN, Infinity, -5])('pauses the day on bad amount %s', async (bad) => {
    const { guard } = await make();
    guard.record('ai', 0.2, 'ok');
    expect(() => guard.record('ai', bad, 'batch 1')).not.toThrow();
    expect(guard.spentToday()).toBeGreaterThanOrEqual(1);
    expect(guard.isPaused()).toBe(true);
  });

  it('rejects bad estimates', async () => {
    const { guard } = await make();
    expect(guard.canSpend(NaN)).toBe(false);
    expect(guard.canSpend(-1)).toBe(false);
    expect(guard.reserve(NaN)).toBeNull();
  });

  it('reserves, releases and settles in-flight calls', async () => {
    const { guard } = await make();
    const id = guard.reserve(0.6);
    expect(id).not.toBeNull();
    expect(guard.reserve(0.6)).toBeNull();
    guard.release(id!);
    const id2 = guard.reserve(0.6);
    expect(id2).not.toBeNull();
    guard.settle(id2!, 'ai', 0.25, 'batch 1');
    expect(guard.spentToday()).toBeCloseTo(0.25);
    expect(guard.reserve(0.75)).not.toBeNull();
  });

  it('stops counting a reservation after 45 minutes', async () => {
    const { clock, guard } = await make();
    expect(guard.reserve(0.6)).not.toBeNull();
    clock.advance(45 * 60_000);
    expect(guard.reserve(0.6)).toBeNull();
    clock.advance(60_000); // T + 46 minutes
    expect(guard.canSpend(0.6)).toBe(true);
    expect(guard.reserve(0.6)).not.toBeNull();
  });

  it('settlePending books every live reservation at its estimate and frees it', async () => {
    const db = await seededDb();
    const clock = manualClock('2026-10-19T10:00:00Z');
    const guard = new SpendGuard({ db, clock, capUsd: 1 });
    expect(guard.reserve(0.1)).not.toBeNull();
    clock.advance(46 * 60_000); // past the 45-minute expiry: no longer counts, so not booked
    expect(guard.reserve(0.2)).not.toBeNull();
    expect(guard.reserve(0.3)).not.toBeNull();
    expect(await guard.settlePending('shutdown (estimated)')).toBe(2);
    await guard.flushed();
    expect(guard.spentToday()).toBeCloseTo(0.5);
    // Booked without a handle, the rows are written side by side (on Postgres on two connections): any order, so by amount.
    expect(await rows(db, 'SELECT kind, usd, detail FROM spend ORDER BY usd')).toEqual([
      { kind: 'ai', usd: 0.2, detail: 'shutdown (estimated)' },
      { kind: 'ai', usd: 0.3, detail: 'shutdown (estimated)' },
    ]);
    expect(guard.reserve(0.01)).toBeNull(); // closed after shutdown booking
  });

  it('reserve returns null after settlePending, so a late retry does not start a paid call', async () => {
    const { guard } = await make();
    expect(guard.reserve(0.01)).not.toBeNull();
    await guard.settlePending('shutdown (estimated)');
    await guard.flushed();
    expect(guard.reserve(0.01)).toBeNull();
  });

  it('settlePending records nothing when nothing is pending', async () => {
    const { guard } = await make();
    const id = guard.reserve(0.2)!;
    guard.settle(id, 'ai', 0.1, 'batch 1');
    expect(await guard.settlePending('shutdown (estimated)')).toBe(0);
    await guard.flushed();
    expect(guard.spentToday()).toBeCloseTo(0.1);
  });

  it('a call that finishes after settlePending is not booked twice', async () => {
    const { guard } = await make();
    const a = guard.reserve(0.2)!;
    const b = guard.reserve(0.3)!;
    await guard.settlePending('shutdown (estimated)');
    await guard.flushed();
    guard.settle(a, 'ai', 0.25, 'batch 1');
    guard.release(b);
    expect(guard.spentToday()).toBeCloseTo(0.5);
  });

  it('tells a cap that is reached apart from holds of calls still in flight (Task 15 review round 3)', async () => {
    const { guard } = await make();
    guard.record('ai', 0.4, 'batch 1');
    const rid = guard.reserve(0.5)!; // a scan read in flight
    expect(guard.canSpend(0.2)).toBe(false);
    expect(guard.fitsIgnoringHolds(0.2)).toBe(true); // only the hold is in the way
    expect(guard.fitsIgnoringHolds(0.6)).toBe(true); // exactly at the cap
    expect(guard.fitsIgnoringHolds(0.61)).toBe(false); // the cap itself is the reason
    expect(guard.fitsIgnoringHolds(NaN)).toBe(false);
    expect(guard.fitsIgnoringHolds(-1)).toBe(false);
    guard.release(rid);
    guard.record('ai', 0.6, 'batch 2');
    expect(guard.isPaused()).toBe(true);
    expect(guard.fitsIgnoringHolds(0)).toBe(false);
  });

  it('a hold keeps its kind: settlePending books a speech hold as stt and an AI hold as ai (Phase 3 Task 6)', async () => {
    const db = await seededDb();
    const guard = new SpendGuard({ db, clock: manualClock('2026-10-19T10:00:00Z'), capUsd: 1 });
    expect(guard.reserve(0.1)).not.toBeNull(); // the default kind stays 'ai'
    expect(guard.reserve(0.2, 'stt')).not.toBeNull();
    expect(guard.reserve(0.3, 'ai')).not.toBeNull();
    expect(await guard.settlePending('shutdown (estimated)')).toBe(3);
    await guard.flushed();
    // Booked without a handle, in any order (see above): by amount.
    expect(await rows(db, 'SELECT kind, usd FROM spend ORDER BY usd')).toEqual([
      { kind: 'ai', usd: 0.1 },
      { kind: 'stt', usd: 0.2 },
      { kind: 'ai', usd: 0.3 },
    ]);
  });

  it('settlePending tells a hold its owner booked it; a failing owner does not stop the other bookings', async () => {
    const db = await seededDb();
    const guard = new SpendGuard({ db, clock: manualClock('2026-10-19T10:00:00Z'), capUsd: 1 });
    const told: string[] = [];
    guard.reserve(0.1, 'stt', () => {
      told.push('a');
      throw new Error('owner write failed');
    });
    guard.reserve(0.2, 'stt', () => told.push('b'));
    expect(await guard.settlePending('shutdown (estimated)')).toBe(2);
    await guard.flushed();
    expect(told).toEqual(['a', 'b']);
    expect((await row<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM spend'))!.n).toBe(2);
  });

  it('settlePending writes the booking and the owner record in one transaction; a failing owner write is rolled back', async () => {
    const db = await seededDb();
    const guard = new SpendGuard({ db, clock: manualClock('2026-10-19T10:00:00Z'), capUsd: 1 });
    // Each owner writes through the handle it is given, as a real one does: its write is in the booking's transaction.
    guard.reserve(0.1, 'stt', (q) => q.run("INSERT INTO kv (k, v) VALUES ('ok', 'x')"));
    guard.reserve(0.2, 'stt', async (q) => {
      await q.run("INSERT INTO kv (k, v) VALUES ('half', 'x')");
      throw new Error('owner write failed');
    });
    await guard.settlePending('shutdown (estimated)');
    await guard.flushed();
    expect(await rows(db, "SELECT k FROM kv WHERE k IN ('ok', 'half') ORDER BY k")).toEqual([{ k: 'ok' }]); // the half-done owner write is gone
    expect(await rows(db, 'SELECT usd FROM spend ORDER BY id')).toEqual([{ usd: 0.1 }, { usd: 0.2 }]); // both still booked
  });

  it('records on settle with an unknown id and ignores unknown release', async () => {
    const { guard } = await make();
    guard.release(999);
    guard.settle(999, 'ai', 0.3, 'x');
    expect(guard.spentToday()).toBeCloseTo(0.3);
  });
});
