import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadGroupsFile, type ClientConfig } from '../../../src/config/groups.ts';
import { GroupDirectory, type GroupSource } from '../../../src/control/groups.ts';
import { syncClients } from '../../../src/store/clients.ts';
import { openDb, type Db } from '../../../src/store/db.ts';
import { manualClock, type ManualClock } from '../../../src/util/clock.ts';
import { createLogger } from '../../../src/util/logger.ts';
import type { GatewayState } from '../../../src/wa/gateway.ts';
import type { AuditFn, OwnerContext } from '../../../src/web/routes/context.ts';
import {
  codeCandidates, groupsApplyHandler, groupsBulkHandler, groupsListHandler, makeGroupKey, suggestCodeHandler, type GroupsDeps,
} from '../../../src/web/routes/groups.ts';
import { MEHTA as MEHTA_HELPER, SHARMA as SHARMA_HELPER } from '../../helpers/db.ts';

// These tests write a real allow-list file, which refuses the shared helpers' example group id: own ids here. The old
// group id form (<phone>-<time>@g.us) is used for Patel, to prove no raw id reaches a response.
const SHARMA: ClientConfig = { ...SHARMA_HELPER, groupId: '120363888000000001@g.us' };
const MEHTA: ClientConfig = { ...MEHTA_HELPER, groupId: '120363888000000002@g.us' };
const DESAI = '120363888000000003@g.us';
const PATEL = '919812345678-1500000000@g.us';
const T0 = '2026-10-27T08:00:00.000Z';
const CTX: OwnerContext = { actor: 'owner@example.com', sessionId: 'session-hash', requestId: 'a1b2c3d4e5f6' };
const SECRET = Buffer.from('fixed-test-key-for-group-keys-00');
const k = makeGroupKey(SECRET);

class FakeSource implements GroupSource {
  state: GatewayState = 'open';
  groups = [
    { id: SHARMA.groupId, subject: 'Sharma x Studio' },
    { id: MEHTA.groupId, subject: 'Mehta – Studio' },
    { id: DESAI, subject: 'Desai Foods x Studio' },
    { id: PATEL, subject: 'Patel Builders' },
  ];
  calls = 0;
  status() {
    return { state: this.state };
  }
  async listGroups() {
    this.calls++;
    return this.groups.map((g) => ({ ...g }));
  }
}

const FILE = {
  clients: [
    { groupId: SHARMA.groupId, name: 'Sharma Interiors', code: 'SHA', meetingKeywords: ['sharma project'] },
    { groupId: MEHTA.groupId, name: 'Mehta Foods', code: 'MEH', emailDomains: ['mehtafoods.in'] },
  ],
};

let dir: string;
let file: string;
let db: Db;
let src: FakeSource;
let clock: ManualClock;
let audits: Parameters<AuditFn>[0][];
let logLines: string[];
let deps: GroupsDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-groups-routes-'));
  file = join(dir, 'allowed-groups.json');
  writeFileSync(file, `${JSON.stringify(FILE, null, 2)}\n`);
  db = openDb(':memory:');
  syncClients(db, loadGroupsFile(file));
  src = new FakeSource();
  audits = [];
  logLines = [];
  clock = manualClock(T0);
  deps = {
    db,
    directory: new GroupDirectory({ gateway: src, clock }),
    groupsFile: file,
    configs: () => loadGroupsFile(file),
    groupKey: k,
    audit: (e) => audits.push(e),
    log: createLogger('debug', { write: (l: string) => void logLines.push(l) }),
    clock,
  };
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

type Body = Record<string, unknown>;
type Row = { key: string; name: string; approved: boolean; client: { name: string; code: string; emailDomains: string[] } | null };
const body = (r: { body: unknown }) => r.body as Body;
const rows = (r: { body: unknown }) => (r.body as { rows: Row[] }).rows;
const errorOf = (r: { body: unknown }) => (r.body as { error: Body }).error;
const noRawIds = (r: unknown) => expect(JSON.stringify(r)).not.toMatch(/@g\.us|919812345678|120363888/);

