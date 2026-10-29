import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DestinationStream } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEnv, reportSettings } from '../../src/config/env.ts';
import { senderSessionDbPath, sessionDbPath } from '../../src/config/paths.ts';
import { openMorningReport, senderOpener } from '../../src/report/start.ts';
import { createLogger } from '../../src/util/logger.ts';
import { openSessionDb, useEncryptedAuthState, useSenderAuthState } from '../../src/wa/authState.ts';
import { FakeSocket } from '../helpers/fakeSocket.ts';

const RECIPIENT = '919800001234';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'wa-report-start-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function capture() {
  const lines: string[] = [];
  const dest = { write: (s: string) => { lines.push(s); } } as unknown as DestinationStream;
  return { log: createLogger('info', dest), out: () => lines.join(''), records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

function start(dir: string, master: Buffer, founderNumber?: string) {
  const env = parseEnv({ DATA_DIR: dir, REPORT_ENABLED: 'true', REPORT_RECIPIENT: RECIPIENT });
  const c = capture();
  const factory = vi.fn(() => new FakeSocket());
  const r = openMorningReport({ env, masterKey: master, log: c.log, factory, founderNumber });
  return { ...r, ...c, factory, env };
}

/** Writes a linked session into file with the founder's (open = useEncryptedAuthState) or the spare number's key. */
async function linkedFile(file: string, master: Buffer, open: typeof useSenderAuthState): Promise<void> {
  const db = openSessionDb(file);
  const a = open(db, master);
  a.state.creds.me = { id: '919800000099:3@s.whatsapp.net', name: 'S' };
  await a.saveCreds();
  db.raw.close();
}

/** The full number, or any 5 of its digits in a row, must not reach the log. */
function expectNoNumber(out: string): void {
  for (let i = 0; i + 5 <= RECIPIENT.length; i++) expect(out).not.toContain(RECIPIENT.slice(i, i + 5));
}

describe('openMorningReport (service start, REPORT_ENABLED)', () => {
  it('opens data/sender-session.db only, logs the last 4 digits of the recipient, and connects nothing yet', () => {
    const dir = tempDir();
    const r = start(dir, randomBytes(32));
    try {
      expect(r.senderDb).toBeDefined();
      expect(existsSync(senderSessionDbPath(dir))).toBe(true);
      expect(existsSync(sessionDbPath(dir))).toBe(false); // the founder's session is never opened
      expect(r.report.settings).toEqual(reportSettings(r.env));
      expect(r.report.sender.status().state).toBe('not_linked');
      expect(r.factory).not.toHaveBeenCalled();
      const line = r.records().find((l) => l.msg === 'morning report enabled');
      expect(line).toMatchObject({ recipientLast4: '…1234', linked: false });
      expectNoNumber(r.out());
    } finally {
      r.senderDb?.raw.close();
    }
  });

  it('reads a linked spare-number session with the spare number key', async () => {
    const dir = tempDir();
    const master = randomBytes(32);
    await linkedFile(senderSessionDbPath(dir), master, useSenderAuthState);
    const r = start(dir, master);
    try {
      expect(r.report.sender.status().state).toBe('idle');
      expect(r.records().find((l) => l.msg === 'morning report enabled')).toMatchObject({ linked: true });
    } finally {
      r.senderDb?.raw.close();
    }
  });

  it("refuses to send when the spare-number link is the founder reader's own number, and never logs that number", async () => {
    const dir = tempDir();
    const master = randomBytes(32);
    await linkedFile(senderSessionDbPath(dir), master, useSenderAuthState); // linked as 919800000099
    const r = start(dir, master, '919800000099');
    try {
      expect(r.report.sender.status().state).toBe('self_send');
      expect(await r.report.sender.sendReport('hi')).toEqual({ status: 'failed', code: 'self_send' });
      expect(r.factory).not.toHaveBeenCalled();
      for (let i = 0; i + 5 <= 12; i++) expect(r.out()).not.toContain('919800000099'.slice(i, i + 5));
    } finally {
      r.senderDb?.raw.close();
    }
    const other = start(tempDir(), master, '919800000099');
    other.senderDb?.raw.close();
    expect(other.report.sender.status().state).toBe('not_linked');
  });

  it("main.ts passes the founder reader's linked number to openMorningReport as a forbidden sender", () => {
    const src = readFileSync(join(import.meta.dirname, '../../src/main.ts'), 'utf8');
    const call = /openMorningReport\(\{([^}]*)\}\)/.exec(src);
    expect(call).not.toBeNull();
    expect(call![1]).toMatch(/(?:^|[\s,{])founderNumber: linkedNumber\(auth\)/);
    // auth is the founder's session (session.db), opened before the report starts.
    expect(src).toMatch(/const auth = useEncryptedAuthState\(sessionDb, key\);/);
    expect(src.indexOf('const auth = useEncryptedAuthState(sessionDb, key);')).toBeLessThan(src.indexOf('openMorningReport('));
  });

  it("never uses the founder's session: a linked session.db leaves the spare number unlinked", async () => {
    const dir = tempDir();
    const master = randomBytes(32);
    await linkedFile(sessionDbPath(dir), master, useEncryptedAuthState);
    const before = readFileSync(sessionDbPath(dir));
    const r = start(dir, master);
    try {
      expect(r.report.sender.status().state).toBe('not_linked');
      expect(readFileSync(sessionDbPath(dir)).equals(before)).toBe(true);
    } finally {
      r.senderDb?.raw.close();
    }
  });

  it('a sender session written with the founder session key is unreadable (the spare number has its own key)', async () => {
    const dir = tempDir();
    const master = randomBytes(32);
    await linkedFile(senderSessionDbPath(dir), master, useEncryptedAuthState);
    const r = start(dir, master);
    expect(r.senderDb).toBeUndefined();
    expect(r.report.sender.status().state).toBe('unreadable');
  });

  it('a damaged sender session never stops the service: it is logged without the number, and left as it is', () => {
    const dir = tempDir();
    const junk = Buffer.alloc(4096, 0x41);
    writeFileSync(senderSessionDbPath(dir), junk);
    const r = start(dir, randomBytes(32));
    expect(r.senderDb).toBeUndefined();
    expect(r.report.sender.status().state).toBe('unreadable');
    const err = r.records().find((l) => l.reason === 'session_unreadable');
    expect(err?.level).toBe(50);
    expect(String(err?.code)).toMatch(/^SQLITE_/);
    expect(r.records().find((l) => l.msg === 'morning report enabled')).toMatchObject({ recipientLast4: '…1234', linked: false });
    expectNoNumber(r.out());
    expect(readFileSync(senderSessionDbPath(dir)).equals(junk)).toBe(true);
  });

  it('main.ts opens the spare number only through openMorningReport, and logs no recipient field itself', () => {
    const src = readFileSync(join(import.meta.dirname, '../../src/main.ts'), 'utf8');
    expect(src).toContain('openMorningReport(');
    expect(src).not.toMatch(/openSenderSession|useSenderAuthState|new SenderGateway|senderSessionDbPath\(/);
    expect(src).not.toMatch(/\brecipient\b\s*:/);
  });

  it('main.ts passes the report to createApp when REPORT_ENABLED, and closes the spare-number database on shutdown', () => {
    const src = readFileSync(join(import.meta.dirname, '../../src/main.ts'), 'utf8');
    // The report is built only under REPORT_ENABLED, and the openMorningReport result is what reaches createApp.
    expect(src).toMatch(/if \(env\.REPORT_ENABLED\) \{/);
    expect(src).toMatch(/const (\w+) = openMorningReport\([\s\S]*?\breport = \1\.report;/);
    expect(src).toMatch(/\bsenderDb = (\w+)\.senderDb;/);
    const call = /createApp\(\{([\s\S]*?)\n\s*\}\);/.exec(src);
    expect(call).not.toBeNull();
    expect(call![1]).toMatch(/^\s*report,?\s*$/m);
    // The spare-number session is closed after app.stop(), and on the startup-failure path, and nowhere else: closing it
    // while the sender runs would make its credential saves fail.
    const count = (sub: string) => src.split(sub).length - 1;
    expect(count('senderDb?.raw.close()')).toBe(1);
    const catchAt = src.indexOf('} catch (e) {');
    expect(catchAt).toBeGreaterThan(0);
    const catchBlock = src.slice(catchAt, src.indexOf('process.exit(2)', catchAt));
    expect(catchBlock).toContain('senderDb?.raw.close()');
    expect(count('senderStore?.raw.close()')).toBe(1);
    const stopAt = src.indexOf('.stop()');
    expect(stopAt).toBeGreaterThan(0);
    const afterStop = src.slice(stopAt, src.indexOf('process.exit', stopAt));
    expect(afterStop).toMatch(/\.finally\(\(\) => \{[\s\S]*senderStore\?\.raw\.close\(\)/);
    const startup = src.slice(src.indexOf('openMorningReport('), src.indexOf('createApp({'));
    expect(startup.length).toBeGreaterThan(0);
    expect(startup).not.toMatch(/\.close\(/);
  });

  it('closes the spare-number database when the sender cannot be made, so no handle is left open', () => {
    const dir = tempDir();
    const env = { ...parseEnv({ DATA_DIR: dir, REPORT_ENABLED: 'true', REPORT_RECIPIENT: RECIPIENT }), REPORT_RECIPIENT: '12345' };
    const c = capture();
    expect(() => openMorningReport({ env, masterKey: randomBytes(32), log: c.log, factory: vi.fn(() => new FakeSocket()) })).toThrow();
    expect(existsSync(senderSessionDbPath(dir))).toBe(true); // it was opened
    // An open handle would make this fail with EBUSY on Windows.
    for (const suffix of ['', '-wal', '-shm']) rmSync(senderSessionDbPath(dir) + suffix, { force: true });
    expect(existsSync(senderSessionDbPath(dir))).toBe(false);
  });

  it('a session file that cannot be opened (not damaged) is unavailable: logged, no --reset advice', () => {
    const dir = tempDir();
    mkdirSync(senderSessionDbPath(dir), { recursive: true }); // a directory where the file should be
    const r = start(dir, randomBytes(32));
    expect(r.senderDb).toBeUndefined();
    expect(r.report.sender.status().state).toBe('unavailable');
    const err = r.records().find((l) => l.reason === 'session_unavailable');
    expect(err?.level).toBe(50);
    expect(String(err?.code)).toMatch(/^SQLITE_CANTOPEN/);
    expectNoNumber(r.out());
  });
});

describe('senderOpener (dashboard settings, D5 Task 1)', () => {
  it('opens a sender for the given number, not the .env one, and close() closes its session file', () => {
    const dir = tempDir();
    const env = parseEnv({ DATA_DIR: dir, REPORT_RECIPIENT: RECIPIENT });
    const c = capture();
    const open = senderOpener({ env, masterKey: randomBytes(32), log: c.log, factory: vi.fn(() => new FakeSocket()) });
    const a = open('917012349999');
    expect(a.sender.maskedRecipient()).toBe('…9999');
    a.close();
    // The file is closed, so the next open (a later number change) can open it again.
    const b = open('919811112222');
    expect(b.sender.maskedRecipient()).toBe('…2222');
    b.close();
    expect(c.out()).not.toContain('7012349999');
  });

  it('works when REPORT_ENABLED was false at service start', () => {
    const dir = tempDir();
    const env = parseEnv({ DATA_DIR: dir });
    const open = senderOpener({ env, masterKey: randomBytes(32), log: capture().log, factory: vi.fn(() => new FakeSocket()) });
    const a = open('917012349999');
    expect(a.sender.maskedRecipient()).toBe('…9999');
    a.close();
  });
});
