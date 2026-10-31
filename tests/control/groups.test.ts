import { describe, expect, it } from 'vitest';
import type { ClientConfig } from '../../src/config/groups.ts';
import { GroupDirectory, groupsOverview, searchKey, type GroupSource } from '../../src/control/groups.ts';
import { syncClients } from '../../src/store/clients.ts';
import { createTask } from '../../src/store/tasks.ts';
import { manualClock } from '../../src/util/clock.ts';
import type { GatewayState } from '../../src/wa/gateway.ts';
import { MEHTA, NOW, seeded, seededDb, SHARMA } from '../helpers/db.ts';

const T0 = '2026-10-27T08:00:00.000Z';

/** A gateway stand-in: state and groups are set by the test; every listGroups call is counted. */
class FakeSource implements GroupSource {
  state: GatewayState = 'open';
  groups: { id: string; subject: string }[] = [];
  calls = 0;
  gate: Promise<void> | undefined;
  fail: Error | undefined;
  status() {
    return { state: this.state };
  }
  async listGroups() {
    this.calls++;
    if (this.gate) await this.gate;
    if (this.fail) throw this.fail;
    return this.groups.map((g) => ({ ...g }));
  }
}

/** Fake group ids, never equal to SHARMA's or MEHTA's. */
const gid = (n: number) => `12036377${String(n).padStart(10, '0')}@g.us`;

