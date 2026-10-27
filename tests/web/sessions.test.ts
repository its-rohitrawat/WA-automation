import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import type { Db } from '../../src/store/db.ts';
import { manualClock } from '../../src/util/clock.ts';
import {
  clearSessionCookie,
  cookieSecure,
  hashToken,
  IDLE_TIMEOUT_MS,
  isToken,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  SessionStore,
  sessionCookie,
} from '../../src/web/sessions.ts';

const T0 = '2026-10-27T10:00:00.000Z';
const HOUR = 3_600_000;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function setup() {
  const db = openDb(':memory:');
  const clock = manualClock(T0);
  return { db, clock, store: new SessionStore(db, clock) };
}

function rows(db: Db) {
  return db.prepare('SELECT * FROM web_sessions').all() as Record<string, string | null>[];
}

describe('SessionStore: create and get', () => {
  it('round-trips a session: email, CSRF hash, created and expiry (7 days)', () => {
    const { store } = setup();
    const { id, csrf } = store.create('Owner@Example.com', 'Edge on Windows');
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(id).not.toBe(csrf);
    expect(store.get(id)).toEqual({
      email: 'owner@example.com',
      csrfHash: sha(csrf),
      createdAt: T0,
      expiresAt: '2026-11-03T10:00:00.000Z',
    });
    expect(SESSION_TTL_MS).toBe(7 * 24 * HOUR);
    expect(IDLE_TIMEOUT_MS).toBe(24 * HOUR);
  });

  it('gives a fresh random id and token every time', () => {
    const { store } = setup();
    const a = store.create('a@example.com');
    const b = store.create('a@example.com');
    expect(new Set([a.id, b.id, a.csrf, b.csrf]).size).toBe(4);
  });

  it('stores only SHA-256 hashes: no column holds the raw id or CSRF token', () => {
    const { db, store } = setup();
    const { id, csrf } = store.create('owner@example.com', 'Safari on Mac');
    const [row] = rows(db);
    expect(row!.id_hash).toBe(sha(id));
    expect(row!.csrf_hash).toBe(sha(csrf));
    expect(row!.agent_label).toBe('Safari on Mac');
    const all = JSON.stringify(rows(db));
    expect(all).not.toContain(id);
    expect(all).not.toContain(csrf);
    expect(hashToken(id)).toBe(sha(id));
  });

  it('keeps the browser label short and on one line', () => {
    const { db, store } = setup();
    store.create('owner@example.com', `  Chrome\non\tLinux ${'x'.repeat(200)}  `);
    const label = rows(db)[0]!.agent_label!;
    expect(label.length).toBeLessThanOrEqual(60);
    expect(label).toMatch(/^Chrome on Linux x+$/);
  });

  it('stores no label when none is given', () => {
    const { db, store } = setup();
    store.create('owner@example.com');
    expect(rows(db)[0]!.agent_label).toBeNull();
  });

  it('an unknown, empty or malformed id gives undefined without throwing', () => {
    const { store } = setup();
    store.create('owner@example.com');
    for (const bad of ['', 'abc', 'A'.repeat(43), 'A'.repeat(44), "x' OR 1=1 --", '../../etc']) {
      expect(store.get(bad)).toBeUndefined();
    }
  });

  it('a malformed id is refused before any database work', () => {
    const { db, store } = setup();
    store.create('owner@example.com');
    const prepare = vi.spyOn(db, 'prepare');
    expect(store.get('A'.repeat(10_000))).toBeUndefined();
    store.destroy('A'.repeat(10_000));
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();
  });

  it('removes the Unicode line breaks and bidi controls from the label', () => {
    const { db, store } = setup();
    store.create('owner@example.com', 'Edge\u2028on\u0085Windows\u202e evil');
    expect(rows(db)[0]!.agent_label).toBe('Edge on Windows evil');
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
  it('expires after 7 days even when used all the time', () => {
    const { store, clock } = setup();
    const { id } = store.create('owner@example.com');
    for (let h = 12; h < 7 * 24; h += 12) {
      clock.set(new Date(Date.parse(T0) + h * HOUR).toISOString());
      expect(store.get(id), `at ${h} h`).toBeDefined();
    }
    clock.set(new Date(Date.parse(T0) + SESSION_TTL_MS - 1).toISOString());
    expect(store.get(id)).toBeDefined();
    clock.set(new Date(Date.parse(T0) + SESSION_TTL_MS).toISOString());
    expect(store.get(id)).toBeUndefined();
  });

  it('ends after more than 24 hours without use', () => {
    const { store, clock } = setup();
    const a = store.create('owner@example.com');
    clock.advance(IDLE_TIMEOUT_MS);
    expect(store.get(a.id)).toBeDefined();
    const b = store.create('owner@example.com');
    clock.advance(IDLE_TIMEOUT_MS + 1);
    expect(store.get(b.id)).toBeUndefined();
  });

  it('each use restarts the idle timer', () => {
    const { store, clock } = setup();
    const { id } = store.create('owner@example.com');
    clock.advance(23 * HOUR);
    expect(store.get(id)).toBeDefined();
    clock.advance(23 * HOUR);
    expect(store.get(id)).toBeDefined();
    clock.advance(IDLE_TIMEOUT_MS + 1);
    expect(store.get(id)).toBeUndefined();
  });

  it('writes last_seen_at at most once a minute', () => {
    const { db, store, clock } = setup();
    const { id } = store.create('owner@example.com');
    const seen = () => rows(db)[0]!.last_seen_at;
    clock.advance(30_000);
    store.get(id);
    expect(seen()).toBe(T0);
    clock.advance(29_999);
    store.get(id);
    expect(seen()).toBe(T0);
    clock.advance(1);
    store.get(id);
    expect(seen()).toBe('2026-10-27T10:01:00.000Z');
  });

  it('an expired or idle session row is removed when it is looked up', () => {
    const { db, store, clock } = setup();
    const { id } = store.create('owner@example.com');
    clock.advance(IDLE_TIMEOUT_MS + 1);
    expect(store.get(id)).toBeUndefined();
    expect(rows(db)).toHaveLength(0);
  });

  it('fails closed: a row whose times cannot be read is refused and removed', () => {
    for (const column of ['expires_at', 'last_seen_at']) {
      const { db, store } = setup();
      const { id } = store.create('owner@example.com');
      db.prepare(`UPDATE web_sessions SET ${column} = ?`).run('not a date');
      expect(store.get(id), column).toBeUndefined();
      expect(rows(db), column).toHaveLength(0);
    }
  });
});

describe('SessionStore: destroy and purge', () => {
  it('destroy makes get undefined and removes the row', () => {
    const { db, store } = setup();
    const a = store.create('owner@example.com');
    const b = store.create('owner@example.com');
    store.destroy(a.id);
    expect(store.get(a.id)).toBeUndefined();
    expect(store.get(b.id)).toBeDefined();
    expect(rows(db)).toHaveLength(1);
    expect(() => store.destroy('not-a-session')).not.toThrow();
  });

  it('destroyAllFor ends every session of that email only (any letter case)', () => {
    const { store } = setup();
    const a = store.create('owner@example.com');
    const b = store.create('owner@example.com');
    const other = store.create('second@example.com');
    expect(store.destroyAllFor('OWNER@example.com')).toBe(2);
    expect(store.get(a.id)).toBeUndefined();
    expect(store.get(b.id)).toBeUndefined();
    expect(store.get(other.id)).toBeDefined();
  });

  it('purgeExpired removes expired and idle rows and keeps live ones', () => {
    const { db, store, clock } = setup();
    store.create('old@example.com');
    clock.advance(IDLE_TIMEOUT_MS - HOUR);
    const live = store.create('live@example.com');
    clock.advance(2 * HOUR);
    expect(store.purgeExpired()).toBe(1);
    expect(rows(db).map((r) => r.email)).toEqual(['live@example.com']);
    expect(store.get(live.id)).toBeDefined();
    expect(store.purgeExpired()).toBe(0);
  });

  it('purgeExpired removes a session past its 7 days even when it was used recently', () => {
    const { db, store, clock } = setup();
    const { id } = store.create('owner@example.com');
    const at = (ms: number) => clock.set(new Date(Date.parse(T0) + ms).toISOString());
    // Keep it in use right up to the end, so only the 7-day expiry (not the idle timeout) can remove it.
    for (let h = 4; h < 7 * 24; h += 4) {
      at(h * HOUR);
      expect(store.get(id), `at ${h} h`).toBeDefined();
      expect(store.purgeExpired(), `at ${h} h`).toBe(0);
    }
    at(SESSION_TTL_MS - 1);
    expect(store.get(id)).toBeDefined();
    expect(store.purgeExpired()).toBe(0);
    expect(Date.parse(rows(db)[0]!.last_seen_at!)).toBeGreaterThan(Date.parse(T0) + SESSION_TTL_MS - IDLE_TIMEOUT_MS);
    at(SESSION_TTL_MS);
    expect(store.purgeExpired()).toBe(1);
    expect(rows(db)).toHaveLength(0);
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

  it('the Secure flag follows the public URL', () => {
    expect(cookieSecure('https://dash.example.com')).toBe(true);
    expect(cookieSecure('http://localhost:8787')).toBe(false);
    expect(cookieSecure('http://127.0.0.1:8787')).toBe(false);
    expect(cookieSecure(undefined)).toBe(false);
  });
});
