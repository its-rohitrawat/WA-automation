import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inviteForSignup } from '../../src/platform/invites.ts';
import type { InviteEmail, InviteMailer, MailOutcome } from '../../src/platform/mailer.ts';
import { ensurePlatformSchema } from '../../src/platform/schema.ts';
import { SqliteDb } from '../../src/store/engine/sqlite.ts';
import { manualClock, type ManualClock } from '../../src/util/clock.ts';
import { createLogger } from '../../src/util/logger.ts';
import type { ApiResult, OwnerContext } from '../../src/web/routes/context.ts';
import { mountPlatformRoutes, type PlatformMount, type PlatformRouteDeps } from '../../src/web/routes/platform.ts';
import type { RequestContext } from '../../src/web/router.ts';

// The platform routes through a stand-in for the dashboard's registrars (mountRoutes.ts adds the owner guard, Origin,
// CSRF and the action limit around every change). A fake mailer only: nothing here reaches Gmail or Google.

const FOUNDER: OwnerContext = { actor: 'founder@example.com', sessionId: 's-hash', requestId: 'a1b2c3d4e5f6' };
const CUSTOMER: OwnerContext = { actor: 'kapoor.studio@example.com', sessionId: 's-hash-2', requestId: 'f6e5d4c3b2a1' };
const SITE = 'https://agent.example.com';

/** Records every email; answers as told. `stateDuring`: the invite's send state when Gmail is asked. */
class FakeMailer implements InviteMailer {
  readonly from = 'founder@example.com';
  sent: InviteEmail[] = [];
  mode: 'ok' | 'throw' | 'failed' | 'unknown' = 'ok';
  stateDuring: string[] = [];
  readonly db: SqliteDb;
  constructor(db: SqliteDb) {
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

let db: SqliteDb;
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
  db = SqliteDb.open(':memory:');
  await ensurePlatformSchema(db);
  clock = manualClock('2026-10-29T06:00:00.000Z');
  mailer = new FakeMailer(db);
  logLines = [];
  mount();
});
afterEach(async () => {
  await db.close();
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
