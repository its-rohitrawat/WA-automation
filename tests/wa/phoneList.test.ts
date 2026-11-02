import { describe, expect, it } from 'vitest';
import { ControlError, type AuditEntry } from '../../src/control/errors.ts';
import type { Sql } from '../../src/store/db.ts';
import { getKv } from '../../src/store/kv.ts';
import { manualClock } from '../../src/util/clock.ts';
import { PHONES_KV_KEY, PhoneList } from '../../src/wa/phoneList.ts';
import { testDb } from '../helpers/db.ts';

// The workspace's reading phones (lane C, change 7): a small list in its own kv, phone 1 (today's phone) when nothing is
// stored. On both engines (kv sits under row security on Postgres).

const AT = '2026-11-02T10:00:00.000Z';
const OWNER = 'owner@example.com';

async function setup(o: { groupsOn?: (id: number) => number } = {}) {
  const db = await testDb();
  const clock = manualClock(AT);
  const audits: AuditEntry[] = [];
  const audit = async (_q: Sql, e: AuditEntry) => {
    audits.push(e);
  };
  const list = await PhoneList.open({ db, clock, groupsOn: o.groupsOn ?? (() => 0) });
  return { db, clock, audits, audit, list };
}

async function refusal(p: Promise<unknown>): Promise<ControlError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ControlError) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

describe('the phone list', () => {
  it('with nothing stored it is phone 1, "Phone 1", active: today’s phone, with nothing written', async () => {
    const { db, list } = await setup();
    expect(list.list()).toEqual([{ id: 1, label: 'Phone 1', state: 'active', addedAt: null }]);
    expect(await getKv(db, PHONES_KV_KEY)).toBeUndefined();
  });

  it('add takes the lowest free number from 2 to 5, is stored and audited, and a sixth is refused', async () => {
    const { db, clock, audits, audit, list } = await setup();
    expect(await list.add('Office phone', OWNER, audit)).toMatchObject({ id: 2, label: 'Office phone', state: 'active', addedAt: AT });
    for (const l of ['Three', 'Four', 'Five']) await list.add(l, OWNER, audit);
    expect(list.list().map((p) => p.id)).toEqual([1, 2, 3, 4, 5]);
    expect((await refusal(list.add('Six', OWNER, audit))).status).toBe(409);
    expect(audits.map((a) => a.event)).toEqual(['phone.added', 'phone.added', 'phone.added', 'phone.added']);
    expect(audits[0]).toMatchObject({ actor: OWNER, kind: 'connection', detail: 'Phone 2 added: Office phone' });
    // Read back from the store, as a restart would.
    const again = await PhoneList.open({ db, clock, groupsOn: () => 0 });
    expect(again.list()).toEqual(list.list());
  });

  it('a label is one line of 1 to 40 characters, unique in the workspace (any case)', async () => {
    const { audits, audit, list } = await setup();
    expect((await list.add('  Sales‮\n desk\u0007 ', OWNER, audit)).label).toBe('Sales desk');
    for (const bad of ['', '   ', 'x'.repeat(41), 'sales DESK', 'phone 1', 12, null]) {
      const e = await refusal(list.add(bad as string, OWNER, audit));
      expect(e.status, String(bad)).toBe(422);
    }
    expect(audits).toHaveLength(1);
  });

  it('a label is not a phone number (it goes unmasked into the audit), and invisible format characters are dropped', async () => {
    const { audits, audit, list } = await setup();
    for (const number of ['919812345678', '+91 98123 45678', '98-123-456', 'Rahul 9812345']) {
      const e = await refusal(list.add(number, OWNER, audit));
      expect([e.status, e.field], number).toEqual([422, 'label']);
      expect(e.message).toBe("A phone's name can't be a phone number. Use a name, for example \"Office phone\".");
    }
    await list.add('Office', OWNER, audit);
    await expect(refusal(list.rename(2, '9812345678', OWNER, audit))).resolves.toMatchObject({ status: 422 });
    // A zero-width or soft-hyphen look-alike is the same name: refused as a duplicate, and never stored with them.
    for (const lookAlike of ['Off​ice', 'Of­fice', '﻿Office', 'Off⁠ice']) {
      expect((await refusal(list.add(lookAlike, OWNER, audit))).message, JSON.stringify(lookAlike)).toBe('Another phone already has that name.');
    }
    expect((await list.add('Site‍ 2', OWNER, audit)).label).toBe('Site 2');
    expect(audits.map((a) => a.detail)).toEqual(['Phone 2 added: Office', 'Phone 3 added: Site 2']);
  });

  it('rename, unlink and activate change only that phone; an unknown phone is a 404', async () => {
    const { clock, audits, audit, list } = await setup();
    await list.add('Second', OWNER, audit);
    await list.rename(2, 'Front desk', OWNER, audit);
    clock.advance(60_000);
    await list.unlink(2, OWNER, audit);
    expect(list.get(2)).toMatchObject({ label: 'Front desk', state: 'unlinked', unlinkedAt: '2026-11-02T10:01:00.000Z' });
    expect(list.get(1)).toMatchObject({ state: 'active' });
    await list.unlink(2, OWNER, audit); // already unlinked: nothing new
    await list.activate(2);
    expect(list.get(2)).toEqual({ id: 2, label: 'Front desk', state: 'active', addedAt: AT });
    await list.unlink(1, OWNER, audit); // the main phone may be unlinked
    expect(list.get(1)?.state).toBe('unlinked');
    expect(audits.map((a) => a.event)).toEqual(['phone.added', 'phone.renamed', 'phone.unlinked', 'phone.unlinked']);
    for (const id of [3, 6, 0]) expect((await refusal(list.rename(id, 'X', OWNER, audit))).status, String(id)).toBe(404);
  });

  it('remove frees the number, but never phone 1 and never a phone that still has approved groups', async () => {
    let groups = 2;
    const { audit, list } = await setup({ groupsOn: (id) => (id === 2 ? groups : 0) });
    await list.add('Second', OWNER, audit);
    await list.add('Third', OWNER, audit);
    expect((await refusal(list.remove(1, OWNER, audit))).status).toBe(409);
    expect((await refusal(list.remove(2, OWNER, audit))).message).toMatch(/2 approved groups/);
    groups = 0;
    await list.remove(2, OWNER, audit);
    expect(list.list().map((p) => p.id)).toEqual([1, 3]);
    expect((await list.add('Again', OWNER, audit)).id).toBe(2); // the lowest free number again
  });

  it('a change whose audit row fails is not made, in the store or in memory', async () => {
    const { db, clock, list } = await setup();
    const failing = async () => {
      throw new Error('audit write failed');
    };
    await expect(list.add('Second', OWNER, failing)).rejects.toThrow('audit write failed');
    expect(list.list().map((p) => p.id)).toEqual([1]);
    expect((await PhoneList.open({ db, clock, groupsOn: () => 0 })).list().map((p) => p.id)).toEqual([1]);
  });

  it('two adds at the same moment get different numbers', async () => {
    const { audit, list } = await setup();
    const [a, b] = await Promise.all([list.add('A', OWNER, audit), list.add('B', OWNER, audit)]);
    expect(new Set([a.id, b.id])).toEqual(new Set([2, 3]));
  });
});