describe('makeGroupKey', () => {
  it('is the first 24 hex characters of HMAC-SHA256 over the group id', () => {
    expect(k(DESAI)).toBe(createHmac('sha256', SECRET).update(DESAI).digest('hex').slice(0, 24));
    expect(k(DESAI)).toMatch(/^[0-9a-f]{24}$/);
    expect(k(DESAI)).not.toBe(k(PATEL));
    expect(makeGroupKey(Buffer.from('another-secret'))(DESAI)).not.toBe(k(DESAI));
  });
});

describe('groupsListHandler', () => {
  it('returns the overview with keys instead of group ids, and stale, reason and fetchedAt', async () => {
    const r = await groupsListHandler(deps, CTX, {});
    expect(r.status).toBe(200);
    expect(body(r)).toMatchObject({ total: 4, counts: { all: 4, approved: 2, notApproved: 2 }, stale: false, reason: null, fetchedAt: T0 });
    expect(rows(r).map((x) => x.key).sort()).toEqual([SHARMA.groupId, MEHTA.groupId, DESAI, PATEL].map(k).sort());
    expect(rows(r).find((x) => x.key === k(PATEL))).toEqual({ key: k(PATEL), name: 'Patel Builders', approved: false, inWhatsApp: true, ignored: false, client: null });
    noRawIds(r);
  });

  it('searches and filters', async () => {
    const r = await groupsListHandler(deps, CTX, { q: 'desai', filter: 'not_approved' });
    expect(rows(r).map((x) => x.key)).toEqual([k(DESAI)]);
    expect(body(await groupsListHandler(deps, CTX, { filter: 'approved' })).total).toBe(2);
  });

  it.each(['1', 'true'])('refresh=%s asks WhatsApp again, but not while the list is under 30 s old', async (refresh) => {
    await groupsListHandler(deps, CTX, {});
    expect(src.calls).toBe(1);
    await groupsListHandler(deps, CTX, { refresh });
    clock.advance(29_999);
    await groupsListHandler(deps, CTX, { refresh });
    expect(src.calls).toBe(1);
    clock.advance(1);
    await groupsListHandler(deps, CTX, { refresh });
    expect(src.calls).toBe(2);
    await groupsListHandler(deps, CTX, { refresh: 'yes' });
    clock.advance(30_000);
    await groupsListHandler(deps, CTX, { refresh: 'yes' });
    expect(src.calls).toBe(2);
  });

  it('marks the list stale when WhatsApp is not connected', async () => {
    src.state = 'closed';
    expect(body(await groupsListHandler(deps, CTX, {}))).toMatchObject({ stale: true, reason: 'whatsapp_not_connected', fetchedAt: null });
  });

  it('accepts a 200-character search; refuses an unknown filter and a 201-character search', async () => {
    expect((await groupsListHandler(deps, CTX, { q: 'x'.repeat(200) })).status).toBe(200);
    for (const search of [{ filter: 'everything' }, { q: 'x'.repeat(201) }]) {
      const r = await groupsListHandler(deps, CTX, search);
      expect(r.status).toBe(400);
      expect(errorOf(r).code).toBe('invalid');
    }
  });
});

