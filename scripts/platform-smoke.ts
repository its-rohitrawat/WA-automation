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
import { createInvite } from '../src/platform/invites.ts';
import { systemClock } from '../src/util/clock.ts';
import { addPlatform, addSignup, fakeGoogle, fakeRuntimes, fakeSteps, previewAs } from './platformFake.ts';

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
const { mailer, db: platformDb } = await addPlatform(web, { signedIn: () => state.signedIn, csrf: FAKE_CSRF });

const failures: string[] = [];
const fail = (where: string, what: string) => failures.push(`${where}: ${what}`);

function watch(page: Page, where: () => string) {
  page.on('pageerror', (e) => fail(where(), `page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) fail(where(), `console: ${m.text()}`);
  });
  page.on('response', (r) => {
    const path = new URL(r.url()).pathname;
    if (r.status() === 404 && path === '/signup/api/invite' && where().startsWith('signup used link')) return;
    if (r.status() === 409 && path === '/dashboard/api/platform/ai-key' && where().startsWith('onboarding key founder')) return;
    if (r.status() >= 400) fail(where(), `${r.status()} ${path}`);
  });
}

async function shot(page: Page, where: string, name: string, full = true) {
  await page.waitForTimeout(500);
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (sideways > 1) fail(where, `scrolls sideways by ${sideways}px`);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: full });
}

/** The floating Ask button never covers a control: row actions sit outside its lane, and the screen's end scrolls clear of it. */
async function clearOfAsk(page: Page, where: string) {
  const fab = await page.locator('.asst-fab').boundingBox();
  if (!fab) return fail(where, 'no Ask button');
  for (const b of await page.locator('.pf-cust td:last-child, .pf-inv td:last-child').locator('button, a').all()) {
    const box = await b.boundingBox();
    if (box && box.x + box.width > fab.x - 4) fail(where, `"${(await b.textContent())?.trim()}" sits in the Ask button's lane`);
  }
  await page.locator('.view').evaluate((v) => v.scrollIntoView({ block: 'end' }));
  const covered = await page.evaluate((f) => [...document.querySelectorAll('.view :is(button, a, input, select, textarea)')]
    .filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.right > f.x && r.left < f.x + f.width && r.bottom > f.y && r.top < f.y + f.height;
    })
    .map((e) => e.textContent?.trim().slice(0, 30) || e.tagName), fab);
  if (covered.length) fail(where, `the Ask button covers ${covered.join(', ')} at the end of the screen`);
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
addSignup(web, { db: platformDb, signIn: () => (state.signedIn = true), publicUrl: base });
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
      // Nothing may reach Google: such a request fails the smoke, and is stopped.
      await ctx.route(/^https:\/\/([a-z0-9-]+\.)*(google|googleapis|gstatic)\.com\//, (route) => {
        fail(`round ${tag}`, `a request to ${new URL(route.request().url()).host}`);
        return route.abort();
      });
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
      await clearOfAsk(p, where);

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
      // (d) Sign-up: the page for a working link, another Google account, the invited one, then the used link.
      where = `signup ${tag}`;
      const made = await createInvite({ db: platformDb, clock: systemClock }, 'owner@example.com', { business: `Kapoor Design Studio ${round}`, email: `kapoor${round}@example.com` });
      // Google is never reached: the agent's own answer to Continue with Google (a redirect to Google's page) is turned
      // into what Google would do, a redirect straight back to the callback with the same state. (A navigation that
      // arrives by redirect cannot be caught on its way to Google, so it is caught here, before it leaves.)
      await ctx.route(`${base}/signup/google**`, async (route) => {
        const answer = await route.fetch({ maxRedirects: 0 });
        const to = answer.headers()['location'] ?? '';
        if (!to.startsWith('https://accounts.google.com/')) return route.fulfill({ response: answer });
        const u = new URL(to);
        fakeGoogle.nonce = u.searchParams.get('nonce') ?? '';
        return route.fulfill({ response: answer, headers: { ...answer.headers(), location: `${base}/signup/callback?code=fake&state=${u.searchParams.get('state') ?? ''}` } });
      });
      state.signedIn = false;
      await p.goto(`${base}/signup?invite=${made.token}`);
      await p.locator('#su-title', { hasText: 'Rohit invited you to WA Agent' }).waitFor();
      await p.locator('#su-sub b', { hasText: `Kapoor Design Studio ${round}` }).waitFor();
      await shot(p, where, `signup-${tag}`, false);

      where = `signup wrong account ${tag}`;
      fakeGoogle.email = 'someone.else@example.com';
      await p.locator('#gbtn').click();
      await p.locator('#su-wrong').waitFor({ state: 'visible' });
      if (state.signedIn) fail(where, 'signed in with another account');
      await shot(p, where, `signup-wrong-${tag}`, false);

      where = `signup invited account ${tag}`;
      fakeGoogle.email = `KAPOOR${round}@example.com`;
      await p.locator('#gbtn').click();
      await p.waitForURL('**/dashboard/onboarding');
      if (!state.signedIn) fail(where, 'no session started');

      where = `signup used link ${tag}`;
      await p.goto(`${base}/signup?invite=${made.token}`);
      await p.locator('#su-title', { hasText: 'This invite link does not work' }).waitFor();
      if (await p.locator('#gbtn').isVisible()) fail(where, 'Continue with Google offered for a used link');
      await shot(p, where, `signup-invalid-${tag}`, false);
      state.signedIn = true;
      // (e) Getting started: before the customer workspace exists (the needed steps coming, the rest locked), then with
      // WhatsApp and the key done (the customer becomes active and the rest unlock).
      where = `onboarding ${tag}`;
      for (const k of Object.keys(fakeSteps) as (keyof typeof fakeSteps)[]) delete fakeSteps[k];
      await platformDb.run("UPDATE tenants SET status = 'onboarding' WHERE name = 'Joshi Interiors'");
      await p.goto(`${base}/dashboard/onboarding`);
      await p.locator('.pf-step').nth(5).waitFor();
      if ((await p.locator('.pf-step.locked').count()) !== 4) fail(where, 'expected 4 locked steps');
      await p.locator('.pf-step.open .pf-coming', { hasText: 'Coming with the customer workspace.' }).waitFor();
      await p.locator('.pf-ob-prog', { hasText: '0 of 6 done' }).waitFor();
      // A locked step is aria-disabled (so Playwright will not click it by itself); a person can still tap it.
      await p.locator('.pf-step.locked .pf-step-head').first().click({ force: true });
      await p.locator('.toast', { hasText: 'Finish WhatsApp and your API key first.' }).waitFor();
      await shot(p, where, `onboarding-${tag}`);
      await clearOfAsk(p, where);

      // (S4.2) The customer's own Anthropic key: an obvious fake, and the preview's tester never calls Anthropic. The
      // founder is refused (their key is in .env); the customer saves it; it leaves the field and never reaches the page.
      where = `onboarding key founder ${tag}`;
      const FAKE_KEY = 'sk-ant-test-0000';
      fakeSteps.key = 'todo';
      await p.reload();
      await p.locator('.pf-step-head', { hasText: 'Anthropic' }).click();
      const keyField = p.locator('[data-key-form] input[name="key"]');
      await keyField.fill(FAKE_KEY);
      await p.locator('[data-key-form] [type="submit"]').click();
      await p.locator('.toast', { hasText: 'is set on the Mac' }).waitFor();
      if ((await keyField.inputValue()) !== '') fail(where, 'the key stayed in the field after a refusal');
      where = `onboarding key ${tag}`;
      previewAs.founder = false;
      await keyField.fill(FAKE_KEY);
      await shot(p, where, `onboarding-key-${tag}`, false);
      await p.locator('[data-key-form] [type="submit"]').click();
      await p.locator('.toast', { hasText: 'Key tested and saved' }).waitFor();
      if ((await keyField.inputValue()) !== '') fail(where, 'the key stayed in the field');
      if ((await p.content()).includes(FAKE_KEY)) fail(where, 'the key is in the page');
      const sealed = await platformDb.get<{ v: string }>("SELECT v FROM kv WHERE k = 'secret.anthropic'");
      if (!sealed || sealed.v.includes('sk-ant')) fail(where, 'the key was not stored encrypted');
      await platformDb.run("DELETE FROM kv WHERE k = 'secret.anthropic'");
      previewAs.founder = true;
      delete fakeSteps.key;

      where = `onboarding active ${tag}`;
      fakeSteps.whatsapp = 'done';
      fakeSteps.key = 'done';
      await p.reload();
      await p.locator('.pf-ob-prog', { hasText: '2 of 6 done' }).waitFor();
      await p.locator('.pf-ob-prog .pill', { hasText: 'Active' }).waitFor();
      if ((await p.locator('.pf-step.locked').count()) !== 0) fail(where, 'steps still locked');
      if ((await p.locator('.pf-step.done').count()) !== 2) fail(where, 'expected 2 done steps');
      await shot(p, where, `onboarding-active-${tag}`);
      for (const k of Object.keys(fakeSteps) as (keyof typeof fakeSteps)[]) delete fakeSteps[k];
      await platformDb.run("UPDATE tenants SET status = 'onboarding' WHERE name = 'Joshi Interiors'");

      // (f) Customers: setup and health only; pause and resume a customer.
      where = `customers ${tag}`;
      // (S4.9) A runtime state from the Supervisor shows under the status: here Nair's runtime keeps crashing.
      const nairId = (await platformDb.get<{ id: string }>("SELECT id FROM tenants WHERE name = 'Nair Digital Works'"))!.id;
      fakeRuntimes[nairId] = 'failing';
      await p.goto(`${base}/dashboard/customers`);
      await p.locator('.pf-cust tbody tr').nth(4).waitFor();
      for (const label of ['Active', 'Onboarding', 'Invited', 'Paused']) {
        if ((await p.locator('.pf-cust .pill', { hasText: label }).count()) < 1) fail(where, `no "${label}" customer`);
      }
      if ((await p.locator('.pf-cust tbody tr', { hasText: 'Your studio' }).locator('[data-pause]').count()) !== 0) fail(where, 'the founder can be paused');
      if ((await p.locator('#nav [data-go="customers"]').count()) !== 1) fail(where, 'no nav entry');
      if ((await p.locator('.pf-cust tbody tr', { hasText: 'Nair Digital Works' }).locator('.pf-run', { hasText: 'Keeps crashing' }).count()) !== 1) fail(where, 'no runtime note');
      if ((await p.locator('.pf-cust .pf-run').count()) !== 1) fail(where, 'a runtime note on a customer without one');
      await shot(p, where, `customers-${tag}`);
      delete fakeRuntimes[nairId];
      await clearOfAsk(p, where);

      where = `customers pause ${tag}`;
      const nairRow = p.locator('.pf-cust tbody tr', { hasText: 'Nair Digital Works' });
      await nairRow.locator('[data-pause]').click();
      await p.locator('.modal h2', { hasText: 'Pause Nair Digital Works?' }).waitFor();
      await p.locator('.modal [data-yes]').click();
      await nairRow.locator('.pill', { hasText: 'Paused' }).waitFor();
      await nairRow.locator('[data-resume]').click();
      await nairRow.locator('.pill', { hasText: 'Active' }).waitFor();
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
