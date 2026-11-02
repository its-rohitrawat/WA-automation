import { describe, expect, it } from 'vitest';
import { listAudit, maskEmail, parseAuditParams, purgeAuditOlderThan } from '../../src/control/auditQueries.ts';
import { ControlError } from '../../src/control/errors.ts';
import type { Db } from '../../src/store/db.ts';
import { rows, seededDb } from '../helpers/db.ts';

const OWNERS = ['owner@example.com', 'second.owner@example.com'];
const isOwner = (email: string) => OWNERS.includes(email.toLowerCase());

async function row(db: Db, at: string, o: { actor?: string; event?: string; kind?: string; detail?: string } = {}): Promise<number> {
  return (await db.get<{ id: number }>('INSERT INTO audit_log (at, actor, event, kind, detail, request_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
    [at, o.actor ?? 'owner@example.com', o.event ?? 'task.done', o.kind ?? 'task', o.detail ?? 'Task SHA-001 marked done', 'req-1']))!.id;
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
  it('lists newest first, without the request id, showing owners in full and masking anyone else', async () => {
    const db = await seededDb();
    const id1 = await row(db, t('05:00'));
    const id2 = await row(db, t('06:00'), { actor: 'stranger@gmail.com', event: 'auth.refused', kind: 'auth', detail: "This account can't open the dashboard" });
    const id3 = await row(db, t('07:00'), { actor: 'agent', event: 'tracker.published', kind: 'ops', detail: 'Tracker.xlsx uploaded to Drive' });
    const id4 = await row(db, t('08:00'), { actor: 'Second.Owner@example.com', event: 'auth.signin', kind: 'auth', detail: 'Signed in' });
    const r = await listAudit(db, params(), isOwner);
    expect(r.rows).toEqual([
      { id: id4, at: t('08:00'), actor: 'Second.Owner@example.com', event: 'auth.signin', kind: 'auth', detail: 'Signed in' },
      { id: id3, at: t('07:00'), actor: 'agent', event: 'tracker.published', kind: 'ops', detail: 'Tracker.xlsx uploaded to Drive' },
      { id: id2, at: t('06:00'), actor: 'st••••@gmail.com', event: 'auth.refused', kind: 'auth', detail: "This account can't open the dashboard" },
      { id: id1, at: t('05:00'), actor: 'owner@example.com', event: 'task.done', kind: 'task', detail: 'Task SHA-001 marked done' },
    ]);
    expect(JSON.stringify(r)).not.toContain('stranger');
    expect(JSON.stringify(r)).not.toContain('req-1');
  });

  it('filters by kind', async () => {
    const db = await seededDb();
    const task = await row(db, t('05:00'));
    const auth = await row(db, t('06:00'), { kind: 'auth', event: 'auth.signin' });
    expect((await listAudit(db, params({ kind: 'auth' }), isOwner)).rows.map((r) => r.id)).toEqual([auth]);
    expect((await listAudit(db, params({ kind: 'task' }), isOwner)).rows.map((r) => r.id)).toEqual([task]);
  });

  it('pages with before, keeping rows that share a time', async () => {
    const db = await seededDb();
    const at5: number[] = [];
    for (let i = 0; i < 3; i++) at5.push(await row(db, t('05:00')));
    const at4 = await row(db, t('04:00'));
    const first = await listAudit(db, params({ limit: '2' }), isOwner);
    expect(first.rows.map((r) => r.id)).toEqual([at5[2], at5[1]]);
    expect(first.next).toBe(`${t('05:00')}|${at5[1]}`);
    const second = await listAudit(db, params({ limit: '2', before: first.next! }), isOwner);
    expect(second.rows.map((r) => r.id)).toEqual([at5[0], at4]);
    expect(await listAudit(db, params({ limit: '2', before: second.next! }), isOwner)).toEqual({ rows: [], next: null });
  });
});

describe('purgeAuditOlderThan', () => {
  it('removes only rows older than the given days, and says how many', async () => {
    const db = await seededDb();
    const now = new Date('2026-10-19T00:00:00.000Z');
    await row(db, '2026-07-20T23:59:59.000Z'); // 90 days and a second
    await row(db, '2026-07-21T00:00:00.000Z'); // exactly 90 days: kept
    await row(db, '2026-10-18T00:00:00.000Z');
    expect(await purgeAuditOlderThan(db, 90, now)).toBe(1);
    expect(await rows(db, 'SELECT at FROM audit_log ORDER BY at')).toEqual([{ at: '2026-07-21T00:00:00.000Z' }, { at: '2026-10-18T00:00:00.000Z' }]);
    expect(await purgeAuditOlderThan(db, 90, now)).toBe(0);
  });

  it('refuses a retention shorter than a day', async () => {
    const db = await seededDb();
    await expect(purgeAuditOlderThan(db, 0, new Date())).rejects.toThrowError();
  });
});

describe('audit review fixes', () => {
  it('a page shorter than the limit has no next', async () => {
    const db = await seededDb();
    await row(db, t('05:00'));
    expect((await listAudit(db, params({ limit: '2' }), isOwner)).next).toBeNull();
  });

  it('masks at the last @', () => {
    expect(maskEmail('a@b@x.org')).toBe('a@••••@x.org');
  });
});
