import type { IncomingMessage } from 'node:http';
import type { Env } from '../config/env.ts';
import type { Db } from '../store/db.ts';
import { systemClock } from '../util/clock.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { AuditLog } from './audit.ts';
import { ACTION_LIMIT, createGuard, RateLimiter, SIGNIN_LIMIT } from './guard.ts';
import type { Guard } from './guard.ts';
import { googleCodeExchanger, googleIdVerifier } from './oidc.ts';
import { secureRequest } from './origin.ts';
import type { CodeExchanger, IdTokenVerifier } from './oidc.ts';
import { auditedWrite, registerAuthRoutes } from './routes/auth.ts';
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
}

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
  /** The platform tables' Db (decision D1), which holds web_sessions on Postgres. Defaults to db (SQLite: the same file). */
  platformDb?: Db;
  log: Logger;
  control: object;
  clock?: Clock;
  /** Registers the agent's routes after sign-in's, before the server listens. A throw stops the dashboard only. */
  mount?: (m: DashboardMount) => void;
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
  const guard = createGuard({ sessions, ownerEmails: env.DASHBOARD_OWNER_EMAILS, port, ...publicUrl });
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
    exchange:
      o.google?.exchange ??
      googleCodeExchanger({ clientId, clientSecret, ...(o.google?.tokenUrl === undefined ? {} : { tokenUrl: o.google.tokenUrl }) }),
    verifier: o.google?.verifier ?? googleIdVerifier(clientId),
    signinLimiter: new RateLimiter({ ...SIGNIN_LIMIT, clock }),
    actionLimiter: actions,
  });
  try {
    o.mount?.({ router: web.router, guard, sessions, audit, actions, secureFor: secureRequest({ ...publicUrl, port }), port });
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
