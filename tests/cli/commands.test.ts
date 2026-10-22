import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmCancelled, googleAuthCommand, linkCommand, listGroupsCommand, statusCommand, type CliDeps } from '../../src/cli/commands.ts';
import { parseEnv } from '../../src/config/env.ts';
import { masterKeyPath, sessionDbPath, trackerDbPath } from '../../src/config/paths.ts';
import { StaticKeyProvider } from '../../src/crypto/keyProvider.ts';
import { mediaRefAad, MediaRefSealer } from '../../src/media/ref.ts';
import { DRIVE_SCOPES, TokenStore, type ConsentClient } from '../../src/output/googleAuth.ts';
import { syncClients } from '../../src/store/clients.ts';
import { openDb } from '../../src/store/db.ts';
import { getKv } from '../../src/store/kv.ts';
import { insertMessage } from '../../src/store/messages.ts';
import { acquireLock } from '../../src/util/lock.ts';
import { openSessionDb, useEncryptedAuthState } from '../../src/wa/authState.ts';
import type { GroupMetadata } from 'baileys';
import { MEHTA, OTHER_GROUP } from '../helpers/db.ts';
import { closeWith, FakeSocket, SEND_METHODS } from '../helpers/fakeSocket.ts';
import { waRaw, waText } from '../helpers/wa.ts';

const KEY = Buffer.alloc(32, 7);
const REFRESH_TOKEN = 'rt-very-secret-token';

let dir: string;
let dataDir: string;
let groupsFile: string;
let sockets: FakeSocket[];
let lines: string[];
let confirm: ReturnType<typeof vi.fn<(q: string) => Promise<boolean>>>;
let factory: ReturnType<typeof vi.fn>;

function deps(over: Partial<CliDeps> = {}): CliDeps {
  return {
    env: parseEnv({ DATA_DIR: dataDir, GROUPS_FILE: groupsFile, GOOGLE_OAUTH_CLIENT_ID: 'test-id', GOOGLE_OAUTH_CLIENT_SECRET: 'test-secret' }),
    keyProvider: new StaticKeyProvider(KEY),
    socketFactory: factory as unknown as CliDeps['socketFactory'],
    out: (l) => void lines.push(l),
    confirm,
    linkTimeoutMs: 300_000,
    quietMs: { link: 5_000, listGroups: 3_000 },
    maxIngestMs: { link: 10_000, listGroups: 6_000 },
    ...over,
  };
}

const out = () => lines.join('\n');

function seedTracker(): void {
  const db = openDb(trackerDbPath(dataDir));
  syncClients(db, [MEHTA]);
  insertMessage(db, { waId: 'seed1', clientId: 1, senderJid: 'a@s.whatsapp.net', senderNumber: '1', senderName: 'A', fromMe: false, ts: '2026-10-19T08:00:00.000Z', text: 'hi', quotedWaId: null, mediaType: null });
  db.close();
}

async function seedSession(): Promise<void> {
  const sdb = openSessionDb(sessionDbPath(dataDir));
  const auth = useEncryptedAuthState(sdb, KEY);
  auth.state.creds.me = { id: '919800000000:1@s.whatsapp.net', name: 'Founder' };
  await auth.saveCreds();
  sdb.close();
}

const rowCount = (file: string, sql: string): number => {
  const db = openDb(file);
  try {
    return (db.prepare(sql).get() as { n: number }).n;
  } finally {
    db.close();
  }
};
const sessionRows = () => {
  const db = openSessionDb(sessionDbPath(dataDir));
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM auth').get() as { n: number }).n;
  } finally {
    db.close();
  }
};
const trackerMessages = () => rowCount(trackerDbPath(dataDir), 'SELECT COUNT(*) AS n FROM messages');

async function lockIsFree(): Promise<void> {
  const l = await acquireLock(dataDir);
  await l.release();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-cli-'));
  dataDir = join(dir, 'data');
  mkdirSync(join(dataDir, 'keys'), { recursive: true });
  writeFileSync(masterKeyPath(dataDir), 'dummy-protected-key');
  groupsFile = join(dir, 'groups.json');
  writeFileSync(groupsFile, JSON.stringify({ clients: [{ groupId: MEHTA.groupId, name: MEHTA.name, code: MEHTA.code }] }));
  sockets = [];
  lines = [];
  confirm = vi.fn(async () => true);
  factory = vi.fn(() => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  });
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const sendCalls = () => sockets.flatMap((s) => SEND_METHODS.map((m) => s[m].mock.calls.length));