describe('GroupDirectory', () => {
  it('caches for the TTL, refreshes after it, and on demand', async () => {
    const src = new FakeSource();
    src.groups = [{ id: gid(1), subject: 'A' }];
    const clock = manualClock(T0);
    const dir = new GroupDirectory({ gateway: src, clock, ttlMs: 600_000 });
    const first = await dir.list();
    expect(first).toMatchObject({ stale: false, reason: null, fetchedAt: T0, groups: [{ id: gid(1), subject: 'A' }] });
    clock.advance(599_999);
    await dir.list();
    expect(src.calls).toBe(1);
    clock.advance(1);
    src.groups.push({ id: gid(2), subject: 'B' });
    expect((await dir.list()).groups).toHaveLength(2);
    expect(src.calls).toBe(2);
    await dir.list({ refresh: true });
    expect(src.calls).toBe(3);
  });

  it('cachedGroups gives the last list without asking WhatsApp (null before the first list), as a copy', async () => {
    const src = new FakeSource();
    src.groups = [{ id: gid(1), subject: 'A' }];
    const dir = new GroupDirectory({ gateway: src, clock: manualClock(T0) });
    expect(dir.cachedGroups()).toBeNull();
    expect(src.calls).toBe(0);
    await dir.list();
    const cached = dir.cachedGroups()!;
    expect(cached).toEqual([{ id: gid(1), subject: 'A' }]);
    cached[0]!.subject = 'changed';
    expect(dir.cachedGroups()).toEqual([{ id: gid(1), subject: 'A' }]);
    src.state = 'closed';
    expect(dir.cachedGroups()).toEqual([{ id: gid(1), subject: 'A' }]);
    expect(src.calls).toBe(1);
  });

  it('cachedListing gives the last list with its time and state, never asking WhatsApp', async () => {
    const src = new FakeSource();
    src.groups = [{ id: gid(1), subject: 'A' }];
    const clock = manualClock(T0);
    const dir = new GroupDirectory({ gateway: src, clock });
    expect(dir.cachedListing()).toEqual({ groups: [], stale: true, reason: null, fetchedAt: null });
    src.state = 'closed';
    expect(dir.cachedListing()).toEqual({ groups: [], stale: true, reason: 'whatsapp_not_connected', fetchedAt: null });
    src.state = 'open';
    await dir.list();
    expect(dir.cachedListing()).toEqual({ groups: [{ id: gid(1), subject: 'A' }], stale: false, reason: null, fetchedAt: T0 });
    // The last list failed: still stale with its reason.
    clock.advance(60_000);
    src.fail = new Error('boom');
    await dir.list({ refresh: true });
    expect(dir.cachedListing()).toMatchObject({ stale: true, reason: 'list_failed', fetchedAt: T0 });
    // WhatsApp closed: stale, whatever the last list said.
    src.fail = undefined;
    await dir.list({ refresh: true });
    src.state = 'closed';
    expect(dir.cachedListing()).toMatchObject({ stale: true, reason: 'whatsapp_not_connected', fetchedAt: '2026-10-27T08:01:00.000Z' });
    // Open again after a closed answer: stale until a fresh list, with no reason left to show.
    await dir.list();
    src.state = 'open';
    expect(dir.cachedListing()).toMatchObject({ stale: true, reason: null });
    const listing = dir.cachedListing();
    listing.groups[0]!.subject = 'changed';
    expect(dir.cachedListing().groups[0]!.subject).toBe('A');
    expect(src.calls).toBe(3);
  });

  it('concurrent calls share one in-flight request', async () => {
    const src = new FakeSource();
    let open!: () => void;
    src.gate = new Promise((r) => (open = r));
    const dir = new GroupDirectory({ gateway: src, clock: manualClock(T0) });
    const a = dir.list();
    const b = dir.list({ refresh: true });
    open();
    expect((await a).fetchedAt).toBe((await b).fetchedAt);
    expect(src.calls).toBe(1);
  });

  it('when WhatsApp is not open: the last cache, marked stale; no cache gives an empty stale list', async () => {
    const src = new FakeSource();
    src.state = 'closed';
    const clock = manualClock(T0);
    const dir = new GroupDirectory({ gateway: src, clock });
    expect(await dir.list()).toEqual({ groups: [], stale: true, reason: 'whatsapp_not_connected', fetchedAt: null });
    expect(src.calls).toBe(0);
    src.state = 'open';
    src.groups = [{ id: gid(1), subject: 'A' }];
    await dir.list();
    src.state = 'logged_out';
    clock.advance(3_600_000);
    expect(await dir.list({ refresh: true })).toEqual({ groups: [{ id: gid(1), subject: 'A' }], stale: true, reason: 'whatsapp_not_connected', fetchedAt: T0 });
    expect(src.calls).toBe(1);
  });

  it('a fresh cache is stale as soon as WhatsApp is not open', async () => {
    const src = new FakeSource();
    src.groups = [{ id: gid(1), subject: 'A' }];
    const dir = new GroupDirectory({ gateway: src, clock: manualClock(T0) });
    await dir.list();
    src.state = 'closed';
    expect(await dir.list()).toMatchObject({ stale: true, reason: 'whatsapp_not_connected', fetchedAt: T0, groups: [{ id: gid(1) }] });
  });

  it('a failing listGroups keeps the last cache and its time, marked stale, and the next call tries again', async () => {
    const src = new FakeSource();
    src.groups = [{ id: gid(1), subject: 'A' }];
    const clock = manualClock(T0);
    const dir = new GroupDirectory({ gateway: src, clock });
    await dir.list();
    clock.advance(60_000);
    src.fail = new Error('boom');
    expect(await dir.list({ refresh: true })).toEqual({ stale: true, reason: 'list_failed', fetchedAt: T0, groups: [{ id: gid(1), subject: 'A' }] });
    src.fail = undefined;
    expect(await dir.list({ refresh: true })).toMatchObject({ stale: false, reason: null, fetchedAt: '2026-10-27T08:01:00.000Z' });
  });

  it('a connection that closes while listing reports whatsapp_not_connected', async () => {
    const src = new FakeSource();
    let open!: () => void;
    src.gate = new Promise((r) => (open = r));
    src.fail = new Error('closed');
    const dir = new GroupDirectory({ gateway: src, clock: manualClock(T0) });
    const p = dir.list();
    src.state = 'closed';
    open();
    expect(await p).toMatchObject({ stale: true, reason: 'whatsapp_not_connected' });
  });

  it('a listGroups that hangs gives up after fetchTimeoutMs', async () => {
    const src = new FakeSource();
    src.gate = new Promise(() => {});
    const dir = new GroupDirectory({ gateway: src, clock: manualClock(T0), fetchTimeoutMs: 20 });
    expect(await dir.list()).toEqual({ groups: [], stale: true, reason: 'list_failed', fetchedAt: null });
  });

  it('returns copies: changing an answer does not change the cache', async () => {
    const src = new FakeSource();
    src.groups = [{ id: gid(1), subject: 'A' }];
    const dir = new GroupDirectory({ gateway: src, clock: manualClock(T0) });
    (await dir.list()).groups[0]!.subject = 'changed';
    expect((await dir.list()).groups[0]!.subject).toBe('A');
  });
});

