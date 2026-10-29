import { describe, expect, it } from 'vitest';
import { TRACKER_ID_KEY } from '../../src/report/morningReport.ts';
import { ReportScheduler } from '../../src/report/scheduler.ts';
import type { ReportSettings } from '../../src/report/types.ts';
import { setKv } from '../../src/store/kv.ts';
import { reportFor } from '../../src/store/reports.ts';
import { manualClock } from '../../src/util/clock.ts';
import { silentLogger } from '../../src/util/logger.ts';
import { seededDb } from '../helpers/db.ts';
import { FakeReportSender } from '../helpers/fakeReportSender.ts';

// The dashboard changes the briefing's settings while the service runs: the scheduler reads them through a getter on
// every tick (D5 Task 1). 2026-10-24 is a Saturday, 2026-10-23 a Friday.
const at = (date: string, hm: string) => `${date}T${hm}:00.000+05:30`;
const ON: ReportSettings = { enabled: true, time: '06:00', deadline: '12:00', days: 'weekdays' };

async function setup(initial: ReportSettings) {
  const db = await seededDb();
  setKv(db, TRACKER_ID_KEY, '1AbCdEfGhIjKlMnOp_qRsTuV-wxyz0123');
  const clock = manualClock(at('2026-10-24', '05:00'));
  const sender = new FakeReportSender();
  let current = initial;
  let reads = 0;
  const s = new ReportScheduler({
    db, clock, log: silentLogger(), sender, healthLine: () => ({ ok: true, text: '✅ Connected' }),
    settings: () => {
      reads++;
      return current;
    },
  });
  s.recover();
  const tick = async (date: string, hm: string) => {
    clock.set(at(date, hm));
    await s.tick(clock.now());
  };
  return { db, sender, s, tick, set: (next: ReportSettings) => (current = next), reads: () => reads };
}

describe('ReportScheduler with a settings getter', () => {
  it('picks up a days change on the next tick', async () => {
    const t = await setup(ON);
    await t.tick('2026-10-24', '06:30'); // Saturday, weekdays only: nothing
    expect(t.sender.calls).toHaveLength(0);
    expect(await reportFor(t.db, '2026-10-24')).toBeUndefined();
    t.set({ ...ON, days: 'mon-sat' });
    await t.tick('2026-10-24', '06:31');
    expect(t.sender.calls).toHaveLength(1);
    expect((await reportFor(t.db, '2026-10-24'))?.status).toBe('sent');
  });

  it('turning off skips the next scheduled send, and on again sends within the window', async () => {
    const t = await setup({ ...ON, enabled: false });
    await t.tick('2026-10-23', '06:30');
    expect(t.sender.calls).toHaveLength(0);
    expect(t.s.health().text).toBe('Morning report: off');
    t.set(ON);
    expect(t.s.health().text).toBe('Morning report: due now');
    await t.tick('2026-10-23', '06:31');
    expect(t.sender.calls).toHaveLength(1);
    t.set({ ...ON, enabled: false });
    await t.tick('2026-10-24', '06:30'); // next day, any day: off sends nothing
    t.set({ ...ON, enabled: false, days: 'daily' });
    await t.tick('2026-10-25', '06:30');
    expect(t.sender.calls).toHaveLength(1);
  });

  it('still sends at most once per IST date when the settings change mid-day', async () => {
    const t = await setup({ ...ON, days: 'daily' });
    await t.tick('2026-10-24', '06:30');
    t.set({ ...ON, enabled: false });
    await t.tick('2026-10-24', '06:31');
    t.set({ ...ON, days: 'mon-sat' });
    await t.tick('2026-10-24', '07:00');
    await t.tick('2026-10-24', '08:00');
    expect(t.sender.calls).toHaveLength(1);
  });

  it('reads the getter once per tick, so one tick never mixes two versions', async () => {
    const t = await setup(ON);
    const before = t.reads();
    await t.tick('2026-10-23', '06:30');
    expect(t.reads() - before).toBe(1);
  });

  it('a settings object still works as before', async () => {
    const db = await seededDb();
    setKv(db, TRACKER_ID_KEY, '1AbCdEfGhIjKlMnOp_qRsTuV-wxyz0123');
    const clock = manualClock(at('2026-10-23', '06:30'));
    const sender = new FakeReportSender();
    const s = new ReportScheduler({ db, clock, log: silentLogger(), sender, settings: ON, healthLine: () => ({ ok: true, text: '✅' }) });
    s.recover();
    await s.tick();
    expect(sender.calls).toHaveLength(1);
  });
});

describe('ReportScheduler with a getter that throws', () => {
  it('tick resolves, sends nothing and logs; health gives a plain line', async () => {
    const db = await seededDb();
    setKv(db, TRACKER_ID_KEY, '1AbCdEfGhIjKlMnOp_qRsTuV-wxyz0123');
    const clock = manualClock(at('2026-10-23', '06:30'));
    const sender = new FakeReportSender();
    const errors: string[] = [];
    const log = { ...silentLogger(), error: (_o: unknown, msg: string) => errors.push(msg) } as unknown as ReturnType<typeof silentLogger>;
    const s = new ReportScheduler({
      db, clock, log, sender, healthLine: () => ({ ok: true, text: '✅' }),
      settings: () => {
        throw new Error('database is locked');
      },
    });
    s.recover();
    await expect(s.tick()).resolves.toBeUndefined();
    expect(sender.calls).toHaveLength(0);
    expect(errors).toContain('morning report tick failed');
    expect(s.health()).toEqual({ text: 'Morning report: settings could not be read', warning: null, recipientMasked: '…1234' });
  });
});
