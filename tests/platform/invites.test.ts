import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlatformError } from '../../src/platform/errors.ts';
import {
  cancelInvite, createInvite, INVITES_PER_DAY, inviteForSignup, linksLeftToday, listInvites, markSending, maskAddress, newLink, recordSend, redeemInvite,
  type InviteDeps,
} from '../../src/platform/invites.ts';
import { ensurePlatformSchema } from '../../src/platform/schema.ts';
import { ensureFounderTenant, FOUNDER_TENANT_ID, getTenant, listTenants, membershipsFor } from '../../src/platform/store.ts';
import { INVITE_TTL_MS, inviteTokenHash, newInviteToken, normalizeEmail } from '../../src/platform/tokens.ts';
import type { Db } from '../../src/store/db.ts';
import type { Params, Sql } from '../../src/store/engine/types.ts';
import { onSqlite } from '../helpers/db.ts';
import { platformTestDb, type PlatformTestDb } from '../helpers/platformTestDb.ts';
import { manualClock, type ManualClock } from '../../src/util/clock.ts';

const FOUNDER = 'founder@example.com';
const T0 = '2026-10-29T06:00:00.000Z';

let store: PlatformTestDb;
let db: Db;
let clock: ManualClock;
let d: InviteDeps;

beforeEach(async () => {
  store = await platformTestDb();
  db = store.db;
  clock = manualClock(T0);
  d = { db, clock };
});
afterEach(async () => {
  await store.close();
});

const refusal = async (p: Promise<unknown>): Promise<PlatformError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof PlatformError) return e;
    throw e;
  }
  throw new Error('expected a PlatformError');
};
const invite = (business = 'Kapoor Design Studio', email = 'Kapoor.Studio@Example.com') => createInvite(d, FOUNDER, { business, email });
/** Every value stored in the platform tables, as one string. */
const everything = async () => JSON.stringify(await Promise.all(['tenants', 'users', 'memberships', 'invites', 'platform_audit'].map((t) => db.all(`SELECT * FROM ${t}`))));

describe('invite tokens', () => {
  it('are 32 random bytes in base64url; only their SHA-256 is kept', () => {
    const a = newInviteToken();
    const b = newInviteToken();
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a.token, 'base64url')).toHaveLength(32);
    expect(a.hash).toBe(createHash('sha256').update(a.token).digest('hex'));
    expect(a.token).not.toBe(b.token);
    for (const bad of ['', 'short', `${a.token}x`, `${a.token.slice(0, 42)}=`, `${a.token.slice(0, 42)}/`, null, 42]) expect(inviteTokenHash(bad)).toBeNull();
  });

  it('emails are trimmed and lower-cased; anything that is not one address is refused', () => {
    expect(normalizeEmail('  Kapoor.Studio@Example.COM ')).toBe('kapoor.studio@example.com');
    for (const bad of ['', 'no-at', 'a@b', 'two@@x.com', 'a b@x.com', 'a@x.com, b@y.com', '<a@x.com>', 1, null]) {
      expect(normalizeEmail(bad), String(bad)).toBeNull();
    }
  });
});

describe('the platform tables', () => {
  // SQLite only: ensurePlatformSchema is SQLite's; on Postgres P1 and P3 made the tables (the next test).
  it.runIf(onSqlite)('are made once and can be ensured again without change; the founder is customer #1, made once', async () => {
    await ensurePlatformSchema(db);
    const a = await ensureFounderTenant(db, { name: 'Your studio', at: T0 });
    const b = await ensureFounderTenant(db, { name: 'Another name', at: T0 });
    expect(b.id).toBe(a.id);
    // The fixed id S2 seeds in Postgres (gap G1), so the copy tool and TENANT_ID agree on customer #1.
    expect(a.id).toBe('00000000-0000-4000-8000-000000000001');
    expect(FOUNDER_TENANT_ID).toBe(a.id);
    expect(a).toMatchObject({ kind: 'founder', status: 'active', name: 'Your studio' });
    await expect(db.run("INSERT INTO tenants (id, kind, name, status, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000009', 'founder', 'x', 'active', ?, ?)", [T0, T0])).rejects.toThrow(/UNIQUE/);
  });

  it.runIf(!onSqlite)('on Postgres P1 seeded the founder as customer #1: ensureFounderTenant finds it, and a second founder is refused', async () => {
    const a = await ensureFounderTenant(db, { name: 'Your studio', at: T0 });
    expect(a.id).toBe(FOUNDER_TENANT_ID);
    expect(a).toMatchObject({ kind: 'founder', status: 'active' });
    expect((await ensureFounderTenant(db, { name: 'Another name', at: T0 })).id).toBe(a.id);
    await expect(db.run("INSERT INTO tenants (id, kind, name, status, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000009', 'founder', 'x', 'active', ?, ?)", [T0, T0])).rejects.toThrow(/unique/i);
  });
});

