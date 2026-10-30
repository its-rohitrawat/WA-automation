import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { DestinationStream } from 'pino';
import { openDb } from '../../src/store/db.ts';
import type { Db, Sql } from '../../src/store/db.ts';
import { manualClock } from '../../src/util/clock.ts';
import type { ManualClock } from '../../src/util/clock.ts';
import { createLogger } from '../../src/util/logger.ts';
import { AuditLog } from '../../src/web/audit.ts';
import { ACTION_LIMIT, createGuard, RateLimiter, SIGNIN_LIMIT } from '../../src/web/guard.ts';
import { googleCodeExchanger, googleIdVerifier, PENDING_TTL_MS, PendingSignIns } from '../../src/web/oidc.ts';
import type { IdClaims, IdTokenVerifier } from '../../src/web/oidc.ts';
import { auditedWrite, registerAuthRoutes } from '../../src/web/routes/auth.ts';
import { createWebServer } from '../../src/web/server.ts';
import type { WebServer } from '../../src/web/server.ts';
import { SessionStore } from '../../src/web/sessions.ts';
import { badTokens, stubGoogleCerts } from '../helpers/googleJwt.ts';
import { rawOf } from '../../src/store/engine/sqlite.ts';

const T0 = '2026-10-27T10:00:00.000Z';
const CLIENT_ID = 'client-123.apps.googleusercontent.com';
const CLIENT_SECRET = 'CLIENT-SECRET-9c1e';
const CODE = 'C0DE-SECRET-4b2d';
const ID_TOKEN = 'ID-TOKEN-SECRET-77aa';
const ACCESS_TOKEN = 'ACCESS-SECRET-0e0e';
const OWNER = 'owner@example.com';
const EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0';

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function capture() {
  const lines: string[] = [];
  const dest = { write: (s: string) => { lines.push(s); } } as unknown as DestinationStream;
  return { log: createLogger('info', dest), out: () => lines.join(''), records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A fake Google token endpoint on 127.0.0.1: answers with an ID token and an access token, and records each form. */
async function fakeTokenEndpoint(idToken: () => string = () => ID_TOKEN) {
  const forms: URLSearchParams[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      forms.push(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id_token: idToken(), access_token: ACCESS_TOKEN, expires_in: 3599 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`, forms };
}

interface Boot {
  web: WebServer;
  port: number;
  db: Db;
  clock: ManualClock;
  audit: AuditLog;
  forms: URLSearchParams[];
  /** The claims the fake verifier returns; `nonce` is filled from the last sign-in when not set. */
  claims: Partial<IdClaims> & Record<string, unknown>;
  verified: string[];
  lastNonce: () => string | undefined;
  out: () => string;
  records: () => Record<string, unknown>[];
  bodies: string[];
  names: Map<string, string>;
  req: (method: string, path: string, headers?: Record<string, string>) => Promise<Reply>;
}

async function boot(
  o: {
    owners?: string[];
    /** The platform screens are on (PLATFORM_ENABLED): /dashboard/api/me says so. */
    platform?: boolean;
    /** A member's dashboard sign-in (F7). */
    memberSignIn?: (email: string) => Promise<{ id: string; csrf: string; choose?: boolean } | null>;
    publicUrl?: string;
    verifierThrows?: boolean;
    /** The code exchange rejects with this plain Error (not a SignInError). */
    exchangeThrows?: Error;
    pendingMax?: number;
    /** The ID token the fake token endpoint answers with (default ID_TOKEN). */
    idToken?: () => string;
    /** A real verifier (such as googleIdVerifier) in place of the fake one. */
    verifier?: IdTokenVerifier;
  } = {},
): Promise<Boot> {
  const c = capture();
  const db = openDb(':memory:');
  cleanups.push(() => {
    rawOf(db).close();
  });
  const clock = manualClock(T0);
  const sessions = new SessionStore(db, clock);
  const audit = new AuditLog(db, clock);
  const ep = await fakeTokenEndpoint(o.idToken);
  const web = createWebServer({ control: {}, env: { DASHBOARD_PORT: 0 }, log: c.log, clock, sessions });
  cleanups.push(() => web.stop());
  const owners = o.owners ?? [OWNER];
  const port = () => web.address()?.port;
  const guard = createGuard({ sessions, ownerEmails: owners, ...(o.publicUrl === undefined ? {} : { publicUrl: o.publicUrl }), port });
  let nonce: string | undefined;
  const b = {
    claims: {} as Boot['claims'],
    verified: [] as string[],
    bodies: [] as string[],
    names: new Map<string, string>(),
  };
  registerAuthRoutes({
    router: web.router,
    sessions,
    guard,
    audit,
    log: c.log,
    clock,
    ownerEmails: owners,
    clientId: CLIENT_ID,
    ...(o.publicUrl === undefined ? {} : { publicUrl: o.publicUrl }),
    port,
    audited: auditedWrite(db, db),
    ...(o.platform === undefined ? {} : { platform: o.platform }),
    ...(o.memberSignIn ? { memberSignIn: async (_ctx: unknown, who: { email: string }) => o.memberSignIn!(who.email) } : {}),
    exchange:
      o.exchangeThrows === undefined
        ? googleCodeExchanger({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tokenUrl: ep.url })
        : () => Promise.reject(o.exchangeThrows),
    ...(o.pendingMax === undefined ? {} : { pending: new PendingSignIns(clock, { max: o.pendingMax }) }),
    names: b.names,
    verifier: o.verifier ?? (async (idToken) => {
      b.verified.push(idToken);
      if (o.verifierThrows) throw new Error(`Wrong number of segments in token: ${idToken}`);
      return {
        iss: 'https://accounts.google.com',
        aud: CLIENT_ID,
        exp: clock.now().getTime() / 1000 + 3600,
        nonce,
        email: 'Owner@Example.com',
        email_verified: true,
        name: 'The Owner',
        ...b.claims,
      };
    }),
    signinLimiter: new RateLimiter({ ...SIGNIN_LIMIT, clock }),
    actionLimiter: new RateLimiter({ ...ACTION_LIMIT, clock }),
  });
  const { port: p } = await web.start();
  const req = (method: string, path: string, headers: Record<string, string> = {}) =>
    new Promise<Reply>((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port: p, method, path, headers: { 'user-agent': EDGE, ...headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (ch: Buffer) => chunks.push(ch));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          b.bodies.push(body + JSON.stringify(res.headers));
          // The authorize redirect carries the nonce (as it must); remember it for the fake verifier.
          const loc = res.headers.location;
          if (loc?.startsWith('https://accounts.google.com/')) nonce = new URL(loc).searchParams.get('nonce') ?? undefined;
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      });
      r.on('error', reject);
      r.end();
    });
  return { web, port: p, db, clock, audit, forms: ep.forms, ...b, lastNonce: () => nonce, out: c.out, records: c.records, req };
}

function setCookies(r: Reply): string[] {
  const v = r.headers['set-cookie'];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}
function cookieValue(r: Reply, name: string): string | undefined {
  const c = setCookies(r).find((s) => s.startsWith(`${name}=`));
  return c === undefined ? undefined : decodeURIComponent(c.slice(name.length + 1).split(';')[0]!);
}

/** Starts a sign-in and returns the Google redirect's parameters and the wa_signin cookie. */
async function login(b: Boot, query = '', headers: Record<string, string> = {}) {
  const r = await b.req('GET', `/dashboard/auth/login${query}`, headers);
  expect(r.status).toBe(302);
  const google = new URL(r.headers.location as string);
  const signin = cookieValue(r, 'wa_signin')!;
  return { r, google, state: google.searchParams.get('state')!, signin };
}

async function callback(b: Boot, state: string, signin: string | undefined, extra = '', headers: Record<string, string> = {}) {
  return b.req('GET', `/dashboard/auth/callback?code=${CODE}&state=${encodeURIComponent(state)}${extra}`, {
    ...(signin === undefined ? {} : { cookie: `wa_signin=${signin}` }),
    ...headers,
  });
}

/** A full sign-in; returns the session cookie value. */
async function signIn(b: Boot): Promise<string> {
  const l = await login(b, '?return=/dashboard/tasks');
  const cb = await callback(b, l.state, l.signin);
  expect(cb.status).toBe(302);
  expect(cb.headers.location).toBe('/dashboard/tasks');
  return cookieValue(cb, 'wa_session')!;
}

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

describe('owner sign-in: happy path', () => {
  it('login redirects to Google with PKCE and a short wa_signin cookie; the callback signs the owner in', async () => {
    const b = await boot();
    const l = await login(b, '?return=/dashboard/tasks');
    const q = l.google.searchParams;
    expect(`${l.google.origin}${l.google.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(q.get('scope')).toBe('openid email profile');
    expect(q.get('prompt')).toBe('select_account');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('redirect_uri')).toBe(`http://127.0.0.1:${b.port}/dashboard/auth/callback`);
    expect(q.get('client_id')).toBe(CLIENT_ID);
    const signinCookie = setCookies(l.r).find((s) => s.startsWith('wa_signin='))!;
    expect(signinCookie).toMatch(/^wa_signin=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Lax; Path=\/dashboard\/auth; Max-Age=600$/);
    expect(l.r.headers['cache-control']).toBe('no-store');

    const cb = await callback(b, l.state, l.signin);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('/dashboard/tasks');
    const cookies = setCookies(cb);
    expect(cookies).toContain('wa_signin=; HttpOnly; SameSite=Lax; Path=/dashboard/auth; Max-Age=0');
    const session = cookies.find((s) => s.startsWith('wa_session='))!;
    expect(session).toMatch(/^wa_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Lax; Path=\/dashboard; Max-Age=604800$/);

    // The code went to the token endpoint with the verifier that matches the challenge, and the ID token was verified.
    const form = b.forms[0]!;
    expect(form.get('code')).toBe(CODE);
    expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(q.get('code_challenge'));
    expect(form.get('redirect_uri')).toBe(q.get('redirect_uri'));
    expect(b.verified).toEqual([ID_TOKEN]);

    const rows = rawOf(b.db).prepare('SELECT email, agent_label FROM web_sessions').all() as { email: string; agent_label: string }[];
    expect(rows).toEqual([{ email: OWNER, agent_label: 'Edge on Windows' }]);
    const audit = await b.audit.list({});
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: OWNER, event: 'Signed in', kind: 'auth', detail: 'Edge on Windows' });
  });

  it('/api/me says platform: true only when the platform screens are on, and nothing more about them', async () => {
    const b = await boot({ platform: true });
    const sid = await signIn(b);
    const me = JSON.parse((await b.req('GET', '/dashboard/api/me', { cookie: `wa_session=${sid}` })).body) as Record<string, unknown>;
    expect(me.platform).toBe(true);
    expect(Object.keys(me).sort()).toEqual(['csrf', 'email', 'expiresAt', 'name', 'platform', 'role', 'signedInAt']);
  });

  it('/api/me gives the owner, the times and the CSRF token that matches the stored hash; 401 without a session', async () => {
    const b = await boot();
    expect((await b.req('GET', '/dashboard/api/me')).status).toBe(401);
    const sid = await signIn(b);
    const r = await b.req('GET', '/dashboard/api/me', { cookie: `wa_session=${sid}` });
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const me = JSON.parse(r.body) as Record<string, string>;
    expect(Object.keys(me).sort()).toEqual(['csrf', 'email', 'expiresAt', 'name', 'platform', 'role', 'signedInAt']);
    expect(me.platform).toBe(false); // PLATFORM_ENABLED is off by default: the shell shows no platform screens
    expect(me.role).toBe('founder'); // an owner-list email in the founder's workspace
    expect(me.email).toBe(OWNER);
    expect(me.name).toBe('The Owner');
    expect(me.signedInAt).toBe(T0);
    expect(me.expiresAt).toBe('2026-11-03T10:00:00.000Z');
    const row = rawOf(b.db).prepare('SELECT csrf_hash FROM web_sessions').get() as { csrf_hash: string };
    expect(sha256hex(me.csrf!)).toBe(row.csrf_hash);
    // The same token every time for the same session.
    const again = JSON.parse((await b.req('GET', '/dashboard/api/me', { cookie: `wa_session=${sid}` })).body) as Record<string, string>;
    expect(again.csrf).toBe(me.csrf);
  });

  it('through the public https address: the redirect uses it and every cookie is Secure', async () => {
    const b = await boot({ publicUrl: 'https://dash.example.com' });
    const host = { host: 'dash.example.com' };
    const l = await login(b, '', host);
    expect(l.google.searchParams.get('redirect_uri')).toBe('https://dash.example.com/dashboard/auth/callback');
    expect(setCookies(l.r).find((s) => s.startsWith('wa_signin='))).toMatch(/; Secure$/);
    const cb = await callback(b, l.state, l.signin, '', host);
    expect(cb.headers.location).toBe('/dashboard');
    for (const c of setCookies(cb)) expect(c).toMatch(/; Secure$/);
    expect(b.forms[0]!.get('redirect_uri')).toBe('https://dash.example.com/dashboard/auth/callback');
  });

  it('on the Mac itself (localhost) with a public https address set: localhost redirect, cookies without Secure', async () => {
    const b = await boot({ publicUrl: 'https://dash.example.com' });
    const l = await login(b, '', { host: `localhost:${b.port}` });
    expect(l.google.searchParams.get('redirect_uri')).toBe(`http://localhost:${b.port}/dashboard/auth/callback`);
    expect(setCookies(l.r).find((s) => s.startsWith('wa_signin='))).not.toMatch(/Secure/);
  });

  it('an unknown Host falls back to the public address', async () => {
    const b = await boot({ publicUrl: 'https://dash.example.com' });
    const l = await login(b, '', { host: 'evil.example.net' });
    expect(l.google.searchParams.get('redirect_uri')).toBe('https://dash.example.com/dashboard/auth/callback');
  });

  it('an unknown Host without a public address falls back to localhost', async () => {
    const b = await boot();
    const l = await login(b, '', { host: 'evil.example.net' });
    expect(l.google.searchParams.get('redirect_uri')).toBe(`http://localhost:${b.port}/dashboard/auth/callback`);
  });

  // Hosts that only look like this machine or the public address: none of them may become the redirect origin.
  const lookalikes = (port: number) => [
    '127.0.0.1.evil.com',
    'localhost.evil.com',
    `127.0.0.1.evil.com:${port}`,
    `127.0.0.1:${port + 1}`,
    `localhost:${port}@evil.com`,
    `localhost:${port}.evil.com`,
    'dash.example.com.evil.com',
    'evil.com@dash.example.com',
  ];

  it('a Host that only looks like this machine falls back to the public address', async () => {
    const b = await boot({ publicUrl: 'https://dash.example.com' });
    for (const host of lookalikes(b.port)) {
      const l = await login(b, '', { host });
      expect(l.google.searchParams.get('redirect_uri'), host).toBe('https://dash.example.com/dashboard/auth/callback');
      expect(setCookies(l.r).find((s) => s.startsWith('wa_signin=')), host).toMatch(/; Secure$/);
    }
  });

  it('a Host that only looks like this machine falls back to localhost when no public address is set', async () => {
    const b = await boot();
    for (const host of lookalikes(b.port)) {
      const l = await login(b, '', { host });
      expect(l.google.searchParams.get('redirect_uri'), host).toBe(`http://localhost:${b.port}/dashboard/auth/callback`);
    }
  });

  it('the owner list is matched trimmed and lower-cased', async () => {
    const b = await boot({ owners: [' Owner@Example.COM '] });
    const sid = await signIn(b);
    expect((await b.req('GET', '/dashboard/api/me', { cookie: `wa_session=${sid}` })).status).toBe(200);
  });

  it('signing in again ends the session the browser already had', async () => {
    const b = await boot();
    const first = await signIn(b);
    const l = await login(b);
    const cb = await b.req('GET', `/dashboard/auth/callback?code=${CODE}&state=${l.state}`, { cookie: `wa_signin=${l.signin}; wa_session=${first}` });
    expect(cb.status).toBe(302);
    expect((await b.req('GET', '/dashboard/api/me', { cookie: `wa_session=${first}` })).status).toBe(401);
    expect((rawOf(b.db).prepare('SELECT COUNT(*) AS n FROM web_sessions').get() as { n: number }).n).toBe(1);
  });
});

