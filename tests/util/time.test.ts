import { describe, expect, it } from 'vitest';
import { daysBetween, displayDate, fromIstDate, isIsoDate, istDate, istDateTime, istShortDate, istTime } from '../../src/util/time.ts';
import { manualClock } from '../../src/util/clock.ts';

describe('India-time helpers', () => {
  const d = new Date('2026-10-19T08:35:00Z'); // 14:05 IST

  it('formats dates and times in Asia/Kolkata', () => {
    expect(istDate(d)).toBe('2026-10-19');
    expect(istShortDate(d)).toBe('19 Oct');
    expect(istTime(d)).toBe('14:05');
    expect(istDateTime(d)).toBe('2026-10-19 14:05');
  });

  it('rolls over at India midnight, not UTC midnight', () => {
    expect(istDate(new Date('2026-10-19T19:00:00Z'))).toBe('2026-10-20');
  });

  it('converts plain dates', () => {
    expect(displayDate('2026-10-18')).toBe('18 Oct');
    expect(fromIstDate('2026-10-18').toISOString()).toBe('2026-10-17T18:30:00.000Z');
    expect(daysBetween('2026-10-10', '2026-10-19')).toBe(9);
  });

  it('validates YYYY-MM-DD', () => {
    expect(isIsoDate('2026-10-18')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('18 Oct')).toBe(false);
  });

  it('manual clock can be moved', () => {
    const c = manualClock('2026-10-19T00:00:00Z');
    c.advance(60_000);
    expect(c.now().toISOString()).toBe('2026-10-19T00:01:00.000Z');
  });
});
