# Merge readiness: feat/saas-s1 into main, with default settings (30 Oct, lane B, read-only)

Compared: today's `main` (450f822) with `feat/saas-s1` (ac8ad04): 147 commits, 168 files under `src/`. This review is by
reading the code only; no change was made.

**The promise checked:** with default settings (`DB_ENGINE` unset, so SQLite; `PLATFORM_ENABLED` unset, so off;
`INVITES_GMAIL` off; no new `.env` keys), the Mac behaves exactly like today's main.

**Verdict:** it holds, with a few small, deliberate behaviour changes, listed below. The review found two conditions
(R1 and R2), and both are **resolved** in d12eac6. Neither depends on the Mac's update script or `.env` any more.
- Condition 1 (resolved): the new `pg` package was loaded at start even on SQLite, so the update step had to run `npm ci`.
- Condition 2 (resolved): a new platform ceiling of US$100 applied to the founder by default, so `DAILY_SPEND_CAP_USD`
  had to stay at or below 100.
- There is **no SQLite schema change**, no new required `.env` key, and no new file under `data/` unless the platform is
  switched on.
- Nothing sent to WhatsApp, Claude or Google changes for the founder.

## Ranked: what to check or know before merging

| # | Risk | Where | What changes with defaults | What to do |
|---|---|---|---|---|
| R1 | **Medium** (the service would not start) | `package.json` (`"pg": "8.23.1"`, new); `src/main.ts`, then `src/store/open.ts:4`, then `src/store/engine/pg.ts:2` (`import pg from 'pg'`) | `pg` is imported at start even on SQLite, because `openStore` imports the Postgres engine module statically. Without `npm ci` after the pull, the service refuses to start with "Cannot find package 'pg'". Once it's installed it's harmless: pure JavaScript, no install script, and nothing connects on SQLite. | Confirm the Mac's update step runs `git pull --ff-only`, then `npm ci`, then the restart (docs/SETUP-mac.md:294 says it must). Optional, lane A: import `pg` lazily, only when `DB_ENGINE=postgres`. |
| R2 | **Low** (only if the founder's cap is above US$100) | `src/main.ts` (`new GlobalSpend({ capUsd: env.PLATFORM_DAILY_SPEND_CAP_USD })`, made unconditionally); `src/runtime/customerRuntime.ts:374` (`t.founder && d.globalSpend`); `src/config/env.ts:64` (default 100) | The founder's SpendGuard joins a platform ceiling of **US$100 a day** even with the platform off. Every check (`reserve`, `canSpend`, `isPaused`) must fit the founder's own cap AND the ceiling. With `DAILY_SPEND_CAP_USD` at its default of 15, or anything up to 100, nothing changes. Above 100, spending stops at 100 a day, and Health shows the same spend-cap line. | Check the Mac's `.env`: `DAILY_SPEND_CAP_USD` ≤ 100, or set `PLATFORM_DAILY_SPEND_CAP_USD` higher. Optional, lane A: create the ceiling only with `PLATFORM_ENABLED`. |
| R3 | Low (deliberate) | `src/store/messages.ts` (S2.5, dbb64ba) | `INSERT OR IGNORE` becomes `INSERT … ON CONFLICT DO NOTHING`. A duplicate is still skipped. A message row that breaks another rule (a `NOT NULL`) is now an error: logged as 'ingest failed' and counted in Health's ingest failures, where main dropped it in silence. A normal event is unaffected. | None. It surfaces a broken event instead of hiding it. |
| R4 | Low (deliberate, more accurate) | `src/wa/historyBackfill.ts` (c7 review finding, S1.12b) | The "read N earlier messages" count after a history backfill counts only the backfill's own new messages. Main also counted live messages that arrived while it read. The number shown may be smaller, and it's now correct. | None. |
| R5 | Low (a fix) | `src/media/processor.ts` (`#noteUnansweredCopy`, S1.12a) | A media copy whose "to be deleted" note can't be written is no longer sent for deletion. It's logged as `forget_not_noted` and kept. On main a missing await meant the note's failure was never seen. | None. |
| R6 | Low (performance) | `src/store/engine/sqlite.ts`, `queue.ts` | Every database call now goes through the async engine's one FIFO queue (S1). Same file, same pragmas (`journal_mode=WAL`, `foreign_keys`, `busy_timeout=5000`, `secure_delete`, compared line by line), and the same statements. Only the timing differs. 15 measured before and after on 30 Oct. | Read 15's measurement before merging. |
| R7 | Low | `src/web/start.ts` (the dispatcher, ~lines 183-206) | Each dashboard API request now does one extra session read (`requireSession`) before its route's own guard, to send a customer's session to its runtime. For the founder it always lands on the founder's routes. The session's last-seen time is still written at most once a minute. Same answers, one more indexed read per request. | None. |
| R8 | Info | `src/web/routes/auth.ts` (`/dashboard/api/me`) | `/me` gains `role: 'founder'` and `platform: false` (and `workspaces` for a customer only). The shell reads them: the founder's nav is exactly today's `NAV` (router.js `navFor` returns `NAV` when the platform is off; `NAV` is byte-identical to main's). | None. |

**Resolved (d12eac6, landed with 33b2163; full suite 4718 passed, 0 failed):**
- **R1:** `src/store/engine/pg.ts` imports only the *type* of `pg` (line 3). It loads the package with `createRequire` on the first Postgres pool or admin connection (lines 13 and 24), not at import. On SQLite nothing in the start resolves `pg`, so a missing package can't stop the service. A child-process test with a resolve hook checks this, with a Postgres pool as the control. `npm ci` on update is still right, but no longer needed for the default path.
- **R2:** `src/main.ts:95` makes the ceiling only with the platform on (`env.PLATFORM_ENABLED ? new GlobalSpend(…) : undefined`). With defaults the founder's SpendGuard joins nothing, and only `DAILY_SPEND_CAP_USD` limits it, as on main.

## 1. SQLite schema: no change

- `src/store/migrations.ts` is **unchanged** between 450f822 and ac8ad04. There's no new or changed SQLite migration, so `tracker.db`'s schema and its `schema_version` rows stay exactly as they are.
- `src/store/engine/sqliteMigrate.ts` (new) is the same `migrate()` as main's `store/db.ts`, moved behind the engine: the same `schema_version` table, the same refusal of a skipped version, and the same per-migration transaction.
- The platform tables (`src/platform/schema.ts`: tenants, users, memberships, invites, platform_audit, tenant_keys) are created in `tracker.db` **only with `PLATFORM_ENABLED`** (`src/main.ts:73-76`), using `CREATE TABLE IF NOT EXISTS`. With defaults, nothing is created.
- The WhatsApp session files (`data/session.db`, `data/sender-session.db`) are opened with the same pragmas, now through `src/store/engine/sessionFile.ts`.

So there's nothing to reverse with defaults. (Switching `PLATFORM_ENABLED` on later adds those tables. That's additive, and the founder's backup before enabling would cover it.)

## 2. Routes and what the founder sees in the dashboard

- **No route was removed or renamed.** The new routes are:
  - `/dashboard/api/platform/*` (10). Mounted only when the founder's runtime has `platformDb`, which needs `PLATFORM_ENABLED` (`customerRuntime.ts:269,577`).
  - `/signup`, `/signup/api/invite`, `/signup/google`, `/signup/callback`. These mount under the same condition (`customerRuntime.ts:579`).
  - `/dashboard/api/workspaces` and `/workspaces/switch`. Mounted only with customer sessions, which means Postgres and the platform on (`start.ts:142-150`; `auth.ts:286-288`, which returns early without `workspaces`).
- **Changed behaviour on existing routes, for the founder: none.**
  - `inScope` (503 workspace_starting) and `requireOwner` (403) apply only to a session whose role isn't `'founder'`.
  - On SQLite every session is the founder's: `SessionStore.create` refuses any other tenant there (`sessions.ts:119`), and `get` gives the founder's id.
  - The Google connect state stays the random hex of before, because its signing key is passed only through the platform (`main.ts`, `googleHooks: platform.google`).
- **Dashboard UI with defaults: unchanged for the founder.**
  - `NAV`, `index.html` and every existing screen's view are unchanged. Only `app.js`, `api.js`, `router.js`, `placeholder.js` and a 3-line `styles.css` addition (the locked-entry style, customers only) changed.
  - The platform screens' modules are imported (`views/platform.js`), but their entries and addresses appear only when `/me` says `platform: true`.
  - The "workspace starting" handler runs only on a 503 `workspace_starting`, which the founder never gets.

## 3. Start-up, shutdown, environment, dependencies, files

- **New `.env` keys: none required.** Each new key has a default or is optional:
  - with defaults: `PLATFORM_ENABLED` (false), `PLATFORM_DAILY_SPEND_CAP_USD` (100, see R2), `PLATFORM_FOUNDER_NAME`, `PLATFORM_MAX_ACTIVE`, `PLATFORM_MAX_RSS_MB`, `INVITES_GMAIL` (false), `DB_ENGINE` (sqlite), `TENANT_ID` (the founder's fixed id);
  - optional: `DATABASE_URL`, `DATABASE_PLATFORM_URL`, `DATABASE_OWNER_URL`.
  - The new checks apply only with `DB_ENGINE=postgres`. Today's `.env` parses as before.
- **Start-up order, defaults:** the groups-file check, the instance lock, the master key, `openStore` (the same `data/tracker.db`), then `platformDb`, which is the tracker itself (`open.ts:45`). Then the groups file, the one local speech engine (only if a setting is `local`), the founder's runtime and the dashboard. The platform schema, the founder tenant and the Supervisor are all skipped without `PLATFORM_ENABLED`.
- **Shutdown:** the same order (the dashboard, then the runtime, then the databases). `platform?.stop()` does nothing without the platform.
- **New dependency:** `pg` 8.23.1, loaded at start (R1). There are no other new packages.
- **New files under `data/` with defaults: none.** `data/tenants/<id>` is made only for a customer runtime (platform on). The migration commands (`migrate-to-postgres`, `export-to-sqlite`) write only when run by hand, to the folder given.

## 4. The founder's own features

- **Morning report:** the scheduler, live report, sender link and report start changed only to async. The sender's session is the same file through `SessionHome` on SQLite. The kv writes inside the report's transaction now use its handle. The same report is sent at the same time.
- **Open chat:** the routes, queries and outbox changed only to async. `src/wa/groupSend.ts` and `src/wa/senderGateway.ts` are **unchanged**.
- **The assistant:** its tools, proposals and assistant changed only to async. It's still on with the dashboard (`DASHBOARD_ASSISTANT` default true), under the founder's cap.
- **Drive publishing:** drive.ts and folders.ts changed only to async. The root, tracker and folder ids are in kv as before. view.ts reads its clients through `Promise.all`, keeping their order.
- **Uptime:** the uptime log loads through `open()` (S1.15e): the same data, read the same way.
- **Spend:** the same SpendGuard, plus the platform ceiling (R2). `dailySpendCapUsd` is **customer-only**: the founder's settings store refuses it, and the founder's cap stays `DAILY_SPEND_CAP_USD` from `.env` (`settingsStore.ts:17-25,122`).
- **Groups:** the founder's groups routes use `fileGroupsStore(env.GROUPS_FILE, …)` (`customerRuntime.ts:546-547`), whose writes are `applyGroupChanges` with the same queue, `.tmp` and `.bak` and the same messages. `tests/config/groupsWriter.test.ts` is unchanged and passes, and a test checks the store writes the same bytes as applyGroupChanges (`tests/config/groupsStore.test.ts`). The file watcher reloads as before.

## 5. What goes to WhatsApp, Claude and Google for the founder: unchanged

- **Claude:** the reconciler (`src/brain/reconciler.ts`) changed only in handles and awaits (`txSync` became `db.tx`, `getClient(q, …)` and the like). I checked word by word: no change to what is put in a prompt or how a reply is applied. Media reads (extract.ts) and meetings (transcribe.ts) changed only to async. The founder keeps the founder's key and prices.
- **WhatsApp:** the gateway is the same for the founder. The new `guarded()` wrapper applies only to a customer's gateway (`customerRuntime.ts:337`), and the group send and sender gateway are unchanged.
- **Google:** with `INVITES_GMAIL` off, `requestedScopes` asks for exactly what main asks for (`googleAuth.ts`). The consent and the token storage are the same through the hub. The founder's Drive and meetings calls are unchanged.

## Not checked here

- The Mac's own `.env`, needed for R2, and its update script, needed for R1. Both are on the Mac.
- Performance under the async engine (R6): 15's measurement is the source.
- Postgres and platform-on behaviour: it isn't part of the default-settings promise. See the isolation review (2026-10-30-isolation-review.md).
