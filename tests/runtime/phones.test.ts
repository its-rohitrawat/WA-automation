import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEntry } from '../../src/control/errors.ts';
import { workspacePhones } from '../../src/runtime/phones.ts';
import type { Db, Sql } from '../../src/store/db.ts';
import { getKv } from '../../src/store/kv.ts';
import { manualClock } from '../../src/util/clock.ts';
import { silentLogger } from '../../src/util/logger.ts';
import type { AllowList } from '../../src/wa/allowlist.ts';
import { accountNameOf, openPhoneSession, openSessionDb, phoneNumberIn, phoneSessionKey, useEncryptedAuthState, type EncryptedAuth, type ReadingPhone, type SessionHome } from '../../src/wa/authState.ts';
import type { GatewayLike, GatewayState, GatewayStatus } from '../../src/wa/gateway.ts';
import { PHONES_KV_KEY } from '../../src/wa/phoneList.ts';
import { SHARMA, testDb } from '../helpers/db.ts';

// A workspace's reading phones in its runtime (lane C, change 7, task 9): phone 1 is the runtime's own session and auth
// (no relink); phones 2 to 5 come from its phone list. The gateways here are fakes that record what each was built with.
// The sessions follow wa_auth's shape after P7 (in memory, as tests/wa/authStatePhones.test.ts does).

const AT = '2026-11-02T10:00:00.000Z';
const OWNER = 'owner@example.com';
const WA_AUTH_P7 = `CREATE TABLE wa_auth (
  phone text NOT NULL CHECK (phone IN ('founder', 'phone2', 'phone3', 'phone4', 'phone5', 'spare')),
  slot text NOT NULL DEFAULT 'live' CHECK (slot IN ('live', 'backup')), k text NOT NULL, v blob NOT NULL,
  PRIMARY KEY (phone, slot, k))`;
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

/**
 * A gateway that records the allow-list and auth it was built with; open once started. A link's gateway (one given a QR
 * callback) opens as if `scanAs` scanned it (WhatsApp's name for the account: `scanName`, else "x"), or never opens with
 * `linkHangs`. endLink answers as `endLink` says.
 */
interface FakeOptions {
  scanAs?: string;
  scanName?: string;
  linkHangs?: boolean;
  endLink?: () => Promise<boolean>;
}

function fakeBuild(o: FakeOptions = {}) {
  const built: { allow: AllowList; auth: EncryptedAuth; gateway: GatewayLike }[] = [];
  const build = (allow: AllowList, auth: EncryptedAuth, onQr?: (qr: string) => void): GatewayLike => {
    let state: GatewayState = 'stopped';
    const statusFns: ((s: GatewayStatus) => void)[] = [];
    const status = (): GatewayStatus => ({ state, since: AT, lastErrorCode: null, credsSaveFailures: 0 });
    const set = (s: GatewayState) => {
      state = s;
      for (const fn of statusFns) fn(status());
    };
    const n = built.length; // which build this is: the sockets say so
    // Answers for any group while open (unlike a real gateway, which also checks its allow-list): so a test sees which
    // phone was asked, and a wrong route shows as the wrong build, not as a null the allow-list would give anyway.
    const own = (_groupId: string) => state === 'open';
    const gateway: GatewayLike = {
      onEvent: () => undefined, onStatus: (fn) => void statusFns.push(fn), onHistory: () => undefined, status,
      start: () => {
        if (onQr && o.linkHangs) return set('connecting');
        if (!onQr || !o.scanAs) return set('open');
        // As WhatsApp does: the scanned number is saved, then the link opens.
        auth.state.creds.me = { id: `${o.scanAs}:9@s.whatsapp.net`, name: o.scanName ?? 'x' };
        void auth.saveCreds().then(() => set('open'));
      },
      stop: async () => set('stopped'), listGroups: async () => [], failedCount: () => 0, droppedCount: () => 0,
      endLink: o.endLink ?? (async () => true),
      groupSocket: (groupId) => (own(groupId) ? ({ send: `build ${n}` } as never) : null),
      groupMembers: async (groupId) => (own(groupId) ? ([{ from: `build ${n}` }] as never) : null),
      chatDeleteSocket: (groupId) => (own(groupId) ? ({ delete: `build ${n}` } as never) : null),
    };
    built.push({ allow, auth, gateway });
    return gateway;
  };
  return { built, build };
}