describe('link --reset', () => {
  it('confirmed: deletes only the session rows and records session_reset_at', async () => {
    seedTracker();
    await seedSession();
    const keyBefore = readFileSync(masterKeyPath(dataDir), 'utf8');
    const msgsBefore = trackerMessages();
    expect(sessionRows()).toBeGreaterThan(0);

    vi.useFakeTimers();
    // Counted when the socket is created, which is right after the reset and before anything new is saved.
    let rowsAtConnect = -1;
    factory.mockImplementation(() => {
      rowsAtConnect = sessionRows();
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    });
    const sessionBefore = sessionRows();
    const p = linkCommand({ reset: true }, deps());
    const rejected = expect(p).rejects.toThrow();
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    expect(sessionBefore).toBe(2); // canary + creds
    expect(rowsAtConnect).toBe(1); // creds gone; only the fresh canary row remains
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0]).toContain('Type yes to continue');
    closeWith(sockets[0]!, 401); // no point connecting further: end the run
    await rejected;

    expect(trackerMessages()).toBe(msgsBefore);
    expect(readFileSync(masterKeyPath(dataDir), 'utf8')).toBe(keyBefore);
    const db = openDb(trackerDbPath(dataDir));
    expect(getKv(db, 'session_reset_at')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    db.close();
    expect(out()).toContain('tracker data were NOT touched');
    await lockIsFree();
  });

  it('Ctrl+C at the prompt cancels cleanly and releases the lock', async () => {
    await seedSession();
    const before = sessionRows();
    confirm.mockRejectedValue(new ConfirmCancelled());
    await linkCommand({ reset: true }, deps());
    expect(out()).toContain('Cancelled. Nothing was changed.');
    expect(sessionRows()).toBe(before);
    expect(factory).not.toHaveBeenCalled();
    await lockIsFree();
  });

  it('not confirmed: nothing is deleted', async () => {
    seedTracker();
    await seedSession();
    const before = sessionRows();
    confirm.mockResolvedValue(false);
    await linkCommand({ reset: true }, deps());
    expect(out()).toContain('Nothing was changed.');
    expect(sessionRows()).toBe(before);
    expect(factory).not.toHaveBeenCalled();
    const db = openDb(trackerDbPath(dataDir));
    expect(getKv(db, 'session_reset_at')).toBeUndefined();
    db.close();
    await lockIsFree();
  });

  it('invalid allowed-groups.json throws before anything is deleted', async () => {
    await seedSession();
    const before = sessionRows();
    writeFileSync(groupsFile, '{ nope');
    await expect(linkCommand({ reset: true }, deps())).rejects.toThrow(/not valid JSON/);
    expect(sessionRows()).toBe(before);
    expect(confirm).not.toHaveBeenCalled();
    await lockIsFree();
  });

  it('with no stored session, skips the reset and does not ask', async () => {
    vi.useFakeTimers();
    const p = linkCommand({ reset: true }, deps());
    const rejected = expect(p).rejects.toThrow();
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    expect(confirm).not.toHaveBeenCalled();
    expect(out()).toContain('No saved WhatsApp link to reset.');
    closeWith(sockets[0]!, 401);
    await rejected;
    await lockIsFree();
  });

  it('missing groups file gives the friendly message', async () => {
    rmSync(groupsFile);
    await expect(linkCommand({ reset: false }, deps())).rejects.toThrow(/Allow-list file missing/);
    await lockIsFree();
  });
});

describe('link with an existing session', () => {
  it('says already linked, never opens a socket, deletes nothing', async () => {
    seedTracker();
    await seedSession();
    const before = sessionRows();
    await linkCommand({ reset: false }, deps());
    expect(out()).toContain('already linked');
    expect(factory).not.toHaveBeenCalled();
    expect(sessionRows()).toBe(before);
    expect(trackerMessages()).toBe(1);
    await lockIsFree();
  });
});

