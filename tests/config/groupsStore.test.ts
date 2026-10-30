import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DestinationStream } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadGroupsFile, type ClientConfig } from '../../src/config/groups.ts';
import { dbGroupsStore, fileGroupsStore, GROUPS_KV_KEY } from '../../src/config/groupsStore.ts';
import { applyGroupChanges, GroupChangeError } from '../../src/config/groupsWriter.ts';
import { listClients, syncClients } from '../../src/store/clients.ts';
import { openDb, type Db } from '../../src/store/db.ts';
import { getKv } from '../../src/store/kv.ts';
import { createLogger } from '../../src/util/logger.ts';

// A customer's allow-list in their own database (Phase B), under the founder file's own rules. Real-looking group ids:
// the parser refuses the example one.
const SHARMA = '120363777000000001@g.us';
const MEHTA = '120363777000000002@g.us';
const approve = (groupId: string, name: string, code: string) => ({ approve: [{ groupId, name, code }] });

function capture() {
  const lines: string[] = [];
  return { lines, log: createLogger('info', { write: (s: string) => void lines.push(s) } as unknown as DestinationStream) };
}

/** A customer: their own database, a store whose onChange reloads their clients as the runtime does (syncClients). */
function customer(onChange?: (db: Db, c: ClientConfig[]) => unknown) {
  const db = openDb(':memory:');
  const { lines, log } = capture();
  const reloads: ClientConfig[][] = [];
  const store = dbGroupsStore({
    db, log,
    onChange: async (c) => {
      reloads.push(c);
      await (onChange ? onChange(db, c) : syncClients(db, c));
    },
  });
  return { db, store, reloads, lines };
}

const activeCodes = async (db: Db) => (await listClients(db)).map((c) => `${c.code} ${c.groupId}`);

