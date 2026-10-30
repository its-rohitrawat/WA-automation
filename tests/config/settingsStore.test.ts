import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/config/env.ts';
import { SettingsStore } from '../../src/config/settingsStore.ts';
import { ControlError, type AuditEntry } from '../../src/control/errors.ts';
import type { Db } from '../../src/store/db.ts';
import { manualClock } from '../../src/util/clock.ts';
import { NOW, seededDb } from '../helpers/db.ts';

const OWNER = 'owner@example.com';
const NUMBER = '919812345678';
const OTHER = '917012349999';

async function setup(o: { env?: Record<string, string>; linked?: boolean } = {}) {
  const db = await seededDb();
  const env = parseEnv({ ...o.env });
  const clock = manualClock(NOW);
  let linked = o.linked ?? true;
  const store = new SettingsStore({ db, env, clock, spareLinked: () => linked });
  const audits: AuditEntry[] = [];
  const audit = async (_q: unknown, e: AuditEntry) => {
    audits.push(e);
  };
  return { db, store, clock, audits, audit, setLinked: (v: boolean) => (linked = v) };
}

const rows = (db: Db) => db.raw.prepare('SELECT k, v, updated_at AS updatedAt, updated_by AS updatedBy FROM settings ORDER BY k').all();

async function refusal(fn: () => unknown): Promise<ControlError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ControlError) return e;
    throw e;
  }
  throw new Error('expected a ControlError');
}

describe('SettingsStore.get', () => {
  it('takes the .env defaults when the dashboard changed nothing', async () => {
    const { store } = await setup({ env: { REPORT_ENABLED: 'true', REPORT_RECIPIENT: NUMBER, REPORT_DAYS: 'mon-sat' } });
    expect(store.get()).toEqual({
      reportEnabled: true, reportDays: 'mon-sat', reportRecipient: NUMBER, reportTime: '06:00',
      dashboardSend: false, source: { reportEnabled: 'env', reportDays: 'env', reportRecipient: 'env', reportTime: 'env', dashboardSend: 'env' },
    });
    expect((await setup()).store.get()).toMatchObject({ reportEnabled: false, reportDays: 'weekdays', reportRecipient: undefined });
  });

  it('a dashboard value wins over .env, and the source says so', async () => {
    const { store, audit } = await setup({ env: { REPORT_ENABLED: 'true', REPORT_RECIPIENT: NUMBER } });
    await store.set('reportDays', 'daily', OWNER, audit);
    await store.set('reportEnabled', false, OWNER, audit);
    expect(store.get()).toEqual({
      reportEnabled: false, reportDays: 'daily', reportRecipient: NUMBER, reportTime: '06:00',
      dashboardSend: false, source: { reportEnabled: 'dashboard', reportDays: 'dashboard', reportRecipient: 'env', reportTime: 'env', dashboardSend: 'env' },
    });
  });

  it('falls back to .env for a stored value that is not valid', async () => {
    const { db, store } = await setup({ env: { REPORT_DAYS: 'mon-sat' } });
    const put = db.raw.prepare('INSERT INTO settings (k, v, updated_at, updated_by) VALUES (?, ?, ?, ?)');
    put.run('reportDays', '"sundays"', NOW, OWNER);
    put.run('reportEnabled', 'not json', NOW, OWNER);
    put.run('reportRecipient', '"12345"', NOW, OWNER);
    put.run('reportTime', '"7:30"', NOW, OWNER);
    await store.load(); // written behind the store's back: it reads them again
    expect(store.get()).toEqual({
      reportEnabled: false, reportDays: 'mon-sat', reportRecipient: undefined, reportTime: '06:00',
      dashboardSend: false, source: { reportEnabled: 'env', reportDays: 'env', reportRecipient: 'env', reportTime: 'env', dashboardSend: 'env' },
    });
  });

  it('builds the scheduler settings with the .env send time and deadline when the dashboard set no time', async () => {
    const { store, audit } = await setup({ env: { REPORT_TIME: '07:00', REPORT_DEADLINE: '11:00', REPORT_RECIPIENT: NUMBER } });
    await store.set('reportEnabled', true, OWNER, audit);
    expect(store.reportSettings()).toEqual({ enabled: true, time: '07:00', deadline: '11:00', days: 'weekdays' });
  });
});