describe('owner sign-in: state, nonce and pending records', () => {
  const failed = (r: Reply) => {
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/dashboard?error=signin');
    expect(setCookies(r).some((s) => s.startsWith('wa_session='))).toBe(false);
  };
  const loggedCode = (b: Boot) => b.records().filter((l) => l.msg === 'dashboard sign-in failed').map((l) => l.code);

  it('a wrong state is refused', async () => {
    const b = await boot();
    const l = await login(b);
    failed(await callback(b, 'x'.repeat(43), l.signin));
    expect(loggedCode(b)).toEqual(['state_mismatch']);
    expect(b.forms).toHaveLength(0);
  });

  it('a replayed state is refused', async () => {
    const b = await boot();
    const l = await login(b);
    expect((await callback(b, l.state, l.signin)).headers.location).toBe('/dashboard');
    failed(await callback(b, l.state, l.signin));
    expect(loggedCode(b)).toEqual(['no_pending']);
  });

  it('a callback without the wa_signin cookie is refused', async () => {
    const b = await boot();
    const l = await login(b);
    failed(await callback(b, l.state, undefined));
  });

  it('an expired pending record is refused', async () => {
    const b = await boot();
    const l = await login(b);
    b.clock.advance(PENDING_TTL_MS + 1_000);
    failed(await callback(b, l.state, l.signin));
    expect(loggedCode(b)).toEqual(['expired']);
  });

  it('a bad nonce is refused', async () => {
    const b = await boot();
    b.claims.nonce = 'not-the-nonce';
    const l = await login(b);
    failed(await callback(b, l.state, l.signin));
    expect(loggedCode(b)).toEqual(['nonce']);
  });

  it('a wrong audience, a wrong issuer and an expired ID token are refused', async () => {
    for (const [patch, code] of [
      [{ aud: 'other-client' }, 'audience'],
      [{ iss: 'https://evil.example.com' }, 'issuer'],
      [{ exp: Date.parse(T0) / 1000 - 5 }, 'token_expired'],
    ] as const) {
      const b = await boot();
      Object.assign(b.claims, patch);
      const l = await login(b);
      failed(await callback(b, l.state, l.signin));
      expect(loggedCode(b)).toEqual([code]);
    }
  });

  it('Google sending the person back with an error (cancelled) is a sign-in failure', async () => {
    const b = await boot();
    const l = await login(b);
    failed(await b.req('GET', `/dashboard/auth/callback?error=access_denied&state=${l.state}`, { cookie: `wa_signin=${l.signin}` }));
    expect(loggedCode(b)).toEqual(['google_error']);
  });

  it('an over-long code is refused before any exchange', async () => {
    const b = await boot();
    const l = await login(b);
    failed(await b.req('GET', `/dashboard/auth/callback?code=${'x'.repeat(2049)}&state=${l.state}`, { cookie: `wa_signin=${l.signin}` }));
    expect(loggedCode(b)).toEqual(['no_code']);
    expect(b.forms).toHaveLength(0);
  });

  it('an unexpected failure (not a SignInError) logs the code "internal" only, never its message', async () => {
    const b = await boot({ exchangeThrows: new Error(`boom ${CODE} ${ID_TOKEN}`) });
    const l = await login(b);
    failed(await callback(b, l.state, l.signin));
    expect(loggedCode(b)).toEqual(['internal']);
    expect(b.out()).not.toContain(CODE);
    expect(b.out()).not.toContain(ID_TOKEN);
    expect(b.out()).not.toContain('boom');
    expect(b.bodies.join('\n')).not.toContain(ID_TOKEN);
  });

  it('one client starting many logins drops only its own oldest pending sign-in, so it cannot fill the map', async () => {
    const b = await boot({ pendingMax: 6 });
    const visitor = () => b.req('GET', '/dashboard/auth/login', { 'cf-connecting-ip': '203.0.113.1' });
    const first = await visitor();
    expect(first.headers.location).toMatch(/^https:\/\/accounts\.google\.com\//);
    for (let i = 0; i < 6; i++) expect((await visitor()).headers.location).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(loggedCode(b)).toEqual([]);
    // Another client (no header: this machine's own address) can still start a sign-in.
    const owner = await login(b);
    expect(owner.google.origin).toBe('https://accounts.google.com');
    expect(loggedCode(b)).toEqual([]);
    // The visitor's earliest sign-in was dropped to keep it under its own cap.
    const state = new URL(first.headers.location as string).searchParams.get('state')!;
    failed(await callback(b, state, cookieValue(first, 'wa_signin')));
    expect(loggedCode(b)).toEqual(['no_pending']);
  });

  it('when the pending sign-ins are full a new login is refused, and the owner sign-in in flight still works', async () => {
    const b = await boot({ pendingMax: 2 });
    const owner = await login(b);
    const visitor = (ip: string) => b.req('GET', '/dashboard/auth/login', { 'cf-connecting-ip': ip });
    expect((await visitor('203.0.113.1')).headers.location).toMatch(/^https:\/\/accounts\.google\.com\//);
    const refused = await visitor('203.0.113.2');
    failed(refused);
    expect(setCookies(refused).some((c) => c.startsWith('wa_signin='))).toBe(false);
    expect(loggedCode(b)).toEqual(['busy']);
    // The fake verifier would answer with the visitor's nonce (the last one sent to Google); use the owner's.
    b.claims.nonce = owner.google.searchParams.get('nonce')!;
    const cb = await callback(b, owner.state, owner.signin);
    expect(cb.headers.location).toBe('/dashboard');
    expect(cookieValue(cb, 'wa_session')).toBeDefined();
  });

  it('a verifier that rejects the ID token is a failure, and its message (which may hold the token) is not logged', async () => {
    const b = await boot({ verifierThrows: true });
    const l = await login(b);
    failed(await callback(b, l.state, l.signin));
    expect(loggedCode(b)).toEqual(['id_token_invalid']);
    expect(b.out()).not.toContain(ID_TOKEN);
  });
});

describe('owner sign-in with the production ID-token verifier (offline)', () => {
  it.each(badTokens(CLIENT_ID))('%s is a sign-in failure, and no log line or response holds the token', async (_what, idToken) => {
    stubGoogleCerts();
    const b = await boot({ idToken: () => idToken, verifier: googleIdVerifier(CLIENT_ID) });
    const l = await login(b);
    const r = await callback(b, l.state, l.signin);
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/dashboard?error=signin');
    expect(setCookies(r).some((c) => c.startsWith('wa_session='))).toBe(false);
    expect(b.records().filter((x) => x.msg === 'dashboard sign-in failed').map((x) => x.code)).toEqual(['id_token_invalid']);
    // Neither the whole token nor any of its parts (the library's messages can quote the payload).
    for (const part of [idToken, ...idToken.split('.').filter((p) => p.length > 8)]) {
      expect(b.out()).not.toContain(part);
      expect(b.bodies.join(' ')).not.toContain(part);
    }
    expect(b.out()).not.toContain('evil@example.com');
    expect((rawOf(b.db).prepare('SELECT COUNT(*) AS n FROM web_sessions').get() as { n: number }).n).toBe(0);
  });
});

describe('owner sign-in: refusals', () => {
  it('an email that is not verified is refused and audited masked', async () => {
    const b = await boot();
    b.claims.email_verified = false;
    const l = await login(b);
    const r = await callback(b, l.state, l.signin);
    expect(r.headers.location).toBe('/dashboard?denied=1');
    expect(setCookies(r).some((s) => s.startsWith('wa_session='))).toBe(false);
    const a = await b.audit.list({});
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ event: 'Sign-in refused', kind: 'auth' });
    expect(a[0]!.detail).toContain('ow••••@example.com');
    expect(JSON.stringify(a)).not.toContain(OWNER);
    expect(b.out().toLowerCase()).not.toContain(OWNER);
    expect(b.bodies.join('\n').toLowerCase()).not.toContain(OWNER);
  });

  it('an email not on the owner list is refused, audited with the masked email, and gets no session', async () => {
    const b = await boot();
    b.claims.email = 'Stranger@Gmail.com';
    const l = await login(b);
    const r = await callback(b, l.state, l.signin);
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/dashboard?denied=1');
    expect(setCookies(r)).toContain('wa_signin=; HttpOnly; SameSite=Lax; Path=/dashboard/auth; Max-Age=0');
    expect((rawOf(b.db).prepare('SELECT COUNT(*) AS n FROM web_sessions').get() as { n: number }).n).toBe(0);
    const a = await b.audit.list({});
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actor: 'st••••@gmail.com', event: 'Sign-in refused', kind: 'auth' });
    expect(a[0]!.detail).toContain('st••••@gmail.com');
    expect(JSON.stringify(a).toLowerCase()).not.toContain('stranger@gmail.com');
    expect(b.out().toLowerCase()).not.toContain('stranger');
  });
});

