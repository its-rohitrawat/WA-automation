import type { IncomingMessage } from 'node:http';
import type { Env } from '../config/env.ts';
import type { Db } from '../store/db.ts';
import { systemClock } from '../util/clock.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { membershipsFor } from '../platform/store.ts';
import { AuditLog } from './audit.ts';
import { ACTION_LIMIT, createGuard, RateLimiter, SIGNIN_LIMIT } from './guard.ts';
import type { Guard } from './guard.ts';
import { googleCodeExchanger, googleIdVerifier } from './oidc.ts';
import { secureRequest } from './origin.ts';
import type { CodeExchanger, IdTokenVerifier } from './oidc.ts';
import { FOUNDER_TENANT_ID } from '../config/env.ts';
import { tenantContext } from '../runtime/context.ts';
import { HttpError } from './http.ts';
import type { OwnerSession } from './guard.ts';
import { createRouter, type RequestContext } from './router.ts';
import { auditedWrite, registerAuthRoutes, type AuditedWrite } from './routes/auth.ts';
import { customerSessionCreator } from './customerSession.ts';
import { createWebServer } from './server.ts';
import type { Router } from './router.ts';
import type { WebServer } from './server.ts';
import { SessionStore } from './sessions.ts';
import { SITE_DIR } from './site.ts';

/** What the agent's own routes are registered with (src/web/mountRoutes.ts): D1's guard, store and limits. */
export interface DashboardMount {
  router: Router;
  guard: Guard;
  sessions: SessionStore;
  audit: AuditLog;
  /** The one ACTION_LIMIT limiter: sign-out and every other change count against the same 30 a minute. */
  actions: RateLimiter;
  /** Whether cookies set for a request carry Secure (only over the https public address). */
  secureFor: (req: IncomingMessage) => boolean;
  /** The bound port, once listening. */
  port: () => number | undefined;
  /** A session change with its audit row, for this mount's customer (auditedWrite: its Db, then the platform Db). */
  audited: AuditedWrite;
}

/** A running customer's dashboard routes (Phase B 4): its own Db, its audit log and the mount its runtime gives. */
export interface TenantRouteEntry {
  db: Db;
  audit: AuditLog;
  mount: (m: DashboardMount) => void;
}

/** The customers whose runtimes give dashboard routes now (the Supervisor keeps it): one entry per running customer. */
export interface TenantRoutes {
  get(tenantId: string): TenantRouteEntry | undefined;
}

/** Routes every member reaches on the founder's runtime: the platform's own (they check the role themselves) and the sign-up. */
const sharedRoute = (pattern: string): boolean => pattern.startsWith('/dashboard/api/platform/') || pattern === '/signup' || pattern.startsWith('/signup/');

export type DashboardEnv = Pick<
  Env,
  'DASHBOARD_PORT' | 'DASHBOARD_PUBLIC_URL' | 'DASHBOARD_OWNER_EMAILS' | 'DASHBOARD_GOOGLE_CLIENT_ID' | 'DASHBOARD_GOOGLE_CLIENT_SECRET'
>;

/**
 * The owner dashboard (D1), started by main.ts only when DASHBOARD_ENABLED is true, after app.start(). It listens on
 * 127.0.0.1 only. A dashboard that cannot start (for example, the port is taken) is logged by its error code only and
 * resolves to undefined: it never stops the agent.
 */
