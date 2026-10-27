# Owner dashboard D1: foundation (web server, owner sign-in, Overview, Connections status)

> **For agentic workers:** use superpowers:subagent-driven-development or superpowers:executing-plans, task by task, tests first.

**Goal:** a signed-in owner opens `http://localhost:8787/dashboard` on the Mac and sees the real agent's health, numbers and connection states, in the agreed design. Nothing can be changed yet except signing out.

**Architecture:** a small `node:http` server inside the agent (`src/web/`), bound to 127.0.0.1, started by `main.ts` when `DASHBOARD_ENABLED=true`. It talks only to a new `AgentControl` object (`src/control/`), which reads the live `App`, the database and the health snapshot. The front end is plain ES modules, CSS and HTML in `src/web/public/` (no build step), matching `C:\Users\Dell\Desktop\wa-agent-mockups\pages\dashboard.html`.

**Tech stack:** Node 24 (TypeScript run directly), `node:http`, better-sqlite3, `google-auth-library` (already in the tree through `@googleapis/drive`; add it as a direct dependency at the same version), vitest. Front end: GSAP, Three.js, Geist fonts and `@hugeicons/core-free-icons` as npm dependencies served by the agent from `node_modules`; `playwright-core` as a dev dependency for the browser smoke test.

**Spec:** `docs/superpowers/specs/2026-10-27-web-dashboard-and-website-design.md` (sections 4, 5, 6, 8, 10, 13).

**Ground rules (binding for every task):**
- Never read `.env`; no real WhatsApp, Google, Anthropic or network in tests (inject fakes).
- Tests first. Full suite (`npm test`) and `npm run typecheck` clean before each commit. Run tests from `C:\Users\Dell\Desktop\WA_agent` (exact casing).
- No secret, token, cookie, QR code, full phone number or message text in any log line or API response. Phone numbers appear masked (`maskNumber`).
- The founder-number reader never sends. Nothing in this phase sends any message.
- New database changes go in a **new** migration (v9). Never edit v1–v8.
- Commit on `feat/web-dashboard` only. Never push.

---

## Task 1: Settings and migration v9

- **`src/config/env.ts`:**
  - `DASHBOARD_ENABLED: Flag.default(false)`
  - `DASHBOARD_PORT: z.coerce.number().int().min(1024).max(65535).default(8787)`
  - `DASHBOARD_PUBLIC_URL: z.string().url().optional()`, which must start with `https://` or be `http://localhost:<port>` / `http://127.0.0.1:<port>`.
  - `DASHBOARD_OWNER_EMAILS`: a comma-separated list, trimmed and lower-cased; each entry must be an email; at least one is required when the dashboard is enabled.
  - `DASHBOARD_GOOGLE_CLIENT_ID` and `DASHBOARD_GOOGLE_CLIENT_SECRET`: `z.string().min(1).optional()`, both required when `DASHBOARD_ENABLED`.
  - `UPTIMEROBOT_READ_KEY: z.string().min(1).optional()`.
  - Cross-checks go in `superRefine` with value-free messages (for example `DASHBOARD_OWNER_EMAILS is required when DASHBOARD_ENABLED is true`).
- **`.env.example`:** the new names with empty values and one-line comments.
- **`src/store/migrations.ts`:** migration **9**:
  - `web_sessions(id_hash TEXT PRIMARY KEY, email TEXT NOT NULL, csrf_hash TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, agent_label TEXT)`.
  - `audit_log(id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, event TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('auth','config','connection','task','meeting','ops')), detail TEXT NOT NULL, request_id TEXT)`, with an index on `at`.
  - `settings(k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL)`.
  - `uptime_log(id INTEGER PRIMARY KEY, at TEXT NOT NULL, up INTEGER NOT NULL)`, with an index on `at`.
- **Tests:**
  - defaults, with the dashboard off by default;
  - a bad port, a bad URL (`http://example.com`), a bad email and missing required values each name only the variable;
  - emails are lower-cased and de-duplicated;
  - the migration applies on a fresh DB and on a v8 DB with data, and v1–v8 rows are untouched;
  - `schema_version` reaches 9.

## Task 2: Web server core (`src/web/http.ts`, `src/web/router.ts`, `src/web/server.ts`)

