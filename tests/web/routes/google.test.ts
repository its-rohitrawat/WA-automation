import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DRIVE_SCOPES, grantedScopes, hasMeetingScopes, MAIN_ACCOUNT, MEETING_SCOPES, meetingAccounts, removeMeetingAccount, saveMeetingAccount, TokenStore,
  type ConsentClient, type OAuth2Client,
} from '../../../src/output/googleAuth.ts';
import { founderMailer, GMAIL_SEND_SCOPE } from '../../../src/platform/gmailSender.ts';
import { GoogleAuthHub } from '../../../src/output/googleAuthHub.ts';
import { getKv } from '../../../src/store/kv.ts';
import { manualClock } from '../../../src/util/clock.ts';
import { createLogger } from '../../../src/util/logger.ts';
import type { OwnerContext } from '../../../src/web/routes/context.ts';
import { CALLBACK_PATH, GoogleConnectRoutes, type GoogleConnectDeps } from '../../../src/web/routes/google.ts';
import type { IdClaims, IdTokenVerifier } from '../../../src/web/oidc.ts';
import { accountEmail } from '../../../src/output/googleAuth.ts';
import { seededDb } from '../../helpers/db.ts';
import { rawOf } from '../../../src/store/engine/sqlite.ts';

const FOUNDER = '00000000-0000-4000-8000-000000000001'; // the founder's fixed id (src/platform/store.ts)
const owner: OwnerContext = { actor: 'owner@studio.in', sessionId: 'session-a', requestId: 'aaaaaaaaaaaa', role: 'founder', tenantId: FOUNDER };
const other: OwnerContext = { actor: 'second@studio.in', sessionId: 'session-b', requestId: 'bbbbbbbbbbbb', role: 'founder', tenantId: FOUNDER };
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

