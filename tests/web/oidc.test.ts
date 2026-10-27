import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { manualClock } from '../../src/util/clock.ts';
import {
  authorizeUrl,
  browserLabel,
  checkClaims,
  DASHBOARD_SCREENS,
  googleCodeExchanger,
  GOOGLE_AUTHORIZE_URL,
  maskEmail,
  PENDING_MAX,
  PENDING_TTL_MS,
  PendingSignIns,
  safeReturnPath,
  SignInError,
  SignInRefused,
} from '../../src/web/oidc.ts';

const T0 = '2026-10-27T10:00:00.000Z';
const CLIENT_ID = 'client-123.apps.googleusercontent.com';

describe('safeReturnPath', () => {
  it('keeps /dashboard and every known screen', () => {
    expect(safeReturnPath(null)).toBe('/dashboard');
    expect(safeReturnPath('/dashboard')).toBe('/dashboard');
    for (const s of DASHBOARD_SCREENS) expect(safeReturnPath(`/dashboard/${s}`)).toBe(`/dashboard/${s}`);
    expect(safeReturnPath('/dashboard/clients/groups')).toBe('/dashboard/clients/groups');
    expect(DASHBOARD_SCREENS).toHaveLength(11);
  });

  it.each([
    '//evil.com',
    'https://evil.com',
    'https://evil.com/dashboard/tasks',
    '/dashboard/../x',
    '/dashboard/%2e%2e/x',
    '/dashboard/nope',
    '/dashboard/tasks/',
    '/dashboard/tasks?x=1',
    '/dashboard//evil.com',
    '/\\evil.com',
    'javascript:alert(1)',
    '',
    '/dashboard/tasks/extra',
    '/Dashboard/tasks',
  ])('anything else becomes /dashboard: %s', (raw) => {
    expect(safeReturnPath(raw)).toBe('/dashboard');
  });
});

describe('PendingSignIns', () => {
  it('a record is used once: the right state passes, then the same key is gone', () => {
    const clock = manualClock(T0);
    const p = new PendingSignIns(clock);
    const a = p.add({ redirectUri: 'http://localhost:8787/dashboard/auth/callback', returnTo: '/dashboard/tasks' });
    expect(a.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set([a.key, a.state, a.nonce]).size).toBe(3);
    const got = p.take(a.key, a.state);
    expect(got.returnTo).toBe('/dashboard/tasks');
    expect(got.nonce).toBe(a.nonce);
    expect(createHash('sha256').update(got.verifier).digest('base64url')).toBe(a.challenge);
    expect(() => p.take(a.key, a.state)).toThrow(SignInError);
  });

  it('a wrong state is refused and also uses up the record', () => {
    const p = new PendingSignIns(manualClock(T0));
    const a = p.add({ redirectUri: 'x', returnTo: '/dashboard' });
    expect(() => p.take(a.key, 'wrong')).toThrow(expect.objectContaining({ code: 'state_mismatch' }));
    expect(() => p.take(a.key, a.state)).toThrow(expect.objectContaining({ code: 'no_pending' }));
  });

  it('no cookie or no state is refused', () => {
    const p = new PendingSignIns(manualClock(T0));
    const a = p.add({ redirectUri: 'x', returnTo: '/dashboard' });
    expect(() => p.take(undefined, a.state)).toThrow(expect.objectContaining({ code: 'no_pending' }));
    expect(() => p.take(a.key, null)).toThrow(expect.objectContaining({ code: 'state_mismatch' }));
  });

  it('a record older than 10 minutes is refused', () => {
    const clock = manualClock(T0);
    const p = new PendingSignIns(clock);
    const a = p.add({ redirectUri: 'x', returnTo: '/dashboard' });
    clock.advance(PENDING_TTL_MS + 1);
    expect(() => p.take(a.key, a.state)).toThrow(expect.objectContaining({ code: 'expired' }));
  });

  it('keeps at most 100 records, dropping the oldest', () => {
    const p = new PendingSignIns(manualClock(T0));
    const first = p.add({ redirectUri: 'x', returnTo: '/dashboard' });
    for (let i = 0; i < PENDING_MAX + 20; i++) p.add({ redirectUri: 'x', returnTo: '/dashboard' });
    expect(p.size()).toBe(PENDING_MAX);
    expect(() => p.take(first.key, first.state)).toThrow(expect.objectContaining({ code: 'no_pending' }));
  });

  it('drops expired records when adding', () => {
    const clock = manualClock(T0);
    const p = new PendingSignIns(clock);
    for (let i = 0; i < 5; i++) p.add({ redirectUri: 'x', returnTo: '/dashboard' });
    clock.advance(PENDING_TTL_MS + 1);
    p.add({ redirectUri: 'x', returnTo: '/dashboard' });
    expect(p.size()).toBe(1);
  });
});

