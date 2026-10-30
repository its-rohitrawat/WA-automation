import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthenticationState } from 'baileys';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senderSessionDbPath } from '../../src/config/paths.ts';
import { LinkingSender, spareLinkDriver, SPARE_LINK_MESSAGES, type SenderScheduler, type SpareLinkDeps } from '../../src/report/senderLink.ts';
import type { ReportSender } from '../../src/report/types.ts';
import type { Db } from '../../src/store/db.ts';
import { createLogger, silentLogger } from '../../src/util/logger.ts';
import { openSenderSession, openSessionDb } from '../../src/wa/authState.ts';
import { LinkSessions } from '../../src/wa/linkSession.ts';
import { linkedNumber, SENDER_DEVICE_NAME } from '../../src/wa/senderGateway.ts';
import { closeWith, FakeSocket } from '../helpers/fakeSocket.ts';
import { FakeReportSender } from '../helpers/fakeReportSender.ts';
import { rawOf } from '../../src/store/engine/sqlite.ts';

const OLD_SPARE = '919811111111';
const NEW_SPARE = '919822222222';
const FOUNDER = '919800000001';
const RECIPIENT = '919800000009';

type Script = (s: FakeSocket, auth: AuthenticationState) => void;
/** The scan: one QR, then WhatsApp's restart; the second socket opens as `number`. */
const scan = (number: string): Script[] => [
  (s) => {
    s.emit('connection.update', { qr: 'QR-SPARE-SECRET' });
    closeWith(s, 515);
  },
  (s, auth) => {
    auth.creds.me = { id: `${number}:5@s.whatsapp.net`, name: 'Spare' };
    s.emit('connection.update', { connection: 'open' });
  },
];

function scripted(scripts: Script[]) {
  const sockets: FakeSocket[] = [];
  const factory = (auth: AuthenticationState) => {
    const s = new FakeSocket();
    sockets.push(s);
    const script = scripts.shift();
    if (script) queueMicrotask(() => script(s, auth));
    return s;
  };
  return { factory, sockets };
}

let dir: string;
let key: Buffer;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-spare-link-'));
  key = randomBytes(32);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const file = () => senderSessionDbPath(dir);

/** A scheduler stand-in: records the senders it is given; whenIdle waits for `idle` when set. */
function fakeScheduler(idle?: Promise<void>) {
  const replaced: ReportSender[] = [];
  const s: SenderScheduler = {
    replaceSender: (x) => void replaced.push(x),
    whenIdle: () => idle ?? Promise.resolve(),
    maskedRecipient: () => '…0009',
  };
  return { replaced, s };
}

/** A spare session already linked to OLD_SPARE, on disk. */
async function linkedBefore(): Promise<void> {
  const opened = await openSenderSession(file(), key);
  if (!opened.ok) throw new Error('could not create the session');
  opened.auth.state.creds.me = { id: `${OLD_SPARE}:3@s.whatsapp.net`, name: 'Old spare' };
  await opened.auth.saveCreds();
  rawOf(opened.db).close();
}

/** The number the spare session on disk is linked to now. */
async function linkedOnDisk(): Promise<string | undefined> {
  const opened = await openSenderSession(file(), key);
  if (!opened.ok) return `unreadable:${opened.code}`;
  const n = linkedNumber(opened.auth);
  rawOf(opened.db).close();
  return n;
}

