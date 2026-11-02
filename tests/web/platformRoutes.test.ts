import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiKeys } from '../../src/platform/aiKey.ts';
import { inviteForSignup, redeemInvite } from '../../src/platform/invites.ts';
import type { InviteEmail, InviteMailer, MailOutcome } from '../../src/platform/mailer.ts';
import { membershipsFor } from '../../src/platform/store.ts';
import type { Db } from '../../src/store/db.ts';
import { onSqlite } from '../helpers/db.ts';
import { platformTestDb, type PlatformTestDb } from '../helpers/platformTestDb.ts';
import { manualClock, type ManualClock } from '../../src/util/clock.ts';
import { createLogger } from '../../src/util/logger.ts';
import type { ApiResult, OwnerContext } from '../../src/web/routes/context.ts';
import { mountPlatformRoutes, type PlatformMount, type PlatformRouteDeps } from '../../src/web/routes/platform.ts';
import type { RequestContext } from '../../src/web/router.ts';

// The platform routes through a stand-in for the dashboard's registrars (mountRoutes.ts adds the owner guard, Origin,
// CSRF and the action limit around every change). A fake mailer only: nothing here reaches Gmail or Google.

const FOUNDER: OwnerContext = { actor: 'founder@example.com', sessionId: 's-hash', requestId: 'a1b2c3d4e5f6' };
const CUSTOMER: OwnerContext = { actor: 'kapoor.studio@example.com', sessionId: 's-hash-2', requestId: 'f6e5d4c3b2a1' };
/** CUSTOMER's session in one workspace, as S4.8's sessions carry it (OwnerContext gains tenantId and role then). */
const customerIn = (tenantId: string): OwnerContext => ({ ...CUSTOMER, tenantId, role: 'owner' }) as OwnerContext;
const SITE = 'https://agent.example.com';

/** Records every email; answers as told. `stateDuring`: the invite's send state when Gmail is asked. */
class FakeMailer implements InviteMailer {
  readonly from = 'founder@example.com';
  sent: InviteEmail[] = [];
  mode: 'ok' | 'throw' | 'failed' | 'unknown' = 'ok';
  stateDuring: string[] = [];
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  async send(m: InviteEmail): Promise<MailOutcome> {
    this.sent.push(m);
    this.stateDuring.push((await this.db.get<{ s: string }>('SELECT send_state AS s FROM invites ORDER BY created_at DESC LIMIT 1'))!.s);
    if (this.mode === 'throw') throw new Error('network said something about kapoor.studio@example.com');
    if (this.mode === 'failed') return { state: 'failed', code: 'no_permission' };
    if (this.mode === 'unknown') return { state: 'unknown', code: 'timeout' };
    return { state: 'sent' };
  }
}

let store: PlatformTestDb;
/** The platform tables (on SQLite, a customer's kv lives in the same store). */
let db: Db;
let clock: ManualClock;
let mailer: FakeMailer;
let logLines: string[];
let routes: Map<string, (ctx: RequestContext, o: OwnerContext, body?: unknown) => ApiResult | Promise<ApiResult>>;

function mount(o: Partial<PlatformRouteDeps> = {}) {
  routes = new Map();
  const m: PlatformMount = {
    read: (path, fn) => void routes.set(`GET ${path}`, fn),
    change: (path, fn) => void routes.set(`POST ${path}`, fn),
  };
  mountPlatformRoutes(m, {
    db, clock, log: createLogger('debug', { write: (l: string) => void logLines.push(l) }), publicUrl: `${SITE}/`, founderName: 'Rohit',
    isFounder: (x) => x.actor === FOUNDER.actor, mailer: () => mailer, ...o,
  });
}

beforeEach(async () => {
  store = await platformTestDb();
  db = store.db;
  clock = manualClock('2026-10-29T06:00:00.000Z');
  mailer = new FakeMailer(db);
  logLines = [];
  mount();
});
afterEach(async () => {
  await store.close();
});

