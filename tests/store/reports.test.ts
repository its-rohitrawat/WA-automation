import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../../src/store/db.ts';
import { MIGRATIONS } from '../../src/store/migrations.ts';
import {
  claimReport, closeOldRetries, finishReport, markInterruptedReports, recentReports, reportFor, retryReport, skipReport,
} from '../../src/store/reports.ts';

const DAY = '2026-10-23';
const T0 = '2026-10-23T00:30:00.000Z'; // 06:00 IST
const T1 = '2026-10-23T00:32:00.000Z';
const T2 = '2026-10-23T00:33:00.000Z';

describe('migration v6', () => {
  it('upgrades a version-5 database and keeps its data', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
    for (const m of MIGRATIONS.filter((x) => x.version <= 5)) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version);
    }
    db.prepare("INSERT INTO clients (code, name, group_id, phases) VALUES ('SHA', 'Sharma', '1@g.us', '[]')").run();
    migrate(db);
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(9); // the latest migration
    expect((db.prepare('SELECT COUNT(*) AS n FROM clients').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM reports').get() as { n: number }).n).toBe(0);
  });

  it('adds version 6 as a new, additive migration and leaves versions 1 to 5 unchanged', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const text = MIGRATIONS.filter((m) => m.version <= 5).map((m) => `${m.version}\n${m.sql}`).join('\n---\n');
    expect(createHash('sha256').update(text).digest('hex')).toBe('53081fb02c22d829badad1e5b7f5d7c0855a67b631a353244b1e5828f81c02df');
    expect(MIGRATIONS[5]!.sql).toMatch(/^\s*CREATE TABLE reports \(/);
    expect(MIGRATIONS[5]!.sql).not.toMatch(/\b(DROP|ALTER|DELETE|UPDATE|INSERT)\b/i);
  });

  it('rejects a status outside the known list', () => {
    const db = openDb(':memory:');
    const insert = db.prepare("INSERT INTO reports (date, status, created_at, updated_at) VALUES (@date, @status, @at, @at)");
    expect(() => insert.run({ date: DAY, status: 'bogus', at: T0 })).toThrow(/CHECK constraint failed/);
    expect(() => insert.run({ date: DAY, status: 'send', at: T0 })).toThrow(/CHECK constraint failed/);
    expect(reportFor(db, DAY)).toBeUndefined();
    for (const [i, status] of ['sending', 'sent', 'retry', 'unknown', 'skipped'].entries()) {
      expect(() => insert.run({ date: `2026-10-0${i + 1}`, status, at: T0 })).not.toThrow();
    }
  });
});

