import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DRIVE_SCOPES, hasMeetingScopes, MEETING_SCOPES, meetingAccounts, removeMeetingAccount, saveMeetingAccount, TokenStore, type ConsentClient,
  type OAuth2Client,
} from '../../../src/output/googleAuth.ts';
import { GoogleAuthHub } from '../../../src/output/googleAuthHub.ts';
import { getKv } from '../../../src/store/kv.ts';
import { manualClock } from '../../../src/util/clock.ts';
import { createLogger } from '../../../src/util/logger.ts';
import type { OwnerContext } from '../../../src/web/routes/context.ts';
import { CALLBACK_PATH, GoogleConnectRoutes } from '../../../src/web/routes/google.ts';
import type { IdClaims, IdTokenVerifier } from '../../../src/web/oidc.ts';
import { accountEmail } from '../../../src/output/googleAuth.ts';
import { seededDb } from '../../helpers/db.ts';

const owner: OwnerContext = { actor: 'owner@studio.in', sessionId: 'session-a', requestId: 'aaaaaaaaaaaa' };
const other: OwnerContext = { actor: 'second@studio.in', sessionId: 'session-b', requestId: 'bbbbbbbbbbbb' };
const WEB = { clientId: 'web-id', clientSecret: 'web-secret' };
const ALL_MEETING = MEETING_SCOPES.join(' ');
const CODE = 'auth-code-SECRET';
const REFRESH = 'refresh-token-SECRET';

/** Google's token endpoint and consent URL, faked: what it is asked, and what it answers. */
function fakeGoogle(answer: { refresh_token?: string | null; scope?: string; id_token?: string | null } | Error = { refresh_token: REFRESH, scope: '' }) {
  const seen: { redirectUri: string[]; authOpts: Record<string, unknown>[]; tokenArgs: unknown[] } = { redirectUri: [], authOpts: [], tokenArgs: [] };
  const createClient = (redirectUri: string): ConsentClient => {
    seen.redirectUri.push(redirectUri);
    return {
      generateCodeVerifierAsync: async () => ({ codeVerifier: 'verifier-SECRET', codeChallenge: 'challenge-1' }),
      generateAuthUrl: (opts) => {
        seen.authOpts.push(opts as unknown as Record<string, unknown>);
        return `https://accounts.google.com/o/oauth2/v2/auth?state=${opts.state}`;
      },
      getToken: async (arg) => {
        seen.tokenArgs.push(arg);
        if (answer instanceof Error) throw answer;
        return { tokens: answer };
      },
    };
  };
  return { seen, createClient };
}

function setup(o: { answer?: Parameters<typeof fakeGoogle>[0]; meetingsEnabled?: boolean; web?: typeof WEB | undefined; verifier?: IdTokenVerifier } = {}) {
  const db = seededDb();
  const key = randomBytes(32);
  new TokenStore(db, key).save('old-main-token');
  const fakeClient = () => {
    const c = { credentials: {} as Record<string, unknown>, setCredentials(x: Record<string, unknown>) { this.credentials = x; } };
    return c as unknown as OAuth2Client;
  };
  const hub = new GoogleAuthHub({ db, key, credentials: { desktop: { clientId: 'd', clientSecret: 's' }, web: WEB }, newClient: fakeClient });
  const g = fakeGoogle(o.answer);
  const audits: unknown[] = [];
  const lines: string[] = [];
  const clock = manualClock('2026-10-27T08:00:00Z');
  const routes = new GoogleConnectRoutes({
    db, hub, publicUrl: 'https://waagent.example/', web: 'web' in o ? o.web : WEB, meetingsEnabled: o.meetingsEnabled ?? false,
    audit: (e) => audits.push(e), log: createLogger('debug', { write: (l: string) => void lines.push(l) }), clock, createClient: g.createClient,
    ...(o.verifier ? { verifier: o.verifier } : {}),
  });
  /** connect, then the state from the URL. */
  const begin = async (ctx: OwnerContext, account: unknown) => {
    const r = await routes.connect(ctx, { account });
    expect(r.status).toBe(200);
    return new URL((r.body as { url: string }).url).searchParams.get('state')!;
  };
  return { db, key, hub, g, audits, lines, clock, routes, begin };
}