describe('groupsApplyHandler', () => {
  beforeEach(async () => {
    await deps.directory.list();
  });

  it('round trip: the keys from the list approve, remove and edit the right groups; one audit line per change', async () => {
    const listed = rows(await groupsListHandler(deps, CTX, {}));
    const keyOf = (name: string) => listed.find((x) => x.name === name)!.key;
    const r = await groupsApplyHandler(deps, CTX, {
      approve: [{ key: keyOf('Desai Foods x Studio'), name: '  Desai Foods ', code: 'DES', emailDomains: [' DesaiFoods.COM '], meetingKeywords: ['desai launch'] }],
      unapprove: [keyOf('Mehta – Studio')],
      edit: [{ key: keyOf('Sharma x Studio'), name: 'Sharma Interiors Pvt' }],
    });
    expect(r.status).toBe(200);
    expect(audits).toEqual([
      { actor: CTX.actor, event: 'Group approved · Desai Foods (DES)', kind: 'config', requestId: CTX.requestId },
      { actor: CTX.actor, event: 'Group removed · Mehta Foods (MEH)', kind: 'config', requestId: CTX.requestId },
      { actor: CTX.actor, event: 'Client edited · Sharma Interiors Pvt (SHA)', kind: 'config', requestId: CTX.requestId },
    ]);
    expect(loadGroupsFile(file).map((c) => [c.groupId, c.code])).toEqual([[SHARMA.groupId, 'SHA'], [DESAI, 'DES']]);
    expect(body(r).counts).toEqual({ all: 4, approved: 2, notApproved: 2, ignored: 0 });
    expect(rows(r).find((x) => x.key === k(DESAI))).toMatchObject({ approved: true, client: { name: 'Desai Foods', emailDomains: ['desaifoods.com'] } });
    expect(rows(r).find((x) => x.key === k(MEHTA.groupId))!.approved).toBe(false);
    expect(rows(r).find((x) => x.key === k(SHARMA.groupId))!.client!.name).toBe('Sharma Interiors Pvt');
    noRawIds(r);
  });

  it('a group only in the allow-list (not in the live list) is found by its key', async () => {
    src.groups = src.groups.filter((g) => g.id !== MEHTA.groupId);
    clock.advance(30_000);
    await deps.directory.list({ refresh: true });
    const r = await groupsApplyHandler(deps, CTX, { edit: [{ key: k(MEHTA.groupId), name: 'Mehta Foods Ltd' }] });
    expect(r.status).toBe(200);
    expect(audits.map((a) => a.event)).toEqual(['Client edited · Mehta Foods Ltd (MEH)']);
  });

  it('builds the answer from the cached list: no WhatsApp call, and the cache state as it is', async () => {
    expect(src.calls).toBe(1);
    src.state = 'closed';
    const r = await groupsApplyHandler(deps, CTX, { approve: [{ key: k(DESAI), name: 'Desai Foods', code: 'DES' }] });
    expect(r.status).toBe(200);
    expect(src.calls).toBe(1);
    expect(body(r)).toMatchObject({ stale: true, reason: 'whatsapp_not_connected', fetchedAt: T0, counts: { all: 4, approved: 3, notApproved: 1 } });
  });

  it('an unknown key gives 400 without repeating it; nothing is written or audited', async () => {
    const before = readFileSync(file, 'utf8');
    const unknown = k('120363888000000099@g.us');
    for (const input of [{ unapprove: [unknown] }, { edit: [{ key: unknown, name: 'X' }] }, { approve: [{ key: unknown, name: 'X', code: 'XXX' }] }]) {
      const r = await groupsApplyHandler(deps, CTX, input);
      expect(r.status).toBe(400);
      expect(errorOf(r).code).toBe('invalid');
      expect(JSON.stringify(r)).not.toContain(unknown);
    }
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(audits).toEqual([]);
  });

  it('a raw group id in place of a key is refused', async () => {
    const r = await groupsApplyHandler(deps, CTX, { unapprove: [MEHTA.groupId] });
    expect(r.status).toBe(400);
    noRawIds(r);
  });

  it('an empty body changes nothing and audits nothing', async () => {
    const before = readFileSync(file, 'utf8');
    const r = await groupsApplyHandler(deps, CTX, {});
    expect(r.status).toBe(200);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(audits).toEqual([]);
  });

  const approve = (o: Record<string, unknown> = {}) => ({ approve: [{ key: k(DESAI), name: 'Desai Foods', code: 'DES', ...o }] });
  const ids = (n: number, from = 100) => Array.from({ length: n }, (_, i) => `120363888${String(from + i).padStart(9, '0')}@g.us`);
  const keys = (n: number) => ids(n).map(k);

  it('accepts a name of exactly 80 characters', async () => {
    const r = await groupsApplyHandler(deps, CTX, approve({ name: 'N'.repeat(80) }));
    expect(r.status).toBe(200);
    expect(audits.map((a) => a.event)).toEqual([`Group approved · ${'N'.repeat(80)} (DES)`]);
  });

  it.each([
    ['301 changes in total', { unapprove: keys(200), edit: keys(101).map((key) => ({ key, name: 'X' })) }],
    ['301 in one list', { unapprove: keys(301) }],
    ['an 81-character name', approve({ name: 'N'.repeat(81) })],
    ['an empty name', approve({ name: '   ' })],
    ['a bad domain', approve({ emailDomains: ['not a domain'] })],
    ['a public mail domain', approve({ emailDomains: ['gmail.com'] })],
    ['a short keyword', approve({ meetingKeywords: ['ab'] })],
    ['a keyword without 3 letters once punctuation is removed', approve({ meetingKeywords: ['c++'] })],
    ['21 keywords', approve({ meetingKeywords: Array.from({ length: 21 }, (_, i) => `keyword ${i}`) })],
    ['a code that is not a string', approve({ code: 123 })],
    ['a code longer than 10 characters', approve({ code: 'ABCDEFGHIJK' })],
    ['a key that is not a key', approve({ key: 'not-a-key' })],
    ['an unknown field', approve({ active: false })],
    ['an edit with an unknown field (code)', { edit: [{ key: k(SHARMA.groupId), code: 'SHX' }] }],
    ['an edit with a groupId instead of a key', { edit: [{ groupId: SHARMA.groupId, name: 'X' }] }],
    ['an unknown list', { approve: [], remove: [] }],
    ['a list that is not a list', { unapprove: k(MEHTA.groupId) }],
    ['a body that is not an object', 'approve'],
    ['no body', null],
  ])('refuses %s with 400 invalid; nothing is written or audited', async (_, input) => {
    const before = readFileSync(file, 'utf8');
    const r = await groupsApplyHandler(deps, CTX, input);
    expect(r.status).toBe(400);
    expect(errorOf(r).code).toBe('invalid');
    expect(typeof errorOf(r).message).toBe('string');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(audits).toEqual([]);
    noRawIds(r);
  });

  it('the 400 message names the field but never repeats the value', async () => {
    const r = await groupsApplyHandler(deps, CTX, approve({ emailDomains: ['secret-looking value'] }));
    const message = errorOf(r).message as string;
    expect(message).toContain('approve.0.emailDomains.0');
    expect(message).not.toContain('secret-looking value');
    const unknown = errorOf(await groupsApplyHandler(deps, CTX, approve({ sneakyField: 1 }))).message as string;
    expect(unknown).not.toContain('sneakyField');
  });

  it('the 400 names the group (by its key) and the form field, so the dashboard can open that group', async () => {
    const r = await groupsApplyHandler(deps, CTX, approve({ emailDomains: ['gmail.com'] }));
    const key = (approve({}) as { approve: { key: string }[] }).approve[0]!.key;
    expect(errorOf(r)).toMatchObject({ code: 'invalid', key, field: 'emailDomains' });
    expect(errorOf(await groupsApplyHandler(deps, CTX, { edit: [{ key: k(SHARMA.groupId), name: '' }] }))).toMatchObject({ key: k(SHARMA.groupId), field: 'name' });
    // A key that is not well-formed, an unknown field, or no list position: neither is echoed.
    expect(errorOf(await groupsApplyHandler(deps, CTX, approve({ key: 'not-a-key' })))).toMatchObject({ key: null, field: null });
    expect(errorOf(await groupsApplyHandler(deps, CTX, approve({ sneakyField: 1 })))).toMatchObject({ field: null });
    expect(errorOf(await groupsApplyHandler(deps, CTX, 'approve'))).toMatchObject({ key: null, field: null });
  });

  it('exactly 300 changes pass the limit (the writer then judges them)', async () => {
    src.groups.push(...ids(300).map((id, i) => ({ id, subject: `Extra ${i}` })));
    clock.advance(30_000);
    await deps.directory.list({ refresh: true });
    const r = await groupsApplyHandler(deps, CTX, { unapprove: keys(300) });
    expect(r.status).toBe(422);
    expect(errorOf(r)).toMatchObject({ code: 'group_change', message: 'This group is not approved.', key: keys(1)[0] });
  });

  it('a GroupChangeError gives 422 with its message, field and the group key; nothing is written or audited', async () => {
    const before = readFileSync(file, 'utf8');
    const r = await groupsApplyHandler(deps, CTX, approve({ code: 'MEH' }));
    expect(r).toEqual({
      status: 422,
      body: { error: { code: 'group_change', message: 'Code MEH is already used by Mehta Foods. Pick a different code.', field: 'code', key: k(DESAI) } },
    });
    const bad = await groupsApplyHandler(deps, CTX, approve({ code: 'de' }));
    expect(errorOf(bad)).toEqual({ code: 'group_change', message: 'The code must be 3 or 4 capital letters, for example SHA.', field: 'code', key: k(DESAI) });
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(audits).toEqual([]);
  });

  it('a 422 about the file has key null and no group id in its message', async () => {
    // A file that already lists Patel twice: the writer's check fails with a message the parser wrote about the id. The
    // app's configs stay the last good list.
    const lastGood = loadGroupsFile(file);
    deps.configs = () => lastGood;
    writeFileSync(file, JSON.stringify({ clients: [...FILE.clients, { groupId: PATEL, name: 'P1', code: 'PAA' }, { groupId: PATEL, name: 'P2', code: 'PAB' }] }));
    const r = await groupsApplyHandler(deps, CTX, { edit: [{ key: k(SHARMA.groupId), name: 'Sharma New' }] });
    expect(r.status).toBe(422);
    expect(errorOf(r).key).toBeNull();
    noRawIds(r);
  });

  it('a failing audit line does not undo a completed save: logged by error type only, the rest still written', async () => {
    const written: string[] = [];
    deps.audit = (e) => {
      if (e.event.startsWith('Group approved')) throw new Error('audit store failed with private details');
      written.push(e.event);
    };
    const r = await groupsApplyHandler(deps, CTX, { ...approve(), unapprove: [k(MEHTA.groupId)] });
    expect(r.status).toBe(200);
    expect(loadGroupsFile(file).map((c) => c.code)).toEqual(['SHA', 'DES']);
    expect(written).toEqual(['Group removed · Mehta Foods (MEH)']);
    const log = logLines.join('\n');
    expect(log).toContain('"Error"');
    expect(log).not.toContain('private details');
    expect(log).not.toContain('Desai');
  });

  it('any other error is thrown, not turned into a response', async () => {
    db.close();
    await expect(groupsApplyHandler(deps, CTX, approve())).rejects.toThrow();
    expect(audits).toEqual([]);
    db = openDb(':memory:');
  });
});

