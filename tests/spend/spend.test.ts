import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/config/env.ts';
import { FALLBACK_PRICES, costUsd, estimateCostUsd, pricesFromEnv, type Prices } from '../../src/spend/pricing.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { manualClock } from '../../src/util/clock.ts';
import { seededDb } from '../helpers/db.ts';

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

describe('SpendGuard', () => {
  it('sums spend per India day and enforces the cap', () => {
    const clock = manualClock('2026-10-19T10:00:00Z');
    const guard = new SpendGuard({ db: seededDb(), clock, capUsd: 1 });
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

  const make = (cap = 1, start = '2026-10-19T10:00:00Z') => {
    const clock = manualClock(start);
    return { clock, guard: new SpendGuard({ db: seededDb(), clock, capUsd: cap }) };
  };

  it('treats spend exactly at the cap correctly', () => {
    const { guard } = make();
    guard.record('ai', 0.6, 'a');
    expect(guard.canSpend(0.4)).toBe(true);
    expect(guard.canSpend(0.41)).toBe(false);
    guard.record('ai', 0.4, 'b');
    expect(guard.isPaused()).toBe(true);
    expect(guard.canSpend(0)).toBe(false);
  });

  it('switches day at midnight IST', () => {
    const { clock, guard } = make(1, '2026-10-19T18:29:59Z');
    guard.record('ai', 0.5, 'a');
    expect(guard.spentToday()).toBeCloseTo(0.5);
    clock.set('2026-10-19T18:30:00Z');
    expect(guard.spentToday()).toBe(0);
  });

  it.each([NaN, Infinity, -5])('pauses the day on bad amount %s', (bad) => {
    const { guard } = make();
    guard.record('ai', 0.2, 'ok');
    expect(() => guard.record('ai', bad, 'batch 1')).not.toThrow();
    expect(guard.spentToday()).toBeGreaterThanOrEqual(1);
    expect(guard.isPaused()).toBe(true);
  });

  it('rejects bad estimates', () => {
    const { guard } = make();
    expect(guard.canSpend(NaN)).toBe(false);
    expect(guard.canSpend(-1)).toBe(false);
    expect(guard.reserve(NaN)).toBeNull();
  });

  it('reserves, releases and settles in-flight calls', () => {
    const { guard } = make();
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

  it('stops counting a reservation after 45 minutes', () => {
    const { clock, guard } = make();
    expect(guard.reserve(0.6)).not.toBeNull();
    clock.advance(45 * 60_000);
    expect(guard.reserve(0.6)).toBeNull();
    clock.advance(60_000); // T + 46 minutes
    expect(guard.canSpend(0.6)).toBe(true);
    expect(guard.reserve(0.6)).not.toBeNull();
  });

  it('records on settle with an unknown id and ignores unknown release', () => {
    const { guard } = make();
    guard.release(999);
    guard.settle(999, 'ai', 0.3, 'x');
    expect(guard.spentToday()).toBeCloseTo(0.3);
  });
});