describe('authorizeUrl', () => {
  it('asks Google for openid email profile with PKCE S256, a nonce and the account picker', () => {
    const u = new URL(
      authorizeUrl({ clientId: CLIENT_ID, redirectUri: 'https://dash.example.com/dashboard/auth/callback', state: 'S', nonce: 'N', challenge: 'C' }),
    );
    expect(`${u.origin}${u.pathname}`).toBe(GOOGLE_AUTHORIZE_URL);
    const q = u.searchParams;
    expect(q.get('client_id')).toBe(CLIENT_ID);
    expect(q.get('response_type')).toBe('code');
    expect(q.get('scope')).toBe('openid email profile');
    expect(q.get('prompt')).toBe('select_account');
    expect(q.get('redirect_uri')).toBe('https://dash.example.com/dashboard/auth/callback');
    expect(q.get('state')).toBe('S');
    expect(q.get('nonce')).toBe('N');
    expect(q.get('code_challenge')).toBe('C');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.has('access_type')).toBe(false);
  });
});

describe('checkClaims', () => {
  const now = new Date(T0).getTime();
  const good = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    exp: now / 1000 + 600,
    nonce: 'N1',
    email: 'Owner@Example.com',
    email_verified: true,
    name: 'The Owner',
  };
  const check = (c: Record<string, unknown>) => checkClaims(c, { clientId: CLIENT_ID, nonce: 'N1', now });

  it('passes good claims and lower-cases the email', () => {
    expect(check(good)).toEqual({ email: 'owner@example.com', name: 'The Owner' });
    expect(check({ ...good, iss: 'accounts.google.com' }).email).toBe('owner@example.com');
  });

  it.each([
    ['issuer', { iss: 'https://evil.example.com' }],
    ['issuer', { iss: undefined }],
    ['audience', { aud: 'someone-else' }],
    ['audience', { aud: [CLIENT_ID, 'other'] }],
    ['token_expired', { exp: now / 1000 - 1 }],
    ['token_expired', { exp: 'soon' }],
    ['nonce', { nonce: 'N2' }],
    ['nonce', { nonce: undefined }],
    ['no_email', { email: '' }],
  ])('refuses a bad %s', (code, patch) => {
    expect(() => check({ ...good, ...patch })).toThrow(expect.objectContaining({ code }));
  });

  it('an unverified email is a refusal that carries the email', () => {
    for (const v of [false, 'true', undefined]) {
      let caught: unknown;
      try {
        check({ ...good, email_verified: v });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(SignInRefused);
      expect((caught as SignInRefused).reason).toBe('unverified');
      expect((caught as SignInRefused).email).toBe('owner@example.com');
    }
  });

  it('a name is kept to one plain line, and absent when missing', () => {
    const odd = `A${String.fromCharCode(0x202e)}B${String.fromCharCode(10)}C`;
    expect(check({ ...good, name: odd }).name).toBe('A B C');
    expect(check({ ...good, name: undefined }).name).toBeUndefined();
    expect(check({ ...good, name: 'x'.repeat(200) }).name).toHaveLength(80);
  });
});

