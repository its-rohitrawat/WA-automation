import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInvite, listInvites } from '../../src/platform/invites.ts';
import { ensurePlatformSchema } from '../../src/platform/schema.ts';
import { getTenant, membershipsFor } from '../../src/platform/store.ts';
import { SqliteDb } from '../../src/store/engine/sqlite.ts';
import { manualClock, type ManualClock } from '../../src/util/clock.ts';
import { createLogger } from '../../src/util/logger.ts';
import type { IdClaims } from '../../src/web/oidc.ts';
import { mountSignupRoutes, SIGNUP_COOKIE, type SignupDeps } from '../../src/web/routes/platform.ts';
import { createWebServer, type WebServer } from '../../src/web/server.ts';

// The public sign-up on the real web server, with a fake Google: a code exchange and an ID-token check that answer as the
// test says. Nothing here reaches Google.

const CLIENT_ID = 'client-123.apps.googleusercontent.com';
const SITE = 'https://agent.example.com';

let db: SqliteDb;
let clock: ManualClock;
let web: WebServer;
let base: string;
let logLines: string[];
let sessions: { email: string; tenantId: string }[];
/** The claims the fake Google gives for the next sign-in (the nonce is filled from the sign-in it started). */
let claims: (nonce: string) => IdClaims;
let lastNonce = '';
/** How many times the routes told the Supervisor a customer's status changed. */
let pokes = 0;

async function start(o: Partial<SignupDeps> = {}) {
  pokes = 0;
  web = createWebServer({ control: {}, env: { DASHBOARD_PORT: 0 }, log: createLogger('debug', { write: (l: string) => void logLines.push(l) }), clock } as never);
  mountSignupRoutes(web.router, {
    db, clock, log: createLogger('debug', { write: (l: string) => void logLines.push(l) }), publicUrl: SITE, founderName: 'Rohit',
    google: { clientId: CLIENT_ID, exchange: async ({ code }) => `id-token-for-${code}`, verify: async () => claims(lastNonce) },
    startSession: async (ctx, s) => {
      sessions.push({ email: s.email, tenantId: s.tenantId });
      ctx.res.setHeader('Set-Cookie', 'wa_session=fake-session; HttpOnly; SameSite=Lax; Path=/');
      return true;
    },
    secure: () => false,
    poke: () => void pokes++,
    ...o,
  });
  const { port } = await web.start();
  base = `http://127.0.0.1:${port}`;
}

beforeEach(async () => {
  db = SqliteDb.open(':memory:');
  await ensurePlatformSchema(db);
  clock = manualClock('2026-10-29T06:00:00.000Z');
  logLines = [];
  sessions = [];
  claims = (nonce) => ({ iss: 'https://accounts.google.com', aud: CLIENT_ID, exp: Date.parse('2026-10-29T07:00:00Z') / 1000, nonce, email: 'Kapoor.Studio@Example.com', email_verified: true, name: 'Asha Kapoor' });
  await start();
});
afterEach(async () => {
  await web.stop();
  await db.close();
});

const invite = async (email = 'kapoor.studio@example.com') => (await createInvite({ db, clock }, 'founder@example.com', { business: 'Kapoor Design Studio', email })).token;
const get = (path: string, cookie?: string) => fetch(base + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });

/** Starts Google sign-in for this invite: the cookie, and the state and nonce Google would carry back. */
async function startGoogle(token: string) {
  const r = await get(`/signup/google?invite=${token}`);
  expect(r.status).toBe(302);
  const to = new URL(r.headers.get('location')!);
  expect(`${to.origin}${to.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  const cookie = r.headers.get('set-cookie')!;
  lastNonce = to.searchParams.get('nonce')!;
  return { cookie: cookie.split(';')[0]!, setCookie: cookie, state: to.searchParams.get('state')!, to };
}

describe('the sign-up page', () => {
  it('is served with no Referer leaving it, and the shell\'s security headers', async () => {
    const r = await get('/signup?invite=x');
    expect(r.status).toBe(200);
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await r.text()).toContain('/dashboard/static/views/signup.js');
  });

  it('shows the business and who invited them for a working link; any link that does not work gets one answer', async () => {
    const token = await invite();
    const ok = await get(`/signup/api/invite?invite=${token}`);
    expect(await ok.json()).toEqual({ business: 'Kapoor Design Studio', founderName: 'Rohit', expiresAt: '2026-11-05T06:00:00.000Z' });
    const answers = new Set<string>();
    for (const t of ['nonsense', 'A'.repeat(43), '']) {
      const r = await get(`/signup/api/invite?invite=${t}`);
      expect(r.status).toBe(404);
      answers.add(await r.text());
    }
    clock.advance(8 * 86_400_000);
    const expired = await get(`/signup/api/invite?invite=${token}`);
    answers.add(await expired.text());
    expect(answers.size).toBe(1);
    expect([...answers][0]).not.toContain('Kapoor');
  });
});

describe('signing up with Google', () => {
  it('Continue with Google: a sign-in with state, nonce and PKCE, its cookie only on /signup, back to /signup/callback', async () => {
    const s = await startGoogle(await invite());
    expect(s.to.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(s.to.searchParams.get('redirect_uri')).toBe(`${SITE}/signup/callback`);
    expect(s.to.searchParams.get('code_challenge_method')).toBe('S256');
    expect(s.to.searchParams.get('scope')).toBe('openid email profile');
    expect(s.setCookie).toMatch(new RegExp(`^${SIGNUP_COOKIE}=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Lax; Path=/signup; Max-Age=600$`));
    // The invite never goes to Google.
    expect(s.to.toString()).not.toContain((await listInvites({ db, clock }))[0]!.id);
  });

  it('the invited account (any case): the invite is used, the session starts, the customer is onboarding, the browser goes to Getting started', async () => {
    const token = await invite();
    const s = await startGoogle(token);
    const r = await get(`/signup/callback?code=good&state=${s.state}`, s.cookie);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/dashboard/onboarding');
    const tenantId = (await listInvites({ db, clock }))[0]!.tenantId;
    expect(sessions).toEqual([{ email: 'kapoor.studio@example.com', tenantId }]);
    expect(pokes).toBe(1); // the Supervisor starts the new customer's setup runtime
    expect(await getTenant(db, tenantId)).toMatchObject({ status: 'onboarding' });
    expect(await membershipsFor(db, 'kapoor.studio@example.com')).toEqual([{ tenantId, role: 'owner', status: 'onboarding' }]);
    // Both cookies reach the browser: the session startSession set, and the cleared sign-up cookie. (The redirect used
    // to replace the first with the second, so the new customer arrived signed out.)
    const cookies = r.headers.getSetCookie();
    expect(cookies).toContain('wa_session=fake-session; HttpOnly; SameSite=Lax; Path=/');
    expect(cookies).toContain(`${SIGNUP_COOKIE}=; HttpOnly; SameSite=Lax; Path=/signup; Max-Age=0`);
    expect(cookies).toHaveLength(2);
    // The link is used up: a second sign-up with it says only that the link does not work.
    const again = await get(`/signup/google?invite=${token}`);
    expect(again.headers.get('location')).toBe('/signup?error=invalid');
    // Nothing in the logs: no token, no address.
    expect(logLines.join('')).not.toMatch(new RegExp(`${token}|kapoor|@example`, 'i'));
  });

  it('before the Postgres switch (no customer sessions yet): signed up all the same, and sent to the waiting page', async () => {
    await web.stop();
    await start({ startSession: async () => false }); // what the agent's startSession says on SQLite (hookups 11)
    const token = await invite();
    const s = await startGoogle(token);
    const r = await get(`/signup/callback?code=good&state=${s.state}`, s.cookie);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/signup?note=waiting'); // no token in it: the invite is used up
    const tenantId = (await listInvites({ db, clock }))[0]!.tenantId;
    expect(await getTenant(db, tenantId)).toMatchObject({ status: 'onboarding' });
    expect(await membershipsFor(db, 'kapoor.studio@example.com')).toEqual([{ tenantId, role: 'owner', status: 'onboarding' }]);
    expect(r.headers.get('set-cookie')).not.toContain('wa_session');
    expect(pokes).toBe(1);
    expect((await get(`/signup/google?invite=${token}`)).headers.get('location')).toBe('/signup?error=invalid');
  });

  it('another Google account: "a different Google account", nothing made, the invite still open for the right one', async () => {
    const token = await invite();
    claims = (nonce) => ({ iss: 'https://accounts.google.com', aud: CLIENT_ID, exp: Date.parse('2026-10-29T07:00:00Z') / 1000, nonce, email: 'someone.else@example.com', email_verified: true });
    const s = await startGoogle(token);
    const r = await get(`/signup/callback?code=good&state=${s.state}`, s.cookie);
    expect(r.headers.get('location')).toBe(`/signup?invite=${token}&error=wrong_account`);
    expect(sessions).toEqual([]);
    expect((await listInvites({ db, clock }))[0]!.status).toBe('open');
    expect(await membershipsFor(db, 'someone.else@example.com')).toEqual([]);
  });

  it('an email Google has not verified is never matched, even when it is the invited one', async () => {
    const token = await invite();
    claims = (nonce) => ({ iss: 'https://accounts.google.com', aud: CLIENT_ID, exp: Date.parse('2026-10-29T07:00:00Z') / 1000, nonce, email: 'kapoor.studio@example.com', email_verified: false });
    const s = await startGoogle(token);
    expect((await get(`/signup/callback?code=good&state=${s.state}`, s.cookie)).headers.get('location')).toBe(`/signup?invite=${token}&error=wrong_account`);
    expect(sessions).toEqual([]);
  });

  it('a callback that is not this browser\'s sign-in (no cookie, another state, a replay, a wrong nonce) redeems nothing', async () => {
    const token = await invite();
    const s = await startGoogle(token);
    expect((await get(`/signup/callback?code=good&state=${s.state}`)).headers.get('location')).toBe('/signup?error=retry');
    const t = await startGoogle(token);
    expect((await get(`/signup/callback?code=good&state=wrong`, t.cookie)).headers.get('location')).toBe('/signup?error=retry');
    // Used up either way: the same cookie and state again do nothing.
    expect((await get(`/signup/callback?code=good&state=${t.state}`, t.cookie)).headers.get('location')).toBe('/signup?error=retry');
    // Spaced out, as a person would: one link allows 5 tries at once, then one every 2 minutes.
    clock.advance(15 * 60_000);
    const u = await startGoogle(token);
    claims = () => ({ iss: 'https://accounts.google.com', aud: CLIENT_ID, exp: Date.parse('2026-10-29T07:00:00Z') / 1000, nonce: 'not-this-one', email: 'kapoor.studio@example.com', email_verified: true });
    expect((await get(`/signup/callback?code=good&state=${u.state}`, u.cookie)).headers.get('location')).toBe(`/signup?invite=${token}&error=retry`);
    // Google said no (the person cancelled).
    clock.advance(15 * 60_000);
    const v = await startGoogle(token);
    expect((await get(`/signup/callback?error=access_denied&state=${v.state}`, v.cookie)).headers.get('location')).toBe(`/signup?invite=${token}&error=retry`);
    expect(sessions).toEqual([]);
    expect((await listInvites({ db, clock }))[0]!.status).toBe('open');
  });

  it('a link that does not work never starts a sign-in', async () => {
    for (const t of ['nonsense', 'A'.repeat(43)]) {
      const r = await get(`/signup/google?invite=${t}`);
      expect(r.headers.get('location')).toBe('/signup?error=invalid');
      expect(r.headers.get('set-cookie')).toBeNull();
    }
  });

  it('is rate-limited per address and per link', async () => {
    const token = await invite();
    let limited = 0;
    for (let i = 0; i < 12; i++) if ((await get(`/signup/api/invite?invite=${token}`)).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
    // The per-link limit counts sign-in attempts only: on a fresh server (a new address count), opening the page is
    // free, and a sixth Continue with Google at once with one link is refused (back to the page, the link kept).
    await web.stop();
    await start();
    const other = await invite('other@example.com');
    for (let i = 0; i < 8; i++) expect((await get(`/signup/api/invite?invite=${other}`)).status).toBe(200);
    await web.stop();
    await start();
    const starts: string[] = [];
    for (let i = 0; i < 6; i++) starts.push((await get(`/signup/google?invite=${other}`)).headers.get('location')!);
    expect(starts.slice(0, 5).every((x) => x.startsWith('https://accounts.google.com/o/oauth2/v2/auth?'))).toBe(true);
    expect(starts[5]).toBe(`/signup?invite=${other}&error=busy`);
  });

  it('without Google sign-in set up, the page says sign-up is not open, and no sign-in starts', async () => {
    await web.stop();
    await start({ google: null });
    const token = await invite();
    const info = await get(`/signup/api/invite?invite=${token}`);
    expect(info.status).toBe(404);
    expect((await info.json()).error.code).toBe('unavailable');
    expect((await get(`/signup/google?invite=${token}`)).headers.get('location')).toBe('/signup?error=unavailable');
  });
});