describe('a member signs in through the dashboard (F7)', () => {
  it("a member of a customer's workspace gets the session its sign-in made; a non-member is still refused", async () => {
    const asked: string[] = [];
    let made: { id: string; csrf: string } | undefined;
    const b = await boot({
      memberSignIn: async (email) => {
        asked.push(email);
        if (email !== 'member@example.com') return null;
        made = await new SessionStore(b.db, b.clock).create(email, 'Test');
        return made;
      },
    });
    b.claims.email = 'Member@Example.com';
    const l = await login(b, '?return=/dashboard/onboarding');
    const r = await callback(b, l.state, l.signin);
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/dashboard/onboarding');
    expect(cookieValue(r, 'wa_session')).toBe(made!.id);
    expect(setCookies(r)).toContain('wa_signin=; HttpOnly; SameSite=Lax; Path=/dashboard/auth; Max-Age=0');
    expect(asked).toEqual(['member@example.com']);
    b.claims.email = 'stranger@gmail.com';
    const l2 = await login(b);
    const r2 = await callback(b, l2.state, l2.signin);
    expect(r2.headers.location).toBe('/dashboard?denied=1');
    expect(cookieValue(r2, 'wa_session')).toBeUndefined();
  });

  it('a member of several workspaces is signed in to the first, then sent to pick one', async () => {
    const b = await boot({
      memberSignIn: async (email) => ({ ...(await new SessionStore(b.db, b.clock).create(email, 'Test')), choose: true }),
    });
    b.claims.email = 'member@example.com';
    const l = await login(b, '?return=/dashboard/clients');
    const r = await callback(b, l.state, l.signin);
    expect(r.headers.location).toBe('/dashboard/workspaces');
    expect(cookieValue(r, 'wa_session')).toBeDefined();
  });
});

