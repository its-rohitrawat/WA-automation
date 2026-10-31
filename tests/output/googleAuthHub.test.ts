import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hubMeetingAccounts, LiveMeetingsApi } from '../../src/meetings/multiAccount.ts';
import { isAuthFailure } from '../../src/output/authFailure.ts';
import { googleDriveApi } from '../../src/output/drive.ts';
import {
  DRIVE_SCOPES, hasMeetingScopes, MEETING_SCOPES, meetingAccounts, removeMeetingAccount, saveGrantedScopes, saveMeetingAccount, TokenStore,
  type OAuth2Client,
} from '../../src/output/googleAuth.ts';
import { GoogleAuthHub, GoogleNotConnectedError, type OAuthCredentials } from '../../src/output/googleAuthHub.ts';
import { getKv, setKv } from '../../src/store/kv.ts';
import { silentLogger } from '../../src/util/logger.ts';
import type { Db, Sql } from '../../src/store/db.ts';
import { seededDb } from '../helpers/db.ts';

/**
 * The same Db, whose transactions refuse one kv write (its key): the database's own failure mid-write, on either engine,
 * with no trigger (a customer's Db on Postgres runs no DDL).
 */
function refusingKv(db: Db, key: string): Db {
  const refuse = (q: Sql): Sql => new Proxy(q, {
    get(t, p) {
      if (p === 'run') {
        return (sql: string, params?: unknown) =>
          /INTO kv/.test(sql) && Array.isArray(params) && params[0] === key ? Promise.reject(new Error('disk full')) : t.run(sql, params as never);
      }
      const v = Reflect.get(t, p) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  return new Proxy(db, {
    get(t, p) {
      if (p === 'tx') return <T>(fn: (q: Sql) => Promise<T>) => t.tx((q) => fn(refuse(q)));
      const v = Reflect.get(t, p) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

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
  it('loads the main token and each meeting account; a missing issuer means desktop', async () => {
    const db = await seededDb();
    const key = randomBytes(32);
    await new TokenStore(db, key).save('rt-main');
    await saveMeetingAccount(db, key, 'company2', 'rt-2', MEETING_SCOPES.join(' '));
    await setKv(db, 'google_client:company2', 'web');
    const f = fakeClients();
    const hub = await GoogleAuthHub.open({ db, key, credentials: { desktop: DESKTOP, web: WEB }, newClient: f.newClient });
    expect(hub.labels()).toEqual(['main', 'company2']);
    expect(hub.issuer('main')).toBe('desktop');
    expect(hub.issuer('company2')).toBe('web');
    expect(tokenOf(hub.client('main'))).toBe('rt-main');
    expect(tokenOf(hub.client('company2'))).toBe('rt-2');
    expect(f.built.map((b) => b.creds)).toEqual([DESKTOP, WEB]);
  });

  it('no main token (setup mode): no main client, and its getter throws GoogleNotConnectedError', async () => {
    const hub = await GoogleAuthHub.open({ db: await seededDb(), key: randomBytes(32), credentials: { desktop: DESKTOP }, newClient: fakeClients().newClient });
    expect(hub.labels()).toEqual([]);
    expect(hub.client('main')).toBeUndefined();
    expect(() => hub.getter('main')()).toThrow(GoogleNotConnectedError);
    expect(hub.problem('main')).toBe('not_connected');
  });

  it('setToken saves the token encrypted, records the issuer, replaces the client and tells the listeners', async () => {
    const db = await seededDb();
    const key = randomBytes(32);
    await new TokenStore(db, key).save('rt-old');
    const f = fakeClients();
    const hub = await GoogleAuthHub.open({ db, key, credentials: { desktop: DESKTOP, web: WEB }, newClient: f.newClient });
    const before = hub.client('main');
    const changes: string[] = [];
    hub.onChange((label) => changes.push(label));
    await hub.setToken('main', 'rt-new', 'web', SCOPE);
    expect(hub.client('main')).not.toBe(before);
    expect(tokenOf(hub.client('main'))).toBe('rt-new');
    expect(f.built.at(-1)!.creds).toEqual(WEB);
    expect(await getKv(db, 'google_client:main')).toBe('web');
    expect(await getKv(db, 'google_refresh_token')).not.toContain('rt-new');
    expect(await new TokenStore(db, key).load()).toBe('rt-new');
    expect(changes).toEqual(['main']);
    // A new hub (a restart) builds the same thing from what was stored.
    const again = await GoogleAuthHub.open({ db, key, credentials: { desktop: DESKTOP, web: WEB }, newClient: f.newClient });
    expect(again.issuer('main')).toBe('web');
    expect(tokenOf(again.client('main'))).toBe('rt-new');
  });

  it('the next Drive call uses the new client, through a getter', async () => {
    const db = await seededDb();
    const key = randomBytes(32);
    await new TokenStore(db, key).save('rt-old');
    const f = fakeClients();
    const hub = await GoogleAuthHub.open({ db, key, credentials: { desktop: DESKTOP, web: WEB }, newClient: f.newClient });
    const drive = googleDriveApi(hub.getter('main'));
    await drive.createFolder('A');
    await hub.setToken('main', 'rt-new', 'web', SCOPE);
    await drive.createFolder('B');
    expect(f.seen).toEqual(['rt-old', 'rt-new']);
  });

  it('a token for a new label is stored under that label only, and the label is checked', async () => {
    const db = await seededDb();
    const key = randomBytes(32);
    await new TokenStore(db, key).save('rt-main');
    const hub = await GoogleAuthHub.open({ db, key, credentials: { desktop: DESKTOP, web: WEB }, newClient: fakeClients().newClient });
    await hub.setToken('company3', 'rt-3', 'web', SCOPE);
    expect(await new TokenStore(db, key, 'company3').load()).toBe('rt-3');
    expect(await new TokenStore(db, key).load()).toBe('rt-main');
    expect(hub.labels()).toEqual(['main', 'company3']);
    await expect(hub.setToken('Bad Label', 'x', 'web', SCOPE)).rejects.toThrow(/account name/);
    await expect(hub.setToken('a:b', 'x', 'web', SCOPE)).rejects.toThrow(/account name/);
  });

  it('refuses a web token when the web client is not configured, and changes nothing', async () => {
    const db = await seededDb();
    const key = randomBytes(32);
    await new TokenStore(db, key).save('rt-main');
    const hub = await GoogleAuthHub.open({ db, key, credentials: { desktop: DESKTOP }, newClient: fakeClients().newClient });
    await expect(hub.setToken('main', 'rt-new', 'web', SCOPE)).rejects.toThrow('The dashboard Google client is not set up');
    expect(await new TokenStore(db, key).load()).toBe('rt-main');
    expect(await getKv(db, 'google_client:main')).toBeUndefined();
  });

  it('a stored token the key cannot read, or whose issuing client is not configured, gives no client and a problem', async () => {
    const db = await seededDb();
    await new TokenStore(db, randomBytes(32)).save('rt-main');
    await saveMeetingAccount(db, randomBytes(32), 'company2', 'rt-2', MEETING_SCOPES.join(' '));
    const key = randomBytes(32);
    await new TokenStore(db, key, 'company2').save('rt-2');
    await setKv(db, 'google_client:company2', 'web');
    const hub = await GoogleAuthHub.open({ db, key, credentials: { desktop: DESKTOP }, newClient: fakeClients().newClient });
    expect(hub.client('main')).toBeUndefined();
    expect(hub.problem('main')).toBe('unreadable');
    expect(hub.client('company2')).toBeUndefined();
    expect(hub.problem('company2')).toBe('no_client');
    expect(hub.labels()).toEqual(['main', 'company2']);
  });

  it('an unknown issuer value is read as desktop', async () => {
    const db = await seededDb();
    const key = randomBytes(32);
    await new TokenStore(db, key).save('rt-main');
    await setKv(db, 'google_client:main', 'something-else');
    const hub = await GoogleAuthHub.open({ db, key, credentials: { desktop: DESKTOP, web: WEB }, newClient: fakeClients().newClient });
    expect(hub.issuer('main')).toBe('desktop');
  });

  it('a listener that throws does not stop the others; unsubscribe works', async () => {
    const db = await seededDb();
    const key = randomBytes(32);
    const hub = await GoogleAuthHub.open({ db, key, credentials: { desktop: DESKTOP }, newClient: fakeClients().newClient });
    const seen: string[] = [];
    hub.onChange(() => {
      throw new Error('bug');
    });
    const off = hub.onChange((l) => seen.push(l));
    await hub.setToken('main', 'rt', 'desktop', SCOPE);
    off();
    await hub.setToken('main', 'rt2', 'desktop', SCOPE);
    expect(seen).toEqual(['main']);
  });

  it('records the granted scopes with the token; a meeting account also joins the account list', async () => {
    const db = await seededDb();
    const key = randomBytes(32);
    await saveGrantedScopes(db, 'scope-a');
    const hub = await GoogleAuthHub.open({ db, key, credentials: { desktop: DESKTOP, web: WEB }, newClient: fakeClients().newClient });
    await hub.setToken('main', 'rt', 'desktop', SCOPE);
    expect(await getKv(db, 'google_scopes')).toBe(SCOPE);
    await hub.setToken('company4', 'rt-4', 'web', MEETING_SCOPES.join(' '));
    expect(await meetingAccounts(db)).toEqual(['company4']);
    expect(await hasMeetingScopes(db, 'company4')).toBe(true);
    expect(await getKv(db, 'google_refresh_token:company4')).not.toContain('rt-4'); // encrypted at rest
    expect(await new TokenStore(db, key, 'company4').load()).toBe('rt-4');
  });

  it('a write that fails changes nothing: the old client stays, and no listener runs', async () => {
    const db = await seededDb();
    const key = randomBytes(32);
    await new TokenStore(db, key).save('rt-old');
    // The issuer's write is refused, after the token's in the same transaction.
    const hub = await GoogleAuthHub.open({ db: refusingKv(db, 'google_client:main'), key, credentials: { desktop: DESKTOP, web: WEB }, newClient: fakeClients().newClient });
    const before = hub.client('main');
    let calls = 0;
    hub.onChange(() => calls++);
    await expect(hub.setToken('main', 'rt-new', 'web', SCOPE)).rejects.toThrow('disk full');
    expect(hub.client('main')).toBe(before);
    expect(calls).toBe(0);
    expect(await new TokenStore(db, key).load()).toBe('rt-old'); // rolled back with the issuer
  });

  it('an unknown label has issuer desktop and problem not_connected', async () => {
    const hub = await GoogleAuthHub.open({ db: await seededDb(), key: randomBytes(32), credentials: { desktop: DESKTOP }, newClient: fakeClients().newClient });
    expect(hub.issuer('nobody')).toBe('desktop');
    expect(hub.problem('nobody')).toBe('not_connected');
  });

  it('an error other than an unreadable token is not swallowed at load', async () => {
    const db = await seededDb();
    const key = randomBytes(32);
    await new TokenStore(db, key).save('rt');
    const newClient = () => {
      throw new Error('bad client');
    };
    await expect(GoogleAuthHub.open({ db, key, credentials: { desktop: DESKTOP }, newClient })).rejects.toThrow('bad client');
  });

  it('a reconnect rebuilds the meetings API: a new meeting account is used without a restart', async () => {
    const db = await seededDb();
    const key = randomBytes(32);
    await new TokenStore(db, key).save('rt-main');
    await saveGrantedScopes(db, SCOPE); // Drive only: main finds no meetings
    const hub = await GoogleAuthHub.open({ db, key, credentials: { desktop: DESKTOP, web: WEB }, newClient: fakeClients().newClient });
    const built: string[][] = [];
    const live = new LiveMeetingsApi(async () => {
      const accounts = await hubMeetingAccounts(db, hub);
      built.push(accounts.map((a) => a.label));
      return accounts;
    }, silentLogger());
    hub.onChange(() => void live.rebuild());
    await live.idle();
    expect(built).toEqual([[]]);
    await hub.setToken('company2', 'rt-2', 'web', MEETING_SCOPES.join(' '));
    await live.idle();
    expect(built).toEqual([[], ['company2']]);
  });

  it('a missing main client counts as a Google sign-in problem for Drive', () => {
    expect(isAuthFailure(new GoogleNotConnectedError('main'))).toBe(true);
  });

  it('a CLI sign-in of a meeting account resets its issuer to desktop; removing the account forgets it', async () => {
    const db = await seededDb();
    const key = randomBytes(32);
    const hub = await GoogleAuthHub.open({ db, key, credentials: { desktop: DESKTOP, web: WEB }, newClient: fakeClients().newClient });
    await hub.setToken('company2', 'rt-web', 'web', MEETING_SCOPES.join(' '));
    expect(await getKv(db, 'google_client:company2')).toBe('web');
    await saveMeetingAccount(db, key, 'company2', 'rt-cli', MEETING_SCOPES.join(' ')); // what google-auth --account does
    expect(await getKv(db, 'google_client:company2')).toBe('desktop');
    expect((await GoogleAuthHub.open({ db, key, credentials: { desktop: DESKTOP, web: WEB }, newClient: fakeClients().newClient })).issuer('company2')).toBe('desktop');
    await removeMeetingAccount(db, 'company2');
    expect(await getKv(db, 'google_client:company2')).toBeUndefined();
  });
});

describe('two customers’ hubs (Phase B): nothing is shared by account label', () => {
  it('each hub loads only its own database’s tokens with its own key, and a reconnect on one never reaches the other', async () => {
    const [dbA, dbB] = [await seededDb(), await seededDb()];
    const [keyA, keyB] = [randomBytes(32), randomBytes(32)];
    await new TokenStore(dbA, keyA).save('rt-A');
    await new TokenStore(dbB, keyB).save('rt-B');
    await saveMeetingAccount(dbA, keyA, 'company2', 'rt-A2', MEETING_SCOPES.join(' '));
    const f = fakeClients();
    const a = await GoogleAuthHub.open({ db: dbA, key: keyA, credentials: { desktop: DESKTOP, web: WEB }, newClient: f.newClient });
    const b = await GoogleAuthHub.open({ db: dbB, key: keyB, credentials: { desktop: DESKTOP, web: WEB }, newClient: f.newClient });
    expect(tokenOf(a.client('main'))).toBe('rt-A');
    expect(tokenOf(b.client('main'))).toBe('rt-B');
    expect(a.client('main')).not.toBe(b.client('main'));
    expect(a.labels()).toEqual(['main', 'company2']);
    expect(b.labels()).toEqual(['main']); // the same label on A gives B nothing
    const changedB: string[] = [];
    b.onChange((label) => changedB.push(label));
    await a.setToken('main', 'rt-A-new', 'web', SCOPE);
    expect(tokenOf(a.client('main'))).toBe('rt-A-new');
    expect(tokenOf(b.client('main'))).toBe('rt-B');
    expect(changedB).toEqual([]);
    expect(await new TokenStore(dbB, keyB).load()).toBe('rt-B');
    // The meetings each hub would use come from its own database and clients only.
    expect((await hubMeetingAccounts(dbA, a)).map((m) => m.label)).toEqual(['company2']);
    expect((await hubMeetingAccounts(dbB, b)).map((m) => m.label)).toEqual([]);
  });
});