describe('link connection flow', () => {
  async function start(over: Partial<CliDeps> = {}) {
    vi.useFakeTimers();
    const p = linkCommand({ reset: false }, deps(over));
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    return { p };
  }
  async function openViaQr(): Promise<FakeSocket> {
    sockets[0]!.emit('connection.update', { qr: 'QR-DATA' });
    closeWith(sockets[0]!, 515);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets.length).toBe(2);
    sockets[1]!.emit('connection.update', { connection: 'open' });
    return sockets[1]!;
  }

  it('QR then restart then open prints the linked line; stores allowed, drops others; stops after the quiet time', async () => {
    const { p } = await start();
    const done = vi.fn();
    void p.then(done, done);
    const sock = await openViaQr();
    expect(out()).toContain('Scan this QR code with WhatsApp');
    expect(out()).toContain('WhatsApp linked. Saving recent messages from the allowed groups (about a minute). Leave this window open.');
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('a1', 'hello', { group: MEHTA.groupId }), waText('b1', 'secret', { group: OTHER_GROUP })] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sock.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(8_000);
    await p;
    expect(sock.end).toHaveBeenCalled();
    expect(out()).toContain('Linked. 1 messages saved from the allowed groups.');
    expect(out()).not.toContain('secret');
    expect(trackerMessages()).toBe(1);
    expect(sendCalls().every((n) => n === 0)).toBe(true);
    await lockIsFree();
  });

  it('caps the wait under a continuous stream of allowed messages', async () => {
    const { p } = await start();
    let done = false;
    void p.then(() => (done = true));
    const sock = await openViaQr();
    for (let i = 0; i < 14; i++) {
      sock.emit('messages.upsert', { type: 'notify', messages: [waText(`s${i}`, `m${i}`, { group: MEHTA.groupId })] });
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(done).toBe(true);
    expect(trackerMessages()).toBeGreaterThan(5);
    await p;
    await lockIsFree();
  });

  it('saves the download details of a shared image sealed, for the service to fetch later', async () => {
    const { p } = await start();
    const sock = await openViaQr();
    const mediaKey = Buffer.alloc(32, 9);
    sock.emit('messages.upsert', { type: 'notify', messages: [
      waRaw('img1', { imageMessage: { url: 'https://mmg.whatsapp.net/v/x', directPath: '/v/x', mediaKey, mimetype: 'image/jpeg' } }, { group: MEHTA.groupId }),
    ] });
    await vi.advanceTimersByTimeAsync(9_000);
    await p;
    const db = openDb(trackerDbPath(dataDir));
    try {
      const row = db.prepare('SELECT status, ref_enc, client_id FROM media').get() as { status: string; ref_enc: Buffer; client_id: number };
      expect(row.status).toBe('pending');
      expect(row.ref_enc.includes(mediaKey)).toBe(false);
      expect(row.ref_enc.toString('latin1')).not.toContain('mmg.whatsapp.net');
      // Sealed under the master key, so the service can open it.
      expect(new MediaRefSealer(KEY).open(row.ref_enc, mediaRefAad(row.client_id, 'img1'))).toMatchObject({ directPath: '/v/x', mediaKey: mediaKey.toString('base64') });
    } finally {
      db.close();
    }
    await lockIsFree();
  });

  it('close 401 rejects with the reset advice', async () => {
    const { p } = await start();
    const r = expect(p).rejects.toThrow(/link --reset/);
    closeWith(sockets[0]!, 401);
    await r;
    await lockIsFree();
  });

  it('close 440 rejects with the took-over advice', async () => {
    const { p } = await start();
    const r = expect(p).rejects.toThrow('Another WhatsApp Web or WA Agent session took over. Find and close it (another PC or browser). Do not reset the link.');
    closeWith(sockets[0]!, 440);
    await r;
    await lockIsFree();
  });

  it('close 403 rejects with the 403 advice', async () => {
    const { p } = await start();
    const r = expect(p).rejects.toThrow("WhatsApp refused this device (403). Check the founder's phone for a WhatsApp warning; do not reset the link.");
    closeWith(sockets[0]!, 403);
    await r;
    await lockIsFree();
  });

  it('times out with the new text', async () => {
    const { p } = await start({ linkTimeoutMs: 5_000 });
    const r = expect(p).rejects.toThrow('No connection to WhatsApp within 5 minutes. Check the internet connection, then run link again (without --reset).');
    await vi.advanceTimersByTimeAsync(5_001);
    await r;
    await lockIsFree();
  });

  it('a drop after a successful link says to start the service, not to link again', async () => {
    const { p } = await start();
    const r = expect(p).rejects.toThrow('WhatsApp is linked, but the connection dropped while saving recent messages. Start the service (net start wa-agent); it will catch up.');
    const sock = await openViaQr();
    sock.emit('connection.update', { connection: 'close', lastDisconnect: { error: Object.assign(new Error('x'), { output: { statusCode: 408 } }), date: new Date() } });
    await vi.advanceTimersByTimeAsync(11_000);
    await r;
    await lockIsFree();
  });

  it('says plainly when allowed messages could not be saved', async () => {
    seedTracker();
    const tdb = openDb(trackerDbPath(dataDir));
    tdb.exec("CREATE TRIGGER block_insert BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'blocked'); END");
    tdb.close();
    const { p } = await start();
    const sock = await openViaQr();
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('f1', 'hello', { group: MEHTA.groupId })] });
    await vi.advanceTimersByTimeAsync(9_000);
    await p;
    expect(lines).toContain('1 messages could not be saved. They are lost from the tracker; check the log, and add anything important by hand.');
    await lockIsFree();
  });

  it('reports a connection that is lost during the wait instead of "Linked."', async () => {
    const { p } = await start();
    const r = expect(p).rejects.toThrow(/took over/);
    const sock = await openViaQr();
    closeWith(sock, 440);
    await vi.advanceTimersByTimeAsync(3_000);
    await r;
    expect(out()).not.toContain('Linked.');
    await lockIsFree();
  });

  it('refuses when the service holds the lock, before opening anything', async () => {
    const held = await acquireLock(dataDir);
    try {
      await expect(linkCommand({ reset: false }, deps())).rejects.toThrow(/Stop it first/);
      await expect(listGroupsCommand(deps())).rejects.toThrow(/Stop it first/);
      expect(factory).not.toHaveBeenCalled();
    } finally {
      await held.release();
    }
  });
});

