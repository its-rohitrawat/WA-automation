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

function setup(o: { env?: Record<string, string>; linked?: boolean } = {}) {
  const db = seededDb();
  const env = parseEnv({ ...o.env });
  const clock = manualClock(NOW);
  let linked = o.linked ?? true;
  const store = new SettingsStore({ db, env, clock, spareLinked: () => linked });
  const audits: AuditEntry[] = [];
  const audit = (e: AuditEntry) => audits.push(e);
  return { db, store, clock, audits, audit, setLinked: (v: boolean) => (linked = v) };
}

const rows = (db: Db) => db.prepare('SELECT k, v, updated_at AS updatedAt, updated_by AS updatedBy FROM settings ORDER BY k').all();

function refusal(fn: () => unknown): ControlError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ControlError) return e;
    throw e;
  }
  throw new Error('expected a ControlError');
}

describe('SettingsStore.get', () => {
  it('takes the .env defaults when the dashboard changed nothing', () => {
    const { store } = setup({ env: { REPORT_ENABLED: 'true', REPORT_RECIPIENT: NUMBER, REPORT_DAYS: 'mon-sat' } });
    expect(store.get()).toEqual({
      reportEnabled: true, reportDays: 'mon-sat', reportRecipient: NUMBER, reportTime: '06:00',
      source: { reportEnabled: 'env', reportDays: 'env', reportRecipient: 'env', reportTime: 'env' },
    });
    expect(setup().store.get()).toMatchObject({ reportEnabled: false, reportDays: 'weekdays', reportRecipient: undefined });
  });

  it('a dashboard value wins over .env, and the source says so', () => {
    const { store, audit } = setup({ env: { REPORT_ENABLED: 'true', REPORT_RECIPIENT: NUMBER } });
    store.set('reportDays', 'daily', OWNER, audit);
    store.set('reportEnabled', false, OWNER, audit);
    expect(store.get()).toEqual({
      reportEnabled: false, reportDays: 'daily', reportRecipient: NUMBER, reportTime: '06:00',
      source: { reportEnabled: 'dashboard', reportDays: 'dashboard', reportRecipient: 'env', reportTime: 'env' },
    });
  });

  it('falls back to .env for a stored value that is not valid', () => {
    const { db, store } = setup({ env: { REPORT_DAYS: 'mon-sat' } });
    const put = db.prepare('INSERT INTO settings (k, v, updated_at, updated_by) VALUES (?, ?, ?, ?)');
    put.run('reportDays', '"sundays"', NOW, OWNER);
    put.run('reportEnabled', 'not json', NOW, OWNER);
    put.run('reportRecipient', '"12345"', NOW, OWNER);
    put.run('reportTime', '"7:30"', NOW, OWNER);
    expect(store.get()).toEqual({
      reportEnabled: false, reportDays: 'mon-sat', reportRecipient: undefined, reportTime: '06:00',
      source: { reportEnabled: 'env', reportDays: 'env', reportRecipient: 'env', reportTime: 'env' },
    });
  });

  it('builds the scheduler settings with the .env send time and deadline when the dashboard set no time', () => {
    const { store, audit } = setup({ env: { REPORT_TIME: '07:00', REPORT_DEADLINE: '11:00', REPORT_RECIPIENT: NUMBER } });
    store.set('reportEnabled', true, OWNER, audit);
    expect(store.reportSettings()).toEqual({ enabled: true, time: '07:00', deadline: '11:00', days: 'weekdays' });
  });
});