describe('groupsBulkHandler', () => {
  const HINDI = '120363888000000009@g.us';
  const EXPORTS = '120363888000000010@g.us';
  const bulk = (action: string, keys: string[]) => groupsBulkHandler(deps, CTX, { action, keys });
  const results = (r: { body: unknown }) => (r.body as { results: { key: string; ok: boolean; reason: string | null }[] }).results;
  // The ignore rows only (the kv table also holds each client's history read).
  const kvRows = () => db.prepare("SELECT k, v FROM kv WHERE k GLOB 'group_ignored:*'").all() as { k: string; v: string }[];
  beforeEach(async () => {
    src.groups.push({ id: HINDI, subject: 'शर्मा परिवार' }, { id: EXPORTS, subject: 'Desai Exports' });
    await deps.directory.list();
  });

  it('approves each group with the name and code the form would suggest; one audit line each; codes never clash', async () => {
    const r = await bulk('approve', [k(DESAI), k(EXPORTS), k(PATEL)]);
    expect(r.status).toBe(200);
    expect(results(r)).toEqual([
      { key: k(DESAI), ok: true, reason: null }, { key: k(EXPORTS), ok: true, reason: null }, { key: k(PATEL), ok: true, reason: null },
    ]);
    // Desai Exports comes after Desai Foods took DES: its code is the next free one.
    expect(loadGroupsFile(file).map((c) => [c.name, c.code])).toEqual([
      ['Sharma Interiors', 'SHA'], ['Mehta Foods', 'MEH'], ['Desai Foods', 'DES'], ['Desai Exports', 'DESA'], ['Patel Builders', 'PAT'],
    ]);
    expect(audits.map((a) => a.event)).toEqual(['Group approved · Desai Foods (DES)', 'Group approved · Desai Exports (DESA)', 'Group approved · Patel Builders (PAT)']);
    expect(audits.every((a) => a.actor === CTX.actor && a.kind === 'config' && a.requestId === CTX.requestId)).toBe(true);
    expect(body(r).counts).toMatchObject({ approved: 5, notApproved: 1 });
    noRawIds(r);
  });

  it('one group failing does not stop the others, and each says why', async () => {
    const r = await bulk('approve', [k(HINDI), k(SHARMA.groupId), k(DESAI)]);
    expect(r.status).toBe(200);
    expect(results(r)).toEqual([
      { key: k(HINDI), ok: false, reason: 'No code could be made from its name. Approve it on its own to choose one.' },
      { key: k(SHARMA.groupId), ok: false, reason: 'It is tracked already.' },
      { key: k(DESAI), ok: true, reason: null },
    ]);
    expect(loadGroupsFile(file).map((c) => c.code)).toEqual(['SHA', 'MEH', 'DES']);
    expect(audits.map((a) => a.event)).toEqual(['Group approved · Desai Foods (DES)']);
  });

  it('a former client comes back with its own name and code', async () => {
    await groupsApplyHandler(deps, CTX, { unapprove: [k(MEHTA.groupId)] });
    const r = await bulk('approve', [k(MEHTA.groupId)]);
    expect(results(r)[0]!.ok).toBe(true);
    expect(loadGroupsFile(file).find((c) => c.groupId === MEHTA.groupId)).toMatchObject({ name: 'Mehta Foods', code: 'MEH' });
  });

  it('a refused write is that group\'s reason, without any group id', async () => {
    // The file on disk is not valid JSON any more (the running agent keeps the list it last read): the writer refuses each
    // group, and says so in words.
    const last = deps.configs();
    deps.configs = () => last;
    writeFileSync(file, '{ not json');
    const r = await bulk('approve', [k(DESAI), k(PATEL)]);
    expect(r.status).toBe(200);
    expect(results(r).map((x) => x.ok)).toEqual([false, false]);
    expect(results(r)[0]!.reason).toBeTruthy();
    expect(audits).toEqual([]);
    noRawIds(r);
  });

  it('refuses the whole request before writing anything: bad action, no keys, more than 50, a repeat, an unknown key', async () => {
    const before = readFileSync(file, 'utf8');
    const many = Array.from({ length: 51 }, (_, i) => i.toString(16).padStart(24, '0'));
    for (const b of [
      { action: 'delete', keys: [k(DESAI)] }, { action: 'approve', keys: [] }, { action: 'approve', keys: many },
      { action: 'approve', keys: [k(DESAI), k(DESAI)] }, { action: 'approve', keys: [k(DESAI), 'f'.repeat(24)] },
      { action: 'approve', keys: [DESAI] }, { action: 'approve', keys: [k(DESAI)], extra: 1 }, null,
    ]) {
      const r = await groupsBulkHandler(deps, CTX, b);
      expect(r.status, JSON.stringify(b)).toBe(400);
      noRawIds(r);
    }
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(audits).toEqual([]);
    expect(kvRows()).toEqual([]);
  });

  it('ignore sets untracked groups aside by key (no id, no name on disk); unignore brings them back', async () => {
    const r = await bulk('ignore', [k(DESAI), k(SHARMA.groupId), k(PATEL)]);
    expect(results(r)).toEqual([
      { key: k(DESAI), ok: true, reason: null },
      { key: k(SHARMA.groupId), ok: false, reason: 'It is tracked. Remove it from the agent first.' },
      { key: k(PATEL), ok: true, reason: null },
    ]);
    expect(body(r).counts).toEqual({ all: 6, approved: 2, notApproved: 2, ignored: 2 });
    expect(rows(r).find((x) => x.key === k(DESAI))).toMatchObject({ ignored: true });
    expect(kvRows().map((x) => x.k).sort()).toEqual([`group_ignored:${k(DESAI)}`, `group_ignored:${k(PATEL)}`].sort());
    expect(JSON.stringify(kvRows())).not.toMatch(/@g\.us|919812345678|Desai|Patel/);
    expect(audits.map((a) => a.event)).toEqual(['Group ignored', 'Group ignored']);
    expect(rows(await groupsListHandler(deps, CTX, { filter: 'ignored' })).map((x) => x.key)).toEqual([k(DESAI), k(PATEL)]);
    expect(rows(await groupsListHandler(deps, CTX, { filter: 'not_approved' })).map((x) => x.key)).not.toContain(k(DESAI));

    const back = await bulk('unignore', [k(PATEL)]);
    expect(results(back)).toEqual([{ key: k(PATEL), ok: true, reason: null }]);
    expect(body(back).counts).toMatchObject({ ignored: 1 });
    expect(audits.at(-1)!.event).toBe('Group shown again');
  });

  it('approving an ignored group (bulk or Save) clears its ignore', async () => {
    await bulk('ignore', [k(DESAI), k(PATEL)]);
    await bulk('approve', [k(DESAI)]);
    await groupsApplyHandler(deps, CTX, { approve: [{ key: k(PATEL), name: 'Patel Builders', code: 'PAT' }] });
    expect(kvRows()).toEqual([]);
  });
});

