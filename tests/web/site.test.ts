import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DestinationStream } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { manualClock } from '../../src/util/clock.ts';
import { createLogger } from '../../src/util/logger.ts';
import { CONTENT_SECURITY_POLICY } from '../../src/web/http.ts';
import { createWebServer, type WebServer } from '../../src/web/server.ts';
import { inlineScriptHashes, SITE_DIR, sitePolicy } from '../../src/web/site.ts';

const FIXTURE = fileURLToPath(new URL('../fixtures/site/', import.meta.url));
const SECRET = 'OUTSIDE-SITE-SECRET-91c2';
const sha = (s: string) => `sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}`;

const servers: WebServer[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A copy of the fixture site in a temp folder, with a secret file beside it (outside the site). */
function siteCopy(): { root: string; site: string } {
  const root = mkdtempSync(join(tmpdir(), 'wa-site-'));
  roots.push(root);
  const site = join(root, 'site');
  cpSync(FIXTURE, site, { recursive: true });
  writeFileSync(join(root, 'secret.html'), `<p>${SECRET}</p>`);
  writeFileSync(join(root, 'secret.json'), JSON.stringify({ secret: SECRET }));
  return { root, site };
}

async function boot(siteDir: string | undefined) {
  const lines: string[] = [];
  const dest = { write: (s: string) => { lines.push(s); } } as unknown as DestinationStream;
  const root = mkdtempSync(join(tmpdir(), 'wa-site-pub-'));
  roots.push(root);
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>shell</title>');
  const server = createWebServer({
    control: {}, env: { DASHBOARD_PORT: 0 }, log: createLogger('info', dest), clock: manualClock('2026-10-27T10:00:00Z'), publicDir: root,
    ...(siteDir === undefined ? {} : { siteDir }),
  });
  servers.push(server);
  const { port } = await server.start();
  return { port, log: () => lines.join('') };
}

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function get(port: number, path: string, o: { method?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', headers: o.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.end();
  });
}

describe('inlineScriptHashes and sitePolicy', () => {
  it('hashes inline scripts that run, never src scripts or data blocks', () => {
    const html = '<script>a()</script><script src="/x.js"></script><script type="application/json">{"a":1}</script>' +
      '<script type="module">b()</script><SCRIPT TYPE="text/javascript">c()</SCRIPT><script>a()</script>';
    expect(inlineScriptHashes(html)).toEqual([sha('a()'), sha('b()'), sha('c()')]);
  });

  it("lists the hashes after 'self', with no unsafe-eval and no framing", () => {
    const p = sitePolicy([sha('a()')]);
    expect(p).toContain(`script-src 'self' '${sha('a()')}'`);
    expect(p).toContain("frame-ancestors 'none'");
    expect(p).not.toContain('unsafe-eval');
    expect(p).not.toMatch(/script-src[^;]*unsafe-inline/);
  });
});

