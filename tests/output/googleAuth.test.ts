import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/config/env.ts';
import { decrypt } from '../../src/crypto/envelope.ts';
import {
  DRIVE_SCOPES,
  hasMeetingScopes,
  MEETING_SCOPES,
  parseCallback,
  requestedScopes,
  runLoopbackConsent,
  saveGrantedScopes,
  scopeName,
  TokenDecryptError,
  TokenStore,
} from '../../src/output/googleAuth.ts';
import { getKv, setKv } from '../../src/store/kv.ts';
import { seededDb } from '../helpers/db.ts';

const TOKEN = '1//refresh-token-value';

describe('TokenStore', () => {
  it('round-trips and stores the token encrypted', () => {
    const db = seededDb();
    const store = new TokenStore(db, randomBytes(32));
    store.save(TOKEN);
    expect(getKv(db, 'google_refresh_token')).not.toContain('refresh-token-value');
    expect(store.load()).toBe(TOKEN);
  });

  it('returns undefined before sign-in', () => {
    expect(new TokenStore(seededDb(), randomBytes(32)).load()).toBeUndefined();
  });

  it('a different master key gives TokenDecryptError without leaking the token', () => {
    const db = seededDb();
    new TokenStore(db, randomBytes(32)).save(TOKEN);
    let err: unknown;
    try {
      new TokenStore(db, randomBytes(32)).load();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TokenDecryptError);
    expect((err as Error).message).toContain('google-auth');
    expect((err as Error).message).not.toContain('refresh-token-value');
  });

  it('a tampered stored value gives TokenDecryptError', () => {
    const db = seededDb();
    const store = new TokenStore(db, randomBytes(32));
    store.save(TOKEN);
    const blob = Buffer.from(getKv(db, 'google_refresh_token')!, 'base64');
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 0xff;
    setKv(db, 'google_refresh_token', blob.toString('base64'));
    expect(() => store.load()).toThrowError(TokenDecryptError);
    expect(() => store.load()).toThrowError(/google-auth/);
  });

  it('uses a derived key: the raw master key cannot decrypt the stored value', () => {
    const db = seededDb();
    const key = randomBytes(32);
    new TokenStore(db, key).save(TOKEN);
    const blob = Buffer.from(getKv(db, 'google_refresh_token')!, 'base64');
    expect(() => decrypt(key, blob)).toThrow();
    expect(() => decrypt(key, blob, Buffer.from('google_refresh_token'))).toThrow();
  });
});

describe('parseCallback', () => {
  it('returns the code when the state matches', () => {
    expect(parseCallback('/?state=abc&code=4%2F0AX', 'abc')).toBe('4/0AX');
  });

  it('returns undefined (not the redirect) when there is no state', () => {
    expect(parseCallback('/', 'abc')).toBeUndefined();
    expect(parseCallback('/favicon.ico', 'abc')).toBeUndefined();
    expect(parseCallback('/?code=x', 'abc')).toBeUndefined();
  });

  it('rejects a wrong state, a cleaned error, or a missing code', () => {
    expect(() => parseCallback('/?state=evil&code=x', 'abc')).toThrowError(/state mismatch/);
    expect(() => parseCallback('/?error=access_denied&state=abc', 'abc')).toThrowError(/access_denied/);
    expect(() => parseCallback('/?error=%3Cb%3Ex&state=abc', 'abc')).toThrowError(/\(bx\)/);
    expect(() => parseCallback('/?state=abc', 'abc')).toThrowError(/no authorisation code/);
  });
});

const ALL_SCOPES = [...DRIVE_SCOPES, ...MEETING_SCOPES];
// drive.meet.readonly only as a longer, different scope: a prefix match must not pass for it.
const NEAR_MISS = ALL_SCOPES.map((s) => (s.endsWith('drive.meet.readonly') ? `${s}.extra` : s)).join(' ');

describe('scopes', () => {
  it('lists the three read-only meeting scopes', () => {
    expect(MEETING_SCOPES).toEqual([
      'https://www.googleapis.com/auth/meetings.space.readonly',
      'https://www.googleapis.com/auth/calendar.events.readonly',
      'https://www.googleapis.com/auth/drive.meet.readonly',
    ]);
  });

  it('asks for Drive only when meetings are off', () => {
    expect(requestedScopes(parseEnv({}))).toEqual(['https://www.googleapis.com/auth/drive.file']);
    expect(requestedScopes(parseEnv({ MEETINGS_ENABLED: 'false' }))).toEqual(DRIVE_SCOPES);
  });

  it('adds the meeting scopes when meetings are on', () => {
    expect(requestedScopes(parseEnv({ MEETINGS_ENABLED: 'true', TEAM_EMAIL_DOMAINS: 'ourstudio.in' }))).toEqual(ALL_SCOPES);
  });

  it('names every scope in plain words', () => {
    expect(ALL_SCOPES.map(scopeName)).toEqual([
      'Google Drive (only the files WA Agent creates)',
      'Google Meet recordings list (read only)',
      'Calendar invites (read only)',
      'Meet files in Drive (read only)',
    ]);
  });
});

