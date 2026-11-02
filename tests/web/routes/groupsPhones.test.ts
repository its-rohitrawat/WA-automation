import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadGroupsFile, type ClientConfig } from '../../../src/config/groups.ts';
import { fileGroupsStore } from '../../../src/config/groupsStore.ts';
import { GroupDirectory, type GroupSource } from '../../../src/control/groups.ts';
import { syncClients } from '../../../src/store/clients.ts';
import type { Db } from '../../../src/store/db.ts';
import { manualClock } from '../../../src/util/clock.ts';
import { createLogger } from '../../../src/util/logger.ts';
import type { GatewayState } from '../../../src/wa/gateway.ts';
import type { AuditFn, OwnerContext } from '../../../src/web/routes/context.ts';
import { groupsApplyHandler, groupsBulkHandler, groupsListHandler, makeGroupKey, type GroupsDeps } from '../../../src/web/routes/groups.ts';
import { MEHTA as MEHTA_HELPER, SHARMA as SHARMA_HELPER, testDb } from '../../helpers/db.ts';

// The Groups screen with more phones (November release, change 7, lane C's task 11 taken by lane B): each group shows
// the phone it is read through and the phones that see it; approving ties it to a phone; a group on an unlinked phone
// says so and can be read through another linked phone that is in it, in one audited edit, never by itself. With one
// phone, the answer approves as before. A real allow-list file; made-up ids and labels.

const SHARMA: ClientConfig = { ...SHARMA_HELPER, groupId: '120363888000000001@g.us' };
const MEHTA: ClientConfig = { ...MEHTA_HELPER, groupId: '120363888000000002@g.us' };
const KAPOOR = '120363888000000004@g.us';
const DESAI = '120363888000000003@g.us';
const PATEL = '919812345678-1500000000@g.us';
const CTX: OwnerContext = { actor: 'owner@example.com', sessionId: 'session-hash', requestId: 'a1b2c3d4e5f6' };
const k = makeGroupKey(Buffer.from('fixed-test-key-for-group-keys-00'));
const PHONES = [
  { id: 1, label: 'Office', state: 'active' as const },
  { id: 2, label: 'Rahul <b>phone', state: 'active' as const },
  { id: 3, label: 'Old phone', state: 'unlinked' as const },
];

/** As the PhoneSet: every OPEN phone's groups, each with the phones in it (phone 3 is unlinked, so it sees none). */
class FakeSource implements GroupSource {
  state: GatewayState = 'open';
  groups: { id: string; subject: string; phones?: number[] }[] = [
    { id: SHARMA.groupId, subject: 'Sharma x Studio', phones: [1, 2] },
    { id: MEHTA.groupId, subject: 'Mehta – Studio', phones: [2] },
    { id: DESAI, subject: 'Desai Foods x Studio', phones: [2] },
    { id: PATEL, subject: 'Patel Builders', phones: [2, 1] },
  ];
  status() {
    return { state: this.state };
  }
  async listGroups() {
    return this.groups.map((g) => ({ ...g }));
  }
}

const FILE = {
  clients: [
    { groupId: SHARMA.groupId, name: 'Sharma Interiors', code: 'SHA' },
    { groupId: MEHTA.groupId, name: 'Mehta Foods', code: 'MEH', phone: 3 },
    { groupId: KAPOOR, name: 'Kapoor Design', code: 'KAP', phone: 3 },
  ],
};

