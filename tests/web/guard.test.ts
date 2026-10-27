import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { manualClock } from '../../src/util/clock.ts';
import {
  ACTION_LIMIT,
  clientAddress,
  createGuard,
  RateLimiter,
  SIGNIN_LIMIT,
} from '../../src/web/guard.ts';
import { SessionStore } from '../../src/web/sessions.ts';
import { HttpError } from '../../src/web/http.ts';

const T0 = '2026-10-27T10:00:00.000Z';
const PUBLIC = 'https://dash.example.com';

function fakeReq(o: { method?: string; headers?: Record<string, string>; remote?: string } = {}): IncomingMessage {
  return { method: o.method ?? 'GET', headers: o.headers ?? {}, socket: { remoteAddress: o.remote ?? '127.0.0.1' } } as unknown as IncomingMessage;
}

function fakeRes() {
  const headers: Record<string, string | number> = {};
  const res = {
    setHeader(name: string, value: string | number) {
      headers[name.toLowerCase()] = value;
      return res;
    },
  };
  return { res: res as unknown as ServerResponse, headers };
}

function setup(o: { publicUrl?: string; port?: number; owners?: string[] } = {}) {
  const db = openDb(':memory:');
  const clock = manualClock(T0);
  const sessions = new SessionStore(db, clock);
  const guard = createGuard({
    sessions,
    ownerEmails: o.owners ?? ['owner@example.com'],
    ...('publicUrl' in o ? (o.publicUrl === undefined ? {} : { publicUrl: o.publicUrl }) : { publicUrl: PUBLIC }),
    port: () => o.port ?? 8787,
  });
  return { db, clock, sessions, guard };
}

function caught(fn: () => unknown): HttpError {
  try {
    fn();
  } catch (e) {
    if (e instanceof HttpError) return e;
    throw e;
  }
  throw new Error('expected an HttpError');
}

describe('requireOwner', () => {
  it('returns the session for a valid cookie', () => {
    const { sessions, guard } = setup();
    const { id } = sessions.create('owner@example.com');
    const s = guard.requireOwner(fakeReq({ headers: { cookie: `other=1; wa_session=${id}` } }));
    expect(s.email).toBe('owner@example.com');
    expect(s.id).toBe(id);
  });

  it('gives 401 JSON for no cookie, an unknown cookie or an expired session', () => {
    const { sessions, guard, clock } = setup();
    const cases: Record<string, string>[] = [{}, { cookie: 'wa_session=' }, { cookie: `wa_session=${'A'.repeat(43)}` }];
    for (const headers of cases) {
      const e = caught(() => guard.requireOwner(fakeReq({ headers })));
      expect(e.status).toBe(401);
      expect(e.code).toBe('unauthorized');
    }
    const { id } = sessions.create('owner@example.com');
    clock.advance(25 * 3_600_000);
    expect(caught(() => guard.requireOwner(fakeReq({ headers: { cookie: `wa_session=${id}` } }))).status).toBe(401);
  });

  it('refuses and ends a session whose email is no longer an owner', () => {
    const { sessions, db } = setup();
    const { id } = sessions.create('former@example.com');
    const guard = createGuard({ sessions, ownerEmails: ['owner@example.com'], publicUrl: PUBLIC, port: () => 8787 });
    expect(caught(() => guard.requireOwner(fakeReq({ headers: { cookie: `wa_session=${id}` } }))).status).toBe(401);
    expect(db.prepare('SELECT COUNT(*) AS n FROM web_sessions').get()).toEqual({ n: 0 });
  });
});

describe('requireCsrf', () => {
  function signedIn(o: Parameters<typeof setup>[0] = {}) {
    const s = setup(o);
    const { id, csrf } = s.sessions.create('owner@example.com');
    const session = s.guard.requireOwner(fakeReq({ headers: { cookie: `wa_session=${id}` } }));
    return { ...s, session, csrf };
  }
  const post = (headers: Record<string, string>) => fakeReq({ method: 'POST', headers });

  it('passes with the public origin and the right token', () => {
    const { guard, session, csrf } = signedIn();
    expect(() => guard.requireCsrf(post({ origin: PUBLIC, 'x-csrf-token': csrf }), session)).not.toThrow();
  });

  it('passes with the localhost origin on the dashboard port', () => {
    const { guard, session, csrf } = signedIn({ port: 41234 });
    expect(() => guard.requireCsrf(post({ origin: 'http://localhost:41234', 'x-csrf-token': csrf }), session)).not.toThrow();
    expect(() => guard.requireCsrf(post({ origin: 'http://127.0.0.1:41234', 'x-csrf-token': csrf }), session)).not.toThrow();
  });

  it('a missing or wrong token gives 403', () => {
    const { guard, session, csrf } = signedIn();
    const other = signedIn().csrf;
    for (const token of [undefined, '', 'x', other, csrf.slice(0, -1), `${csrf} `, csrf.toUpperCase()]) {
      const headers: Record<string, string> = { origin: PUBLIC };
      if (token !== undefined) headers['x-csrf-token'] = token;
      const e = caught(() => guard.requireCsrf(post(headers), session));
      expect(e.status, String(token)).toBe(403);
      expect(e.code).toBe('csrf');
    }
  });

  it('a missing or wrong Origin gives 403', () => {
    const { guard, session, csrf } = signedIn();
    for (const origin of [undefined, 'null', 'https://evil.example.com', 'http://dash.example.com', 'https://dash.example.com:8443', `${PUBLIC}/`, 'http://localhost:9999', 'http://localhost']) {
      const headers: Record<string, string> = { 'x-csrf-token': csrf };
      if (origin !== undefined) headers.origin = origin;
      expect(caught(() => guard.requireCsrf(post(headers), session)).status, String(origin)).toBe(403);
    }
  });

  it('without a public URL only the localhost origins pass', () => {
    const { guard, session, csrf } = signedIn({ publicUrl: undefined });
    expect(caught(() => guard.requireCsrf(post({ origin: PUBLIC, 'x-csrf-token': csrf }), session)).status).toBe(403);
    expect(() => guard.requireCsrf(post({ origin: 'http://localhost:8787', 'x-csrf-token': csrf }), session)).not.toThrow();
  });

  it('applies to every method but GET and HEAD', () => {
    const { guard, session } = signedIn();
    expect(() => guard.requireCsrf(fakeReq({ method: 'GET' }), session)).not.toThrow();
    expect(() => guard.requireCsrf(fakeReq({ method: 'HEAD' }), session)).not.toThrow();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(caught(() => guard.requireCsrf(fakeReq({ method }), session)).status).toBe(403);
    }
  });
});

