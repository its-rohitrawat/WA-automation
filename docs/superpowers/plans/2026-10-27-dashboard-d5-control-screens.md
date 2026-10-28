# Owner dashboard D5: AI usage, Automations, Audit logs, Settings, go-live guide

> **For agentic workers:** use superpowers:subagent-driven-development or superpowers:executing-plans, task by task, tests first. Task 1 changes how the morning briefing reads its settings. Read `src/report/start.ts`, `src/report/scheduler.ts` and `src/config/env.ts` first, and keep every safety rule in `docs/superpowers/specs/2026-10-23-morning-report-design.md`.

**Goal:** the owner can:
- switch the morning briefing on or off and choose its days and number, live, from the dashboard;
- check AI costs and uptime history;
- read the audit trail and manage the session.

The go-live steps are written down for the owner.

**Architecture:**
- A `settings` table (from migration v9) holds the values the owner changed in the dashboard. A `SettingsStore` combines them with the `.env` defaults.
- The report scheduler reads its settings through a getter on every tick.
- The uptime history comes from `uptime_log`, which the agent writes itself, or from UptimeRobot's read-only API when a read key is set.

**Depends on:** D1–D4.

**Spec:** sections 4.7, 4.8, 5, 9, 10, 11.

**Ground rules:**
- As in D1.
- The morning-report rules all stay:
  - the founder reader never sends;
  - the sender messages only the configured recipient;
  - claim before send, at most once per IST date;
  - an unknown outcome is never retried;
  - catch up until the deadline;
  - no AI spend.
- The recipient is shown masked everywhere. The full number is only ever typed by the owner, never sent back to the browser.
- The spend cap stays `.env`-only.

---

## Task 1: Runtime settings (`src/config/settingsStore.ts`)

- **`SettingsStore(db, env, clock)`:** `get()` returns `{ reportEnabled, reportDays, reportRecipient, source: { reportEnabled: 'env'|'dashboard', … } }`. A dashboard value wins over `.env`.
- **`set(key, value, actor)`** validates each key:
  - `reportDays` must be in the enum;
  - `reportRecipient` must match `INDIAN_MOBILE`;
  - `reportEnabled` can't be true without a recipient and a linked spare phone.
- It writes the row, audits (kind `config`, the number masked), and notifies listeners.
- **Report wiring** (`src/report/start.ts`, `scheduler.ts`):
  - the scheduler takes `settings: () => ReportSettings` instead of a fixed object, and reads it on each tick;
  - a recipient change rebuilds the `SenderGateway` with the new number (the recipient stays fixed per sender instance, as today);
  - switching on when the report module was never opened (`REPORT_ENABLED=false` at startup) opens it lazily through `openMorningReport`;
  - switching off stops sending from the next tick, and an in-flight send finishes under the existing rules.
- **Tests:**
  - precedence;
  - every validation;
  - masked audit;
  - the scheduler picks up a days change on the next tick;
  - turning on at runtime opens the module once;
  - turning off skips the next scheduled send;
  - a recipient change rebuilds the sender and the old instance is stopped;
  - every existing report safety test still passes.

## Task 2: AI usage API (`src/web/routes/usage.ts`)

- **`GET /dashboard/api/usage`:**
  - today's `spentToday`, `spentTodayByKind`, `capUsd`, remaining and `isPaused`;
  - a 14-day series from `spend` (IST days, zero-filled);
  - today's breakdown by kind with labels (messages to tasks, meeting summaries, speech to text);
  - voice notes on the Mac shown at $0;
  - today's batch count and messages read.
- **Tests:** zero-filling; IST day boundaries; the paused state; remaining is never negative.

## Task 3: Uptime history (`src/health/uptimeLog.ts`, `src/health/uptimeRobot.ts`)

- **`UptimeLog`:**
  - the tick records a row only when `isUp()` changes, plus one row at startup;
  - `daily(days = 30)` returns per IST day the minutes down and the longest outage;
  - `outages(days = 30)` returns start, duration and reason when known.
- **`UptimeRobotClient`** (only when `UPTIMEROBOT_READ_KEY` is set):
  - a server-side `getMonitors` call with custom uptime ratios for 1, 7 and 30 days, a 10 s timeout and a 5-minute cache;
  - the key is sent only to UptimeRobot, is never logged, and is never in a response;
  - on failure it falls back to `UptimeLog`.
- **`GET /dashboard/api/uptime`:** `{ source: 'uptimerobot'|'agent', ratios: { d1, d7, d30 }, days: [...], outages: [...] }`.
- **Tests:**
  - transitions only;
  - daily maths across midnight IST;
  - the fallback when the API fails;
  - the key absent from the response and from logs (a fake fetch records headers);
  - the cache.

## Task 4: Audit logs and sessions API

- **`GET /dashboard/api/audit?kind=&before=&limit=`:** newest first. Actor emails are shown in full only for owners; other emails are masked.
- **Retention:** a daily `purgeOlderThan(90)`.
- **`GET /dashboard/api/session`:** the current session (signed in, expires, browser label).
- **`POST /dashboard/api/session/signout-everywhere`:** `destroyAllFor(email)`, audited.
- **Tests:** filters and paging; masking; purge; sign out everywhere ends the other sessions.

## Task 5: Front end: AI usage, Automations, Audit logs, Settings

- **AI usage** (follow the dataviz rules from the mockup work):
  - the KPI row;
  - the 14-day bar chart: single series, today highlighted, cap as a dashed reference line, a per-bar tooltip, and a visually hidden data table;
  - "today by kind".
- **Automations:**
  - the briefing switch, disabled until the spare phone is linked, with **Link phone** opening the D3 dialog;
  - the confirmation dialog "Start sending to the founder?";
  - a days select;
  - **Change number**: type the number twice; the screen shows only the masked number;
  - the WhatsApp-style preview;
  - the status pill with the next send time from the scheduler.
- **Audit logs:** filter tabs, and the table that becomes cards on phones.
- **Settings:**
  - owner details;
  - this session;
  - **Sign out** and **Sign out everywhere**;
  - time zone (display only);
  - appearance;
  - the security notes from the mockup.
- **Vitals strip on Overview:** uses `/api/uptime`.
- **Smoke test:** each screen, the switch flow (link, then on, then off), phone width, both themes.

## Task 6: Go-live guide (`docs/GO-LIVE.md`): owner steps, written and not run

1. **Back up the Mac's `data` folder**, then check the copy opens (`sqlite3 tracker.db "select count(*) from tasks"`).
2. **Update and settings:**
   - make sure the Mac's update step runs `npm ci` after pulling;
   - set the `DASHBOARD_*` values and restart.
3. **Google Cloud:**
   - create the web OAuth client;
   - add the redirect URIs for localhost and for `waagent.agentsolutionbowl.si`;
   - add `agentsolutionbowl.si` as an authorized domain (it needs ownership proof in Google Search Console);
   - keep the app "In production".
4. **Cloudflare:**
   - move the domain's DNS to Cloudflare;
   - create the Pages project for the website;
   - install `cloudflared` on the Mac as a launchd service, and create the tunnel to `http://127.0.0.1:8787`;
   - protect the tunnel hostname with an Access service token;
   - deploy the routing Worker from the website repo, with the token as a Worker secret.
5. **Optional:** Cloudflare Access with Google in front of `/dashboard`.
6. **Check:**
   - the homepage loads;
   - `/dashboard` signs in;
   - stopping the agent shows "Agent offline";
   - starting it brings the dashboard back.

Lock the guide's key steps in `tests/docs/setup.test.ts` (the backup step, `npm ci`, and the redirect paths).
