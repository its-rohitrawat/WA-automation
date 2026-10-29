import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from '../config/env.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { HttpError, requestId, securityHeaders, sendError } from './http.ts';
import { createRouter } from './router.ts';
import type { Router } from './router.ts';
import { createSite } from './site.ts';

/** The front-end files (`index.html`, scripts, styles), served under `/dashboard/static/`. */
export const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));

const nodeModule = (path: string) => fileURLToPath(new URL(`../../node_modules/${path}`, import.meta.url));

/**
 * The fixed allowlist of third-party files served under `/dashboard/vendor/<name>`: published name to absolute file
 * path. Nothing else under `node_modules` is reachable. Versions are pinned exactly in package.json.
 * three.js imports './three.core.js', which resolves to the second Three.js entry here.
 */
export const VENDOR_FILES: Readonly<Record<string, string>> = Object.freeze({
  'gsap.js': nodeModule('gsap/dist/gsap.min.js'),
  'three.js': nodeModule('three/build/three.module.js'),
  'three.core.js': nodeModule('three/build/three.core.js'),
});

/** The only file types served. Anything else is a 404. */
export const MIME: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
});

/** How long stop() waits for requests in flight before cutting the remaining connections. */
export const STOP_GRACE_MS = 5_000;
/** How often expired and idle owner sessions are removed while the server runs (also once at start). */
export const SESSION_PURGE_EVERY_MS = 3_600_000;
/** First path segments under /dashboard that are never a front-end screen. */
const RESERVED = new Set(['api', 'static', 'vendor', 'auth', 'connect']);
const SCREEN_SEGMENT = /^[a-z][a-z0-9-]{0,39}$/;
const FILE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

export interface WebServerDeps {
  /** The AgentControl (task 5): the only way the web layer reaches the agent. The core server does not call it. */
  control: object;
  env: Pick<Env, 'DASHBOARD_PORT'>;
  log: Logger;
  clock: Clock;
  /** The owner sessions (task 3): purged at start and then hourly while the server runs. */
  sessions?: { purgeExpired(): Promise<number> };
  /** Tests only: how often sessions are purged (default hourly). */
  purgeEveryMs?: number;
  /** Tests only: another public folder. */
  publicDir?: string;
  /** Tests only: another vendor allowlist. */
  vendorFiles?: Readonly<Record<string, string>>;
  /** Tests only: how long stop() waits for requests in flight (default 5 s). */
  stopGraceMs?: number;
  /** Tests only: receives the underlying Node server once it is made. */
  onHttpServer?: (server: Server) => void;
  /** The website's folder, served for every path outside /dashboard (src/web/site.ts). Not given: no website. */
  siteDir?: string;
}

export interface WebServer {
  /** Routes are added here (auth and API routes in later tasks). */
  readonly router: Router;
  start(): Promise<{ port: number; host: string }>;
  /** Stops accepting, closes idle connections, waits for requests in flight (up to 5 s), then closes the rest. */
  stop(): Promise<void>;
  /** The bound address while listening, else null. */
  address(): AddressInfo | null;
}

/**
 * The raw path of a request, or undefined when it is not something this server would ever serve: not origin-form,
 * empty segments, `.` or `..` segments (plain or percent-encoded), backslashes, encoded slashes or NUL bytes. All such
 * requests get a plain 404 before any routing.
 */