function live(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: gid(i + 10), subject: `Group ${String(i).padStart(3, '0')}` }));
}

describe('groupsOverview', () => {
  const listing = (groups: { id: string; subject: string }[]) => ({ groups, stale: false, reason: null, fetchedAt: T0 });

  it('merges 250 live groups with the allow-list and the clients table; approved first, then by name', async () => {
    const db = await seededDb();
    const groups = [...live(248), { id: SHARMA.groupId, subject: 'Sharma x Studio' }, { id: MEHTA.groupId, subject: 'Mehta – Studio' }];
    const o = await groupsOverview({ db, listing: listing(groups), configs: [SHARMA, MEHTA] });
    expect(o.total).toBe(250);
    expect(o.counts).toEqual({ all: 250, approved: 2, notApproved: 248, ignored: 0 });
    expect(o.rows.slice(0, 2).map((r) => r.groupId)).toEqual([MEHTA.groupId, SHARMA.groupId]);
    expect(o.rows[0]).toEqual({
      groupId: MEHTA.groupId, name: 'Mehta – Studio', approved: true, inWhatsApp: true, ignored: false,
      client: { name: 'Mehta Foods', code: 'MEH', active: true, hasTasks: false, codeLocked: true, emailDomains: [], meetingKeywords: [] },
    });
    expect(o.rows[2]).toEqual({ groupId: gid(10), name: 'Group 000', approved: false, inWhatsApp: true, ignored: false, client: null });
    expect(o.rows.at(-1)!.name).toBe('Group 247');
  });

  it('filters approved / not approved and caps the rows at limit (counts stay whole)', async () => {
    const db = await seededDb();
    const groups = [...live(30), { id: SHARMA.groupId, subject: 'Sharma' }];
    const approved = await groupsOverview({ db, listing: listing(groups), configs: [SHARMA], filter: 'approved' });
    expect(approved.rows.map((r) => r.groupId)).toEqual([SHARMA.groupId]);
    const not = await groupsOverview({ db, listing: listing(groups), configs: [SHARMA], filter: 'not_approved', limit: 5 });
    expect(not.rows).toHaveLength(5);
    expect(not.rows.every((r) => !r.approved)).toBe(true);
    expect(not.total).toBe(30);
    expect(not.counts).toEqual({ all: 31, approved: 1, notApproved: 30, ignored: 0 });
  });

  it('ignored groups leave Not approved for their own filter; an approved group is never ignored', async () => {
    const db = await seededDb();
    const groups = [...live(5), { id: SHARMA.groupId, subject: 'Sharma' }];
    const ignored = (id: string) => id === gid(10) || id === gid(11) || id === SHARMA.groupId;
    const at = (filter: 'all' | 'not_approved' | 'ignored' | 'approved') => groupsOverview({ db, listing: listing(groups), configs: [SHARMA], filter, ignored });
    expect((await at('all')).counts).toEqual({ all: 6, approved: 1, notApproved: 3, ignored: 2 });
    expect((await at('all')).rows).toHaveLength(6);
    expect((await at('ignored')).rows.map((r) => r.groupId)).toEqual([gid(10), gid(11)]);
    expect((await at('not_approved')).rows.map((r) => r.groupId)).toEqual([gid(12), gid(13), gid(14)]);
    expect((await at('approved')).rows[0]).toMatchObject({ groupId: SHARMA.groupId, ignored: false });
  });

  it('two groups with the same name are ordered by id; a limit that is not a number means 500', async () => {
    const db = await seededDb();
    const o = await groupsOverview({ db, listing: listing([{ id: gid(2), subject: 'Same' }, { id: gid(1), subject: 'same' }]), configs: [], limit: Number.NaN });
    expect(o.rows.map((r) => r.groupId)).toEqual([gid(1), gid(2)]);
    expect((await groupsOverview({ db, listing: listing(live(600)), configs: [], limit: Number.NaN })).rows).toHaveLength(500);
  });

  it('searches group and client names, ignoring case and accents', async () => {
    const db = await seededDb();
    const groups = [
      { id: gid(1), subject: 'Café Désai Projects' },
      { id: gid(2), subject: 'CAFE desai accounts' },
      { id: gid(3), subject: 'Other' },
      { id: SHARMA.groupId, subject: 'Studio x Team' }, // matched by its client name
    ];
    const cafe = await groupsOverview({ db, listing: listing(groups), configs: [SHARMA], q: 'cafe DESAI' });
    expect(cafe.rows.map((r) => r.groupId).sort()).toEqual([gid(1), gid(2)]);
    expect((await groupsOverview({ db, listing: listing(groups), configs: [SHARMA], q: 'shárma' })).rows.map((r) => r.groupId)).toEqual([SHARMA.groupId]);
    expect((await groupsOverview({ db, listing: listing(groups), configs: [SHARMA], q: '   ' })).rows).toHaveLength(4);
  });

  it('an approved group no longer in WhatsApp is listed with inWhatsApp false and its client name', async () => {
    const db = await seededDb();
    const o = await groupsOverview({ db, listing: listing(live(3)), configs: [SHARMA] });
    const row = o.rows.find((r) => r.groupId === SHARMA.groupId)!;
    expect(row).toMatchObject({ approved: true, inWhatsApp: false, name: 'Sharma Interiors' });
  });

  it('a stale empty listing does not mark approved groups as gone', async () => {
    const db = await seededDb();
    const o = await groupsOverview({ db, listing: { groups: [], stale: true, reason: 'whatsapp_not_connected', fetchedAt: null }, configs: [SHARMA] });
    expect(o.rows).toEqual([expect.objectContaining({ groupId: SHARMA.groupId, approved: true, inWhatsApp: true })]);
    expect(o).toMatchObject({ stale: true, reason: 'whatsapp_not_connected', fetchedAt: null });
  });

  it('a client with tasks has hasTasks; a client row in the DB locks the code; a new approved client does not', async () => {
    const { db, ids } = await seeded();
    await createTask(db, { clientId: ids.sharma, side: 'us', title: 'Banner', category: 'design', priority: 'major', assignedTo: null, askedBy: null,
      raisedOn: '2026-10-10', deadline: null, latestProgress: null, sourceQuote: 'q', sourceDate: '2026-10-10', sourceWaId: 'W1', origin: 'whatsapp' }, NOW);
    const fresh: ClientConfig = { ...SHARMA, groupId: gid(99), name: 'Desai Foods', code: 'DES' };
    const o = await groupsOverview({ db, listing: listing([]), configs: [SHARMA, MEHTA, fresh] });
    const by = (id: string) => o.rows.find((r) => r.groupId === id)!.client!;
    expect(by(SHARMA.groupId)).toMatchObject({ hasTasks: true, codeLocked: true });
    expect(by(MEHTA.groupId)).toMatchObject({ hasTasks: false, codeLocked: true });
    expect(by(gid(99))).toMatchObject({ hasTasks: false, codeLocked: false, active: false });
  });

  it('a group removed earlier, not approved now, shows its former client with the code locked', async () => {
    const db = await seededDb();
    await syncClients(db, [MEHTA]); // Sharma removed from the allow-list: its row stays, inactive
    const o = await groupsOverview({ db, listing: listing([{ id: SHARMA.groupId, subject: 'Sharma x Studio' }, { id: gid(7), subject: 'New group' }]), configs: [MEHTA] });
    const row = o.rows.find((r) => r.groupId === SHARMA.groupId)!;
    expect(row).toMatchObject({ approved: false, name: 'Sharma x Studio' });
    expect(row.client).toEqual({ name: SHARMA.name, code: 'SHA', active: false, hasTasks: false, codeLocked: true, emailDomains: [], meetingKeywords: [] });
    expect(o.rows.find((r) => r.groupId === gid(7))!.client).toBeNull();
  });

  it('an inactive client row (removed earlier, approved again) still locks its code', async () => {
    const db = await seededDb();
    await syncClients(db, [MEHTA]); // Sharma inactive
    const o = await groupsOverview({ db, listing: listing([]), configs: [SHARMA] });
    expect(o.rows[0]!.client).toMatchObject({ code: 'SHA', active: false, codeLocked: true });
  });
});

describe('searchKey', () => {
  it('lower-cases, strips accents and collapses spaces', () => {
    expect(searchKey('  Café  DÉSAI ')).toBe('cafe desai');
  });
});