describe('dbGroupsStore: a customer’s allow-list in their own database', () => {
  it('keeps the list in the customer’s kv and touches no file: the store has no file access at all', async () => {
    const { db, store } = customer();
    expect(await store.list()).toEqual([]);
    await store.apply(approve(SHARMA, 'Sharma Interiors', 'SHA'));
    expect(JSON.parse((await getKv(db, GROUPS_KV_KEY))!)).toEqual({ clients: [{ groupId: SHARMA, name: 'Sharma Interiors', code: 'SHA' }] });
    expect((await store.list()).map((c) => c.code)).toEqual(['SHA']);
    const source = readFileSync(join(import.meta.dirname, '../../src/config/groupsStore.ts'), 'utf8');
    expect(source).not.toMatch(/from 'node:fs'|require\(/);
  });

  it('two customers’ approvals stay apart: the same group and code in both, each only in its own list and clients', async () => {
    const a = customer();
    const b = customer();
    await a.store.apply(approve(SHARMA, 'Sharma Interiors', 'SHA'));
    expect(await b.store.list()).toEqual([]);
    expect(await activeCodes(b.db)).toEqual([]);
    expect(await getKv(b.db, GROUPS_KV_KEY)).toBeUndefined();
    await b.store.apply(approve(SHARMA, 'Sharma for B', 'SHA')); // B's own rules: A's code does not block it
    await a.store.apply({ unapprove: [SHARMA] });
    expect(await a.store.list()).toEqual([]);
    expect((await b.store.list()).map((c) => c.name)).toEqual(['Sharma for B']);
    expect(await activeCodes(a.db)).toEqual([]);
    expect(await activeCodes(b.db)).toEqual([`SHA ${SHARMA}`]);
  });

  it('the founder file’s rules: a code is permanent, a code in use is refused, a name is required; nothing is saved', async () => {
    const { db, store, reloads } = customer();
    await store.apply(approve(SHARMA, 'Sharma Interiors', 'SHA'));
    await store.apply({ unapprove: [SHARMA] }); // its clients row stays, with code SHA
    const before = await getKv(db, GROUPS_KV_KEY);
    const refused = async (changes: Parameters<typeof store.apply>[0], field: string, text: RegExp) => {
      const e = await store.apply(changes).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(GroupChangeError);
      expect(e).toMatchObject({ field });
      expect((e as Error).message).toMatch(text);
    };
    await refused(approve(SHARMA, 'Sharma Interiors', 'SHI'), 'code', /permanent/);
    await refused(approve(MEHTA, 'Mehta Foods', 'SHA'), 'code', /already used by Sharma Interiors/);
    await refused(approve(MEHTA, '  ', 'MEH'), 'name', /client name/);
    expect(await getKv(db, GROUPS_KV_KEY)).toBe(before);
    expect(reloads).toHaveLength(2);
  });

  it('onChange runs after the change has committed, with the new list; a change to nothing writes nothing and tells no one', async () => {
    const seen: (string | undefined)[] = [];
    const { db, store, reloads } = customer(async (d, c) => {
      seen.push(await getKv(d, GROUPS_KV_KEY)); // the outer handle: inside the transaction this would throw
      await syncClients(d, c);
    });
    await store.apply(approve(SHARMA, 'Sharma Interiors', 'SHA'));
    expect(JSON.parse(seen[0]!).clients).toHaveLength(1);
    expect(reloads.at(-1)!.map((c) => c.code)).toEqual(['SHA']);
    const saved = await getKv(db, GROUPS_KV_KEY);
    expect((await store.apply({ edit: [{ groupId: SHARMA, name: 'Sharma Interiors' }] })).edited).toEqual([]);
    expect(reloads).toHaveLength(1);
    expect(await getKv(db, GROUPS_KV_KEY)).toBe(saved);
  });

  it('a reload that fails keeps the change, logs only its type, warns, and the next start syncs the clients from the list', async () => {
    const { db, store, lines } = customer(() => {
      throw new TypeError(`could not reload Sharma Interiors in ${SHARMA}`);
    });
    const r = await store.apply(approve(SHARMA, 'Sharma Interiors', 'SHA'));
    expect(r.warning).toBe('reload_failed');
    expect(r.approved).toEqual([{ groupId: SHARMA, name: 'Sharma Interiors', code: 'SHA' }]);
    expect((await store.list()).map((c) => c.code)).toEqual(['SHA']); // saved
    expect(await activeCodes(db)).toEqual([]); // the clients rows are behind until the next start
    const logged = lines.join('\n');
    expect(logged).toContain('clients not reloaded after a group change');
    expect(logged).toContain('TypeError');
    expect(logged).not.toContain(SHARMA);
    expect(logged).not.toContain('Sharma');
    // The runtime's next start: its clients come from the saved list.
    await syncClients(db, await store.list());
    expect(await activeCodes(db)).toEqual([`SHA ${SHARMA}`]);
  });

  it('changes run one at a time: of two at once, the second is checked against the first', async () => {
    const { store } = customer();
    const [first, second] = await Promise.all([
      store.apply(approve(SHARMA, 'Sharma Interiors', 'SHA')),
      store.apply(approve(MEHTA, 'Mehta Foods', 'SHA')).catch((e: unknown) => e),
    ]);
    expect(first).toMatchObject({ approved: [{ code: 'SHA' }] });
    expect(second).toBeInstanceOf(GroupChangeError); // SHA was taken by the first
    expect((await store.list()).map((c) => c.code)).toEqual(['SHA']);
  });
});

describe('fileGroupsStore: the founder’s file, as before', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wa-groups-store-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the same file applyGroupChanges writes, and lists what loadGroupsFile reads', async () => {
    const original = `${JSON.stringify({ clients: [{ groupId: MEHTA, name: 'Mehta Foods', code: 'MEH', emailDomains: ['mehtafoods.in'] }] }, null, 2)}\n`;
    const [viaStore, viaWriter] = [join(dir, 'a.json'), join(dir, 'b.json')];
    for (const f of [viaStore, viaWriter]) writeFileSync(f, original);
    const [dbA, dbB] = [openDb(':memory:'), openDb(':memory:')];
    const store = fileGroupsStore(viaStore, { db: dbA });
    const r1 = await store.apply(approve(SHARMA, 'Sharma Interiors', 'SHA'));
    const r2 = await applyGroupChanges(viaWriter, approve(SHARMA, 'Sharma Interiors', 'SHA'), { db: dbB });
    expect(readFileSync(viaStore, 'utf8')).toBe(readFileSync(viaWriter, 'utf8'));
    expect(r1).toEqual(r2);
    expect(r1.warning).toBeUndefined();
    expect(await store.list()).toEqual(loadGroupsFile(viaStore));
    expect(readFileSync(`${viaStore}.bak`, 'utf8')).toBe(original);
  });
});
