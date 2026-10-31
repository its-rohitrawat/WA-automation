import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FOUNDER_TENANT_ID } from '../../src/config/env.ts';
import { createTenant } from '../../src/platform/store.ts';
import { openDb } from '../../src/store/db.ts';
import type { Db } from '../../src/store/db.ts';
import { manualClock } from '../../src/util/clock.ts';
import {
  clearSessionCookie,
  csrfFor,
  hashToken,
  IDLE_TIMEOUT_MS,
  isToken,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  SessionStore,
  secureFor,
  sessionCookie,
} from '../../src/web/sessions.ts';
import { onSqlite } from '../helpers/db.ts';
import { freshPg, type FreshPg } from '../helpers/freshPg.ts';

const T0 = '2026-10-27T10:00:00.000Z';
const HOUR = 3_600_000;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// The sessions are where the app keeps them: in the tracker on SQLite (a new in-memory store for each test), on the
// platform Db on Postgres. There, a database of this file's own, its web_sessions emptied before each test, since the
// tests count the rows.
let fresh: FreshPg | undefined;
let platformDb: Db | undefined;
beforeAll(async () => {
  if (onSqlite) return;
  fresh = await freshPg();
  platformDb = fresh.platformDb();
});
afterAll(async () => {
  await fresh?.drop();
});
beforeEach(async () => {
  await platformDb?.run('DELETE FROM web_sessions');
});

function setup() {
  const db = platformDb ?? openDb(':memory:');
  const clock = manualClock(T0);
  return { db, clock, store: new SessionStore(db, clock) };
}

function rows(db: Db) {
  return db.all<Record<string, string | null>>('SELECT * FROM web_sessions');
}

