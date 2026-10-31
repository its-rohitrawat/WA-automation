import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { customerSessionStarter } from '../../src/web/customerSession.ts';
import type { Db } from '../../src/store/db.ts';
import type { RequestContext } from '../../src/web/router.ts';
import { seededDb } from '../helpers/db.ts';

// A new customer owner's session from the sign-up (S4.8): on Postgres only; the audit row first, in the customer's own
// Db, then the session; a new id every time (no fixation); the owner's cookie flags.

const CUSTOMER = '00000000-0000-4000-8000-0000000000c2';
const EMAIL = 'customer@example.com';
const opened: Db[] = [];
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
});

function ctxWith(cookie?: string): RequestContext & { headers: Record<string, unknown> } {
  const headers: Record<string, unknown> = {};
  const res = { setHeader: (k: string, v: unknown) => void (headers[k.toLowerCase()] = v) } as unknown as ServerResponse;
  const req = { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Edg/130', ...(cookie ? { cookie } : {}) } } as unknown as IncomingMessage;
  return { req, res, params: {}, url: new URL('http://x/signup/callback'), requestId: 'abcdef123456', headers };
}

async function setup(o: { failCreate?: boolean } = {}) {
  const customerDb = await seededDb();
  opened.push(customerDb);
  const auditRows = async () => (await customerDb.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'Signed in'"))!.n;
  const log: string[] = [];
  let n = 0;
  const sessions = {
    create: async (email: string, _label?: string, _q?: unknown, tenantId?: string) => {
      log.push(`create ${email} ${tenantId} after ${await auditRows()} audit row(s)`);
      if (o.failCreate) throw new Error('platform Db down');
      n += 1;
      return { id: `${'S'.repeat(42)}${n}`, csrf: 'c' };
    },
    destroy: async (id: string) => void log.push(`destroy ${id}`),
  };
  const tenants: string[] = [];
  const start = customerSessionStarter({
    customerDb: (id) => {
      tenants.push(id);
      return customerDb;
    },
    sessions,
    secureFor: () => true,
  });
  return { start, log, tenants, auditRows };
}

describe('customerSessionStarter (S4.8)', () => {
  it('SQLite (no customer Db): starts none and says false, writing nothing', async () => {
    const log: string[] = [];
    const start = customerSessionStarter({
      customerDb: undefined,
      sessions: { create: async () => { log.push('create'); return { id: 'x', csrf: 'y' }; }, destroy: async () => void log.push('destroy') },
      secureFor: () => true,
    });
    const ctx = ctxWith();
    expect(await start(ctx, { email: EMAIL, tenantId: CUSTOMER })).toBe(false);
    expect(log).toEqual([]);
    expect(ctx.headers['set-cookie']).toBeUndefined();
  });

  it('Postgres: the audit row first in the customer’s own Db, then the session for that customer, and the owner’s cookie', async () => {
    const { start, log, tenants, auditRows } = await setup();
    const ctx = ctxWith();
    expect(await start(ctx, { email: EMAIL, tenantId: CUSTOMER })).toBe(true);
    expect(tenants).toEqual([CUSTOMER]);
    expect(log).toEqual([`create ${EMAIL} ${CUSTOMER} after 1 audit row(s)`]);
    expect(await auditRows()).toBe(1);
    const cookie = String(ctx.headers['set-cookie']);
    expect(cookie).toMatch(/^wa_session=S{42}1;/);
    for (const flag of ['HttpOnly', 'SameSite=Lax', 'Path=/dashboard', 'Secure']) expect(cookie).toContain(flag);
  });

  it('a new session id at every sign-in: the session this browser had is ended first (no fixation)', async () => {
    const { start, log } = await setup();
    const earlier = 'E'.repeat(43);
    const first = ctxWith(`wa_session=${earlier}`);
    await start(first, { email: EMAIL, tenantId: CUSTOMER });
    const second = ctxWith(`wa_session=${String(first.headers['set-cookie']).split(';')[0]!.split('=')[1]}`);
    await start(second, { email: EMAIL, tenantId: CUSTOMER });
    expect(log.filter((l) => l.startsWith('destroy'))).toEqual([`destroy ${earlier}`, `destroy ${'S'.repeat(42)}1`]);
    expect(String(second.headers['set-cookie'])).toMatch(/^wa_session=S{42}2;/);
  });

  it('a failed session write leaves the audit row (an attempt) and no cookie', async () => {
    const { start, auditRows } = await setup({ failCreate: true });
    const ctx = ctxWith();
    await expect(start(ctx, { email: EMAIL, tenantId: CUSTOMER })).rejects.toThrow('platform Db down');
    expect(await auditRows()).toBe(1);
    expect(ctx.headers['set-cookie']).toBeUndefined();
  });
});
