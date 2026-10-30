import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { getKv } from '../../src/store/kv.ts';
import { createLogger } from '../../src/util/logger.ts';
import { AllowList } from '../../src/wa/allowlist.ts';
import { openSessionDb, resetSession, useEncryptedAuthState, type EncryptedAuth } from '../../src/wa/authState.ts';
import { TRACKER_DEVICE_NAME, WhatsAppGateway } from '../../src/wa/gateway.ts';
import {
  backupAndReset, founderLinkDriver, guardAuth, LinkBusyError, LinkSessions, recoverInterruptedLink, type LinkDriver, type LinkEvent,
} from '../../src/wa/linkSession.ts';
import { SwitchableGateway } from '../../src/wa/switchableGateway.ts';
import { closeWith, FakeSocket } from '../helpers/fakeSocket.ts';

const QR1 = 'QR-SECRET-one-2@abc';
const QR2 = 'QR-SECRET-two-2@def';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A service with a linked founder session, its gateway on fake sockets, and the link sessions around it. */
async function setup(o: { linked?: boolean; timeoutMs?: number } = {}) {
  const key = randomBytes(32);
  const sessionDb = openSessionDb(':memory:');
  const trackerDb = openDb(':memory:');
  if (o.linked !== false) {
    const first = await useEncryptedAuthState(sessionDb, key);
    first.state.creds.me = { id: '919800000001:3@s.whatsapp.net', name: 'Founder' };
    await first.saveCreds();
  }
  const sockets: FakeSocket[] = [];
  const auths: EncryptedAuth[] = [];
  const lines: string[] = [];
  const log = createLogger('debug', { write: (s: string) => void lines.push(s) });
  const buildGateway = (auth: EncryptedAuth, onQr?: (qr: string) => void) => {
    auths.push(auth);
    return new WhatsAppGateway({
      allow: new AllowList([]),
      factory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      auth: auth.state,
      saveCreds: auth.saveCreds,
      onQr,
    });
  };
  const switchable = new SwitchableGateway(
    o.linked === false ? { initialState: 'not_linked' } : { inner: buildGateway(await useEncryptedAuthState(sessionDb, key)) },
  );
  const statuses: string[] = [];
  switchable.onStatus((s) => statuses.push(s.state));
  switchable.start();
  if (o.linked !== false) sockets[0]!.emit('connection.update', { connection: 'open' });
  const audits: { event: string; actor: string }[] = [];
  const sessions = new LinkSessions({
    drivers: { founder: founderLinkDriver({ sessionDb, trackerDb, key, switchable, buildGateway, log }) },
    log,
    audit: async (event, actor) => { audits.push({ event, actor }); },
    ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
  });
  const rows = () => sessionDb.raw.prepare('SELECT k, v FROM auth ORDER BY k').all() as { k: string; v: Buffer }[];
  const backupRows = () => {
    sessionDb.raw.exec('CREATE TABLE IF NOT EXISTS auth_backup (k TEXT PRIMARY KEY, v BLOB NOT NULL)');
    return (sessionDb.raw.prepare('SELECT COUNT(*) AS n FROM auth_backup').get() as { n: number }).n;
  };
  return { key, sessionDb, trackerDb, sockets, auths, lines, switchable, statuses, audits, sessions, rows, backupRows };
}

function record(sessions: LinkSessions, id: string) {
  const events: LinkEvent[] = [];
  sessions.subscribe(id, (e) => events.push(e));
  return events;
}

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup) await c();
  cleanup = [];
});