/** A linked session for a phone, sealed as the runtime seals it. */
async function linkedSession(home: SessionHome, key: Buffer, phone: ReadingPhone, number: string): Promise<{ db: Db; auth: EncryptedAuth }> {
  const db = await openPhoneSession(home, phone);
  const auth = await useEncryptedAuthState(db, phoneSessionKey(key, phone));
  auth.state.creds.me = { id: `${number}:2@s.whatsapp.net`, name: 'x' };
  await auth.saveCreds();
  return { db, auth };
}

async function setup(o: FakeOptions & {
  phone1Linked?: boolean;
  beforeOpen?: (d: { db: Db; home: SessionHome; key: Buffer }) => Promise<void>;
  spareNumber?: () => Promise<string | undefined>;
} = {}) {
  const db = await testDb();
  const base = openSessionDb(':memory:');
  cleanup.push(() => base.close());
  await base.exec(WA_AUTH_P7);
  const home: SessionHome = { engine: 'postgres', db: base };
  const key = randomBytes(32);
  const phone1 = o.phone1Linked === false
    ? { db: await openPhoneSession(home, 'founder'), auth: undefined as unknown as EncryptedAuth }
    : await linkedSession(home, key, 'founder', '919800000001');
  if (o.phone1Linked === false) phone1.auth = await useEncryptedAuthState(phone1.db, key);
  await o.beforeOpen?.({ db, home, key });
  const audits: AuditEntry[] = [];
  const f = fakeBuild(o);
  const phones = await workspacePhones({
    db, sessions: home, key, clock: manualClock(AT), log: silentLogger(), configs: [SHARMA],
    phone1: { sessionDb: phone1.db, auth: phone1.auth, linked: o.phone1Linked !== false },
    buildGateway: f.build, audit: async (_q: Sql, e: AuditEntry) => void audits.push(e),
    ...(o.spareNumber ? { spareNumber: o.spareNumber } : {}),
  });
  cleanup.push(() => phones.close());
  return { db, base, home, key, phones, audits, ...f, phone1 };
}

const hooks = { qr: () => undefined, opening: () => undefined };
/** Phones 1 and 2 stored, phone 2 linked to 919800000002. */
const phone2Linked = async ({ db, home, key }: { db: Db; home: SessionHome; key: Buffer }) => {
  await linkedSession(home, key, 'phone2', '919800000002');
  await db.run('INSERT INTO kv (k, v) VALUES (?, ?)', [PHONES_KV_KEY, JSON.stringify({ phones: [
    { id: 1, label: 'Phone 1', state: 'active', addedAt: null }, { id: 2, label: 'Front desk', state: 'active', addedAt: AT },
  ] })]);
};

