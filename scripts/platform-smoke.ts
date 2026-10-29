// Smoke test of the platform screens (SaaS S5) in a real browser: the fake dashboard (scripts/dashboardFake.ts) with the
// platform screens added (scripts/platformFake.ts), at a laptop and a phone size, in both themes, with a screenshot of
// each step in the output folder (outside the repo). Nothing reaches Gmail, Google, the agent or any data folder.
//
//   node scripts/platform-smoke.ts [--out <folder>] [--browser chrome|msedge]
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { FAKE_CSRF, fakeDashboard, type FakeState } from './dashboardFake.ts';
import { addPlatform } from './platformFake.ts';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const OUT = arg('out') ?? join(tmpdir(), 'wa-platform-smoke');
const CHANNELS = arg('browser') ? [arg('browser')!] : ['chrome', 'msedge'];
const VIEWPORTS = [{ name: 'laptop', width: 1440, height: 900 }, { name: 'phone', width: 390, height: 844 }] as const;
const THEMES = ['dark', 'light'] as const;
const WAIT_MS = 60_000;

const state: FakeState = { signedIn: true, empty: false };
const web = fakeDashboard({ port: 0, state });
const { mailer } = await addPlatform(web, { signedIn: () => state.signedIn, csrf: FAKE_CSRF });

const failures: string[] = [];
const fail = (where: string, what: string) => failures.push(`${where}: ${what}`);

function watch(page: Page, where: () => string) {
  page.on('pageerror', (e) => fail(where(), `page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) fail(where(), `console: ${m.text()}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) fail(where(), `${r.status()} ${new URL(r.url()).pathname}`);
  });
}

async function shot(page: Page, where: string, name: string, full = true) {
  await page.waitForTimeout(500);
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (sideways > 1) fail(where, `scrolls sideways by ${sideways}px`);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: full });
}

async function launch() {
  for (const channel of CHANNELS) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      // the next installed browser
    }
  }
  throw new Error(`No browser found (tried ${CHANNELS.join(', ')}).`);
}

mkdirSync(OUT, { recursive: true });
const { port } = await web.start();
const base = `http://127.0.0.1:${port}`;
const browser = await launch();
let round = 0;
try {
  for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
      const tag = `${vp.name}-${theme}`;
      let where = '';
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      ctx.setDefaultTimeout(WAIT_MS);
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
      await ctx.addInitScript((t) => {
        try {
          localStorage.setItem('wa-agent-theme', t);
        } catch {
          // storage blocked: dark
        }
      }, theme);
      const p = await ctx.newPage();
      watch(p, () => where);
      round++;

      // (b) Invite a customer: the list, a new invite by Copy link and by email, a row's new link, a cancel.
      where = `invite ${tag}`;
      await p.goto(`${base}/dashboard/invite`);
      await p.locator('.pf-inv tbody tr').nth(3).waitFor();
      for (const label of ['Sent', 'Accepted', 'Expired', 'Unknown, check Gmail']) {
        if ((await p.locator('.pf-inv .pill', { hasText: label }).count()) < 1) fail(where, `no "${label}" invite`);
      }
      if ((await p.locator('#nav [data-go="invite"]').count()) !== 1) fail(where, 'no nav entry');
      await shot(p, where, `invite-${tag}`);

      where = `invite copy link ${tag}`;
      await p.locator('[data-invite] [name="business"]').fill(`Joshi Interiors ${round}`);
      await p.locator('[data-invite] [name="email"]').fill(`joshi${round}@example.com`);
      await p.locator('[data-copy-new]').click();
      await p.locator('.toast', { hasText: `Invite created for Joshi Interiors ${round}` }).waitFor();
      const copied = await p.evaluate(() => navigator.clipboard.readText());
      if (!/^https:\/\/agent\.example\.com\/signup\?invite=[A-Za-z0-9_-]{43}$/.test(copied)) fail(where, `copied ${copied}`);
      await p.locator('.pf-inv tbody tr', { hasText: `Joshi Interiors ${round}` }).waitFor();
      await shot(p, where, `invite-copied-${tag}`, false);

      where = `invite send ${tag}`;
      await p.locator('[data-invite] [name="business"]').fill(`Iyer Web Labs ${round}`);
      await p.locator('[data-invite] [name="email"]').fill(`iyer${round}@example.com`);
      await p.locator('[data-invite] button[type="submit"]').click();
      await p.locator('.toast', { hasText: `Invite sent to iyer${round}@example.com from your Gmail.` }).waitFor();
      if (!mailer.sent.some((m) => m.to === `iyer${round}@example.com`)) fail(where, 'the fake mailer got nothing');

      where = `invite errors ${tag}`;
      await p.locator('[data-invite] [name="business"]').fill('Somebody');
      await p.locator('[data-invite] [name="email"]').fill('not-an-address');
      await p.locator('[data-invite] button[type="submit"]').click();
      await p.locator('.pf-err', { hasText: 'Enter their Gmail address' }).waitFor();
      await shot(p, where, `invite-error-${tag}`, false);

      where = `invite row link ${tag}`;
      const row = p.locator('.pf-inv tbody tr', { hasText: `Joshi Interiors ${round}` });
      await row.locator('[data-copy]').click();
      await p.locator('.modal h2', { hasText: `Copy a new link for Joshi Interiors ${round}?` }).waitFor();
      await p.locator('.modal [data-yes]').click();
      await p.locator('.toast', { hasText: `New link copied for Joshi Interiors ${round}` }).waitFor();
      const again = await p.evaluate(() => navigator.clipboard.readText());
      if (again === copied) fail(where, 'the new link is the old one');

      where = `invite cancel ${tag}`;
      await row.locator('[data-cancel]').click();
      await p.locator('.modal [data-yes]').click();
      await p.locator('.pf-inv tbody tr', { hasText: `Joshi Interiors ${round}` }).locator('.pill', { hasText: 'Cancelled' }).waitFor();
      await shot(p, where, `invite-cancelled-${tag}`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  await web.stop();
}
if (failures.length) {
  console.log(`Platform smoke test failed (${failures.length}):\n${failures.map((f) => `- ${f}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Platform smoke test passed. Screenshots: ${OUT}`);
}