describe('maskEmail', () => {
  it('keeps two letters and the domain', () => {
    expect(maskEmail('stranger@gmail.com')).toBe('st••••@gmail.com');
    expect(maskEmail('a@x.com')).toBe('a••••@x.com');
    expect(maskEmail('no-at-sign')).toBe('••••');
    expect(maskEmail(`ev${String.fromCharCode(0x202e)}il@x.com`)).toBe('ev••••@x.com');
  });
});

describe('browserLabel', () => {
  it.each([
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0', 'Edge on Windows'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 'Safari on Mac'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', 'Safari on iPhone'],
    ['Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36', 'Chrome on Android'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 'Firefox on Linux'],
    [undefined, 'A browser'],
  ])('%s', (ua, label) => {
    expect(browserLabel(ua)).toBe(label);
  });
});

describe('googleCodeExchanger (fake token endpoint)', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) await c();
  });

  async function fakeEndpoint(reply: (form: URLSearchParams) => { status: number; body: string }) {
    const seen: URLSearchParams[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        seen.push(form);
        const r = reply(form);
        res.writeHead(r.status, { 'content-type': 'application/json' }).end(r.body);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    closers.push(() => new Promise<void>((r) => server.close(() => r())));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`, seen };
  }

  it('posts the code with the PKCE verifier and returns only the ID token', async () => {
    const ep = await fakeEndpoint(() => ({ status: 200, body: JSON.stringify({ id_token: 'ID.TOKEN.X', access_token: 'AT' }) }));
    const exchange = googleCodeExchanger({ clientId: CLIENT_ID, clientSecret: 'shh', tokenUrl: ep.url });
    await expect(exchange({ code: 'C0DE', verifier: 'V', redirectUri: 'http://localhost:1/dashboard/auth/callback' })).resolves.toBe('ID.TOKEN.X');
    const f = ep.seen[0]!;
    expect(f.get('grant_type')).toBe('authorization_code');
    expect(f.get('code')).toBe('C0DE');
    expect(f.get('code_verifier')).toBe('V');
    expect(f.get('client_id')).toBe(CLIENT_ID);
    expect(f.get('client_secret')).toBe('shh');
    expect(f.get('redirect_uri')).toBe('http://localhost:1/dashboard/auth/callback');
  });

  it('a refusal, a reply without an ID token or bad JSON is a token_exchange / no_id_token failure with no echo', async () => {
    const replies = [
      { status: 400, body: '{"error":"invalid_grant","error_description":"C0DE was bad"}' },
      { status: 200, body: '{"access_token":"AT"}' },
      { status: 200, body: 'not json C0DE' },
    ];
    let i = 0;
    const ep = await fakeEndpoint(() => replies[i++]!);
    const exchange = googleCodeExchanger({ clientId: CLIENT_ID, clientSecret: 'shh', tokenUrl: ep.url });
    const codes: string[] = [];
    for (let n = 0; n < replies.length; n++) {
      try {
        await exchange({ code: 'C0DE', verifier: 'V', redirectUri: 'r' });
      } catch (e) {
        expect(e).toBeInstanceOf(SignInError);
        expect((e as Error).message).not.toContain('C0DE');
        codes.push((e as SignInError).code);
      }
    }
    expect(codes).toEqual(['token_exchange', 'no_id_token', 'token_exchange']);
  });

  it('an endpoint that cannot be reached is a token_exchange failure', async () => {
    const ep = await fakeEndpoint(() => ({ status: 200, body: '{}' }));
    await closers.pop()!();
    const exchange = googleCodeExchanger({ clientId: CLIENT_ID, clientSecret: 'shh', tokenUrl: ep.url, timeoutMs: 2_000 });
    await expect(exchange({ code: 'C0DE', verifier: 'V', redirectUri: 'r' })).rejects.toMatchObject({ code: 'token_exchange' });
  });
});