async function setup(o: {
  answer?: Parameters<typeof fakeGoogle>[0]; meetingsEnabled?: boolean; invitesGmail?: boolean; web?: typeof WEB | undefined; verifier?: IdTokenVerifier;
  extra?: Partial<GoogleConnectDeps>;
} = {}) {
  const db = await seededDb();
  const key = randomBytes(32);
  await new TokenStore(db, key).save('old-main-token');
  const fakeClient = () => {
    const c = { credentials: {} as Record<string, unknown>, setCredentials(x: Record<string, unknown>) { this.credentials = x; } };
    return c as unknown as OAuth2Client;
  };
  const hub = await GoogleAuthHub.open({ db, key, credentials: { desktop: { clientId: 'd', clientSecret: 's' }, web: WEB }, newClient: fakeClient });
  const g = fakeGoogle(o.answer);
  const audits: unknown[] = [];
  const lines: string[] = [];
  const clock = manualClock('2026-10-27T08:00:00Z');
  const routes = new GoogleConnectRoutes({
    db, hub, publicUrl: 'https://waagent.example/', web: 'web' in o ? o.web : WEB, meetingsEnabled: o.meetingsEnabled ?? false, invitesGmail: o.invitesGmail ?? false,
    audit: async (e) => { audits.push(e); }, log: createLogger('debug', { write: (l: string) => void lines.push(l) }), clock, createClient: g.createClient,
    ...(o.verifier ? { verifier: o.verifier } : {}),
    ...o.extra,
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
    const t = await setup({ meetingsEnabled: true });
    await t.begin(owner, 'main');
    expect(t.g.seen.redirectUri[0]).toBe(`https://waagent.example${CALLBACK_PATH}`);
    expect(t.g.seen.authOpts[0]).toMatchObject({
      access_type: 'offline', prompt: 'consent', code_challenge_method: 'S256', code_challenge: 'challenge-1', scope: [...DRIVE_SCOPES, ...MEETING_SCOPES, 'openid', 'email'],
    });
    expect((t.g.seen.authOpts[0] as { state: string }).state).toMatch(/^[0-9a-f]{32}$/);
  });

  it('main happy path: stores the web-issued token through the hub and redirects with connected=main', async () => {
    const t = await setup({ answer: { refresh_token: REFRESH, scope: DRIVE_SCOPES[0]! } });
    const before = t.hub.client('main');
    const state = await t.begin(owner, 'main');
    const r = await t.routes.callback(owner, { state, code: CODE });
    expect(r).toEqual({ status: 302, location: '/dashboard/connections?connected=main' });
    expect(t.g.seen.tokenArgs).toEqual([{ code: CODE, codeVerifier: 'verifier-SECRET' }]);
    expect(t.hub.client('main')).not.toBe(before);
    expect(t.hub.issuer('main')).toBe('web');
    expect(await new TokenStore(t.db, t.key).load()).toBe(REFRESH);
    expect(t.audits).toEqual([{ actor: 'owner@studio.in', kind: 'connection', requestId: 'aaaaaaaaaaaa', event: 'Google account reconnected · main' }]);
  });

  it('an existing meeting account: meeting scopes only', async () => {
    const t = await setup({ answer: { refresh_token: REFRESH, scope: ALL_MEETING } });
    await saveMeetingAccount(t.db, t.key, 'company2', 'old', ALL_MEETING);
    const state = await t.begin(owner, 'company2');
    expect(t.g.seen.authOpts[0]!.scope).toEqual([...MEETING_SCOPES, 'openid', 'email']);
    expect(await t.routes.callback(owner, { state, code: CODE })).toEqual({ status: 302, location: '/dashboard/connections?connected=company2' });
    expect(await new TokenStore(t.db, t.key, 'company2').load()).toBe(REFRESH);
    expect(await getKv(t.db, 'google_client:company2')).toBe('web');
  });

  it('a new account: added to the list with its scopes, and audited as added', async () => {
    const t = await setup({ answer: { refresh_token: REFRESH, scope: ALL_MEETING } });
    const state = await t.begin(owner, { add: 'company3' });
    await t.routes.callback(owner, { state, code: CODE });
    expect(await meetingAccounts(t.db)).toEqual(['company3']);
    expect(await hasMeetingScopes(t.db, 'company3')).toBe(true);
    expect(t.audits).toEqual([expect.objectContaining({ event: 'Google account added · company3' })]);
  });

  it('refuses an unknown label, a label that exists already, a bad label, and no web client', async () => {
    const t = await setup();
    expect(await t.routes.connect(owner, { account: 'nobody' })).toMatchObject({ status: 404 });
    await saveMeetingAccount(t.db, t.key, 'company2', 'old', ALL_MEETING);
    expect(await t.routes.connect(owner, { account: { add: 'company2' } })).toMatchObject({ status: 409, body: { error: { code: 'exists' } } });
    expect(await t.routes.connect(owner, { account: { add: 'Bad Name' } })).toMatchObject({ status: 400, body: { error: { code: 'invalid_label' } } });
    expect(await t.routes.connect(owner, { account: 5 })).toMatchObject({ status: 400 });
    const noWeb = await setup({ web: undefined });
    expect(await noWeb.routes.connect(owner, { account: 'main' })).toMatchObject({ status: 503, body: { error: { code: 'not_configured' } } });
  });

  it.each([
    ['no refresh token', { refresh_token: null, scope: DRIVE_SCOPES[0]! }, 'no_refresh_token'],
    ['a missing scope', { refresh_token: REFRESH, scope: 'openid' }, 'missing_scope'],
    ['an exchange error', new Error(`google said ${CODE}`), 'exchange'],
  ])('%s: refused, nothing stored', async (_name, answer, code) => {
    const t = await setup({ answer });
    const before = t.hub.client('main');
    const state = await t.begin(owner, 'main');
    expect(await t.routes.callback(owner, { state, code: CODE })).toEqual({ status: 302, location: `/dashboard/connections?google_error=${code}` });
    expect(t.hub.client('main')).toBe(before);
    expect(await new TokenStore(t.db, t.key).load()).toBe('old-main-token');
    expect(t.audits).toEqual([]);
  });

  it('a wrong, replayed or expired state is refused; the owner denying access too', async () => {
    const t = await setup({ answer: { refresh_token: REFRESH, scope: DRIVE_SCOPES[0]! } });
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
    const t = await setup({ answer: { refresh_token: REFRESH, scope: DRIVE_SCOPES[0]! } });
    const state = await t.begin(owner, 'main');
    expect((await t.routes.callback(other, { state, code: CODE })).location).toContain('google_error=state');
    expect(t.g.seen.tokenArgs).toEqual([]);
    expect((await t.routes.callback(owner, { state, code: CODE })).location).toContain('connected=main');
  });

  it('keeps at most 5 pending sign-ins per session (the oldest go first)', async () => {
    const t = await setup({ answer: { refresh_token: REFRESH, scope: DRIVE_SCOPES[0]! } });
    const states: string[] = [];
    for (let i = 0; i < 6; i++) states.push(await t.begin(owner, 'main'));
    expect((await t.routes.callback(owner, { state: states[0]!, code: CODE })).location).toContain('google_error=state');
    expect((await t.routes.callback(owner, { state: states[5]!, code: CODE })).location).toContain('connected=main');
  });

  it('with invites by Gmail on, main also asks for gmail.send; a meeting account never does (S5H.4 A)', async () => {
    const t = await setup({ invitesGmail: true });
    await t.begin(owner, 'main');
    expect(t.g.seen.authOpts[0]!.scope).toEqual([...DRIVE_SCOPES, GMAIL_SEND_SCOPE, 'openid', 'email']);
    await t.begin(owner, { add: 'company4' });
    expect(t.g.seen.authOpts[1]!.scope).not.toContain(GMAIL_SEND_SCOPE);
  });

  it('gmail.send is optional: a grant without it connects, and invites then have no Gmail mailer (Send invite off)', async () => {
    const t = await setup({ invitesGmail: true, answer: { refresh_token: REFRESH, scope: DRIVE_SCOPES.join(' ') } });
    const state = await t.begin(owner, 'main');
    expect(await t.routes.callback(owner, { state, code: CODE })).toEqual({ status: 302, location: '/dashboard/connections?connected=main' });
    const transport = {} as Parameters<typeof founderMailer>[0]['transport'];
    expect(founderMailer({ grantedScopes: await grantedScopes(t.db, MAIN_ACCOUNT), from: 'owner@studio.in', transport })).toBeNull();
    // Granted, the same account gets a mailer: the screen offers Send invite.
    const g = await setup({ invitesGmail: true, answer: { refresh_token: REFRESH, scope: [...DRIVE_SCOPES, GMAIL_SEND_SCOPE].join(' ') } });
    const s2 = await g.begin(owner, 'main');
    expect((await g.routes.callback(owner, { state: s2, code: CODE })).location).toBe('/dashboard/connections?connected=main');
    expect(founderMailer({ grantedScopes: await grantedScopes(g.db, MAIN_ACCOUNT), from: 'owner@studio.in', transport })).not.toBeNull();
  });

  it('a missing meeting scope is refused too: main with meetings on, and a meeting account', async () => {
    const main = await setup({ meetingsEnabled: true, answer: { refresh_token: REFRESH, scope: [DRIVE_SCOPES[0], ...MEETING_SCOPES.slice(1)].join(' ') } });
    const s1 = await main.begin(owner, 'main');
    expect((await main.routes.callback(owner, { state: s1, code: CODE })).location).toContain('google_error=missing_scope');
    const acct = await setup({ answer: { refresh_token: REFRESH, scope: MEETING_SCOPES.slice(0, 2).join(' ') } });
    const s2 = await acct.begin(owner, { add: 'company3' });
    expect((await acct.routes.callback(owner, { state: s2, code: CODE })).location).toContain('google_error=missing_scope');
    expect(await meetingAccounts(acct.db)).toEqual([]);
  });

  it('the account list is checked again at the callback: a second add of one name, and a reconnect of a removed account', async () => {
    const t = await setup({ answer: { refresh_token: REFRESH, scope: ALL_MEETING } });
    const first = await t.begin(owner, { add: 'company3' });
    const second = await t.begin(owner, { add: 'company3' }); // another tab
    expect((await t.routes.callback(owner, { state: first, code: CODE })).location).toContain('connected=company3');
    expect((await t.routes.callback(owner, { state: second, code: CODE })).location).toContain('google_error=exists');
    expect(await new TokenStore(t.db, t.key, 'company3').load()).toBe(REFRESH);
    const again = await t.begin(owner, 'company3');
    await removeMeetingAccount(t.db, 'company3'); // the CLI removed it meanwhile
    expect((await t.routes.callback(owner, { state: again, code: CODE })).location).toContain('google_error=not_found');
    expect(await meetingAccounts(t.db)).toEqual([]);
  });

  it('refuses to start without PKCE', async () => {
    const db = await seededDb();
    const key = randomBytes(32);
    const hub = await GoogleAuthHub.open({ db, key, credentials: { web: WEB }, newClient: () => ({ setCredentials() {} }) as unknown as OAuth2Client });
    const routes = new GoogleConnectRoutes({
      db, hub, publicUrl: 'https://waagent.example', web: WEB, meetingsEnabled: false, invitesGmail: false, audit: async () => {}, log: createLogger('silent'),
      createClient: () => ({
        generateCodeVerifierAsync: async () => ({}),
        generateAuthUrl: () => 'https://accounts.google.com/x',
        getToken: async () => ({ tokens: {} }),
      }),
    });
    expect(await routes.connect(owner, { account: 'main' })).toMatchObject({ status: 503, body: { error: { code: 'unavailable' } } });
  });

  it('no token, code or verifier in any response, audit line or log line', async () => {
    const t = await setup({ answer: new Error(`invalid_grant ${CODE} ${REFRESH}`) });
    const state = await t.begin(owner, 'main');
    const r = await t.routes.callback(owner, { state, code: CODE });
    const ok = await setup({ answer: { refresh_token: REFRESH, scope: DRIVE_SCOPES[0]! } });
    const s2 = await ok.begin(owner, 'main');
    const r2 = await ok.routes.callback(owner, { state: s2, code: CODE });
    const everything = JSON.stringify([r, r2, t.audits, ok.audits]) + t.lines.join('') + ok.lines.join('');
    expect(everything).not.toMatch(/SECRET/);
  });
});

