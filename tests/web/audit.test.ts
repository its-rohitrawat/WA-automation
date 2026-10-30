import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { manualClock } from '../../src/util/clock.ts';
import { AUDIT_DETAIL_MAX, AuditLog } from '../../src/web/audit.ts';
import type { AuditKind } from '../../src/web/audit.ts';

const T0 = '2026-10-27T10:00:00.000Z';
const DAY = 86_400_000;

function setup() {
  const db = openDb(':memory:');
  const clock = manualClock(T0);
  return { db, clock, audit: new AuditLog(db, clock) };
}

describe('AuditLog.record', () => {
  it('stores one row with the clock time and gives it back newest first', async () => {
    const { audit, clock } = setup();
    await audit.record({ actor: 'owner@example.com', event: 'Signed in', kind: 'auth', detail: 'Edge on Windows', requestId: 'a1b2c3d4e5f6' });
    clock.advance(60_000);
    await audit.record({ actor: 'agent', event: 'Tracker published', kind: 'ops', detail: '3 clients' });
    expect(await audit.list()).toEqual([
      { id: 2, at: '2026-10-27T10:01:00.000Z', actor: 'agent', event: 'Tracker published', kind: 'ops', detail: '3 clients' },
      { id: 1, at: T0, actor: 'owner@example.com', event: 'Signed in', kind: 'auth', detail: 'Edge on Windows', requestId: 'a1b2c3d4e5f6' },
    ]);
  });

  it('writes through a transaction handle, so the row rolls back with the change', async () => {
    const { audit, db } = setup();
    await expect(db.tx(async (q) => {
      await audit.record({ actor: 'agent', event: 'Kept?', kind: 'ops', detail: '' }, q);
      throw new Error('the change failed');
    })).rejects.toThrow('the change failed');
    expect(await audit.list()).toEqual([]);
    await db.tx(async (q) => audit.record({ actor: 'agent', event: 'Kept', kind: 'ops', detail: '' }, q));
    expect((await audit.list()).map((e) => e.event)).toEqual(['Kept']);
  });

  it('keeps detail to one line of at most 300 characters', async () => {
    const { audit } = setup();
    await audit.record({ actor: 'agent', event: 'Note', kind: 'ops', detail: `line one\r\nline\ttwo ${'y'.repeat(400)}` });
    const [e] = await audit.list();
    expect(AUDIT_DETAIL_MAX).toBe(300);
    expect(e!.detail.length).toBe(300);
    expect(e!.detail.startsWith('line one line two y')).toBe(true);
    expect(e!.detail).not.toMatch(/[\r\n\t]/);
  });

  it('removes Unicode line breaks and bidi controls from actor, event and detail', async () => {
    const { audit } = setup();
    await audit.record({ actor: 'agent\u2028x', event: 'Group\u2029renamed', kind: 'config', detail: 'Acme\u2028Ltd\u0085next\u202egnp.exe \u2066a\u2069 \u200fb' });
    const [e] = await audit.list();
    expect(e!.actor).toBe('agent x');
    expect(e!.event).toBe('Group renamed');
    expect(e!.detail).toBe('Acme Ltd next gnp.exe a b');
    expect(JSON.stringify(e)).not.toMatch(/[\u0085\u2028\u2029\u202a-\u202e\u2066-\u2069\u200e\u200f]/);
  });

  it('an empty detail is stored as an empty string', async () => {
    const { audit } = setup();
    await audit.record({ actor: 'agent', event: 'Restarted', kind: 'ops', detail: '' });
    expect((await audit.list())[0]!.detail).toBe('');
  });

  it('refuses an unknown kind, an empty actor or an empty event', async () => {
    const { audit } = setup();
    await expect(audit.record({ actor: 'agent', event: 'X', kind: 'nope' as AuditKind, detail: '' })).rejects.toThrow(/kind/);
    await expect(audit.record({ actor: ' ', event: 'X', kind: 'ops', detail: '' })).rejects.toThrow(/actor/);
    await expect(audit.record({ actor: 'agent', event: '', kind: 'ops', detail: '' })).rejects.toThrow(/event/);
    expect(await audit.list()).toEqual([]);
  });

  it('drops a request id that is not a plain short id', async () => {
    const { audit } = setup();
    await audit.record({ actor: 'agent', event: 'X', kind: 'ops', detail: '', requestId: 'Bearer abc.def ghi' });
    expect((await audit.list())[0]).not.toHaveProperty('requestId');
  });
});