describe('SettingsStore: sending from the dashboard (Open chat)', () => {
  it('is off by default with no .env value, switches on and off from the dashboard, audited each time', async () => {
    const { db, store, audits, audit } = await setup({ env: { REPORT_RECIPIENT: NUMBER } });
    expect(store.get().dashboardSend).toBe(false);
    expect((await store.view()).dashboardSend).toBe(false);
    await store.set('dashboardSend', true, OWNER, audit);
    expect(await store.view()).toMatchObject({ dashboardSend: true, source: { dashboardSend: 'dashboard' } });
    await store.set('dashboardSend', false, OWNER, audit);
    expect(rows(db)).toEqual([{ k: 'dashboardSend', v: 'false', updatedAt: NOW, updatedBy: OWNER }]);
    expect(audits).toEqual([
      { actor: OWNER, event: 'settings.dashboardSend', kind: 'config', detail: 'Sending from the dashboard switched on' },
      { actor: OWNER, event: 'settings.dashboardSend', kind: 'config', detail: 'Sending from the dashboard switched off' },
    ]);
    expect(await refusal(() => store.set('dashboardSend', 'true', OWNER, audit))).toMatchObject({ status: 422 });
  });
});

describe('SettingsStore.set', () => {
  it('writes the row with who and when, audits in plain words and returns the new settings', async () => {
    const { db, store, audits, audit } = await setup({ env: { REPORT_RECIPIENT: NUMBER } });
    expect((await store.set('reportDays', 'mon-sat', OWNER, audit)).reportDays).toBe('mon-sat');
    await store.set('reportEnabled', true, OWNER, audit);
    await store.set('reportEnabled', false, OWNER, audit);
    expect(rows(db)).toEqual([
      { k: 'reportDays', v: '"mon-sat"', updatedAt: NOW, updatedBy: OWNER },
      { k: 'reportEnabled', v: 'false', updatedAt: NOW, updatedBy: OWNER },
    ]);
    expect(audits).toEqual([
      { actor: OWNER, event: 'settings.reportDays', kind: 'config', detail: 'Morning briefing days set to Monday to Saturday' },
      { actor: OWNER, event: 'settings.reportEnabled', kind: 'config', detail: 'Morning briefing switched on' },
      { actor: OWNER, event: 'settings.reportEnabled', kind: 'config', detail: 'Morning briefing switched off' },
    ]);
  });

  it('audits a number change masked to its last 4 digits, and never shows the full number', async () => {
    const { db, store, audits, audit } = await setup({ env: { REPORT_RECIPIENT: NUMBER } });
    await store.set('reportRecipient', '+91 70123 49999', OWNER, audit);
    expect(store.get().reportRecipient).toBe(OTHER);
    expect(rows(db)).toMatchObject([{ k: 'reportRecipient', v: `"${OTHER}"` }]);
    expect(audits).toEqual([{ actor: OWNER, event: 'settings.reportRecipient', kind: 'config', detail: 'Morning briefing number changed to …9999' }]);
    expect(JSON.stringify(audits)).not.toContain('70123');
    expect(await store.view()).toEqual({
      reportEnabled: false, reportDays: 'weekdays', recipientMasked: '…9999', sendAt: '06:00', deadline: '12:00', nextReport: null,
      dashboardSend: false, source: { reportEnabled: 'env', reportDays: 'env', reportRecipient: 'dashboard', reportTime: 'env', dashboardSend: 'env' },
    });
    expect(JSON.stringify(await store.view())).not.toContain(OTHER);
  });

  it('validates every key, writing and auditing nothing on a refusal', async () => {
    const { db, store, audits, audit } = await setup({ env: { REPORT_RECIPIENT: NUMBER } });
    const bad: [string, unknown, number][] = [
      ['reportDays', 'sundays', 422], ['reportDays', 1, 422], ['reportEnabled', 'true', 422], ['reportEnabled', 1, 422],
      ['reportRecipient', '9812345678', 422], ['reportRecipient', '911234567890', 422], ['reportRecipient', 919812345678, 422],
      ['reportRecipient', '91 98123 4567x', 422], ['reportRecipient', '', 422], ['dailySpendCap', 50, 422], ['reportDeadline', '13:00', 422],
      ['reportTimeToday', '05:00', 422], ['reportTime', '25:00', 422],
    ];
    for (const [key, value, status] of bad) {
      const e = await refusal(() => store.set(key, value, OWNER, audit));
      expect(e.status, `${key}=${String(value)}`).toBe(status);
      expect(e.message).not.toContain('9812');
    }
    expect((await refusal(() => store.set('reportRecipient', '9812345678', OWNER, audit))).field).toBe('reportRecipient');
    expect(rows(db)).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('refuses to switch on without a number, or before the spare phone is linked', async () => {
    const noNumber = await setup({ linked: true });
    expect(await refusal(() => noNumber.store.set('reportEnabled', true, OWNER, noNumber.audit))).toMatchObject({ status: 409, field: 'reportEnabled' });
    const unlinked = await setup({ env: { REPORT_RECIPIENT: NUMBER }, linked: false });
    expect(await refusal(() => unlinked.store.set('reportEnabled', true, OWNER, unlinked.audit))).toMatchObject({
      status: 409, field: 'reportEnabled', message: 'Link the spare phone first',
    });
    // Switching off never needs either.
    expect((await unlinked.store.set('reportEnabled', false, OWNER, unlinked.audit)).reportEnabled).toBe(false);
    // A number set from the dashboard counts.
    await noNumber.store.set('reportRecipient', NUMBER, OWNER, noNumber.audit);
    expect((await noNumber.store.set('reportEnabled', true, OWNER, noNumber.audit)).reportEnabled).toBe(true);
  });

  it('without a spare-phone check it never switches on', async () => {
    const db = await seededDb();
    const env = parseEnv({ REPORT_RECIPIENT: NUMBER });
    const store = new SettingsStore({ db, env, clock: manualClock(NOW) });
    expect((await refusal(() => store.set('reportEnabled', true, OWNER, async () => {}))).status).toBe(409);
  });

  it('changes nothing, audits nothing and tells no one when the value is already in force', async () => {
    const { db, store, audits, audit } = await setup({ env: { REPORT_DAYS: 'mon-sat' } });
    let told = 0;
    store.onChange(() => told++);
    await store.set('reportDays', 'mon-sat', OWNER, audit);
    expect(rows(db)).toEqual([]);
    expect(audits).toEqual([]);
    expect(told).toBe(0);
  });

  it('tells listeners after the change is saved; a failing listener changes nothing for the others', async () => {
    const { store, audit } = await setup({ env: { REPORT_RECIPIENT: NUMBER } });
    const seen: string[] = [];
    store.onChange(() => {
      throw new Error('listener bug');
    });
    const off = store.onChange((s, key) => seen.push(`${key}:${s.reportDays}`));
    await store.set('reportDays', 'daily', OWNER, audit);
    off();
    await store.set('reportDays', 'weekdays', OWNER, audit);
    expect(seen).toEqual(['reportDays:daily']);
  });

  it('rolls the row back when the audit cannot be written', async () => {
    const { db, store } = await setup();
    await expect(store.set('reportDays', 'daily', OWNER, () => {
      throw new Error('disk full');
    })).rejects.toThrowError('disk full');
    expect(rows(db)).toEqual([]);
    expect(store.get().reportDays).toBe('weekdays');
  });

  it('runs saves one at a time, in the order they came, and a failed one does not stop the next (S1.5)', async () => {
    const { db, store, audit, audits } = await setup();
    const first = store.set('reportDays', 'daily', OWNER, () => {
      throw new Error('disk full');
    });
    const second = store.set('reportDays', 'mon-sat', OWNER, audit);
    const third = store.set('reportDays', 'mon-sat', OWNER, audit); // already in force once the second is saved
    await expect(first).rejects.toThrowError('disk full');
    expect((await second).reportDays).toBe('mon-sat');
    expect((await third).reportDays).toBe('mon-sat');
    expect(audits).toHaveLength(1);
    expect(rows(db)).toMatchObject([{ k: 'reportDays', v: '"mon-sat"' }]);
  });

  it('a store opened later reads what an earlier one saved (S1.5)', async () => {
    const { db, store, audit } = await setup();
    await store.set('reportTime', '07:30', OWNER, audit);
    const again = await SettingsStore.open({ db, env: parseEnv({}), clock: manualClock(NOW) });
    expect(again.get()).toMatchObject({ reportTime: '07:30', source: { reportTime: 'dashboard' } });
  });

  it('records the time from the clock', async () => {
    const { db, store, clock, audit } = await setup();
    clock.set('2026-10-20T01:02:03.000Z');
    await store.set('reportDays', 'daily', OWNER, audit);
    expect(rows(db)).toMatchObject([{ updatedAt: '2026-10-20T01:02:03.000Z' }]);
  });
});
