import { describe, expect, it } from 'vitest';
import { dailyDown, downIntervals, uptimeRatio, UptimeLog } from '../../src/health/uptimeLog.ts';
import { openDb, type Db } from '../../src/store/db.ts';
import { manualClock } from '../../src/util/clock.ts';

const rows = (db: Db) => db.prepare('SELECT at, up FROM uptime_log ORDER BY id').all();
const ist = (date: string, hm: string) => new Date(`${date}T${hm}:00.000+05:30`).getTime();

function setup(start = '2026-10-19T00:00:00.000Z') {
  const db = openDb(':memory:');
  const clock = manualClock(start);
  return { db, clock, log: new UptimeLog(db, clock) };
}

describe('UptimeLog recording', () => {
  it('writes one row at start, then only when up changes, and a down row at a clean stop', () => {
    const t = setup();
    t.log.start(true);
    t.clock.advance(30_000);
    t.log.tick(true);
    t.log.tick(true);
    t.clock.advance(30_000);
    t.log.tick(false);
    t.log.tick(false);
    t.clock.advance(30_000);
    t.log.tick(true);
    t.clock.advance(30_000);
    t.log.stop();
    t.log.stop();
    expect(rows(t.db)).toEqual([
      { at: '2026-10-19T00:00:00.000Z', up: 1 },
      { at: '2026-10-19T00:01:00.000Z', up: 0 },
      { at: '2026-10-19T00:01:30.000Z', up: 1 },
      { at: '2026-10-19T00:02:00.000Z', up: 0 },
    ]);
  });

  it('writes the start row even when the state matches the last one before the restart', () => {
    const t = setup();
    t.log.start(true);
    const again = new UptimeLog(t.db, t.clock);
    t.clock.advance(60_000);
    again.start(true);
    again.tick(true);
    expect(rows(t.db)).toHaveLength(2);
  });

  it('a tick before start counts as a change from nothing', () => {
    const t = setup();
    t.log.tick(false);
    expect(rows(t.db)).toEqual([{ at: '2026-10-19T00:00:00.000Z', up: 0 }]);
  });
});

describe('downIntervals', () => {
  it('runs from each down row to the next up row; an outage still going has no end', () => {
    const r = [
      { at: 0, up: true }, { at: 10, up: false }, { at: 15, up: false }, { at: 20, up: true }, { at: 30, up: false },
    ];
    expect(downIntervals(r)).toEqual([{ start: 10, end: 20 }, { start: 30, end: null }]);
    expect(downIntervals([])).toEqual([]);
  });
});

describe('dailyDown', () => {
  it('splits an outage across midnight IST into both days', () => {
    const now = ist('2026-10-20', '12:00');
    const days = dailyDown([{ start: ist('2026-10-19', '23:30'), end: ist('2026-10-20', '00:45') }], now, 3);
    expect(days).toEqual([
      { day: '2026-10-18', downMinutes: 0, longestMinutes: 0 },
      { day: '2026-10-19', downMinutes: 30, longestMinutes: 30 },
      { day: '2026-10-20', downMinutes: 45, longestMinutes: 45 },
    ]);
  });

  it('counts an outage still going up to now, and sums several in a day', () => {
    const now = ist('2026-10-20', '10:00');
    const days = dailyDown([
      { start: ist('2026-10-20', '01:00'), end: ist('2026-10-20', '01:10') },
      { start: ist('2026-10-20', '02:00'), end: ist('2026-10-20', '02:25') },
      { start: ist('2026-10-20', '09:30'), end: null },
    ], now, 1);
    expect(days).toEqual([{ day: '2026-10-20', downMinutes: 65, longestMinutes: 30 }]);
  });
});

describe('uptimeRatio', () => {
  it('is the percentage of known time up in the window', () => {
    const now = ist('2026-10-20', '00:00');
    const dayAgo = now - 86_400_000;
    expect(uptimeRatio([{ start: now - 864_000, end: now - 432_000 }], dayAgo, now, 1)).toBe(99.5);
    expect(uptimeRatio([], dayAgo, now, 1)).toBe(100);
  });

  it('counts only the time since the log began, and is null with no log at all', () => {
    const now = ist('2026-10-20', '00:00');
    const hourAgo = now - 3_600_000;
    expect(uptimeRatio([{ start: hourAgo, end: hourAgo + 1_800_000 }], hourAgo, now, 30)).toBe(50);
    expect(uptimeRatio([], undefined, now, 30)).toBeNull();
  });
});