describe('suggestCodeHandler', () => {
  const suggest = async (name: string) => body(await suggestCodeHandler(deps, CTX, name)).code;

  it('candidates: first three letters, initials for 3 or 4 words, first four letters, then two letters plus A to Z', () => {
    expect(codeCandidates('Desai Foods').slice(0, 3)).toEqual(['DES', 'DESA', 'DEA']);
    expect(codeCandidates('Bharat Heavy Electricals').slice(0, 3)).toEqual(['BHA', 'BHE', 'BHAR']);
    expect(codeCandidates('Rao & Sons Paper Mills').slice(0, 3)).toEqual(['RAO', 'RSPM', 'RAOS']);
    expect(codeCandidates('One Two Three Four Five').slice(0, 2)).toEqual(['ONE', 'ONET']);
    expect(codeCandidates('Ébène Studio')[0]).toBe('EBE');
    expect(codeCandidates('Desai Foods')).toHaveLength(2 + 26 - 1);
    expect(codeCandidates('Ab')).toEqual(Array.from({ length: 26 }, (_, i) => `AB${String.fromCharCode(65 + i)}`));
    expect(codeCandidates('A')).toEqual([]);
    expect(codeCandidates('१२३ स्टूडियो')).toEqual([]);
  });

  it('gives the first three letters when free; accepts an 80-character name', async () => {
    expect(await suggest('Desai Foods')).toBe('DES');
    expect(await suggest('D'.repeat(80))).toBe('DDD');
  });

  it('reads the allow-list file itself, not the configs it was given', async () => {
    deps.configs = () => [];
    writeFileSync(file, JSON.stringify({ clients: [...FILE.clients, { groupId: DESAI, name: 'Desai', code: 'DES' }] }));
    expect(await suggest('Desai Foods')).toBe('DESA');
  });

  it('a missing or unreadable file counts as no codes; the DB still does', async () => {
    for (const write of [() => rmSync(file), () => writeFileSync(file, 'not json')]) {
      write();
      expect(await suggest('Desai Foods')).toBe('DES');
      expect(await suggest('Sharma Builders')).toBe('SHAR');
    }
  });

  it('skips codes used by any client row in the DB, including inactive ones', async () => {
    const desai: ClientConfig = { ...SHARMA, groupId: DESAI, name: 'Desai Old', code: 'DES' };
    const desa: ClientConfig = { ...SHARMA, groupId: '120363888000000005@g.us', name: 'Desa Old', code: 'DESA' };
    syncClients(db, [...loadGroupsFile(file), desai, desa]);
    syncClients(db, loadGroupsFile(file));
    expect(await suggest('Desai Foods')).toBe('DEA');
  });

  it('gives null when every candidate is taken, or the name has no letters to use', async () => {
    const taken = codeCandidates('Ab').map((code, i) => ({ groupId: `120363888${String(500 + i).padStart(9, '0')}@g.us`, name: `Taken ${i}`, code }));
    writeFileSync(file, JSON.stringify({ clients: taken }));
    expect(await suggest('Ab')).toBeNull();
    expect(await suggest('1234')).toBeNull();
  });

  it('refuses an empty or over-long name', async () => {
    for (const name of ['   ', 'N'.repeat(81)]) {
      const r = await suggestCodeHandler(deps, CTX, name);
      expect(r.status).toBe(400);
      expect(errorOf(r).code).toBe('invalid');
    }
  });
});
