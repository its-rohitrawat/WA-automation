import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addReportCommands, ConfirmCancelled, linkSenderCommand, reportSendNowCommand, reportStatusCommand, type CliDeps,
} from '../../src/cli/commands.ts';
import { parseEnv } from '../../src/config/env.ts';
import { senderSessionDbPath, sessionDbPath, trackerDbPath } from '../../src/config/paths.ts';
import { StaticKeyProvider } from '../../src/crypto/keyProvider.ts';
import type { HealthSnapshot } from '../../src/health/health.ts';
import { openDb, type Db } from '../../src/store/db.ts';
import { getKv, setKv } from '../../src/store/kv.ts';
import { claimReport, finishReport, REPORT_REQUEST_KEY, reportFor, reportRequest, retryReport, skipReport } from '../../src/store/reports.ts';
import { acquireLock } from '../../src/util/lock.ts';
import { openSessionDb, SenderSessionDecryptError, useSenderAuthState } from '../../src/wa/authState.ts';
import type { SenderSocketFactory } from '../../src/wa/senderGateway.ts';
import { closeWith, FakeSocket, SEND_METHODS } from '../helpers/fakeSocket.ts';

/** renameSync passes through, except that it fails for the one path in failRename (a file another program has locked). */
const fsSeam = vi.hoisted(() => ({ failRename: undefined as string | undefined }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    renameSync: (from: import('node:fs').PathLike, to: import('node:fs').PathLike): void => {
      if (fsSeam.failRename !== undefined && String(from) === fsSeam.failRename) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      real.renameSync(from, to);
    },
  };
});

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);
const NOW = new Date('2026-10-23T03:30:00.000Z'); // 09:00 IST
const DAY = '2026-10-23';
const NUMBER = '919812345678';
const JUNK = Buffer.alloc(4096, 0x41);

type Script = (s: FakeSocket) => void;
const open: Script = (s) => s.emit('connection.update', { connection: 'open' });

let dir: string;
let dataDir: string;
let lines: string[];
let sockets: FakeSocket[];
let scripts: Script[];
let confirm: ReturnType<typeof vi.fn<(q: string) => Promise<boolean>>>;

function deps(env: Record<string, string> = {}): CliDeps {
  return {
    env: parseEnv({ DATA_DIR: dataDir, GROUPS_FILE: join(dir, 'groups.json'), REPORT_ENABLED: 'true', REPORT_RECIPIENT: NUMBER, ...env }),
    keyProvider: new StaticKeyProvider(KEY),
    socketFactory: () => {
      throw new Error('the founder-number socket must not be used');
    },
    senderSocketFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      const script = scripts.shift() ?? open;
      queueMicrotask(() => script(s));
      return s;
    },
    senderSettleMs: 0,
    out: (l) => void lines.push(l),
    confirm,
    linkTimeoutMs: 1_000,
    quietMs: { link: 5_000, listGroups: 3_000 },
    maxIngestMs: { link: 10_000, listGroups: 6_000 },
  };
}

const out = () => lines.join('\n');

