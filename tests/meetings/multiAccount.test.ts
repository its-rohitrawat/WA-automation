import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GoogleAccessError, GoogleNoAccessError, GoogleTransientError } from '../../src/meetings/googleErrors.ts';
import { combineMeetingAccounts, hubMeetingAccounts, LiveMeetingsApi, MultiAccountMeetingsApi, storedMeetingAccounts } from '../../src/meetings/multiAccount.ts';
import {
  createOAuthClient, MEETING_SCOPES, saveGrantedScopes, saveMeetingAccount, TokenStore, type OAuth2Client,
} from '../../src/output/googleAuth.ts';
import { setKv } from '../../src/store/kv.ts';
import { silentLogger } from '../../src/util/logger.ts';
import { seededDb } from '../helpers/db.ts';
import { FakeMeetingsApi } from '../helpers/fakeMeetings.ts';

const signal = new AbortController().signal;
const log = silentLogger();
const FROM = '2026-10-20T00:00:00Z';
const TO = '2026-10-27T00:00:00Z';
const info = { name: 'Client sync.mp4', size: 5, mimeType: 'video/mp4', durationMs: 60_000 };

function conference(id: string) {
  return { name: `conferenceRecords/${id}`, space: `spaces/s-${id}`, startTime: '2026-10-25T05:00:00Z', endTime: '2026-10-25T06:00:00Z' };
}