describe('creating an invite', () => {
  it('makes an invited customer and an open invite for the lower-cased email; the database keeps only the token hash', async () => {
    const { invite: v, token } = await invite();
    expect(v).toMatchObject({ business: 'Kapoor Design Studio', email: 'kapoor.studio@example.com', status: 'open', send: 'none', createdAt: T0 });
    expect(Date.parse(v.expiresAt) - Date.parse(T0)).toBe(INVITE_TTL_MS);
    expect(await getTenant(db, v.tenantId)).toMatchObject({ status: 'invited', kind: 'customer' });
    const stored = await everything();
    expect(stored).not.toContain(token);
    expect(stored).toContain(inviteTokenHash(token)!);
    expect(JSON.stringify(await listInvites(d))).not.toContain(inviteTokenHash(token)!);
    expect(await db.all('SELECT actor, event, detail FROM platform_audit')).toEqual([
      { actor: FOUNDER, event: 'invite.created', detail: `Kapoor Design Studio · ${maskAddress('kapoor.studio@example.com')}` },
    ]);
  });

  it('refuses a missing name, a bad address, and a second open invite for the same address (any case)', async () => {
    expect(await refusal(invite('   '))).toMatchObject({ status: 400 });
    expect(await refusal(invite('x'.repeat(81)))).toMatchObject({ status: 400 });
    expect(await refusal(invite('Kapoor', 'not-an-email'))).toMatchObject({ status: 400 });
    await invite();
    expect(await refusal(invite('Kapoor again', 'KAPOOR.studio@example.com'))).toMatchObject({ status: 409, code: 'already_open' });
    expect((await listTenants(db)).filter((t) => t.kind === 'customer')).toHaveLength(1); // Postgres also lists the founder
  });

  it('a name is one line of plain text: control and direction characters become spaces', async () => {
    const { invite: v } = await invite(`Kapoor\nDesign${String.fromCharCode(0x202e)}Studio${String.fromCharCode(0)}`);
    expect(v.business).toBe('Kapoor Design Studio');
  });

  it('20 links a day per founder (new invites and new links); the next day the count starts again', async () => {
    for (let i = 0; i < INVITES_PER_DAY; i++) await invite(`Business ${i}`, `b${i}@example.com`);
    expect(await linksLeftToday(d, FOUNDER)).toBe(0);
    expect(await refusal(invite('One more', 'more@example.com'))).toMatchObject({ status: 429, code: 'invite_limit' });
    const first = (await listInvites(d)).at(-1)!;
    expect(await refusal(newLink(d, FOUNDER, first.id))).toMatchObject({ status: 429 });
    // Another founder has their own count.
    await createInvite(d, 'other@example.com', { business: 'Theirs', email: 'theirs@example.com' });
    clock.advance(86_400_000);
    await invite('One more', 'more@example.com');
    expect(await linksLeftToday(d, FOUNDER)).toBe(INVITES_PER_DAY - 1);
  });
});