describe('UptimeLog reading', () => {
  it('gives daily minutes, outages newest first and ratios from what it recorded', () => {
    const t = setup('2026-10-19T00:00:00.000+05:30');
    t.log.start(true);
    t.clock.set('2026-10-19T10:00:00.000+05:30');
    t.log.tick(false);
    t.clock.set('2026-10-19T10:20:00.000+05:30');
    t.log.tick(true);
    t.clock.set('2026-10-19T23:50:00.000+05:30');
    t.log.stop();
    t.clock.set('2026-10-20T00:10:00.000+05:30');
    const restarted = new UptimeLog(t.db, t.clock);
    restarted.start(true);
    t.clock.set('2026-10-20T12:00:00.000+05:30');
    expect(restarted.daily(2)).toEqual([
      { day: '2026-10-19', downMinutes: 30, longestMinutes: 20 },
      { day: '2026-10-20', downMinutes: 10, longestMinutes: 10 },
    ]);
    expect(restarted.outages(30)).toEqual([
      { start: '2026-10-19T18:20:00.000Z', end: '2026-10-19T18:40:00.000Z', minutes: 20, reason: null },
      { start: '2026-10-19T04:30:00.000Z', end: '2026-10-19T04:50:00.000Z', minutes: 20, reason: null },
    ]);
    const r = restarted.ratios();
    expect(r.d1).toBeCloseTo(100 * (1 - 20 / 1440), 2); // the last 24 h hold the 20-minute stop
    expect(r.d30).toBeCloseTo(100 * (1 - 40 / 2160), 2);
  });

  it('reads the state from before a window to know an outage that began earlier', () => {
    const t = setup('2026-09-01T00:00:00.000Z');
    t.log.start(false); // down since 1 Sep
    t.clock.set('2026-10-20T00:00:00.000Z');
    expect(t.log.outages(30)).toEqual([{ start: '2026-09-01T00:00:00.000Z', end: null, minutes: 70_560, reason: null }]);
    expect(t.log.ratios().d7).toBe(0);
  });

  it('has null ratios and no outages before anything was recorded', () => {
    const t = setup();
    expect(t.log.ratios()).toEqual({ d1: null, d7: null, d30: null });
    expect(t.log.outages(30)).toEqual([]);
    expect(t.log.daily(1)).toEqual([{ day: '2026-10-19', downMinutes: 0, longestMinutes: 0 }]);
  });
});

describe('UptimeLog review fixes', () => {
  it('an outage that began before the window starts at its first down row, across a stop and a down start', () => {
    const t = setup('2026-09-01T00:00:00.000Z');
    t.log.start(true);
    t.clock.set('2026-09-02T00:00:00.000Z');
    t.log.tick(false);
    t.clock.set('2026-09-03T00:00:00.000Z');
    t.log.stop(); // already down: no row
    const again = new UptimeLog(t.db, t.clock);
    t.clock.set('2026-09-05T00:00:00.000Z');
    again.start(false);
    t.clock.set('2026-10-20T00:00:00.000Z');
    expect(again.outages(30)).toEqual([{ start: '2026-09-02T00:00:00.000Z', end: null, minutes: 69_120, reason: null }]);
  });

  it('dailyDown never counts past now', () => {
    const now = ist('2026-10-20', '10:00');
    expect(dailyDown([{ start: ist('2026-10-20', '09:00'), end: ist('2026-10-20', '23:00') }], now, 1)).toEqual([
      { day: '2026-10-20', downMinutes: 60, longestMinutes: 60 },
    ]);
  });

  it('purges old rows but keeps what says the state at the cutoff and where its outage began', () => {
    const t = setup('2026-07-01T00:00:00.000Z');
    t.log.start(true);
    t.clock.set('2026-07-02T00:00:00.000Z');
    t.log.tick(false);
    t.clock.set('2026-07-03T00:00:00.000Z');
    new UptimeLog(t.db, t.clock).start(false);
    t.clock.set('2026-10-19T00:00:00.000Z');
    t.log.tick(true);
    expect(t.log.purgeOlderThan(30)).toBe(1); // the first up row
    expect(rows(t.db)).toEqual([
      { at: '2026-07-02T00:00:00.000Z', up: 0 },
      { at: '2026-07-03T00:00:00.000Z', up: 0 },
      { at: '2026-10-19T00:00:00.000Z', up: 1 },
    ]);
    expect(t.log.outages(30)[0]).toMatchObject({ start: '2026-07-02T00:00:00.000Z', end: '2026-10-19T00:00:00.000Z' });
    expect(t.log.purgeOlderThan(30)).toBe(0);
    expect(() => t.log.purgeOlderThan(0)).toThrowError();
  });
});
