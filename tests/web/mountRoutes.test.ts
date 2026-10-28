import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { UptimeLog } from '../../src/health/uptimeLog.ts';
import { manualClock } from '../../src/util/clock.ts';
import { silentLogger } from '../../src/util/logger.ts';
import { mountAgentRoutes, type AgentRoutesDeps } from '../../src/web/mountRoutes.ts';
import { secureRequest } from '../../src/web/origin.ts';
import type { WebServer } from '../../src/web/server.ts';
import { SessionStore } from '../../src/web/sessions.ts';
import { startDashboard } from '../../src/web/start.ts';
import { NOW, seededDb } from '../helpers/db.ts';

// The combined dashboard (stage 2): the agent's routes and c7's handlers mounted through startDashboard, on the guard,
// session store and action limiter it builds. A request is checked by that one guard whichever route it reaches.

const PUBLIC = 'https://dash.example.com';
const OWNER = 'owner@example.com';
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

/** Only what the requests below reach is real; the rest is never called. */
function deps(db: ReturnType<typeof seededDb>, clock: ReturnType<typeof manualClock>, started: string[]): AgentRoutesDeps {
  const never = {} as never;
  return {
    db, clock, log: silentLogger(), control: never, spend: new SpendGuard({ db, clock, capUsd: 10 }) as never, health: never,
    voiceLocal: true, uptime: { log: new UptimeLog(db, clock) }, ownerEmails: [OWNER], settings: never,
    groups: never, clients: never, google: never, actions: never,
    links: { start: (o: { target: string }) => (started.push(o.target), { id: 'a'.repeat(32), target: o.target }) } as never,
  };
}

async function boot() {
  const db = seededDb();
  const clock = manualClock(NOW);
  const started: string[] = [];
  const web = await startDashboard({
    env: {
      DASHBOARD_PORT: 0, DASHBOARD_PUBLIC_URL: PUBLIC, DASHBOARD_OWNER_EMAILS: [OWNER],
      DASHBOARD_GOOGLE_CLIENT_ID: 'client-id', DASHBOARD_GOOGLE_CLIENT_SECRET: 'client-secret',
    },
    db, log: silentLogger(), control: {}, clock,
    google: { exchange: () => Promise.reject(new Error('no Google')), verifier: () => Promise.reject(new Error('no Google')) },
    mount: (m) => mountAgentRoutes(m, deps(db, clock, started)),
  });
  servers.push(web!);
  const port = web!.address()!.port;
  const session = new SessionStore(db, clock).create(OWNER);
  const post = (path: string, h: Record<string, string>, body = '{}') =>
    new Promise<{ status: number; cookie: string }>((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { cookie: `wa_session=${session.id}`, 'content-type': 'application/json', ...h } }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, cookie: String(res.headers['set-cookie'] ?? '') }));
      });
      r.on('error', reject);
      r.end(body);
    });
  return { port, session, post, started };
}

describe('the combined dashboard routes', () => {
  it('a change with the public https Origin and the CSRF token passes; a foreign Origin or no token gets 403', async () => {
    const { post, session, started } = await boot();
    const body = JSON.stringify({ target: 'founder', confirm: true });
    const path = '/dashboard/api/whatsapp/link/start'; // c7's handler, mounted here
    expect((await post(path, { origin: 'https://evil.example', 'x-csrf-token': session.csrf }, body)).status).toBe(403);
    expect((await post(path, { origin: PUBLIC }, body)).status).toBe(403);
    expect(started).toEqual([]);
    expect((await post(path, { origin: PUBLIC, 'x-csrf-token': session.csrf }, body)).status).toBe(200);
    expect(started).toEqual(['founder']);
  });

  it('the same guard covers the agent\'s own routes, and Secure follows the address the browser used', async () => {
    const { post, session } = await boot();
    const path = '/dashboard/api/session/signout-everywhere';
    expect((await post(path, { origin: 'https://evil.example', 'x-csrf-token': session.csrf })).status).toBe(403);
    // Over the tunnel: the public Host, so the cleared cookie is Secure.
    const viaTunnel = await post(path, { origin: PUBLIC, host: 'dash.example.com', 'x-csrf-token': session.csrf });
    expect(viaTunnel.status).toBe(200);
    expect(viaTunnel.cookie).toMatch(/Max-Age=0; Secure$/);
    // On the Mac itself (http://127.0.0.1): no Secure, or Safari would keep the old cookie. A fresh owner session first.
    const { post: post2, session: s2 } = await boot();
    const local = await post2(path, { origin: PUBLIC, 'x-csrf-token': s2.csrf });
    expect(local.status).toBe(200);
    expect(local.cookie).not.toContain('Secure');
  });
});

describe('secureRequest', () => {
  const at = (host: string) => ({ headers: { host } }) as never;
  const secure = secureRequest({ publicUrl: PUBLIC, port: () => 8787 });
  it('is true only for the public https host', () => {
    expect(secure(at('dash.example.com'))).toBe(true);
    expect(secure(at('localhost:8787'))).toBe(false);
    expect(secure(at('127.0.0.1:8787'))).toBe(false);
    // An unknown Host is treated as the public address, as sign-in does.
    expect(secure(at('other.example'))).toBe(true);
  });
  it('is false without a public address', () => {
    expect(secureRequest({ port: () => 8787 })(at('other.example'))).toBe(false);
  });
});
