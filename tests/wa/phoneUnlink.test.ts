import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntry } from '../../src/control/errors.ts';
import type { Db, Sql } from '../../src/store/db.ts';
import { manualClock } from '../../src/util/clock.ts';
import { createLogger } from '../../src/util/logger.ts';
import { AllowList } from '../../src/wa/allowlist.ts';
import { hasSessionRows, openSessionDb, useEncryptedAuthState } from '../../src/wa/authState.ts';
import { WhatsAppGateway, type GatewayLike } from '../../src/wa/gateway.ts';
import { unlinkPhone } from '../../src/wa/phoneControl.ts';
import { PhoneList } from '../../src/wa/phoneList.ts';
import { PhoneSet } from '../../src/wa/phoneSet.ts';
import { SwitchableGateway } from '../../src/wa/switchableGateway.ts';
import { FakeSocket } from '../helpers/fakeSocket.ts';
import { testDb } from '../helpers/db.ts';

// Unlinking a reading phone (lane C, change 7, task 8): the device is logged out at WhatsApp, its gateway stops, it is
// marked unlinked (audited with its masked number), and its session is cleared. Messages, tasks and approvals stay.

const AT = '2026-11-02T10:00:00.000Z';
const OWNER = 'owner@example.com';
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

/** A real gateway on a fake socket that can log out: open, with its logout scripted. */
async function openGateway(logout: () => Promise<void>, o: { unlinkTimeoutMs?: number } = {}) {
  const sessionDb = openSessionDb(':memory:');
  cleanup.push(() => sessionDb.close());
  const auth = await useEncryptedAuthState(sessionDb, randomBytes(32));
  const socket = new FakeSocket() as FakeSocket & { logout?: () => Promise<void> };
  socket.logout = vi.fn(logout);
  const gateway = new WhatsAppGateway({ allow: new AllowList([]), factory: () => socket, auth: auth.state, saveCreds: auth.saveCreds, ...o });
  gateway.start();
  socket.emit('connection.update', { connection: 'open' });
  cleanup.push(() => gateway.stop());
  return { gateway, socket };
}

describe('the gateway’s logout', () => {
  it('asks WhatsApp to log the device out while open: true when it took it', async () => {
    const { gateway, socket } = await openGateway(async () => undefined);
    expect(await gateway.endLink()).toBe(true);
    expect(socket.logout).toHaveBeenCalledTimes(1);
  });

  it('false, and nothing asked, while not open; false when the request fails or never answers', async () => {
    const closed = await openGateway(async () => undefined);
    await closed.gateway.stop();
    expect(await closed.gateway.endLink()).toBe(false);
    expect(closed.socket.logout).not.toHaveBeenCalled();
    const failing = await openGateway(async () => {
      throw new Error('request failed: secret detail');
    });
    expect(await failing.gateway.endLink()).toBe(false);
    const silent = await openGateway(() => new Promise(() => undefined), { unlinkTimeoutMs: 20 });
    expect(await silent.gateway.endLink()).toBe(false);
  });

  it('the switchable passes it to its gateway; with none it is false', async () => {
    const { gateway, socket } = await openGateway(async () => undefined);
    expect(await new SwitchableGateway({ inner: gateway }).endLink()).toBe(true);
    expect(socket.logout).toHaveBeenCalledTimes(1);
    expect(await new SwitchableGateway({ initialState: 'not_linked' }).endLink()).toBe(false);
  });
});

