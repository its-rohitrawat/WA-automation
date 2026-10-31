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
/** Another family per round for the bulk steps (each family's groups are approved or ignored by the end of its round). */
const BULK_WORDS = ['Bose', 'Reddy', 'Sethi', 'Malhotra'];
let bulkRound = 0;
/** The screens drawn from src/web/public/views/screens.js. */
const WORK_SCREENS = ['tasks', 'meetings', 'activity', 'tracker', 'usage', 'automations', 'audit', 'settings'];
let round = 0;
let timeRound = 0;

const state: FakeState = { signedIn: false, empty: false };
const web = await fakeDashboard({ port: 0, state });

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
    if (r.status() === 429 && path === '/dashboard/api/actions/upload-tracker' && where().startsWith('sync tracker')) return; // the limit step
    if (r.status() >= 400 && !(r.status() === 401 && path.startsWith('/dashboard/api/') && !state.signedIn)) fail(where(), `${r.status()} ${path}`);
  });
  page.on('requestfailed', (r) => {
    // Closing the link dialog closes its event stream on purpose.
    if (new URL(r.url()).pathname === '/dashboard/api/whatsapp/link/stream') return;
    // Chrome reports a fetch read through its body stream as aborted even when every line arrived (text() of the same
    // answer finishes); the assistant steps check that each answer finished instead.
    if (new URL(r.url()).pathname === '/dashboard/api/assistant/ask' && r.failure()?.errorText === 'net::ERR_ABORTED') return;
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
        // The uptime strip lists the newest outages with their exact times ("Off from 02:14 to 06:33 (4 h 19 min)").
        if ((await p.locator('[data-uptime-outages] li', { hasText: / to \d\d:\d\d \(/ }).count()) < 1) fail(where, 'no outage with its exact times');
        if ((await p.locator('#view b', { hasText: '<b>' }).count()) !== 1) fail(where, 'agent text was not shown as plain text');
        const htmlTheme = await p.evaluate(() => document.documentElement.dataset.theme ?? 'dark');
        if (htmlTheme !== theme) fail(where, `theme is ${htmlTheme}`);

        // Every count is a link to the screen that lists it, with the filter in the address; the "i" beside it says
        // what the number means (hover on a laptop, a tap on a phone, keyboard focus on both).
        where = `overview counts ${tag}`;
        const hrefs = await p.locator('.kpi-link').evaluateAll((els) => els.map((a) => a.getAttribute('href')));
        const want = ['/dashboard/clients', '/dashboard/tasks?status=open', '/dashboard/tasks?status=overdue', '/dashboard/tasks?status=review', '/dashboard/tasks?status=done&closed=7d'];
        if (JSON.stringify(hrefs) !== JSON.stringify(want)) fail(where, `links are ${JSON.stringify(hrefs)}`);
        if ((await p.locator('.kpi .kpi-link .kpi-i').count()) !== 0) fail(where, 'an info button is inside a link');
        const tip = p.locator('#kpi-tip-overdue');
        if (vp.name === 'phone') await p.locator('[data-kpi-info="overdue"]').click();
        else await p.locator('[data-kpi-info="overdue"]').hover();
        await tip.waitFor({ state: 'visible' });
        if ((await tip.textContent()) !== 'Tasks past their deadline that are not done yet.') fail(where, `the overdue sentence is "${await tip.textContent()}"`);
        await p.waitForTimeout(300);
        await p.screenshot({ path: join(OUT, `overview-info-${tag}.png`) });
        if (vp.name === 'phone') {
          await p.locator('[data-kpi-info="overdue"]').click(); // a second tap closes it
          await p.locator('[data-kpi-info="overdue"][aria-expanded="false"]').waitFor();
          // This test browser reports a mouse that can hover (a phone has none): move it off before checking.
          await p.mouse.move(5, 5);
          await tip.waitFor({ state: 'hidden' });
        } else await p.mouse.move(5, 5);
        // Keyboard: Tab to the review tile's "i" (past its link) shows its sentence, and Esc closes an open one.
        await p.locator('[data-kpi-info="overdue"]').focus();
        await p.keyboard.press('Tab');
        await p.keyboard.press('Tab');
        await p.locator('#kpi-tip-review').waitFor({ state: 'visible' });
        const ring = await p.locator('.kpi-link[data-query="?status=review"]').evaluate((a) => {
          a.focus();
          return getComputedStyle(a).outlineStyle;
        });
        if (ring !== 'solid') fail(where, `a focused count has no focus ring (${ring})`);
        await p.locator('[data-kpi-info="done"]').click();
        await p.locator('.kpi.info-open #kpi-tip-done').waitFor({ state: 'visible' });
        await p.keyboard.press('Escape');
        await p.locator('.kpi.info-open').waitFor({ state: 'detached' });
        await p.locator('.kpi-link[data-query="?status=overdue"]').click();
        await p.waitForURL('**/dashboard/tasks?status=overdue');
        await p.locator('select[data-f="status"]').waitFor();
        if ((await p.locator('select[data-f="status"]').inputValue()) !== 'overdue') fail(where, 'Tasks did not open filtered to overdue');
        await p.goBack();
        await p.waitForURL(/\/dashboard$/);
        await p.locator('.kpis').waitFor();
        // Done: the tasks closed in the last 7 days (the count's own days), as a chip that removes that filter.
        where = `overview done ${tag}`;
        await p.locator('.kpi-link[data-query="?status=done&closed=7d"]').click();
        await p.waitForURL('**/dashboard/tasks?status=done&closed=7d');
        await p.locator('.fchip[data-clear="closed"]', { hasText: 'Done · last 7 days' }).waitFor();
        // Active clients only, as the Overview counts; removed clients' tasks only when asked for.
        await p.locator('.fchip[data-removed][aria-pressed="false"]', { hasText: 'Include removed clients' }).waitFor();
        await p.locator('#view .skel').first().waitFor({ state: 'detached' });
        await p.waitForTimeout(400);
        await p.screenshot({ path: join(OUT, `tasks-done-7d-${tag}.png`) });
        await p.locator('.fchip[data-removed]').click();
        await p.waitForURL((u) => u.search === '?status=done&closed=7d&removed=1');
        await p.locator('.fchip[data-removed][aria-pressed="true"]').waitFor();
        await p.locator('.fchip[data-removed]').click();
        await p.waitForURL((u) => u.search === '?status=done&closed=7d');
        await p.locator('.fchip[data-clear="closed"]').click();
        await p.waitForURL((u) => u.pathname === '/dashboard/tasks' && u.search === '?status=done');
        if ((await p.locator('.fchip[data-clear]').count()) !== 0) fail(where, 'the chip stayed after removing it');
        await p.goto(`${base}/dashboard`);
        await p.locator('.kpis').waitFor();

        // The AI assistant, on a scripted Claude (scripts/assistantFake.ts: no API call): open it, ask, Confirm a card,
        // let it open a screen, and close it with Escape.
        where = `assistant ${tag}`;
        await p.locator('#asst-fab').click();
        await p.locator('#asst .asst-sugg .chip').first().waitFor({ timeout: WAIT_MS }).catch(() => fail(where, 'no suggested questions'));
        await p.waitForTimeout(400);
        await p.screenshot({ path: join(OUT, `assistant-open-${tag}.png`) });
        await p.locator('#asst .chip', { hasText: 'Summarise today' }).click();
        await p.locator('#asst .asst-meta').first().waitFor({ timeout: WAIT_MS }).catch(() => fail(where, 'the answer never finished'));
        if ((await p.locator('#asst .asst-msg.bot b', { hasText: '11 open tasks' }).count()) !== 1) fail(where, 'the answer was not drawn');
        await p.locator('#asst-q').fill('Add a task for Acme: book the photo shoot');
        await p.keyboard.press('Enter');
        await p.locator('#asst .asst-card [data-confirm]').waitFor({ timeout: WAIT_MS }).catch(() => fail(where, 'no card to confirm'));
        await p.locator('#asst .asst-meta').nth(1).waitFor({ timeout: WAIT_MS }).catch(() => fail(where, 'the second answer never finished'));
        await p.waitForTimeout(300);
        await p.screenshot({ path: join(OUT, `assistant-card-${tag}.png`) });
        await p.locator('#asst .asst-card [data-confirm]').click();
        await p.locator('#asst .asst-card .ok', { hasText: 'added' }).waitFor({ timeout: WAIT_MS }).catch(() => fail(where, 'Confirm did not finish'));
        await p.locator('#asst-q').fill('Show overdue tasks');
        await p.keyboard.press('Enter');
        await p.waitForURL('**/dashboard/tasks?status=overdue', { timeout: WAIT_MS }).catch(() => fail(where, `did not open the overdue tasks: ${p.url()}`));
        await p.locator('#asst .asst-meta').nth(2).waitFor({ timeout: WAIT_MS }).catch(() => fail(where, 'the third answer never finished'));
        await p.waitForTimeout(300);
        await p.screenshot({ path: join(OUT, `assistant-screen-${tag}.png`) });
        const asstSideways = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (asstSideways > 1) fail(where, `scrolls sideways by ${asstSideways}px`);
        await p.locator('#asst-q').focus();
        await p.keyboard.press('Escape');
        await p.locator('#asst').waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => fail(where, 'Escape did not close it'));

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
        const driveCard = p.locator('[data-conn="drive"]');
        if ((await driveCard.locator('dd', { hasText: 'owner@example.com' }).count()) !== 1) fail(where, 'the Drive card does not name the account');
        if ((await driveCard.locator('a[data-open-drive][href^="https://drive.google.com/file/d/"]').count()) !== 1) fail(where, 'the Drive card has no Open in Drive');

        // The work and control screens (D4, D5), on the real routes: each draws its content, with no error panel.
        for (const screen of WORK_SCREENS) {
          where = `${screen} ${tag}`;
          await p.goto(`${base}/dashboard/${screen}`);
          await p.locator('#view .skel').first().waitFor({ state: 'detached', timeout: WAIT_MS }).catch(() => fail(where, 'still loading'));
          await check(p, where, '#view .card', `${screen}-${tag}`);
          if (await p.locator('#view .err-state').count()) fail(where, 'shows its error panel');
          if ((await p.locator('#view', { hasText: 'Coming in the next update' }).count()) !== 0) fail(where, 'is still the placeholder');
          if (screen === 'tracker') {
            // Which file is written, as whom, and the one-time note that a new file had to be started.
            if ((await p.locator('#view [data-tracker-file]', { hasText: 'owner@example.com' }).count()) !== 1) fail(where, 'does not name the account');
            if ((await p.locator('#view [data-new-file]', { hasText: 'A new tracker file was started on' }).count()) !== 1) fail(where, 'has no new-file note');
            if ((await p.locator('#view a[href^="https://drive.google.com/file/d/"]', { hasText: 'Open in Drive' }).count()) !== 1) fail(where, 'has no Open in Drive');
          }
          if (screen === 'automations') {
            // The send time is saved with its own button (a new one each round: a time already in force saves nothing),
            // and the next report follows it.
            where = `automations send time ${tag}`;
            const hm = `07:${String(10 + timeRound++).padStart(2, '0')}`;
            await p.locator('#view [data-timeform] input').fill(hm);
            await p.locator('#view [data-timeform] button[type="submit"]').click();
            await p.locator('.toast', { hasText: 'Briefing time saved' }).first().waitFor({ timeout: WAIT_MS }).catch(() => fail(where, 'no saved toast'));
            const next = await p.locator('#view [data-next]').innerText();
            if (!next.includes(hm) && !next.includes('due now')) fail(where, `the next report does not follow the new time: ${next}`);
            await p.waitForTimeout(300);
            await p.screenshot({ path: join(OUT, `automations-time-${tag}.png`), fullPage: true });
            // Link phone opens the spare phone's first-link dialog right here, not Connections.
            where = `automations link phone ${tag}`;
            await p.locator('#view [data-fix="spare-link"]').click();
            await p.locator('.modal .qr img').waitFor();
            if (!p.url().endsWith('/dashboard/automations')) fail(where, `moved to ${p.url()}`);
            await p.keyboard.press('Escape');
            await p.locator('.modal').waitFor({ state: 'detached' });
            state.spareLinked = false; // the Connections steps below start from an unlinked spare phone
          }
        }

        where = `overview empty ${tag}`;
        state.empty = true;
        await p.goto(`${base}/dashboard`);
        await check(p, where, 'text=No clients approved yet', `overview-empty-${tag}`);

        where = `back button ${tag}`;
        await p.goBack();
        await settle(p);
        if (!p.url().endsWith(`/dashboard/${WORK_SCREENS.at(-1)}`)) fail(where, `back went to ${p.url()}`);

        state.empty = false;
        where = `clients ${tag}`;
        await p.goto(`${base}/dashboard/clients`);
        await check(p, where, '.ccard', `clients-${tag}`);
        // Every card has its status line; the ones the agent is working on have the travelling edge.
        if ((await p.locator('.ccard .cstat').count()) !== (await p.locator('.ccard').count())) fail(where, 'a card has no status line');
        if ((await p.locator('.ccard.busy').count()) !== 2) fail(where, 'expected 2 busy cards (Acme reading, Blue Harbour reading its last 7 days)');
        await p.locator('.ccard').first().click();
        await p.locator('.drawer h2', { hasText: 'Acme Traders' }).waitFor();
        if ((await p.locator('.drawer .li').count()) < 3) fail(where, 'the client drawer has no tasks');
        await p.locator('.drawer .status', { hasText: 'Reading new messages' }).waitFor();
        if ((await p.locator('.drawer .msgs .msg').count()) !== 3) fail(where, 'expected the 3 latest messages');
        // The group's text is shown as text: the tags in it stay visible characters.
        await p.locator('.drawer .bub p', { hasText: '<b>not bold</b>' }).waitFor();
        await p.locator('.drawer .bub p', { hasText: 'Voice note · 0:42 · transcribed' }).waitFor();
        await p.locator('.drawer .lastread', { hasText: '2 task changes' }).waitFor();
        if ((await p.locator('.drawer .syncline [data-action="upload-tracker"]').count()) !== 1) fail(where, 'the panel has no Sync now');
        if ((await p.locator('.drawer .dr-foot button').count()) !== 3) fail(where, 'the panel foot should hold Close, Open chat and Open tracker');
        await p.waitForTimeout(600); // the drawer slides in
        await p.screenshot({ path: join(OUT, `client-drawer-${tag}.png`) });
        await p.keyboard.press('Escape');
        await p.locator('.drawer').waitFor({ state: 'detached' });

        where = `client panel, no tasks ${tag}`;
        await p.locator('.ccard', { hasText: 'Cedar' }).click();
        await p.locator('.drawer .empty', { hasText: 'No tasks yet' }).waitFor();
        await p.locator('.drawer .status', { hasText: 'Watching for new messages' }).waitFor();
        await p.locator('.drawer .kv', { hasText: 'Last 7 days read · 42 found' }).waitFor();
        await p.waitForTimeout(600);
        await p.screenshot({ path: join(OUT, `client-panel-no-tasks-${tag}.png`) });
        await p.keyboard.press('Escape');
        await p.locator('.drawer').waitFor({ state: 'detached' });

        // Open chat. Sending is off at first: the chat says so and has no text box.
        where = `open chat, sending off ${tag}`;
        const openAcmeChat = async () => {
          await p.locator('.ccard', { hasText: 'Acme Traders' }).click();
          await p.locator('.drawer [data-open-chat]').click();
          await p.locator('.chat-sheet .ch-row').first().waitFor();
          await p.locator('.chat-sheet .ch-head h2', { hasText: 'Acme Traders x Studio' }).waitFor();
          await p.waitForTimeout(500); // the sheet comes in
          // It opens at the newest message.
          const fromEnd = await p.locator('.chat-sheet .ch-body').evaluate((b) => b.scrollHeight - b.scrollTop - b.clientHeight);
          if (fromEnd > 80) fail(where, `the chat did not open at its newest message (${fromEnd}px from the end)`);
        };
        await openAcmeChat();
        await p.locator('.chat-sheet .ch-off', { hasText: 'Sending is off' }).waitFor();
        if ((await p.locator('.chat-sheet #ch-text').count()) !== 0) fail(where, 'a text box while sending is off');
        if ((await p.locator('.chat-sheet .ch-reply').count()) !== 0) fail(where, 'Reply buttons while sending is off');
        await p.screenshot({ path: join(OUT, `chat-off-${tag}.png`) });
        // The stored messages: bubbles, days, names, tags, the voice note's words; text shown as text.
        where = `open chat ${tag}`;
        if ((await p.locator('.chat-sheet .ch-row').count()) < 40) fail(where, 'expected a page of messages');
        if ((await p.locator('.chat-sheet .ch-day').count()) < 2) fail(where, 'expected day separators');
        await p.locator('.chat-sheet .ch-bub p', { hasText: 'Text with <b>tags</b> stays text' }).waitFor();
        await p.locator('.chat-sheet .ch-tag', { hasText: 'Voice note · 0:42' }).waitFor();
        await p.locator('.chat-sheet .ch-tr', { hasText: 'The blue one works' }).waitFor();
        await p.locator('.chat-sheet .ch-gone', { hasText: 'This message was deleted' }).waitFor();
        const page1 = await p.locator('.chat-sheet .ch-row[data-msg]').count();
        // Scrolling up with the wheel, as the owner would, loads the page before.
        await p.locator('.chat-sheet .ch-body').hover();
        for (let i = 0; i < 12; i++) {
          await p.mouse.wheel(0, -800);
          await p.waitForTimeout(80);
        }
        await p.waitForFunction((n) => document.querySelectorAll('.chat-sheet .ch-row[data-msg]').length > n, page1);
        // Back to the client's panel.
        await p.locator('.chat-sheet [data-chat-back]').click();
        await p.locator('.drawer h2', { hasText: 'Acme Traders' }).waitFor();
        await p.keyboard.press('Escape');
        await p.locator('.drawer').waitFor({ state: 'detached' });

        // Settings: switching sending on asks first, with the ban risk.
        where = `settings, sending ${tag}`;
        await p.goto(`${base}/dashboard/settings`);
        await p.locator('#send-card [data-send-switch][aria-checked="false"]').waitFor();
        await p.locator('#send-card').scrollIntoViewIfNeeded();
        await p.screenshot({ path: join(OUT, `settings-sending-${tag}.png`), fullPage: true });
        await p.locator('[data-send-switch]').click();
        await p.locator('.modal h2', { hasText: "Allow sending from the founder's WhatsApp?" }).waitFor();
        await p.locator('.modal [data-yes]').click();
        await p.locator('#send-card [data-send-switch][aria-checked="true"]').waitFor();

        // Reply to a message: the confirm dialog shows the exact text and the group; Send, then the bubble says Sent.
        where = `open chat, send ${tag}`;
        await p.goto(`${base}/dashboard/clients`);
        await p.locator('.ccard').first().waitFor();
        await openAcmeChat();
        await p.waitForTimeout(300);
        await p.screenshot({ path: join(OUT, `chat-${tag}.png`) });
        const target = p.locator('.chat-sheet .ch-row[data-msg]', { hasText: 'See you at 11 tomorrow' });
        await target.hover();
        await target.locator('.ch-reply').click();
        await p.locator('.chat-sheet .ch-replying .ch-quote', { hasText: 'See you at 11 tomorrow' }).waitFor();
        const words = `See you there ${tag}\nI'll bring the samples`;
        await p.locator('#ch-text').fill(words);
        await p.locator('#ch-text').press('Enter');
        await p.locator('.modal h2', { hasText: 'Send this from your WhatsApp to Acme Traders x Studio?' }).waitFor();
        if ((await p.locator('.modal .m-quote').textContent()) !== words) fail(where, 'the dialog does not show the exact text');
        await p.waitForTimeout(300);
        await p.screenshot({ path: join(OUT, `chat-confirm-${tag}.png`) });
        await p.locator('.modal [data-yes]').click();
        await p.locator('.chat-sheet .ch-own.ok .ch-state', { hasText: 'Sent' }).waitFor();
        await p.locator('.chat-sheet .ch-own .ch-quote', { hasText: 'See you at 11 tomorrow' }).waitFor();
        if ((await p.locator('#ch-text').inputValue()) !== '') fail(where, 'the text box was not emptied');
        await p.waitForTimeout(300);
        await p.screenshot({ path: join(OUT, `chat-sent-${tag}.png`) });
        await p.keyboard.press('Escape');
        await p.locator('.chat-sheet').waitFor({ state: 'detached' });

        // Off again, so the next round starts as the owner would: sending off. Switching off asks nothing.
        where = `settings, sending off ${tag}`;
        await p.goto(`${base}/dashboard/settings`);
        await p.locator('[data-send-switch][aria-checked="true"]').click();
        await p.locator('#send-card [data-send-switch][aria-checked="false"]').waitFor();
        await p.goto(`${base}/dashboard/clients`);
        await p.locator('.ccard').first().waitFor();

        where = `sync tracker ${tag}`;
        await p.locator('.synch', { hasText: 'Tracker updated' }).waitFor();
        await p.locator('.synch [data-action="upload-tracker"]').click();
        await p.locator('.toast', { hasText: 'Tracker.xlsx uploaded to Drive' }).waitFor();
        await p.locator('.synch [data-action="upload-tracker"]:not([disabled])').waitFor();
        state.rateLimited = true; // the agent's 5-a-minute limit
        await p.locator('.synch [data-action="upload-tracker"]').click();
        await p.locator('.toast', { hasText: 'Too many tries' }).waitFor();
        state.rateLimited = false;

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

        // Several at once: a shift-click range, approved together. The fake makes codes as the agent does: the third
        // group of a family has none left, so it fails on its own and the others still go through.
        where = `manage groups bulk ${tag}`;
        const family = BULK_WORDS[bulkRound++ % BULK_WORDS.length]!;
        await p.locator('#g-q').fill(family);
        await p.waitForURL(new RegExp(`q=${family}`));
        await p.waitForFunction((w) => [...document.querySelectorAll('.g-row')].every((r) => (r.textContent ?? '').includes(w)), family);
        const ticks = p.locator('[data-select]');
        await ticks.nth(0).click();
        await ticks.nth(2).click({ modifiers: ['Shift'] });
        await p.locator('.selbar', { hasText: '3 selected' }).waitFor();
        if ((await p.locator('.g-row.selected').count()) !== 3) fail(where, 'the shift-click range did not tick 3 groups');
        await p.waitForTimeout(500);
        await p.screenshot({ path: join(OUT, `groups-selected-${tag}.png`) });
        if (vp.name === 'laptop' && theme === 'dark') {
          // Dragging a ticked group carries all three: dropped on the right, it asks to approve the three (cancelled here).
          where = `manage groups drag selection ${tag}`;
          await p.locator('.g-row.selected').first().dragTo(p.locator('.board.on'), { targetPosition: { x: 60, y: 30 } });
          await p.locator('.modal h2', { hasText: 'Track 3 groups?' }).waitFor();
          await p.locator('.modal [data-no]').click();
          await p.locator('.modal').waitFor({ state: 'detached' });
          where = `manage groups bulk ${tag}`;
        }
        await p.locator('#g-bulk-approve').click();
        await p.locator('.modal h2', { hasText: 'Track 3 groups?' }).waitFor();
        await p.locator('.modal [data-yes]').click();
        await p.locator('.g-outcome', { hasText: '2 approved, 1 failed: No code could be made from its name' }).waitFor();
        if ((await p.locator('.g-row.selected').count()) !== 1) fail(where, 'the group that failed is not still ticked');
        await p.waitForTimeout(500);
        await p.screenshot({ path: join(OUT, `groups-bulk-result-${tag}.png`), fullPage: true });

        // Select all, ignore them, then show one again from the Ignored list.
        where = `manage groups ignore ${tag}`;
        await p.locator('#g-all').check();
        const many = Number(await p.locator('.selbar b').textContent());
        if (!(many > 3)) fail(where, `Select all ticked ${many}`);
        await p.locator('#g-bulk-ignore').click();
        await p.locator('.g-outcome', { hasText: `${many} groups ignored.` }).waitFor();
        await p.locator('.selbar').waitFor({ state: 'detached' });
        await p.locator('[data-filter="ignored"]').click();
        await p.locator('[data-unignore]').first().waitFor();
        await p.locator('[data-unignore]').first().click();
        await p.locator('.g-outcome', { hasText: '1 group shown again.' }).waitFor();
        await p.waitForTimeout(400);
        await p.screenshot({ path: join(OUT, `groups-ignored-${tag}.png`), fullPage: true });

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
        // Each Google card names its account by email; the Drive card says which account it writes as.
        await p.locator('[data-conn="google:main"] h3', { hasText: 'owner@example.com' }).waitFor();
        await p.locator('[data-conn="google:main"]', { hasText: 'Account name: main' }).waitFor();
        await p.locator('[data-conn="drive"]', { hasText: 'Writes as' }).waitFor();

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