describe('a workspace’s phones in its runtime', () => {
  it('with nothing stored: phone 1 alone, on its own session and auth (no relink), reading every approved group', async () => {
    const t = await setup();
    expect(t.phones.set.phones().map((p) => [p.id, p.label])).toEqual([[1, 'Phone 1']]);
    expect(t.built).toHaveLength(1);
    expect(t.built[0]!.auth).toBe(t.phone1.auth); // the runtime's own auth, not a new one
    expect(t.built[0]!.allow.has(SHARMA.groupId)).toBe(true);
    expect(t.phones.numbers()).toEqual(['919800000001']);
    expect(await getKv(t.db, PHONES_KV_KEY)).toBeUndefined(); // nothing written
    expect(t.phones.driver('founder')).toBeDefined();
    expect(t.phones.driver('phone2')).toBeUndefined(); // not added: the route answers 404
  });

  it('phone 1 not linked: setup mode as before, no gateway built until a link', async () => {
    const t = await setup({ phone1Linked: false });
    expect(t.built).toHaveLength(0);
    expect(t.phones.set.phones().map((p) => p.status.state)).toEqual(['not_linked']);
    expect(t.phones.numbers()).toEqual([]);
  });

  it('a stored phone 2 starts on its own session and subkey, beside phone 1', async () => {
    const t = await setup({
      beforeOpen: async ({ db, home, key }) => {
        await linkedSession(home, key, 'phone2', '919800000002');
        await db.run('INSERT INTO kv (k, v) VALUES (?, ?)', [PHONES_KV_KEY, JSON.stringify({ phones: [
          { id: 1, label: 'Phone 1', state: 'active', addedAt: null }, { id: 2, label: 'Front desk', state: 'active', addedAt: AT },
        ] })]);
      },
    });
    expect(t.phones.set.phones().map((p) => [p.id, p.label])).toEqual([[1, 'Phone 1'], [2, 'Front desk']]);
    expect(t.built).toHaveLength(2);
    expect(t.built[1]!.auth.state.creds.me?.id).toMatch(/^919800000002/);
    expect(t.built[1]!.allow.has(SHARMA.groupId)).toBe(false); // Sharma is phone 1's
    expect(t.phones.numbers().sort()).toEqual(['919800000001', '919800000002']);
  });

  it('a phone stored as unlinked does not start again after a restart: its groups are read by no phone', async () => {
    const t = await setup({
      beforeOpen: async ({ db, home, key }) => {
        await linkedSession(home, key, 'phone2', '919800000002'); // rows that were not cleared (a failed clear)
        await db.run('INSERT INTO kv (k, v) VALUES (?, ?)', [PHONES_KV_KEY, JSON.stringify({ phones: [
          { id: 1, label: 'Phone 1', state: 'active', addedAt: null },
          { id: 2, label: 'Front desk', state: 'unlinked', addedAt: AT, unlinkedAt: AT },
        ] })]);
      },
    });
    expect(t.phones.set.phones().map((p) => p.id)).toEqual([1]);
    expect(t.built).toHaveLength(1); // no gateway for phone 2
    t.phones.setConfigs([{ ...SHARMA, phone: 2 }]);
    expect(t.phones.connected(SHARMA.groupId)).toBe(false);
    expect(t.phones.routes.list().map((p) => [p.id, p.state, p.status])).toEqual([[1, 'active', 'stopped'], [2, 'unlinked', null]]);
  });

  it('add, rename, list and unlink change only that phone', async () => {
    const t = await setup();
    const added = await t.phones.routes.add('Sales', OWNER);
    expect(added.id).toBe(2);
    expect(t.phones.set.phones().map((p) => [p.id, p.status.state])).toEqual([[1, 'stopped'], [2, 'not_linked']]);
    await t.phones.routes.rename(2, 'Sales desk', OWNER);
    expect(t.phones.set.phones()[1]!.label).toBe('Sales desk');
    expect(t.phones.routes.list()).toEqual([
      { id: 1, label: 'Phone 1', state: 'active', number: expect.stringMatching(/0001$/), status: 'stopped', groups: 1, accountName: 'x' },
      { id: 2, label: 'Sales desk', state: 'active', number: null, status: 'not_linked', groups: 0, accountName: null },
    ]);
    expect(JSON.stringify(t.phones.routes.list())).not.toContain('919800000001');
    const r = await t.phones.routes.unlink(2, OWNER);
    expect(r.phone.state).toBe('unlinked');
    expect(t.phones.set.phones().map((p) => p.id)).toEqual([1]);
    expect(t.audits.map((a) => a.event)).toEqual(['phone.added', 'phone.renamed', 'phone.unlinked']);
  });

  it('an unlinked phone joins the set for a link, and leaves again when the link is not kept', async () => {
    const t = await setup();
    await t.phones.routes.add('Sales', OWNER);
    await t.phones.routes.unlink(2, OWNER);
    const driver = t.phones.driver('phone2')!;
    const stopped = new AbortController();
    stopped.abort('cancelled');
    const outcome = await driver.run({ qr: () => undefined, opening: () => undefined }, stopped.signal);
    expect(outcome.ok).toBe(false);
    expect(t.phones.set.phones().map((p) => p.id)).toEqual([1]);
    expect(t.phones.list.get(2)?.state).toBe('unlinked');
  });

  it('Open chat’s connected is per group: phone 2’s group is not connected while phone 1 is open', async () => {
    const t = await setup();
    await t.phones.routes.add('Sales', OWNER);
    const MEHTA_GROUP = '120363000000000002@g.us';
    t.phones.setConfigs([SHARMA, { ...SHARMA, groupId: MEHTA_GROUP, code: 'MEH', phone: 2 }]);
    t.phones.set.start(); // phone 1 opens; phone 2 is not linked
    expect(t.phones.connected(SHARMA.groupId)).toBe(true);
    expect(t.phones.connected(MEHTA_GROUP)).toBe(false); // its own phone is down, though phone 1 is up
    expect(t.phones.connected('120363000000000009@g.us')).toBe(false); // approved nowhere
    expect(t.phones.connected()).toBe(true); // without a group: any phone open
    await t.phones.set.stop();
  });

  it('Open chat’s send, members and Delete chat go through the group’s own phone, never another (the runtime’s chat deps)', async () => {
    const MEHTA_GROUP = '120363000000000002@g.us';
    const t = await setup({
      beforeOpen: async ({ db, home, key }) => {
        await linkedSession(home, key, 'phone2', '919800000002');
        await db.run('INSERT INTO kv (k, v) VALUES (?, ?)', [PHONES_KV_KEY, JSON.stringify({ phones: [
          { id: 1, label: 'Phone 1', state: 'active', addedAt: null }, { id: 2, label: 'Front desk', state: 'active', addedAt: AT },
        ] })]);
      },
    });
    t.phones.setConfigs([SHARMA, { ...SHARMA, groupId: MEHTA_GROUP, code: 'MEH', phone: 2 }]);
    t.phones.set.start();
    const chat = t.phones.chat;
    // Build 0 is phone 1's gateway, build 1 phone 2's.
    expect(chat.chatDeleteSocket(MEHTA_GROUP)).toEqual({ delete: 'build 1' });
    expect(chat.chatDeleteSocket(SHARMA.groupId)).toEqual({ delete: 'build 0' });
    expect(chat.groupSocket(MEHTA_GROUP)).toEqual({ send: 'build 1' });
    expect(await chat.groupMembers(MEHTA_GROUP)).toEqual([{ from: 'build 1' }]);
    // Phone 2 down: its group gets nothing (phone 1 is up, but it is not that group's phone).
    await t.built[1]!.gateway.stop();
    expect(chat.connected(MEHTA_GROUP)).toBe(false);
    expect(chat.chatDeleteSocket(MEHTA_GROUP)).toBeNull();
    expect(chat.groupSocket(MEHTA_GROUP)).toBeNull();
    expect(await chat.groupMembers(MEHTA_GROUP)).toBeNull();
    await t.phones.set.stop();
  });

  it('a new group config moves a group to phone 2’s allow-list', async () => {
    const t = await setup();
    await t.phones.routes.add('Sales', OWNER);
    t.phones.setConfigs([{ ...SHARMA, phone: 2 }]);
    expect(t.built[0]!.allow.has(SHARMA.groupId)).toBe(false);
    expect(t.phones.set.phoneOf(SHARMA.groupId)).toBe(2);
  });
});