/** Account A hosted c1 (file fa), account B hosted c2 (file fb). */
function twoAccounts() {
  const a = new FakeMeetingsApi();
  const b = new FakeMeetingsApi();
  a.conferences = [conference('c1')];
  b.conferences = [conference('c2')];
  a.recordings.set('conferenceRecords/c1', [{ name: 'conferenceRecords/c1/recordings/r1', state: 'FILE_GENERATED', driveFileId: 'fa', startTime: null, endTime: null }]);
  b.recordings.set('conferenceRecords/c2', [{ name: 'conferenceRecords/c2/recordings/r2', state: 'FILE_GENERATED', driveFileId: 'fb', startTime: null, endTime: null }]);
  a.files.set('fa', { info, bytes: Buffer.from('aaaaa') });
  b.files.set('fb', { info, bytes: Buffer.from('bbbbb') });
  const router = new MultiAccountMeetingsApi([{ label: 'main', api: a }, { label: 'company2', api: b }], log);
  return { a, b, router };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-multi-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('MultiAccountMeetingsApi', () => {
  it('lists every account\'s conferences once, and remembers which account found each', async () => {
    const { a, b, router } = twoAccounts();
    b.conferences.push(conference('c1')); // both accounts were in c1: listed once, owned by the first
    const list = await router.listConferences(FROM, TO, signal);
    expect(list.map((c) => c.name)).toEqual(['conferenceRecords/c1', 'conferenceRecords/c2']);
    expect(router.accountOf('conferenceRecords/c1')).toBe('main');
    expect(router.accountOf('conferenceRecords/c2')).toBe('company2');
    expect(a.callsOf('listConferences')).toHaveLength(1);
    expect(b.callsOf('listConferences')).toHaveLength(1);
  });

  it('sends recordings, file info and downloads to the account that listed them, never the other', async () => {
    const { a, b, router } = twoAccounts();
    await router.listConferences(FROM, TO, signal);
    await router.listRecordings('conferenceRecords/c2', signal);
    expect(a.callsOf('listRecordings')).toHaveLength(0);
    expect((await router.videoInfo('fb', signal)).name).toBe('Client sync.mp4');
    const dest = join(dir, 'b.mp4.part');
    expect(await router.download('fb', dest, 100, signal)).toBe(5);
    expect(readFileSync(dest, 'utf8')).toBe('bbbbb');
    expect(a.callsOf('videoInfo')).toHaveLength(0);
    expect(a.callsOf('download')).toHaveLength(0);
  });

  it('after a restart (nothing remembered) tries the accounts in order and moves on after no access', async () => {
    const { a, b, router: first } = twoAccounts();
    void first;
    const router = new MultiAccountMeetingsApi([{ label: 'main', api: a }, { label: 'company2', api: b }], log);
    const dest = join(dir, 'b.mp4.part');
    expect(await router.download('fb', dest, 100, signal)).toBe(5);
    expect(a.callsOf('download')).toHaveLength(1); // A: http_404, then B
    expect(b.callsOf('download')).toHaveLength(1);
    await router.videoInfo('fb', signal);
    expect(a.callsOf('videoInfo')).toHaveLength(0); // B is now the owner
  });

  it('no account can open the file: no access, after every account tried', async () => {
    const { a, b, router } = twoAccounts();
    await expect(router.videoInfo('missing', signal)).rejects.toBeInstanceOf(GoogleNoAccessError);
    expect(a.callsOf('videoInfo')).toHaveLength(1);
    expect(b.callsOf('videoInfo')).toHaveLength(1);
  });

  it('a transient error is thrown at once, without asking the other accounts', async () => {
    const { a, b, router } = twoAccounts();
    a.failWith.set('videoInfo', new GoogleTransientError('http_503'));
    await expect(router.videoInfo('fb', signal)).rejects.toBeInstanceOf(GoogleTransientError);
    expect(b.callsOf('videoInfo')).toHaveLength(0);
  });

  it('the invite comes from another calendar when the owner\'s has none', async () => {
    const { a, b, router } = twoAccounts();
    a.codes.set('spaces/s-c1', 'abc-defg-hij');
    b.invites.set('abc-defg-hij', { title: 'Mehta review', attendees: [] });
    await router.listConferences(FROM, TO, signal);
    expect(await router.meetingCode('spaces/s-c1', signal)).toBe('abc-defg-hij');
    expect(b.callsOf('meetingCode')).toHaveLength(0);
    expect((await router.findInvite('abc-defg-hij', '2026-10-25T05:00:00Z', signal))?.title).toBe('Mehta review');
    expect(a.callsOf('findInvite')).toHaveLength(1); // the owner first
  });

  it('one account losing its sign-in does not stop the others, and is named until it works again', async () => {
    const { b, router } = twoAccounts();
    b.failWith.set('listConferences', new GoogleAccessError('invalid_grant'));
    const list = await router.listConferences(FROM, TO, signal);
    expect(list.map((c) => c.name)).toEqual(['conferenceRecords/c1']);
    expect(router.lostAccounts()).toEqual(['company2']);
    b.failWith.delete('listConferences');
    await router.listConferences(FROM, TO, signal);
    expect(router.lostAccounts()).toEqual([]);
  });

  it('every account failing throws the most serious error (a lost sign-in)', async () => {
    const { a, b, router } = twoAccounts();
    a.failWith.set('listConferences', new GoogleTransientError('http_503'));
    b.failWith.set('listConferences', new GoogleAccessError('invalid_grant'));
    await expect(router.listConferences(FROM, TO, signal)).rejects.toBeInstanceOf(GoogleAccessError);
  });

  it('a stop is thrown as it is', async () => {
    const { router } = twoAccounts();
    const stop = new AbortController();
    stop.abort(new Error('stopped'));
    await expect(router.listConferences(FROM, TO, stop.signal)).rejects.toThrow('stopped');
  });
});

describe('combineMeetingAccounts', () => {
  it('one account: its API unchanged, no router', () => {
    const a = new FakeMeetingsApi();
    const r = combineMeetingAccounts([{ label: 'main', api: a }], log);
    expect(r.api).toBe(a);
    expect(r.router).toBeNull();
  });

  it('several accounts: the router', () => {
    const r = combineMeetingAccounts([{ label: 'main', api: new FakeMeetingsApi() }, { label: 'x', api: new FakeMeetingsApi() }], log);
    expect(r.router).toBeInstanceOf(MultiAccountMeetingsApi);
    expect(r.api).toBe(r.router);
  });
});

describe('storedMeetingAccounts', () => {
  const ALL = MEETING_SCOPES.join(' ');
  const clients: OAuth2Client[] = [];
  const newClient = () => {
    const c = createOAuthClient('id', 'secret');
    clients.push(c);
    return c;
  };

  it('the main account, then each extra account with every meeting scope; one without them is left out (no calls)', () => {
    const db = seededDb();
    const key = randomBytes(32);
    saveGrantedScopes(db, ALL);
    saveMeetingAccount(db, key, 'company2', 'rt-2', ALL);
    saveMeetingAccount(db, key, 'company3', 'rt-3', 'https://www.googleapis.com/auth/calendar.events.readonly');
    clients.length = 0;
    const accounts = storedMeetingAccounts({ db, key, main: createOAuthClient('id', 'secret'), newClient, log });
    expect(accounts.map((a) => a.label)).toEqual(['main', 'company2']);
    expect(clients).toHaveLength(1);
    expect(clients[0]!.credentials.refresh_token).toBe('rt-2');
  });

  it('only extra accounts have the scopes: the main one is left out', () => {
    const db = seededDb();
    const key = randomBytes(32);
    saveGrantedScopes(db, 'https://www.googleapis.com/auth/drive.file');
    saveMeetingAccount(db, key, 'company2', 'rt-2', ALL);
    expect(storedMeetingAccounts({ db, key, main: createOAuthClient('id', 'secret'), newClient, log }).map((a) => a.label)).toEqual(['company2']);
  });

  it('an extra token this key cannot read is skipped; none usable gives the main account (still paused, no calls)', () => {
    const db = seededDb();
    saveMeetingAccount(db, randomBytes(32), 'company2', 'rt-2', ALL);
    const accounts = storedMeetingAccounts({ db, key: randomBytes(32), main: createOAuthClient('id', 'secret'), newClient, log });
    expect(accounts.map((a) => a.label)).toEqual(['main']);
  });

  it('an extra token copied under another account\'s key does not open (the key name is bound in)', () => {
    const db = seededDb();
    const key = randomBytes(32);
    saveMeetingAccount(db, key, 'company2', 'rt-2', ALL);
    saveMeetingAccount(db, key, 'company3', 'rt-3', ALL);
    const db2 = seededDb();
    new TokenStore(db2, key, 'company2').save('rt-2');
    // Move company2's ciphertext into company3's slot.
    setKv(db2, 'google_refresh_token:company3', String(db2.raw.prepare("SELECT v FROM kv WHERE k = 'google_refresh_token:company2'").pluck().get()));
    expect(() => new TokenStore(db2, key, 'company3').load()).toThrow(/google-auth --account company3/);
  });
});

describe('hubMeetingAccounts and LiveMeetingsApi', () => {
  const ALL = MEETING_SCOPES.join(' ');
  const client = () => createOAuthClient('id', 'secret');

  it('takes each account that has a client and every meeting scope, main first', () => {
    const db = seededDb();
    const key = randomBytes(32);
    saveGrantedScopes(db, ALL);
    saveMeetingAccount(db, key, 'company2', 'rt-2', ALL);
    saveMeetingAccount(db, key, 'company3', 'rt-3', 'https://www.googleapis.com/auth/drive.file');
    const clients = new Map([['main', client()], ['company2', client()], ['company3', client()]]);
    expect(hubMeetingAccounts(db, { client: (l) => clients.get(l) }).map((a) => a.label)).toEqual(['main', 'company2']);
    clients.delete('main');
    expect(hubMeetingAccounts(db, { client: (l) => clients.get(l) }).map((a) => a.label)).toEqual(['company2']);
  });

  it('with no account every call is refused as not connected; a rebuild picks up a reconnected account', async () => {
    let accounts: { label: string; api: FakeMeetingsApi }[] = [];
    const live = new LiveMeetingsApi(() => accounts, log);
    await expect(live.listConferences(FROM, TO, signal)).rejects.toMatchObject({ name: 'GoogleAccessError', code: 'not_connected' });
    const a = new FakeMeetingsApi();
    a.conferences = [conference('c1')];
    accounts = [{ label: 'main', api: a }];
    live.rebuild();
    expect((await live.listConferences(FROM, TO, signal)).map((c) => c.name)).toEqual(['conferenceRecords/c1']);
    expect(live.lostAccounts()).toEqual([]);
  });

  it('several accounts go through the router: lostAccounts and accountOf come from it', async () => {
    const { a, b } = twoAccounts();
    b.failWith.set('listConferences', new GoogleAccessError('invalid_grant'));
    const live = new LiveMeetingsApi(() => [{ label: 'main', api: a }, { label: 'company2', api: b }], log);
    await live.listConferences(FROM, TO, signal);
    expect(live.lostAccounts()).toEqual(['company2']);
    expect(live.accountOf('conferenceRecords/c1')).toBe('main');
    const dest = join(dir, 'a.mp4.part');
    expect(await live.download('fa', dest, 100, signal)).toBe(5);
  });
});