describe('owner sign-in: the return path', () => {
  it.each(['//evil.com', 'https://evil.com', '/dashboard/../x', '/dashboard/nope', '/dashboard/clients/groups/../../x'])(
    '%s comes back as /dashboard',
    async (ret) => {
      const b = await boot();
      const l = await login(b, `?return=${encodeURIComponent(ret)}`);
      const cb = await callback(b, l.state, l.signin);
      expect(cb.headers.location).toBe('/dashboard');
    },
  );

  it('a known screen is kept', async () => {
    const b = await boot();
    const l = await login(b, `?return=${encodeURIComponent('/dashboard/clients/groups')}`);
    expect((await callback(b, l.state, l.signin)).headers.location).toBe('/dashboard/clients/groups');
  });
});

describe('owner sign-in and sign-out: one transaction with the audit row', () => {
  const failAudit = (db: Db) => rawOf(db).exec(`CREATE TRIGGER t_fail_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit down'); END`);
  const count = (db: Db) => (rawOf(db).prepare('SELECT COUNT(*) AS n FROM web_sessions').get() as { n: number }).n;

  it('a sign-in whose audit row cannot be written creates no session and keeps the earlier one', async () => {
    const b = await boot();
    const first = await signIn(b);
    failAudit(b.db);
    const l = await login(b);
    const cb = await b.req('GET', `/dashboard/auth/callback?code=${CODE}&state=${l.state}`, { cookie: `wa_signin=${l.signin}; wa_session=${first}` });
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('/dashboard?error=signin');
    expect(setCookies(cb).some((c) => c.startsWith('wa_session='))).toBe(false);
    expect(count(b.db)).toBe(1);
    expect((await b.req('GET', '/dashboard/api/me', { cookie: `wa_session=${first}` })).status).toBe(200);
    expect(b.out()).not.toContain('audit down');
  });

  it('a refused sign-in whose audit row cannot be written still goes to the sign-in error page, with no session', async () => {
    const b = await boot();
    failAudit(b.db);
    b.claims.email = 'Stranger@Gmail.com';
    const l = await login(b);
    const cb = await callback(b, l.state, l.signin);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('/dashboard?error=signin');
    expect(setCookies(cb).some((c) => c.startsWith('wa_session='))).toBe(false);
    expect(setCookies(cb)).toContain('wa_signin=; HttpOnly; SameSite=Lax; Path=/dashboard/auth; Max-Age=0');
    expect(count(b.db)).toBe(0);
    expect(b.records().filter((x) => x.msg === 'dashboard sign-in failed').map((x) => x.code)).toEqual(['audit']);
    expect(b.out()).not.toContain('audit down');
    expect(b.out().toLowerCase()).not.toContain('stranger');
    expect(b.bodies.join('\n').toLowerCase()).not.toContain('stranger');
  });

  it('a sign-out whose audit row cannot be written keeps the session', async () => {
    const b = await boot();
    const sid = await signIn(b);
    const me = JSON.parse((await b.req('GET', '/dashboard/api/me', { cookie: `wa_session=${sid}` })).body) as { csrf: string };
    failAudit(b.db);
    const r = await b.req('POST', '/dashboard/auth/logout', { cookie: `wa_session=${sid}`, origin: `http://127.0.0.1:${b.port}`, 'x-csrf-token': me.csrf });
    expect(r.status).toBe(500);
    expect(count(b.db)).toBe(1);
    expect((await b.req('GET', '/dashboard/api/me', { cookie: `wa_session=${sid}` })).status).toBe(200);
  });
});

