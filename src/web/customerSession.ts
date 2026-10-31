import type { IncomingMessage } from 'node:http';
import type { Db } from '../store/db.ts';
import { systemClock } from '../util/clock.ts';
import { AuditLog } from './audit.ts';
import { parseCookies } from './http.ts';
import { browserLabel } from './oidc.ts';
import type { RequestContext } from './router.ts';
import { SESSION_COOKIE, sessionCookie, type SessionStore } from './sessions.ts';

// A customer owner's dashboard session (S4.8), on Postgres only: started by the sign-up (the invite just redeemed) and
// by the ordinary dashboard sign-in for a member (F7). The sign-in's audit row goes first, in the customer's own Db,
// then the session on the platform Db: the two cannot share a transaction, so a failed session write leaves an audit
// row for an attempt (the safe side). A new session id every time: a session this browser had is ended first.

export interface CustomerSessionDeps {
  /** Each customer's own Db; undefined (SQLite) means no customer session is ever made. */
  customerDb: ((tenantId: string) => Db) | undefined;
  sessions: Pick<SessionStore, 'create' | 'destroy'>;
}

/**
 * Makes the session (no cookie); null without customerDb (SQLite). `from`: a switch from another of the member's
 * workspaces, whose audit log says the member left it (neither workspace is named in the other's log).
 */
export function customerSessionCreator(
  o: CustomerSessionDeps,
): (ctx: RequestContext, s: { email: string; tenantId: string; from?: string }) => Promise<{ id: string; csrf: string } | null> {
  return async (ctx, s) => {
    if (!o.customerDb) return null;
    const label = browserLabel(typeof ctx.req.headers['user-agent'] === 'string' ? ctx.req.headers['user-agent'] : undefined);
    if (s.from !== undefined) {
      await new AuditLog(o.customerDb(s.from), systemClock)
        .record({ actor: s.email, event: 'Signed out', kind: 'auth', detail: `${label}, switched to another workspace`, requestId: ctx.requestId });
    }
    await new AuditLog(o.customerDb(s.tenantId), systemClock).record({
      actor: s.email, event: 'Signed in', kind: 'auth', detail: s.from === undefined ? label : `${label}, switched from another workspace`, requestId: ctx.requestId,
    });
    const earlier = parseCookies(typeof ctx.req.headers.cookie === 'string' ? ctx.req.headers.cookie : undefined)[SESSION_COOKIE];
    if (earlier !== undefined) await o.sessions.destroy(earlier);
    return o.sessions.create(s.email, label, undefined, s.tenantId);
  };
}

/**
 * The sign-up's startSession: the session and its cookie (the owner's flags: HttpOnly, SameSite, Secure over https),
 * then true; false on SQLite, where the sign-up sends the new customer to the waiting page.
 */
export function customerSessionStarter(
  o: CustomerSessionDeps & { secureFor: (req: IncomingMessage) => boolean },
): (ctx: RequestContext, s: { email: string; tenantId: string }) => Promise<boolean> {
  const create = customerSessionCreator(o);
  return async (ctx, s) => {
    const created = await create(ctx, s);
    if (!created) return false;
    ctx.res.setHeader('Set-Cookie', sessionCookie(created.id, { secure: o.secureFor(ctx.req) }));
    return true;
  };
}
