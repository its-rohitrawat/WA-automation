// Copies the website's static export (its out/ folder, built in the website project) into this repo's site/ folder,
// which the agent serves at / (src/web/site.ts). Repeatable: run it again after each website build.
//
//   node scripts/site-import.ts <path to the website's out folder>
//
// The export is checked twice, before the copy and again on the copy, with the website's export rules (its
// scripts/export-check.mjs) plus the agent's own: nothing under a dashboard path, no link below /dashboard, no .map
// file, no file over 2 MB, no script, stylesheet or font from another origin, nothing that looks like a key (the value
// is never printed), no symbolic link, and only names and file types the agent serves. Any problem leaves site/ as it
// was. Otherwise site/ is replaced as a whole, so no file of an older build is left behind. It prints the inline-script
// hashes the site's CSP will carry (the agent works them out itself when it starts).
import { lstat, readdir, readFile, rename, rm, cp, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inlineScriptHashes, SEGMENT, SITE_DIR, SITE_MIME } from '../src/web/site.ts';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const BINARY = new Set(['.woff2', '.woff', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico']);
const SECRETS: readonly { name: string; re: RegExp }[] = [
  { name: 'sk- key', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'PEM block', re: /-----BEGIN [A-Z0-9 ]+-----/ },
];
/** <link> rels that load nothing into the page. */
const NON_LOADING = new Set(['canonical', 'alternate', 'author', 'license', 'help', 'me', 'search', 'next', 'prev']);

export interface Problem {
  rule: string;
  file: string;
  detail: string;
}

const attr = (tag: string, name: string): string | null => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
};
const rootRelative = (url: string) => url.startsWith('/') && !url.startsWith('//');
const otherOrigin = (url: string) => /^([a-z][a-z0-9+.-]*:)?\/\//i.test(url.trim());

function checkCss(file: string, css: string, out: Problem[]): void {
  const urls = [...css.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gi), ...css.matchAll(/url\(\s*["']?([^"')]+)/gi)].map((m) => m[1]!);
  for (const url of new Set(urls)) if (otherOrigin(url)) out.push({ rule: 'external-asset', file, detail: `CSS loads from another origin: ${url}` });
}

function checkHtml(file: string, html: string, out: Problem[]): void {
  for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = attr(tag, 'src');
    if (src !== null && !rootRelative(src)) out.push({ rule: 'external-asset', file, detail: `script src is not on this site: ${src}` });
  }
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const href = attr(tag, 'href');
    const rels = (attr(tag, 'rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    if (href === null || rels.every((r) => NON_LOADING.has(r))) continue;
    if (!rootRelative(href) && !href.startsWith('data:')) out.push({ rule: 'external-asset', file, detail: `<link rel="${rels.join(' ')}"> is not on this site: ${href}` });
  }
  for (const m of html.matchAll(/\shref\s*=\s*(["'])(\/dashboard\/[^"']*)\1/gi)) {
    out.push({ rule: 'dashboard-link', file, detail: `links below /dashboard (only /dashboard itself is allowed): ${m[2]}` });
  }
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) checkCss(file, m[1]!, out);
}

async function walk(root: string, dir: string, files: string[], out: Problem[]): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    const file = relative(root, path).split(sep).join('/');
    if ((await lstat(path)).isSymbolicLink()) {
      out.push({ rule: 'link', file, detail: 'symbolic links are not copied' });
      continue;
    }
    if (e.isDirectory()) await walk(root, path, files, out);
    else files.push(file);
  }
}

/** Checks an export folder. Returns the problems (empty: fine to serve), the files and each page's inline-script hashes. */
export async function inspectSite(dir: string): Promise<{ problems: Problem[]; files: string[]; extensions: Record<string, number>; hashes: { file: string; hashes: string[] }[] }> {
  const root = resolve(dir);
  const problems: Problem[] = [];
  const files: string[] = [];
  await walk(root, root, files, problems);
  files.sort();
  const extensions: Record<string, number> = {};
  const hashes: { file: string; hashes: string[] }[] = [];
  if (!files.includes('index.html')) problems.push({ rule: 'no-home', file: 'index.html', detail: 'the export has no home page' });
  for (const file of files) {
    const ext = extname(file).toLowerCase();
    extensions[ext] = (extensions[ext] ?? 0) + 1;
    if (/^dashboard/i.test(file)) problems.push({ rule: 'dashboard-path', file, detail: "this path belongs to the agent's dashboard" });
    if (ext === '.map') problems.push({ rule: 'source-map', file, detail: 'source maps must not ship' });
    else if (!Object.hasOwn(SITE_MIME, ext)) problems.push({ rule: 'file-type', file, detail: `the agent does not serve ${ext || 'files without a type'}; add it to SITE_MIME first` });
    if (!file.split('/').every((s) => SEGMENT.test(s))) problems.push({ rule: 'name', file, detail: 'a name the agent does not serve (src/web/site.ts SEGMENT)' });
    const path = join(root, ...file.split('/'));
    const { size } = await stat(path);
    if (size > MAX_FILE_BYTES) problems.push({ rule: 'size', file, detail: `${size} bytes is over the 2 MB limit` });
    if (BINARY.has(ext)) continue;
    const text = await readFile(path, 'utf8');
    for (const { name, re } of SECRETS) {
      const m = re.exec(text);
      if (m) problems.push({ rule: 'secret', file, detail: `looks like a ${name} at character ${m.index} (value not shown)` });
    }
    if (ext === '.html') {
      checkHtml(file, text, problems);
      const h = inlineScriptHashes(text);
      if (h.length) hashes.push({ file, hashes: h });
    } else if (ext === '.css') {
      checkCss(file, text, problems);
    }
  }
  return { problems, files, extensions, hashes };
}

const report = (where: string, problems: Problem[]) => {
  for (const p of problems) console.error(`site-import: ${p.rule}: ${p.file}: ${p.detail}`);
  console.error(`site-import: refused, ${problems.length} problem(s) in ${where}; site/ is unchanged`);
};

/** Checks `from`, copies it beside `to`, checks the copy, then swaps it in for `to`. Returns false (and changes nothing) on a problem. */
export async function importSite(from: string, to: string = SITE_DIR): Promise<boolean> {
  const source = resolve(from);
  const target = resolve(to);
  if (!existsSync(source) || !(await stat(source)).isDirectory()) {
    console.error(`site-import: ${source} is not a folder`);
    return false;
  }
  if (target === source || target.startsWith(source + sep) || source.startsWith(target + sep)) {
    console.error('site-import: the export and site/ must be separate folders');
    return false;
  }
  const before = await inspectSite(source);
  if (before.problems.length) {
    report(source, before.problems);
    return false;
  }
  const incoming = `${target}.incoming`;
  const outgoing = `${target}.outgoing`;
  await rm(incoming, { recursive: true, force: true });
  await rm(outgoing, { recursive: true, force: true });
  await cp(source, incoming, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
  const after = await inspectSite(incoming);
  const sameFiles = after.files.join('\n') === before.files.join('\n');
  if (after.problems.length || !sameFiles) {
    report('the copy', sameFiles ? after.problems : [{ rule: 'copy', file: '', detail: 'the copy does not hold the same files' }, ...after.problems]);
    await rm(incoming, { recursive: true, force: true });
    return false;
  }
  if (existsSync(target)) await rename(target, outgoing);
  await rename(incoming, target);
  await rm(outgoing, { recursive: true, force: true });
  const types = Object.entries(after.extensions).sort().map(([e, n]) => `${e} ${n}`).join(', ');
  console.log(`site-import: ${after.files.length} files copied into ${target} (${types})`);
  for (const { file, hashes } of after.hashes) console.log(`  ${file}: ${hashes.length} inline script(s)`);
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const from = process.argv[2];
  if (!from) {
    console.error('Usage: node scripts/site-import.ts <path to the website out folder>');
    process.exitCode = 2;
  } else if (!(await importSite(from))) {
    process.exitCode = 1;
  }
}