let dir: string;
let file: string;
let db: Db;
let src: FakeSource;
let audits: Parameters<AuditFn>[0][];
let deps: GroupsDeps;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wa-groups-phones-'));
  file = join(dir, 'allowed-groups.json');
  writeFileSync(file, `${JSON.stringify(FILE, null, 2)}\n`);
  db = await testDb();
  await syncClients(db, loadGroupsFile(file));
  src = new FakeSource();
  audits = [];
  const clock = manualClock('2026-11-02T08:00:00.000Z');
  deps = {
    db, directory: new GroupDirectory({ gateway: src, clock }), store: fileGroupsStore(file, { db }), configs: () => loadGroupsFile(file),
    groupKey: k, audit: async (e) => { audits.push(e); }, log: createLogger('debug', { write: () => {} }), clock,
    phones: () => PHONES,
  };
});
afterEach(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

type Row = { key: string; name: string; approved: boolean; inWhatsApp: boolean; phone: number | null; seenBy: number[]; phoneState: string; readThrough: number | null };
const view = (r: { body: unknown }) => r.body as { rows: Row[]; phones: typeof PHONES; total: number };
const row = (r: { body: unknown }, groupId: string) => view(r).rows.find((x) => x.key === k(groupId))!;
const list = (q: Record<string, string | null> = {}) => groupsListHandler(deps, CTX, { q: null, filter: null, refresh: null, ...q });
const apply = (b: unknown) => groupsApplyHandler(deps, CTX, b);
const errorOf = (r: { body: unknown }) => (r.body as { error: { code: string; field?: string } }).error;
const fileEntry = (groupId: string) => (JSON.parse(readFileSync(file, 'utf8')) as typeof FILE).clients.find((c) => c.groupId === groupId) as Record<string, unknown> | undefined;

describe('Groups: each group and its phone', () => {
  it('each row has the phone it is read through and the phones that see it; the answer lists the phones', async () => {
    const r = await list();
    expect(view(r).phones).toEqual(PHONES);
    expect(row(r, SHARMA.groupId)).toMatchObject({ approved: true, phone: 1, seenBy: [1, 2], phoneState: 'ok', readThrough: null });
    expect(row(r, DESAI)).toMatchObject({ approved: false, phone: null, seenBy: [2], phoneState: 'ok', readThrough: null });
    expect(row(r, PATEL)).toMatchObject({ seenBy: [1, 2] }); // in phone order
  });

  it('a group on an unlinked phone says so, and offers the lowest linked phone that is in it; none: no offer, and not "gone"', async () => {
    const r = await list();
    expect(row(r, MEHTA.groupId)).toMatchObject({ approved: true, phone: 3, seenBy: [2], phoneState: 'unlinked', readThrough: 2 });
    // Kapoor's only phone is unlinked and no linked phone is in it: still an approved group, not "no longer in WhatsApp".
    expect(row(r, KAPOOR)).toMatchObject({ approved: true, phone: 3, seenBy: [], phoneState: 'unlinked', readThrough: null, inWhatsApp: true });
  });

  it('a phone that no longer exists counts as unlinked', async () => {
    deps.phones = () => PHONES.filter((p) => p.id !== 3);
    expect(row(await list(), MEHTA.groupId)).toMatchObject({ phoneState: 'unlinked', readThrough: 2 });
  });

  it('never gives a group id or a number; labels come as the owner wrote them (the page escapes them)', async () => {
    const text = JSON.stringify((await list()).body);
    expect(text).not.toMatch(/@g\.us|919812345678|120363888/);
    expect(text).toContain('Rahul <b>phone');
  });
});

describe('Groups: approving on a phone', () => {
  // As the dashboard: the list first (a save names groups by the keys of the list it showed).
  beforeEach(async () => {
    await list();
  });

  it('approve with no phone takes the lowest linked phone that sees the group (phone 1 writes no field)', async () => {
    expect((await apply({ approve: [{ key: k(DESAI), name: 'Desai Foods', code: 'DES' }, { key: k(PATEL), name: 'Patel Builders', code: 'PAT' }] })).status).toBe(200);
    expect(fileEntry(DESAI)!.phone).toBe(2);
    expect(fileEntry(PATEL)).not.toHaveProperty('phone');
  });

  it('approve on the phone the owner picks; refused, writing nothing, for a phone not in the group, an unlinked one, or not 1 to 5', async () => {
    expect((await apply({ approve: [{ key: k(PATEL), name: 'Patel Builders', code: 'PAT', phone: 2 }] })).status).toBe(200);
    expect(fileEntry(PATEL)!.phone).toBe(2);
    const notIn = await apply({ approve: [{ key: k(DESAI), name: 'Desai Foods', code: 'DES', phone: 1 }] });
    expect(notIn.status).toBe(422);
    expect(errorOf(notIn)).toMatchObject({ code: 'group_change', field: 'phone' });
    const unlinked = await apply({ approve: [{ key: k(DESAI), name: 'Desai Foods', code: 'DES', phone: 3 }] });
    expect(errorOf(unlinked)).toMatchObject({ code: 'group_change', field: 'phone' });
    for (const phone of [0, 6, 1.5, '2']) expect((await apply({ approve: [{ key: k(DESAI), name: 'Desai Foods', code: 'DES', phone }] })).status, String(phone)).toBe(400);
    expect(fileEntry(DESAI)).toBeUndefined();
  });

  it('bulk approve takes the same default phone for each group', async () => {
    await groupsBulkHandler(deps, CTX, { action: 'approve', keys: [k(DESAI)] });
    expect(fileEntry(DESAI)!.phone).toBe(2);
  });
});

describe('Groups: read through another phone', () => {
  beforeEach(async () => {
    await list();
  });

  it('is one edit: the group moves to that phone, with one audit line naming it, and is read as ok from then on', async () => {
    const r = await apply({ edit: [{ key: k(MEHTA.groupId), phone: 2 }] });
    expect(r.status).toBe(200);
    expect(fileEntry(MEHTA.groupId)!.phone).toBe(2);
    expect(audits.map((a) => a.event)).toEqual(['Group now read through Rahul <b>phone · Mehta Foods (MEH)']);
    expect(row(await list(), MEHTA.groupId)).toMatchObject({ phone: 2, phoneState: 'ok', readThrough: null });
  });

  it('moving back to phone 1 drops the field; moving to an unlinked phone or one not in the group is refused', async () => {
    await apply({ edit: [{ key: k(MEHTA.groupId), phone: 2 }] });
    expect(errorOf(await apply({ edit: [{ key: k(SHARMA.groupId), phone: 3 }] }))).toMatchObject({ field: 'phone' });
    expect(errorOf(await apply({ edit: [{ key: k(MEHTA.groupId), phone: 1 }] }))).toMatchObject({ field: 'phone' }); // phone 1 is not in Mehta's group
    src.groups[1]!.phones = [1, 2];
    await deps.directory.list({ refresh: true });
    expect((await apply({ edit: [{ key: k(MEHTA.groupId), phone: 1 }] })).status).toBe(200);
    expect(fileEntry(MEHTA.groupId)).not.toHaveProperty('phone');
  });

  it('nothing moves by itself: listing a group on an unlinked phone changes nothing', async () => {
    const before = readFileSync(file, 'utf8');
    await list();
    await list({ refresh: '1' });
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(audits).toEqual([]);
  });
});

describe('Groups with one phone (no phone list)', () => {
  it('approves as before: phone 1, no field written; any other phone is refused', async () => {
    delete deps.phones;
    src.groups = src.groups.map(({ phones: _p, ...g }) => g); // a single gateway says nothing about phones
    const r = await list();
    expect(view(r).phones).toEqual([{ id: 1, label: 'Phone 1', state: 'active' }]);
    expect(row(r, DESAI)).toMatchObject({ seenBy: [1], phone: null, phoneState: 'ok' });
    expect((await apply({ approve: [{ key: k(DESAI), name: 'Desai Foods', code: 'DES' }] })).status).toBe(200);
    expect(fileEntry(DESAI)).not.toHaveProperty('phone');
    expect(errorOf(await apply({ approve: [{ key: k(PATEL), name: 'Patel Builders', code: 'PAT', phone: 2 }] }))).toMatchObject({ field: 'phone' });
  });
});
