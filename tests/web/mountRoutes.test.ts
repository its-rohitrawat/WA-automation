import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { UptimeLog } from '../../src/health/uptimeLog.ts';
import { ensurePlatformSchema } from '../../src/platform/schema.ts';
import { manualClock } from '../../src/util/clock.ts';
import { silentLogger } from '../../src/util/logger.ts';
import { mountAgentRoutes, type AgentRoutesDeps } from '../../src/web/mountRoutes.ts';
import { secureRequest } from '../../src/web/origin.ts';
import type { WebServer } from '../../src/web/server.ts';
import { SessionStore } from '../../src/web/sessions.ts';
import { startDashboard } from '../../src/web/start.ts';
import type { Db } from '../../src/store/db.ts';
import { NOW, onSqlite, seededDb, SHARMA } from '../helpers/db.ts';
import { openTestPlatformDb } from '../helpers/pg.ts';
import { OWNER } from '../helpers/web.ts';

// The combined dashboard (stage 2): the agent's routes and c7's handlers mounted through startDashboard, on the guard,
// session store and action limiter it builds. A request is checked by that one guard whichever route it reaches.

const PUBLIC = 'https://dash.example.com';
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

/** Only what the requests below reach is real; the rest is never called. */
function deps(db: Awaited<ReturnType<typeof seededDb>>, clock: ReturnType<typeof manualClock>, started: string[]): AgentRoutesDeps {
  const never = {} as never;
  return {
    db, clock, log: silentLogger(), control: never, spend: new SpendGuard({ db, clock, capUsd: 10 }) as never, health: never,
    voiceLocal: true, uptime: { log: new UptimeLog(db, clock) }, ownerEmails: [OWNER], settings: never, priority: never,
    groups: never, clients: never, google: never, actions: never,
    links: { start: (o: { target: string }) => (started.push(o.target), { id: 'a'.repeat(32), target: o.target }) } as never,
  };
}

/** `extra` gets the platform Db: the platform and sign-up routes' own; and the agent's own (tracker) Db. */
async function boot(extra: (platformDb: Db, clock: ReturnType<typeof manualClock>, db: Db) => Partial<AgentRoutesDeps> = () => ({})) {
  const db = await seededDb();
  // The platform tables and the sessions: in tracker.db on SQLite (what main.ts does before the platform routes are
  // mounted, S5H.1); on Postgres their own, which P3 made (OWNER is this file's own there).
  const platformDb = onSqlite ? db : openTestPlatformDb();
  if (onSqlite) await ensurePlatformSchema(db);
  const clock = manualClock(NOW);
  const started: string[] = [];
  const web = await startDashboard({
    env: {
      DASHBOARD_PORT: 0, DASHBOARD_PUBLIC_URL: PUBLIC, DASHBOARD_OWNER_EMAILS: [OWNER],
      DASHBOARD_GOOGLE_CLIENT_ID: 'client-id', DASHBOARD_GOOGLE_CLIENT_SECRET: 'client-secret',
    },
    db, platformDb, log: silentLogger(), control: {}, clock,
    google: { exchange: () => Promise.reject(new Error('no Google')), verifier: () => Promise.reject(new Error('no Google')) },
    mount: (m) => mountAgentRoutes(m, { ...deps(db, clock, started), ...extra(platformDb, clock, db) }),
  });
  servers.push(web!);
  const port = web!.address()!.port;
  const session = await new SessionStore(platformDb, clock).create(OWNER);
  const post = (path: string, h: Record<string, string>, body = '{}') =>
    new Promise<{ status: number; cookie: string }>((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { cookie: `wa_session=${session.id}`, 'content-type': 'application/json', ...h } }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, cookie: String(res.headers['set-cookie'] ?? '') }));
      });
      r.on('error', reject);
      r.end(body);
    });
  const get = (path: string, signedIn = true) =>
    new Promise<{ status: number; type: string }>((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port, path, headers: signedIn ? { cookie: `wa_session=${session.id}` } : {} }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? '') }));
      });
      r.on('error', reject);
      r.end();
    });
  return { db, port, session, post, get, started };
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