/** A workspace with phones 1 and 2, phone 2 linked to 919800000002 with a saved session. */
async function workspace(o: { endLink?: () => Promise<boolean>; audit?: (q: Sql, e: AuditEntry) => Promise<void> } = {}) {
  const db = await testDb();
  const audits: AuditEntry[] = [];
  const audit = o.audit ?? (async (_q: Sql, e: AuditEntry) => void audits.push(e));
  const list = await PhoneList.open({ db, clock: manualClock(AT), groupsOn: () => 0 });
  await list.add('Front desk', OWNER, async () => undefined);
  const set = new PhoneSet({ clock: manualClock(AT) });
  const fake = (): GatewayLike & { endLink: ReturnType<typeof vi.fn>; counts: { stopped: number } } => {
    const counts = { stopped: 0 };
    return {
      counts,
      endLink: vi.fn(o.endLink ?? (async () => true)),
      onEvent: () => undefined, onStatus: () => undefined, onHistory: () => undefined,
      status: () => ({ state: 'open' as const, since: AT, lastErrorCode: null, credsSaveFailures: 0 }),
      start: () => undefined,
      stop: async () => {
        counts.stopped++;
      },
      listGroups: async () => [], failedCount: () => 0, droppedCount: () => 0,
    };
  };
  const one = fake();
  const two = fake();
  set.add({ id: 1, label: 'Phone 1', gateway: one, allow: new AllowList([]) });
  set.add({ id: 2, label: 'Front desk', gateway: two, allow: new AllowList([]) });
  set.start();
  const sessionOf = async (): Promise<Db> => {
    const s = openSessionDb(':memory:');
    cleanup.push(() => s.close());
    const auth = await useEncryptedAuthState(s, randomBytes(32));
    auth.state.creds.me = { id: '919800000002:5@s.whatsapp.net', name: 'x' };
    await auth.saveCreds();
    return s;
  };
  const sessionOne = await sessionOf();
  const sessionTwo = await sessionOf();
  const lines: string[] = [];
  const log = createLogger('debug', { write: (s: string) => void lines.push(s) });
  const unlink = () => unlinkPhone({ id: 2, actor: OWNER, audit, list, set, gateway: two, sessionDb: sessionTwo, number: '919800000002', log });
  return { db, list, set, one, two, sessionOne, sessionTwo, audits, lines, unlink };
}

describe('unlinking a phone', () => {
  it('logs it out, stops only it, marks it unlinked (audited, number masked) and clears only its session', async () => {
    const w = await workspace();
    const r = await w.unlink();
    expect(r.loggedOut).toBe(true);
    expect(w.two.endLink).toHaveBeenCalledTimes(1);
    expect(w.two.counts.stopped).toBe(1);
    expect(w.one.counts.stopped).toBe(0);
    expect(w.set.phones().map((p) => p.id)).toEqual([1]);
    expect(w.list.get(2)).toMatchObject({ state: 'unlinked', label: 'Front desk' });
    expect(w.audits).toEqual([expect.objectContaining({ event: 'phone.unlinked', kind: 'connection', actor: OWNER })]);
    expect(w.audits[0]!.detail).toMatch(/^Phone 2 unlinked: Front desk \(.*0002\)$/);
    expect(w.audits[0]!.detail).not.toContain('919800000002');
    expect(await hasSessionRows(w.sessionTwo)).toBe(false);
    expect(await hasSessionRows(w.sessionOne)).toBe(true);
  });

  it('when WhatsApp cannot be told, the rest still happens, and the result says so', async () => {
    const w = await workspace({ endLink: async () => false });
    const r = await w.unlink();
    expect(r.loggedOut).toBe(false);
    expect(w.list.get(2)?.state).toBe('unlinked');
    expect(await hasSessionRows(w.sessionTwo)).toBe(false);
  });

  it('a session that cannot be cleared leaves the phone unlinked (never started again), logged without the number', async () => {
    const w = await workspace();
    await w.sessionTwo.close();
    await expect(w.unlink()).resolves.toMatchObject({ phone: { state: 'unlinked' } });
    expect(w.lines.join(' ')).toMatch(/could not be cleared/);
    expect(w.lines.join(' ')).not.toContain('919800000002');
  });

  it('an audit that fails leaves it not marked, and its session as it was', async () => {
    const w = await workspace({
      audit: async () => {
        throw new Error('audit write failed');
      },
    });
    await expect(w.unlink()).rejects.toThrow('audit write failed');
    expect(w.list.get(2)?.state).toBe('active');
    expect(await hasSessionRows(w.sessionTwo)).toBe(true);
  });
});
