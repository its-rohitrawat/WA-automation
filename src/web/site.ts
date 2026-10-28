import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../util/logger.ts';

// The public website (owner decision, 27 Oct 2026: the agent serves it at /, the dashboard at /dashboard; nothing is
// deployed elsewhere). A static folder, the site's export, served for every path outside /dashboard: GET and HEAD only,
// files of the allowlisted types only, and never anything outside the folder or hidden inside it (links and Windows
// short names included). The site has its own Content-Security-Policy: its pages carry inline scripts, so each page's
// policy lists the SHA-256 of that page's own inline scripts. They are worked out at startup for every page, and again
// for a page whose content changed since: the cache is keyed by the content, so a policy always matches what is sent.
// No 'unsafe-eval', no framing. Without the folder, / says so and the dashboard works.
// A file swapped for a link between the check and the read is not caught: that needs write access to the site folder.

/** The repo's site/ folder: the website's static export. */
export const SITE_DIR = fileURLToPath(new URL('../../site/', import.meta.url));

/**
 * The only file types served. Anything else is a 404. No video: serving it well needs range requests (Safari plays
 * nothing without them), which this small server does not do.
 */
export const SITE_MIME: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
});

/** Content-hashed build files: they never change under the same name. */
const IMMUTABLE_PREFIX = '/_next/static/';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const ASSET = 'public, max-age=3600';
const HTML = 'no-cache';

/** A path segment as served: no leading dot (no hidden files), no slash, backslash, colon, NUL, tilde or control character. */
export const SEGMENT = /^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*$/;
/** The biggest file served, and the biggest page read for its scripts. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
/** Pages read at startup, and policies kept (oldest dropped first). */
const MAX_HTML_FILES = 2_000;
const MAX_POLICIES = 4_000;

const BASE_POLICY = [
  "default-src 'self'",
  // The export has no <style> tags; React writes style="..." attributes, so only those are allowed inline.
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
];

/** The site's policy for a page with these inline-script hashes ("sha256-…"). */
export function sitePolicy(hashes: readonly string[]): string {
  const scripts = ["'self'", ...hashes.map((h) => `'${h}'`)].join(' ');
  return [BASE_POLICY[0], `script-src ${scripts}`, ...BASE_POLICY.slice(1)].join('; ');
}

