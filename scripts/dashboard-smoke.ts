// Opens the dashboard in a real browser (the installed Chrome or Edge, through playwright-core) against the real web
// server with made-up API answers, and fails on any page error, console error, Content-Security-Policy violation,
// unexpected failed request, missing screen content, or sideways scroll. Every screen this version draws is visited at
// a laptop and a phone size, in both themes, and a screenshot of each lands in the output folder (outside the repo).
//
//   npm run smoke:dashboard [-- --out <folder>] [-- --browser chrome|msedge]
//
// Nothing here touches the agent, WhatsApp, Google or any data folder: see scripts/dashboardFake.ts.
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';
import { fakeDashboard } from './dashboardFake.ts';
import type { FakeState } from './dashboardFake.ts';

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
const SEARCH_WORDS = ['Nair', 'Joshi', 'Patel', 'Gupta'];
let round = 0;

const state: FakeState = { signedIn: false, empty: false };
const web = fakeDashboard({ port: 0, state });

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
    if (r.status() === 422 && path === '/dashboard/api/groups/apply' && where().startsWith('manage groups refused')) return; // the refusal step
    if (r.status() >= 400 && !(r.status() === 401 && path.startsWith('/dashboard/api/') && !state.signedIn)) fail(where(), `${r.status()} ${path}`);
  });
  page.on('requestfailed', (r) => {
    // Closing the link dialog closes its event stream on purpose.
    if (new URL(r.url()).pathname === '/dashboard/api/whatsapp/link/stream') return;
    fail(where(), `request failed ${new URL(r.url()).pathname}: ${r.failure()?.errorText}`);
  });
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
      state.signedIn = false;
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
        state.signedIn = true;
        state.empty = false;
        state.setup = false;
        state.spareLinked = false;
        state.org2Ok = false;
        const tctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
        tctx.setDefaultTimeout(WAIT_MS);
        // Google's sign-in page, answered as Google would after consent: straight back to the agent's callback result.
        await tctx.route('https://accounts.google.com/**', (route) => {
          const account = new URL(route.request().url()).searchParams.get('account') ?? '';
          return route.fulfill({ status: 302, headers: { Location: `${base}/dashboard/connections?connected=${encodeURIComponent(account)}` } });
        });
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
        state.empty = true;
        await p.goto(`${base}/dashboard`);
        await check(p, where, 'text=No clients approved yet', `overview-empty-${tag}`);

        where = `back button ${tag}`;
        await p.goBack();
        await settle(p);
        if (!p.url().endsWith('/dashboard/tasks')) fail(where, `back went to ${p.url()}`);

        state.empty = false;
        where = `clients ${tag}`;
        await p.goto(`${base}/dashboard/clients`);
        await check(p, where, '.ccard', `clients-${tag}`);
        await p.locator('.ccard').first().click();
        await p.locator('.drawer h2', { hasText: 'Acme Traders' }).waitFor();
        if ((await p.locator('.drawer .li').count()) < 3) fail(where, 'the client drawer has no tasks');
        await p.waitForTimeout(600); // the drawer slides in
        await p.screenshot({ path: join(OUT, `client-drawer-${tag}.png`) });
        await p.keyboard.press('Escape');
        await p.locator('.drawer').waitFor({ state: 'detached' });

        where = `manage groups ${tag}`;
        await p.locator('[data-ctab="groups"]').click();
        await p.waitForURL('**/dashboard/clients/groups');
        await check(p, where, '.g-row', `groups-${tag}`);
        const firstBatch = await p.locator('.g-row').count();
        if (firstBatch > 2 * 60 + 3) fail(where, `drew ${firstBatch} rows at once (batches of 60)`);
        // A different family name each round: the fake directory keeps every save, so codes would run out.
        const word = SEARCH_WORDS[round++ % SEARCH_WORDS.length]!;
        await p.locator('#g-q').fill(word);
        await p.waitForURL(new RegExp(`q=${word}`));
        await p.waitForFunction((w) => [...document.querySelectorAll('.g-row')].every((r) => (r.textContent ?? '').includes(w)), word);
        const control = vp.name === 'phone' ? '[data-toggle][aria-checked="false"]' : '[data-approve]';
        await p.locator(`.g-row:not(.changed) ${control}`).first().click();
        await p.locator('#g-form').waitFor();
        await p.waitForFunction(() => /^[A-Z]{3,4}$/.test((document.querySelector('#g-code') as HTMLInputElement | null)?.value ?? ''));
        await p.waitForTimeout(600);
        await p.screenshot({ path: join(OUT, `group-drawer-${tag}.png`) });
        await p.locator('.drawer button[type="submit"]').click();
        await p.locator('.savebar', { hasText: '1 change not saved' }).waitFor();
        if (vp.name === 'laptop' && theme === 'dark') {
          // A code a listed client has: the drawer says so before any save.
          where = `manage groups refused ${tag}`;
          await p.locator('.g-row:not(.changed) [data-approve]').first().click();
          await p.locator('#g-code').fill('ACM');
          await p.locator('.drawer button[type="submit"]').click();
          await p.locator('.g-error', { hasText: 'used by Acme Traders' }).waitFor();
          // A code only the agent knows is taken: it refuses the save and that group's drawer opens with why.
          await p.locator('#g-code').fill('ZZZ');
          await p.locator('.drawer button[type="submit"]').click();
          await p.locator('.drawer').waitFor({ state: 'detached' });
          await p.locator('#g-save').click();
          await p.locator('.g-error', { hasText: 'already used' }).waitFor();
          await p.waitForTimeout(600);
          await p.screenshot({ path: join(OUT, `group-refused-${tag}.png`) });
          await p.keyboard.press('Escape');
          await p.locator('#g-undo').click();
          await p.locator('.savebar').waitFor({ state: 'detached' });
          await p.locator('.g-row:not(.changed) [data-approve]').first().click();
          await p.locator('.drawer button[type="submit"]').click();
        }
        where = `manage groups save ${tag}`;
        await p.screenshot({ path: join(OUT, `groups-unsaved-${tag}.png`) });
        await p.locator('#g-save').click();
        await p.locator('.toast', { hasText: 'Saved' }).waitFor();
        await p.locator('.savebar').waitFor({ state: 'detached' });

        where = `fix now ${tag}`;
        await p.goto(`${base}/dashboard`);
        await check(p, where, '.attn [data-fix="google:org2"]', `overview-attention-${tag}`);
        await p.locator('.attn [data-fix]').click();
        await p.locator('.modal h2', { hasText: 'Reconnect meetings@example.org' }).waitFor(); // the email comes from Connections
        await p.keyboard.press('Escape');
        await p.locator('.modal').waitFor({ state: 'detached' });

        where = `quick action ${tag}`;
        await p.goto(`${base}/dashboard/connections`);
        await check(p, where, '.conn', `connections-actions-${tag}`);
        await p.locator('[data-action="test-claude"]').click();
        await p.locator('.toast', { hasText: 'Claude answered in 0.8 s' }).waitFor();

        where = `link spare ${tag}`;
        await p.locator('[data-fix="spare-link"]').click();
        await p.locator('.modal .qr img').waitFor();
        await p.waitForTimeout(400);
        await p.screenshot({ path: join(OUT, `qr-${tag}.png`) });
        await p.locator('.modal .m-done', { hasText: 'Linked as "WA Agent - Morning report"' }).waitFor();
        await p.screenshot({ path: join(OUT, `linked-${tag}.png`) });
        await p.locator('.modal [data-close]', { hasText: 'Done' }).click();
        await p.locator('.modal').waitFor({ state: 'detached' });
        await p.locator('[data-conn="spare"] [data-fix="spare"]').waitFor(); // the card reloaded: linked, so Reconnect

        where = `relink cancelled ${tag}`;
        await p.locator('[data-conn="spare"] [data-fix="spare"]').click();
        await p.locator('.modal [data-step="start"]').click();
        await p.locator('.modal .qr img').waitFor();
        await p.keyboard.press('Escape');
        await p.locator('.modal').waitFor({ state: 'detached' });

        where = `google reconnect ${tag}`;
        await p.locator('[data-conn="google:org2"] [data-fix]').click();
        await p.locator('.modal h2', { hasText: 'meetings@example.org' }).waitFor();
        await p.waitForTimeout(300);
        await p.screenshot({ path: join(OUT, `google-dialog-${tag}.png`) });
        await p.locator('.modal button[type="submit"]').click();
        await p.waitForURL(/\/dashboard\/connections$/);
        await p.locator('.toast', { hasText: 'Google account org2 is signed in' }).waitFor();

        if (vp.name === 'laptop' && theme === 'dark') {
          where = `setup mode ${tag}`;
          state.setup = true;
          await p.goto(`${base}/dashboard`);
          await check(p, where, '.setup-cta', `setup-${tag}`);
          await p.locator('.setup-cta [data-fix="founder-link"]').click();
          await p.locator('.modal .m-done', { hasText: 'Linked as "WA Agent - Tracker"' }).waitFor();
          await p.locator('.modal [data-close]', { hasText: 'Done' }).click();
          await p.locator('.kpis').waitFor(); // the status changed: the Overview is back
        }

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

await main().catch((e: unknown) => {
  // Stopped early: what the pages reported so far usually explains why.
  if (failures.length) console.error(`Before it stopped (${failures.length}):\n- ${failures.join('\n- ')}`);
  throw e;
});