describe('links, cancelling and expiry', () => {
  it('a new link replaces the old one (which stops working) and gives 7 more days', async () => {
    const { invite: v, token: old } = await invite();
    clock.advance(3 * 86_400_000);
    const { token } = await newLink(d, FOUNDER, v.id);
    expect(token).not.toBe(old);
    expect(await inviteForSignup(d, old)).toBeNull();
    expect(await inviteForSignup(d, token)).toEqual({ business: 'Kapoor Design Studio', expiresAt: new Date(clock.now().getTime() + INVITE_TTL_MS).toISOString() });
    expect((await db.all('SELECT event FROM platform_audit')).map((r) => (r as { event: string }).event)).toEqual(['invite.created', 'invite.new_link']);
  });

  it('expires after 7 days: the list says expired, the link no longer works, a new link opens it again', async () => {
    const { invite: v, token } = await invite();
    clock.advance(INVITE_TTL_MS);
    expect((await listInvites(d))[0]!.status).toBe('expired');
    expect(await inviteForSignup(d, token)).toBeNull();
    expect(await redeemInvite(d, { token, email: 'kapoor.studio@example.com' })).toEqual({ ok: false, reason: 'invalid' });
    const again = await newLink(d, FOUNDER, v.id);
    expect(again.invite.status).toBe('open');
  });

  it('a cancelled invite\'s link stops working; it cannot be cancelled or relinked again; the address can be invited anew', async () => {
    const { invite: v, token } = await invite();
    expect((await cancelInvite(d, FOUNDER, v.id)).status).toBe('cancelled');
    expect(await inviteForSignup(d, token)).toBeNull();
    expect(await refusal(cancelInvite(d, FOUNDER, v.id))).toMatchObject({ status: 409 });
    expect(await refusal(newLink(d, FOUNDER, v.id))).toMatchObject({ status: 409 });
    expect(await refusal(newLink(d, FOUNDER, '00000000-0000-4000-8000-000000000000'))).toMatchObject({ status: 404 });
    await invite();
  });
});

describe('the email\'s send state', () => {
  it('is marked sending (and audited) before the call, then sent; an unclear outcome stays unknown', async () => {
    const { invite: v } = await invite();
    await markSending(d, FOUNDER, v.id);
    expect((await listInvites(d))[0]!.send).toBe('sending');
    clock.advance(1000);
    expect((await recordSend(d, FOUNDER, v.id, { state: 'sent' })).send).toBe('sent');
    const { invite: w } = await invite('Gupta Events', 'gupta@example.com');
    await markSending(d, FOUNDER, w.id);
    expect((await recordSend(d, FOUNDER, w.id, { state: 'unknown', code: 'timeout' })).send).toBe('unknown');
    const events = (await db.all<{ event: string }>('SELECT event FROM platform_audit ORDER BY id')).map((r) => r.event);
    expect(events).toEqual(['invite.created', 'invite.email_attempt', 'invite.email_sent', 'invite.created', 'invite.email_attempt', 'invite.email_unknown']);
    // A cancelled invite is never marked as being sent.
    await cancelInvite(d, FOUNDER, w.id);
    expect(await refusal(markSending(d, FOUNDER, w.id))).toMatchObject({ status: 409 });
  });
});

