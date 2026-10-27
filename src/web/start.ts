import type { Env } from '../config/env.ts';
import { systemClock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { createWebServer } from './server.ts';
import type { WebServer } from './server.ts';

/**
 * The owner dashboard (D1), started by main.ts only when DASHBOARD_ENABLED is true, after app.start(). It listens on
 * 127.0.0.1 only. A dashboard that cannot start (for example, the port is taken) is logged by its error code only and
 * resolves to undefined: it never stops the agent.
 */
export async function startDashboard(o: { env: Pick<Env, 'DASHBOARD_PORT'>; log: Logger; control: object }): Promise<WebServer | undefined> {
  const { env, log } = o;
  const web = createWebServer({ control: o.control, env, log, clock: systemClock });
  try {
    const { port } = await web.start();
    log.info(`dashboard on http://127.0.0.1:${port}/dashboard`);
    return web;
  } catch (err) {
    log.error({ code: (err as { code?: unknown }).code ?? 'unknown' }, 'dashboard did not start; the agent carries on without it');
    return undefined;
  }
}