describe('GoogleConnectRoutes: the account email (owner fix 3)', () => {
  const ID_TOKEN = 'id-token-SECRET';
  /** A verifier that accepts only ID_TOKEN and returns these claims; the nonce is read from the consent URL options. */
  const claimsFor = (over: Partial<IdClaims> = {}) => (t: Awaited<ReturnType<typeof setup>>): IdClaims => ({
    iss: 'https://accounts.google.com', aud: WEB.clientId, exp: Date.parse('2026-10-27T09:00:00Z') / 1000,
    nonce: (t.g.seen.authOpts[0] as { nonce?: string }).nonce, email: 'Meetings@Studio.IN', email_verified: true, ...over,
  });
  async function withVerifier(over: Partial<IdClaims> = {}, answer: Parameters<typeof fakeGoogle>[0] = { refresh_token: REFRESH, scope: DRIVE_SCOPES[0], id_token: ID_TOKEN }) {
    const box: { t?: Awaited<ReturnType<typeof setup>> } = {};
    const verifier: IdTokenVerifier = async (token) => {
      if (token !== ID_TOKEN) throw new Error('bad signature');
      return claimsFor(over)(box.t!);
    };
    box.t = await setup({ verifier, answer });
    return box.t;
  }

  it('asks Google for openid and email too, with a fresh nonce bound into the sign-in', async () => {
    const t = await withVerifier();
    await t.begin(owner, 'main');
    const opts = t.g.seen.authOpts[0] as { scope: string[]; nonce: string };
    expect(opts.scope).toEqual(expect.arrayContaining(['openid', 'email']));
    expect(opts.nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it('stores the email from a verified ID token, lower-cased; the audit line has it masked; no log line has it', async () => {
    const t = await withVerifier();
    const state = await t.begin(owner, 'main');
    expect((await t.routes.callback(owner, { state, code: CODE })).location).toBe('/dashboard/connections?connected=main');
    expect(await accountEmail(t.db, 'main')).toBe('meetings@studio.in');
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
    const t = await withVerifier(over as Partial<IdClaims>);
    const state = await t.begin(owner, 'main');
    expect((await t.routes.callback(owner, { state, code: CODE })).location).toBe('/dashboard/connections?connected=main');
    expect(await accountEmail(t.db, 'main')).toBeNull();
    expect(t.lines.join('\n')).not.toMatch(/meetings@|SECRET/i);
  });

  it('an ID token the verifier refuses, or none at all, stores no email', async () => {
    const forged = await withVerifier({}, { refresh_token: REFRESH, scope: DRIVE_SCOPES[0], id_token: 'forged' });
    let state = await forged.begin(owner, 'main');
    await forged.routes.callback(owner, { state, code: CODE });
    expect(await accountEmail(forged.db, 'main')).toBeNull();
    const none = await withVerifier({}, { refresh_token: REFRESH, scope: DRIVE_SCOPES[0] });
    state = await none.begin(owner, 'main');
    await none.routes.callback(owner, { state, code: CODE });
    expect(await accountEmail(none.db, 'main')).toBeNull();
  });

  it('a reconnect forgets the old email before storing the new one', async () => {
    const t = await withVerifier({ email_verified: false });
    rawOf(t.db).prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run('google_account_email:main', 'old@studio.in');
    const state = await t.begin(owner, 'main');
    await t.routes.callback(owner, { state, code: CODE });
    expect(await accountEmail(t.db, 'main')).toBeNull();
  });
});

describe('GoogleConnectRoutes per customer (S4.7 A1): a signed state, and each customer’s token in their own database', () => {
  const A = '6f1c2e9a-3b4d-4c5e-8f60-718293a4b5c6';
  const B = '7a2d3f0b-4c5e-4d6f-9071-8293a4b5c6d7';
  const custA: OwnerContext = { actor: 'a@customer.in', sessionId: 'session-ca', requestId: 'cccccccccccc', role: 'owner', tenantId: A };
  const custB: OwnerContext = { actor: 'b@customer.in', sessionId: 'session-cb', requestId: 'dddddddddddd', role: 'owner', tenantId: B };

  async function platform() {
    const stateKey = randomBytes(32);
    const customers = new Map([[A, { db: await seededDb(), key: randomBytes(32) }], [B, { db: await seededDb(), key: randomBytes(32) }]]);
    const told: string[] = [];
    const t = await setup({
      answer: { refresh_token: REFRESH, scope: DRIVE_SCOPES[0]! },
      extra: { stateKey, customer: async (id) => customers.get(id) ?? null, onCustomerToken: (id, label) => void told.push(`${id} ${label}`) },
    });
    const tokenOf = (id: string) => new TokenStore(customers.get(id)!.db, customers.get(id)!.key).load();
    return { ...t, stateKey, customers, told, tokenOf };
  }

  it('a customer’s token is stored only in their own database, under their own key, and their runtime is told', async () => {
    const t = await platform();
    const state = await t.begin(custA, 'main');
    expect(state).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/); // signed, not the random hex of before
    expect(await t.routes.callback(custA, { state, code: CODE })).toEqual({ status: 302, location: '/dashboard/connections?connected=main' });
    expect(await t.tokenOf(A)).toBe(REFRESH);
    expect(await getKv(t.customers.get(A)!.db, 'google_client:main')).toBe('web');
    expect(await t.tokenOf(B)).toBeUndefined();
    expect(await new TokenStore(t.db, t.key).load()).toBe('old-main-token'); // the founder's untouched
    expect(t.told).toEqual([`${A} main`]);
  });

  it('A’s callback carrying B’s state is refused, stores nothing, and leaves B’s own sign-in usable', async () => {
    const t = await platform();
    const bState = await t.begin(custB, 'main');
    expect(await t.routes.callback(custA, { state: bState, code: CODE })).toEqual({ status: 302, location: '/dashboard/connections?google_error=state' });
    expect(t.g.seen.tokenArgs).toEqual([]); // no code was exchanged
    expect(await t.tokenOf(A)).toBeUndefined();
    expect(await t.tokenOf(B)).toBeUndefined();
    const logged = t.lines.join('\n');
    expect(logged).toContain('state_other_workspace');
    for (const secret of [A, B, bState, 'a@customer.in', 'b@customer.in']) expect(logged).not.toContain(secret);
    // B's pending sign-in was not used up by A's try.
    expect((await t.routes.callback(custB, { state: bState, code: CODE })).location).toBe('/dashboard/connections?connected=main');
    expect(await t.tokenOf(B)).toBe(REFRESH);
    expect(await t.tokenOf(A)).toBeUndefined();
  });

  it('an expired state (10 minutes and 1 ms) is refused before anything is looked up or stored', async () => {
    const t = await platform();
    const state = await t.begin(custA, 'main');
    t.clock.advance(10 * 60_000 + 1);
    expect((await t.routes.callback(custA, { state, code: CODE })).location).toBe('/dashboard/connections?google_error=state');
    expect(t.lines.join('\n')).toContain('state_invalid');
    expect(t.g.seen.tokenArgs).toEqual([]);
    expect(await t.tokenOf(A)).toBeUndefined();
  });

  it('a forged state is refused: one character changed, or signed with another key for the right customer', async () => {
    const t = await platform();
    const state = await t.begin(custA, 'main');
    const changed = state.slice(0, 5) + (state[5] === 'A' ? 'B' : 'A') + state.slice(6);
    const { signOAuthState } = await import('../../../src/output/oauthState.ts');
    const otherKey = signOAuthState(randomBytes(32), { tenantId: A, account: 'main', at: t.clock.now() });
    for (const s of [changed, otherKey, '', 'not-a-state']) {
      expect((await t.routes.callback(custA, { state: s, code: CODE })).location).toBe('/dashboard/connections?google_error=state');
    }
    expect(t.g.seen.tokenArgs).toEqual([]);
    expect(await t.tokenOf(A)).toBeUndefined();
    // The real one still works afterwards.
    expect((await t.routes.callback(custA, { state, code: CODE })).location).toBe('/dashboard/connections?connected=main');
  });

  it('a customer is refused without a signing key or resolver, or with no role; a workspace not there yet answers 503', async () => {
    const plain = await setup();
    expect((await plain.routes.connect(custA, { account: 'main' })).status).toBe(403);
    const noRole: OwnerContext = { actor: 'x@x.in', sessionId: 's', requestId: 'eeeeeeeeeeee' };
    expect((await plain.routes.connect(noRole, { account: 'main' })).status).toBe(403);
    const t = await platform();
    const stranger: OwnerContext = { ...custA, tenantId: '8b3e4a1c-5d6f-4e70-a182-93a4b5c6d7e8' };
    expect(await t.routes.connect(stranger, { account: 'main' })).toMatchObject({ status: 503, body: { error: { code: 'workspace_starting' } } });
  });

  it('the founder with the signing key: the state is signed with the founder’s id, and the token goes through the hub as before', async () => {
    const t = await platform();
    const state = await t.begin(owner, 'main');
    expect(state).toContain('.');
    expect((await t.routes.callback(owner, { state, code: CODE })).location).toBe('/dashboard/connections?connected=main');
    expect(await new TokenStore(t.db, t.key).load()).toBe(REFRESH);
    expect(t.hub.issuer('main')).toBe('web');
    expect(await t.tokenOf(A)).toBeUndefined();
    expect(t.told).toEqual([]);
    // A customer cannot finish the founder's sign-in, even holding its state.
    const founderState = await t.begin(owner, 'main');
    expect((await t.routes.callback(custA, { state: founderState, code: CODE })).location).toBe('/dashboard/connections?google_error=state');
  });
});