describe('redeeming an invite at sign-up', () => {
  it('only for the invited Google account (any case): the invite is used once, the owner membership made, the customer onboarding', async () => {
    const { invite: v, token } = await invite();
    expect(await redeemInvite(d, { token, email: 'someone.else@example.com' })).toEqual({ ok: false, reason: 'wrong_account' });
    expect((await listInvites(d))[0]!.status).toBe('open');
    const r = await redeemInvite(d, { token, email: 'KAPOOR.Studio@example.com', name: 'Asha Kapoor' });
    expect(r).toMatchObject({ ok: true, tenantId: v.tenantId });
    expect(await getTenant(db, v.tenantId)).toMatchObject({ status: 'onboarding', signedUpAt: T0 });
    expect(await membershipsFor(db, 'kapoor.studio@example.com')).toEqual([{ tenantId: v.tenantId, role: 'owner', status: 'onboarding' }]);
    expect((await listInvites(d))[0]).toMatchObject({ status: 'accepted', usedAt: T0 });
    expect(await redeemInvite(d, { token, email: 'kapoor.studio@example.com' })).toEqual({ ok: false, reason: 'invalid' });
    expect(await inviteForSignup(d, token)).toBeNull();
  });

  it('several workspaces: listed oldest membership first, ties by workspace id, so the first one is always the same', async () => {
    const join = async (business: string) => {
      const { token } = await invite(business);
      const r = await redeemInvite(d, { token, email: 'kapoor.studio@example.com' });
      if (!r.ok) throw new Error(r.reason);
      return r.tenantId;
    };
    const same = [await join('Kapoor One'), await join('Kapoor Two'), await join('Kapoor Three')]; // all joined at T0
    clock.advance(60_000);
    const later = await join('Kapoor Four');
    const order = (await membershipsFor(db, 'kapoor.studio@example.com')).map((m) => m.tenantId);
    expect(order).toEqual([...same.sort(), later]);
  });

  it('a link that does not work says only "invalid": unknown, malformed, cancelled or used', async () => {
    const { invite: v, token } = await invite();
    for (const t of ['nonsense', newInviteToken().token, '', undefined]) expect(await redeemInvite(d, { token: t, email: 'kapoor.studio@example.com' })).toEqual({ ok: false, reason: 'invalid' });
    await cancelInvite(d, FOUNDER, v.id);
    expect(await redeemInvite(d, { token, email: 'kapoor.studio@example.com' })).toEqual({ ok: false, reason: 'invalid' });
  });

  it('two redeems at the same moment: exactly one wins; the others get what a used link gets, nothing more', async () => {
    const { token } = await invite();
    const results = await Promise.all([1, 2, 3].map(() => redeemInvite(d, { token, email: 'kapoor.studio@example.com' })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'invalid' }, { ok: false, reason: 'invalid' }]);
    expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM memberships'))!.n).toBe(1);
    expect((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE email = 'kapoor.studio@example.com'"))!.n).toBe(1);
  });

  it('a refusal never uses the invite up: a wrong account or an expired link leaves it open', async () => {
    const { invite: v, token } = await invite();
    expect(await redeemInvite(d, { token, email: 'someone.else@example.com' })).toEqual({ ok: false, reason: 'wrong_account' });
    clock.advance(INVITE_TTL_MS);
    expect(await redeemInvite(d, { token, email: 'kapoor.studio@example.com' })).toEqual({ ok: false, reason: 'invalid' }); // expired
    expect(await db.get('SELECT status, used_at AS usedAt, used_by AS usedBy FROM invites WHERE id = ?', [v.id])).toEqual({ status: 'open', usedAt: null, usedBy: null });
    expect(await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users'))!.toEqual({ n: 0 });
    // Before it expires, the right account still wins after a wrong one.
    const second = await invite('Kapoor Events', 'events@example.com');
    expect(await redeemInvite(d, { token: second.token, email: 'not.events@example.com' })).toEqual({ ok: false, reason: 'wrong_account' });
    expect(await redeemInvite(d, { token: second.token, email: 'events@example.com' })).toMatchObject({ ok: true, tenantId: second.invite.tenantId });
  });

  it('a redeem whose later step fails gives the claim back: nothing of it stays, and the next redeem wins', async () => {
    const { invite: v, token } = await invite();
    // The membership insert fails once, after the invite was claimed and the user made: the database's own failure, on
    // either engine, with no trigger.
    let failNext = true;
    const failing = (q: Sql): Sql => new Proxy(q, {
      get(t, p) {
        if (p === 'run') {
          return async (sql: string, params?: Params) => {
            if (failNext && /^\s*INSERT INTO memberships/.test(sql)) {
              failNext = false;
              throw new Error('membership write failed');
            }
            return t.run(sql, params);
          };
        }
        const x = Reflect.get(t, p) as unknown;
        return typeof x === 'function' ? (x as (...a: unknown[]) => unknown).bind(t) : x;
      },
    });
    const flaky = { ...d, db: new Proxy(db, {
      get(t, p) {
        if (p === 'tx') return <T>(fn: (q: Sql) => Promise<T>) => t.tx((q) => fn(failing(q)));
        const x = Reflect.get(t, p) as unknown;
        return typeof x === 'function' ? (x as (...a: unknown[]) => unknown).bind(t) : x;
      },
    }) };
    await expect(redeemInvite(flaky, { token, email: 'kapoor.studio@example.com' })).rejects.toThrow('membership write failed');
    expect(await db.get('SELECT status, used_at AS usedAt, used_by AS usedBy FROM invites WHERE id = ?', [v.id])).toEqual({ status: 'open', usedAt: null, usedBy: null });
    expect(await db.get('SELECT COUNT(*) AS n FROM users')).toEqual({ n: 0 });
    expect(await getTenant(db, v.tenantId)).toMatchObject({ status: 'invited' });
    expect(await redeemInvite(flaky, { token, email: 'kapoor.studio@example.com' })).toMatchObject({ ok: true, tenantId: v.tenantId });
    expect((await listInvites(d))[0]).toMatchObject({ status: 'accepted' });
  });

  it('a wrong account is audited without the address it used in full', async () => {
    const { token } = await invite();
    await redeemInvite(d, { token, email: 'intruder.person@example.com' });
    const audit = JSON.stringify(await db.all('SELECT * FROM platform_audit'));
    expect(audit).toContain('signup.wrong_account');
    expect(audit).not.toContain('intruder.person');
  });
});