- **`router.ts`:** `createRouter()` with `get/post(path, handler)`. Paths support `:param` segments; there is no regex user input. `match(method, pathname)` returns `{ handler, params }` or `undefined`.
- **`http.ts`:**
  - `readJson(req, limitBytes = 65_536)`: rejects bodies over the limit with 413 and bad JSON with 400.
  - `sendJson(res, status, body)` and `sendError(res, status, code, message)` (shape `{ error: { code, message } }`; messages are plain and never contain stack traces or internal paths).
  - `parseCookies(header)` and `serializeCookie(name, value, opts)`.
  - `securityHeaders(res)`:
    - `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://accounts.google.com`
    - `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `Cache-Control: no-store` on API responses.
  - `requestId()`: 12 random hex characters.
- **`server.ts`:** `createWebServer({ control, env, log, clock, verifier })` returns `{ start(): Promise<{ port }>, stop(): Promise<void> }`.
  - Listens on `127.0.0.1` at `DASHBOARD_PORT` (port 0 allowed in tests).
  - Serves:
    - static files from `src/web/public/` under `/dashboard/static/`;
    - vendor files from a fixed allowlist under `/dashboard/vendor/` (task 7);
    - `index.html` for `/dashboard` and every `/dashboard/<screen>` path, so the front end routes.
  - Static serving rules:
    - resolve the path and refuse anything outside the folder (`..`, encoded `%2e%2e`, absolute paths, backslashes) with 404;
    - correct MIME types for `.html .js .css .woff2 .svg .json`;
    - `ETag`, and `Cache-Control: public, max-age=3600` for vendor files.
  - Logs one line per request: method, path pattern (not the full query), status and duration. No cookies, no headers.
  - `stop()` closes idle connections and waits for in-flight requests (up to 5 s).
- **`src/main.ts`:** when `env.DASHBOARD_ENABLED`, build `AgentControl` (task 5) and the web server after `app.start()`, start it, and log `dashboard on http://127.0.0.1:<port>/dashboard`. On shutdown, stop the web server first. When the dashboard is off, nothing changes.
- **Tests** (real server on port 0, `fetch` to it):
  - an unknown route gives 404 JSON;
  - every traversal variant gives 404;
  - the security headers are present;
  - `/dashboard/tasks` serves `index.html`;
  - a body over the limit gives 413;
  - `stop()` resolves while a slow handler finishes;
  - the server binds 127.0.0.1 only (check `server.address()`);
  - `main.ts` source scan: the server starts only when `DASHBOARD_ENABLED` is set, and stops before `app.stop()`.

## Task 3: Sessions, CSRF, rate limits, audit log (`src/web/auth/sessions.ts`, `src/web/auth/guard.ts`, `src/web/audit.ts`)

- **`SessionStore(db, clock)`:**
  - `create(email, agentLabel)`: random 32-byte id and 32-byte CSRF token (base64url). Stores SHA-256 hashes only. `expires_at` is now + 7 days. Returns `{ id, csrf }`.
  - `get(id)`: returns `{ email, csrfHash, createdAt, expiresAt }`, or undefined when missing, expired, or idle for more than 24 h. On success it updates `last_seen_at` at most once a minute.
  - `destroy(id)`, `destroyAllFor(email)`, and `purgeExpired()` (called hourly by the server).
- **Cookie:** `wa_session=<id>; HttpOnly; SameSite=Lax; Path=/dashboard; Max-Age=604800`, plus `Secure` when `DASHBOARD_PUBLIC_URL` is https. Signing out clears it (`Max-Age=0`).
- **`guard.ts`:**
  - `requireOwner(req)` returns the session or a 401 JSON.
  - `requireCsrf(req, session)` applies to every non-GET API request:
    - the `Origin` header must equal the public origin (or the localhost origin);
    - the `X-CSRF-Token` header must hash to `csrfHash`;
    - otherwise 403.
  - `RateLimiter({ capacity, refillPerSec })` keyed by client address (the `CF-Connecting-IP` header only when the request comes from 127.0.0.1 through the tunnel; otherwise the socket address). Sign-in routes allow 10 per minute; actions allow 30 per minute; over the limit gives 429.
- **`AuditLog(db, clock)`:**
  - `record({ actor, event, kind, detail, requestId })`: detail is plain text, at most 300 characters, already free of secrets (callers pass masked values).
  - `list({ kind?, before?, limit = 100 })`.
  - `purgeOlderThan(days = 90)`.
- **Tests:**
  - a session round-trip;
  - only hashes are in the DB (no raw id or CSRF in any column);
  - expiry at 7 days and the 24 h idle timeout (with a fake clock);
  - `destroy` makes `get` undefined;
  - the Secure flag follows the public URL;
  - CSRF: missing or wrong token gives 403, wrong Origin gives 403, correct gives pass;
  - the rate limiter allows exactly the capacity and then 429, and refills over time;
  - audit list order and paging, and the 90-day purge.

