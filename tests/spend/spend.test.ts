import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/config/env.ts';
import { costUsd, estimateCostUsd, pricesFromEnv, type Prices } from '../../src/spend/pricing.ts';
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
    expect(estimateCostUsd(30_000, P)).toBeCloseTo((10_000 * 4 + 4_000 * 20) / 1e6, 6);
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
});
