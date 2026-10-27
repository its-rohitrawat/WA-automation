import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hubMeetingAccounts, LiveMeetingsApi } from '../../src/meetings/multiAccount.ts';
import { isAuthFailure } from '../../src/output/authFailure.ts';
import { googleDriveApi } from '../../src/output/drive.ts';
import {
  DRIVE_SCOPES, hasMeetingScopes, MEETING_SCOPES, meetingAccounts, saveGrantedScopes, saveMeetingAccount, TokenStore, type OAuth2Client,
} from '../../src/output/googleAuth.ts';
import { GoogleAuthHub, GoogleNotConnectedError, type OAuthCredentials } from '../../src/output/googleAuthHub.ts';
import { getKv, setKv } from '../../src/store/kv.ts';
import { silentLogger } from '../../src/util/logger.ts';
import { seededDb } from '../helpers/db.ts';

const DESKTOP: OAuthCredentials = { clientId: 'desktop-id', clientSecret: 'desktop-secret' };
const WEB: OAuthCredentials = { clientId: 'web-id', clientSecret: 'web-secret' };
const SCOPE = DRIVE_SCOPES[0]!;

/**
 * A stand-in OAuth client: remembers which credentials built it and which refresh token it holds, and answers Drive
 * requests (googleapis calls auth.request) by recording that token.
 */
function fakeClients() {
  const seen: string[] = [];
  const built: { creds: OAuthCredentials; client: OAuth2Client }[] = [];
  const newClient = (creds: OAuthCredentials): OAuth2Client => {
    const c = {
      credentials: {} as { refresh_token?: string },
      setCredentials(x: { refresh_token?: string }) {
        this.credentials = { ...x };
      },
      async request() {
        seen.push(c.credentials.refresh_token ?? '');
        return { data: { id: 'file-1' }, status: 200, headers: {} };
      },
    };
    const client = c as unknown as OAuth2Client;
    built.push({ creds, client });
    return client;
  };
  return { seen, built, newClient };
}

const tokenOf = (c: OAuth2Client | undefined) => (c as unknown as { credentials: { refresh_token?: string } } | undefined)?.credentials.refresh_token;