## Task 4: Owner sign-in (`src/web/auth/oidc.ts`, routes in `src/web/routes/auth.ts`)

- **`GET /dashboard/auth/login`:**
  - creates a pending sign-in record in memory: `state`, `nonce` and PKCE verifier, kept for 10 minutes and tied to a short `wa_signin` cookie (HttpOnly, Lax, `Path=/dashboard/auth`).
  - redirects (302) to Google's authorize URL with scopes `openid email profile`, `prompt=select_account`, the `code_challenge` (S256) and the redirect `<public or localhost origin>/dashboard/auth/callback`.
  - takes an optional `return=/dashboard/<screen>` (validated against a known-screens list; anything else becomes `/dashboard`).
- **`GET /dashboard/auth/callback`:**
  - checks the `state` against the pending record (one use);
  - exchanges the code with the verifier;
  - verifies the ID token through an injectable `verifier` (production: `OAuth2Client.verifyIdToken({ idToken, audience: clientId })`), checking issuer `accounts.google.com` / `https://accounts.google.com`, audience, expiry and `nonce`;
  - requires `email_verified === true`;
  - the email (lower-cased) must be in `DASHBOARD_OWNER_EMAILS`.
  - **On success:** create a session, set the cookie, audit `Signed in` (kind `auth`, detail `<browser label>`), and redirect to the `return` path.
  - **On refusal:** audit `Sign-in refused` with the email masked as `ab••••@domain`, and redirect to `/dashboard?denied=1` (the page shows "This account can't open the dashboard").
  - Any other failure redirects to `/dashboard?error=signin` with a plain message and logs the code only.
- **`POST /dashboard/auth/logout`:** CSRF-checked; destroys the session, clears the cookie, audits `Signed out`, and returns 204.
- **`GET /dashboard/api/me`:** gives `{ email, name, signedInAt, expiresAt, csrf }` for a valid session, else 401. The CSRF token is returned only here, over the authenticated same-origin request, and kept in memory by the front end.
- **Tests** (fake Google token endpoint and fake verifier):
  - happy path;
  - wrong `state`, replayed `state` and expired pending record are each refused;
  - bad `nonce` is refused;
  - `email_verified` false is refused;
  - an email not on the list is refused and audited with the masked email;
  - `return` sanitising (`//evil.com`, `https://evil.com`, `/dashboard/../x`);
  - the cookie flags;
  - logout without CSRF gives 403;
  - no response body or log line contains the code, tokens or the ID token.

## Task 5: `AgentControl` read side (`src/control/agentControl.ts`, `src/control/queries.ts`)

- **`src/app.ts`:**
  - The `App` interface gains `spend: { spentToday(): number; spentTodayByKind(): { ai: number; stt: number }; capUsd: number; isPaused(): boolean }`, a read-only view of the existing `SpendGuard`.
  - `main.ts` passes the `gateway` (`status()` only for now) and, when the report is on, `report` status into `AgentControl`.
- **`AgentControl({ app, db, gateway, env, clock })`** read methods:
  - `status()`: the live `app.health.snapshot()` reduced to what the UI needs:
    - the overall line;
    - per part (WhatsApp, Drive tracker, meetings with lost accounts, voice notes, morning report, Claude spend) a state of `ok | warn | down | off` with a plain label;
    - the last message time;
    - `spentToday`, `capUsd` and `isUp()`.
  - `overview()` (from `queries.ts`, plain SQL with parameters):
    - active client count;
    - open, overdue (deadline before today IST and not done), needs review (`maybe_done`) and done-this-week counts;
    - per-client segments in the agreed stack order;
    - the latest 4 meetings (title, status label, when, minutes);
    - the latest 5 activity items from `task_events` and `batches`;
    - tracker last publish time and health.
  - `connections()`: one entry per card:
    - founder WhatsApp: state, approved group count, last activity, device name `WA Agent - Tracker`;
    - spare WhatsApp: sender state, device name `WA Agent - Morning report`;
    - each Google account: label, masked email when known, used-for and state from `lostAccounts()` and publish auth state;
    - Drive: last upload;
    - Claude: today's calls and spend, and the cap;
    - Monitoring: heartbeat on or off and the last beat time (add `lastBeatAt()` to `Heartbeat`).
- **Tests** (in-memory DB with fixture rows and a fake `App`):
  - overdue uses IST dates at the midnight edges;
  - inactive clients are excluded;
  - the segment order and counts;
  - the activity merge order;
  - every state mapping (WhatsApp `open`/`closed`/`logged_out`, publish auth failure, meetings `paused`, lost accounts);
  - no response field contains a token, key or full phone number (a scan of the JSON).

