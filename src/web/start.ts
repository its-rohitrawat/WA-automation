import type { Env } from '../config/env.ts';
import { tx } from '../store/db.ts';
import type { Db } from '../store/db.ts';
import { systemClock } from '../util/clock.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { AuditLog } from './audit.ts';
import { ACTION_LIMIT, createGuard, RateLimiter, SIGNIN_LIMIT } from './guard.ts';
import { googleCodeExchanger, googleIdVerifier } from './oidc.ts';
import type { CodeExchanger, IdTokenVerifier } from './oidc.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { createWebServer } from './server.ts';
import type { WebServer } from './server.ts';
import { SessionStore } from './sessions.ts';

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
  /** The tracker database (web_sessions and audit_log live there, migration v9). */
  db: Db;
  log: Logger;
  control: object;
  clock?: Clock;
  /** Tests only: a fake Google (code exchange and ID-token check). */
  google?: { exchange: CodeExchanger; verifier: IdTokenVerifier };
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
  const sessions = new SessionStore(o.db, clock);
  const web = createWebServer({ control: o.control, env, log, clock, sessions });
  const port = () => web.address()?.port;
  const publicUrl = env.DASHBOARD_PUBLIC_URL === undefined ? {} : { publicUrl: env.DASHBOARD_PUBLIC_URL };
  const guard = createGuard({ sessions, ownerEmails: env.DASHBOARD_OWNER_EMAILS, port, ...publicUrl });
  registerAuthRoutes({
    router: web.router,
    sessions,
    guard,
    audit: new AuditLog(o.db, clock),
    log,
    clock,
    ownerEmails: env.DASHBOARD_OWNER_EMAILS,
    clientId,
    ...publicUrl,
    port,
    tx: <T>(fn: () => T): T => tx(o.db, fn),
    exchange: o.google?.exchange ?? googleCodeExchanger({ clientId, clientSecret }),
    verifier: o.google?.verifier ?? googleIdVerifier(clientId),
    signinLimiter: new RateLimiter({ ...SIGNIN_LIMIT, clock }),
    actionLimiter: new RateLimiter({ ...ACTION_LIMIT, clock }),
  });
  try {
    const { port: bound } = await web.start();
    log.info(`dashboard on http://127.0.0.1:${bound}/dashboard`);
    return web;
  } catch (err) {
    log.error({ code: (err as { code?: unknown }).code ?? 'unknown' }, 'dashboard did not start; the agent carries on without it');
    return undefined;
  }
}
