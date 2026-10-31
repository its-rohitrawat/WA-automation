import { describe, expect, it } from 'vitest';
import { GlobalSpend } from '../../src/spend/globalSpend.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { manualClock, type Clock } from '../../src/util/clock.ts';
import { seededDb } from '../helpers/db.ts';

// Two members on separate databases (each tenant's spend rows are its own) under one platform ceiling (S4.3, D3). The
// mechanics take any number of members; in the wiring only founder-billed spend joins (owner, 30 Oct).
const NOW = '2026-10-19T10:00:00.000Z'; // 15:30 IST on the 19th

async function guard(o: { clock: Clock; capUsd: number; global: GlobalSpend; tenantId: string }) {
  return SpendGuard.open({ db: await seededDb(), clock: o.clock, capUsd: o.capUsd, platform: { global: o.global, tenantId: o.tenantId } });
}

describe('GlobalSpend: the platform ceiling over its members (S4.3)', () => {
  it('a reservation must fit both the customer cap and the platform ceiling', async () => {
    const clock = manualClock(NOW);
    const global = new GlobalSpend({ capUsd: 1 });
    const a = await guard({ clock, capUsd: 0.8, global, tenantId: 'A' });
    const b = await guard({ clock, capUsd: 0.8, global, tenantId: 'B' });
    expect(a.reserve(0.6)).not.toBeNull();
    expect(b.reserve(0.6)).toBeNull(); // 1.2 > the platform's 1.0, though under b's own 0.8
    expect(b.canSpend(0.6)).toBe(false);
    expect(b.fitsIgnoringHolds(0.6)).toBe(true); // a's call in flight is the reason, not the spend
    expect(b.reserve(0.3)).not.toBeNull();
    expect(a.reserve(0.9)).toBeNull(); // a's own cap
  });

  it('counts settled spend, not estimates, and resets at the IST day change', async () => {
    const clock = manualClock('2026-10-19T18:00:00.000Z'); // 23:30 IST
    const global = new GlobalSpend({ capUsd: 1 });
    const a = await guard({ clock, capUsd: 5, global, tenantId: 'A' });
    const b = await guard({ clock, capUsd: 5, global, tenantId: 'B' });
    const id = a.reserve(0.9)!;
    expect(b.reserve(0.2)).toBeNull(); // the hold counts while the call is in flight
    a.settle(id, 'ai', 0.1, 'batch 1'); // the call cost far less than its estimate
    expect(global.spentToday()).toBeCloseTo(0.1);
    const idB = b.reserve(0.85)!;
    expect(idB).not.toBeNull();
    b.settle(idB, 'ai', 0.9, 'batch 2'); // 1.0 booked across both
    expect(global.isPaused()).toBe(true);
    expect(a.pauseReason()).toBe('platform');
    expect(a.isPaused()).toBe(true);
    expect(global.spentTodayByTenant()).toEqual({ A: 0.1, B: 0.9 });
    clock.set('2026-10-19T18:31:00.000Z'); // 00:01 IST on the 20th
    expect(global.spentToday()).toBe(0);
    expect(a.isPaused()).toBe(false);
    expect(a.reserve(0.9)).not.toBeNull();
  });

  it('a customer’s own cap is named as the reason before the ceiling', async () => {
    const clock = manualClock(NOW);
    const global = new GlobalSpend({ capUsd: 1 });
    const a = await guard({ clock, capUsd: 0.5, global, tenantId: 'A' });
    a.record('ai', 0.5, 'batch 1');
    expect(a.pauseReason()).toBe('cap');
    expect(global.isPaused()).toBe(false);
  });

  it('a runtime that restarts joins with its loaded total and replaces its old guard: never counted twice, never at zero', async () => {
    const clock = manualClock(NOW);
    const global = new GlobalSpend({ capUsd: 1 });
    const db = await seededDb();
    const first = await SpendGuard.open({ db, clock, capUsd: 5, platform: { global, tenantId: 'A' } });
    first.record('ai', 0.7, 'batch 1');
    await first.flushed();
    const again = await SpendGuard.open({ db, clock, capUsd: 5, platform: { global, tenantId: 'A' } });
    expect(again.spentToday()).toBeCloseTo(0.7);
    expect(global.spentToday()).toBeCloseTo(0.7);
    expect(again.reserve(0.4)).toBeNull();
  });

  it('without a platform the guard behaves as before: only its own cap counts', async () => {
    const clock = manualClock(NOW);
    const global = new GlobalSpend({ capUsd: 0.1 });
    await guard({ clock, capUsd: 5, global, tenantId: 'A' }).then((a) => a.record('ai', 0.5, 'batch 1'));
    const founder = await SpendGuard.open({ db: await seededDb(), clock, capUsd: 1 });
    expect(founder.reserve(0.9)).not.toBeNull();
    expect(founder.pauseReason()).toBeNull();
  });
});
