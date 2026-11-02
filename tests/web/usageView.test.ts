import { describe, expect, it } from 'vitest';
// Browser module; its JSDoc types are checked by tsconfig.web.json, so the import is untyped here.
// @ts-expect-error -- browser module (see above)
import { chartModel, niceScale } from '../../src/web/public/views/usage.js';

describe('AI usage chart (November release, change 4)', () => {
  it('has one axis from $0 in up to 4 round steps that reach the top', () => {
    expect(niceScale(3)).toEqual({ max: 3, ticks: [0, 1, 2, 3], decimals: 0 });
    expect(niceScale(15)).toEqual({ max: 15, ticks: [0, 5, 10, 15], decimals: 0 });
    expect(niceScale(18.3)).toEqual({ max: 20, ticks: [0, 5, 10, 15, 20], decimals: 0 });
    expect(niceScale(7.5)).toEqual({ max: 8, ticks: [0, 2, 4, 6, 8], decimals: 0 });
    expect(niceScale(0.42)).toEqual({ max: 0.6, ticks: [0, 0.2, 0.4, 0.6], decimals: 2 });
    expect(niceScale(10)).toEqual({ max: 10, ticks: [0, 2.5, 5, 7.5, 10], decimals: 2 });
  });

  it('keeps an axis to $1 when there is nothing to show', () => {
    for (const top of [0, -1, Number.NaN]) expect(niceScale(top)).toEqual({ max: 1, ticks: [0, 0.25, 0.5, 0.75, 1], decimals: 2 });
  });

  it('places the columns, the cap line and the ticks on that axis, marks today and a day over the cap', () => {
    const days = [{ day: '2026-10-30', usd: 18.3 }, { day: '2026-10-31', usd: 0 }, { day: '2026-11-01', usd: 10 }];
    const m = chartModel(days, 15);
    expect(m.cols.map((c: { label: string; h: number; today: boolean; over: boolean }) => [c.label, c.h, c.today, c.over])).toEqual([
      ['30', 91.5, false, true], ['31', 0, false, false], ['01', 50, true, false],
    ]);
    expect(m.cols[0].tip).toBe('30 Oct · $18.30 · over the cap');
    expect(m.cols[1].tip).toBe('31 Oct · $0.00');
    expect(m.cols[2].tip).toBe('1 Nov · $10.00 · today');
    expect(m.capAt).toBe(75);
    expect(m.ticks).toEqual([{ at: 0, label: '$0' }, { at: 25, label: '$5' }, { at: 50, label: '$10' }, { at: 75, label: '$15' }, { at: 100, label: '$20' }]);
    expect(m.empty).toBe(false);
  });

  it('says when every day is at $0, and has no cap line without a cap', () => {
    const m = chartModel([{ day: '2026-11-01', usd: 0 }], 0);
    expect(m.empty).toBe(true);
    expect(m.capAt).toBeNull();
    expect(chartModel([], 5).cols).toEqual([]);
  });
});
