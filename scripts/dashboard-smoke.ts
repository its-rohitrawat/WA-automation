// Opens the dashboard in a real browser (the installed Chrome or Edge, through playwright-core) against the real web
// server with made-up API answers, and fails on any page error, console error, Content-Security-Policy violation,
// unexpected failed request, missing screen content, or sideways scroll. Every screen this version draws is visited at
// a laptop and a phone size, in both themes, and a screenshot of each lands in the output folder (outside the repo).
//
//   npm run smoke:dashboard [-- --out <folder>] [-- --browser chrome|msedge]
//
// Nothing here touches the agent, WhatsApp, Google or any data folder: the API answers are fixed fake data.
import { mkdirSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';
import { sendError, sendJson } from '../src/web/http.ts';
import { createWebServer } from '../src/web/server.ts';
import { manualClock } from '../src/util/clock.ts';
import { silentLogger } from '../src/util/logger.ts';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const OUT = arg('out') ?? join(tmpdir(), 'wa-dashboard-smoke');
const CHANNELS = arg('browser') ? [arg('browser')!] : ['chrome', 'msedge'];
const VIEWPORTS = [
  { name: 'laptop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const;
const THEMES = ['dark', 'light'] as const;

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

/** Made-up answers in the agent's shapes (D1 tasks 5 and 6). */
const fixtures = (empty: boolean) => ({
  status: {
    at: at(0), up: true, line: { ok: false, text: 'Spare WhatsApp is not linked' },
    parts: [
      { key: 'founder', name: 'Founder WhatsApp', state: 'ok', label: 'Connected' },
      { key: 'spare', name: 'Spare WhatsApp', state: 'warn', label: 'Not linked' },
      { key: 'google', name: 'Google', state: 'ok', label: 'Connected' },
      { key: 'claude', name: 'Claude spend', state: 'ok', label: '$0.84 of $3.00' },
    ],
    lastMessageAt: at(3), spentToday: 0.84, capUsd: 3,
  },
  overview: empty
    ? { clients: 0, tasks: { open: 0, overdue: 0, review: 0, doneThisWeek: 0 }, byClient: [], meetings: [], activity: [], tracker: null }
    : {
        clients: 3,
        tasks: { open: 9, overdue: 2, review: 1, doneThisWeek: 6 },
        byClient: [
          { client: { code: 'ACM', name: 'Acme Traders' }, segments: [{ key: 'overdue', count: 2 }, { key: 'open', count: 4 }, { key: 'done', count: 3 }] },
          { client: { code: 'BLU', name: 'Blue Harbour Logistics With A Very Long Name' }, segments: [{ key: 'open', count: 5 }, { key: 'review', count: 1 }] },
          { client: { code: 'CED', name: 'Cedar' }, segments: [{ key: 'done', count: 3 }] },
        ],
        meetings: [
          { title: 'Weekly review', status: 'done', stageLabel: 'Summarised', when: at(90), minutes: 42 },
          { title: '', status: 'processing', stageLabel: 'Transcribing', when: at(20), minutes: null },
        ],
        activity: [
          { kind: 'task', title: 'New task', detail: 'Send the revised quote', who: 'Acme Traders', at: at(12) },
          { kind: 'msg', title: 'Message read', detail: '<b>not bold</b>', who: 'Blue Harbour', at: at(30) },
          { kind: 'issue', title: 'Spare WhatsApp not linked', detail: '', who: '', at: at(60) },
        ],
        tracker: { lastPublishedAt: at(300), health: { ok: true, text: 'Published to Drive' } },
      },
  connections: {
    founder: { state: 'ok', label: 'Connected', groups: 3, lastActivityAt: at(3) },
    spare: { state: 'not_linked', label: 'Not linked', recipientMasked: '•••• 0000' },
    google: [
      { label: 'main', email: 'owner@example.com', state: 'ok', stateLabel: 'Connected', usedFor: ['Mail', 'Drive', 'Meetings'] },
      { label: 'org2', email: 'meetings@example.org', state: 'down', stateLabel: 'Sign in again', usedFor: ['Meetings'] },
    ],
    drive: { state: 'ok', label: 'Connected', lastUploadAt: at(300) },
    claude: { callsToday: 41, spentToday: 0.84, capUsd: 3 },
    monitoring: { on: true, lastBeatAt: at(1) },
  },
});

let signedIn = false;
let empty = false;

const web = createWebServer({ control: {}, env: { DASHBOARD_PORT: 0 }, log: silentLogger(), clock: manualClock(new Date().toISOString()) });
const guarded = (body: () => unknown) => (ctx: { res: ServerResponse }) => {
  if (!signedIn) return sendError(ctx.res, 401, 'unauthenticated', 'Sign in first.');
  sendJson(ctx.res, 200, body());
};
web.router.get('/dashboard/api/me', guarded(() => ({ email: 'owner@example.com', name: 'Test Owner', signedInAt: at(5), expiresAt: at(-600), csrf: 'smoke-csrf' })));
web.router.get('/dashboard/api/status', guarded(() => fixtures(empty).status));
web.router.get('/dashboard/api/overview', guarded(() => fixtures(empty).overview));
web.router.get('/dashboard/api/connections', guarded(() => fixtures(empty).connections));
web.router.post('/dashboard/auth/logout', ({ req, res }) => {
  if (req.headers['x-csrf-token'] !== 'smoke-csrf') return sendError(res, 403, 'csrf', 'Refused.');
  signedIn = false;
  res.writeHead(204).end();
});

const failures: string[] = [];
const fail = (where: string, what: string) => failures.push(`${where}: ${what}`);

/** Watches a page for errors. `allow401` lets the signed-out /api/me answer through. */
function watch(page: Page, where: () => string) {
  page.on('pageerror', (e) => fail(where(), `page error: ${e.message}`));
  page.on('console', (m) => {
    // A refused request is logged by the browser as well; responses are checked below instead.
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) fail(where(), `console: ${m.text()}`);
  });
  page.on('response', (r) => {
    const path = new URL(r.url()).pathname;
    if (r.status() >= 400 && !(r.status() === 401 && path.startsWith('/dashboard/api/') && !signedIn)) fail(where(), `${r.status()} ${path}`);
  });
  page.on('requestfailed', (r) => fail(where(), `request failed ${new URL(r.url()).pathname}: ${r.failure()?.errorText}`));
}

/** Slow machines (and the sign-in core drawn without a GPU) can take seconds per page: wait for content, not a fixed time. */
const WAIT_MS = 60_000;

async function settle(page: Page) {
  await page.waitForLoadState('load');
  await page.waitForTimeout(1500); // the entry animations
}

async function check(page: Page, where: string, selector: string, shot: string) {
  await settle(page);
  try {
    await page.locator(selector).first().waitFor({ state: 'visible', timeout: WAIT_MS });
  } catch {
    fail(where, `expected ${selector} to be visible`);
  }
  await page.waitForTimeout(300);
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (sideways > 1) fail(where, `scrolls sideways by ${sideways}px`);
  await page.screenshot({ path: join(OUT, `${shot}.png`), fullPage: true });
}

async function launch() {
  for (const channel of CHANNELS) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      // try the next installed browser
    }
  }
  throw new Error(`No browser found (tried ${CHANNELS.join(', ')}). Install Chrome or Edge, or pass --browser.`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { port } = await web.start();
  const base = `http://127.0.0.1:${port}`;
  const browser = await launch();
  try {
    for (const vp of VIEWPORTS) {
      // Signed out: the sign-in page, then its two notes.
      signedIn = false;
      let where = '';
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      ctx.setDefaultTimeout(WAIT_MS);
      const page = await ctx.newPage();
      watch(page, () => where);
      where = `sign-in ${vp.name}`;
      await page.goto(`${base}/dashboard/connections`);
      await check(page, where, '#gbtn', `signin-${vp.name}`);
      const href = await page.locator('#gbtn').getAttribute('href');
      if (href !== '/dashboard/auth/login?return=%2Fdashboard%2Fconnections') fail(where, `sign-in link is ${href}`);
      where = `sign-in denied ${vp.name}`;
      await page.goto(`${base}/dashboard?denied=1`);
      await check(page, where, '#si-denied', `signin-denied-${vp.name}`);
      if (new URL(page.url()).search) fail(where, 'the note query stayed in the address bar');
      await ctx.close();

      for (const theme of THEMES) {
        signedIn = true;
        empty = false;
        const tctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
        tctx.setDefaultTimeout(WAIT_MS);
        await tctx.addInitScript((t) => {
          try {
            localStorage.setItem('wa-agent-theme', t);
          } catch {
            // storage blocked: the page falls back to dark
          }
        }, theme);
        const p = await tctx.newPage();
        watch(p, () => where);
        const tag = `${vp.name}-${theme}`;

        where = `overview ${tag}`;
        await p.goto(`${base}/dashboard`);
        await check(p, where, '.kpis', `overview-${tag}`);
        if ((await p.locator('#view b', { hasText: '<b>' }).count()) !== 1) fail(where, 'agent text was not shown as plain text');
        const htmlTheme = await p.evaluate(() => document.documentElement.dataset.theme ?? 'dark');
        if (htmlTheme !== theme) fail(where, `theme is ${htmlTheme}`);

        where = `connections ${tag}`;
        if (vp.name === 'phone') {
          await p.locator('#mnav').click();
          await p.waitForTimeout(400);
        }
        await p.locator('#nav [data-go="connections"]').click();
        await p.waitForURL('**/dashboard/connections');
        await check(p, where, '.conn', `connections-${tag}`);
        const cards = await p.locator('.conn').count();
        if (cards !== 7) fail(where, `expected 7 cards, found ${cards}`);

        where = `placeholder ${tag}`;
        await p.goto(`${base}/dashboard/tasks`);
        await check(p, where, 'text=Coming in the next update', `placeholder-${tag}`);

        where = `overview empty ${tag}`;
        empty = true;
        await p.goto(`${base}/dashboard`);
        await check(p, where, 'text=No clients approved yet', `overview-empty-${tag}`);

        where = `back button ${tag}`;
        await p.goBack();
        await settle(p);
        if (!p.url().endsWith('/dashboard/tasks')) fail(where, `back went to ${p.url()}`);

        where = `sign out ${tag}`;
        await p.locator('#avatar').click();
        await p.locator('#signout').click();
        await check(p, where, '#gbtn', `signed-out-${tag}`);
        await tctx.close();
      }
    }
  } finally {
    await browser.close();
    await web.stop();
  }
  if (failures.length) {
    console.error(`Dashboard smoke test failed (${failures.length}):\n- ${failures.join('\n- ')}`);
    process.exitCode = 1;
  } else {
    console.log(`Dashboard smoke test passed. Screenshots: ${OUT}`);
  }
}

await main();
