import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../util/logger.ts';

// The public website (owner decision, 27 Oct 2026: the agent serves it at /, the dashboard at /dashboard; nothing is
// deployed elsewhere). A static folder, the site's export, served for every path outside /dashboard: GET and HEAD only,
// files of the allowlisted types only, and never anything outside the folder (links included). The site has its own
// Content-Security-Policy: its pages carry inline scripts, so each page's policy lists the SHA-256 of its own inline
// scripts, computed once at startup. No 'unsafe-eval', no framing. Without the folder, / says so and the dashboard works.

/** The repo's site/ folder: the website's static export. */
export const SITE_DIR = fileURLToPath(new URL('../../site/', import.meta.url));

/** The only file types served. Anything else is a 404. */
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
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
});

/** Content-hashed build files: they never change under the same name. */
const IMMUTABLE_PREFIX = '/_next/static/';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const ASSET = 'public, max-age=3600';
const HTML = 'no-cache';

/** A path segment as served: no leading dot (no hidden files), no slash, backslash, colon, NUL or control character. */
const SEGMENT = /^[A-Za-z0-9_~@+-][A-Za-z0-9._~@+-]*$/;
/** HTML files read at startup for their inline scripts: more is not a website. */
const MAX_HTML_FILES = 2_000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;

const BASE_POLICY = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self'",
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

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
/** Types a browser runs; any other type (application/json, ld+json) is data and needs no hash. */
const RUNS = /^(?:|text\/javascript|application\/javascript|module)$/i;

/** The CSP hashes of a page's inline scripts: each one's exact text, SHA-256, base64. In page order, without repeats. */
export function inlineScriptHashes(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(SCRIPT)) {
    const attrs = m[1] ?? '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    if (!RUNS.test((type?.[1] ?? type?.[2] ?? type?.[3] ?? '').trim())) continue;
    out.add(`sha256-${createHash('sha256').update(m[2] ?? '', 'utf8').digest('base64')}`);
  }
  return [...out];
}

const NOT_INSTALLED = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Website not installed</title>' +
  '<p>Website not installed. The owner dashboard is at <a href="/dashboard">/dashboard</a>.</p></html>';

export interface Site {
  /** True when the folder was there at startup. */
  readonly installed: boolean;
  /** Answers one request for a path outside /dashboard. pathname: already checked by the server (no dot segments). */
  serve(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void>;
}

function etagOf(body: Buffer): string {
  return `"${createHash('sha1').update(body).digest('base64url')}"`;
}

/** Every .html file under root (links not followed), at most MAX_HTML_FILES. */
function htmlFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
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
 * Loads the site folder once at startup: checks it is there and computes each page's policy. A missing or unreadable
 * folder is logged by its error code only, and the site answers "Website not installed" at / and 404 elsewhere.
 */
export function createSite(o: { dir: string; log: Logger }): Site {
  let root: string | undefined;
  const policies = new Map<string, string>();
  try {
    if (existsSync(o.dir) && statSync(o.dir).isDirectory()) {
      root = realpathSync(o.dir);
      for (const file of htmlFiles(root)) {
        if (statSync(file).size > MAX_HTML_BYTES) continue;
        policies.set(file, sitePolicy(inlineScriptHashes(readFileSync(file, 'utf8'))));
      }
    }
  } catch (err) {
    o.log.error({ code: (err as { code?: unknown }).code ?? 'unknown' }, 'the website folder could not be read; / shows "Website not installed"');
    root = undefined;
  }
  if (!root) o.log.info({}, 'no website folder; / shows "Website not installed"');
  const plainPolicy = sitePolicy([]);

  /** The real path of a file inside root, or undefined (missing, a folder, or outside root after resolving links). */
  function inside(segments: readonly string[]): string | undefined {
    if (!root) return undefined;
    const file = resolve(root, ...segments);
    if (!file.startsWith(root + sep)) return undefined;
    try {
      const real = realpathSync(file);
      if (!real.startsWith(root + sep) || !statSync(real).isFile()) return undefined;
      return real;
    } catch {
      return undefined;
    }
  }

  /** The file a path names: /x is x.html or x/index.html, / and /x/ are index.html, a path with a type is that file. */
  function find(pathname: string): string | undefined {
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
      if (!SEGMENT.test(d) || d === '.' || d === '..') return undefined;
      segs.push(d);
    }
    if (segs.length === 0) return inside(['index.html']);
    if (trailing) return inside([...segs, 'index.html']);
    const last = segs.at(-1)!;
    if (extname(last) !== '') return Object.hasOwn(SITE_MIME, extname(last).toLowerCase()) ? inside(segs) : undefined;
    return inside([...segs.slice(0, -1), `${last}.html`]) ?? inside([...segs, 'index.html']);
  }

  function send(req: IncomingMessage, res: ServerResponse, o2: { status: number; body: Buffer; type: string; cache: string; policy: string }): void {
    res.setHeader('Content-Security-Policy', o2.policy);
    res.setHeader('Cache-Control', o2.cache);
    const etag = etagOf(o2.body);
    if (o2.status === 200) {
      res.setHeader('ETag', etag);
      if (req.headers['if-none-match'] === etag) {
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

  function policyOf(file: string): string {
    let p = policies.get(file);
    if (p === undefined) {
      // A page added after startup (an update without a restart): its hashes are worked out once, then kept.
      p = sitePolicy(inlineScriptHashes(readFileSync(file, 'utf8')));
      policies.set(file, p);
    }
    return p;
  }

  function notFound(req: IncomingMessage, res: ServerResponse): void {
    const page = inside(['404.html']);
    if (page) {
      send(req, res, { status: 404, body: readFileSync(page), type: SITE_MIME['.html']!, cache: HTML, policy: policyOf(page) });
      return;
    }
    send(req, res, { status: 404, body: Buffer.from('Not found.'), type: SITE_MIME['.txt']!, cache: HTML, policy: plainPolicy });
  }

  return {
    installed: root !== undefined,
    async serve(req, res, pathname) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        send(req, res, { status: 405, body: Buffer.from('Method not allowed.'), type: SITE_MIME['.txt']!, cache: HTML, policy: plainPolicy });
        return;
      }
      if (!root) {
        if (pathname === '/') {
          send(req, res, { status: 200, body: Buffer.from(NOT_INSTALLED), type: SITE_MIME['.html']!, cache: HTML, policy: plainPolicy });
        } else {
          send(req, res, { status: 404, body: Buffer.from('Not found.'), type: SITE_MIME['.txt']!, cache: HTML, policy: plainPolicy });
        }
        return;
      }
      const file = find(pathname);
      if (!file) return notFound(req, res);
      let body: Buffer;
      try {
        body = readFileSync(file);
      } catch {
        return notFound(req, res);
      }
      const ext = extname(file).toLowerCase();
      const type = SITE_MIME[ext];
      if (type === undefined) return notFound(req, res);
      const html = ext === '.html';
      const cache = html ? HTML : pathname.startsWith(IMMUTABLE_PREFIX) ? IMMUTABLE : ASSET;
      send(req, res, { status: 200, body, type, cache, policy: html ? policyOf(file) : plainPolicy });
    },
  };
}