## Task 6: Read API (`src/web/routes/api.ts`)

- `GET /dashboard/api/status`, `/overview` and `/connections` require an owner and return `AgentControl` results.
- Each response gets `Cache-Control: no-store`.
- Errors give 500 `{ error: { code: 'internal', message: 'Something went wrong.' } }`; the detail is logged with the request id only.
- **Tests:**
  - 401 without a session;
  - shapes for each endpoint (a snapshot of keys, not values);
  - an internal error does not leak its message;
  - the `no-store` header.

## Task 7: Front end shell, sign-in page, Overview, Connections (status only)

**Files:** `src/web/public/index.html`, `styles.css`, `app.js`, `api.js`, `router.js`, `icons.js` (generated), `views/overview.js`, `views/connections.js`, `views/signin.js`, `views/placeholder.js`, `core3d.js`; plus `scripts/build-dashboard-icons.ts`.

- **Match the mockup** (`pages/dashboard.html`), keeping its tokens and CSS:
  - the WhatsApp dark palette, and the WhatsApp Web light theme;
  - the validated status colours;
  - Geist;
  - the hospital-monitor vitals panel (always dark);
  - the sidebar with its 11 items, collapsible, slide-out on phones;
  - the top bar with the search box, health pill, theme switch and avatar menu (Settings, Sign out).
- **Sign-in page:** the same 3D particle core (`core3d.js`, Three.js) and the copy from the mockup.
  - "Continue with Google" goes to `/dashboard/auth/login?return=<path>`.
  - The denied and error notes show when the query asks for them.
  - The "Back to website" link uses `DASHBOARD_PUBLIC_URL`'s origin (or `/` on localhost).
- **Routing:** real paths (`history.pushState`) for `/dashboard/<screen>`.
  - Screens not built yet show a calm "Coming in the next update" panel.
  - The browser back button works.
- **`api.js`:**
  - `fetch` wrappers that add `X-CSRF-Token` to non-GET calls;
  - a 401 sends the user to the sign-in page;
  - while the tab is visible, poll `/dashboard/api/status` every 10 s and `/overview` every 30 s;
  - stop polling when the tab is hidden.
- **Overview:** the KPI count-up, the monitor (ECG canvas and parts lights; the 30-day uptime strip arrives in D5, so until then it shows "Uptime history starts with the next update"), the AI spend gauge, the tasks-by-client stacked bars (with tooltips and a visually hidden table for screen readers), latest meetings, recent activity, and the tracker card.
  - The attention banner shows when any part is `down` or `warn`.
  - Empty states read "No clients approved yet. Open Clients → Manage groups." and "No meetings yet."
- **Connections:** cards with the real states. Action buttons show but are disabled, with the tooltip "Available in the next update". No fake actions.
- **Vendor files:** the server allowlist maps `/dashboard/vendor/gsap.js` to `node_modules/gsap/dist/gsap.min.js`, `/dashboard/vendor/three.js` to `node_modules/three/build/three.module.min.js`, and the Geist woff2 files from the `geist` package. Pin exact versions in `package.json`.
- **Icons:** `scripts/build-dashboard-icons.ts` writes `src/web/public/icons.js` from a fixed list of Hugeicons names (the mockup's list). A test fails if the committed file differs from a fresh run.
- **No inline scripts.** Theme choice is kept in `localStorage`, wrapped in try/catch. Reduced motion is respected.
- **Smoke test** `scripts/dashboard-smoke.ts` (playwright-core with the installed Chrome or Edge):
  - starts a test server with a fake `AgentControl` and a test session;
  - opens the sign-in page, then each built screen at 1440×900 and 390×844 in both themes;
  - fails on any page error, console error or sideways scroll (`scrollWidth > innerWidth`).
  - Add `npm run smoke:dashboard`. Not part of `npm test`, because it needs a browser.

## Task 8: Docs

- **`docs/SETUP-mac.md`, new section "Owner dashboard":**
  - create the Google **web** OAuth client and its redirect URIs (localhost first);
  - set the `DASHBOARD_*` variables;
  - restart, open `http://localhost:8787/dashboard`, and sign in;
  - after this update the Mac's update step must run `npm ci` after pulling.
- **`docs/SETUP.md`:** a short pointer to the same section.
- **`tests/docs/setup.test.ts`:** lock the new variable names and the `npm ci` note.
