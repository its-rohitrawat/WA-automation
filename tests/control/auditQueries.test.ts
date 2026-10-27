import { describe, expect, it } from 'vitest';
import { listAudit, maskEmail, parseAuditParams, purgeAuditOlderThan } from '../../src/control/auditQueries.ts';
import { ControlError } from '../../src/control/errors.ts';
import type { Db } from '../../src/store/db.ts';
import { seededDb } from '../helpers/db.ts';

const OWNERS = ['owner@example.com', 'second.owner@example.com'];
const isOwner = (email: string) => OWNERS.includes(email.toLowerCase());

function row(db: Db, at: string, o: { actor?: string; event?: string; kind?: string; detail?: string } = {}) {
  db.prepare('INSERT INTO audit_log (at, actor, event, kind, detail, request_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(at, o.actor ?? 'owner@example.com', o.event ?? 'task.done', o.kind ?? 'task', o.detail ?? 'Task SHA-001 marked done', 'req-1');
}

const params = (o: Record<string, string> = {}) => parseAuditParams(new URLSearchParams(o));
const t = (hm: string, day = '19') => `2026-10-${day}T${hm}:00.000Z`;

describe('parseAuditParams', () => {
  it('defaults, caps and refuses bad values', () => {
    expect(params()).toEqual({ kind: 'all', limit: 50 });
    expect(params({ limit: '1000' }).limit).toBe(200);
    expect(params({ kind: 'auth', before: `${t('05:00')}|7` })).toEqual({ kind: 'auth', limit: 50, before: { at: t('05:00'), id: 7 } });
    for (const [field, value] of [['kind', 'chat'], ['limit', '0'], ['before', 'x'], ['before', `${t('05:00')}|0`], ['before', '2026-10-19']] as const) {
      expect(() => params({ [field]: value }), `${field}=${value}`).toThrowError(ControlError);
    }
  });
});

describe('maskEmail', () => {
  it('keeps the first two letters and the domain', () => {
    expect(maskEmail('someone@gmail.com')).toBe('so••••@gmail.com');
    expect(maskEmail('a@x.org')).toBe('a••••@x.org');
    expect(maskEmail('not an email')).toBe('••••');
  });
});

describe('listAudit', () => {
  it('lists newest first, without the request id, showing owners in full and masking anyone else', () => {
    const db = seededDb();
    row(db, t('05:00'));
    row(db, t('06:00'), { actor: 'stranger@gmail.com', event: 'auth.refused', kind: 'auth', detail: "This account can't open the dashboard" });
    row(db, t('07:00'), { actor: 'agent', event: 'tracker.published', kind: 'ops', detail: 'Tracker.xlsx uploaded to Drive' });
    row(db, t('08:00'), { actor: 'Second.Owner@example.com', event: 'auth.signin', kind: 'auth', detail: 'Signed in' });
    const r = listAudit(db, params(), isOwner);
    expect(r.rows).toEqual([
      { id: 4, at: t('08:00'), actor: 'Second.Owner@example.com', event: 'auth.signin', kind: 'auth', detail: 'Signed in' },
      { id: 3, at: t('07:00'), actor: 'agent', event: 'tracker.published', kind: 'ops', detail: 'Tracker.xlsx uploaded to Drive' },
      { id: 2, at: t('06:00'), actor: 'st••••@gmail.com', event: 'auth.refused', kind: 'auth', detail: "This account can't open the dashboard" },
      { id: 1, at: t('05:00'), actor: 'owner@example.com', event: 'task.done', kind: 'task', detail: 'Task SHA-001 marked done' },
    ]);
    expect(JSON.stringify(r)).not.toContain('stranger');
    expect(JSON.stringify(r)).not.toContain('req-1');
  });

  it('filters by kind', () => {
    const db = seededDb();
    row(db, t('05:00'));
    row(db, t('06:00'), { kind: 'auth', event: 'auth.signin' });
    expect(listAudit(db, params({ kind: 'auth' }), isOwner).rows.map((r) => r.id)).toEqual([2]);
    expect(listAudit(db, params({ kind: 'task' }), isOwner).rows.map((r) => r.id)).toEqual([1]);
  });

  it('pages with before, keeping rows that share a time', () => {
    const db = seededDb();
    for (let i = 0; i < 3; i++) row(db, t('05:00'));
    row(db, t('04:00'));
    const first = listAudit(db, params({ limit: '2' }), isOwner);
    expect(first.rows.map((r) => r.id)).toEqual([3, 2]);
    expect(first.next).toBe(`${t('05:00')}|2`);
    const second = listAudit(db, params({ limit: '2', before: first.next! }), isOwner);
    expect(second.rows.map((r) => r.id)).toEqual([1, 4]);
    expect(listAudit(db, params({ limit: '2', before: second.next! }), isOwner)).toEqual({ rows: [], next: null });
  });
});

describe('purgeAuditOlderThan', () => {
  it('removes only rows older than the given days, and says how many', () => {
    const db = seededDb();
    const now = new Date('2026-10-19T00:00:00.000Z');
    row(db, '2026-07-20T23:59:59.000Z'); // 90 days and a second
    row(db, '2026-07-21T00:00:00.000Z'); // exactly 90 days: kept
    row(db, '2026-10-18T00:00:00.000Z');
    expect(purgeAuditOlderThan(db, 90, now)).toBe(1);
    expect(db.prepare('SELECT at FROM audit_log ORDER BY at').all()).toEqual([{ at: '2026-07-21T00:00:00.000Z' }, { at: '2026-10-18T00:00:00.000Z' }]);
    expect(purgeAuditOlderThan(db, 90, now)).toBe(0);
  });

  it('refuses a retention shorter than a day', () => {
    expect(() => purgeAuditOlderThan(seededDb(), 0, new Date())).toThrowError();
  });
});

describe('audit review fixes', () => {
  it('a page shorter than the limit has no next', () => {
    const db = seededDb();
    row(db, t('05:00'));
    expect(listAudit(db, params({ limit: '2' }), isOwner).next).toBeNull();
  });

  it('masks at the last @', () => {
    expect(maskEmail('a@b@x.org')).toBe('a@••••@x.org');
  });
});