function withTracker<T>(fn: (db: Db) => T): T {
  const db = openDb(trackerDbPath(dataDir));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** A health snapshot of a running service. `reportOn: false` is a service started with the report off (no report line). */
function writeSnapshot(at: Date, opts: { reportOn?: boolean } = {}): void {
  const snap: HealthSnapshot = {
    at: at.toISOString(), line: { ok: true, text: '✅ Connected' }, whatsapp: { state: 'open', since: at.toISOString(), lastErrorCode: null, credsSaveFailures: 0 },
    downSince: null, failed: [], lastSuccessAt: null, lastPublishedAt: null, spentToday: 0, capUsd: 15, freeGb: 100, publishFailingSince: null,
    ingestFailures: 0,
    ...(opts.reportOn === false ? {} : { report: { text: 'Morning report: due now', warning: null } }),
  };
  withTracker((db) => setKv(db, 'health', JSON.stringify(snap)));
}

async function seedSender(key: Buffer = KEY): Promise<void> {
  const sdb = openSessionDb(senderSessionDbPath(dataDir));
  const auth = useSenderAuthState(sdb, key);
  auth.state.creds.me = { id: '919800000099:2@s.whatsapp.net', name: 'Spare' };
  await auth.saveCreds();
  sdb.close();
}

const senderLinked = (): boolean => {
  const sdb = openSessionDb(senderSessionDbPath(dataDir));
  try {
    return useSenderAuthState(sdb, KEY).hasSession;
  } finally {
    sdb.close();
  }
};

const request = () => withTracker((db) => getKv(db, REPORT_REQUEST_KEY));

/** Files in the data folder whose names start with sender-session.db. */
const senderFiles = () => readdirSync(dataDir).filter((f) => f.startsWith('sender-session.db')).sort();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-report-'));
  dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  lines = [];
  sockets = [];
  scripts = [];
  confirm = vi.fn(async () => true);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  fsSeam.failRename = undefined;
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('cli link-sender', () => {
  it('links the spare number by QR into its own file, without touching the founder session or sending anything', async () => {
    scripts = [
      (s) => {
        s.emit('connection.update', { qr: 'QR-1' });
        closeWith(s, 515);
      },
      open,
    ];
    await linkSenderCommand({ reset: false }, deps());
    expect(out()).toContain('SPARE phone');
    expect(out()).toContain('Spare number linked.');
    expect(existsSync(senderSessionDbPath(dataDir))).toBe(true);
    expect(existsSync(sessionDbPath(dataDir))).toBe(false);
    expect(sockets).toHaveLength(2);
    for (const s of sockets) for (const name of SEND_METHODS) expect(s[name]).not.toHaveBeenCalled();
    expect(senderLinked()).toBe(false); // the fake socket never sets creds.me; the file is the spare number's own
    const lock = await acquireLock(dataDir); // released by the command
    await lock.release();
  });

  it('refuses while the service holds the data folder', async () => {
    const lock = await acquireLock(dataDir);
    try {
      await expect(linkSenderCommand({ reset: false }, deps())).rejects.toThrow(/Another WA Agent process/);
    } finally {
      await lock.release();
    }
    expect(sockets).toHaveLength(0);
    expect(existsSync(senderSessionDbPath(dataDir))).toBe(false);
  });

  it('says so when the spare number is already linked, and connects nothing', async () => {
    await seedSender();
    await linkSenderCommand({ reset: false }, deps());
    expect(out()).toContain('already linked');
    expect(sockets).toHaveLength(0);
  });

  it('--reset asks first, and "no" keeps the session', async () => {
    await seedSender();
    confirm.mockResolvedValue(false);
    await linkSenderCommand({ reset: true }, deps());
    expect(confirm.mock.calls[0]![0]).toContain('data/sender-session.db');
    expect(out()).toContain('Nothing was changed.');
    expect(senderLinked()).toBe(true);
    expect(sockets).toHaveLength(0);
  });

  it('--reset cancelled with Ctrl+C keeps the session', async () => {
    await seedSender();
    confirm.mockRejectedValue(new ConfirmCancelled());
    await linkSenderCommand({ reset: true }, deps());
    expect(out()).toContain('Cancelled. Nothing was changed.');
    expect(senderLinked()).toBe(true);
    expect(sockets).toHaveLength(0);
  });

  it('--reset with yes deletes only the spare session and links again', async () => {
    await seedSender();
    await linkSenderCommand({ reset: true }, deps());
    expect(out()).toContain('Reset: the saved spare-number session was deleted.');
    expect(out()).toContain('Spare number linked.');
    expect(existsSync(sessionDbPath(dataDir))).toBe(false);
    expect(sockets).toHaveLength(1);
  });

  it('--reset with nothing saved says so and links', async () => {
    await linkSenderCommand({ reset: true }, deps());
    expect(out()).toContain('No saved spare-number link to reset.');
    expect(out()).toContain('Spare number linked.');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('gives up after its link timeout when no QR code ever comes, and releases the lock', async () => {
    scripts = [() => {}]; // the connection never opens and never shows a QR code
    await expect(linkSenderCommand({ reset: false }, deps())).rejects.toThrow(/not scanned within 5 minutes/);
    expect(sockets).toHaveLength(1);
    for (const s of sockets) for (const name of SEND_METHODS) expect(s[name]).not.toHaveBeenCalled();
    const lock = await acquireLock(dataDir); // released after the failure
    await lock.release();
  });

  it('explains a refused link', async () => {
    scripts = [(s) => closeWith(s, 401)];
    await expect(linkSenderCommand({ reset: false }, deps())).rejects.toThrow(/link-sender --reset/);
  });

  it("refuses a link made with the founder's phone: clears the saved session, links nothing and sends nothing", async () => {
    const factory: SenderSocketFactory = (auth) => {
      const s = new FakeSocket();
      sockets.push(s);
      queueMicrotask(() => {
        s.emit('connection.update', { qr: 'QR-1' });
        auth.creds.me = { id: `${NUMBER}:5@s.whatsapp.net`, name: 'Founder' }; // the founder's phone scanned the QR code
        s.emit('creds.update', { me: auth.creds.me });
        open(s);
      });
      return s;
    };
    const err = await linkSenderCommand({ reset: false }, { ...deps(), senderSocketFactory: factory }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).not.toContain('\n');
    expect(message).toContain("scanned with the founder's phone");
    expect(message).toContain('SPARE phone');
    expect(message).not.toContain(NUMBER);
    expect(out()).not.toContain('Spare number linked.');
    expect(senderLinked()).toBe(false);
    expect(sockets).toHaveLength(1);
    for (const s of sockets) for (const name of SEND_METHODS) expect(s[name]).not.toHaveBeenCalled();
    const lock = await acquireLock(dataDir); // released after the failure
    await lock.release();
  });

  it('a session written with another master key: without --reset it says to reset and changes nothing', async () => {
    await seedSender(OTHER_KEY);
    const before = readFileSync(senderSessionDbPath(dataDir));
    const err = await linkSenderCommand({ reset: false }, deps()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SenderSessionDecryptError); // a key mismatch, not a damaged file
    expect((err as Error).message).toContain('master key');
    expect((err as Error).message).toContain('link-sender --reset');
    expect((err as Error).message).not.toContain('damaged');
    expect(readFileSync(senderSessionDbPath(dataDir)).equals(before)).toBe(true);
    expect(existsSync(sessionDbPath(dataDir))).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(0);
  });

  it('a session written with another master key: --reset asks, then clears it and links', async () => {
    await seedSender(OTHER_KEY);
    await linkSenderCommand({ reset: true }, deps());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(out()).toContain('Reset: the saved spare-number session was deleted.');
    expect(out()).toContain('Spare number linked.');
    expect(senderLinked()).toBe(false); // readable with this key now
    expect(existsSync(sessionDbPath(dataDir))).toBe(false);
  });

  it('a damaged session file: --reset with yes moves it aside unchanged, opens a fresh file and links by QR', async () => {
    const file = senderSessionDbPath(dataDir);
    writeFileSync(file, JUNK);
    scripts = [
      (s) => {
        s.emit('connection.update', { qr: 'QR-1' });
        open(s);
      },
    ];
    await linkSenderCommand({ reset: true }, deps());
    const question = confirm.mock.calls[0]![0];
    expect(question).toContain('data/sender-session.db');
    expect(question).toContain('damaged');
    expect(question).toContain('not deleted');
    const moved = senderFiles().filter((f) => f.startsWith('sender-session.db.damaged-'));
    expect(moved).toEqual(['sender-session.db.damaged-20261023T090000']);
    expect(readFileSync(join(dataDir, moved[0]!)).equals(JUNK)).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).equals(JUNK)).toBe(false);
    expect(out()).toContain('sender-session.db.damaged-20261023T090000');
    expect(out()).toContain('SPARE phone');
    expect(out()).toContain('Spare number linked.');
    expect(sockets).toHaveLength(1);
    expect(existsSync(sessionDbPath(dataDir))).toBe(false);
    expect(senderLinked()).toBe(false); // the fresh file is readable with the spare number's own key
  });

  it('a damaged session file: its -wal and -shm files move with it, and an earlier damaged copy is never overwritten', async () => {
    const file = senderSessionDbPath(dataDir);
    const earlier = Buffer.from('earlier damaged copy');
    writeFileSync(`${file}.damaged-20261023T090000`, earlier);
    writeFileSync(file, JUNK);
    writeFileSync(`${file}-wal`, Buffer.from('wal bytes'));
    writeFileSync(`${file}-shm`, Buffer.from('shm bytes'));
    await linkSenderCommand({ reset: true }, deps());
    expect(readFileSync(`${file}.damaged-20261023T090000`).equals(earlier)).toBe(true);
    expect(readFileSync(`${file}.damaged-20261023T090000-2`).equals(JUNK)).toBe(true);
    expect(readFileSync(`${file}-wal.damaged-20261023T090000-2`).toString()).toBe('wal bytes');
    expect(readFileSync(`${file}-shm.damaged-20261023T090000-2`).toString()).toBe('shm bytes');
    expect(out()).toContain('Spare number linked.');
    expect(senderLinked()).toBe(false);
  });

  it('a damaged session file: an earlier damaged -wal copy is never overwritten, even with no earlier main-file copy', async () => {
    const file = senderSessionDbPath(dataDir);
    const earlierWal = Buffer.from('earlier damaged wal copy');
    writeFileSync(`${file}-wal.damaged-20261023T090000`, earlierWal);
    writeFileSync(file, JUNK);
    writeFileSync(`${file}-wal`, Buffer.from('new wal bytes'));
    await linkSenderCommand({ reset: true }, deps());
    expect(readFileSync(`${file}-wal.damaged-20261023T090000`).equals(earlierWal)).toBe(true);
    expect(existsSync(`${file}.damaged-20261023T090000`)).toBe(false);
    expect(readFileSync(`${file}.damaged-20261023T090000-2`).equals(JUNK)).toBe(true);
    expect(readFileSync(`${file}-wal.damaged-20261023T090000-2`).toString()).toBe('new wal bytes');
    expect(out()).toContain('sender-session.db.damaged-20261023T090000-2');
    expect(out()).toContain('Spare number linked.');
  });

  it('a damaged session file: the moved-aside name carries the seconds', async () => {
    vi.setSystemTime(new Date('2026-10-23T03:30:07.000Z'));
    writeFileSync(senderSessionDbPath(dataDir), JUNK);
    await linkSenderCommand({ reset: true }, deps());
    expect(senderFiles().filter((f) => f.startsWith('sender-session.db.damaged-'))).toEqual(['sender-session.db.damaged-20261023T090007']);
  });

  it('a damaged session file: the -wal and -shm files are moved first, so a failed rename of the main file leaves no stale log beside it', async () => {
    const file = senderSessionDbPath(dataDir);
    writeFileSync(file, JUNK);
    writeFileSync(`${file}-wal`, Buffer.from('wal bytes'));
    writeFileSync(`${file}-shm`, Buffer.from('shm bytes'));
    fsSeam.failRename = file; // another program holds the main file
    await expect(linkSenderCommand({ reset: true }, deps())).rejects.toThrow(/EBUSY/);
    expect(senderFiles()).toEqual(['sender-session.db', 'sender-session.db-shm.damaged-20261023T090000', 'sender-session.db-wal.damaged-20261023T090000']);
    expect(readFileSync(file).equals(JUNK)).toBe(true);
    expect(sockets).toHaveLength(0);
    const lock = await acquireLock(dataDir); // released after the failure
    await lock.release();
  });

  it('a damaged session file: "no" or Ctrl+C leaves it and its -wal and -shm files unchanged at their names', async () => {
    const file = senderSessionDbPath(dataDir);
    writeFileSync(file, JUNK);
    writeFileSync(`${file}-wal`, Buffer.from('wal bytes'));
    writeFileSync(`${file}-shm`, Buffer.from('shm bytes'));
    confirm.mockResolvedValueOnce(false).mockRejectedValueOnce(new ConfirmCancelled());
    await linkSenderCommand({ reset: true }, deps());
    await linkSenderCommand({ reset: true }, deps());
    expect(lines).toEqual(['Nothing was changed.', 'Cancelled. Nothing was changed.']);
    expect(senderFiles()).toEqual(['sender-session.db', 'sender-session.db-shm', 'sender-session.db-wal']);
    expect(readFileSync(file).equals(JUNK)).toBe(true);
    expect(readFileSync(`${file}-wal`).toString()).toBe('wal bytes');
    expect(readFileSync(`${file}-shm`).toString()).toBe('shm bytes');
    expect(sockets).toHaveLength(0);
  });

  it('a damaged session file without --reset: one line saying to run --reset, and the file is unchanged', async () => {
    const file = senderSessionDbPath(dataDir);
    writeFileSync(file, JUNK);
    writeFileSync(`${file}-wal`, Buffer.from('wal bytes'));
    const err = await linkSenderCommand({ reset: false }, deps()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).not.toContain('\n');
    expect(message).toContain('damaged');
    expect(message).toContain('npm run cli -- link-sender --reset');
    expect(confirm).not.toHaveBeenCalled();
    expect(senderFiles()).toEqual(['sender-session.db', 'sender-session.db-wal']);
    expect(readFileSync(file).equals(JUNK)).toBe(true);
    expect(readFileSync(`${file}-wal`).toString()).toBe('wal bytes');
    expect(sockets).toHaveLength(0);
  });

  it('a session file that cannot be opened (not damaged): stops, never suggests --reset and moves nothing, even with --reset', async () => {
    mkdirSync(senderSessionDbPath(dataDir)); // a folder at the file's path: SQLITE_CANTOPEN
    for (const reset of [false, true]) {
      const err = await linkSenderCommand({ reset }, deps()).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('could not be opened');
      expect((err as Error).message).not.toContain('npm run cli -- link-sender --reset');
    }
    expect(confirm).not.toHaveBeenCalled();
    expect(senderFiles()).toEqual(['sender-session.db']);
    expect(sockets).toHaveLength(0);
    const lock = await acquireLock(dataDir); // released after the failure
    await lock.release();
  });
});

describe('cli report status', () => {
  it('shows the settings, today and the last days, with the number masked', () => {
    withTracker((db) => {
      skipReport(db, '2026-10-21', 'connect_timeout', '2026-10-21T06:30:00.000Z');
      claimReport(db, '2026-10-22', '2026-10-22T00:30:00.000Z');
      finishReport(db, '2026-10-22', 'sent', 'msg-1,msg-2', '2026-10-22T00:31:00.000Z');
      claimReport(db, DAY, '2026-10-23T00:30:00.000Z');
      finishReport(db, DAY, 'unknown', 'timeout', '2026-10-23T00:33:00.000Z');
    });
    reportStatusCommand(deps());
    expect(lines).toEqual([
      'Morning report: on, 06:00 to 12:00 IST, to the number ending …5678',
      'Today (2026-10-23): Morning report: unknown, check WhatsApp',
      'Last days:',
      '  2026-10-22  sent    at 06:01 IST',
      '  2026-10-21  skipped could not connect to WhatsApp',
    ]);
    expect(out()).not.toContain(NUMBER);
  });

  it("repeats the running service's warning", () => {
    const snap = {
      at: NOW.toISOString(), line: { ok: false, text: 'x' }, whatsapp: { state: 'open', since: NOW.toISOString(), lastErrorCode: null, credsSaveFailures: 0 },
      downSince: null, failed: [], lastSuccessAt: null, lastPublishedAt: null, spentToday: 0, capUsd: 15, freeGb: 100, publishFailingSince: null,
      ingestFailures: 0, report: { text: 'Morning report: due now', warning: '⚠️ Morning report: the spare number is not linked.' },
    };
    withTracker((db) => setKv(db, 'health', JSON.stringify(snap)));
    reportStatusCommand(deps());
    expect(lines).toEqual([
      'Morning report: on, 06:00 to 12:00 IST, to the number ending …5678',
      'Today (2026-10-23): Morning report: due now',
      '⚠️ Morning report: the spare number is not linked.',
    ]);
  });

  it("does not repeat an old snapshot's warning: says the service has not reported since then", () => {
    const at = new Date(NOW.getTime() - 3 * 60_000);
    const snap = {
      at: at.toISOString(), line: { ok: false, text: 'x' }, whatsapp: { state: 'open', since: at.toISOString(), lastErrorCode: null, credsSaveFailures: 0 },
      downSince: null, failed: [], lastSuccessAt: null, lastPublishedAt: null, spentToday: 0, capUsd: 15, freeGb: 100, publishFailingSince: null,
      ingestFailures: 0, report: { text: 'Morning report: due now', warning: '⚠️ Morning report: the spare number is not linked.' },
    };
    withTracker((db) => setKv(db, 'health', JSON.stringify(snap)));
    reportStatusCommand(deps());
    expect(lines).toEqual([
      'Morning report: on, 06:00 to 12:00 IST, to the number ending …5678',
      'Today (2026-10-23): Morning report: due now',
      '⚠️ The service has not reported since 23 Oct 08:57. Is it running?',
    ]);
  });

  it('says when the report is off', () => {
    reportStatusCommand(deps({ REPORT_ENABLED: 'false' }));
    expect(lines).toEqual(['Morning report: off (set REPORT_ENABLED=true and REPORT_RECIPIENT in .env, then restart the service)']);
    // A stopped service does not matter while the report is off: still the one line.
    writeSnapshot(new Date(NOW.getTime() - 3 * 60_000), { reportOn: false });
    lines = [];
    reportStatusCommand(deps({ REPORT_ENABLED: 'false' }));
    expect(lines).toEqual(['Morning report: off (set REPORT_ENABLED=true and REPORT_RECIPIENT in .env, then restart the service)']);
  });

  it("still shows today's row when the report is off", () => {
    withTracker((db) => {
      claimReport(db, DAY, '2026-10-23T00:30:00.000Z');
      finishReport(db, DAY, 'sent', 'msg-1,msg-2', '2026-10-23T00:31:00.000Z');
    });
    reportStatusCommand(deps({ REPORT_ENABLED: 'false' }));
    expect(lines[0]).toBe('Morning report: off (set REPORT_ENABLED=true and REPORT_RECIPIENT in .env, then restart the service)');
    expect(lines[1]).toMatch(/^Today \(2026-10-23\): /);
    expect(lines).toHaveLength(2);
  });

  it('lists at most the last 7 days, newest first', () => {
    withTracker((db) => {
      for (let d = 14; d <= 22; d++) skipReport(db, `2026-10-${d}`, 'connect_timeout', `2026-10-${d}T06:30:00.000Z`);
    });
    reportStatusCommand(deps());
    const history = lines.filter((l) => l.startsWith('  2026-'));
    expect(history.map((l) => l.slice(2, 12))).toEqual(['2026-10-22', '2026-10-21', '2026-10-20', '2026-10-19', '2026-10-18', '2026-10-17', '2026-10-16']);
  });
});

describe('cli report send-now', () => {
  it('asks, then hands the request to the running service, stamped with the time of the yes', async () => {
    writeSnapshot(NOW);
    const answeredAt = new Date(NOW.getTime() + 30_000);
    confirm.mockImplementation(async () => {
      vi.setSystemTime(answeredAt); // the owner took 30 s to answer
      return true;
    });
    await reportSendNowCommand(deps());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0]).toContain('the number ending …5678');
    expect(confirm.mock.calls[0]![0]).not.toContain(NUMBER);
    expect(request()).toBe(reportRequest(DAY, undefined, answeredAt));
    expect(request()).toBe(`${DAY}|none||2026-10-23T03:30:30.000Z`);
    expect(out()).toContain('Requested.');
  });

  it('records the row the owner was shown, so the service honours the request only while it is unchanged', async () => {
    writeSnapshot(NOW);
    withTracker((db) => {
      claimReport(db, DAY, '2026-10-23T00:30:00.000Z');
      retryReport(db, DAY, 'connect_timeout', '2026-10-23T00:32:00.000Z', '2026-10-23T00:30:30.000Z');
    });
    await reportSendNowCommand(deps());
    const row = withTracker((db) => reportFor(db, DAY));
    expect(request()).toBe(reportRequest(DAY, row, NOW));
    expect(request()).toBe(`${DAY}|retry|2026-10-23T00:30:30.000Z|${NOW.toISOString()}`);
  });

  it('refuses without asking when today was already sent', async () => {
    writeSnapshot(NOW);
    withTracker((db) => {
      claimReport(db, DAY, '2026-10-23T00:30:00.000Z');
      finishReport(db, DAY, 'sent', 'msg-1,msg-2', '2026-10-23T00:31:00.000Z');
    });
    await reportSendNowCommand(deps());
    expect(out()).toBe("Today's report was already sent at 06:01 IST. Nothing was sent.");
    expect(confirm).not.toHaveBeenCalled();
    expect(request()).toBeUndefined();
  });

  it('refuses while a send is running', async () => {
    writeSnapshot(NOW);
    withTracker((db) => claimReport(db, DAY, '2026-10-23T03:29:00.000Z'));
    await reportSendNowCommand(deps());
    expect(out()).toContain('being sent right now');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('refuses when the service is not running', async () => {
    await reportSendNowCommand(deps());
    writeSnapshot(new Date(NOW.getTime() - 3 * 60_000));
    await reportSendNowCommand(deps());
    expect(lines).toEqual([
      'The service is not running, so nothing can be sent. Start it first (net start wa-agent), then run this again.',
      'The service is not running, so nothing can be sent. Start it first (net start wa-agent), then run this again.',
    ]);
    expect(confirm).not.toHaveBeenCalled();
    expect(request()).toBeUndefined();
  });

  it('warns first when the last try ended unknown', async () => {
    writeSnapshot(NOW);
    withTracker((db) => {
      claimReport(db, DAY, '2026-10-23T00:30:00.000Z');
      finishReport(db, DAY, 'unknown', 'timeout', '2026-10-23T00:33:00.000Z');
    });
    await reportSendNowCommand(deps());
    expect(confirm.mock.calls[0]![0]).toContain("may already be on the founder's phone");
    expect(request()).toBe(`${DAY}|unknown|2026-10-23T00:33:00.000Z|${NOW.toISOString()}`);
  });

  it('changes nothing when declined or cancelled', async () => {
    writeSnapshot(NOW);
    confirm.mockResolvedValueOnce(false).mockRejectedValueOnce(new ConfirmCancelled());
    await reportSendNowCommand(deps());
    await reportSendNowCommand(deps());
    expect(lines).toEqual(['Nothing was sent.', 'Cancelled. Nothing was sent.']);
    expect(request()).toBeUndefined();
  });

  it('refuses after the yes when the service sent today meanwhile', async () => {
    writeSnapshot(NOW);
    confirm.mockImplementation(async () => {
      withTracker((db) => {
        claimReport(db, DAY, '2026-10-23T03:30:00.000Z');
        finishReport(db, DAY, 'sent', 'msg-1,msg-2', '2026-10-23T03:31:00.000Z');
      });
      return true;
    });
    await reportSendNowCommand(deps());
    expect(out()).toBe("Today's report was already sent at 09:01 IST. Nothing was sent.");
    expect(request()).toBeUndefined();
  });

  it('refuses after the yes when a send started meanwhile', async () => {
    writeSnapshot(NOW);
    confirm.mockImplementation(async () => {
      withTracker((db) => claimReport(db, DAY, '2026-10-23T03:30:00.000Z'));
      return true;
    });
    await reportSendNowCommand(deps());
    expect(out()).toContain('being sent right now');
    expect(request()).toBeUndefined();
  });

  it('refuses after the yes when today changed from what was shown (a send ended unknown meanwhile)', async () => {
    writeSnapshot(NOW);
    confirm.mockImplementation(async () => {
      withTracker((db) => {
        claimReport(db, DAY, '2026-10-23T03:30:00.000Z');
        finishReport(db, DAY, 'unknown', 'timeout', '2026-10-23T03:32:00.000Z');
      });
      return true;
    });
    await reportSendNowCommand(deps());
    expect(out()).toContain('changed while you were answering');
    expect(out()).toContain('Morning report: unknown, check WhatsApp');
    expect(out()).toContain('Nothing was sent.');
    expect(request()).toBeUndefined();
  });

  it('refuses after the yes when the same status was written again meanwhile (a newer try)', async () => {
    writeSnapshot(NOW);
    withTracker((db) => {
      claimReport(db, DAY, '2026-10-23T00:30:00.000Z');
      retryReport(db, DAY, 'connect_timeout', '2026-10-23T00:32:00.000Z', '2026-10-23T00:30:30.000Z');
    });
    confirm.mockImplementation(async () => {
      withTracker((db) => {
        expect(claimReport(db, DAY, '2026-10-23T03:30:00.000Z')).toBe(true);
        expect(retryReport(db, DAY, 'connect_timeout', '2026-10-23T03:32:00.000Z', '2026-10-23T03:30:30.000Z')).toBe(true);
      });
      return true;
    });
    await reportSendNowCommand(deps());
    expect(withTracker((db) => reportFor(db, DAY))?.status).toBe('retry');
    expect(out()).toContain('changed while you were answering');
    expect(out()).toContain('Nothing was sent.');
    expect(request()).toBeUndefined();
  });

  it('refuses after the yes when the IST date changed meanwhile', async () => {
    writeSnapshot(NOW);
    confirm.mockImplementation(async () => {
      vi.setSystemTime(new Date('2026-10-23T18:31:00.000Z')); // 00:01 IST on 24 Oct
      return true;
    });
    await reportSendNowCommand(deps());
    expect(out()).toContain('The date changed while you were answering');
    expect(out()).toContain('Nothing was sent.');
    expect(request()).toBeUndefined();
  });

  it('refuses without asking when the running service was started with the report off', async () => {
    writeSnapshot(NOW, { reportOn: false });
    await reportSendNowCommand(deps());
    expect(lines).toEqual([
      'The running service has the morning report off (it was started before REPORT_ENABLED=true was set). Restart it (net stop wa-agent, then net start wa-agent), wait a minute, then run this again.',
    ]);
    expect(confirm).not.toHaveBeenCalled();
    expect(request()).toBeUndefined();
  });

  it('refuses when the report is off', async () => {
    await reportSendNowCommand(deps({ REPORT_ENABLED: 'false' }));
    expect(out()).toContain('The morning report is off.');
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('cli wiring of the report commands', () => {
  async function run(args: string[]): Promise<unknown[][]> {
    const calls: unknown[][] = [];
    const d = deps();
    const program = new Command().exitOverride();
    addReportCommands(program, () => d, {
      linkSender: async (opts, got) => void calls.push(['link-sender', opts, got === d]),
      reportStatus: (got) => void calls.push(['report status', got === d]),
      reportSendNow: async (got) => void calls.push(['report send-now', got === d]),
    });
    await program.parseAsync(args, { from: 'user' });
    return calls;
  }

  it('link-sender resets only with --reset, and each report command runs its own function', async () => {
    expect(await run(['link-sender'])).toEqual([['link-sender', { reset: false }, true]]);
    expect(await run(['link-sender', '--reset'])).toEqual([['link-sender', { reset: true }, true]]);
    expect(await run(['report', 'status'])).toEqual([['report status', true]]);
    expect(await run(['report', 'send-now'])).toEqual([['report send-now', true]]);
  });
});