describe('GoogleAuthHub', () => {
  it('loads the main token and each meeting account; a missing issuer means desktop', () => {
    const db = seededDb();
    const key = randomBytes(32);
    new TokenStore(db, key).save('rt-main');
    saveMeetingAccount(db, key, 'company2', 'rt-2', MEETING_SCOPES.join(' '));
    setKv(db, 'google_client:company2', 'web');
    const f = fakeClients();
    const hub = new GoogleAuthHub({ db, key, credentials: { desktop: DESKTOP, web: WEB }, newClient: f.newClient });
    expect(hub.labels()).toEqual(['main', 'company2']);
    expect(hub.issuer('main')).toBe('desktop');
    expect(hub.issuer('company2')).toBe('web');
    expect(tokenOf(hub.client('main'))).toBe('rt-main');
    expect(tokenOf(hub.client('company2'))).toBe('rt-2');
    expect(f.built.map((b) => b.creds)).toEqual([DESKTOP, WEB]);
  });

  it('no main token (setup mode): no main client, and its getter throws GoogleNotConnectedError', () => {
    const hub = new GoogleAuthHub({ db: seededDb(), key: randomBytes(32), credentials: { desktop: DESKTOP }, newClient: fakeClients().newClient });
    expect(hub.labels()).toEqual([]);
    expect(hub.client('main')).toBeUndefined();
    expect(() => hub.getter('main')()).toThrow(GoogleNotConnectedError);
    expect(hub.problem('main')).toBe('not_connected');
  });

  it('setToken saves the token encrypted, records the issuer, replaces the client and tells the listeners', () => {
    const db = seededDb();
    const key = randomBytes(32);
    new TokenStore(db, key).save('rt-old');
    const f = fakeClients();
    const hub = new GoogleAuthHub({ db, key, credentials: { desktop: DESKTOP, web: WEB }, newClient: f.newClient });
    const before = hub.client('main');
    const changes: string[] = [];
    hub.onChange((label) => changes.push(label));
    hub.setToken('main', 'rt-new', 'web', SCOPE);
    expect(hub.client('main')).not.toBe(before);
    expect(tokenOf(hub.client('main'))).toBe('rt-new');
    expect(f.built.at(-1)!.creds).toEqual(WEB);
    expect(getKv(db, 'google_client:main')).toBe('web');
    expect(getKv(db, 'google_refresh_token')).not.toContain('rt-new');
    expect(new TokenStore(db, key).load()).toBe('rt-new');
    expect(changes).toEqual(['main']);
    // A new hub (a restart) builds the same thing from what was stored.
    const again = new GoogleAuthHub({ db, key, credentials: { desktop: DESKTOP, web: WEB }, newClient: f.newClient });
    expect(again.issuer('main')).toBe('web');
    expect(tokenOf(again.client('main'))).toBe('rt-new');
  });

  it('the next Drive call uses the new client, through a getter', async () => {
    const db = seededDb();
    const key = randomBytes(32);
    new TokenStore(db, key).save('rt-old');
    const f = fakeClients();
    const hub = new GoogleAuthHub({ db, key, credentials: { desktop: DESKTOP, web: WEB }, newClient: f.newClient });
    const drive = googleDriveApi(hub.getter('main'));
    await drive.createFolder('A');
    hub.setToken('main', 'rt-new', 'web', SCOPE);
    await drive.createFolder('B');
    expect(f.seen).toEqual(['rt-old', 'rt-new']);
  });

  it('a token for a new label is stored under that label only, and the label is checked', () => {
    const db = seededDb();
    const key = randomBytes(32);
    new TokenStore(db, key).save('rt-main');
    const hub = new GoogleAuthHub({ db, key, credentials: { desktop: DESKTOP, web: WEB }, newClient: fakeClients().newClient });
    hub.setToken('company3', 'rt-3', 'web', SCOPE);
    expect(new TokenStore(db, key, 'company3').load()).toBe('rt-3');
    expect(new TokenStore(db, key).load()).toBe('rt-main');
    expect(hub.labels()).toEqual(['main', 'company3']);
    expect(() => hub.setToken('Bad Label', 'x', 'web', SCOPE)).toThrow(/account name/);
    expect(() => hub.setToken('a:b', 'x', 'web', SCOPE)).toThrow(/account name/);
  });

  it('refuses a web token when the web client is not configured, and changes nothing', () => {
    const db = seededDb();
    const key = randomBytes(32);
    new TokenStore(db, key).save('rt-main');
    const hub = new GoogleAuthHub({ db, key, credentials: { desktop: DESKTOP }, newClient: fakeClients().newClient });
    expect(() => hub.setToken('main', 'rt-new', 'web', SCOPE)).toThrow('The dashboard Google client is not set up');
    expect(new TokenStore(db, key).load()).toBe('rt-main');
    expect(getKv(db, 'google_client:main')).toBeUndefined();
  });

  it('a stored token the key cannot read, or whose issuing client is not configured, gives no client and a problem', () => {
    const db = seededDb();
    new TokenStore(db, randomBytes(32)).save('rt-main');
    saveMeetingAccount(db, randomBytes(32), 'company2', 'rt-2', MEETING_SCOPES.join(' '));
    const key = randomBytes(32);
    new TokenStore(db, key, 'company2').save('rt-2');
    setKv(db, 'google_client:company2', 'web');
    const hub = new GoogleAuthHub({ db, key, credentials: { desktop: DESKTOP }, newClient: fakeClients().newClient });
    expect(hub.client('main')).toBeUndefined();
    expect(hub.problem('main')).toBe('unreadable');
    expect(hub.client('company2')).toBeUndefined();
    expect(hub.problem('company2')).toBe('no_client');
    expect(hub.labels()).toEqual(['main', 'company2']);
  });

  it('an unknown issuer value is read as desktop', () => {
    const db = seededDb();
    const key = randomBytes(32);
    new TokenStore(db, key).save('rt-main');
    setKv(db, 'google_client:main', 'something-else');
    const hub = new GoogleAuthHub({ db, key, credentials: { desktop: DESKTOP, web: WEB }, newClient: fakeClients().newClient });
    expect(hub.issuer('main')).toBe('desktop');
  });

  it('a listener that throws does not stop the others; unsubscribe works', () => {
    const db = seededDb();
    const key = randomBytes(32);
    const hub = new GoogleAuthHub({ db, key, credentials: { desktop: DESKTOP }, newClient: fakeClients().newClient });
    const seen: string[] = [];
    hub.onChange(() => {
      throw new Error('bug');
    });
    const off = hub.onChange((l) => seen.push(l));
    hub.setToken('main', 'rt', 'desktop', SCOPE);
    off();
    hub.setToken('main', 'rt2', 'desktop', SCOPE);
    expect(seen).toEqual(['main']);
  });

  it('records the granted scopes with the token; a meeting account also joins the account list', () => {
    const db = seededDb();
    const key = randomBytes(32);
    saveGrantedScopes(db, 'scope-a');
    const hub = new GoogleAuthHub({ db, key, credentials: { desktop: DESKTOP, web: WEB }, newClient: fakeClients().newClient });
    hub.setToken('main', 'rt', 'desktop', SCOPE);
    expect(getKv(db, 'google_scopes')).toBe(SCOPE);
    hub.setToken('company4', 'rt-4', 'web', MEETING_SCOPES.join(' '));
    expect(meetingAccounts(db)).toEqual(['company4']);
    expect(hasMeetingScopes(db, 'company4')).toBe(true);
    expect(getKv(db, 'google_refresh_token:company4')).not.toContain('rt-4'); // encrypted at rest
    expect(new TokenStore(db, key, 'company4').load()).toBe('rt-4');
  });

  it('a write that fails changes nothing: the old client stays, and no listener runs', () => {
    const db = seededDb();
    const key = randomBytes(32);
    new TokenStore(db, key).save('rt-old');
    const hub = new GoogleAuthHub({ db, key, credentials: { desktop: DESKTOP, web: WEB }, newClient: fakeClients().newClient });
    const before = hub.client('main');
    let calls = 0;
    hub.onChange(() => calls++);
    db.exec("CREATE TRIGGER no_issuer BEFORE INSERT ON kv WHEN NEW.k = 'google_client:main' BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    expect(() => hub.setToken('main', 'rt-new', 'web', SCOPE)).toThrow('disk full');
    expect(hub.client('main')).toBe(before);
    expect(calls).toBe(0);
    expect(new TokenStore(db, key).load()).toBe('rt-old'); // rolled back with the issuer
  });

  it('an unknown label has issuer desktop and problem not_connected', () => {
    const hub = new GoogleAuthHub({ db: seededDb(), key: randomBytes(32), credentials: { desktop: DESKTOP }, newClient: fakeClients().newClient });
    expect(hub.issuer('nobody')).toBe('desktop');
    expect(hub.problem('nobody')).toBe('not_connected');
  });

  it('an error other than an unreadable token is not swallowed at load', () => {
    const db = seededDb();
    const key = randomBytes(32);
    new TokenStore(db, key).save('rt');
    const newClient = () => {
      throw new Error('bad client');
    };
    expect(() => new GoogleAuthHub({ db, key, credentials: { desktop: DESKTOP }, newClient })).toThrow('bad client');
  });

  it('a reconnect rebuilds the meetings API: a new meeting account is used without a restart', async () => {
    const db = seededDb();
    const key = randomBytes(32);
    new TokenStore(db, key).save('rt-main');
    saveGrantedScopes(db, SCOPE); // Drive only: main finds no meetings
    const hub = new GoogleAuthHub({ db, key, credentials: { desktop: DESKTOP, web: WEB }, newClient: fakeClients().newClient });
    const built: string[][] = [];
    const live = new LiveMeetingsApi(() => {
      const accounts = hubMeetingAccounts(db, hub);
      built.push(accounts.map((a) => a.label));
      return accounts;
    }, silentLogger());
    hub.onChange(() => live.rebuild());
    expect(built).toEqual([[]]);
    hub.setToken('company2', 'rt-2', 'web', MEETING_SCOPES.join(' '));
    expect(built).toEqual([[], ['company2']]);
  });

  it('a missing main client counts as a Google sign-in problem for Drive', () => {
    expect(isAuthFailure(new GoogleNotConnectedError('main'))).toBe(true);
  });
});
