import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importSite, inspectSite } from '../../scripts/site-import.ts';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PAGE = '<!doctype html><html><head><script src="/_next/static/chunks/a.js"></script></head><body><a href="/dashboard">Sign in</a><script>self.__next_f=[]</script></body></html>';

/** A temp folder with an export holding these files (path → text), and an empty place for site/. */
function setup(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'wa-site-import-'));
  dirs.push(root);
  const out = join(root, 'out');
  for (const [path, text] of Object.entries(files)) {
    const file = join(out, ...path.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return { out, site: join(root, 'site') };
}

const GOOD = { 'index.html': PAGE, '404.html': PAGE, 'demo.html': PAGE, 'demo/__next.demo.__PAGE__.txt': '0:{}', '_next/static/chunks/a.js': 'x()', '_next/static/css/a.css': 'a{color:red}' };
const quiet = () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  return vi.spyOn(console, 'error').mockImplementation(() => {});
};

describe('site import', () => {
  it('copies a clean export into site/ and lists each page with inline scripts', async () => {
    const { out, site } = setup(GOOD);
    quiet();
    expect(await importSite(out, site)).toBe(true);
    expect(readFileSync(join(site, 'demo', '__next.demo.__PAGE__.txt'), 'utf8')).toBe('0:{}');
    const r = await inspectSite(site);
    expect(r.problems).toEqual([]);
    expect(r.hashes.map((h) => h.file)).toEqual(['404.html', 'demo.html', 'index.html']);
    expect(existsSync(`${site}.incoming`) || existsSync(`${site}.outgoing`)).toBe(false);
  });

  it('replaces site/ as a whole: a file of the older build does not stay', async () => {
    const { out, site } = setup(GOOD);
    mkdirSync(join(site, '_next', 'static'), { recursive: true });
    writeFileSync(join(site, 'old.html'), PAGE);
    writeFileSync(join(site, '_next', 'static', 'old.js'), 'old()');
    quiet();
    expect(await importSite(out, site)).toBe(true);
    expect(existsSync(join(site, 'old.html'))).toBe(false);
    expect(existsSync(join(site, '_next', 'static', 'old.js'))).toBe(false);
  });

  it.each([
    ['a dashboard path', { 'dashboard/index.html': PAGE }, 'dashboard-path'],
    ['a source map', { '_next/static/chunks/a.js.map': '{}' }, 'source-map'],
    ['a link below /dashboard', { 'contact.html': '<a href="/dashboard/tasks">x</a>' }, 'dashboard-link'],
    ['a script from another origin', { 'contact.html': '<script src="https://cdn.example.com/x.js"></script>' }, 'external-asset'],
    ['a stylesheet from another origin', { 'contact.html': '<link rel="stylesheet" href="//fonts.example.com/a.css">' }, 'external-asset'],
    ['a CSS import from another origin', { '_next/static/css/b.css': '@import url("https://fonts.example.com/a.css");' }, 'external-asset'],
    ['a file type the agent does not serve', { 'notes.md': '# hi' }, 'file-type'],
    ['a name the agent does not serve', { 'a b.html': PAGE }, 'name'],
    ['a file over 2 MB', { '_next/static/chunks/big.js': 'x'.repeat(2 * 1024 * 1024 + 1) }, 'size'],
  ])('refuses %s and leaves site/ as it was', async (_what, extra, rule) => {
    const { out, site } = setup({ ...GOOD, ...extra });
    mkdirSync(site);
    writeFileSync(join(site, 'index.html'), 'the live site');
    const err = quiet();
    expect(await importSite(out, site)).toBe(false);
    expect(readFileSync(join(site, 'index.html'), 'utf8')).toBe('the live site');
    expect(err.mock.calls.flat().join('\n')).toContain(`site-import: ${rule}:`);
    expect(existsSync(`${site}.incoming`)).toBe(false);
  });

  it('refuses something that looks like a key without ever printing it', async () => {
    const key = `sk-${'A1b2C3d4'.repeat(4)}`;
    const { out, site } = setup({ ...GOOD, '_next/static/chunks/k.js': `const k="${key}"` });
    const err = quiet();
    expect(await importSite(out, site)).toBe(false);
    const said = err.mock.calls.flat().join('\n');
    expect(said).toContain('site-import: secret:');
    expect(said).not.toContain(key);
    expect(existsSync(site)).toBe(false);
  });

  it('refuses an export without a home page, a missing folder, and site/ inside the export', async () => {
    const { out, site } = setup({ 'demo.html': PAGE });
    quiet();
    expect(await importSite(out, site)).toBe(false);
    expect(await importSite(join(out, 'missing'), site)).toBe(false);
    const { out: out2 } = setup(GOOD);
    expect(await importSite(out2, join(out2, 'site'))).toBe(false);
  });

  it('refuses a symbolic link in the export', async (ctx) => {
    const { out, site } = setup(GOOD);
    try {
      symlinkSync(join(out, 'index.html'), join(out, 'linked.html'));
    } catch {
      ctx.skip(); // creating links needs extra rights on Windows
    }
    const err = quiet();
    expect(await importSite(out, site)).toBe(false);
    expect(err.mock.calls.flat().join('\n')).toContain('site-import: link:');
  });
});