describe('granted scopes', () => {
  it('an old token with nothing recorded counts as Drive only', () => {
    const db = seededDb();
    new TokenStore(db, randomBytes(32)).save(TOKEN);
    expect(getKv(db, 'google_scopes')).toBeUndefined();
    expect(hasMeetingScopes(db)).toBe(false);
  });

  it('stores the granted scope string and reads it back', () => {
    const db = seededDb();
    saveGrantedScopes(db, ALL_SCOPES.join(' '));
    expect(getKv(db, 'google_scopes')).toBe(ALL_SCOPES.join(' '));
    expect(hasMeetingScopes(db)).toBe(true);
  });

  it('is true only when every meeting scope is recorded', () => {
    const db = seededDb();
    saveGrantedScopes(db, DRIVE_SCOPES.join(' '));
    expect(hasMeetingScopes(db)).toBe(false);
    saveGrantedScopes(db, [...DRIVE_SCOPES, MEETING_SCOPES[0], MEETING_SCOPES[2]].join(' '));
    expect(hasMeetingScopes(db)).toBe(false);
    saveGrantedScopes(db, ['openid', ...MEETING_SCOPES.toReversed(), ...DRIVE_SCOPES].join(' '));
    expect(hasMeetingScopes(db)).toBe(true);
  });

  it('a near-miss scope does not count', () => {
    const db = seededDb();
    saveGrantedScopes(db, NEAR_MISS);
    expect(hasMeetingScopes(db)).toBe(false);
  });
});

function fakeClient(over: { scope?: string; tokenFails?: boolean } = {}) {
  const calls: { redirectUri?: string; authUrlOpts?: Record<string, unknown>; getTokenArg?: unknown } = {};
  const createClient = (redirectUri: string) => {
    calls.redirectUri = redirectUri;
    return {
      generateCodeVerifierAsync: async () => ({ codeVerifier: 'verifier-123', codeChallenge: 'challenge-456' }),
      generateAuthUrl: (opts: Record<string, unknown>) => {
        calls.authUrlOpts = opts;
        return `https://accounts.example/auth?state=${String(opts.state)}`;
      },
      getToken: async (arg: unknown) => {
        calls.getTokenArg = arg;
        if (over.tokenFails) throw new Error('google said: secret-detail');
        return { tokens: { refresh_token: 'rt-1', scope: over.scope ?? DRIVE_SCOPES[0] } };
      },
    };
  };
  return { calls, createClient: createClient as never };
}

async function startConsent(f: ReturnType<typeof fakeClient>, timeoutMs?: number, scopes: readonly string[] = DRIVE_SCOPES) {
  let url = '';
  let ready!: () => void;
  const urlReady = new Promise<void>((r) => (ready = r));
  const promise = runLoopbackConsent({
    clientId: 'id',
    clientSecret: 'secret',
    scopes,
    createClient: f.createClient,
    showUrl: (u) => {
      url = u;
      ready();
    },
    timeoutMs,
  });
  promise.catch(() => {});
  await urlReady;
  return { promise, base: f.calls.redirectUri!, state: new URL(url).searchParams.get('state')! };
}