describe('WhatsApp’s own name for each phone (owner follow-up, 2 Nov)', () => {
  /** As Baileys does when WhatsApp says the account's name (a creds.update): a new `me` on the same creds. */
  const rename = (auth: EncryptedAuth, me: { name?: string; notify?: string }) => {
    const c = auth.state.creds;
    c.me = { id: c.me!.id, ...me };
  };

  it('lists the name WhatsApp keeps for each linked phone, as it changes, and none once a phone is unlinked', async () => {
    const t = await setup({ beforeOpen: phone2Linked });
    const names = () => t.phones.routes.list().map((p) => p.accountName);
    expect(names()).toEqual(['x', 'x']); // the name each saved link carries
    rename(t.built[0]!.auth, { name: 'Rohit Rawat' });
    rename(t.built[1]!.auth, { notify: 'Front desk team' }); // no profile name: the name WhatsApp shows others
    expect(names()).toEqual(['Rohit Rawat', 'Front desk team']);
    expect(JSON.stringify(t.phones.routes.list())).not.toMatch(/919800000001|919800000002/); // never the number
    await t.phones.routes.unlink(2, OWNER);
    expect(names()).toEqual(['Rohit Rawat', null]);
  });

  it('a phone just added has none; once linked, the name of the account that scanned it', async () => {
    const t = await setup({ scanAs: '919800000022', scanName: 'Sales <b>team</b>' });
    await t.phones.routes.add('Sales', OWNER);
    expect(t.phones.routes.list()[1]!.accountName).toBeNull();
    expect(await t.phones.driver('phone2')!.run(hooks, new AbortController().signal)).toMatchObject({ ok: true });
    expect(t.phones.routes.list()[1]!.accountName).toBe('Sales <b>team</b>'); // text: the page escapes it
  });

  it('the name is untrusted text: one line, no control or invisible characters, at most 60 characters, never a number', () => {
    expect(accountNameOf({ name: 'Rohit\u200B Ra\u202Ewat\u0007\n' })).toBe('Rohit Rawat');
    expect(accountNameOf({ name: 'Front\u0000\u0085desk' })).toBe('Front desk');
    expect(accountNameOf({ name: 'A'.repeat(70) })).toBe('A'.repeat(60));
    expect(accountNameOf({ name: `${'A'.repeat(59)}😀😀` })).toBe(`${'A'.repeat(59)}😀`); // never half an emoji
    expect(accountNameOf({ name: '  Desk  ', notify: 'Other' })).toBe('Desk');
    expect(accountNameOf({ notify: 'Desk' })).toBe('Desk');
    // Unknown: nothing, blank, Baileys' "~" (a pairing-code link before WhatsApp says the name), or a phone number.
    for (const me of [undefined, {}, { name: '' }, { name: ' \u200B ' }, { name: '~' }, { name: '+91 98000 00002' }, { name: 'Desk 1234567' }, { name: 7 as unknown as string }]) {
      expect(accountNameOf(me), JSON.stringify(me)).toBeNull();
    }
    expect(accountNameOf({ name: 'Desk 123456' })).toBe('Desk 123456'); // up to 6 digits is a name
  });
});