/** A script tag's attributes may hold quoted ">" characters; the content runs to the first closing tag, as a browser reads it. */
const SCRIPT = /<script((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>([\s\S]*?)<\/script\s*>/gi;
const ATTR = /\s([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
/** Types a browser runs or reads under script-src; any other type (application/json, ld+json) is data and needs no hash. */
const RUNS = /^(?:|text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript|module|importmap|speculationrules)$/i;

/**
 * The CSP hashes of a page's inline scripts: each one's text as the browser hashes it (line breaks made LF), SHA-256,
 * base64. In page order, without repeats.
 */
export function inlineScriptHashes(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(SCRIPT)) {
    const attrs = new Map<string, string>();
    for (const a of (m[1] ?? '').matchAll(ATTR)) {
      const name = a[1]!.toLowerCase();
      if (!attrs.has(name)) attrs.set(name, a[2] ?? a[3] ?? a[4] ?? ''); // a repeated attribute: the first counts, as in a browser
    }
    if (attrs.has('src')) continue;
    if (!RUNS.test((attrs.get('type') ?? '').trim())) continue;
    const text = (m[2] ?? '').replace(/\r\n?/g, '\n');
    out.add(`sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`);
  }
  return [...out];
}

const NOT_INSTALLED = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Website not installed</title>' +
  '<p>Website not installed. The owner dashboard is at <a href="/dashboard">/dashboard</a>.</p></html>';

export interface Site {
  /** True when the folder was there at startup. */
  readonly installed: boolean;
  /** How many pages had their policy worked out at startup. */
  readonly warmed: number;
  /** Answers one request for a path outside /dashboard. pathname: already checked by the server (no dot segments). */
  serve(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void>;
}

const contentKey = (body: Buffer) => createHash('sha1').update(body).digest('base64url');

/** Pages read at the same time; more get a 503 for a moment, so a flood of requests cannot fill the agent's memory. */
export const MAX_PAGE_READS = 16;

/** Whether an If-None-Match header names this ETag: a list, weak tags (W/"…", as a proxy may send) and * included. */
export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const opaque = etag.replace(/^W\//, '');
  return String(header)
    .split(',')
    .map((t) => t.trim())
    .some((t) => t === '*' || t.replace(/^W\//, '') === opaque);
}

/** Every .html file under root (links not followed), at most MAX_HTML_FILES. A folder that cannot be read is skipped. */
function htmlFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_HTML_FILES) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.html')) out.push(p);
    }
  };
  walk(root);
  return out;
}

/**
 * Loads the site folder once at startup: checks it is there and works out each page's policy. A missing folder is
 * logged as such; a page that cannot be read is skipped (its policy is worked out when it is served).
 */
export function createSite(o: { dir: string; log: Logger; /** Tests only: reads a page at startup. */ readPage?: (file: string) => Buffer }): Site {
  let root: string | undefined;
  const policies = new Map<string, string>();
  const readPage = o.readPage ?? ((file: string) => readFileSync(file));
  let pageReads = 0;

  function policyFor(body: Buffer): string {
    const key = contentKey(body);
    let p = policies.get(key);
    if (p === undefined) {
      p = sitePolicy(inlineScriptHashes(body.toString('utf8')));
      if (policies.size >= MAX_POLICIES) policies.delete(policies.keys().next().value!);
      policies.set(key, p);
    }
    return p;
  }

  try {
    // The native realpath gives each name as it is on disk (a Windows short name expands to the long one).
    if (existsSync(o.dir) && statSync(o.dir).isDirectory()) root = realpathSync.native(o.dir);
  } catch (err) {
    o.log.error({ code: (err as { code?: unknown }).code ?? 'unknown' }, 'the website folder could not be opened; / shows "Website not installed"');
    root = undefined;
  }
  let warmed = 0;
  if (root) {
    for (const file of htmlFiles(root)) {
      try {
        if (statSync(file).size > MAX_HTML_BYTES) continue;
        policyFor(readPage(file));
        warmed++;
      } catch {
        // Skipped: worked out when the page is served.
      }
    }
  } else {
    o.log.info({}, 'no website folder; / shows "Website not installed"');
  }
  const plainPolicy = sitePolicy([]);

  /**
   * The real path of a file inside root, or undefined: missing, a folder, too big, or, once links and short names are
   * resolved, outside root or below a hidden or oddly named entry.
   */
  async function inside(segments: readonly string[]): Promise<string | undefined> {
    if (!root) return undefined;
    const file = resolve(root, ...segments);
    if (!file.startsWith(root + sep)) return undefined;
    try {
      const real = realpathSync.native(file);
      const rel = relative(root, real);
      if (rel === '' || rel.startsWith('..') || resolve(root, rel) !== real) return undefined;
      if (!rel.split(sep).every((s) => SEGMENT.test(s))) return undefined;
      const st = await stat(real);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return undefined;
      return real;
    } catch {
      return undefined;
    }
  }

  /** The file a path names: /x is x.html or x/index.html, / and /x/ are index.html, a path with a type is that file. */
  async function find(pathname: string): Promise<string | undefined> {
    const raw = pathname.slice(1).split('/');
    const trailing = raw.at(-1) === '';
    if (trailing) raw.pop();
    const segs: string[] = [];
    for (const r of raw) {
      let d: string;
      try {
        d = decodeURIComponent(r);
      } catch {
        return undefined;
      }
      if (!SEGMENT.test(d)) return undefined;
      segs.push(d);
    }
    if (segs.length === 0) return inside(['index.html']);
    if (trailing) return inside([...segs, 'index.html']);
    const last = segs.at(-1)!;
    if (extname(last) !== '') return Object.hasOwn(SITE_MIME, extname(last).toLowerCase()) ? inside(segs) : undefined;
    return (await inside([...segs.slice(0, -1), `${last}.html`])) ?? inside([...segs, 'index.html']);
  }

  function send(req: IncomingMessage, res: ServerResponse, o2: { status: number; body: Buffer; type: string; cache: string; policy: string }): void {
    res.setHeader('Content-Security-Policy', o2.policy);
    res.setHeader('Cache-Control', o2.cache);
    if (o2.status === 200) {
      const etag = `"${contentKey(o2.body)}"`;
      res.setHeader('ETag', etag);
      if (etagMatches(req.headers['if-none-match'], etag)) {
        res.statusCode = 304;
        res.end();
        return;
      }
    }
    res.statusCode = o2.status;
    res.setHeader('Content-Type', o2.type);
    res.setHeader('Content-Length', o2.body.length);
    res.end(req.method === 'HEAD' ? undefined : o2.body);
  }

  const plain = (req: IncomingMessage, res: ServerResponse, status: number, text: string) =>
    send(req, res, { status, body: Buffer.from(text), type: SITE_MIME['.txt']!, cache: HTML, policy: plainPolicy });

  async function notFound(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const page = await inside(['404.html']);
    if (page) {
      try {
        const body = await readFile(page);
        send(req, res, { status: 404, body, type: SITE_MIME['.html']!, cache: HTML, policy: policyFor(body) });
        return;
      } catch {
        // falls through to the plain answer
      }
    }
    plain(req, res, 404, 'Not found.');
  }

  return {
    installed: root !== undefined,
    warmed,
    async serve(req, res, pathname) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        plain(req, res, 405, 'Method not allowed.');
        return;
      }
      // A service worker from the site would control every path on this origin, /dashboard included: none is served.
      if (req.headers['service-worker'] !== undefined) return plain(req, res, 404, 'Not found.');
      if (!root) {
        if (pathname === '/') {
          send(req, res, { status: 200, body: Buffer.from(NOT_INSTALLED), type: SITE_MIME['.html']!, cache: HTML, policy: plainPolicy });
        } else {
          plain(req, res, 404, 'Not found.');
        }
        return;
      }
      const file = await find(pathname);
      if (!file) return notFound(req, res);
      const ext = extname(file).toLowerCase();
      const type = SITE_MIME[ext];
      if (type === undefined) return notFound(req, res);
      // The router's .txt payloads change with every build, like the pages: never kept stale.
      if (ext !== '.html') return streamFile(req, res, file, type, pathname.startsWith(IMMUTABLE_PREFIX) ? IMMUTABLE : ext === '.txt' ? HTML : ASSET);
      // A page is read whole, for its policy: a few at a time.
      if (pageReads >= MAX_PAGE_READS) {
        res.setHeader('Retry-After', '1');
        return plain(req, res, 503, 'Busy, try again in a moment.');
      }
      pageReads++;
      let body: Buffer;
      try {
        body = await readFile(file);
      } catch {
        return notFound(req, res);
      } finally {
        pageReads--;
      }
      if (body.length > MAX_HTML_BYTES) return notFound(req, res);
      send(req, res, { status: 200, body, type, cache: HTML, policy: policyFor(body) });
    },
  };

  /** Any other file is streamed from disk, never held whole; its ETag comes from its size and change time. */
  async function streamFile(req: IncomingMessage, res: ServerResponse, file: string, type: string, cache: string): Promise<void> {
    let st;
    try {
      st = await stat(file);
    } catch {
      return notFound(req, res);
    }
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    res.setHeader('Content-Security-Policy', plainPolicy);
    res.setHeader('Cache-Control', cache);
    res.setHeader('ETag', etag);
    if (etagMatches(req.headers['if-none-match'], etag)) {
      res.statusCode = 304;
      res.end();
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Length', st.size);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    await new Promise<void>((done) => {
      const stream = createReadStream(file);
      stream.on('error', () => {
        res.destroy(); // the headers are out: the answer can only be cut
        done();
      });
      res.on('close', () => {
        stream.destroy();
        done();
      });
      stream.pipe(res);
    });
  }
}