describe('SessionStore: create and get', () => {
  it('round-trips a session: email, CSRF hash, created and expiry (7 days)', async () => {
    const { store } = setup();
    const { id, csrf } = await store.create('Owner@Example.com', 'Edge on Windows');
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(id).not.toBe(csrf);
    expect(await store.get(id)).toEqual({
      email: 'owner@example.com',
      tenantId: FOUNDER_TENANT_ID, // no customer named: the founder's (on SQLite every session is)
      csrfHash: sha(csrf),
      createdAt: T0,
      expiresAt: '2026-11-03T10:00:00.000Z',
    });
    expect(SESSION_TTL_MS).toBe(7 * 24 * HOUR);
    expect(IDLE_TIMEOUT_MS).toBe(24 * HOUR);
  });

  it.runIf(onSqlite)("on SQLite only the founder's session can be made: a customer's is refused, nothing written (S4.8)", async () => {
    const { store, db } = setup();
    await expect(store.create('owner@example.com', undefined, undefined, '00000000-0000-4000-8000-0000000000c2')).rejects.toThrow('customer sessions exist on Postgres only');
    expect(await db.get('SELECT COUNT(*) AS n FROM web_sessions')).toEqual({ n: 0 });
  });

  it.runIf(!onSqlite)("on Postgres a customer's session is kept with its customer, read back as that customer's only (S4.8)", async () => {
    const { store, db } = setup();
    const customer = (await createTenant(db, { name: 'Acme', status: 'active', at: T0 })).id;
    const mine = await store.create('owner@acme.example', 'Test', undefined, customer);
    const founder = await store.create('owner@example.com', 'Test');
    expect((await store.get(mine.id))?.tenantId).toBe(customer);
    expect((await store.get(founder.id))?.tenantId).toBe(FOUNDER_TENANT_ID);
    expect(await db.all('SELECT email, tenant_id AS t FROM web_sessions ORDER BY email')).toEqual([
      { email: 'owner@acme.example', t: customer },
      { email: 'owner@example.com', t: FOUNDER_TENANT_ID },
    ]);
    // A customer that does not exist cannot be named: the database refuses it, nothing written.
    await expect(store.create('x@example.com', undefined, undefined, '00000000-0000-4000-8000-0000000000ff')).rejects.toThrow();
    expect(await db.get("SELECT COUNT(*) AS n FROM web_sessions WHERE email = 'x@example.com'")).toEqual({ n: 0 });
  });

  it('gives a fresh random id and token every time', async () => {
    const { store } = setup();
    const a = await store.create('a@example.com');
    const b = await store.create('a@example.com');
    expect(new Set([a.id, b.id, a.csrf, b.csrf]).size).toBe(4);
  });

  it('the CSRF token is derived from the id, so /api/me can hand it out again without storing it', async () => {
    const { store } = setup();
    const { id, csrf } = await store.create('a@example.com');
    expect(csrfFor(id)).toBe(csrf);
    expect(csrfFor(id)).not.toBe(csrfFor((await store.create('a@example.com')).id));
    expect((await store.get(id))!.csrfHash).toBe(sha(csrfFor(id)));
    expect(csrfFor(id)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(csrfFor(id)).not.toBe(id);
    // Every character of the id counts, the last one included.
    const last = id.slice(-1) === 'A' ? 'B' : 'A';
    expect(csrfFor(`${id.slice(0, -1)}${last}`)).not.toBe(csrfFor(id));
    const tokens = new Set(await Promise.all(Array.from({ length: 50 }, async () => csrfFor((await store.create('a@example.com')).id))));
    expect(tokens.size).toBe(50);
  });

  it('stores only SHA-256 hashes: no column holds the raw id or CSRF token', async () => {
    const { db, store } = setup();
    const { id, csrf } = await store.create('owner@example.com', 'Safari on Mac');
    const [row] = await rows(db);
    expect(row!.id_hash).toBe(sha(id));
    expect(row!.csrf_hash).toBe(sha(csrf));
    expect(row!.agent_label).toBe('Safari on Mac');
    const all = JSON.stringify(await rows(db));
    expect(all).not.toContain(id);
    expect(all).not.toContain(csrf);
    expect(hashToken(id)).toBe(sha(id));
  });

  it('keeps the browser label short and on one line', async () => {
    const { db, store } = setup();
    await store.create('owner@example.com', `  Chrome\non\tLinux ${'x'.repeat(200)}  `);
    const label = (await rows(db))[0]!.agent_label!;
    expect(label.length).toBeLessThanOrEqual(60);
    expect(label).toMatch(/^Chrome on Linux x+$/);
  });

  it('stores no label when none is given', async () => {
    const { db, store } = setup();
    await store.create('owner@example.com');
    expect((await rows(db))[0]!.agent_label).toBeNull();
  });

  it('an unknown, empty or malformed id gives undefined without throwing', async () => {
    const { store } = setup();
    await store.create('owner@example.com');
    for (const bad of ['', 'abc', 'A'.repeat(43), 'A'.repeat(44), "x' OR 1=1 --", '../../etc']) {
      expect(await store.get(bad)).toBeUndefined();
    }
  });

  it('a malformed id is refused before any database work', async () => {
    const { db, store } = setup();
    await store.create('owner@example.com');
    const calls = (['get', 'all', 'run', 'tx'] as const).map((m) => vi.spyOn(db, m));
    expect(await store.get('A'.repeat(10_000))).toBeUndefined();
    await store.destroy('A'.repeat(10_000));
    for (const c of calls) expect(c).not.toHaveBeenCalled();
    for (const c of calls) c.mockRestore();
  });

  it('removes the Unicode line breaks and bidi controls from the label', async () => {
    const { db, store } = setup();
    await store.create('owner@example.com', 'Edge\u2028on\u0085Windows\u202e evil');
    expect((await rows(db))[0]!.agent_label).toBe('Edge on Windows evil');
  });
});

describe('isToken', () => {
  it('accepts exactly 43 base64url characters', () => {
    const good = 'aZ09_-'.repeat(7) + 'x';
    expect(good).toHaveLength(43);
    expect(isToken(good)).toBe(true);
    expect(isToken('A'.repeat(43))).toBe(true);
  });

  it('refuses anything else', () => {
    const base = 'A'.repeat(42);
    for (const bad of [undefined, '', 'A'.repeat(42), 'A'.repeat(44), `${base}+`, `${base}/`, `${base}=`, `${base} `, `${base}\n`, 'A'.repeat(10_000)]) {
      expect(isToken(bad), JSON.stringify(bad)?.slice(0, 50)).toBe(false);
    }
  });
});

describe('SessionStore: expiry and idle timeout', () => {
  it('expires after 7 days even when used all the time', async () => {
    const { store, clock } = setup();
    const { id } = await store.create('owner@example.com');
    for (let h = 12; h < 7 * 24; h += 12) {
      clock.set(new Date(Date.parse(T0) + h * HOUR).toISOString());
      expect(await store.get(id), `at ${h} h`).toBeDefined();
    }
    clock.set(new Date(Date.parse(T0) + SESSION_TTL_MS - 1).toISOString());
    expect(await store.get(id)).toBeDefined();
    clock.set(new Date(Date.parse(T0) + SESSION_TTL_MS).toISOString());
    expect(await store.get(id)).toBeUndefined();
  });

  it('ends after more than 24 hours without use', async () => {
    const { store, clock } = setup();
    const a = await store.create('owner@example.com');
    clock.advance(IDLE_TIMEOUT_MS);
    expect(await store.get(a.id)).toBeDefined();
    const b = await store.create('owner@example.com');
    clock.advance(IDLE_TIMEOUT_MS + 1);
    expect(await store.get(b.id)).toBeUndefined();
  });

  it('each use restarts the idle timer', async () => {
    const { store, clock } = setup();
    const { id } = await store.create('owner@example.com');
    clock.advance(23 * HOUR);
    expect(await store.get(id)).toBeDefined();
    clock.advance(23 * HOUR);
    expect(await store.get(id)).toBeDefined();
    clock.advance(IDLE_TIMEOUT_MS + 1);
    expect(await store.get(id)).toBeUndefined();
  });

  it('writes last_seen_at at most once a minute', async () => {
    const { db, store, clock } = setup();
    const { id } = await store.create('owner@example.com');
    const seen = async () => (await rows(db))[0]!.last_seen_at;
    clock.advance(30_000);
    await store.get(id);
    expect(await seen()).toBe(T0);
    clock.advance(29_999);
    await store.get(id);
    expect(await seen()).toBe(T0);
    clock.advance(1);
    await store.get(id);
    expect(await seen()).toBe('2026-10-27T10:01:00.000Z');
  });

  it('an expired or idle session row is removed when it is looked up', async () => {
    const { db, store, clock } = setup();
    const { id } = await store.create('owner@example.com');
    clock.advance(IDLE_TIMEOUT_MS + 1);
    expect(await store.get(id)).toBeUndefined();
    expect(await rows(db)).toHaveLength(0);
  });

  it('fails closed: a row whose times cannot be read is refused and removed', async () => {
    for (const column of ['expires_at', 'last_seen_at']) {
      const { db, store } = setup();
      const { id } = await store.create('owner@example.com');
      await db.run(`UPDATE web_sessions SET ${column} = ?`, ['not a date']);
      expect(await store.get(id), column).toBeUndefined();
      expect(await rows(db), column).toHaveLength(0);
    }
  });
});

describe('SessionStore: destroy and purge', () => {
  it('destroy makes get undefined and removes the row', async () => {
    const { db, store } = setup();
    const a = await store.create('owner@example.com');
    const b = await store.create('owner@example.com');
    await store.destroy(a.id);
    expect(await store.get(a.id)).toBeUndefined();
    expect(await store.get(b.id)).toBeDefined();
    expect(await rows(db)).toHaveLength(1);
    await expect(store.destroy('not-a-session')).resolves.toBeUndefined();
  });

  it('destroyAllFor ends every session of that email only (any letter case)', async () => {
    const { store } = setup();
    const a = await store.create('owner@example.com');
    const b = await store.create('owner@example.com');
    const other = await store.create('second@example.com');
    expect(await store.destroyAllFor('OWNER@example.com')).toBe(2);
    expect(await store.get(a.id)).toBeUndefined();
    expect(await store.get(b.id)).toBeUndefined();
    expect(await store.get(other.id)).toBeDefined();
  });

  it('purgeExpired removes expired and idle rows and keeps live ones', async () => {
    const { db, store, clock } = setup();
    await store.create('old@example.com');
    clock.advance(IDLE_TIMEOUT_MS - HOUR);
    const live = await store.create('live@example.com');
    clock.advance(2 * HOUR);
    expect(await store.purgeExpired()).toBe(1);
    expect((await rows(db)).map((r) => r.email)).toEqual(['live@example.com']);
    expect(await store.get(live.id)).toBeDefined();
    expect(await store.purgeExpired()).toBe(0);
  });

  it('purgeExpired removes a session past its 7 days even when it was used recently', async () => {
    const { db, store, clock } = setup();
    const { id } = await store.create('owner@example.com');
    const at = (ms: number) => clock.set(new Date(Date.parse(T0) + ms).toISOString());
    // Keep it in use right up to the end, so only the 7-day expiry (not the idle timeout) can remove it.
    for (let h = 4; h < 7 * 24; h += 4) {
      at(h * HOUR);
      expect(await store.get(id), `at ${h} h`).toBeDefined();
      expect(await store.purgeExpired(), `at ${h} h`).toBe(0);
    }
    at(SESSION_TTL_MS - 1);
    expect(await store.get(id)).toBeDefined();
    expect(await store.purgeExpired()).toBe(0);
    expect(Date.parse((await rows(db))[0]!.last_seen_at!)).toBeGreaterThan(Date.parse(T0) + SESSION_TTL_MS - IDLE_TIMEOUT_MS);
    at(SESSION_TTL_MS);
    expect(await store.purgeExpired()).toBe(1);
    expect(await rows(db)).toHaveLength(0);
  });
});

describe('session cookie', () => {
  it('is HttpOnly, Lax, scoped to /dashboard and lasts 7 days', () => {
    expect(SESSION_COOKIE).toBe('wa_session');
    expect(sessionCookie('abc_DEF-123', { secure: false })).toBe('wa_session=abc_DEF-123; HttpOnly; SameSite=Lax; Path=/dashboard; Max-Age=604800');
    expect(sessionCookie('abc', { secure: true })).toBe('wa_session=abc; HttpOnly; SameSite=Lax; Path=/dashboard; Max-Age=604800; Secure');
  });

  it('signing out clears it with Max-Age=0', () => {
    expect(clearSessionCookie({ secure: false })).toBe('wa_session=; HttpOnly; SameSite=Lax; Path=/dashboard; Max-Age=0');
    expect(clearSessionCookie({ secure: true })).toBe('wa_session=; HttpOnly; SameSite=Lax; Path=/dashboard; Max-Age=0; Secure');
  });

  it('the Secure flag follows the origin each request uses: https only (localhost stays plain http)', () => {
    expect(secureFor('https://dash.example.com')).toBe(true);
    expect(secureFor('http://localhost:8787')).toBe(false);
    expect(secureFor('http://127.0.0.1:8787')).toBe(false);
  });
});

describe('SessionStore: onEnd (the assistant forgets a chat that ended)', () => {
  it('tells listeners of a sign-out, of sign out everywhere and of a session found expired; a failing listener changes nothing', async () => {
    const { clock, store } = setup();
    const seen: unknown[] = [];
    store.onEnd(() => {
      throw new Error('listener bug');
    });
    const off = store.onEnd((e) => seen.push(e));
    const a = await store.create('owner@example.com');
    await store.destroy(a.id);
    await store.destroyAllFor('Owner@Example.com');
    const b = await store.create('owner@example.com');
    clock.set(new Date(Date.parse(T0) + SESSION_TTL_MS + HOUR).toISOString());
    expect(await store.get(b.id)).toBeUndefined();
    expect(seen).toEqual([{ idHash: hashToken(a.id) }, { email: 'owner@example.com' }, { idHash: hashToken(b.id) }]);
    off();
    await store.destroy((await store.create('owner@example.com')).id);
    expect(seen).toHaveLength(3);
  });
});

describe('a Postgres session without its customer (isolation review F4)', () => {
  // SQLite only: Postgres's web_sessions.tenant_id is NOT NULL (the next test), so this is the code's own defence, on a
  // store that says it is Postgres.
  it.runIf(onSqlite)('is ended at its next read, never taken for the founder’s', async () => {
    const raw = openDb(':memory:');
    await raw.exec('ALTER TABLE web_sessions ADD COLUMN tenant_id TEXT');
    const pgLike: Db = {
      engine: 'postgres', get: (s, p) => raw.get(s, p), all: (s, p) => raw.all(s, p), run: (s, p) => raw.run(s, p), exec: (s) => raw.exec(s), tx: (fn) => raw.tx(fn), close: async () => {},
    };
    const store = new SessionStore(pgLike, manualClock(T0));
    const { id } = await store.create('owner@example.com', 'Test');
    expect((await store.get(id))?.tenantId).toBe(FOUNDER_TENANT_ID); // written with its customer: read back as such
    await raw.run('UPDATE web_sessions SET tenant_id = NULL');
    expect(await store.get(id)).toBeUndefined();
    expect(await raw.get('SELECT COUNT(*) AS n FROM web_sessions')).toEqual({ n: 0 });
    await raw.close();
  });

  it.runIf(!onSqlite)('cannot exist on Postgres: the database refuses a session row without its customer', async () => {
    const { db, store } = setup();
    await store.create('owner@example.com', 'Test');
    await expect(db.run('UPDATE web_sessions SET tenant_id = NULL')).rejects.toThrow(/null value|not-null/);
    expect((await rows(db))[0]!.tenant_id).toBe(FOUNDER_TENANT_ID);
  });
});