const call = async (method: 'GET' | 'POST', path: string, o: OwnerContext = FOUNDER, body: unknown = {}, params: Record<string, string> = {}) => {
  const pattern = path.replace(/[0-9a-f-]{36}/, ':id');
  const fn = routes.get(`${method} ${pattern}`);
  if (!fn) throw new Error(`no route ${method} ${pattern}`);
  const id = /[0-9a-f-]{36}/.exec(path)?.[0];
  const ctx = { params: { ...(id ? { id } : {}), ...params }, url: new URL(path, SITE) } as unknown as RequestContext;
  return fn(ctx, o, body);
};
const body = (r: ApiResult) => r.body as Record<string, any>;
const tokenOf = (link: string) => new URL(link).searchParams.get('invite')!;
const invite = (send: boolean, email = 'Kapoor.Studio@example.com') => call('POST', '/dashboard/api/platform/invites', FOUNDER, { business: 'Kapoor Design Studio', email, send });

describe('the platform routes', () => {
  it('are for the founder only', async () => {
    for (const [method, path] of [['GET', '/dashboard/api/platform/invites'], ['POST', '/dashboard/api/platform/invites']] as const) {
      const r = await call(method, path, CUSTOMER, { business: 'x', email: 'x@example.com', send: false });
      expect(r.status).toBe(403);
    }
    const made = body(await invite(false));
    for (const action of ['link', 'resend', 'cancel']) expect((await call('POST', `/dashboard/api/platform/invites/${made.invite.id}/${action}`, CUSTOMER)).status).toBe(403);
    expect(mailer.sent).toEqual([]);
  });

  it('Copy link (send false): an invite and its link, nothing emailed; the link opens the sign-up page for that business', async () => {
    const r = await invite(false);
    expect(r.status).toBe(200);
    const b = body(r);
    expect(b.link).toMatch(/^https:\/\/agent\.example\.com\/signup\?invite=[A-Za-z0-9_-]{43}$/);
    expect(b).toMatchObject({ email: 'not_sent', invite: { business: 'Kapoor Design Studio', email: 'kapoor.studio@example.com', status: 'open', send: 'none' } });
    expect(mailer.sent).toEqual([]);
    expect(await inviteForSignup({ db, clock }, tokenOf(b.link))).toMatchObject({ business: 'Kapoor Design Studio' });
    const list = body(await call('GET', '/dashboard/api/platform/invites'));
    expect(list).toMatchObject({ left: 19, perDay: 20, gmail: { connected: true, from: 'founder@example.com' } });
    expect(JSON.stringify(list)).not.toContain(tokenOf(b.link));
  });

  it('Send invite: marked sending before Gmail is asked, the email holds the link and the invited address, then sent', async () => {
    const b = body(await invite(true));
    expect(b.email).toBe('sent');
    expect(mailer.stateDuring).toEqual(['sending']);
    expect(mailer.sent).toEqual([{ to: 'kapoor.studio@example.com', business: 'Kapoor Design Studio', founderName: 'Rohit', link: b.link, expiresAt: b.invite.expiresAt }]);
    expect(b.invite.send).toBe('sent');
    const asking = logLines.findIndex((l) => l.includes('invite email: asking Gmail'));
    expect(asking).toBeGreaterThan(-1);
    expect(logLines.findIndex((l) => l.includes('invite email: done'))).toBeGreaterThan(asking);
    // No link, token or address in the log.
    expect(logLines.join('')).not.toMatch(/signup\?invite|kapoor\.studio|@example\.com/);
  });

  it('an unclear answer (an error, a timeout) is unknown and never sent again by itself; a refusal is failed', async () => {
    mailer.mode = 'throw';
    expect(body(await invite(true)).email).toBe('unknown');
    mailer.mode = 'unknown';
    expect(body(await invite(true, 'gupta@example.com')).email).toBe('unknown');
    mailer.mode = 'failed';
    expect(body(await invite(true, 'patel@example.com')).email).toBe('failed');
    expect(mailer.sent).toHaveLength(3);
    clock.advance(60_000);
    await call('GET', '/dashboard/api/platform/invites');
    expect(mailer.sent).toHaveLength(3);
    const sends = (body(await call('GET', '/dashboard/api/platform/invites')).invites as { send: string }[]).map((v) => v.send).sort();
    expect(sends).toEqual(['failed', 'unknown', 'unknown']);
    expect(logLines.join('')).not.toContain('kapoor.studio');
  });

  it('without Gmail: Copy link still works, Send invite says not connected, Resend is refused', async () => {
    mount({ mailer: () => null });
    const b = body(await invite(false));
    expect(b.link).toContain('/signup?invite=');
    expect(body(await invite(true, 'other@example.com')).email).toBe('not_connected');
    expect((await call('POST', `/dashboard/api/platform/invites/${b.invite.id}/resend`)).status).toBe(409);
    expect(body(await call('GET', '/dashboard/api/platform/invites')).gmail).toEqual({ connected: false, from: null });
  });

  it('Copy link on a row makes a new link (the old one stops working); Resend emails a new one; Cancel ends it', async () => {
    const first = body(await invite(false));
    const copied = body(await call('POST', `/dashboard/api/platform/invites/${first.invite.id}/link`));
    expect(copied.link).not.toBe(first.link);
    expect(await inviteForSignup({ db, clock }, tokenOf(first.link))).toBeNull();
    const resent = body(await call('POST', `/dashboard/api/platform/invites/${first.invite.id}/resend`));
    expect(resent.email).toBe('sent');
    expect(mailer.sent).toHaveLength(1);
    expect(await inviteForSignup({ db, clock }, tokenOf(copied.link))).toBeNull();
    expect(await inviteForSignup({ db, clock }, tokenOf(mailer.sent[0]!.link))).not.toBeNull();
    const cancelled = body(await call('POST', `/dashboard/api/platform/invites/${first.invite.id}/cancel`));
    expect(cancelled.invite.status).toBe('cancelled');
    expect(await inviteForSignup({ db, clock }, tokenOf(mailer.sent[0]!.link))).toBeNull();
    expect((await call('POST', `/dashboard/api/platform/invites/${first.invite.id}/cancel`)).status).toBe(409);
  });

  it('Getting started: a member sees the checklist of their own workspace; someone with no workspace gets none', async () => {
    expect((await call('GET', '/dashboard/api/platform/onboarding', CUSTOMER)).status).toBe(404);
    const made = body(await invite(false));
    await redeemInvite({ db, clock }, { token: tokenOf(made.link), email: 'kapoor.studio@example.com' });
    // A member, but a session that names no workspace (every session before S4.8): none is chosen for it.
    expect((await call('GET', '/dashboard/api/platform/onboarding', CUSTOMER)).status).toBe(404);
    const r = await call('GET', '/dashboard/api/platform/onboarding', customerIn(made.invite.tenantId));
    expect(r.status).toBe(200);
    expect(body(r)).toMatchObject({ business: 'Kapoor Design Studio', status: 'onboarding', done: 0, total: 6, founderName: 'Rohit' });
    expect((body(r).steps as { state: string }[]).map((x) => x.state)).toEqual(['coming', 'coming', 'locked', 'locked', 'locked', 'locked']);
    // The founder has no membership in this customer: no checklist (and never the customer's content).
    expect((await call('GET', '/dashboard/api/platform/onboarding', FOUNDER)).status).toBe(404);
  });

  it('Getting started tells the Supervisor once, when WhatsApp and the key make the customer active', async () => {
    let pokes = 0;
    mount({ poke: () => void pokes++, probes: { state: async (_t, step) => (step === 'whatsapp' || step === 'key' ? 'done' : 'todo') } });
    const made = body(await invite(false));
    await redeemInvite({ db, clock }, { token: tokenOf(made.link), email: 'kapoor.studio@example.com' });
    const mine = customerIn(made.invite.tenantId);
    expect(body(await call('GET', '/dashboard/api/platform/onboarding', mine))).toMatchObject({ status: 'active', activated: true });
    expect(body(await call('GET', '/dashboard/api/platform/onboarding', mine))).toMatchObject({ status: 'active', activated: false });
    expect(pokes).toBe(1);
  });

  it('Customers: the founder only; pause and resume through the routes, each telling the Supervisor', async () => {
    let pokes = 0;
    mount({ poke: () => void pokes++ });
    expect((await call('GET', '/dashboard/api/platform/customers', CUSTOMER)).status).toBe(403);
    const made = body(await invite(false));
    await redeemInvite({ db, clock }, { token: tokenOf(made.link), email: 'kapoor.studio@example.com' });
    const list = body(await call('GET', '/dashboard/api/platform/customers'));
    const customers = (l: Record<string, unknown>) => (l.customers as { id: string; founder: boolean; status: string }[]).filter((c) => !c.founder);
    expect(customers(list)).toHaveLength(1); // on Postgres the founder's own business is listed too (P1 seeds it)
    const id = customers(list)[0]!.id;
    expect((await call('POST', `/dashboard/api/platform/customers/${id}/pause`, CUSTOMER)).status).toBe(403);
    expect(pokes).toBe(0);
    expect(customers(body(await call('POST', `/dashboard/api/platform/customers/${id}/pause`)))[0]!.status).toBe('paused');
    expect(pokes).toBe(1);
    expect((await call('POST', `/dashboard/api/platform/customers/${id}/pause`)).status).toBe(409); // refused: no poke
    expect(pokes).toBe(1);
    expect(customers(body(await call('POST', `/dashboard/api/platform/customers/${id}/resume`)))[0]!.status).toBe('onboarding');
    expect(pokes).toBe(2);
    expect((await call('POST', '/dashboard/api/platform/customers/00000000-0000-4000-8000-000000000000/pause')).status).toBe(404);
  });

  it("one person in two workspaces only ever gets the session's own, and none it is not a member of", async () => {
    if (onSqlite) await db.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)'); // the customer's own table (theirs on Postgres)
    // One open invite per address at a time: the first is used before the second is made.
    const a = body(await invite(false, 'kapoor.studio@example.com'));
    await redeemInvite({ db, clock }, { token: tokenOf(a.link), email: 'kapoor.studio@example.com' });
    clock.advance(60_000);
    const b = body(await call('POST', '/dashboard/api/platform/invites', FOUNDER, { business: 'Kapoor Events', email: 'kapoor.studio@example.com', send: false }));
    await redeemInvite({ db, clock }, { token: tokenOf(b.link), email: 'kapoor.studio@example.com' });
    expect((await membershipsFor(db, CUSTOMER.actor)).map((x) => x.tenantId).sort()).toEqual([a.invite.tenantId, b.invite.tenantId].sort());
    const asked: string[] = [];
    mount({ aiKeys: (id) => (asked.push(id), new AiKeys({ db: store.customerDb(id), platform: db, tenantId: id, dataKey: async () => Buffer.alloc(32, 7), tester: async () => 'ok', clock })) });

    // Each session gets its own workspace, whatever order the memberships come in.
    expect(body(await call('GET', '/dashboard/api/platform/onboarding', customerIn(b.invite.tenantId))).business).toBe('Kapoor Events');
    expect(body(await call('GET', '/dashboard/api/platform/onboarding', customerIn(a.invite.tenantId))).business).toBe('Kapoor Design Studio');
    await call('POST', '/dashboard/api/platform/ai-key', customerIn(b.invite.tenantId), { key: 'sk-ant-test-0000' });
    expect(asked).toEqual([b.invite.tenantId]);

    // A workspace the email is not a member of (another business, or the founder's) is refused, even named by the session.
    const other = body(await call('POST', '/dashboard/api/platform/invites', FOUNDER, { business: 'Gupta Events', email: 'gupta@example.com', send: false }));
    for (const t of [other.invite.tenantId, '00000000-0000-4000-8000-000000000001']) {
      expect((await call('GET', '/dashboard/api/platform/onboarding', customerIn(t))).status).toBe(404);
      expect(body(await call('POST', '/dashboard/api/platform/ai-key', customerIn(t), { key: 'sk-ant-test-0000' })).error.code).toBe('no_workspace');
    }
    expect(asked).toEqual([b.invite.tenantId]);
  });

  it("the customer's AI key: set and removed for their own workspace only, never echoed or logged", async () => {
    const FAKE = 'sk-ant-test-0000'; // an obvious fake; the tester below is a fake too (nothing calls Anthropic)
    if (onSqlite) await db.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)'); // the customer's own table (theirs on Postgres)
    const made = body(await invite(false));
    // Not signed up yet: no workspace. Signed up, but before S4 wires the runtimes in: no key store yet.
    expect(body(await call('POST', '/dashboard/api/platform/ai-key', CUSTOMER, { key: FAKE })).error.code).toBe('no_workspace');
    await redeemInvite({ db, clock }, { token: tokenOf(made.link), email: 'kapoor.studio@example.com' });
    const tenantId = (await membershipsFor(db, CUSTOMER.actor))[0]!.tenantId;
    const mine = customerIn(tenantId);
    expect(body(await call('POST', '/dashboard/api/platform/ai-key', mine, { key: FAKE })).error.code).toBe('not_ready');
    const asked: string[] = [];
    const restarts: string[] = [];
    mount({ restart: (id) => void restarts.push(id), aiKeys: (id) => (asked.push(id), new AiKeys({ db: store.customerDb(id), platform: db, tenantId: id, dataKey: async () => Buffer.alloc(32, 7), tester: async () => 'ok', clock })) });

    const nobody: OwnerContext = { actor: 'nobody@example.com', sessionId: 's-3', requestId: 'r3' };
    expect((await call('POST', '/dashboard/api/platform/ai-key', nobody, { key: FAKE })).status).toBe(404);
    expect(body(await call('POST', '/dashboard/api/platform/ai-key', FOUNDER, { key: FAKE })).error.code).toBe('founder_env');
    // The customer comes from the session, never the body.
    expect((await call('POST', '/dashboard/api/platform/ai-key', mine, { key: FAKE, tenantId: '00000000-0000-4000-8000-000000000001' })).status).toBe(400);
    const bad = await call('POST', '/dashboard/api/platform/ai-key', mine, { key: 'not-a-key-zzz' });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain('zzz');
    expect(restarts).toEqual([]); // refused: the runtime is left as it is

    const set = await call('POST', '/dashboard/api/platform/ai-key', mine, { key: FAKE });
    expect(set.status).toBe(200);
    expect(body(set)).toEqual({ aiKey: 'configured' });
    expect(asked.every((id) => id === tenantId)).toBe(true);
    expect(restarts).toEqual([tenantId]); // the key is in: started again as a full runtime
    expect(body(await call('POST', '/dashboard/api/platform/ai-key/remove', mine))).toEqual({ aiKey: 'missing' });
    expect(restarts).toEqual([tenantId, tenantId]); // removed: back to a setup shell
    expect(logLines.join('\n')).not.toContain(FAKE);
  });

  it('refuses a bad body, a bad address, an unknown invite, and the daily limit, with plain messages', async () => {
    for (const b of [{}, { business: 'x', email: 'x@example.com' }, { business: 'x', email: 'x@example.com', send: 'yes' }, { business: 'x', email: 'x@example.com', send: false, extra: 1 }, null]) {
      expect((await call('POST', '/dashboard/api/platform/invites', FOUNDER, b)).status).toBe(400);
    }
    expect((await call('POST', '/dashboard/api/platform/invites', FOUNDER, { business: 'x', email: 'nope', send: false })).status).toBe(400);
    expect((await call('POST', '/dashboard/api/platform/invites/00000000-0000-4000-8000-000000000000/cancel')).status).toBe(404);
    for (let i = 0; i < 20; i++) await call('POST', '/dashboard/api/platform/invites', FOUNDER, { business: `B${i}`, email: `b${i}@example.com`, send: false });
    const over = await call('POST', '/dashboard/api/platform/invites', FOUNDER, { business: 'More', email: 'more@example.com', send: false });
    expect(over.status).toBe(429);
    expect((over.body as { error: { message: string } }).error.message).toBe('At most 20 invite links a day. Try again tomorrow.');
  });
});