function sessions(scripts: Script[], over: Partial<SpareLinkDeps> = {}, timeoutMs?: number) {
  const { factory, sockets } = scripted(scripts);
  const audits: string[] = [];
  const lines: string[] = [];
  const log = createLogger('debug', { write: (s: string) => void lines.push(s) });
  const s = new LinkSessions({
    drivers: {
      spare: spareLinkDriver({
        dataDir: dir, key, factory, founderNumber: () => FOUNDER, recipient: () => RECIPIENT, log, settleMs: 0, ...over,
      }),
    },
    log,
    audit: async (e) => { audits.push(e); },
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  return { s, sockets, audits, lines };
}

describe('spare phone link', () => {
  it('links without a running report: the new session is saved and the file closed', async () => {
    await linkedBefore();
    const t = sessions(scan(NEW_SPARE));
    const link = t.s.start({ target: 'spare', actor: 'owner@studio.in' });
    await t.s.settled(link.id);
    expect(t.s.info(link.id)).toMatchObject({ state: 'linked', device: SENDER_DEVICE_NAME });
    expect(await linkedOnDisk()).toBe(NEW_SPARE);
    expect(t.audits).toEqual(['Spare phone linked']);
    for (const s of t.sockets) expect(s.sendMessage).not.toHaveBeenCalled();
    expect(t.lines.join('\n')).not.toContain('QR-SPARE-SECRET');
  });

  it("with a running report: its sender steps aside while linking, then gets the new one, on the report's own database", async () => {
    await linkedBefore();
    const opened = await openSenderSession(file(), key);
    if (!opened.ok) throw new Error('open failed');
    const f = fakeScheduler();
    const made = new FakeReportSender();
    const t = sessions(scan(NEW_SPARE), {
      reportDb: () => opened.db,
      scheduler: () => f.s,
      makeSender: (auth) => {
        expect(linkedNumber(auth)).toBe(NEW_SPARE);
        return made;
      },
    });
    const link = t.s.start({ target: 'spare', actor: 'a@b.in' });
    await t.s.settled(link.id);
    expect(f.replaced).toHaveLength(2);
    expect(f.replaced[0]).toBeInstanceOf(LinkingSender);
    expect(await f.replaced[0]!.sendReport('x')).toEqual({ status: 'failed', code: 'linking' });
    expect(f.replaced[0]!.maskedRecipient()).toBe('…0009');
    expect(f.replaced[1]).toBe(made);
    expect(rawOf(opened.db).open).toBe(true); // the report's database stays open for it
    rawOf(opened.db).close();
    expect(await linkedOnDisk()).toBe(NEW_SPARE);
  });

  it('waits for a report send in flight before touching the shared session', async () => {
    await linkedBefore();
    const opened = await openSenderSession(file(), key);
    if (!opened.ok) throw new Error('open failed');
    let idle!: () => void;
    const f = fakeScheduler(new Promise<void>((r) => (idle = r)));
    const t = sessions(scan(NEW_SPARE), { reportDb: () => opened.db, scheduler: () => f.s, makeSender: () => new FakeReportSender() });
    const link = t.s.start({ target: 'spare', actor: 'a@b.in' });
    await new Promise((r) => setTimeout(r, 20));
    expect(t.sockets).toHaveLength(0);
    expect(f.replaced).toHaveLength(0);
    idle();
    await t.s.settled(link.id);
    expect(t.s.info(link.id)!.state).toBe('linked');
    rawOf(opened.db).close();
  });

  it("a refused link gives the report back a sender on the restored session, never on the founder's", async () => {
    await linkedBefore();
    const opened = await openSenderSession(file(), key);
    if (!opened.ok) throw new Error('open failed');
    const f = fakeScheduler();
    const madeFor: (string | undefined)[] = [];
    const t = sessions(scan(FOUNDER), {
      reportDb: () => opened.db,
      scheduler: () => f.s,
      makeSender: (auth) => {
        madeFor.push(linkedNumber(auth));
        return new FakeReportSender();
      },
    });
    const link = t.s.start({ target: 'spare', actor: 'a@b.in' });
    await t.s.settled(link.id);
    expect(t.s.info(link.id)!.errorCode).toBe('founder_number');
    expect(madeFor).toEqual([OLD_SPARE]);
    rawOf(opened.db).close();
    expect(await linkedOnDisk()).toBe(OLD_SPARE);
  });

  it('a database the driver opened is handed over when a scheduler takes the new sender (no stand-in: it shared nothing)', async () => {
    const adopted: Db[] = [];
    const f = fakeScheduler();
    const t = sessions(scan(NEW_SPARE), {
      scheduler: () => f.s,
      makeSender: () => new FakeReportSender(),
      adoptDb: (db) => void adopted.push(db),
    });
    const link = t.s.start({ target: 'spare', actor: 'a@b.in' });
    await t.s.settled(link.id);
    expect(f.replaced).toHaveLength(1);
    expect(f.replaced[0]).not.toBeInstanceOf(LinkingSender);
    expect(adopted).toHaveLength(1);
    expect(rawOf(adopted[0]!).open).toBe(true);
    rawOf(adopted[0]!).close();
  });

  it('a failure after the commit (building the sender) does not undo or fail the link', async () => {
    await linkedBefore();
    const t = sessions(scan(NEW_SPARE), {
      scheduler: () => fakeScheduler().s,
      makeSender: () => {
        throw new Error('bad recipient');
      },
    });
    const link = t.s.start({ target: 'spare', actor: 'a@b.in' });
    await t.s.settled(link.id);
    expect(t.s.info(link.id)!.state).toBe('linked');
    expect(await linkedOnDisk()).toBe(NEW_SPARE);
  });

  it('a session written with another key is reset, not moved aside', async () => {
    const other = await openSenderSession(file(), randomBytes(32));
    if (!other.ok) throw new Error('open failed');
    await other.auth.saveCreds();
    rawOf(other.db).close();
    const t = sessions(scan(NEW_SPARE));
    const link = t.s.start({ target: 'spare', actor: 'a@b.in' });
    await t.s.settled(link.id);
    expect(t.s.info(link.id)!.state).toBe('linked');
    expect(readdirSync(dir).some((f) => f.includes('.damaged-'))).toBe(false);
    expect(await linkedOnDisk()).toBe(NEW_SPARE);
  });

  it('a session file that cannot be opened is left alone', async () => {
    mkdirSync(file()); // a folder where the file should be: SQLite cannot open it
    const t = sessions(scan(NEW_SPARE));
    const link = t.s.start({ target: 'spare', actor: 'a@b.in' });
    await t.s.settled(link.id);
    expect(t.s.info(link.id)).toMatchObject({ state: 'failed', errorCode: 'session_unavailable' });
    expect(t.sockets).toHaveLength(0);
    expect(readdirSync(dir).some((f) => f.includes('.damaged-'))).toBe(false);
  });

  it('a cancelled link leaves no backup behind', async () => {
    await linkedBefore();
    const t = sessions([(s) => s.emit('connection.update', { qr: 'QR' })]);
    const link = t.s.start({ target: 'spare', actor: 'a@b.in' });
    await new Promise((r) => setTimeout(r, 10));
    t.s.cancel(link.id);
    await t.s.settled(link.id);
    const db = openSessionDb(file());
    expect((rawOf(db).prepare('SELECT COUNT(*) AS n FROM auth_backup').get() as { n: number }).n).toBe(0);
    rawOf(db).close();
  });

  it('shows "opening" once the phone has scanned (WhatsApp asks for its restart)', async () => {
    const t = sessions([
      (s) => {
        s.emit('connection.update', { qr: 'QR' });
        closeWith(s, 515);
      },
      () => {},
    ]);
    const link = t.s.start({ target: 'spare', actor: 'a@b.in' });
    await new Promise((r) => setTimeout(r, 20));
    expect(t.s.info(link.id)!.state).toBe('opening');
    t.s.cancel(link.id);
    await t.s.settled(link.id);
  });

  it("refuses a scan from the founder's number: nothing of it is kept, the old spare comes back, and the message says why", async () => {
    await linkedBefore();
    const t = sessions(scan(FOUNDER));
    const link = t.s.start({ target: 'spare', actor: 'a@b.in' });
    await t.s.settled(link.id);
    expect(t.s.info(link.id)).toMatchObject({ state: 'failed', errorCode: 'founder_number' });
    expect(await linkedOnDisk()).toBe(OLD_SPARE);
    expect(t.audits).toEqual(['Spare phone link failed (founder_number)']);
    expect(SPARE_LINK_MESSAGES.founder_number).toMatch(/scanned with the founder's phone/);
  });

  it('refuses a scan from REPORT_RECIPIENT as well', async () => {
    const t = sessions(scan(RECIPIENT));
    const link = t.s.start({ target: 'spare', actor: 'a@b.in' });
    await t.s.settled(link.id);
    expect(t.s.info(link.id)).toMatchObject({ errorCode: 'founder_number' });
  });

  it('a damaged session file is moved aside (not deleted), then the link goes on', async () => {
    writeFileSync(file(), 'this is not a database');
    const t = sessions(scan(NEW_SPARE));
    const link = t.s.start({ target: 'spare', actor: 'a@b.in' });
    await t.s.settled(link.id);
    expect(t.s.info(link.id)!.state).toBe('linked');
    expect(readdirSync(dir).some((f) => f.startsWith('sender-session.db.damaged-'))).toBe(true);
    expect(await linkedOnDisk()).toBe(NEW_SPARE);
  });

  it('the timeout restores the previous spare session', async () => {
    await linkedBefore();
    const t = sessions([(s) => s.emit('connection.update', { qr: 'QR-SPARE-SECRET' })], {}, 50);
    const link = t.s.start({ target: 'spare', actor: 'a@b.in' });
    await t.s.settled(link.id);
    expect(t.s.info(link.id)).toMatchObject({ state: 'timed_out' });
    expect(await linkedOnDisk()).toBe(OLD_SPARE);
    expect(t.sockets[0]!.end).toHaveBeenCalled();
    expect(t.audits).toEqual(['Spare phone link timed out']);
  });

  it('cancel restores the previous spare session at once', async () => {
    await linkedBefore();
    const t = sessions([(s) => s.emit('connection.update', { qr: 'QR-SPARE-SECRET' })]);
    const link = t.s.start({ target: 'spare', actor: 'a@b.in' });
    await new Promise((r) => setTimeout(r, 10));
    t.s.cancel(link.id);
    await t.s.settled(link.id);
    expect(t.s.info(link.id)).toMatchObject({ state: 'cancelled' });
    expect(await linkedOnDisk()).toBe(OLD_SPARE);
  });

  it('WhatsApp refusing the link restores the previous session and gives its code', async () => {
    await linkedBefore();
    const t = sessions([(s) => closeWith(s, 403)]);
    const link = t.s.start({ target: 'spare', actor: 'a@b.in' });
    await t.s.settled(link.id);
    expect(t.s.info(link.id)).toMatchObject({ state: 'failed', errorCode: 'forbidden' });
    expect(await linkedOnDisk()).toBe(OLD_SPARE);
    expect(SPARE_LINK_MESSAGES.forbidden).toBeTruthy();
  });

  it('shares the one-at-a-time rule with the founder relink', () => {
    const t = sessions([(s) => s.emit('connection.update', { qr: 'QR' })]);
    const busy = new LinkSessions({
      drivers: { spare: { run: () => new Promise(() => {}) }, founder: { run: () => new Promise(() => {}) } },
      log: silentLogger(),
      audit: async () => {},
    });
    busy.start({ target: 'spare', actor: 'a@b.in' });
    expect(() => busy.start({ target: 'founder', actor: 'a@b.in' })).toThrow('already in progress');
    void t;
  });

  it('no session file yet: the link creates it', async () => {
    expect(existsSync(file())).toBe(false);
    const t = sessions(scan(NEW_SPARE));
    const link = t.s.start({ target: 'spare', actor: 'a@b.in' });
    await t.s.settled(link.id);
    expect(await linkedOnDisk()).toBe(NEW_SPARE);
  });
});