describe('GoogleConnectRoutes', () => {
  it('main: asks for the Drive scope (and the meeting ones with meetings on) with PKCE, offline access and consent', async () => {
    const t = setup({ meetingsEnabled: true });
    await t.begin(owner, 'main');
    expect(t.g.seen.redirectUri[0]).toBe(`https://waagent.example${CALLBACK_PATH}`);
    expect(t.g.seen.authOpts[0]).toMatchObject({
      access_type: 'offline', prompt: 'consent', code_challenge_method: 'S256', code_challenge: 'challenge-1', scope: [...DRIVE_SCOPES, ...MEETING_SCOPES, 'openid', 'email'],
    });
    expect((t.g.seen.authOpts[0] as { state: string }).state).toMatch(/^[0-9a-f]{32}$/);
  });

  it('main happy path: stores the web-issued token through the hub and redirects with connected=main', async () => {
    const t = setup({ answer: { refresh_token: REFRESH, scope: DRIVE_SCOPES[0]! } });
    const before = t.hub.client('main');
    const state = await t.begin(owner, 'main');
    const r = await t.routes.callback(owner, { state, code: CODE });
    expect(r).toEqual({ status: 302, location: '/dashboard/connections?connected=main' });
    expect(t.g.seen.tokenArgs).toEqual([{ code: CODE, codeVerifier: 'verifier-SECRET' }]);
    expect(t.hub.client('main')).not.toBe(before);
    expect(t.hub.issuer('main')).toBe('web');
    expect(new TokenStore(t.db, t.key).load()).toBe(REFRESH);
    expect(t.audits).toEqual([{ actor: 'owner@studio.in', kind: 'connection', requestId: 'aaaaaaaaaaaa', event: 'Google account reconnected · main' }]);
  });

  it('an existing meeting account: meeting scopes only', async () => {
    const t = setup({ answer: { refresh_token: REFRESH, scope: ALL_MEETING } });
    saveMeetingAccount(t.db, t.key, 'company2', 'old', ALL_MEETING);
    const state = await t.begin(owner, 'company2');
    expect(t.g.seen.authOpts[0]!.scope).toEqual([...MEETING_SCOPES, 'openid', 'email']);
    expect(await t.routes.callback(owner, { state, code: CODE })).toEqual({ status: 302, location: '/dashboard/connections?connected=company2' });
    expect(new TokenStore(t.db, t.key, 'company2').load()).toBe(REFRESH);
    expect(getKv(t.db, 'google_client:company2')).toBe('web');
  });

  it('a new account: added to the list with its scopes, and audited as added', async () => {
    const t = setup({ answer: { refresh_token: REFRESH, scope: ALL_MEETING } });
    const state = await t.begin(owner, { add: 'company3' });
    await t.routes.callback(owner, { state, code: CODE });
    expect(meetingAccounts(t.db)).toEqual(['company3']);
    expect(hasMeetingScopes(t.db, 'company3')).toBe(true);
    expect(t.audits).toEqual([expect.objectContaining({ event: 'Google account added · company3' })]);
  });

  it('refuses an unknown label, a label that exists already, a bad label, and no web client', async () => {
    const t = setup();
    expect(await t.routes.connect(owner, { account: 'nobody' })).toMatchObject({ status: 404 });
    saveMeetingAccount(t.db, t.key, 'company2', 'old', ALL_MEETING);
    expect(await t.routes.connect(owner, { account: { add: 'company2' } })).toMatchObject({ status: 409, body: { error: { code: 'exists' } } });
    expect(await t.routes.connect(owner, { account: { add: 'Bad Name' } })).toMatchObject({ status: 400, body: { error: { code: 'invalid_label' } } });
    expect(await t.routes.connect(owner, { account: 5 })).toMatchObject({ status: 400 });
    const noWeb = setup({ web: undefined });
    expect(await noWeb.routes.connect(owner, { account: 'main' })).toMatchObject({ status: 503, body: { error: { code: 'not_configured' } } });
  });

  it.each([
    ['no refresh token', { refresh_token: null, scope: DRIVE_SCOPES[0]! }, 'no_refresh_token'],
    ['a missing scope', { refresh_token: REFRESH, scope: 'openid' }, 'missing_scope'],
    ['an exchange error', new Error(`google said ${CODE}`), 'exchange'],
  ])('%s: refused, nothing stored', async (_name, answer, code) => {
    const t = setup({ answer });
    const before = t.hub.client('main');
    const state = await t.begin(owner, 'main');
    expect(await t.routes.callback(owner, { state, code: CODE })).toEqual({ status: 302, location: `/dashboard/connections?google_error=${code}` });
    expect(t.hub.client('main')).toBe(before);
    expect(new TokenStore(t.db, t.key).load()).toBe('old-main-token');
    expect(t.audits).toEqual([]);
  });

  it('a wrong, replayed or expired state is refused; the owner denying access too', async () => {
    const t = setup({ answer: { refresh_token: REFRESH, scope: DRIVE_SCOPES[0]! } });
    expect((await t.routes.callback(owner, { state: 'nope', code: CODE })).location).toContain('google_error=state');
    const state = await t.begin(owner, 'main');
    await t.routes.callback(owner, { state, code: CODE });
    expect((await t.routes.callback(owner, { state, code: CODE })).location).toContain('google_error=state'); // one use
    const late = await t.begin(owner, 'main');
    t.clock.advance(10 * 60_000);
    expect((await t.routes.callback(owner, { state: late, code: CODE })).location).toContain('google_error=state');
    const denied = await t.begin(owner, 'main');
    expect((await t.routes.callback(owner, { state: denied, error: 'access_denied' })).location).toContain('google_error=denied');
  });

  it("another owner's session cannot complete someone else's sign-in, which stays usable for its owner", async () => {
    const t = setup({ answer: { refresh_token: REFRESH, scope: DRIVE_SCOPES[0]! } });
    const state = await t.begin(owner, 'main');
    expect((await t.routes.callback(other, { state, code: CODE })).location).toContain('google_error=state');
    expect(t.g.seen.tokenArgs).toEqual([]);
    expect((await t.routes.callback(owner, { state, code: CODE })).location).toContain('connected=main');
  });

  it('keeps at most 5 pending sign-ins per session (the oldest go first)', async () => {
    const t = setup({ answer: { refresh_token: REFRESH, scope: DRIVE_SCOPES[0]! } });
    const states: string[] = [];
    for (let i = 0; i < 6; i++) states.push(await t.begin(owner, 'main'));
    expect((await t.routes.callback(owner, { state: states[0]!, code: CODE })).location).toContain('google_error=state');
    expect((await t.routes.callback(owner, { state: states[5]!, code: CODE })).location).toContain('connected=main');
  });

  it('a missing meeting scope is refused too: main with meetings on, and a meeting account', async () => {
    const main = setup({ meetingsEnabled: true, answer: { refresh_token: REFRESH, scope: [DRIVE_SCOPES[0], ...MEETING_SCOPES.slice(1)].join(' ') } });
    const s1 = await main.begin(owner, 'main');
    expect((await main.routes.callback(owner, { state: s1, code: CODE })).location).toContain('google_error=missing_scope');
    const acct = setup({ answer: { refresh_token: REFRESH, scope: MEETING_SCOPES.slice(0, 2).join(' ') } });
    const s2 = await acct.begin(owner, { add: 'company3' });
    expect((await acct.routes.callback(owner, { state: s2, code: CODE })).location).toContain('google_error=missing_scope');
    expect(meetingAccounts(acct.db)).toEqual([]);
  });

  it('the account list is checked again at the callback: a second add of one name, and a reconnect of a removed account', async () => {
    const t = setup({ answer: { refresh_token: REFRESH, scope: ALL_MEETING } });
    const first = await t.begin(owner, { add: 'company3' });
    const second = await t.begin(owner, { add: 'company3' }); // another tab
    expect((await t.routes.callback(owner, { state: first, code: CODE })).location).toContain('connected=company3');
    expect((await t.routes.callback(owner, { state: second, code: CODE })).location).toContain('google_error=exists');
    expect(new TokenStore(t.db, t.key, 'company3').load()).toBe(REFRESH);
    const again = await t.begin(owner, 'company3');
    removeMeetingAccount(t.db, 'company3'); // the CLI removed it meanwhile
    expect((await t.routes.callback(owner, { state: again, code: CODE })).location).toContain('google_error=not_found');
    expect(meetingAccounts(t.db)).toEqual([]);
  });

  it('refuses to start without PKCE', async () => {
    const db = seededDb();
    const key = randomBytes(32);
    const hub = new GoogleAuthHub({ db, key, credentials: { web: WEB }, newClient: () => ({ setCredentials() {} }) as unknown as OAuth2Client });
    const routes = new GoogleConnectRoutes({
      db, hub, publicUrl: 'https://waagent.example', web: WEB, meetingsEnabled: false, audit: () => {}, log: createLogger('silent'),
      createClient: () => ({
        generateCodeVerifierAsync: async () => ({}),
        generateAuthUrl: () => 'https://accounts.google.com/x',
        getToken: async () => ({ tokens: {} }),
      }),
    });
    expect(await routes.connect(owner, { account: 'main' })).toMatchObject({ status: 503, body: { error: { code: 'unavailable' } } });
  });

  it('no token, code or verifier in any response, audit line or log line', async () => {
    const t = setup({ answer: new Error(`invalid_grant ${CODE} ${REFRESH}`) });
    const state = await t.begin(owner, 'main');
    const r = await t.routes.callback(owner, { state, code: CODE });
    const ok = setup({ answer: { refresh_token: REFRESH, scope: DRIVE_SCOPES[0]! } });
    const s2 = await ok.begin(owner, 'main');
    const r2 = await ok.routes.callback(owner, { state: s2, code: CODE });
    const everything = JSON.stringify([r, r2, t.audits, ok.audits]) + t.lines.join('') + ok.lines.join('');
    expect(everything).not.toMatch(/SECRET/);
  });
});