describe('runLoopbackConsent', () => {
  it('builds a PKCE auth request with exactly the drive.file scope on 127.0.0.1', async () => {
    const f = fakeClient();
    const { promise, base, state } = await startConsent(f);
    const o = f.calls.authUrlOpts!;
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(o.code_challenge).toBe('challenge-456');
    expect(o.code_challenge_method).toBe('S256');
    expect(o.access_type).toBe('offline');
    expect(o.prompt).toBe('consent');
    expect(o.scope).toEqual(['https://www.googleapis.com/auth/drive.file']);
    const res = await fetch(`${base}/?state=${state}&code=abc`);
    expect(await res.text()).toBe('Sign-in received. Return to the terminal.');
    expect(await promise).toEqual({ refreshToken: 'rt-1', scope: 'https://www.googleapis.com/auth/drive.file' });
    expect(f.calls.getTokenArg).toEqual({ code: 'abc', codeVerifier: 'verifier-123' });
  });

  it('ignores stray requests without state and keeps waiting', async () => {
    const f = fakeClient();
    const { promise, base, state } = await startConsent(f);
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/favicon.ico`)).status).toBe(404);
    await fetch(`${base}/?state=${state}&code=abc`);
    expect((await promise).refreshToken).toBe('rt-1');
  });

  it('a wrong state gets 400 and rejects', async () => {
    const f = fakeClient();
    const { promise, base } = await startConsent(f);
    const res = await fetch(`${base}/?state=evil&code=abc`);
    expect(res.status).toBe(400);
    await expect(promise).rejects.toThrow(/state mismatch/);
  });

  it('refuses a second request after the redirect', async () => {
    const f = fakeClient();
    const { promise, base, state } = await startConsent(f);
    await fetch(`${base}/?state=${state}&code=abc`);
    await promise;
    await expect(fetch(`${base}/?state=${state}&code=abc`)).rejects.toThrow();
  });

  it('closes the server on timeout', async () => {
    const f = fakeClient();
    const { promise, base } = await startConsent(f, 50);
    await expect(promise).rejects.toThrow(/Timed out/);
    await expect(fetch(`${base}/`)).rejects.toThrow();
  });

  it('rejects when drive.file was not granted', async () => {
    const f = fakeClient({ scope: 'openid email' });
    const { promise, base, state } = await startConsent(f);
    await fetch(`${base}/?state=${state}&code=abc`);
    await expect(promise).rejects.toThrow(/Drive access was not granted/);
  });

  it('asks for the meeting scopes and returns the granted scope string', async () => {
    const granted = [...ALL_SCOPES, 'openid'].join(' ');
    const f = fakeClient({ scope: granted });
    const { promise, base, state } = await startConsent(f, undefined, ALL_SCOPES);
    expect(f.calls.authUrlOpts!.scope).toEqual(ALL_SCOPES);
    await fetch(`${base}/?state=${state}&code=abc`);
    expect(await promise).toEqual({ refreshToken: 'rt-1', scope: granted });
  });

  it('rejects a consent missing one meeting scope, naming it in plain words', async () => {
    const f = fakeClient({ scope: ALL_SCOPES.filter((s) => !s.endsWith('calendar.events.readonly')).join(' ') });
    const { promise, base, state } = await startConsent(f, undefined, ALL_SCOPES);
    await fetch(`${base}/?state=${state}&code=abc`);
    const err = (await promise.catch((e: Error) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/meeting permissions were not granted/);
    expect(err.message).toContain('Calendar invites');
    expect(err.message).not.toContain('Meet files in Drive');
    expect(err.message).not.toContain('recordings list');
    expect(err.message).not.toContain('rt-1');
    expect(err.message).not.toContain('googleapis.com');
  });

  it('rejects a near-miss scope in place of drive.meet.readonly', async () => {
    const f = fakeClient({ scope: NEAR_MISS });
    const { promise, base, state } = await startConsent(f, undefined, ALL_SCOPES);
    await fetch(`${base}/?state=${state}&code=abc`);
    const err = (await promise.catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/meeting permissions were not granted/);
    expect(err.message).toContain('Meet files in Drive');
    expect(err.name).toBe('ConsentRefused');
  });

  it('names every missing meeting scope', async () => {
    const f = fakeClient({ scope: DRIVE_SCOPES.join(' ') });
    const { promise, base, state } = await startConsent(f, undefined, ALL_SCOPES);
    await fetch(`${base}/?state=${state}&code=abc`);
    const err = (await promise.catch((e: Error) => e)) as Error;
    expect(err.message).toContain('Google Meet recordings list');
    expect(err.message).toContain('Calendar invites');
    expect(err.message).toContain('Meet files in Drive');
  });

  it('reports a missing Drive scope first, even when meeting scopes are missing too', async () => {
    const f = fakeClient({ scope: MEETING_SCOPES[0] });
    const { promise, base, state } = await startConsent(f, undefined, ALL_SCOPES);
    await fetch(`${base}/?state=${state}&code=abc`);
    await expect(promise).rejects.toThrow(/Drive access was not granted/);
  });

  it('hides Google error text when the code exchange fails', async () => {
    const f = fakeClient({ tokenFails: true });
    const { promise, base, state } = await startConsent(f);
    await fetch(`${base}/?state=${state}&code=abc`);
    const err = await promise.catch((e: Error) => e);
    expect((err as Error).message).toMatch(/would not exchange/);
    expect((err as Error).message).not.toContain('secret-detail');
  });

  it('closes the server and rejects if showUrl throws', async () => {
    const f = fakeClient();
    await expect(
      runLoopbackConsent({
        clientId: 'i',
        clientSecret: 's',
        scopes: DRIVE_SCOPES,
        createClient: f.createClient,
        showUrl: () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
    await expect(fetch(`${f.calls.redirectUri}/`)).rejects.toThrow();
  });
});