describe('owner sign-out', () => {
  it('without a CSRF token or with a wrong Origin it is 403 and the session stays', async () => {
    const b = await boot();
    const sid = await signIn(b);
    const me = JSON.parse((await b.req('GET', '/dashboard/api/me', { cookie: `wa_session=${sid}` })).body) as { csrf: string };
    const origin = `http://127.0.0.1:${b.port}`;
    expect((await b.req('POST', '/dashboard/auth/logout', { cookie: `wa_session=${sid}`, origin })).status).toBe(403);
    expect((await b.req('POST', '/dashboard/auth/logout', { cookie: `wa_session=${sid}`, origin: 'https://evil.com', 'x-csrf-token': me.csrf })).status).toBe(403);
    expect((await b.req('GET', '/dashboard/api/me', { cookie: `wa_session=${sid}` })).status).toBe(200);
  });

  it('without a session it is 401', async () => {
    const b = await boot();
    expect((await b.req('POST', '/dashboard/auth/logout', { origin: `http://127.0.0.1:${b.port}` })).status).toBe(401);
  });

  it('is limited to 30 a minute per client, counted before the session check: then 429 with Retry-After', async () => {
    const b = await boot();
    const origin = `http://127.0.0.1:${b.port}`;
    for (let i = 0; i < ACTION_LIMIT.capacity; i++) expect((await b.req('POST', '/dashboard/auth/logout', { origin })).status).toBe(401);
    const over = await b.req('POST', '/dashboard/auth/logout', { origin });
    expect(over.status).toBe(429);
    expect(Number(over.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    // Another client is not affected.
    expect((await b.req('POST', '/dashboard/auth/logout', { origin, 'cf-connecting-ip': '203.0.113.9' })).status).toBe(401);
  });

  it('forgets the display name on sign-out and when the browser signs in again', async () => {
    const b = await boot();
    const first = await signIn(b);
    expect([...b.names.values()]).toEqual(['The Owner']);
    // Signing in again from the same browser (Google gives no name this time) drops the earlier session's name.
    b.claims.name = undefined;
    const l = await login(b);
    const cb = await b.req('GET', `/dashboard/auth/callback?code=${CODE}&state=${l.state}`, { cookie: `wa_signin=${l.signin}; wa_session=${first}` });
    const second = cookieValue(cb, 'wa_session')!;
    expect(second).toBeDefined();
    expect(b.names.size).toBe(0);
    // A third sign-in with a name, then sign-out: the name goes with the session.
    b.claims.name = 'Owner Again';
    const third = await signIn(b);
    expect([...b.names.values()]).toEqual(['Owner Again']);
    const me = JSON.parse((await b.req('GET', '/dashboard/api/me', { cookie: `wa_session=${third}` })).body) as { csrf: string; name: string };
    expect(me.name).toBe('Owner Again');
    const r = await b.req('POST', '/dashboard/auth/logout', { cookie: `wa_session=${third}`, origin: `http://127.0.0.1:${b.port}`, 'x-csrf-token': me.csrf });
    expect(r.status).toBe(204);
    expect(b.names.size).toBe(0);
  });

  it('with the session, Origin and CSRF token: 204, the row is gone, the cookie cleared and audited', async () => {
    const b = await boot();
    const sid = await signIn(b);
    const me = JSON.parse((await b.req('GET', '/dashboard/api/me', { cookie: `wa_session=${sid}` })).body) as { csrf: string };
    const r = await b.req('POST', '/dashboard/auth/logout', { cookie: `wa_session=${sid}`, origin: `http://127.0.0.1:${b.port}`, 'x-csrf-token': me.csrf });
    expect(r.status).toBe(204);
    expect(r.body).toBe('');
    expect(setCookies(r)).toEqual(['wa_session=; HttpOnly; SameSite=Lax; Path=/dashboard; Max-Age=0']);
    expect((rawOf(b.db).prepare('SELECT COUNT(*) AS n FROM web_sessions').get() as { n: number }).n).toBe(0);
    expect((await b.req('GET', '/dashboard/api/me', { cookie: `wa_session=${sid}` })).status).toBe(401);
    const events = (await b.audit.list({})).map((e) => [e.actor, e.event, e.kind]);
    expect(events).toContainEqual([OWNER, 'Signed out', 'auth']);
  });
});

describe('owner sign-out over the public https address', () => {
  it('clears the cookie with the same attributes, Secure included', async () => {
    const b = await boot({ publicUrl: 'https://dash.example.com' });
    const host = { host: 'dash.example.com' };
    const l = await login(b, '', host);
    const cb = await callback(b, l.state, l.signin, '', host);
    const sid = cookieValue(cb, 'wa_session')!;
    const me = JSON.parse((await b.req('GET', '/dashboard/api/me', { cookie: `wa_session=${sid}`, ...host })).body) as { csrf: string };
    const r = await b.req('POST', '/dashboard/auth/logout', { cookie: `wa_session=${sid}`, ...host, origin: 'https://dash.example.com', 'x-csrf-token': me.csrf });
    expect(r.status).toBe(204);
    expect(setCookies(r)).toEqual(['wa_session=; HttpOnly; SameSite=Lax; Path=/dashboard; Max-Age=0; Secure']);
  });
});

describe('owner sign-in: limits and secrets', () => {
  it('sign-in and its callback share a limit of 10 a minute per client; over it, the sign-in error page', async () => {
    const b = await boot();
    const toGoogle = /^https:\/\/accounts\.google\.com\//;
    for (let i = 0; i < 10; i++) expect((await b.req('GET', '/dashboard/auth/login')).headers.location).toMatch(toGoogle);
    const over = [await b.req('GET', '/dashboard/auth/login'), await b.req('GET', '/dashboard/auth/callback?code=x&state=y')];
    for (const r of over) {
      expect(r.status).toBe(302);
      expect(r.headers.location).toBe('/dashboard?error=signin');
      expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(setCookies(r)).toEqual([]);
    }
    const codes = b.records().filter((l) => l.msg === 'dashboard sign-in failed').map((l) => l.code);
    expect(codes).toEqual(['rate_limited', 'rate_limited']);
    // Another client is not affected.
    expect((await b.req('GET', '/dashboard/auth/login', { 'cf-connecting-ip': '203.0.113.9' })).headers.location).toMatch(toGoogle);
  });

  it('no response or log line holds the code, the tokens, the client secret, the session id or the CSRF token', async () => {
    const b = await boot();
    const sid = await signIn(b);
    const meBody = (await b.req('GET', '/dashboard/api/me', { cookie: `wa_session=${sid}` })).body;
    const csrf = (JSON.parse(meBody) as { csrf: string }).csrf;
    // Failures too.
    const l = await login(b);
    await callback(b, 'wrong', l.signin);
    b.claims.email = 'stranger@gmail.com';
    const l2 = await login(b);
    await callback(b, l2.state, l2.signin);
    await b.req('POST', '/dashboard/auth/logout', { cookie: `wa_session=${sid}`, origin: `http://127.0.0.1:${b.port}`, 'x-csrf-token': csrf });

    const responses = b.bodies.join('\n');
    for (const secret of [CODE, ID_TOKEN, ACCESS_TOKEN, CLIENT_SECRET]) {
      expect(responses).not.toContain(secret);
      expect(b.out()).not.toContain(secret);
    }
    for (const secret of [sid, csrf, l.signin, l2.signin, l.state]) expect(b.out()).not.toContain(secret);
    const audit = JSON.stringify(await b.audit.list({}));
    for (const secret of [CODE, ID_TOKEN, ACCESS_TOKEN, sid, csrf]) expect(audit).not.toContain(secret);
  });
});
