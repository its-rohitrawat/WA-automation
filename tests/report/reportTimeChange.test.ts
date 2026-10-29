import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/config/env.ts';
import { SettingsStore } from '../../src/config/settingsStore.ts';
import { ControlError, type AuditEntry } from '../../src/control/errors.ts';
import { TRACKER_ID_KEY } from '../../src/report/morningReport.ts';
import { ReportScheduler } from '../../src/report/scheduler.ts';
import type { Db } from '../../src/store/db.ts';
import { setKv } from '../../src/store/kv.ts';
import { reportFor } from '../../src/store/reports.ts';
import { manualClock } from '../../src/util/clock.ts';
import { silentLogger } from '../../src/util/logger.ts';
import { seededDb } from '../helpers/db.ts';
import { FakeReportSender } from '../helpers/fakeReportSender.ts';

// The owner sets the briefing's send time from the dashboard (29 Oct 2026). The scheduler reads it through the settings
// store on every tick, so it applies without a restart; a time that has already passed today starts tomorrow. The
// sender is the fake one: nothing is ever sent to WhatsApp. 2026-10-22 is a Thursday, 2026-10-23 a Friday.
const OWNER = 'owner@example.com';
const THU = '2026-10-22';
const FRI = '2026-10-23';
const at = (date: string, hm: string) => `${date}T${hm}:00.000+05:30`;

async function setup(env: Record<string, string> = {}) {
  const db = await seededDb();
  setKv(db, TRACKER_ID_KEY, '1AbCdEfGhIjKlMnOp_qRsTuV-wxyz0123');
  const clock = manualClock(at(THU, '05:00'));
  const audits: AuditEntry[] = [];
  const audit = (e: AuditEntry) => audits.push(e);
  const sender = new FakeReportSender();
  const make = (d: Db) => {
    const store = new SettingsStore({
      db: d, env: parseEnv({ REPORT_ENABLED: 'true', REPORT_RECIPIENT: '919812345678', ...env }), clock, spareLinked: () => true,
    });
    const s = new ReportScheduler({ db: d, clock, log: silentLogger(), sender, healthLine: () => ({ ok: true, text: '✅ Connected' }), settings: () => store.reportSettings() });
    s.recover();
    return { store, s };
  };
  let { store, s } = make(db);
  return {
    db, clock, sender, audits,
    store: () => store,
    /** Moves the clock to an IST time and runs one tick. */
    tick: async (date: string, hm: string) => {
      clock.set(at(date, hm));
      await s.tick(clock.now());
    },
    setTime: (date: string, hm: string, value: unknown) => {
      clock.set(at(date, hm));
      return store.set('reportTime', value, OWNER, audit);
    },
    /** A service restart: a new store and scheduler on the same database. */
    restart: () => ({ store, s } = make(db)),
  };
}