describe('a phone’s session never outlives it (security review S1)', () => {
  const NO_DELETE = "CREATE TRIGGER no_delete BEFORE DELETE ON wa_auth BEGIN SELECT RAISE(ABORT, 'refused'); END";

  it('remove refuses a linked phone; unlinked, its rows are cleared before its number is freed, or it is not removed', async () => {
    const t = await setup({ beforeOpen: phone2Linked });
    await expect(t.phones.routes.remove(2, OWNER)).rejects.toMatchObject({ status: 409, message: 'Front desk is linked. Unlink it first.' });
    expect(t.phones.list.get(2)?.state).toBe('active');
    await t.phones.routes.unlink(2, OWNER);
    await linkedSession(t.home, t.key, 'phone2', '919800000002'); // rows a failed clear left
    // The clear fails: the phone stays, so its number is not given out with the rows.
    await t.base.exec(NO_DELETE);
    await expect(t.phones.routes.remove(2, OWNER)).rejects.toThrow();
    expect(t.phones.list.get(2)?.state).toBe('unlinked');
    await t.base.exec('DROP TRIGGER no_delete');
    await t.phones.routes.remove(2, OWNER);
    expect(t.phones.list.get(2)).toBeUndefined();
    expect(await phoneNumberIn(t.home, t.key, 'phone2')).toBeUndefined();
    // A phone that was never linked goes at once.
    await t.phones.routes.add('Sales', OWNER);
    await t.phones.routes.remove(2, OWNER);
    expect(t.phones.list.list().map((p) => p.id)).toEqual([1]);
  });

  it('add clears rows left under its number; when it cannot, the phone still starts unlinked and needs a QR', async () => {
    const t = await setup({ scanAs: '919800000022', beforeOpen: async ({ home, key }) => void (await linkedSession(home, key, 'phone2', '919800000002')) });
    await t.base.exec(NO_DELETE);
    const added = await t.phones.routes.add('Sales', OWNER);
    expect(added.id).toBe(2);
    expect(t.built).toHaveLength(1); // nothing built from the rows that were left
    expect(t.phones.routes.list()[1]).toMatchObject({ id: 2, number: null, status: 'not_linked' });
    expect(t.phones.numbers()).toEqual(['919800000001']);
    await t.base.exec('DROP TRIGGER no_delete');
    // It links by its own QR, to the number that scanned it.
    expect(await t.phones.driver('phone2')!.run(hooks, new AbortController().signal)).toMatchObject({ ok: true });
    expect(t.phones.numbers().sort()).toEqual(['919800000001', '919800000022']);
    // And when the clear works, the rows are gone at once.
    const u = await setup({ beforeOpen: async ({ home, key }) => void (await linkedSession(home, key, 'phone2', '919800000002')) });
    await u.phones.routes.add('Sales', OWNER);
    expect(await phoneNumberIn(u.home, u.key, 'phone2')).toBeUndefined();
    expect(u.phones.routes.list()[1]).toMatchObject({ number: null, status: 'not_linked' });
  });
});