export async function startDashboard(o: {
  env: DashboardEnv;
  /** The tracker database (audit_log; on SQLite web_sessions too, migration v9). */
  db: Db;
  /** The shell shows the platform screens (GET /dashboard/api/me says so): the runtime mounted them. */
  platform?: boolean;
  /** The platform tables' Db (decision D1), which holds web_sessions on Postgres. Defaults to db (SQLite: the same file). */
  platformDb?: Db;
  /**
   * Customer sessions are possible (S4.8: Postgres, with the platform on): the guard then accepts a customer owner's
   * session while its membership holds. Otherwise only the founder's.
   */
  customerSessions?: boolean;
  /** Each customer's own Db (customerDbsOf): a member's dashboard sign-in writes its audit row there first (F7). */
  customerDb?: (tenantId: string) => Db;
  log: Logger;
  control: object;
  clock?: Clock;
  /** Registers the agent's routes after sign-in's, before the server listens. A throw stops the dashboard only. */
  mount?: (m: DashboardMount) => void;
  /**
   * Each running customer's own routes (Phase B 4). A request with a customer's session is sent to that customer's
   * routes (503 workspace_starting while it has none); the founder's, and one with no session, to the founder's.
   */
  tenants?: TenantRoutes;
  /** The audit log the agent also writes to (phone links, uploads); one is made on db when not given. */
  audit?: AuditLog;
  /**
   * Tests only: a fake Google. `exchange` and `verifier` replace the production ones; `tokenUrl` points the production
   * code exchanger (with this env's client id and secret) at a local endpoint instead of Google's.
   */
  google?: { exchange?: CodeExchanger; verifier?: IdTokenVerifier; tokenUrl?: string };
}): Promise<WebServer | undefined> {
  const { env, log } = o;
  const clock = o.clock ?? systemClock;
  const clientId = env.DASHBOARD_GOOGLE_CLIENT_ID;
  const clientSecret = env.DASHBOARD_GOOGLE_CLIENT_SECRET;
  // parseEnv already refuses DASHBOARD_ENABLED without these; checked again so a half-configured dashboard never runs.
  if (clientId === undefined || clientSecret === undefined || env.DASHBOARD_OWNER_EMAILS.length === 0) {
    log.error({ code: 'config' }, 'dashboard not started: DASHBOARD_GOOGLE_CLIENT_ID, DASHBOARD_GOOGLE_CLIENT_SECRET and DASHBOARD_OWNER_EMAILS are required');
    return undefined;
  }
  const platformDb = o.platformDb ?? o.db;
  const sessions = new SessionStore(platformDb, clock);
  const web = createWebServer({ control: o.control, env, log, clock, sessions, siteDir: SITE_DIR });
  const port = () => web.address()?.port;
  const publicUrl = env.DASHBOARD_PUBLIC_URL === undefined ? {} : { publicUrl: env.DASHBOARD_PUBLIC_URL };
  // A customer's memberships, from the platform Db: a customer that was removed no longer counts (Postgres's tenants
  // allow 'removed', which TenantStatus does not name yet, so it is compared as text).
  const memberships = async (email: string) =>
    (await membershipsFor(platformDb, email)).filter((m) => (m.status as string) !== 'removed').map((m) => m.tenantId);
  const guard = createGuard({ sessions, ownerEmails: env.DASHBOARD_OWNER_EMAILS, port, ...publicUrl, ...(o.customerSessions ? { memberships } : {}) });
  const createCustomerSession = customerSessionCreator({ customerDb: o.customerDb, sessions });
  const audit = o.audit ?? new AuditLog(o.db, clock);
  const actions = new RateLimiter({ ...ACTION_LIMIT, clock });
  registerAuthRoutes({
    router: web.router,
    sessions,
    guard,
    audit,
    log,
    clock,
    ownerEmails: env.DASHBOARD_OWNER_EMAILS,
    clientId,
    ...publicUrl,
    port,
    audited: auditedWrite(o.db, platformDb),
    platform: o.platform === true,
    // A member signs in to its first live workspace (a chooser for several comes later); never the founder's.
    ...(o.customerSessions && o.customerDb ? {
      memberSignIn: async (ctx: RequestContext, who: { email: string }) => {
        const tenantId = (await memberships(who.email)).find((id) => id !== FOUNDER_TENANT_ID);
        return tenantId ? createCustomerSession(ctx, { email: who.email, tenantId }) : null;
      },
    } : {}),
    exchange:
      o.google?.exchange ??
      googleCodeExchanger({ clientId, clientSecret, ...(o.google?.tokenUrl === undefined ? {} : { tokenUrl: o.google.tokenUrl }) }),
    verifier: o.google?.verifier ?? googleIdVerifier(clientId),
    signinLimiter: new RateLimiter({ ...SIGNIN_LIMIT, clock }),
    actionLimiter: actions,
  });
  const secureFor = secureRequest({ ...publicUrl, port });
  const mountFor = (router: Router, db: Db, auditLog: AuditLog): DashboardMount => ({
    router, guard, sessions, audit: auditLog, actions, secureFor, port, audited: auditedWrite(db, platformDb),
  });
  try {
    // The founder's routes go on a router of their own; each pattern is then registered once on the server's router,
    // sending each request to the routes of its session's customer.
    const founderRoutes = createRouter();
    o.mount?.(mountFor(founderRoutes, o.db, audit));
    const customers = new Map<string, { entry: TenantRouteEntry; router: Router }>();
    const routesOf = (tenantId: string): Router | undefined => {
      const entry = o.tenants?.get(tenantId);
      if (!entry) {
        customers.delete(tenantId);
        return undefined;
      }
      const known = customers.get(tenantId);
      if (known?.entry === entry) return known.router;
      const router = createRouter(); // a restarted runtime gives a new entry: its routes are mounted again
      entry.mount(mountFor(router, entry.db, entry.audit));
      customers.set(tenantId, { entry, router });
      return router;
    };
    for (const r of founderRoutes.routes()) {
      const shared = sharedRoute(r.pattern);
      const dispatch = async (ctx: RequestContext): Promise<void> => {
        let routes: Router = founderRoutes;
        let customer: string | undefined;
        if (!shared) {
          let s: OwnerSession | undefined;
          try {
            s = await guard.requireSession(ctx.req);
          } catch (err) {
            if (!(err instanceof HttpError) || err.status !== 401) throw err; // a membership that cannot be checked: 503
          }
          // A running customer's own routes. One whose runtime is not running stays on the founder's, which refuse any
          // other customer's session by scope (503 workspace_starting, or a navigation's redirect home).
          if (s && s.tenantId !== FOUNDER_TENANT_ID) {
            const own = routesOf(s.tenantId);
            if (own) customer = s.tenantId;
            routes = own ?? founderRoutes;
          }
        }
        const hit = routes.match(ctx.req.method ?? 'GET', ctx.url.pathname);
        if (!hit) throw new HttpError(404, 'not_found', 'Not found.');
        // A customer's request runs in its context (isolation review F2): whatever it starts (a phone link's socket, its
        // timers) carries the customer's id, so a stray throw there restarts that customer alone, never the process.
        if (customer) await tenantContext.run(customer, () => hit.handler({ ...ctx, params: hit.params }));
        else await hit.handler({ ...ctx, params: hit.params });
      };
      if (r.method === 'GET') web.router.get(r.pattern, dispatch);
      else web.router.post(r.pattern, dispatch);
    }
  } catch (err) {
    log.error({ err }, 'dashboard not started: its routes could not be set up; the agent carries on without it');
    return undefined;
  }
  try {
    const { port: bound } = await web.start();
    log.info(`dashboard on http://127.0.0.1:${bound}/dashboard`);
    return web;
  } catch (err) {
    log.error({ code: (err as { code?: unknown }).code ?? 'unknown' }, 'dashboard did not start; the agent carries on without it');
    return undefined;
  }
}