describe('GoogleConnectRoutes: the account email (owner fix 3)', () => {
  const ID_TOKEN = 'id-token-SECRET';
  /** A verifier that accepts only ID_TOKEN and returns these claims; the nonce is read from the consent URL options. */
  const claimsFor = (over: Partial<IdClaims> = {}) => (t: ReturnType<typeof setup>): IdClaims => ({
    iss: 'https://accounts.google.com', aud: WEB.clientId, exp: Date.parse('2026-10-27T09:00:00Z') / 1000,
    nonce: (t.g.seen.authOpts[0] as { nonce?: string }).nonce, email: 'Meetings@Studio.IN', email_verified: true, ...over,
  });
  function withVerifier(over: Partial<IdClaims> = {}, answer: Parameters<typeof fakeGoogle>[0] = { refresh_token: REFRESH, scope: DRIVE_SCOPES[0], id_token: ID_TOKEN }) {
    const box: { t?: ReturnType<typeof setup> } = {};
    const verifier: IdTokenVerifier = async (token) => {
      if (token !== ID_TOKEN) throw new Error('bad signature');
      return claimsFor(over)(box.t!);
    };
    box.t = setup({ verifier, answer });
    return box.t;
  }

  it('asks Google for openid and email too, with a fresh nonce bound into the sign-in', async () => {
    const t = withVerifier();
    await t.begin(owner, 'main');
    const opts = t.g.seen.authOpts[0] as { scope: string[]; nonce: string };
    expect(opts.scope).toEqual(expect.arrayContaining(['openid', 'email']));
    expect(opts.nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it('stores the email from a verified ID token, lower-cased; the audit line has it masked; no log line has it', async () => {
    const t = withVerifier();
    const state = await t.begin(owner, 'main');
    expect((await t.routes.callback(owner, { state, code: CODE })).location).toBe('/dashboard/connections?connected=main');
    expect(accountEmail(t.db, 'main')).toBe('meetings@studio.in');
    expect(JSON.stringify(t.audits)).toContain('me••••@studio.in');
    expect(JSON.stringify(t.audits)).not.toContain('meetings@studio.in');
    expect(t.lines.join('\n')).not.toMatch(/meetings@|studio\.in|SECRET/i);
  });

  it.each([
    ['email_verified false', { email_verified: false }],
    ['another client as the audience', { aud: 'someone-else' }],
    ['another sign-in\'s nonce', { nonce: 'f'.repeat(32) }],
    ['an expired token', { exp: Date.parse('2026-10-27T07:00:00Z') / 1000 }],
    ['no email', { email: undefined }],
  ])('%s: the reconnect stands, but no email is stored', async (_, over) => {
    const t = withVerifier(over as Partial<IdClaims>);
    const state = await t.begin(owner, 'main');
    expect((await t.routes.callback(owner, { state, code: CODE })).location).toBe('/dashboard/connections?connected=main');
    expect(accountEmail(t.db, 'main')).toBeNull();
    expect(t.lines.join('\n')).not.toMatch(/meetings@|SECRET/i);
  });

  it('an ID token the verifier refuses, or none at all, stores no email', async () => {
    const forged = withVerifier({}, { refresh_token: REFRESH, scope: DRIVE_SCOPES[0], id_token: 'forged' });
    let state = await forged.begin(owner, 'main');
    await forged.routes.callback(owner, { state, code: CODE });
    expect(accountEmail(forged.db, 'main')).toBeNull();
    const none = withVerifier({}, { refresh_token: REFRESH, scope: DRIVE_SCOPES[0] });
    state = await none.begin(owner, 'main');
    await none.routes.callback(owner, { state, code: CODE });
    expect(accountEmail(none.db, 'main')).toBeNull();
  });

  it('a reconnect forgets the old email before storing the new one', async () => {
    const t = withVerifier({ email_verified: false });
    t.db.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run('google_account_email:main', 'old@studio.in');
    const state = await t.begin(owner, 'main');
    await t.routes.callback(owner, { state, code: CODE });
    expect(accountEmail(t.db, 'main')).toBeNull();
  });
});
