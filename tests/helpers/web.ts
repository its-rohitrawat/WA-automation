import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DestinationStream } from 'pino';
import type { Db } from '../../src/store/db.ts';
import type { ManualClock } from '../../src/util/clock.ts';
import { createLogger } from '../../src/util/logger.ts';
import { createGuard, RateLimiter } from '../../src/web/guard.ts';
import type { Router } from '../../src/web/router.ts';
import { createWebServer, type WebServer } from '../../src/web/server.ts';
import { SessionStore } from '../../src/web/sessions.ts';

export const OWNER = 'owner@example.com';

export interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  json: unknown;
}

/** A real dashboard server on a random port, with one owner session and its CSRF token, and the routes `mount` adds. */
export async function bootDashboard(o: {
  db: Db;
  clock: ManualClock;
  mount: (router: Router, x: { guard: ReturnType<typeof createGuard>; actions: RateLimiter; sessions: SessionStore }) => void;
  actionCapacity?: number;
}) {
  const lines: string[] = [];
  const log = createLogger('info', { write: (s: string) => { lines.push(s); } } as unknown as DestinationStream);
  const root = mkdtempSync(join(tmpdir(), 'wa-dash-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html>');
  let port = 0;
  const sessions = new SessionStore(o.db, o.clock);
  const guard = createGuard({ sessions, ownerEmails: [OWNER], port: () => port });
  const actions = new RateLimiter({ capacity: o.actionCapacity ?? 1000, refillPerSec: 1, clock: o.clock });
  const server: WebServer = createWebServer({ control: {}, env: { DASHBOARD_PORT: 0 }, log, clock: o.clock, publicDir: root });
  o.mount(server.router, { guard, actions, sessions });
  port = (await server.start()).port;
  const { id, csrf } = sessions.create(OWNER);
  const origin = `http://127.0.0.1:${port}`;

  function send(method: string, path: string, x: { body?: unknown; raw?: string; cookie?: string | null; csrf?: string | null; origin?: string | null } = {}): Promise<Reply> {
    const headers: Record<string, string> = {};
    const cookie = x.cookie === undefined ? id : x.cookie;
    if (cookie !== null) headers.cookie = `wa_session=${cookie}`;
    if (method !== 'GET') {
      const token = x.csrf === undefined ? csrf : x.csrf;
      if (token !== null) headers['x-csrf-token'] = token;
      const or = x.origin === undefined ? origin : x.origin;
      if (or !== null) headers.origin = or;
    }
    const text = x.raw !== undefined ? x.raw : x.body === undefined ? undefined : JSON.stringify(x.body);
    if (text !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(text));
    }
    return new Promise((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          try {
            json = raw === '' ? null : (JSON.parse(raw) as unknown);
          } catch {
            json = raw;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
        });
      });
      r.on('error', reject);
      r.end(text);
    });
  }

  return {
    port, sessions, log: () => lines.join(''),
    get: (path: string, x?: { cookie?: string | null }) => send('GET', path, x),
    post: (path: string, x?: { body?: unknown; raw?: string; cookie?: string | null; csrf?: string | null; origin?: string | null }) => send('POST', path, x),
    async close() {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