describe('clientAddress', () => {
  it('uses CF-Connecting-IP only for requests from 127.0.0.1 (the tunnel)', () => {
    expect(clientAddress(fakeReq({ remote: '127.0.0.1', headers: { 'cf-connecting-ip': '203.0.113.9' } }))).toBe('203.0.113.9');
    expect(clientAddress(fakeReq({ remote: '::ffff:127.0.0.1', headers: { 'cf-connecting-ip': '2001:db8::1' } }))).toBe('2001:db8::1');
    expect(clientAddress(fakeReq({ remote: '::1', headers: { 'cf-connecting-ip': '203.0.113.9' } }))).toBe('203.0.113.9');
    expect(clientAddress(fakeReq({ remote: '198.51.100.7', headers: { 'cf-connecting-ip': '203.0.113.9' } }))).toBe('198.51.100.7');
  });

  it('ignores a header that is not one IP address', () => {
    for (const bad of ['203.0.113.9, 10.0.0.1', 'evil', '', '999.1.1.1']) {
      expect(clientAddress(fakeReq({ remote: '127.0.0.1', headers: { 'cf-connecting-ip': bad } }))).toBe('127.0.0.1');
    }
    expect(clientAddress(fakeReq({ remote: '127.0.0.1' }))).toBe('127.0.0.1');
  });

  it('falls back to a fixed key when the socket has no address', () => {
    const req = { method: 'GET', headers: {}, socket: {} } as unknown as IncomingMessage;
    expect(clientAddress(req)).toBe('unknown');
  });
});

describe('RateLimiter', () => {
  it('sign-in allows 10 a minute and actions 30 a minute', () => {
    expect(SIGNIN_LIMIT).toEqual({ capacity: 10, refillPerSec: 10 / 60 });
    expect(ACTION_LIMIT).toEqual({ capacity: 30, refillPerSec: 30 / 60 });
  });

  it('allows exactly the capacity, then 429 with Retry-After', () => {
    const clock = manualClock(T0);
    const limiter = new RateLimiter({ ...SIGNIN_LIMIT, clock });
    const req = fakeReq({ headers: { 'cf-connecting-ip': '203.0.113.9' } });
    for (let i = 0; i < 10; i++) {
      const { res } = fakeRes();
      expect(() => limiter.hit(req, res), `hit ${i + 1}`).not.toThrow();
    }
    const { res, headers } = fakeRes();
    const e = caught(() => limiter.hit(req, res));
    expect(e.status).toBe(429);
    expect(e.code).toBe('rate_limited');
    expect(headers['retry-after']).toBe('6');
  });

  it('keeps a separate bucket per client', () => {
    const clock = manualClock(T0);
    const limiter = new RateLimiter({ capacity: 2, refillPerSec: 1 / 60, clock });
    const a = fakeReq({ headers: { 'cf-connecting-ip': '203.0.113.1' } });
    const b = fakeReq({ headers: { 'cf-connecting-ip': '203.0.113.2' } });
    expect(limiter.take(clientAddress(a))).toBe(true);
    expect(limiter.take(clientAddress(a))).toBe(true);
    expect(limiter.take(clientAddress(a))).toBe(false);
    expect(limiter.take(clientAddress(b))).toBe(true);
  });

  it('refills over time, never beyond the capacity', () => {
    const clock = manualClock(T0);
    const limiter = new RateLimiter({ ...SIGNIN_LIMIT, clock });
    for (let i = 0; i < 10; i++) expect(limiter.take('k')).toBe(true);
    expect(limiter.take('k')).toBe(false);
    clock.advance(5_999);
    expect(limiter.take('k')).toBe(false);
    clock.advance(1);
    expect(limiter.take('k')).toBe(true);
    expect(limiter.take('k')).toBe(false);
    clock.advance(10 * 60_000);
    for (let i = 0; i < 10; i++) expect(limiter.take('k')).toBe(true);
    expect(limiter.take('k')).toBe(false);
  });

  it('a clock that steps back does not add tokens', () => {
    const clock = manualClock(T0);
    const limiter = new RateLimiter({ capacity: 1, refillPerSec: 1, clock });
    expect(limiter.take('k')).toBe(true);
    clock.advance(-60_000);
    expect(limiter.take('k')).toBe(false);
  });

  it('keeps at most maxKeys clients in memory', () => {
    const clock = manualClock(T0);
    const limiter = new RateLimiter({ capacity: 5, refillPerSec: 1, clock, maxKeys: 3 });
    for (const k of ['a', 'b', 'c', 'd', 'e']) limiter.take(k);
    expect(limiter.size()).toBeLessThanOrEqual(3);
  });
});
