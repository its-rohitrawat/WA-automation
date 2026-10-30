import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/config/env.ts';
import { decrypt } from '../../src/crypto/envelope.ts';
import {
  checkAccountLabel,
  DRIVE_SCOPES,
  hasMeetingScopes,
  MEETING_SCOPES,
  meetingAccounts,
  meetingsReady,
  removeMeetingAccount,
  saveMeetingAccount,
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
  it('round-trips and stores the token encrypted', async () => {
    const db = await seededDb();
    const store = new TokenStore(db, randomBytes(32));
    await store.save(TOKEN);
    expect(await getKv(db, 'google_refresh_token')).not.toContain('refresh-token-value');
    expect(await store.load()).toBe(TOKEN);
  });

  it('returns undefined before sign-in', async () => {
    expect(await new TokenStore(await seededDb(), randomBytes(32)).load()).toBeUndefined();
  });

  it('a different master key gives TokenDecryptError without leaking the token', async () => {
    const db = await seededDb();
    await new TokenStore(db, randomBytes(32)).save(TOKEN);
    let err: unknown;
    try {
      await new TokenStore(db, randomBytes(32)).load();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TokenDecryptError);
    expect((err as Error).message).toContain('google-auth');
    expect((err as Error).message).not.toContain('refresh-token-value');
  });

  it('a tampered stored value gives TokenDecryptError', async () => {
    const db = await seededDb();
    const store = new TokenStore(db, randomBytes(32));
    await store.save(TOKEN);
    const blob = Buffer.from((await getKv(db, 'google_refresh_token'))!, 'base64');
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 0xff;
    await setKv(db, 'google_refresh_token', blob.toString('base64'));
    await expect(store.load()).rejects.toThrowError(TokenDecryptError);
    await expect(store.load()).rejects.toThrowError(/google-auth/);
  });

  it('uses a derived key: the raw master key cannot decrypt the stored value', async () => {
    const db = await seededDb();
    const key = randomBytes(32);
    await new TokenStore(db, key).save(TOKEN);
    const blob = Buffer.from((await getKv(db, 'google_refresh_token'))!, 'base64');
    expect(() => decrypt(key, blob)).toThrow();
    expect(() => decrypt(key, blob, Buffer.from('google_refresh_token'))).toThrow();
  });

  it('per customer (S4.7): a token saved with customer A’s data key opens only with it, even copied into B’s store', async () => {
    const [dbA, dbB] = [await seededDb(), await seededDb()];
    const [keyA, keyB] = [randomBytes(32), randomBytes(32)];
    await new TokenStore(dbA, keyA).save(TOKEN);
    await new TokenStore(dbB, keyB).save('b-token');
    expect(await new TokenStore(dbA, keyA).load()).toBe(TOKEN);
    await expect(new TokenStore(dbA, keyB).load()).rejects.toThrowError(TokenDecryptError);
    await setKv(dbB, 'google_refresh_token', (await getKv(dbA, 'google_refresh_token'))!);
    await expect(new TokenStore(dbB, keyB).load()).rejects.toThrowError(TokenDecryptError);
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

  it('adds Gmail’s send permission only when invites go by email (S5H.4), and names it', () => {
    const GMAIL = 'https://www.googleapis.com/auth/gmail.send';
    expect(requestedScopes(parseEnv({ INVITES_GMAIL: 'true' }))).toEqual([...DRIVE_SCOPES, GMAIL]);
    expect(requestedScopes(parseEnv({ INVITES_GMAIL: 'true', MEETINGS_ENABLED: 'true', TEAM_EMAIL_DOMAINS: 'ourstudio.in' }))).toEqual([...ALL_SCOPES, GMAIL]);
    expect(requestedScopes({ MEETINGS_ENABLED: false })).toEqual(DRIVE_SCOPES); // left out: off
    expect(scopeName(GMAIL)).toBe('Send email as you (invites only)');
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
  it('an old token with nothing recorded counts as Drive only', async () => {
    const db = await seededDb();
    await new TokenStore(db, randomBytes(32)).save(TOKEN);
    expect(await getKv(db, 'google_scopes')).toBeUndefined();
    expect(await hasMeetingScopes(db)).toBe(false);
  });

  it('stores the granted scope string and reads it back', async () => {
    const db = await seededDb();
    await saveGrantedScopes(db, ALL_SCOPES.join(' '));
    expect(await getKv(db, 'google_scopes')).toBe(ALL_SCOPES.join(' '));
    expect(await hasMeetingScopes(db)).toBe(true);
  });

  it('is true only when every meeting scope is recorded', async () => {
    const db = await seededDb();
    await saveGrantedScopes(db, DRIVE_SCOPES.join(' '));
    expect(await hasMeetingScopes(db)).toBe(false);
    await saveGrantedScopes(db, [...DRIVE_SCOPES, MEETING_SCOPES[0], MEETING_SCOPES[2]].join(' '));
    expect(await hasMeetingScopes(db)).toBe(false);
    await saveGrantedScopes(db, ['openid', ...MEETING_SCOPES.toReversed(), ...DRIVE_SCOPES].join(' '));
    expect(await hasMeetingScopes(db)).toBe(true);
  });

  it('a near-miss scope does not count', async () => {
    const db = await seededDb();
    await saveGrantedScopes(db, NEAR_MISS);
    expect(await hasMeetingScopes(db)).toBe(false);
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

describe('extra meeting accounts', () => {
  const ALL = MEETING_SCOPES.join(' ');

  it('checks the label before it goes into a kv key', () => {
    expect(checkAccountLabel('company2')).toBe('company2');
    for (const bad of ['main', '', 'Company2', 'a b', 'x:y', '../x', 'a'.repeat(21), '-x']) {
      expect(() => checkAccountLabel(bad)).toThrow(/account name/);
    }
  });

  it('stores each account under its own key, leaves the main token alone, and lists them in order', async () => {
    const db = await seededDb();
    const key = randomBytes(32);
    await new TokenStore(db, key).save(TOKEN);
    await saveMeetingAccount(db, key, 'company2', 'rt-2', ALL);
    await saveMeetingAccount(db, key, 'company3', 'rt-3', ALL);
    await saveMeetingAccount(db, key, 'company2', 'rt-2b', ALL); // signing in again replaces, keeps the place
    expect(await meetingAccounts(db)).toEqual(['company2', 'company3']);
    expect(await new TokenStore(db, key).load()).toBe(TOKEN);
    expect(await new TokenStore(db, key, 'company2').load()).toBe('rt-2b');
    expect(await new TokenStore(db, key, 'company3').load()).toBe('rt-3');
    expect(await getKv(db, 'google_refresh_token:company3')).not.toContain('rt-3');
  });

  it('meetingsReady: the main sign-in or any extra account with every meeting scope', async () => {
    const db = await seededDb();
    const key = randomBytes(32);
    await saveGrantedScopes(db, DRIVE_SCOPES[0]!);
    expect(await meetingsReady(db)).toBe(false);
    await saveMeetingAccount(db, key, 'company2', 'rt-2', MEETING_SCOPES.slice(1).join(' '));
    expect(await meetingsReady(db)).toBe(false);
    await saveMeetingAccount(db, key, 'company3', 'rt-3', ALL);
    expect(await meetingsReady(db)).toBe(true);
    expect(await hasMeetingScopes(db)).toBe(false); // the main sign-in alone is unchanged
  });

  it('remove forgets the token, scopes and list entry of that account only', async () => {
    const db = await seededDb();
    const key = randomBytes(32);
    await new TokenStore(db, key).save(TOKEN);
    await saveMeetingAccount(db, key, 'company2', 'rt-2', ALL);
    await saveMeetingAccount(db, key, 'company3', 'rt-3', ALL);
    expect(await removeMeetingAccount(db, 'company2')).toBe(true);
    expect(await removeMeetingAccount(db, 'company2')).toBe(false);
    expect(await meetingAccounts(db)).toEqual(['company3']);
    expect(await getKv(db, 'google_refresh_token:company2')).toBeUndefined();
    expect(await getKv(db, 'google_scopes:company2')).toBeUndefined();
    expect(await new TokenStore(db, key).load()).toBe(TOKEN);
    expect(await new TokenStore(db, key, 'company3').load()).toBe('rt-3');
  });

  it('a damaged account list reads as no extra accounts', async () => {
    const db = await seededDb();
    await setKv(db, 'google_meeting_accounts', '{not json');
    expect(await meetingAccounts(db)).toEqual([]);
    await setKv(db, 'google_meeting_accounts', JSON.stringify(['ok-1', 'main', 'Bad', 7]));
    expect(await meetingAccounts(db)).toEqual(['ok-1']);
  });

  it('runLoopbackConsent with requireDrive false accepts the meeting scopes without Drive', async () => {
    const f = fakeClient({ scope: ALL });
    let url = '';
    let ready!: () => void;
    const urlReady = new Promise<void>((r) => (ready = r));
    const promise = runLoopbackConsent({
      clientId: 'id', clientSecret: 'secret', scopes: MEETING_SCOPES, requireDrive: false, createClient: f.createClient,
      showUrl: (u) => {
        url = u;
        ready();
      },
    });
    await urlReady;
    await fetch(`${f.calls.redirectUri!}/?state=${new URL(url).searchParams.get('state')!}&code=abc`);
    expect(await promise).toEqual({ refreshToken: 'rt-1', scope: ALL });
    expect(f.calls.authUrlOpts!.scope).toEqual(MEETING_SCOPES);
  });
});