describe('SettingsStore.set', () => {
  it('writes the row with who and when, audits in plain words and returns the new settings', () => {
    const { db, store, audits, audit } = setup({ env: { REPORT_RECIPIENT: NUMBER } });
    expect(store.set('reportDays', 'mon-sat', OWNER, audit).reportDays).toBe('mon-sat');
    store.set('reportEnabled', true, OWNER, audit);
    store.set('reportEnabled', false, OWNER, audit);
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

  it('audits a number change masked to its last 4 digits, and never shows the full number', () => {
    const { db, store, audits, audit } = setup({ env: { REPORT_RECIPIENT: NUMBER } });
    store.set('reportRecipient', '+91 70123 49999', OWNER, audit);
    expect(store.get().reportRecipient).toBe(OTHER);
    expect(rows(db)).toMatchObject([{ k: 'reportRecipient', v: `"${OTHER}"` }]);
    expect(audits).toEqual([{ actor: OWNER, event: 'settings.reportRecipient', kind: 'config', detail: 'Morning briefing number changed to …9999' }]);
    expect(JSON.stringify(audits)).not.toContain('70123');
    expect(store.view()).toEqual({
      reportEnabled: false, reportDays: 'weekdays', recipientMasked: '…9999', sendAt: '06:00', deadline: '12:00', nextReport: null,
      source: { reportEnabled: 'env', reportDays: 'env', reportRecipient: 'dashboard', reportTime: 'env' },
    });
    expect(JSON.stringify(store.view())).not.toContain(OTHER);
  });

  it('validates every key, writing and auditing nothing on a refusal', () => {
    const { db, store, audits, audit } = setup({ env: { REPORT_RECIPIENT: NUMBER } });
    const bad: [string, unknown, number][] = [
      ['reportDays', 'sundays', 422], ['reportDays', 1, 422], ['reportEnabled', 'true', 422], ['reportEnabled', 1, 422],
      ['reportRecipient', '9812345678', 422], ['reportRecipient', '911234567890', 422], ['reportRecipient', 919812345678, 422],
      ['reportRecipient', '91 98123 4567x', 422], ['reportRecipient', '', 422], ['dailySpendCap', 50, 422], ['reportDeadline', '13:00', 422],
      ['reportTimeToday', '05:00', 422], ['reportTime', '25:00', 422], ['reportTime', '12:00', 422],
    ];
    for (const [key, value, status] of bad) {
      const e = refusal(() => store.set(key, value, OWNER, audit));
      expect(e.status, `${key}=${String(value)}`).toBe(status);
      expect(e.message).not.toContain('9812');
    }
    expect(refusal(() => store.set('reportRecipient', '9812345678', OWNER, audit)).field).toBe('reportRecipient');
    expect(rows(db)).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('refuses to switch on without a number, or before the spare phone is linked', () => {
    const noNumber = setup({ linked: true });
    expect(refusal(() => noNumber.store.set('reportEnabled', true, OWNER, noNumber.audit))).toMatchObject({ status: 409, field: 'reportEnabled' });
    const unlinked = setup({ env: { REPORT_RECIPIENT: NUMBER }, linked: false });
    expect(refusal(() => unlinked.store.set('reportEnabled', true, OWNER, unlinked.audit))).toMatchObject({
      status: 409, field: 'reportEnabled', message: 'Link the spare phone first',
    });
    // Switching off never needs either.
    expect(unlinked.store.set('reportEnabled', false, OWNER, unlinked.audit).reportEnabled).toBe(false);
    // A number set from the dashboard counts.
    noNumber.store.set('reportRecipient', NUMBER, OWNER, noNumber.audit);
    expect(noNumber.store.set('reportEnabled', true, OWNER, noNumber.audit).reportEnabled).toBe(true);
  });

  it('without a spare-phone check it never switches on', () => {
    const db = seededDb();
    const env = parseEnv({ REPORT_RECIPIENT: NUMBER });
    const store = new SettingsStore({ db, env, clock: manualClock(NOW) });
    expect(refusal(() => store.set('reportEnabled', true, OWNER, () => {})).status).toBe(409);
  });

  it('changes nothing, audits nothing and tells no one when the value is already in force', () => {
    const { db, store, audits, audit } = setup({ env: { REPORT_DAYS: 'mon-sat' } });
    let told = 0;
    store.onChange(() => told++);
    store.set('reportDays', 'mon-sat', OWNER, audit);
    expect(rows(db)).toEqual([]);
    expect(audits).toEqual([]);
    expect(told).toBe(0);
  });

  it('tells listeners after the change is saved; a failing listener changes nothing for the others', () => {
    const { store, audit } = setup({ env: { REPORT_RECIPIENT: NUMBER } });
    const seen: string[] = [];
    store.onChange(() => {
      throw new Error('listener bug');
    });
    const off = store.onChange((s, key) => seen.push(`${key}:${s.reportDays}`));
    store.set('reportDays', 'daily', OWNER, audit);
    off();
    store.set('reportDays', 'weekdays', OWNER, audit);
    expect(seen).toEqual(['reportDays:daily']);
  });

  it('rolls the row back when the audit cannot be written', () => {
    const { db, store } = setup();
    expect(() => store.set('reportDays', 'daily', OWNER, () => {
      throw new Error('disk full');
    })).toThrowError('disk full');
    expect(rows(db)).toEqual([]);
    expect(store.get().reportDays).toBe('weekdays');
  });

  it('records the time from the clock', () => {
    const { db, store, clock, audit } = setup();
    clock.set('2026-10-20T01:02:03.000Z');
    store.set('reportDays', 'daily', OWNER, audit);
    expect(rows(db)).toMatchObject([{ updatedAt: '2026-10-20T01:02:03.000Z' }]);
  });
});