describe('AuditLog.list', () => {
  async function filled() {
    const s = setup();
    const kinds: AuditKind[] = ['auth', 'config', 'connection', 'task', 'meeting', 'ops'];
    for (let i = 0; i < 130; i++) {
      await s.audit.record({ actor: 'agent', event: `E${i}`, kind: kinds[i % kinds.length]!, detail: '' });
      s.clock.advance(1000);
    }
    return s;
  }

  it('gives the newest 100 by default', async () => {
    const { audit } = await filled();
    const page = await audit.list();
    expect(page).toHaveLength(100);
    expect(page[0]!.event).toBe('E129');
    expect(page[99]!.event).toBe('E30');
  });

  it('pages with before (an entry id) and limit', async () => {
    const { audit } = await filled();
    const first = await audit.list({ limit: 10 });
    expect(first.map((e) => e.event)).toEqual(['E129', 'E128', 'E127', 'E126', 'E125', 'E124', 'E123', 'E122', 'E121', 'E120']);
    const second = await audit.list({ limit: 10, before: first.at(-1)!.id });
    expect(second[0]!.event).toBe('E119');
    expect(second).toHaveLength(10);
    const last = await audit.list({ limit: 100, before: 3 });
    expect(last.map((e) => e.event)).toEqual(['E1', 'E0']);
  });

  it('filters by kind', async () => {
    const { audit } = await filled();
    const auth = await audit.list({ kind: 'auth', limit: 500 });
    expect(auth).toHaveLength(22);
    expect(auth.every((e) => e.kind === 'auth')).toBe(true);
    expect(auth[0]!.event).toBe('E126');
    const page2 = await audit.list({ kind: 'auth', limit: 5, before: auth[4]!.id });
    expect(page2.map((e) => e.event)).toEqual(['E96', 'E90', 'E84', 'E78', 'E72']);
  });

  it('clamps the limit to 1-500', async () => {
    const { audit } = await filled();
    expect(await audit.list({ limit: 0 })).toHaveLength(1);
    expect(await audit.list({ limit: -5 })).toHaveLength(1);
    expect(await audit.list({ limit: 10_000 })).toHaveLength(130);
    expect(await audit.list({ limit: 2.7 })).toHaveLength(2);
  });
});

describe('AuditLog.purgeOlderThan', () => {
  it('removes entries older than 90 days by default and keeps the rest', async () => {
    const { audit, clock } = setup();
    await audit.record({ actor: 'agent', event: 'old', kind: 'ops', detail: '' });
    clock.advance(DAY);
    await audit.record({ actor: 'agent', event: 'edge', kind: 'ops', detail: '' });
    clock.advance(30 * DAY);
    await audit.record({ actor: 'agent', event: 'recent', kind: 'ops', detail: '' });
    clock.set(new Date(Date.parse(T0) + DAY + 90 * DAY).toISOString());
    expect(await audit.purgeOlderThan()).toBe(1);
    expect((await audit.list()).map((e) => e.event)).toEqual(['recent', 'edge']);
  });

  it('takes another number of days', async () => {
    const { audit, clock } = setup();
    await audit.record({ actor: 'agent', event: 'a', kind: 'ops', detail: '' });
    clock.advance(8 * DAY);
    await audit.record({ actor: 'agent', event: 'b', kind: 'ops', detail: '' });
    expect(await audit.purgeOlderThan(7)).toBe(1);
    expect((await audit.list()).map((e) => e.event)).toEqual(['b']);
  });
});