describe('a link and an unlink or removal of the same phone never overlap (security review S5)', () => {
  it('while a phone is being linked, its unlink and its removal are refused', async () => {
    const t = await setup({ linkHangs: true });
    await t.phones.routes.add('Sales', OWNER);
    const stop = new AbortController();
    const running = t.phones.driver('phone2')!.run(hooks, stop.signal);
    await expect(t.phones.routes.unlink(2, OWNER)).rejects.toMatchObject({ status: 409, message: 'Sales is being linked. Finish or cancel that link first.' });
    await expect(t.phones.routes.remove(2, OWNER)).rejects.toMatchObject({ status: 409 });
    stop.abort();
    expect((await running).ok).toBe(false);
    await t.phones.routes.unlink(2, OWNER); // free again once the link ended
    expect(t.phones.list.get(2)?.state).toBe('unlinked');
  });

  it('while a phone is being unlinked, a link of it is refused at once, and nothing reactivates it', async () => {
    let answer!: (v: boolean) => void;
    const t = await setup({ beforeOpen: phone2Linked, endLink: () => new Promise<boolean>((r) => (answer = r)) });
    t.phones.set.start();
    const unlinking = t.phones.routes.unlink(2, OWNER);
    expect(await t.phones.driver('phone2')!.run(hooks, new AbortController().signal)).toEqual({ ok: false, code: 'phone_busy' });
    answer(true);
    await unlinking;
    expect(t.phones.list.get(2)?.state).toBe('unlinked');
    expect(t.phones.set.phones().map((p) => p.id)).toEqual([1]);
    await t.phones.set.stop();
  });
});

describe('a reading phone refuses the spare’s number too (security review N7)', () => {
  it('a link scanned with the spare’s number is undone, as one with another reading phone’s', async () => {
    const t = await setup({ scanAs: '919800000009', spareNumber: async () => '919800000009' });
    await t.phones.routes.add('Sales', OWNER);
    expect(await t.phones.driver('phone2')!.run(hooks, new AbortController().signal)).toEqual({ ok: false, code: 'number_in_use' });
    expect(t.phones.numbers()).toEqual(['919800000001']);
    const u = await setup({ scanAs: '919800000001' }); // phone 1's own number
    await u.phones.routes.add('Sales', OWNER);
    expect(await u.phones.driver('phone2')!.run(hooks, new AbortController().signal)).toEqual({ ok: false, code: 'number_in_use' });
    const v = await setup({ scanAs: '919800000002', spareNumber: async () => '919800000009' });
    await v.phones.routes.add('Sales', OWNER);
    expect(await v.phones.driver('phone2')!.run(hooks, new AbortController().signal)).toMatchObject({ ok: true });
  });
});
