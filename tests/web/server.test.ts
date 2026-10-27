import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { Server } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DestinationStream } from 'pino';
import { CONTENT_SECURITY_POLICY, HttpError, readJson, sendJson } from '../../src/web/http.ts';
import { createWebServer, PUBLIC_DIR, SESSION_PURGE_EVERY_MS, STOP_GRACE_MS } from '../../src/web/server.ts';
import { startDashboard } from '../../src/web/start.ts';
import { SessionStore } from '../../src/web/sessions.ts';
import { openDb } from '../../src/store/db.ts';
import type { Db } from '../../src/store/db.ts';
import type { WebServer } from '../../src/web/server.ts';
import { manualClock } from '../../src/util/clock.ts';
import { createLogger } from '../../src/util/logger.ts';

const SECRET = 'OUTSIDE-SECRET-7f3a';
const INDEX = '<!doctype html><title>test shell</title><p>shell</p>';

function capture() {
  const lines: string[] = [];
  const dest = { write: (s: string) => { lines.push(s); } } as unknown as DestinationStream;
  return {
    log: createLogger('info', dest),
    out: () => lines.join(''),
    records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

/** A temporary public folder with one file of each served type, and a secret file beside it (outside it). */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wa-web-'));
  const pub = join(root, 'public');
  mkdirSync(join(pub, 'views'), { recursive: true });
  writeFileSync(join(pub, 'index.html'), INDEX);
  writeFileSync(join(pub, 'app.js'), 'export const a = 1;\n');
  writeFileSync(join(pub, 'views', 'overview.js'), 'export const v = 2;\n');
  writeFileSync(join(pub, 'styles.css'), 'body{}\n');
  writeFileSync(join(pub, 'font.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32]));
  writeFileSync(join(pub, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(pub, 'data.json'), '{"x":1}');
  writeFileSync(join(pub, 'notes.txt'), 'not a served type');
  writeFileSync(join(pub, '.hidden.js'), 'hidden');
  writeFileSync(join(root, 'outside.json'), JSON.stringify({ secret: SECRET }));
  writeFileSync(join(root, 'vendor-lib.js'), 'export const lib = 3;\n');
  return { root, pub };
}

const servers: WebServer[] = [];
const roots: string[] = [];
const dbs: Db[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
  for (const d of dbs.splice(0)) d.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function boot(o: { publicDir?: string; vendorFiles?: Record<string, string>; stopGraceMs?: number } = {}) {
  const c = capture();
  const f = fixture();
  roots.push(f.root);
  let http!: Server;
  const server = createWebServer({
    control: {},
    env: { DASHBOARD_PORT: 0 },
    log: c.log,
    clock: manualClock('2026-10-27T10:00:00Z'),
    publicDir: o.publicDir ?? f.pub,
    vendorFiles: o.vendorFiles ?? { 'lib.js': join(f.root, 'vendor-lib.js'), 'missing.js': join(f.root, 'nope.js') },
    ...(o.stopGraceMs === undefined ? {} : { stopGraceMs: o.stopGraceMs }),
    onHttpServer: (h) => {
      http = h;
    },
  });
  servers.push(server);
  const { port, host } = await server.start();
  return { server, http, port, host, base: `http://127.0.0.1:${port}`, ...c, ...f };
}

/** A GET that sends the path exactly as written (fetch would normalise dot segments first). */
function rawGet(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('web server: routing', () => {
  it('an unknown route gives a 404 JSON error', async () => {
    const s = await boot();
    for (const path of ['/', '/nope', '/dashboard/api/nope', '/dashboard/static/nope.js', '/dashboard/vendor/nope.js', '/dashboardx']) {
      const r = await fetch(s.base + path);
      expect(r.status, path).toBe(404);
      expect(r.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(await r.json()).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
    }
    const post = await fetch(`${s.base}/dashboard/tasks`, { method: 'POST', body: '{}' });
    expect(post.status).toBe(404);
  });

  it('serves index.html for /dashboard and every /dashboard/<screen> path', async () => {
    const s = await boot();
    const paths = ['/dashboard', '/dashboard/', '/dashboard/tasks', '/dashboard/tasks/', '/dashboard/clients/groups', '/dashboard/clients/groups/', '/dashboard/tasks?x=1'];
    for (const path of paths) {
      const r = await fetch(s.base + path);
      expect(r.status, path).toBe(200);
      expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(await r.text()).toBe(INDEX);
    }
  });

  it('does not serve the shell for reserved or odd prefixes', async () => {
    const s = await boot();
    const paths = ['/dashboard/api', '/dashboard/api/', '/dashboard/static', '/dashboard/auth/x', '/dashboard/Tasks', '/dashboard/a/b/c/d', '/dashboard/a/b/c/d/', '/dashboard/tasks//'];
    for (const path of paths) {
      const r = await fetch(s.base + path);
      expect(r.status, path).toBe(404);
    }
  });

  it('the real public folder has the shell', async () => {
    const s = await boot({ publicDir: PUBLIC_DIR });
    const r = await fetch(`${s.base}/dashboard/tasks`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8'));
  });

  it('runs router handlers with params and the parsed query', async () => {
    const s = await boot();
    s.server.router.get('/dashboard/api/echo/:id', ({ res, params, url }) => sendJson(res, 200, { id: params.id, q: url.searchParams.get('q') }));
    const r = await fetch(`${s.base}/dashboard/api/echo/a%20b?q=1`);
    expect(await r.json()).toEqual({ id: 'a b', q: '1' });
  });

  it('odd paths never reach a :param handler', async () => {
    const s = await boot();
    let calls = 0;
    s.server.router.get('/dashboard/api/echo/:id', ({ res, params }) => {
      calls++;
      sendJson(res, 200, { id: params.id });
    });
    s.server.router.get('/dashboard/api/pair/:a/:b', ({ res }) => {
      calls++;
      sendJson(res, 200, {});
    });
    const variants = [
      '/dashboard/api/echo/%2e%2e',
      '/dashboard/api/echo/%2E%2E',
      '/dashboard/api/echo/.%2e',
      '/dashboard/api/echo/..%2fx',
      '/dashboard/api/echo/..%2Fx',
      '/dashboard/api/echo/a%5cb',
      '/dashboard/api/echo/a\\b',
      '/dashboard/api/echo/%00',
      '/dashboard/api/echo/a%00b',
      '/dashboard/api/echo/..',
      '/dashboard/api/echo/.',
      '/dashboard/api//echo/1',
      '/dashboard/api/pair/a/%2e%2e',
      '/dashboard/api/pair/%2fetc/x',
    ];
    for (const path of variants) {
      const r = await rawGet(s.port, path);
      expect(r.status, path).toBe(404);
      expect(JSON.parse(r.body), path).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
    }
    expect(calls).toBe(0);
    // The route itself works.
    expect((await rawGet(s.port, '/dashboard/api/echo/abc')).status).toBe(200);
    expect(calls).toBe(1);
  });

  it('a throwing handler with a plain internal message still gives the generic 500', async () => {
    const s = await boot();
    s.server.router.get('/dashboard/api/boom', () => {
      throw new Error('UNIQUE constraint failed: web_sessions.id_hash SECRET-DETAIL');
    });
    s.server.router.get('/dashboard/api/boom-async', async () => {
      await Promise.resolve();
      throw new Error('invalid_grant SECRET-DETAIL');
    });
    for (const path of ['/dashboard/api/boom', '/dashboard/api/boom-async']) {
      const r = await fetch(s.base + path);
      expect(r.status, path).toBe(500);
      const text = await r.text();
      expect(JSON.parse(text), path).toEqual({ error: { code: 'internal', message: 'Something went wrong.' } });
      expect(text, path).not.toContain('SECRET-DETAIL');
    }
    expect(s.out()).not.toContain('SECRET-DETAIL');
  });

  it('a throwing handler gives a plain 500 and the detail stays in the log with the request id', async () => {
    const s = await boot();
    s.server.router.get('/dashboard/api/boom', () => {
      throw new Error('C:\\Users\\Dell\\secret path SECRET-DETAIL');
    });
    const r = await fetch(`${s.base}/dashboard/api/boom`);
    expect(r.status).toBe(500);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ error: { code: 'internal', message: 'Something went wrong.' } });
    expect(text).not.toContain('SECRET-DETAIL');
    const failed = s.records().find((l) => l.msg === 'request failed');
    expect(failed?.rid).toMatch(/^[0-9a-f]{12}$/);
    expect(s.out()).not.toContain('SECRET-DETAIL');
  });

  it('a handler that throws after the headers went out has its connection cut, and the log leaves out the detail', async () => {
    const s = await boot();
    s.server.router.get('/dashboard/api/half', ({ res }) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('partial');
      throw new Error('half-way SECRET-DETAIL');
    });
    // A truncated answer must not look complete: the read fails (at the headers or in the body, by timing).
    await expect(fetch(`${s.base}/dashboard/api/half`).then(async (r) => r.text())).rejects.toThrow();
    const failed = s.records().find((l) => l.msg === 'request failed');
    expect(failed?.rid).toMatch(/^[0-9a-f]{12}$/);
    expect(s.out()).not.toContain('SECRET-DETAIL');
  });
});

describe('web server: static files', () => {
  it('serves files under /dashboard/static/ with the right MIME types and an ETag', async () => {
    const s = await boot();
    const cases: [string, string][] = [
      ['/dashboard/static/index.html', 'text/html; charset=utf-8'],
      ['/dashboard/static/app.js', 'text/javascript; charset=utf-8'],
      ['/dashboard/static/views/overview.js', 'text/javascript; charset=utf-8'],
      ['/dashboard/static/styles.css', 'text/css; charset=utf-8'],
      ['/dashboard/static/font.woff2', 'font/woff2'],
      ['/dashboard/static/icon.svg', 'image/svg+xml'],
      ['/dashboard/static/data.json', 'application/json; charset=utf-8'],
    ];
    for (const [path, type] of cases) {
      const r = await fetch(s.base + path);
      expect(r.status, path).toBe(200);
      expect(r.headers.get('content-type'), path).toBe(type);
      expect(r.headers.get('etag'), path).toMatch(/^"[A-Za-z0-9_-]{8,}"$/);
      expect(r.headers.get('cache-control'), path).toBe('no-cache');
    }
    const r = await fetch(`${s.base}/dashboard/static/app.js`);
    expect(await r.text()).toBe('export const a = 1;\n');
    // The shell is revalidated on every load too, so a deploy reaches the browser at once.
    const shell = await fetch(`${s.base}/dashboard/tasks`);
    expect(shell.headers.get('cache-control')).toBe('no-cache');
  });

  it('answers a matching If-None-Match with 304', async () => {
    const s = await boot();
    const first = await fetch(`${s.base}/dashboard/static/app.js`);
    const etag = first.headers.get('etag')!;
    const again = await fetch(`${s.base}/dashboard/static/app.js`, { headers: { 'If-None-Match': etag } });
    expect(again.status).toBe(304);
    expect(again.headers.get('etag')).toBe(etag);
  });

  it('refuses types it does not serve and hidden files', async () => {
    const s = await boot();
    expect((await fetch(`${s.base}/dashboard/static/notes.txt`)).status).toBe(404);
    expect((await fetch(`${s.base}/dashboard/static/.hidden.js`)).status).toBe(404);
    expect((await fetch(`${s.base}/dashboard/static/views`)).status).toBe(404);
    expect((await fetch(`${s.base}/dashboard/static/`)).status).toBe(404);
  });

  it('every traversal variant gives 404 and never the file outside', async () => {
    const s = await boot();
    const variants = [
      '/dashboard/static/../outside.json',
      '/dashboard/static/../../outside.json',
      '/dashboard/static/%2e%2e/outside.json',
      '/dashboard/static/%2E%2E/outside.json',
      '/dashboard/static/.%2e/outside.json',
      '/dashboard/static/..%2foutside.json',
      '/dashboard/static/..%2Foutside.json',
      '/dashboard/static/%2e%2e%2foutside.json',
      '/dashboard/static/..%5coutside.json',
      '/dashboard/static/..\\outside.json',
      '/dashboard/static/views/..\\..\\outside.json',
      '/dashboard/static/%c0%ae%c0%ae/outside.json',
      '/dashboard/static/..%00/outside.json',
      '/dashboard/static//outside.json',
      '/dashboard/static/./app.js',
      `/dashboard/static/${encodeURIComponent(join(tmpdir(), 'outside.json'))}`,
      '/dashboard/static/C:/Windows/win.ini',
      '/dashboard/static/C:%5cWindows%5cwin.ini',
      '/dashboard/vendor/../outside.json',
      '/dashboard/vendor/%2e%2e/outside.json',
      '/dashboard/../outside.json',
      '/dashboard/static/views/../../outside.json',
    ];
    for (const path of variants) {
      const r = await rawGet(s.port, path);
      expect(r.status, path).toBe(404);
      expect(r.body, path).not.toContain(SECRET);
      expect(JSON.parse(r.body), path).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
    }
  });

  it('a link inside the public folder that points outside is refused', async (ctx) => {
    const s = await boot();
    try {
      symlinkSync(join(s.root, 'outside.json'), join(s.pub, 'link.json'), 'file');
    } catch {
      ctx.skip(); // Windows without the right to make links; it runs on macOS and CI.
      return;
    }
    const r = await rawGet(s.port, '/dashboard/static/link.json');
    expect(r.status).toBe(404);
    expect(r.body).not.toContain(SECRET);
    expect(JSON.parse(r.body)).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
  });

  it('a linked folder inside the public folder that points outside is refused (junction: runs on Windows without admin)', async () => {
    const s = await boot();
    const outDir = join(s.root, 'outdir');
    mkdirSync(outDir);
    writeFileSync(join(outDir, 'secret.json'), JSON.stringify({ secret: SECRET }));
    // 'junction' is a Windows directory junction; elsewhere the type is ignored and a directory link is made.
    symlinkSync(outDir, join(s.pub, 'lnkdir'), 'junction');
    const r = await rawGet(s.port, '/dashboard/static/lnkdir/secret.json');
    expect(r.status).toBe(404);
    expect(r.body).not.toContain(SECRET);
    expect(JSON.parse(r.body)).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
  });

  it('serves vendor files from the allowlist only, cached for an hour', async () => {
    const s = await boot();
    const r = await fetch(`${s.base}/dashboard/vendor/lib.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(r.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(r.headers.get('etag')).toMatch(/^"/);
    expect(await r.text()).toBe('export const lib = 3;\n');
    expect((await fetch(`${s.base}/dashboard/vendor/vendor-lib.js`)).status).toBe(404);
    expect((await fetch(`${s.base}/dashboard/vendor/missing.js`)).status).toBe(404);
    expect((await fetch(`${s.base}/dashboard/vendor/toString`)).status).toBe(404);
    expect((await fetch(`${s.base}/dashboard/vendor/__proto__`)).status).toBe(404);
    // Names that do exist relative to the working directory: only the allowlist may decide what is served.
    for (const name of ['package.json', 'tsconfig.json']) {
      expect(readFileSync(join(process.cwd(), name), 'utf8').length, name).toBeGreaterThan(0);
      const r = await fetch(`${s.base}/dashboard/vendor/${name}`);
      expect(r.status, name).toBe(404);
      expect(await r.json(), name).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
    }
  });
});

describe('web server: headers and logging', () => {
  it('the security headers are on every response, and no-store on JSON', async () => {
    const s = await boot();
    for (const path of ['/nope', '/dashboard/tasks', '/dashboard/static/app.js', '/dashboard/vendor/lib.js']) {
      const r = await fetch(s.base + path);
      expect(r.headers.get('content-security-policy'), path).toBe(CONTENT_SECURITY_POLICY);
      expect(r.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(r.headers.get('referrer-policy'), path).toBe('same-origin');
    }
    expect((await fetch(`${s.base}/nope`)).headers.get('cache-control')).toBe('no-store');
  });

  it('logs one line per request with the method, route pattern, status and duration; no query, cookie or header', async () => {
    const s = await boot();
    s.server.router.get('/dashboard/api/tasks/:id', ({ res }) => sendJson(res, 200, {}));
    await fetch(`${s.base}/dashboard/api/tasks/PATHIDSECRET?code=QUERY-SECRET`, { headers: { Cookie: 'wa_session=COOKIE-SECRET', Authorization: 'Bearer HEADER-SECRET' } });
    await fetch(`${s.base}/dashboard/static/app.js?v=QUERY-SECRET`);
    await fetch(`${s.base}/dashboard/clients?token=QUERY-SECRET`);
    await fetch(`${s.base}/nope/PATHIDSECRET?x=QUERY-SECRET`);
    const lines = s.records().filter((l) => l.msg === 'http');
    expect(lines.map((l) => [l.method, l.route, l.status])).toEqual([
      ['GET', '/dashboard/api/tasks/:id', 200],
      ['GET', '/dashboard/static/*', 200],
      ['GET', '/dashboard/*', 200],
      ['GET', '(unmatched)', 404],
    ]);
    for (const l of lines) {
      expect(typeof l.ms).toBe('number');
      expect(l.rid).toMatch(/^[0-9a-f]{12}$/);
    }
    const out = s.out();
    for (const secret of ['QUERY-SECRET', 'COOKIE-SECRET', 'HEADER-SECRET', 'PATHIDSECRET', 'app.js', 'clients']) expect(out).not.toContain(secret);
  });

  it('a request the client gives up on before any answer is not logged as a 200', async () => {
    const s = await boot();
    let entered!: () => void;
    const inHandler = new Promise<void>((r) => {
      entered = r;
    });
    s.server.router.get('/dashboard/api/hang', ({ req }) => {
      entered();
      return new Promise<void>((r) => req.once('close', () => r()));
    });
    const ac = new AbortController();
    const pending = fetch(`${s.base}/dashboard/api/hang`, { signal: ac.signal });
    pending.catch(() => {}); // aborted on purpose
    await inHandler;
    ac.abort();
    await expect(pending).rejects.toThrow();
    const deadline = Date.now() + 2_000;
    let line: Record<string, unknown> | undefined;
    while (!line && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
      line = s.records().find((l) => l.msg === 'http' && l.route === '/dashboard/api/hang');
    }
    expect(line).toBeDefined();
    expect(line!.status).toBe(0);
  });

  it('an error the server emits after start (for example EMFILE) is logged by its code and the agent carries on', async () => {
    const s = await boot();
    expect(s.http.listenerCount('error')).toBeGreaterThanOrEqual(1);
    expect(() => s.http.emit('error', Object.assign(new Error('accept failed SECRET-DETAIL'), { code: 'EMFILE' }))).not.toThrow();
    const errors = s.records().filter((l) => l.level === 50);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe('EMFILE');
    expect(errors[0]).not.toHaveProperty('err');
    expect(errors[0]).not.toHaveProperty('stack');
    expect(s.out()).not.toContain('SECRET-DETAIL');
    // Still answering.
    expect((await fetch(`${s.base}/dashboard/tasks`)).status).toBe(200);
  });
});

describe('web server: request bodies', () => {
  it('a body over the limit gives 413, bad JSON gives 400, and good JSON reaches the handler', async () => {
    const s = await boot();
    s.server.router.post('/dashboard/api/echo', async ({ req, res }) => sendJson(res, 200, { got: await readJson(req) }));
    const big = await fetch(`${s.base}/dashboard/api/echo`, { method: 'POST', body: JSON.stringify({ x: 'a'.repeat(70_000) }) });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: { code: 'too_large', message: 'The request is too large.' } });
    const bad = await fetch(`${s.base}/dashboard/api/echo`, { method: 'POST', body: '{"x":' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: { code: 'bad_json', message: 'The request is not valid JSON.' } });
    const empty = await fetch(`${s.base}/dashboard/api/echo`, { method: 'POST' });
    expect(empty.status).toBe(400);
    const good = await fetch(`${s.base}/dashboard/api/echo`, { method: 'POST', body: '{"x":[1,2]}' });
    expect(await good.json()).toEqual({ got: { x: [1, 2] } });
  });

  it('a chunked body over the limit gives 413 too', async () => {
    const s = await boot();
    s.server.router.post('/dashboard/api/echo', async ({ req, res }) => sendJson(res, 200, { got: await readJson(req, 100) }));
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 5; i++) c.enqueue(new TextEncoder().encode('b'.repeat(40)));
        c.close();
      },
    });
    const r = await fetch(`${s.base}/dashboard/api/echo`, { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
    expect(r.status).toBe(413);
  });
});

describe('web server: very large bodies', () => {
  it('a body over 1 MB gets a 413 answer, not a dropped connection', async () => {
    const s = await boot();
    s.server.router.post('/dashboard/api/echo', async ({ req, res }) => sendJson(res, 200, { got: await readJson(req) }));
    const r = await fetch(`${s.base}/dashboard/api/echo`, { method: 'POST', body: JSON.stringify({ x: 'a'.repeat(2_000_000) }) });
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: { code: 'too_large', message: 'The request is too large.' } });
  });

  it('a streamed body that passes 1 MB gets a 413 answer', async () => {
    const s = await boot();
    s.server.router.post('/dashboard/api/echo', async ({ req, res }) => sendJson(res, 200, { got: await readJson(req) }));
    const chunk = new TextEncoder().encode('c'.repeat(64 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= 40) return c.close(); // 2.5 MB in all
        sent++;
        c.enqueue(chunk);
      },
    });
    const r = await fetch(`${s.base}/dashboard/api/echo`, { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: { code: 'too_large', message: 'The request is too large.' } });
  });

  it('a streamed body that passes 1 MB and then stalls gets a 413, and the connection is then cut', async () => {
    const s = await boot();
    s.server.router.post('/dashboard/api/echo', async ({ req, res }) => sendJson(res, 200, { got: await readJson(req) }));
    const t0 = Date.now();
    let closed!: Promise<number>;
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: s.port, path: '/dashboard/api/echo', method: 'POST', agent: false, headers: { 'Content-Type': 'application/json' } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('error', reject);
      closed = new Promise<number>((r) => req.once('socket', (sock) => sock.once('close', () => r(Date.now() - t0))));
      req.write(Buffer.alloc(1_100_000, 0x61)); // chunked, past 1 MiB, and then nothing more
    });
    expect(result.status).toBe(413);
    expect(JSON.parse(result.body)).toEqual({ error: { code: 'too_large', message: 'The request is too large.' } });
    expect(await closed).toBeLessThan(5_000);
  });

  it('a caller that asks for more than 1 MB gets it', async () => {
    const s = await boot();
    s.server.router.post('/dashboard/api/echo', async ({ req, res }) => {
      const got = (await readJson(req, 2_000_000)) as { x: string };
      sendJson(res, 200, { len: got.x.length });
    });
    const r = await fetch(`${s.base}/dashboard/api/echo`, { method: 'POST', body: JSON.stringify({ x: 'a'.repeat(1_500_000) }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ len: 1_500_000 });
    const over = await fetch(`${s.base}/dashboard/api/echo`, { method: 'POST', body: JSON.stringify({ x: 'a'.repeat(2_100_000) }) });
    expect(over.status).toBe(413);
  });

  it('a declared Content-Length over 1 MB is refused before the body arrives', async () => {
    const s = await boot();
    let rejected: unknown;
    s.server.router.post('/dashboard/api/echo', async ({ req, res }) => {
      try {
        sendJson(res, 200, { got: await readJson(req) });
      } catch (err) {
        rejected = err;
        throw err;
      }
    });
    const t0 = Date.now();
    let closed!: Promise<void>;
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1', port: s.port, path: '/dashboard/api/echo', method: 'POST', agent: false,
          headers: { 'Content-Type': 'application/json', 'Content-Length': '5000000' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('error', reject);
      closed = new Promise<void>((r) => req.once('socket', (sock) => sock.once('close', () => r())));
      req.write('{"x":'); // a few bytes and then nothing: the answer must not wait for the rest
    });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(result.status).toBe(413);
    expect(JSON.parse(result.body)).toEqual({ error: { code: 'too_large', message: 'The request is too large.' } });
    expect(rejected).toBeInstanceOf(HttpError);
    expect((rejected as HttpError).status).toBe(413);
    // The upload that never finishes is then cut off by the server.
    await closed;
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});

describe('web server: start and stop', () => {
  it('binds 127.0.0.1 only', async () => {
    const s = await boot();
    expect(s.host).toBe('127.0.0.1');
    expect(s.server.address()).toEqual({ address: '127.0.0.1', family: 'IPv4', port: s.port });
  });

  it('stop() lets a slow handler finish, then closes', async () => {
    const s = await boot();
    let entered!: () => void;
    const inHandler = new Promise<void>((r) => {
      entered = r;
    });
    s.server.router.get('/dashboard/api/slow', async ({ res }) => {
      entered();
      await new Promise((r) => setTimeout(r, 300));
      sendJson(res, 200, { done: true });
    });
    const pending = fetch(`${s.base}/dashboard/api/slow`);
    await inHandler;
    const t0 = Date.now();
    await s.server.stop();
    expect(Date.now() - t0).toBeLessThan(5_000);
    const r = await pending;
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ done: true });
    await expect(fetch(`${s.base}/dashboard`)).rejects.toThrow();
    expect(s.server.address()).toBeNull();
  });

  it('stop() cuts a handler that never finishes once the grace period is over', async () => {
    const s = await boot({ stopGraceMs: 200 });
    let entered!: () => void;
    const inHandler = new Promise<void>((r) => {
      entered = r;
    });
    s.server.router.get('/dashboard/api/hang', () => {
      entered();
      return new Promise<void>(() => {}); // never answers
    });
    const pending = fetch(`${s.base}/dashboard/api/hang`).then(async (r) => r.text());
    pending.catch(() => {}); // asserted below
    await inHandler;
    const t0 = Date.now();
    await s.server.stop();
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(150);
    expect(took).toBeLessThan(1_000);
    await expect(pending).rejects.toThrow();
    expect(s.server.address()).toBeNull();
  });

  it('stop() closes idle keep-alive connections at once and can be called twice', async () => {
    const s = await boot();
    await (await fetch(`${s.base}/dashboard`)).text(); // leaves a keep-alive connection open
    const t0 = Date.now();
    await s.server.stop();
    await s.server.stop();
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('a kept-alive connection whose answer finishes during stop() closes at once, not after the grace period', async () => {
    const s = await boot();
    let entered!: () => void;
    const inHandler = new Promise<void>((r) => {
      entered = r;
    });
    s.server.router.get('/dashboard/api/slow', async ({ res }) => {
      entered();
      await new Promise((r) => setTimeout(r, 300));
      sendJson(res, 200, { done: true });
    });
    const sock = connect(s.port, '127.0.0.1');
    const chunks: Buffer[] = [];
    sock.on('data', (c: Buffer) => chunks.push(c));
    const closed = new Promise<number>((r) => sock.once('close', () => r(Date.now())));
    sock.write('GET /dashboard/api/slow HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n');
    await inHandler;
    const t0 = Date.now();
    await s.server.stop();
    expect((await closed) - t0).toBeLessThan(2_000);
    expect(Buffer.concat(chunks).toString('utf8')).toContain('{"done":true}');
  });

  it('the default grace period is 5 s', () => {
    expect(STOP_GRACE_MS).toBe(5_000);
  });

  it('a request that arrives on a kept-alive connection during stop() is answered with Connection: close, then the connection closes', async () => {
    const s = await boot();
    let entered!: () => void;
    const inHandler = new Promise<void>((r) => {
      entered = r;
    });
    s.server.router.get('/dashboard/api/slow', async ({ res }) => {
      entered();
      await new Promise((r) => setTimeout(r, 300));
      sendJson(res, 200, { done: true });
    });
    const sock = connect(s.port, '127.0.0.1');
    const chunks: Buffer[] = [];
    sock.on('data', (c: Buffer) => chunks.push(c));
    const closed = new Promise<number>((r) => sock.once('close', () => r(Date.now())));
    sock.write('GET /dashboard/api/slow HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n');
    await inHandler;
    const t0 = Date.now();
    const stopping = s.server.stop();
    // The second request comes on the same connection while the first is still running.
    sock.write('GET /dashboard/tasks HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n');
    const at = await closed;
    await stopping;
    // Closed once both answers went out, well before the 5 s grace period.
    expect(at - t0).toBeLessThan(2_000);
    const text = Buffer.concat(chunks).toString('utf8');
    const answers = text.split(/(?=HTTP\/1\.1 )/);
    expect(answers).toHaveLength(2);
    expect(answers[0]).toMatch(/^HTTP\/1\.1 200/);
    expect(answers[0]).toContain('{"done":true}');
    expect(answers[1]).toMatch(/^HTTP\/1\.1 200/);
    expect(answers[1]!.toLowerCase()).toContain('connection: close');
    expect(answers[1]).toContain('test shell');
  });
});

describe('main.ts dashboard wiring', () => {
  const src = readFileSync(join(import.meta.dirname, '../../src/main.ts'), 'utf8');

  it('starts the web server only when DASHBOARD_ENABLED is set, after app.start()', () => {
    expect(src).toMatch(/const webReady = env\.DASHBOARD_ENABLED\s*\?\s*startDashboard\(/);
    expect(src).toMatch(/import \{ startDashboard \} from '\.\/web\/start\.ts';/);
    expect(src).not.toContain('createWebServer(');
    expect(src.indexOf('app.start();')).toBeLessThan(src.indexOf('const webReady = env.DASHBOARD_ENABLED'));
  });

  it('awaits nothing between app.start() and the SIGINT/SIGTERM handlers', () => {
    const gap = src.slice(src.indexOf('app.start();'), src.indexOf("process.on('SIGTERM', shutdown);"));
    expect(gap.length).toBeGreaterThan(0);
    expect(gap).not.toMatch(/\bawait\b/);
  });

  it('stops the web server before app.stop() on shutdown', () => {
    const shutdown = src.slice(src.indexOf('const shutdown = () => {'), src.indexOf("process.on('SIGINT', shutdown);"));
    expect(shutdown).toMatch(/const webStopped = webReady\s*\.then\(\(w\) => w\?\.stop\(\)\)/);
    expect(shutdown.indexOf('webReady')).toBeLessThan(shutdown.indexOf('app.stop()'));
    expect(shutdown).toMatch(/webStopped\s*\.then\(\(\) => app\.stop\(\)\)/);
  });
});

describe('startDashboard', () => {
  const fakeGoogle = {
    exchange: () => Promise.reject(new Error('no Google in tests')),
    verifier: () => Promise.reject(new Error('no Google in tests')),
  };
  function dashEnv(port: number) {
    return {
      DASHBOARD_PORT: port,
      DASHBOARD_OWNER_EMAILS: ['owner@example.com'],
      DASHBOARD_GOOGLE_CLIENT_ID: 'client-id',
      DASHBOARD_GOOGLE_CLIENT_SECRET: 'client-secret',
    };
  }
  function memDb() {
    const db = openDb(':memory:');
    dbs.push(db);
    return db;
  }

  it('logs the address and returns the running server', async () => {
    const c = capture();
    const web = await startDashboard({ env: dashEnv(0), db: memDb(), log: c.log, control: {}, google: fakeGoogle });
    expect(web).toBeDefined();
    servers.push(web!);
    const port = web!.address()!.port;
    expect(c.out()).toContain(`dashboard on http://127.0.0.1:${port}/dashboard`);
  });

  it('a port already taken leaves the agent running: undefined, and only the error code in the log', async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    try {
      const port = (blocker.address() as AddressInfo).port;
      const c = capture();
      const web = await startDashboard({ env: dashEnv(port), db: memDb(), log: c.log, control: {}, google: fakeGoogle });
      expect(web).toBeUndefined();
      const errors = c.records().filter((l) => l.level === 50);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.code).toBe('EADDRINUSE');
      expect(errors[0]).not.toHaveProperty('err');
      expect(errors[0]).not.toHaveProperty('stack');
      expect(c.out()).not.toContain(String(port));
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  it('removes expired owner sessions once at start (and serves the sign-in routes)', async () => {
    const db = memDb();
    const clock = manualClock('2026-10-27T10:00:00Z');
    const store = new SessionStore(db, clock);
    store.create('owner@example.com');
    clock.advance(8 * 24 * 3_600_000);
    const c = capture();
    const web = await startDashboard({ env: dashEnv(0), db, log: c.log, control: {}, clock, google: fakeGoogle });
    servers.push(web!);
    expect((db.prepare('SELECT COUNT(*) AS n FROM web_sessions').get() as { n: number }).n).toBe(0);
    const port = web!.address()!.port;
    const r = await fetch(`http://127.0.0.1:${port}/dashboard/auth/login`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect((await fetch(`http://127.0.0.1:${port}/dashboard/api/me`)).status).toBe(401);
  });

  const endpoints: Server[] = [];
  afterEach(async () => {
    for (const s of endpoints.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  });
  /**
   * startDashboard's own wiring, with a Google that says yes: the real code exchanger posts to a fake token endpoint
   * on 127.0.0.1 (which records each form), and the verifier returns good claims carrying the nonce from the last
   * authorize redirect. Requests go through node:http so the Host header can be set.
   */
  async function bootSignIn(o: { publicUrl?: string } = {}) {
    const forms: URLSearchParams[] = [];
    const ep = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (ch: Buffer) => chunks.push(ch));
      req.on('end', () => {
        forms.push(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id_token: 'ID-TOKEN-x', access_token: 'ACCESS-x' }));
      });
    });
    await new Promise<void>((r) => ep.listen(0, '127.0.0.1', r));
    endpoints.push(ep);
    const db = memDb();
    let nonce: string | undefined;
    const c = capture();
    const env = { ...dashEnv(0), ...(o.publicUrl === undefined ? {} : { DASHBOARD_PUBLIC_URL: o.publicUrl }) };
    const web = await startDashboard({
      env,
      db,
      log: c.log,
      control: {},
      google: {
        tokenUrl: `http://127.0.0.1:${(ep.address() as AddressInfo).port}/token`,
        verifier: async () => ({
          iss: 'https://accounts.google.com',
          aud: 'client-id',
          exp: Date.now() / 1000 + 3600,
          nonce,
          email: 'owner@example.com',
          email_verified: true,
        }),
      },
    });
    servers.push(web!);
    const port = web!.address()!.port;
    const get = async (path: string, headers: Record<string, string> = {}) => {
      const r = await rawGet(port, path, headers);
      const loc = r.headers.location;
      if (typeof loc === 'string' && loc.startsWith('https://accounts.google.com/')) nonce = new URL(loc).searchParams.get('nonce') ?? undefined;
      return r;
    };
    return { db, port, forms, get, ...c };
  }
  const cookiesOf = (r: { headers: Record<string, string | string[] | undefined> }) => {
    const v = r.headers['set-cookie'];
    return v === undefined ? [] : Array.isArray(v) ? v : [v];
  };
  const cookieValue = (r: { headers: Record<string, string | string[] | undefined> }, name: string) =>
    cookiesOf(r).find((s) => s.startsWith(`${name}=`))?.slice(name.length + 1).split(';')[0];
  async function fullSignIn(b: Awaited<ReturnType<typeof bootSignIn>>, headers: Record<string, string> = {}) {
    const l = await b.get('/dashboard/auth/login', headers);
    expect(l.status).toBe(302);
    const google = new URL(l.headers.location as string);
    const state = google.searchParams.get('state')!;
    const signin = cookieValue(l, 'wa_signin')!;
    const cb = await b.get(`/dashboard/auth/callback?code=CODE-x&state=${encodeURIComponent(state)}`, { ...headers, cookie: `wa_signin=${signin}` });
    return { l, google, cb };
  }

  it('signs the owner in through the public https address: its redirect_uri, Secure cookies, the client secret sent', async () => {
    const b = await bootSignIn({ publicUrl: 'https://dash.example.com' });
    const host = { host: 'dash.example.com' };
    const { l, google, cb } = await fullSignIn(b, host);
    expect(google.searchParams.get('redirect_uri')).toBe('https://dash.example.com/dashboard/auth/callback');
    expect(google.searchParams.get('client_id')).toBe('client-id');
    for (const c of cookiesOf(l)) expect(c).toMatch(/; Secure$/);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('/dashboard');
    const cookies = cookiesOf(cb);
    expect(cookies.some((c) => c.startsWith('wa_session='))).toBe(true);
    for (const c of cookies) expect(c).toMatch(/; Secure$/);
    // The production code exchanger posted the web client's id and secret, and the same redirect_uri.
    expect(b.forms).toHaveLength(1);
    expect(b.forms[0]!.get('client_id')).toBe('client-id');
    expect(b.forms[0]!.get('client_secret')).toBe('client-secret');
    expect(b.forms[0]!.get('redirect_uri')).toBe('https://dash.example.com/dashboard/auth/callback');
    expect((b.db.prepare('SELECT COUNT(*) AS n FROM web_sessions').get() as { n: number }).n).toBe(1);
    expect(b.out()).not.toContain('client-secret');
  });

  it('a sign-in whose audit row cannot be written leaves no session (one database transaction)', async () => {
    const b = await bootSignIn();
    b.db.exec(`CREATE TRIGGER t_fail_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit down'); END`);
    const { cb } = await fullSignIn(b);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('/dashboard?error=signin');
    expect(cookiesOf(cb).some((c) => c.startsWith('wa_session='))).toBe(false);
    expect((b.db.prepare('SELECT COUNT(*) AS n FROM web_sessions').get() as { n: number }).n).toBe(0);
  });

  it('sign-in is limited to 10 a minute per client: the 11th goes to the sign-in error page', async () => {
    const b = await bootSignIn();
    for (let i = 0; i < 10; i++) expect((await b.get('/dashboard/auth/login')).headers.location).toMatch(/^https:\/\/accounts\.google\.com\//);
    const over = await b.get('/dashboard/auth/login');
    expect(over.status).toBe(302);
    expect(over.headers.location).toBe('/dashboard?error=signin');
    expect(Number(over.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ['no client id', { DASHBOARD_GOOGLE_CLIENT_ID: undefined }],
    ['no client secret', { DASHBOARD_GOOGLE_CLIENT_SECRET: undefined }],
    ['an empty owner list', { DASHBOARD_OWNER_EMAILS: [] as string[] }],
  ])('%s: the dashboard does not start (and says so without values)', async (_what, patch) => {
    const c = capture();
    const env = { ...dashEnv(0), ...patch };
    const web = await startDashboard({ env, db: memDb(), log: c.log, control: {}, google: fakeGoogle });
    if (web !== undefined) servers.push(web);
    expect(web).toBeUndefined();
    expect(c.out()).toContain('dashboard not started');
    for (const value of ['client-id', 'client-secret', 'owner@example.com']) expect(c.out()).not.toContain(value);
  });
});

describe('web server: session purge', () => {
  async function bootWith(sessions: { purgeExpired(): number }, purgeEveryMs: number) {
    const c = capture();
    const server = createWebServer({
      control: {},
      env: { DASHBOARD_PORT: 0 },
      log: c.log,
      clock: manualClock('2026-10-27T10:00:00Z'),
      sessions,
      purgeEveryMs,
    });
    servers.push(server);
    await server.start();
    return { server, ...c };
  }

  it('purges expired sessions at start and then on every interval, and stops with the server', async () => {
    let calls = 0;
    const { server } = await bootWith({ purgeExpired: () => (calls++, 0) }, 20);
    expect(calls).toBe(1);
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(3), { timeout: 2_000 });
    await server.stop();
    const after = calls;
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toBe(after);
  });

  it('a purge that fails is logged by its code only and the server carries on', async () => {
    const { server, records, out } = await bootWith({
      purgeExpired: () => {
        throw Object.assign(new Error('SQLITE_BUSY: wa_session=SECRETVALUE'), { code: 'SQLITE_BUSY' });
      },
    }, 60_000);
    const errors = records().filter((l) => l.level === 50);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe('SQLITE_BUSY');
    expect(out()).not.toContain('SECRETVALUE');
    const res = await fetch(`http://127.0.0.1:${server.address()!.port}/nope`);
    expect(res.status).toBe(404);
  });

  it('runs the purge hourly by default', () => {
    expect(SESSION_PURGE_EVERY_MS).toBe(3_600_000);
  });
});