describe('reports store', () => {
  it('claims a date once, before anything is sent', () => {
    const db = openDb(':memory:');
    expect(reportFor(db, DAY)).toBeUndefined();
    expect(claimReport(db, DAY, T0)).toBe(true);
    expect(claimReport(db, DAY, T1)).toBe(false);
    expect(reportFor(db, DAY)).toEqual({
      date: DAY, status: 'sending', detail: null, attempts: 1, nextAttemptAt: null, forced: false, createdAt: T0, updatedAt: T0,
    });
  });

  it('takes a retry row again only once its wait is over', () => {
    const db = openDb(':memory:');
    claimReport(db, DAY, T0);
    expect(retryReport(db, DAY, 'connect_timeout', T1, T0)).toBe(true);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'retry', detail: 'connect_timeout', nextAttemptAt: T1 });
    expect(claimReport(db, DAY, T0)).toBe(false);
    expect(claimReport(db, DAY, T1)).toBe(true);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'sending', attempts: 2, nextAttemptAt: null, updatedAt: T1 });
  });

  it('finishes only a row that is sending, and a sent row is never claimed again, even forced', () => {
    const db = openDb(':memory:');
    expect(finishReport(db, DAY, 'sent', 'msg-1', T0)).toBe(false);
    claimReport(db, DAY, T0);
    expect(finishReport(db, DAY, 'sent', 'msg-1,msg-2', T1)).toBe(true);
    expect(finishReport(db, DAY, 'unknown', 'timeout', T2)).toBe(false);
    expect(retryReport(db, DAY, 'closed', T2, T2)).toBe(false);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'sent', detail: 'msg-1,msg-2', updatedAt: T1 });
    expect(claimReport(db, DAY, T2)).toBe(false);
    expect(claimReport(db, DAY, T2, { force: true })).toBe(false);
  });

  it('a normal claim never takes an unknown, skipped or sent row, at any later time', () => {
    const db = openDb(':memory:');
    claimReport(db, '2026-10-20', T0);
    finishReport(db, '2026-10-20', 'unknown', 'timeout', T0);
    skipReport(db, '2026-10-21', 'not_running', T0);
    claimReport(db, '2026-10-22', T0);
    finishReport(db, '2026-10-22', 'sent', 'msg-1', T0);
    const before = ['2026-10-20', '2026-10-21', '2026-10-22'].map((date) => reportFor(db, date));
    for (const date of ['2026-10-20', '2026-10-21', '2026-10-22']) {
      for (const at of [T1, T2, '2026-10-24T06:00:00.000Z']) expect(claimReport(db, date, at)).toBe(false);
    }
    expect(['2026-10-20', '2026-10-21', '2026-10-22'].map((date) => reportFor(db, date))).toEqual(before);
    expect(reportFor(db, '2026-10-20')).toMatchObject({ status: 'unknown', detail: 'timeout', attempts: 1, forced: false });
    expect(reportFor(db, '2026-10-21')).toMatchObject({ status: 'skipped', detail: 'not_running', attempts: 0, forced: false });
    expect(reportFor(db, '2026-10-22')).toMatchObject({ status: 'sent', detail: 'msg-1', attempts: 1, forced: false });
  });

  it('a forced claim takes unknown, skipped and waiting retry rows, but never a row that is sending', () => {
    const db = openDb(':memory:');
    claimReport(db, '2026-10-20', T0);
    finishReport(db, '2026-10-20', 'unknown', 'timeout', T0);
    skipReport(db, '2026-10-21', 'not_running', T0);
    claimReport(db, '2026-10-22', T0);
    retryReport(db, '2026-10-22', 'closed', T2, T0);
    claimReport(db, DAY, T0);
    for (const date of ['2026-10-20', '2026-10-21', '2026-10-22']) {
      expect(claimReport(db, date, T1, { force: true })).toBe(true);
      expect(reportFor(db, date)).toMatchObject({ status: 'sending', forced: true, nextAttemptAt: null });
    }
    expect(claimReport(db, DAY, T1, { force: true })).toBe(false);
  });

  it('sets forced on a fresh forced claim, and a later normal claim clears it', () => {
    const db = openDb(':memory:');
    expect(claimReport(db, DAY, T0, { force: true })).toBe(true);
    expect(reportFor(db, DAY)).toEqual({
      date: DAY, status: 'sending', detail: null, attempts: 1, nextAttemptAt: null, forced: true, createdAt: T0, updatedAt: T0,
    });
    expect(retryReport(db, DAY, 'closed', T1, T0)).toBe(true);
    expect(claimReport(db, DAY, T1)).toBe(true);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'sending', attempts: 2, forced: false });
  });

  it('retryReport changes only a row that is sending: never unknown, skipped, retry or a missing date', () => {
    const db = openDb(':memory:');
    claimReport(db, '2026-10-19', T0);
    finishReport(db, '2026-10-19', 'unknown', 'timeout', T0);
    claimReport(db, '2026-10-20', T0);
    markInterruptedReports(db, T0);
    skipReport(db, '2026-10-21', 'not_running', T0);
    claimReport(db, '2026-10-22', T0);
    retryReport(db, '2026-10-22', 'connect_timeout', '2026-10-23T05:00:00.000Z', T0);
    const dates = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22'];
    const before = dates.map((date) => reportFor(db, date));
    for (const date of dates) expect(retryReport(db, date, 'closed', T1, T1)).toBe(false);
    expect(retryReport(db, DAY, 'closed', T1, T1)).toBe(false);
    expect(dates.map((date) => reportFor(db, date))).toEqual(before);
    expect(reportFor(db, DAY)).toBeUndefined();
    expect(reportFor(db, '2026-10-19')).toMatchObject({ status: 'unknown', nextAttemptAt: null });
    expect(reportFor(db, '2026-10-20')).toMatchObject({ status: 'unknown', detail: 'interrupted', nextAttemptAt: null });
    expect(reportFor(db, '2026-10-21')).toMatchObject({ status: 'skipped', nextAttemptAt: null });
    expect(reportFor(db, '2026-10-22')).toMatchObject({ status: 'retry', detail: 'connect_timeout', nextAttemptAt: '2026-10-23T05:00:00.000Z' });
    for (const date of ['2026-10-19', '2026-10-20', '2026-10-21']) {
      for (const at of [T2, '2026-10-24T06:00:00.000Z']) expect(claimReport(db, date, at)).toBe(false);
    }
    expect(dates.slice(0, 3).map((date) => reportFor(db, date))).toEqual(before.slice(0, 3));
  });

  it('finishReport changes only a row that is sending: never unknown, interrupted, retry or skipped', () => {
    const db = openDb(':memory:');
    claimReport(db, '2026-10-19', T0);
    finishReport(db, '2026-10-19', 'unknown', 'timeout', T0);
    claimReport(db, '2026-10-20', T0);
    markInterruptedReports(db, T0);
    skipReport(db, '2026-10-21', 'not_running', T0);
    claimReport(db, '2026-10-22', T0);
    retryReport(db, '2026-10-22', 'connect_timeout', T2, T0);
    const dates = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22'];
    const before = dates.map((date) => reportFor(db, date));
    for (const date of dates) {
      expect(finishReport(db, date, 'sent', 'msg-1', T1)).toBe(false);
      expect(finishReport(db, date, 'unknown', 'timeout', T1)).toBe(false);
    }
    expect(dates.map((date) => reportFor(db, date))).toEqual(before);
    expect(dates.map((date) => reportFor(db, date)!.status)).toEqual(['unknown', 'unknown', 'skipped', 'retry']);
  });

  it('never skips a sent row or a row that is still sending', () => {
    const db = openDb(':memory:');
    claimReport(db, '2026-10-21', T0);
    finishReport(db, '2026-10-21', 'sent', 'msg-1', T0);
    claimReport(db, '2026-10-22', T0);
    const sent = reportFor(db, '2026-10-21');
    const sending = reportFor(db, '2026-10-22');
    expect(skipReport(db, '2026-10-21', 'deadline', T2)).toBe(false);
    expect(skipReport(db, '2026-10-22', 'deadline', T2)).toBe(false);
    expect(reportFor(db, '2026-10-21')).toEqual(sent);
    expect(reportFor(db, '2026-10-22')).toEqual(sending);
    expect(reportFor(db, '2026-10-21')).toMatchObject({ status: 'sent', detail: 'msg-1' });
    expect(reportFor(db, '2026-10-22')).toMatchObject({ status: 'sending', detail: null });
    expect(finishReport(db, '2026-10-22', 'sent', 'msg-2', T2)).toBe(true);
  });

  it('skips a day with no row or a retry row, and leaves unknown and skipped rows alone', () => {
    const db = openDb(':memory:');
    expect(skipReport(db, '2026-10-20', 'not_running', T0)).toBe(true);
    expect(reportFor(db, '2026-10-20')).toMatchObject({ status: 'skipped', detail: 'not_running', attempts: 0 });
    claimReport(db, '2026-10-21', T0);
    retryReport(db, '2026-10-21', 'connect_timeout', T1, T0);
    expect(skipReport(db, '2026-10-21', 'connect_timeout', T2)).toBe(true);
    expect(reportFor(db, '2026-10-21')).toMatchObject({ status: 'skipped', detail: 'connect_timeout', nextAttemptAt: null });
    claimReport(db, '2026-10-22', T0);
    finishReport(db, '2026-10-22', 'unknown', 'timeout', T0);
    expect(skipReport(db, '2026-10-22', 'not_running', T2)).toBe(false);
    expect(reportFor(db, '2026-10-22')!.status).toBe('unknown');
    expect(skipReport(db, '2026-10-20', 'again', T2)).toBe(false);
    expect(reportFor(db, '2026-10-20')!.detail).toBe('not_running');
  });

  it('turns rows left sending into unknown at start, and leaves every other status alone', () => {
    const db = openDb(':memory:');
    claimReport(db, '2026-10-22', T0);
    claimReport(db, DAY, T0);
    finishReport(db, DAY, 'sent', 'msg-1', T0);
    claimReport(db, '2026-10-19', T0);
    retryReport(db, '2026-10-19', 'connect_timeout', T2, T0);
    skipReport(db, '2026-10-20', 'not_running', T0);
    claimReport(db, '2026-10-21', T0);
    finishReport(db, '2026-10-21', 'unknown', 'timeout', T0);
    const others = ['2026-10-19', '2026-10-20', '2026-10-21', DAY].map((date) => reportFor(db, date));
    expect(markInterruptedReports(db, T1)).toBe(1);
    expect(reportFor(db, '2026-10-22')).toMatchObject({ status: 'unknown', detail: 'interrupted', updatedAt: T1 });
    expect(['2026-10-19', '2026-10-20', '2026-10-21', DAY].map((date) => reportFor(db, date))).toEqual(others);
    expect(reportFor(db, '2026-10-19')).toMatchObject({ status: 'retry', detail: 'connect_timeout', updatedAt: T0 });
    expect(reportFor(db, '2026-10-20')).toMatchObject({ status: 'skipped', detail: 'not_running', updatedAt: T0 });
    expect(reportFor(db, '2026-10-21')).toMatchObject({ status: 'unknown', detail: 'timeout', updatedAt: T0 });
    expect(reportFor(db, DAY)).toMatchObject({ status: 'sent', detail: 'msg-1', updatedAt: T0 });
  });

  it('closes retry rows of earlier dates and keeps their reason, and leaves other earlier rows alone', () => {
    const db = openDb(':memory:');
    for (const date of ['2026-10-22', DAY]) {
      claimReport(db, date, T0);
      retryReport(db, date, 'connect_timeout', T1, T0);
    }
    claimReport(db, '2026-10-18', T0);
    claimReport(db, '2026-10-19', T0);
    finishReport(db, '2026-10-19', 'unknown', 'timeout', T0);
    claimReport(db, '2026-10-20', T0);
    finishReport(db, '2026-10-20', 'sent', 'msg-1', T0);
    skipReport(db, '2026-10-21', 'not_running', T0);
    const earlier = ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21'];
    const before = earlier.map((date) => reportFor(db, date));
    expect(closeOldRetries(db, DAY, T2)).toBe(1);
    expect(reportFor(db, '2026-10-22')).toMatchObject({ status: 'skipped', detail: 'connect_timeout', nextAttemptAt: null });
    expect(reportFor(db, DAY)!.status).toBe('retry');
    expect(earlier.map((date) => reportFor(db, date))).toEqual(before);
    expect(earlier.map((date) => reportFor(db, date)!.status)).toEqual(['sending', 'unknown', 'sent', 'skipped']);
  });

  it('lists recent reports newest first', () => {
    const db = openDb(':memory:');
    for (const date of ['2026-10-21', DAY, '2026-10-22']) skipReport(db, date, 'not_running', T0);
    expect(recentReports(db, 2).map((r) => r.date)).toEqual([DAY, '2026-10-22']);
  });
});