describe('founder relink', () => {
  it('happy path: QR codes in order, open hands the new gateway to the service, the old one was stopped', async () => {
    const t = await setup();
    cleanup.push(() => t.switchable.stop());
    const before = t.rows();
    const link = t.sessions.start({ target: 'founder', actor: 'owner@studio.in' });
    const events = record(t.sessions, link.id);
    await tick();
    expect(t.sockets[0]!.end).toHaveBeenCalled(); // the old gateway stopped
    expect(t.switchable.status().state).toBe('linking');
    expect(t.rows()).not.toEqual(before); // reset
    const fresh = t.sockets[1]!;
    fresh.emit('connection.update', { qr: QR1 });
    fresh.emit('connection.update', { qr: QR2 });
    fresh.emit('connection.update', { connection: 'open' });
    await t.sessions.settled(link.id);
    expect(events).toEqual([
      { type: 'state', state: 'waiting_qr' },
      { type: 'qr', qr: QR1 },
      { type: 'state', state: 'qr' },
      { type: 'qr', qr: QR2 },
      { type: 'state', state: 'linked' },
      { type: 'done', device: TRACKER_DEVICE_NAME },
    ]);
    expect(t.sessions.info(link.id)).toMatchObject({ state: 'linked', device: TRACKER_DEVICE_NAME, errorCode: null });
    expect(t.switchable.status().state).toBe('open');
    expect(t.sockets).toHaveLength(2); // handed over as it is: no third connection
    expect(await getKv(t.trackerDb, 'session_reset_at')).toBeTruthy();
    expect(t.audits).toEqual([{ event: "WhatsApp relinked · founder's phone", actor: 'owner@studio.in' }]);
    // The service now reads from the new gateway.
    let seen = 0;
    t.switchable.onStatus(() => seen++);
    fresh.emit('connection.update', { connection: 'open' });
    expect(seen).toBe(1);
  });

  it('cancel restores the session rows byte for byte and reconnects', async () => {
    const t = await setup();
    cleanup.push(() => t.switchable.stop());
    const before = t.rows();
    const link = t.sessions.start({ target: 'founder', actor: 'owner@studio.in' });
    await tick();
    t.sockets[1]!.emit('connection.update', { qr: QR1 });
    expect(t.sessions.cancel(link.id)).toBe(true);
    await t.sessions.settled(link.id);
    expect(t.rows()).toEqual(before);
    expect(t.sockets[1]!.end).toHaveBeenCalled(); // the linking gateway stopped
    expect(t.sockets).toHaveLength(3); // reconnected with the restored session
    expect(t.switchable.status().state).toBe('connecting');
    expect(t.sessions.info(link.id)).toMatchObject({ state: 'cancelled', errorCode: 'cancelled' });
    expect(t.audits.map((a) => a.event)).toEqual(['WhatsApp relink cancelled']);
    expect(await getKv(t.trackerDb, 'session_reset_at')).toBeUndefined();
  });

  it('the 5-minute timeout restores the session', async () => {
    const t = await setup({ timeoutMs: 30 });
    cleanup.push(() => t.switchable.stop());
    const before = t.rows();
    const link = t.sessions.start({ target: 'founder', actor: 'a@b.in' });
    await t.sessions.settled(link.id);
    expect(t.rows()).toEqual(before);
    expect(t.sessions.info(link.id)).toMatchObject({ state: 'timed_out' });
    expect(t.audits.map((a) => a.event)).toEqual(['WhatsApp relink timed out']);
  });

  it('logged_out during the link restores the session and reports the code', async () => {
    const t = await setup();
    cleanup.push(() => t.switchable.stop());
    const before = t.rows();
    const link = t.sessions.start({ target: 'founder', actor: 'a@b.in' });
    await tick();
    closeWith(t.sockets[1]!, 401);
    await t.sessions.settled(link.id);
    expect(t.rows()).toEqual(before);
    expect(t.sessions.info(link.id)).toMatchObject({ state: 'failed', errorCode: 'logged_out' });
    expect(t.audits.map((a) => a.event)).toEqual(['WhatsApp relink failed (logged_out)']);
  });

  it('a scan moves the link to opening (WhatsApp closes once and reconnects)', async () => {
    const t = await setup();
    cleanup.push(() => t.switchable.stop());
    const link = t.sessions.start({ target: 'founder', actor: 'a@b.in' });
    await tick();
    t.sockets[1]!.emit('connection.update', { qr: QR1 });
    closeWith(t.sockets[1]!, 515); // restart required
    expect(t.sessions.info(link.id)!.state).toBe('opening');
    t.sessions.cancel(link.id);
    await t.sessions.settled(link.id);
  });

  it('a second start while one runs gives LinkBusyError', async () => {
    const t = await setup();
    cleanup.push(() => t.switchable.stop());
    const link = t.sessions.start({ target: 'founder', actor: 'a@b.in' });
    expect(() => t.sessions.start({ target: 'founder', actor: 'a@b.in' })).toThrow(LinkBusyError);
    t.sessions.cancel(link.id);
    await t.sessions.settled(link.id);
    const again = t.sessions.start({ target: 'founder', actor: 'a@b.in' }); // allowed once ended
    t.sessions.cancel(again.id);
    await t.sessions.settled(again.id);
  });

  it('a subscriber joining late gets the current state and only the latest QR', async () => {
    const t = await setup();
    cleanup.push(() => t.switchable.stop());
    const link = t.sessions.start({ target: 'founder', actor: 'a@b.in' });
    await tick();
    t.sockets[1]!.emit('connection.update', { qr: QR1 });
    t.sockets[1]!.emit('connection.update', { qr: QR2 });
    const events = record(t.sessions, link.id);
    expect(events).toEqual([{ type: 'state', state: 'qr' }, { type: 'qr', qr: QR2 }]);
    t.sessions.cancel(link.id);
    await t.sessions.settled(link.id);
    expect(events.at(-1)).toEqual({ type: 'error', code: 'cancelled' });
  });

  it('no QR code appears in any log line or audit line', async () => {
    const t = await setup();
    cleanup.push(() => t.switchable.stop());
    const link = t.sessions.start({ target: 'founder', actor: 'a@b.in' });
    await tick();
    t.sockets[1]!.emit('connection.update', { qr: QR1 });
    t.sockets[1]!.emit('connection.update', { qr: QR2 });
    t.sessions.cancel(link.id);
    await t.sessions.settled(link.id);
    expect(t.lines.length).toBeGreaterThan(0);
    expect(t.lines.join('\n')).not.toMatch(/QR-SECRET/);
    expect(JSON.stringify(t.audits)).not.toMatch(/QR-SECRET/);
  });

  it('setup mode (never linked): a cancel leaves no session and no gateway', async () => {
    const t = await setup({ linked: false });
    cleanup.push(() => t.switchable.stop());
    expect(t.rows()).toEqual([]);
    const link = t.sessions.start({ target: 'founder', actor: 'a@b.in' });
    await tick();
    t.sessions.cancel(link.id);
    await t.sessions.settled(link.id);
    expect(t.rows()).toEqual([]);
    expect(t.switchable.status().state).toBe('not_linked');
    expect(t.switchable.hasGateway()).toBe(false);
  });

  it('setup mode: a successful link gives the service its first gateway', async () => {
    const t = await setup({ linked: false });
    cleanup.push(() => t.switchable.stop());
    const link = t.sessions.start({ target: 'founder', actor: 'a@b.in' });
    await tick();
    t.sockets[0]!.emit('connection.update', { connection: 'open' });
    await t.sessions.settled(link.id);
    expect(t.switchable.status().state).toBe('open');
  });

  it('stop() on shutdown undoes a running link and waits for it', async () => {
    const t = await setup();
    const before = t.rows();
    const link = t.sessions.start({ target: 'founder', actor: 'a@b.in' });
    await tick();
    await t.sessions.stop();
    expect(t.rows()).toEqual(before);
    expect(t.sessions.info(link.id)).toMatchObject({ state: 'failed', errorCode: 'stopped' });
    await t.switchable.stop();
  });

  it('a driver that throws ends the link as failed, never as linked', async () => {
    const driver: LinkDriver = { run: () => Promise.reject(new Error('boom')) };
    const audits: string[] = [];
    const sessions = new LinkSessions({ drivers: { founder: driver }, log: createLogger('silent'), audit: async (e) => { audits.push(e); } });
    const link = sessions.start({ target: 'founder', actor: 'a@b.in' });
    await sessions.settled(link.id);
    expect(sessions.info(link.id)).toMatchObject({ state: 'failed', errorCode: 'error' });
    expect(audits).toEqual(['WhatsApp relink failed (error)']);
  });

  it('the backup is in the database: a crash mid-link is undone at the next start', async () => {
    const t = await setup();
    cleanup.push(() => t.switchable.stop());
    const before = t.rows();
    const link = t.sessions.start({ target: 'founder', actor: 'a@b.in' });
    await tick();
    expect(t.rows()).not.toEqual(before);
    expect(t.backupRows()).toBeGreaterThan(0);
    // What the next start does, before it reads the session:
    expect(await recoverInterruptedLink(t.sessionDb)).toBe(true);
    expect(t.rows()).toEqual(before);
    expect(t.backupRows()).toBe(0);
    expect(await recoverInterruptedLink(t.sessionDb)).toBe(false);
    t.sessions.cancel(link.id);
    await t.sessions.settled(link.id);
    expect(t.rows()).toEqual(before);
  });

  it('a finished link leaves no backup, so the next start keeps the new session', async () => {
    const t = await setup();
    cleanup.push(() => t.switchable.stop());
    const link = t.sessions.start({ target: 'founder', actor: 'a@b.in' });
    await tick();
    t.sockets[1]!.emit('connection.update', { connection: 'open' });
    await t.sessions.settled(link.id);
    const after = t.rows();
    expect(t.backupRows()).toBe(0);
    expect(await recoverInterruptedLink(t.sessionDb)).toBe(false);
    expect(t.rows()).toEqual(after);
  });

  it('a cancel before the reset touches nothing: the session and the gateway stay as they were', async () => {
    const t = await setup();
    cleanup.push(() => t.switchable.stop());
    const before = t.rows();
    const link = t.sessions.start({ target: 'founder', actor: 'a@b.in' });
    t.sessions.cancel(link.id); // while the old gateway is still stopping
    await t.sessions.settled(link.id);
    expect(t.rows()).toEqual(before);
    expect(t.switchable.hasGateway()).toBe(true);
    expect(t.backupRows()).toBe(0);
    expect(t.sessions.info(link.id)).toMatchObject({ state: 'cancelled' });
  });

  it('a close that is not the restart after a scan (an expired code) does not move the link to opening', async () => {
    const t = await setup();
    cleanup.push(() => t.switchable.stop());
    const link = t.sessions.start({ target: 'founder', actor: 'a@b.in' });
    await tick();
    t.sockets[1]!.emit('connection.update', { qr: QR1 });
    closeWith(t.sockets[1]!, 408);
    expect(t.sessions.info(link.id)!.state).toBe('qr');
    t.sessions.cancel(link.id);
    await t.sessions.settled(link.id);
  });

  it.each([
    [403, 'forbidden'],
    [440, 'replaced'],
  ])('WhatsApp closing with %i during the link restores the session (%s)', async (code, name) => {
    const t = await setup();
    cleanup.push(() => t.switchable.stop());
    const before = t.rows();
    const link = t.sessions.start({ target: 'founder', actor: 'a@b.in' });
    await tick();
    closeWith(t.sockets[1]!, code);
    await t.sessions.settled(link.id);
    expect(t.rows()).toEqual(before);
    expect(t.sessions.info(link.id)).toMatchObject({ state: 'failed', errorCode: name });
  });

  it('a relink from a different phone number is logged as a warning with both numbers masked', async () => {
    const t = await setup();
    cleanup.push(() => t.switchable.stop());
    const link = t.sessions.start({ target: 'founder', actor: 'a@b.in' });
    await tick();
    t.auths.at(-1)!.state.creds.me = { id: '919899999999:4@s.whatsapp.net', name: 'Other' };
    t.sockets[1]!.emit('connection.update', { connection: 'open' });
    await t.sessions.settled(link.id);
    const warn = t.lines.find((l) => l.includes('relinked from a different number'));
    expect(warn).toBeDefined();
    expect(warn).toContain('…9999');
    expect(warn).toContain('…0001');
    expect(t.lines.join(' ')).not.toMatch(/919899999999|919800000001/);
  });

  it('a driver that commits after an abort is reported as linked (it is kept); one that undoes is not', async () => {
    let finish!: (o: { ok: true; device: string } | { ok: false; code: string }) => void;
    const driver: LinkDriver = { run: () => new Promise((r) => (finish = r)) };
    const sessions = new LinkSessions({ drivers: { founder: driver }, log: createLogger('silent'), audit: async () => {} });
    const a = sessions.start({ target: 'founder', actor: 'a@b.in' });
    await tick(); // the driver starts on the next turn
    sessions.cancel(a.id);
    finish({ ok: true, device: 'D' });
    await sessions.settled(a.id);
    expect(sessions.info(a.id)).toMatchObject({ state: 'linked', device: 'D' });
    const b = sessions.start({ target: 'founder', actor: 'a@b.in' });
    await tick();
    sessions.cancel(b.id);
    finish({ ok: false, code: 'aborted' });
    await sessions.settled(b.id);
    expect(sessions.info(b.id)).toMatchObject({ state: 'cancelled' });
  });

  it('a driver that throws at once ends the link and frees the slot', async () => {
    const driver: LinkDriver = {
      run: () => {
        throw new Error('sync boom');
      },
    };
    const sessions = new LinkSessions({ drivers: { founder: driver }, log: createLogger('silent'), audit: async () => {} });
    const a = sessions.start({ target: 'founder', actor: 'a@b.in' });
    await sessions.settled(a.id);
    expect(sessions.info(a.id)).toMatchObject({ state: 'failed', errorCode: 'error' });
    expect(() => sessions.start({ target: 'founder', actor: 'a@b.in' })).not.toThrow();
  });
});

