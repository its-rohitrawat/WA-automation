import { request } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DestinationStream } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/config/env.ts';
import { AgentControl } from '../../src/control/agentControl.ts';
import { Health } from '../../src/health/health.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { manualClock } from '../../src/util/clock.ts';
import { createLogger } from '../../src/util/logger.ts';
import { createGuard } from '../../src/web/guard.ts';
import { registerReadApi } from '../../src/web/routes/api.ts';
import { createWebServer, type WebServer } from '../../src/web/server.ts';
import { SessionStore } from '../../src/web/sessions.ts';
import { seededDb } from '../helpers/db.ts';

const NOW = '2026-10-19T08:00:00.000Z';
const OWNER = 'owner@example.com';

const servers: WebServer[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function boot(o: { control?: Parameters<typeof registerReadApi>[1]['control'] } = {}) {
  const lines: string[] = [];
  const log = createLogger('info', { write: (s: string) => { lines.push(s); } } as unknown as DestinationStream);
  const db = seededDb();
  const clock = manualClock(NOW);
  const spend = new SpendGuard({ db, clock, capUsd: 10 });
  const health = new Health({ db, clock, spend, freeBytes: () => 200e9 });
  const gw = { state: 'open' as const, since: NOW, lastErrorCode: null, credsSaveFailures: 0 };
  health.setWhatsApp(gw);
  const control = o.control ?? new AgentControl({ app: { health, spend }, db, gateway: { status: () => gw }, env: parseEnv({}), clock });
  const sessions = new SessionStore(db, clock);
  const root = mkdtempSync(join(tmpdir(), 'wa-api-'));
  roots.push(root);
  writeFileSync(join(root, 'index.html'), '<!doctype html>');
  let port = 0;
  const guard = createGuard({ sessions, ownerEmails: [OWNER], port: () => port });
  const server = createWebServer({ control: {}, env: { DASHBOARD_PORT: 0 }, log, clock, publicDir: root });
  registerReadApi(server.router, { guard, control });
  servers.push(server);
  port = (await server.start()).port;
  const owner = sessions.create(OWNER).id;
  const other = sessions.create('someone@example.com').id;
  return { port, owner, other, log: () => lines.join('') };
}

function get(port: number, path: string, cookie?: string): Promise<{ status: number; headers: Record<string, unknown>; json: unknown }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path, headers: cookie ? { cookie: `wa_session=${cookie}` } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }));
    });
    r.on('error', reject);
    r.end();
  });
}

/** The keys of an object, deeply, with array elements described by their first element: a snapshot of shape, not values. */
function shape(v: unknown): unknown {
  if (Array.isArray(v)) return v.length === 0 ? [] : [shape(v[0])];
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape((v as Record<string, unknown>)[k])]));
  return v === null ? 'null' : typeof v;
}

const PATHS = ['/dashboard/api/status', '/dashboard/api/overview', '/dashboard/api/connections'];

describe('read API', () => {
  it('needs a signed-in owner: 401 JSON without a session, a malformed or unknown one, or a non-owner, and reads nothing first', async () => {
    let calls = 0;
    const spy = () => {
      calls++;
      return {};
    };
    const { port, other } = await boot({ control: { status: spy, overview: spy, connections: spy } as never });
    // The guard ends a non-owner's session at its first refusal, so that case comes first on each path's own run.
    const r0 = await get(port, PATHS[0]!, other);
    expect(r0.status).toBe(401);
    for (const path of PATHS) {
      for (const cookie of [undefined, 'not-a-token', 'x'.repeat(43), other]) {
        const r = await get(port, path, cookie);
        expect(r.status, `${path} ${cookie === other ? 'other' : String(cookie)}`).toBe(401);
        expect(r.json).toEqual({ error: { code: 'unauthorized', message: 'Sign in to continue.' } });
      }
    }
    expect(calls).toBe(0);
  });

  it('a non-owner is refused on every path, not only the first', async () => {
    for (const path of PATHS) {
      const { port, other } = await boot();
      expect((await get(port, path, other)).status, path).toBe(401);
    }
  });

  it('answers each endpoint with its shape and no-store', async () => {
    const { port, owner } = await boot();
    const status = await get(port, '/dashboard/api/status', owner);
    expect(status.status).toBe(200);
    expect(status.headers['cache-control']).toBe('no-store');
    expect(shape(status.json)).toEqual({
      at: 'string', capUsd: 'number', lastMessageAt: 'null', line: { ok: 'boolean', text: 'string' },
      parts: [{ key: 'string', label: 'string', name: 'string', state: 'string' }], spentToday: 'number', up: 'boolean',
    });
    const overview = await get(port, '/dashboard/api/overview', owner);
    expect(overview.headers['cache-control']).toBe('no-store');
    expect(shape(overview.json)).toEqual({
      activity: [], byClient: [{ client: { code: 'string', name: 'string' }, segments: [{ count: 'number', key: 'string' }] }], clients: 'number',
      meetings: [], tasks: { doneThisWeek: 'number', open: 'number', overdue: 'number', review: 'number' },
      tracker: { health: { ok: 'boolean', text: 'string' }, lastPublishedAt: 'null' },
    });
    const connections = await get(port, '/dashboard/api/connections', owner);
    expect(connections.headers['cache-control']).toBe('no-store');
    expect(shape(connections.json)).toEqual({
      claude: { callsToday: 'number', capUsd: 'number', spentToday: 'number' },
      drive: { account: 'null', file: 'string', folder: 'string', label: 'string', lastUploadAt: 'null', state: 'string', url: 'null' },
      founder: { device: 'string', groups: 'number', label: 'string', lastActivityAt: 'null', state: 'string' },
      google: [{ email: 'null', label: 'string', state: 'string', stateLabel: 'string', usedFor: ['string'] }],
      monitoring: { lastBeatAt: 'null', on: 'boolean' },
      spare: { device: 'string', label: 'string', recipientMasked: 'null', state: 'string' },
    });
  });

  it('an internal error gives the plain 500, and is logged with the request id, its type and stack, never its message', async () => {
    const boom = () => {
      throw new Error('SQLITE_BUSY secret detail'); // no path in it: the plain-message filter must not be what hides it
    };
    const { port, owner, log } = await boot({ control: { status: boom, overview: boom, connections: boom } });
    for (const path of PATHS) {
      const r = await get(port, path, owner);
      expect(r.status, path).toBe(500);
      expect(r.json).toEqual({ error: { code: 'internal', message: 'Something went wrong.' } });
      expect(r.headers['cache-control']).toBe('no-store');
      expect(JSON.stringify(r.json)).not.toContain('secret');
    }
    const failed = log().split('\n').filter((l) => l.includes('"request failed"'));
    expect(failed).toHaveLength(3);
    for (const l of failed) {
      expect(l).toMatch(/"rid":"[0-9a-f]{12}"/);
      // The logger keeps the error's type and stack frames, never its message (src/util/logger.ts).
      expect(l).toMatch(/"err":{"type":"Error"/);
      expect(l).not.toContain('secret');
    }
  });

  it('answers HEAD like GET, and refuses other methods', async () => {
    const { port, owner } = await boot();
    const head = await new Promise<number>((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port, path: '/dashboard/api/status', method: 'HEAD', headers: { cookie: `wa_session=${owner}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      r.on('error', reject);
      r.end();
    });
    expect(head).toBe(200);
    const post = await new Promise<number>((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port, path: '/dashboard/api/status', method: 'POST', headers: { cookie: `wa_session=${owner}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      r.on('error', reject);
      r.end();
    });
    expect(post).toBe(405); // no POST route: never the read answer, and the path says which methods it takes
  });
});