function safePathname(rawUrl: string): string | undefined {
  if (!rawUrl.startsWith('/')) return undefined;
  const q = rawUrl.search(/[?#]/);
  const path = q < 0 ? rawUrl : rawUrl.slice(0, q);
  if (/\\|%5c|%2f|%00|%2e|\0/i.test(path)) return undefined;
  const segments = path.slice(1).split('/');
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    if (s === '.' || s === '..') return undefined;
    // An empty segment is allowed only as the trailing slash of a path.
    if (s === '' && i !== segments.length - 1) return undefined;
  }
  return path;
}

/**
 * `/dashboard`, `/dashboard/` and `/dashboard/<screen>[/<sub>[/<sub>]]` in lower-case words, with or without one trailing
 * slash: the front end routes these.
 */
function isScreenPath(pathname: string): boolean {
  if (pathname === '/dashboard' || pathname === '/dashboard/') return true;
  if (!pathname.startsWith('/dashboard/')) return false;
  const segs = pathname.slice('/dashboard/'.length).split('/');
  if (segs.length > 1 && segs.at(-1) === '') segs.pop();
  if (segs.length > 3 || RESERVED.has(segs[0]!)) return false;
  return segs.every((s) => SCREEN_SEGMENT.test(s));
}

function etagOf(body: Buffer): string {
  return `"${createHash('sha1').update(body).digest('base64url')}"`;
}

/** Sends a file's bytes with its type, an ETag and the given cache rule; 304 when the browser already has it. */
function sendFile(req: IncomingMessage, res: ServerResponse, body: Buffer, type: string, cache: string): void {
  const etag = etagOf(body);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', cache);
  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', body.length);
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** Reads a file that must sit inside `root` (after resolving links). Undefined when it is missing or outside. */
async function readInside(root: string, file: string): Promise<Buffer | undefined> {
  try {
    const realRoot = await realpath(root);
    const real = await realpath(file);
    if (!real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) return undefined;
    return await readFile(real);
  } catch {
    return undefined;
  }
}

/** A file under the public folder by its path below `/dashboard/static/`, or undefined for anything not safely inside. */
async function readPublic(root: string, rel: string): Promise<Buffer | undefined> {
  const parts = rel.split('/');
  const decoded: string[] = [];
  for (const p of parts) {
    let d: string;
    try {
      d = decodeURIComponent(p);
    } catch {
      return undefined;
    }
    if (!FILE_SEGMENT.test(d)) return undefined;
    decoded.push(d);
  }
  const base = resolve(root);
  const file = resolve(base, ...decoded);
  if (!file.startsWith(base + sep)) return undefined;
  return readInside(base, file);
}

export function createWebServer(deps: WebServerDeps): WebServer {
  const { log } = deps;
  const publicDir = deps.publicDir ?? PUBLIC_DIR;
  const vendorFiles = deps.vendorFiles ?? VENDOR_FILES;
  const router = createRouter();
  const site = deps.siteDir === undefined ? undefined : createSite({ dir: deps.siteDir, log });
  let stopping = false;
  let stopped: Promise<void> | undefined;
  let purgeTimer: NodeJS.Timeout | undefined;

  /** Housekeeping must never stop the server: a failure is logged by its code only. */
  function purgeSessions(): void {
    const failed = (err: unknown) => log.error({ code: (err as { code?: unknown }).code ?? 'unknown' }, 'dashboard session purge failed');
    try {
      void deps.sessions?.purgeExpired().catch(failed);
    } catch (err) {
      failed(err);
    }
  }

  const notFound = (res: ServerResponse) => sendError(res, 404, 'not_found', 'Not found.');

  /** A dashboard path that exists, asked with a method it does not take: 405 with the methods it does. */
  function notAllowed(res: ServerResponse, allow: readonly string[]): void {
    res.setHeader('Allow', allow.join(', '));
    sendError(res, 405, 'method_not_allowed', 'Method not allowed.');
  }

  /** The methods a /dashboard path takes: its routes', and GET and HEAD for the shell, static and vendor files. */
  function allowedFor(pathname: string): string[] {
    const routed = router.methodsFor(pathname).flatMap((m) => (m === 'GET' ? ['GET', 'HEAD'] : [m]));
    const files = pathname.startsWith('/dashboard/static/') || pathname.startsWith('/dashboard/vendor/') || isScreenPath(pathname);
    return [...new Set([...routed, ...(files ? ['GET', 'HEAD'] : [])])];
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, rel: string): Promise<void> {
    const type = MIME[extname(rel).toLowerCase()];
    const body = type === undefined ? undefined : await readPublic(publicDir, rel);
    if (type === undefined || body === undefined) return notFound(res);
    sendFile(req, res, body, type, 'no-cache');
  }

  async function serveVendor(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    const file = Object.hasOwn(vendorFiles, name) ? vendorFiles[name] : undefined;
    const type = MIME[extname(name).toLowerCase()];
    let body: Buffer | undefined;
    if (file !== undefined && type !== undefined) {
      try {
        body = await readFile(file);
      } catch {
        body = undefined;
      }
    }
    if (type === undefined || body === undefined) return notFound(res);
    sendFile(req, res, body, type, 'public, max-age=3600');
  }

  async function serveShell(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readPublic(publicDir, 'index.html');
    if (body === undefined) return notFound(res);
    sendFile(req, res, body, MIME['.html']!, 'no-cache');
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    const rid = requestId();
    const method = req.method ?? 'GET';
    let route = '(unmatched)';
    // One line per request: no full path, no search string, no cookies, no headers. Status 0: the connection closed
    // before the answer was complete (the client gave up, or the answer was cut).
    res.once('close', () => {
      const status = res.writableFinished ? res.statusCode : 0;
      log.info({ rid, method, route, status, ms: Math.round(performance.now() - started) }, 'http');
    });
    securityHeaders(res);
    if (stopping) res.setHeader('Connection', 'close');
    try {
      const pathname = safePathname(req.url ?? '');
      if (pathname === undefined) return notFound(res);
      const match = router.match(method, pathname);
      if (match) {
        route = match.pattern;
        await match.handler({ req, res, params: match.params, url: new URL(req.url ?? '/', 'http://127.0.0.1'), requestId: rid });
        return;
      }
      if (site && pathname !== '/dashboard' && !pathname.startsWith('/dashboard/')) {
        route = '/*';
        return await site.serve(req, res, pathname);
      }
      if (method === 'GET' || method === 'HEAD') {
        if (pathname.startsWith('/dashboard/static/')) {
          route = '/dashboard/static/*';
          return await serveStatic(req, res, pathname.slice('/dashboard/static/'.length));
        }
        if (pathname.startsWith('/dashboard/vendor/')) {
          route = '/dashboard/vendor/*';
          return await serveVendor(req, res, pathname.slice('/dashboard/vendor/'.length));
        }
        if (isScreenPath(pathname)) {
          route = '/dashboard/*';
          return await serveShell(req, res);
        }
      }
      const allow = allowedFor(pathname);
      if (allow.length > 0 && !allow.includes(method)) return notAllowed(res, allow);
      notFound(res);
    } catch (err) {
      if (res.headersSent) {
        log.error({ rid, err }, 'request failed');
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        // A 413 can come while the body is still arriving (or never ends). Node answers, marks the answer
        // `Connection: close` and closes the connection itself when the request is unfinished, so the answer reaches the
        // client and a slow or endless upload cannot hold the connection. Setting that header here, or destroying the
        // request before answering, would reset the connection and lose the 413 (tests pin both halves).
        sendError(res, err.status, err.code, err.message);
        return;
      }
      log.error({ rid, err }, 'request failed');
      sendError(res, 500, 'internal', 'Something went wrong.');
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res);
  });
  // Without a listener, an error the server emits while running (for example EMFILE on accept) would throw, reach
  // main.ts's uncaughtException handler and stop the whole agent. Only the code is logged; start() handles listen errors.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (!server.listening) return;
    log.error({ code: err.code ?? 'unknown' }, 'dashboard server error; the agent carries on');
  });
  deps.onHttpServer?.(server);
  // A connection that finishes its last response during stop() closes at once instead of idling.
  server.on('request', (_req: IncomingMessage, res: ServerResponse) => {
    res.once('finish', () => {
      if (stopping) setImmediate(() => server.closeIdleConnections());
    });
  });

  return {
    router,
    start() {
      return new Promise((resolveStart, rejectStart) => {
        const onError = (err: Error) => rejectStart(err);
        server.once('error', onError);
        server.listen(deps.env.DASHBOARD_PORT, '127.0.0.1', () => {
          server.off('error', onError);
          if (deps.sessions !== undefined && purgeTimer === undefined) {
            purgeSessions();
            purgeTimer = setInterval(purgeSessions, deps.purgeEveryMs ?? SESSION_PURGE_EVERY_MS);
            purgeTimer.unref();
          }
          const a = server.address() as AddressInfo;
          resolveStart({ port: a.port, host: a.address });
        });
      });
    },
    stop() {
      if (purgeTimer !== undefined) {
        clearInterval(purgeTimer);
        purgeTimer = undefined;
      }
      if (stopped) return stopped;
      if (!server.listening) return Promise.resolve();
      stopping = true;
      stopped = new Promise<void>((done) => {
        const force = setTimeout(() => server.closeAllConnections(), deps.stopGraceMs ?? STOP_GRACE_MS);
        force.unref();
        // On Node 19 and later (engines: >=24) close() also closes the connections idle at this moment; the 'finish'
        // hook above closes the ones that go idle later, and new requests during stop get `Connection: close`.
        server.close(() => {
          clearTimeout(force);
          done();
        });
      });
      return stopped;
    },
    address() {
      const a = server.address();
      return a !== null && typeof a === 'object' ? a : null;
    },
  };
}