describe('the reading phones’ routes (lane C, change 7): mounted with their deps, behind the owner and change guards', () => {
  const PHONES = '/dashboard/api/whatsapp/phones';
  const phoneDeps = (calls: string[]): Partial<AgentRoutesDeps> => ({
    phones: {
      list: () => [{ id: 1, label: 'Phone 1', state: 'active', number: '…0001', status: 'open', groups: 2 }],
      add: async (label) => (calls.push(`add ${String(label)}`), { id: 2, label: String(label), state: 'active', addedAt: NOW }),
      rename: async (id, label) => (calls.push(`rename ${id}`), { id, label: String(label), state: 'active', addedAt: NOW }),
      unlink: async (id) => (calls.push(`unlink ${id}`), { phone: { id, label: 'x', state: 'unlinked', addedAt: NOW }, loggedOut: true }),
      remove: async (id) => (calls.push(`remove ${id}`), { id, label: 'x', state: 'active', addedAt: NOW }),
    },
  });

  it('without them there are no phone routes; with them each route answers, and a change needs the CSRF token and confirm', async () => {
    expect((await (await boot()).get(PHONES)).status).toBe(404);
    const calls: string[] = [];
    const { get, post, session } = await boot(() => phoneDeps(calls));
    expect((await get(PHONES)).status).toBe(200);
    expect((await get(PHONES, false)).status).toBe(401);
    const h = { origin: PUBLIC, 'x-csrf-token': session.csrf };
    expect((await post(`${PHONES}/2/unlink`, { origin: PUBLIC }, JSON.stringify({ confirm: true }))).status).toBe(403); // no token
    expect((await post(`${PHONES}/2/unlink`, h, '{}')).status).toBe(400); // no confirm
    expect(calls).toEqual([]);
    expect((await post(PHONES, h, JSON.stringify({ label: 'Sales' }))).status).toBe(200);
    expect((await post(`${PHONES}/2/rename`, h, JSON.stringify({ label: 'Desk' }))).status).toBe(200);
    expect((await post(`${PHONES}/2/unlink`, h, JSON.stringify({ confirm: true }))).status).toBe(200);
    expect((await post(`${PHONES}/2/remove`, h, JSON.stringify({ confirm: true }))).status).toBe(200);
    expect(calls).toEqual(['add Sales', 'rename 2', 'unlink 2', 'remove 2']);
  });
});

describe('Open chat’s members (final review, S6)', () => {
  it('each read of the members counts against the action limit, as a change does: the 31st in a minute is refused, unasked', async () => {
    let asked = 0;
    const { get } = await boot((_p, clock, db) => ({
      chat: {
        db, configs: () => [SHARMA], sendingOn: () => false, connected: () => true, groupSocket: () => null,
        groupMembers: async () => (asked++, []), directory: { cachedGroups: () => [] }, log: silentLogger(), clock,
      },
    }));
    const path = '/dashboard/api/clients/SHA/chat/members';
    for (let i = 0; i < 30; i++) expect((await get(path)).status).toBe(200);
    expect((await get(path)).status).toBe(429);
    expect(asked).toBe(30);
  });
});

describe('the platform and sign-up routes (SaaS S5H.2, S5H.6): mounted only when their deps are given', () => {
  const INVITES = '/dashboard/api/platform/invites';

  it('without them (today’s main.ts) neither the invite API nor the sign-up page is there', async () => {
    const { get } = await boot();
    expect((await get(INVITES)).status).toBe(404);
    expect((await get('/signup/api/invite?invite=x')).status).toBe(404);
  });

  it('with the platform deps the founder (a dashboard owner) reads the invites, behind the owner guard', async () => {
    const { get } = await boot((db, clock) => ({
      platform: { db, clock, log: silentLogger(), publicUrl: PUBLIC, founderName: 'Founder', mailer: () => null },
    }));
    const signedIn = await get(INVITES);
    expect(signedIn.status).toBe(200);
    expect(signedIn.type).toContain('application/json');
    expect((await get(INVITES, false)).status).toBe(401);
  });

  it('with the sign-up deps the public sign-up answers without an owner session', async () => {
    const { get } = await boot((db, clock) => ({
      signup: { db, clock, log: silentLogger(), publicUrl: PUBLIC, founderName: 'Founder', google: null, startSession: async () => false, secure: () => true },
    }));
    const page = await get('/signup', false);
    expect(page.status).toBe(200);
    expect(page.type).toContain('text/html');
    expect((await get('/signup/api/invite?invite=x', false)).type).toContain('application/json');
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
