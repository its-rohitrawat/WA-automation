import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { FOUNDER_TENANT_ID } from '../../src/config/env.ts';
import { createGuard, type GuardDeps } from '../../src/web/guard.ts';
import { HttpError } from '../../src/web/http.ts';
import type { Session } from '../../src/web/sessions.ts';

// The member guard (S4.8): who a session is comes from the session record and the owner list, plus the memberships on
// the platform Db for a customer. It fails closed: an unknown or removed membership is ended (401), a lookup that fails
// is a 503 (never the founder), and requireOwner refuses a customer with a 403 and keeps its session.

const OWNER = 'owner@example.com';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER = '00000000-0000-4000-8000-0000000000c2';
const OTHER = '00000000-0000-4000-8000-0000000000c3';
const ID = 'A'.repeat(43);

function setup(session: Partial<Session> & { email: string; tenantId: string }, memberships?: GuardDeps['memberships']) {
  let live = true;
  const destroyed: string[] = [];
  const guard = createGuard({
    sessions: {
      get: async (id) => (live && id === ID ? { csrfHash: 'x', createdAt: 't', expiresAt: 't', ...session } : undefined),
      destroy: async (id) => {
        destroyed.push(id);
        live = false;
      },
    },
    ownerEmails: [OWNER],
    port: () => 8787,
    ...(memberships ? { memberships } : {}),
  });
  const req = { headers: { cookie: `wa_session=${ID}` } } as unknown as IncomingMessage;
  return { guard, req, destroyed };
}

async function status(p: Promise<unknown>): Promise<number | 'ok'> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof HttpError) return e.status;
    throw e;
  }
}

describe('requireSession and requireOwner (S4.8)', () => {
  it('the founder: an owner-list email in the founder’s workspace; both pass, role founder', async () => {
    const { guard, req } = setup({ email: OWNER, tenantId: FOUNDER_TENANT_ID }, async () => []);
    expect((await guard.requireSession(req)).role).toBe('founder');
    expect((await guard.requireOwner(req)).role).toBe('founder');
  });

  it('a customer owner whose membership holds: requireSession passes (role owner); requireOwner is 403 and keeps it', async () => {
    const { guard, req, destroyed } = setup({ email: CUSTOMER_EMAIL, tenantId: CUSTOMER }, async () => [CUSTOMER]);
    const s = await guard.requireSession(req);
    expect([s.role, s.tenantId]).toEqual(['owner', CUSTOMER]);
    expect(await status(guard.requireOwner(req))).toBe(403);
    expect(destroyed).toEqual([]);
    expect((await guard.requireSession(req)).role).toBe('owner'); // still signed in
  });

  it('a membership removed, or one for another workspace, ends the session (401)', async () => {
    for (const tenants of [[], [OTHER]]) {
      const { guard, req, destroyed } = setup({ email: CUSTOMER_EMAIL, tenantId: CUSTOMER }, async () => tenants);
      expect(await status(guard.requireSession(req)), JSON.stringify(tenants)).toBe(401);
      expect(destroyed).toEqual([ID]);
    }
  });

  it('the founder’s workspace is the owner list’s only: a membership there never makes anyone the founder', async () => {
    // An email taken off DASHBOARD_OWNER_EMAILS, even with a membership row naming the founder's workspace.
    const { guard, req, destroyed } = setup({ email: CUSTOMER_EMAIL, tenantId: FOUNDER_TENANT_ID }, async () => [FOUNDER_TENANT_ID]);
    expect(await status(guard.requireSession(req))).toBe(401);
    expect(destroyed).toEqual([ID]);
  });

  it('an owner-list email in a customer’s workspace is not the founder there: only a membership lets it in, as owner', async () => {
    const without = setup({ email: OWNER, tenantId: CUSTOMER }, async () => []);
    expect(await status(without.guard.requireSession(without.req))).toBe(401);
    const withIt = setup({ email: OWNER, tenantId: CUSTOMER }, async () => [CUSTOMER]);
    expect((await withIt.guard.requireSession(withIt.req)).role).toBe('owner');
    expect(await status(withIt.guard.requireOwner(withIt.req))).toBe(403);
  });

  it('without the membership lookup (SQLite, or the platform off) a customer session is never accepted', async () => {
    const { guard, req, destroyed } = setup({ email: CUSTOMER_EMAIL, tenantId: CUSTOMER });
    expect(await status(guard.requireSession(req))).toBe(401);
    expect(destroyed).toEqual([ID]);
  });

  it('a membership lookup that fails (the platform Db down) is a 503: never the founder, and the session is kept', async () => {
    const { guard, req, destroyed } = setup({ email: CUSTOMER_EMAIL, tenantId: CUSTOMER }, async () => {
      throw new Error('connection refused');
    });
    expect(await status(guard.requireSession(req))).toBe(503);
    expect(await status(guard.requireOwner(req))).toBe(503);
    expect(destroyed).toEqual([]);
  });

  it('no cookie, or an unknown session: 401', async () => {
    const { guard } = setup({ email: OWNER, tenantId: FOUNDER_TENANT_ID }, async () => []);
    expect(await status(guard.requireSession({ headers: {} } as unknown as IncomingMessage))).toBe(401);
    expect(await status(guard.requireSession({ headers: { cookie: `wa_session=${'B'.repeat(43)}` } } as unknown as IncomingMessage))).toBe(401);
  });
});
