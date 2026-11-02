import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/config/env.ts';
import { CUSTOMER_DEFAULT_CAP_USD, DAILY_CAP_KEY, SettingsStore } from '../../src/config/settingsStore.ts';
import { ControlError, type AuditEntry } from '../../src/control/errors.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { manualClock } from '../../src/util/clock.ts';
import { NOW, seededDb } from '../helpers/db.ts';

// A customer's daily Claude limit (S4.3, owner decision D3): on the customer's own key, so a customer's store has it.
// The founder's cap stays .env-only: the founder's store refuses the key and shows nothing new.

async function setup(customer: boolean) {
  const db = await seededDb();
  const store = await SettingsStore.open({ db, env: parseEnv({}), clock: manualClock(NOW), customer });
  const audits: AuditEntry[] = [];
  const audit = async (_q: unknown, e: AuditEntry) => {
    audits.push(e);
  };
  return { db, store, audits, audit };
}

async function refusal(fn: () => unknown): Promise<ControlError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ControlError) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

describe('the customer daily Claude limit', () => {
  it('the founder: refused, and absent from get() and view()', async () => {
    const { store, audits, audit } = await setup(false);
    const e = await refusal(() => store.set(DAILY_CAP_KEY, 50, 'owner@example.com', audit));
    expect(e.status).toBe(422);
    expect('dailySpendCapUsd' in store.get()).toBe(false);
    expect('dailySpendCapUsd' in (await store.view())).toBe(false);
    expect(audits).toEqual([]);
  });

  it('a customer: US$5 until set; a set value is saved, audited and kept across a reload', async () => {
    const { db, store, audits, audit } = await setup(true);
    expect(store.get().dailySpendCapUsd).toBe(CUSTOMER_DEFAULT_CAP_USD);
    expect((await store.view()).dailySpendCapUsd).toBe(5);
    await store.set(DAILY_CAP_KEY, 12.5, 'owner@example.com', audit);
    expect(store.get().dailySpendCapUsd).toBe(12.5);
    expect(audits).toEqual([{ actor: 'owner@example.com', event: 'settings.dailySpendCapUsd', kind: 'config', detail: 'Daily Claude limit (your key) set to US$12.5' }]);
    await store.set(DAILY_CAP_KEY, 12.5, 'owner@example.com', audit); // already in force: nothing written
    expect(audits).toHaveLength(1);
    const again = await SettingsStore.open({ db, env: parseEnv({}), clock: manualClock(NOW), customer: true });
    expect(again.get().dailySpendCapUsd).toBe(12.5);
  });

  it('a customer: from US$1 to 1000, to the cent; anything else is refused and changes nothing', async () => {
    const { store, audits, audit } = await setup(true);
    for (const bad of [0, 0.99, 1000.01, 1.234, -5, Number.NaN, '20', null]) {
      const e = await refusal(() => store.set(DAILY_CAP_KEY, bad, 'owner@example.com', audit));
      expect(e.status, String(bad)).toBe(422);
      expect(e.message).toMatch(/from US\$1 to US\$1000/);
    }
    expect(store.get().dailySpendCapUsd).toBe(5);
    expect(audits).toEqual([]);
    for (const ok of [1, 1000, 7.25]) await store.set(DAILY_CAP_KEY, ok, 'owner@example.com', audit);
    expect(store.get().dailySpendCapUsd).toBe(7.25);
  });

  it('a lowered limit applies to the next call, with no restart (review B S4)', async () => {
    const { db, store, audit } = await setup(true);
    // As customerRuntime.ts builds it for a customer: the guard reads the store's limit at every check.
    const spend = await SpendGuard.open({ db, clock: manualClock(NOW), capUsd: () => store.get().dailySpendCapUsd ?? CUSTOMER_DEFAULT_CAP_USD });
    const held = spend.reserve(1.5);
    expect(held).not.toBeNull(); // under US$5
    spend.release(held!);
    await store.set(DAILY_CAP_KEY, 1, 'owner@example.com', audit);
    expect(spend.capUsd).toBe(1);
    expect(spend.canSpend(1.5)).toBe(false);
    expect(spend.reserve(1.5)).toBeNull();
    expect(spend.reserve(0.5)).not.toBeNull(); // still under the new limit
    // Raised again: the next call fits again, the same guard.
    await store.set(DAILY_CAP_KEY, 5, 'owner@example.com', audit);
    expect(spend.reserve(1.5)).not.toBeNull();
  });

  it('a limit that cannot be read as an amount pauses spending (fail closed)', async () => {
    const { db } = await setup(true);
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const spend = await SpendGuard.open({ db, clock: manualClock(NOW), capUsd: () => bad });
      expect(spend.capUsd, String(bad)).toBe(0);
      expect(spend.isPaused(), String(bad)).toBe(true);
      expect(spend.reserve(0.01), String(bad)).toBeNull();
    }
  });
});