describe('session backup helpers', () => {
  it('guardAuth drops writes once stopped, and passes them before', async () => {
    const db = openSessionDb(':memory:');
    const key = randomBytes(32);
    const auth = await useEncryptedAuthState(db, key);
    let stopped = false;
    const guarded = guardAuth(auth, () => stopped);
    const count = () => (db.raw.prepare('SELECT COUNT(*) AS n FROM auth').get() as { n: number }).n;
    const start = count();
    await guarded.state.keys.set({ 'pre-key': { '1': { public: Buffer.alloc(32), private: Buffer.alloc(32) } } });
    expect(count()).toBe(start + 1);
    stopped = true;
    await guarded.state.keys.set({ 'pre-key': { '2': { public: Buffer.alloc(32), private: Buffer.alloc(32) } } });
    await guarded.saveCreds();
    expect(count()).toBe(start + 1);
  });

  it("resetSession (the CLI's --reset) also drops a backup left by an unfinished dashboard link", async () => {
    const db = openSessionDb(':memory:');
    await useEncryptedAuthState(db, randomBytes(32)); // the canary row
    await backupAndReset(db);
    await resetSession(db);
    expect(await recoverInterruptedLink(db)).toBe(false);
    expect((db.raw.prepare('SELECT COUNT(*) AS n FROM auth').get() as { n: number }).n).toBe(0);
  });

  it('a cancelled founder link leaves no backup behind', async () => {
    const t = await setup();
    cleanup.push(() => t.switchable.stop());
    const link = t.sessions.start({ target: 'founder', actor: 'a@b.in' });
    await tick();
    t.sessions.cancel(link.id);
    await t.sessions.settled(link.id);
    expect(t.backupRows()).toBe(0);
  });
});