describe('list-groups', () => {
  it('prints id, subject and [allowed] only, and sends nothing', async () => {
    await seedSession();
    vi.useFakeTimers();
    const p = listGroupsCommand(deps());
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    const sock = sockets[0]!;
    sock.groupFetchAllParticipating.mockResolvedValue({
      [MEHTA.groupId]: { id: MEHTA.groupId, subject: 'Mehta Foods x Studio' } as GroupMetadata,
      [OTHER_GROUP]: { id: OTHER_GROUP, subject: 'Family' } as GroupMetadata,
    });
    sock.emit('connection.update', { connection: 'open' });
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    expect(lines).toEqual([
      'Connected. Reading your groups…',
      'Groups on this number (this list is shown only on this screen; messages from allowed groups are still saved):\n',
      `${OTHER_GROUP}  Family`,
      `${MEHTA.groupId}  Mehta Foods x Studio   [allowed]`,
      '\nCopy the ids you want into config/allowed-groups.json. Finishing up...',
    ]);
    expect(sendCalls().every((n) => n === 0)).toBe(true);
    expect(sock.end).toHaveBeenCalled();
    await lockIsFree();
  });

  it('works with an empty allow-list', async () => {
    writeFileSync(groupsFile, '{ "clients": [] }');
    await seedSession();
    vi.useFakeTimers();
    const p = listGroupsCommand(deps());
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    sockets[0]!.emit('connection.update', { connection: 'open' });
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    expect(out()).toContain('Family');
  });
});

describe('google-auth', () => {
  function consentClient(opts: { failToken?: boolean } = {}): (uri: string) => ConsentClient {
    return (redirectUri) => ({
      generateCodeVerifierAsync: async () => ({ codeVerifier: 'v', codeChallenge: 'c' }),
      generateAuthUrl: (o) => `${redirectUri}/?state=${o.state}&code=abc`,
      getToken: async () => {
        if (opts.failToken) throw new Error(`boom ${REFRESH_TOKEN}`);
        return { tokens: { refresh_token: REFRESH_TOKEN, scope: DRIVE_SCOPES[0] } };
      },
    });
  }
  const visit = async () => {
    await vi.waitFor(() => expect(lines.some((l) => l.startsWith('http://127.0.0.1'))).toBe(true));
    await fetch(lines.find((l) => l.startsWith('http://127.0.0.1'))!);
  };

  it('stores the token encrypted, never prints it, and says to restart the service', async () => {
    const p = googleAuthCommand(deps({ createConsentClient: consentClient() }));
    await visit();
    await p;
    const db = openDb(trackerDbPath(dataDir));
    const raw = getKv(db, 'google_refresh_token')!;
    expect(raw).toBeTruthy();
    expect(raw).not.toContain(REFRESH_TOKEN);
    expect(new TokenStore(db, KEY).load()).toBe(REFRESH_TOKEN);
    db.close();
    expect(out()).not.toContain(REFRESH_TOKEN);
    expect(out()).toContain('Google Drive connected. If the WA Agent service is running, restart it so it uses the new sign-in: net stop wa-agent, then net start wa-agent');
  });

  it('stores nothing when the code exchange fails', async () => {
    const p = googleAuthCommand(deps({ createConsentClient: consentClient({ failToken: true }) }));
    const caught = p.catch((e: Error) => e);
    await visit();
    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(REFRESH_TOKEN);
    const db = openDb(trackerDbPath(dataDir));
    expect(getKv(db, 'google_refresh_token')).toBeUndefined();
    db.close();
    expect(out()).not.toContain(REFRESH_TOKEN);
  });
});

describe('status command', () => {
  it('prints no report yet on a fresh database', () => {
    statusCommand(deps());
    expect(out()).toContain('no report yet');
  });
});