describe('the briefing send time set from the dashboard', () => {
  it('a time still ahead applies today without a restart, and the next report is shown', async () => {
    const t = await setup();
    t.setTime(THU, '05:00', '07:30');
    expect(t.store().view()).toMatchObject({ sendAt: '07:30', nextReport: 'today 07:30', source: { reportTime: 'dashboard' } });
    await t.tick(THU, '06:00');
    await t.tick(THU, '07:29');
    expect(t.sender.calls).toHaveLength(0);
    await t.tick(THU, '07:30');
    expect(t.sender.calls).toHaveLength(1);
    expect(t.store().view().nextReport).toBe('tomorrow 07:30');
    await t.tick(FRI, '07:29');
    expect(t.sender.calls).toHaveLength(1);
    await t.tick(FRI, '07:30');
    expect(t.sender.calls).toHaveLength(2);
    expect(t.store().view().nextReport).toBe('Mon 26 Oct, 07:30'); // weekdays: Saturday and Sunday are skipped
    expect(t.audits).toEqual([{ actor: OWNER, event: 'settings.reportTime', kind: 'config', detail: 'Morning briefing time set to 07:30 IST' }]);
  });

  it('a later time after today was sent never sends a second time; the next report is tomorrow', async () => {
    const t = await setup();
    await t.tick(THU, '06:00');
    expect(t.sender.calls).toHaveLength(1);
    t.setTime(THU, '09:00', '10:00');
    expect(t.store().view().nextReport).toBe('tomorrow 10:00');
    for (const hm of ['10:00', '10:30', '11:59']) await t.tick(THU, hm);
    expect(t.sender.calls).toHaveLength(1);
    await t.tick(FRI, '10:00');
    expect(t.sender.calls).toHaveLength(2);
  });

  it('a time that has already passed starts tomorrow, and today keeps its time so it is not missed', async () => {
    const t = await setup({ REPORT_TIME: '09:00' });
    t.setTime(THU, '08:00', '07:30'); // 07:30 has passed; today's 09:00 has not
    expect(t.audits.at(-1)?.detail).toBe('Morning briefing time set to 07:30 IST, from tomorrow');
    expect(t.store().reportSettings().time).toBe('09:00');
    expect(t.store().view()).toMatchObject({ sendAt: '07:30', nextReport: 'today 09:00' });
    await t.tick(THU, '08:30');
    expect(t.sender.calls).toHaveLength(0); // not sent at once
    await t.tick(THU, '09:00');
    expect(t.sender.calls).toHaveLength(1);
    expect(t.store().view().nextReport).toBe('tomorrow 07:30');
    await t.tick(FRI, '07:29');
    expect(t.sender.calls).toHaveLength(1);
    await t.tick(FRI, '07:30');
    expect(t.sender.calls).toHaveLength(2);
    expect(reportFor(t.db, FRI)?.status).toBe('sent');
  });

  it('an earlier time after today was sent sends nothing more today, and goes out tomorrow at the new time', async () => {
    const t = await setup();
    await t.tick(THU, '06:00');
    t.setTime(THU, '07:00', '05:00');
    expect(t.store().view().nextReport).toBe('tomorrow 05:00');
    for (const hm of ['07:00', '08:00', '11:00']) await t.tick(THU, hm);
    expect(t.sender.calls).toHaveLength(1);
    await t.tick(FRI, '05:00');
    expect(t.sender.calls).toHaveLength(2);
  });

  it("today's kept time outlasts a restart, and a time changed back ahead applies today again", async () => {
    const t = await setup({ REPORT_TIME: '09:00' });
    t.setTime(THU, '08:00', '07:00');
    t.restart();
    expect(t.store().reportSettings().time).toBe('09:00');
    t.setTime(THU, '08:10', '08:45'); // ahead again: today goes at 08:45, and the kept time is gone
    expect(t.store().reportSettings().time).toBe('08:45');
    expect(t.db.raw.prepare("SELECT k FROM settings WHERE k = 'reportTimeToday'").all()).toEqual([]);
    await t.tick(THU, '08:45');
    await t.tick(THU, '09:00');
    expect(t.sender.calls).toHaveLength(1);
  });

  it('refuses a time that is not HH:MM, saving and auditing nothing', async () => {
    const t = await setup();
    for (const v of ['7:30', '24:00', '07:60', '07:30:00', '', 730, null]) {
      let e: unknown;
      try {
        t.setTime(THU, '05:00', v);
      } catch (err) {
        e = err;
      }
      expect(e, String(v)).toBeInstanceOf(ControlError);
      expect((e as ControlError).status).toBe(422);
      expect((e as ControlError).field).toBe('reportTime');
    }
    expect(t.db.raw.prepare('SELECT k FROM settings').all()).toEqual([]);
    expect(t.audits).toEqual([]);
  });

  it('takes any time of day: a time from the deadline on catches up for 3 hours, never past 23:59', async () => {
    const t = await setup();
    t.setTime(THU, '05:00', '13:15');
    expect(t.store().view()).toMatchObject({ sendAt: '13:15', deadline: '16:15', source: { reportTime: 'dashboard' } });
    expect(t.store().reportSettings()).toMatchObject({ time: '13:15', deadline: '16:15' });
    t.setTime(THU, '05:00', '22:30');
    expect(t.store().reportSettings()).toMatchObject({ time: '22:30', deadline: '23:59' });
    t.setTime(THU, '05:00', '07:30');
    expect(t.store().reportSettings()).toMatchObject({ time: '07:30', deadline: '12:00' });
  });

  it('sends an evening report once, at the evening time', async () => {
    const t = await setup();
    t.setTime(THU, '05:00', '19:00');
    await t.tick(THU, '18:59');
    expect(t.sender.calls).toHaveLength(0);
    await t.tick(THU, '19:00');
    await t.tick(THU, '19:30');
    expect(t.sender.calls).toHaveLength(1);
  });
});