describe('the website at /', () => {
  it('serves index.html at /, x.html at /x and x/index.html at /x/ and /x', async () => {
    const { port } = await boot(FIXTURE);
    expect(await get(port, '/')).toMatchObject({ status: 200, body: expect.stringContaining('<h1>Home</h1>') });
    expect((await get(port, '/about')).body).toContain('<h1>About</h1>');
    expect((await get(port, '/about.html')).body).toContain('<h1>About</h1>');
    expect((await get(port, '/docs')).body).toContain('Docs index');
    expect((await get(port, '/docs/')).body).toContain('Docs index');
    expect((await get(port, '/index')).body).toContain('<h1>Home</h1>');
  });

  it('gives each page a policy with the hashes of its own inline scripts', async () => {
    const { port } = await boot(FIXTURE);
    const home = await get(port, '/');
    const csp = String(home.headers['content-security-policy']);
    expect(csp).toContain(`'${sha('window.a=1;')}'`);
    expect(csp).toContain(`'${sha('import("/x.js");')}'`);
    expect(csp).not.toContain(sha('window.about=true;'));
    expect(csp).not.toContain(sha('{"@type":"Organization"}'));
    expect(String((await get(port, '/about')).headers['content-security-policy'])).toContain(sha('window.about=true;'));
    expect(csp).not.toBe(CONTENT_SECURITY_POLICY);
    expect(home.headers['x-content-type-options']).toBe('nosniff');
    expect(home.headers['referrer-policy']).toBe('same-origin');
  });

  it('answers unknown paths with 404.html and status 404', async () => {
    const { port } = await boot(FIXTURE);
    for (const path of ['/nope', '/nope/', '/docs/nope', '/missing.css']) {
      const r = await get(port, path);
      expect(r.status, path).toBe(404);
      expect(r.body, path).toContain('Page not found');
      expect(String(r.headers['content-security-policy'])).toContain(sha('window.nf=1;'));
    }
  });

  it('serves only allowlisted types, and no hidden files', async () => {
    const { port } = await boot(FIXTURE);
    expect(await get(port, '/style.css')).toMatchObject({ status: 200, headers: { 'content-type': 'text/css; charset=utf-8' } });
    expect(await get(port, '/data.json')).toMatchObject({ status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
    expect(await get(port, '/images/logo.png')).toMatchObject({ status: 200, headers: { 'content-type': 'image/png' } });
    expect((await get(port, '/notes.md')).status).toBe(404);
    expect((await get(port, '/.hidden.html')).status).toBe(404);
    expect((await get(port, '/.hidden')).status).toBe(404);
  });

  it('caches hashed build files for a year, other files for an hour, and never HTML', async () => {
    const { port } = await boot(FIXTURE);
    expect((await get(port, '/_next/static/chunks/app-1a2b3c.js')).headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await get(port, '/style.css')).headers['cache-control']).toBe('public, max-age=3600');
    expect((await get(port, '/')).headers['cache-control']).toBe('no-cache');
    expect((await get(port, '/about')).headers['cache-control']).toBe('no-cache');
    expect((await get(port, '/nope')).headers['cache-control']).toBe('no-cache');
  });

  it('answers HEAD without a body, a matching ETag with 304, and refuses other methods', async () => {
    const { port } = await boot(FIXTURE);
    const head = await get(port, '/about', { method: 'HEAD' });
    expect(head).toMatchObject({ status: 200, body: '' });
    expect(Number(head.headers['content-length'])).toBeGreaterThan(0);
    const etag = String((await get(port, '/style.css')).headers.etag);
    expect((await get(port, '/style.css', { headers: { 'if-none-match': etag } })).status).toBe(304);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const r = await get(port, '/', { method });
      expect(r.status, method).toBe(405);
      expect(r.headers.allow).toBe('GET, HEAD');
    }
  });

  it('never serves anything outside the folder, whatever the path', async () => {
    const { site } = siteCopy();
    const { port } = await boot(site);
    const paths = [
      '/../secret.html', '/..%2fsecret.html', '/%2e%2e/secret.html', '/%2E%2E%2Fsecret.json', '/docs/../../secret.html', '/..\\secret.html',
      '/%5c..%5csecret.html', '/secret.html%00.css', '/%00', '//secret.html', '/C:/Windows/win.ini', '/C:%5cWindows%5cwin.ini',
      `/${encodeURIComponent(join(site, '..', 'secret.html'))}`, '/docs/%2e%2e%2f%2e%2e%2fsecret.json', '/.%2e/secret.html', '/docs/..',
    ];
    for (const path of paths) {
      const r = await get(port, path);
      expect(r.body, path).not.toContain(SECRET);
      expect(r.status, path).toBe(404);
    }
  });

  it('refuses a link inside the folder that points outside it (junction: runs on Windows without admin)', async () => {
    const { root, site } = siteCopy();
    symlinkSync(root, join(site, 'escape'), 'junction');
    const { port } = await boot(site);
    for (const path of ['/escape/secret.html', '/escape/secret', '/escape/secret.json']) {
      const r = await get(port, path);
      expect(r.body, path).not.toContain(SECRET);
      expect(r.status, path).toBe(404);
    }
  });

  it('leaves /dashboard to the dashboard', async () => {
    const { port } = await boot(FIXTURE);
    expect((await get(port, '/dashboard')).body).toContain('<title>shell</title>');
    expect((await get(port, '/dashboard/api/nope')).headers['content-type']).toMatch(/^application\/json/);
    expect(String((await get(port, '/dashboard')).headers['content-security-policy'])).toBe(CONTENT_SECURITY_POLICY);
  });

  it('logs requests by the route pattern only, never the path', async () => {
    const { port, log } = await boot(FIXTURE);
    await get(port, '/docs/secret-looking-path?token=abc');
    expect(log()).toContain('"route":"/*"');
    expect(log()).not.toContain('secret-looking-path');
    expect(log()).not.toContain('token=abc');
  });
});

describe('without the website folder', () => {
  it('/ says the website is not installed, other paths are 404, and the dashboard still works', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wa-nosite-'));
    roots.push(root);
    const { port } = await boot(join(root, 'site'));
    const home = await get(port, '/');
    expect(home).toMatchObject({ status: 200, body: expect.stringContaining('Website not installed') });
    expect(home.headers['cache-control']).toBe('no-cache');
    expect((await get(port, '/about')).status).toBe(404);
    expect((await get(port, '/dashboard')).body).toContain('<title>shell</title>');
  });

  it('a server made without a site folder serves no website (the core server as before)', async () => {
    const { port } = await boot(undefined);
    const r = await get(port, '/');
    expect(r.status).toBe(404);
    expect(r.headers['content-type']).toMatch(/^application\/json/);
  });

  it("the real site folder is the repo's site/", () => {
    expect(SITE_DIR.replaceAll('\\', '/')).toMatch(/\/site\/$/);
  });
});
