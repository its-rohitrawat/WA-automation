import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { getKv } from '../../src/store/kv.ts';
import { createLogger, silentLogger } from '../../src/util/logger.ts';
import { AllowList } from '../../src/wa/allowlist.ts';
import { openSessionDb, phoneSessionKey, useEncryptedAuthState, type EncryptedAuth } from '../../src/wa/authState.ts';
import { WhatsAppGateway } from '../../src/wa/gateway.ts';
import { founderLinkDriver, LinkSessions, type LinkDriver, type LinkTarget } from '../../src/wa/linkSession.ts';
import { SwitchableGateway } from '../../src/wa/switchableGateway.ts';
import type { OwnerContext } from '../../src/web/routes/context.ts';
import { linkErrorMessage, WhatsAppLinkRoutes } from '../../src/web/routes/whatsapp.ts';
import { FakeSocket } from '../helpers/fakeSocket.ts';
import { testDb } from '../helpers/db.ts';

// Linking reading phones 2 to 5 (lane C, change 7): today's QR flow, each on its own session, its own key and its own
// session_reset_at, one link at a time per workspace, and a number already linked as another phone refused.

const tick = () => new Promise((r) => setTimeout(r, 0));
const owner: OwnerContext = { actor: 'owner@studio.in', sessionId: 'session-a', requestId: 'aaaaaaaaaaaa' };

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

/** Phone 3 of a workspace whose phone 1 is linked to 919800000001; phone 3 not linked yet. */
async function setup(o: { refuseOthers?: string[] } = {}) {
  const workspaceKey = randomBytes(32);
  const key = phoneSessionKey(workspaceKey, 'phone3');
  const sessionDb = openSessionDb(':memory:');
  const trackerDb = await testDb();
  const sockets: FakeSocket[] = [];
  const auths: EncryptedAuth[] = [];
  const buildGateway = (auth: EncryptedAuth, onQr?: (qr: string) => void) => {
    auths.push(auth);
    return new WhatsAppGateway({
      allow: new AllowList([]),
      factory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      auth: auth.state, saveCreds: auth.saveCreds, onQr,
    });
  };
  const switchable = new SwitchableGateway({ initialState: 'not_linked' });
  switchable.start();
  cleanup.push(() => switchable.stop());
  const audits: string[] = [];
  const lines: string[] = [];
  const others = new Set(o.refuseOthers ?? ['919800000001']);
  const driver = founderLinkDriver({
    sessionDb, trackerDb, key, switchable, buildGateway, log: createLogger('debug', { write: (s: string) => void lines.push(s) }),
    resetKey: 'session_reset_at:phone3',
    refuse: (number) => (others.has(number) ? 'number_in_use' : undefined),
  });
  const drivers = new Map<LinkTarget, LinkDriver>([['phone3', driver]]);
  const sessions = new LinkSessions({ drivers: (t) => drivers.get(t), log: silentLogger(), audit: async (e) => void audits.push(e) });
  /** The scan: the new link's creds name `number` and are saved (as Baileys does on creds.update), then WhatsApp opens. */
  const scan = async (number: string) => {
    const auth = auths.at(-1)!;
    auth.state.creds.me = { id: `${number}:4@s.whatsapp.net`, name: 'x' };
    await auth.saveCreds();
    sockets.at(-1)!.emit('connection.update', { connection: 'open' });
  };
  return { workspaceKey, key, sessionDb, trackerDb, switchable, sessions, drivers, audits, lines, scan };
}

describe('linking reading phones 2 to 5', () => {
  it('phone 3 links with its own key and its own session_reset_at, and is audited as Phone 3', async () => {
    const t = await setup();
    const link = t.sessions.start({ target: 'phone3', actor: owner.actor });
    await tick();
    await t.scan('919800000003');
    await t.sessions.settled(link.id);
    expect(t.sessions.info(link.id)).toMatchObject({ state: 'linked' });
    expect(t.switchable.status().state).toBe('open');
    expect((await useEncryptedAuthState(t.sessionDb, t.key)).hasSession).toBe(true); // sealed with phone 3's key
    await expect(useEncryptedAuthState(t.sessionDb, t.workspaceKey)).rejects.toThrow(); // not with the workspace key
    expect(await getKv(t.trackerDb, 'session_reset_at:phone3')).toBeTruthy();
    expect(await getKv(t.trackerDb, 'session_reset_at')).toBeUndefined(); // phone 1's is not touched
    expect(t.audits).toEqual(['WhatsApp linked · Phone 3']);
  });

  it('a number already linked as another phone is refused: the link is undone, as if cancelled', async () => {
    const t = await setup();
    const link = t.sessions.start({ target: 'phone3', actor: owner.actor });
    await tick();
    await t.scan('919800000001'); // phone 1's number
    await t.sessions.settled(link.id);
    expect(t.sessions.info(link.id)).toMatchObject({ state: 'failed', errorCode: 'number_in_use' });
    expect(t.switchable.status().state).toBe('not_linked'); // as before: phone 3 was not linked
    expect(Number((await t.sessionDb.get<{ n: number }>('SELECT COUNT(*) AS n FROM auth'))!.n)).toBe(0); // nothing kept
    expect(await getKv(t.trackerDb, 'session_reset_at:phone3')).toBeUndefined();
    expect(t.audits).toEqual(['WhatsApp link failed · Phone 3 (number_in_use)']);
    expect(t.lines.join(' ')).not.toMatch(/919800000001/); // the number is never logged
    expect(linkErrorMessage('phone3', 'number_in_use')).toMatch(/already linked/);
  });

  it('one link at a time per workspace, across the phones', async () => {
    const t = await setup();
    const pending: LinkDriver = { run: () => new Promise(() => undefined) };
    t.drivers.set('phone4', pending);
    t.sessions.start({ target: 'phone4', actor: owner.actor });
    expect(() => t.sessions.start({ target: 'phone3', actor: owner.actor })).toThrow(/already in progress/);
  });

  it('the route takes phone2 to phone5; a phone with no driver (not added) is a 404; busy is a 409 naming another phone', async () => {
    const t = await setup();
    const routes = new WhatsAppLinkRoutes({ sessions: t.sessions });
    expect(routes.start(owner, { target: 'phone6', confirm: true })).toMatchObject({ status: 400 });
    expect(routes.start(owner, { target: 'phone2', confirm: true })).toMatchObject({ status: 404, body: { error: { code: 'no_such_phone' } } });
    const first = routes.start(owner, { target: 'phone3', confirm: true });
    expect(first.status).toBe(200);
    const busy = routes.start(owner, { target: 'phone3', confirm: true });
    expect(busy).toMatchObject({ status: 409, body: { error: { code: 'link_in_progress' } } });
    expect(JSON.stringify(busy.body)).toMatch(/Another phone is being linked/);
  });
});
