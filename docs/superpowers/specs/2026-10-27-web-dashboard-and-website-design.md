# Owner dashboard and public website: design

Status: draft for the owner's review, 27 Oct 2026. Nothing here is built yet. The look, motion and every screen were agreed through clickable mockups (copies in `C:\Users\Dell\Desktop\wa-agent-mockups`: `pages/` to open in a browser, `source/` to read). This document turns them into a buildable design that plugs into the agent already running on the office Mac Pro.

## 1. What we are building

One address, two parts:

| Address | Part | Runs on | Data |
|---|---|---|---|
| `waagent.agentsolutionbowl.si/` | **Public website**: homepage, `/demo`, `/contact`, `/privacy`, `/terms`, 404 | Cloudflare Pages (static) | Made-up demo data only |
| `waagent.agentsolutionbowl.si/dashboard` | **Owner dashboard**: sign-in and 11 screens | Inside the agent on the Mac Pro | The agent's real database, live |

The dashboard is a window into the running agent. It keeps no data of its own in the browser. Everything the owner does there (approve groups, close tasks, reconnect a phone, switch the briefing on) is saved by the agent on the Mac, so it is the same from any browser or phone. The existing setup carries over untouched: the founder's WhatsApp link, the three Google accounts, the tracker, the database and all history.

The owner's goal: never need the Mac terminal for day-to-day work. Every connection can be fixed from the dashboard.

## 2. Non-goals

- No public sign-up, no second business, no billing, no roles beyond "owner".
- No reading of any WhatsApp group the owner has not approved. The 250-group list shows names only.
- No sending to clients or groups. The only outgoing message stays the founder's morning briefing from the spare number.
- No editing of API keys or secrets in the browser. `ANTHROPIC_API_KEY`, `STT_API_KEY`, the Google client secrets and `HEARTBEAT_URL` stay in `.env` on the Mac.
- No remote shell or file access from the dashboard.
- The public website never talks to the agent.

## 3. Decisions already made (owner, 27 Oct 2026)

- **Look:** WhatsApp palette (dark #111B21 base; #075E54, #128C7E, #25D366, #34B7F1). The dashboard's light theme is **WhatsApp Web's own light theme** (#F0F2F5 panels, white cards, #111B21 / #667781 text, #E9EDEF dividers, #00A884 fills, #008069 for readable green, #027EB5 links, #D9FDD3 bubbles on #EFEAE2). Geist fonts, Hugeicons (free set, MIT). Footer line: "Not affiliated with WhatsApp or Meta"; no WhatsApp or Google logos except Google's own sign-in button.
- **Motion:** GSAP ScrollTrigger for scroll scenes, Three.js for the hero particle core, the sign-in core and the ending planet, inspired by lialive.ai without copying its branding.
- **Sign-in:** owner-only Google sign-in; owner emails listed on the Mac; sessions last up to 7 days.
- **Reconnect from the dashboard:** WhatsApp (QR shown in the browser), Google accounts (Google sign-in and back), plus "Upload tracker now", "Test Claude" and "Send test beat".
- **Morning briefing:** switched on and off in the dashboard, with a confirmation, and only once the spare phone is linked.
- **Hosting:** split by path on one domain (section 9).
- **Status colours** (checked for colour-blind separation on both themes): overdue #D94F63, open #008F7A, needs review #3D8FD9, done #2BAA4A, stacked in that order.

## 4. How the dashboard plugs into the agent

### 4.1 What the agent looks like today (from the code)

- `src/main.ts` starts everything once: environment, single-instance lock on the data folder, master key, `tracker.db`, `session.db`, Google token, WhatsApp gateway, `createApp(...)`, groups-file watcher, heartbeat.
- The `App` object (`src/app.ts:126-151`) exposes `health`, `publisher`, `meetings`, `report`, `reloadClients`. The WhatsApp `gateway` and the `SpendGuard` are not reachable from outside.
- The service **exits** if WhatsApp was never linked or there is no Google token (`main.ts:127`, `:129`).
- The running gateway has **no QR handler**. After `logged_out`, `replaced` or `forbidden` it stops for good (`gateway.ts:238-246`).
- Settings (`.env`, report settings, recipient, spend cap) and the Google meeting accounts are read **once at startup**.
- `link`, `link-sender` and `list-groups` take the data-folder lock, so they cannot run beside the service. Task and meeting corrections (`src/cli/corrections.ts`, `src/cli/meetings.ts`) already work beside it through SQLite WAL.
- There is no HTTP server and no web dependency.

### 4.2 The changes

1. **A small web server inside the agent** (`src/web/`), started by `main.ts` after `app.start()`, stopped first on shutdown. Plain `node:http` with a tiny router, no web framework. It listens on **127.0.0.1 only** (`DASHBOARD_PORT`, default 8787), so nothing on the office network can reach it directly. The outside world reaches it only through the Cloudflare tunnel (section 9).
2. **An `AgentControl` object** created in `main.ts` and handed to the web server. It owns the live pieces the dashboard needs and is the only thing the web layer talks to:
   - `status()`: the live health snapshot (`app.health.snapshot()`), connection states, spend today and cap, report state.
   - `groups`: list all WhatsApp groups from the running gateway (`listGroups()`), read and write the allow-list (4.4).
   - `tasks` and `meetings`: the existing correction functions (`closeTask`, `reopenTask`, `editTask`, `unlockTask`, `assignMeetingToClient`, `skipMeetingById`, `retryMeetingById`, `requestRebuild`), run in-process.
   - `whatsapp`: relink the founder's phone and link the spare phone (4.5).
   - `google`: reconnect an account (4.6).
   - `actions`: upload tracker now, test Claude, send test heartbeat.
   - `settings`: the runtime settings the dashboard may change (4.7).
3. **Setup mode instead of exiting.** With no WhatsApp link or no Google token, the service starts anyway with that part marked "not linked" and the dashboard shows "Link the founder's phone" / "Connect Google". Reading, publishing and meetings stay off until the missing part is linked. The CLI commands keep working when the service is stopped.
4. **Swappable gateway and Google client.** The app gets a holder for the WhatsApp gateway and for the Google clients so a relink or reconnect replaces them in place without a restart. The rest of the app keeps calling the same methods.

### 4.3 Data the dashboard reads

| Screen | Source |
|---|---|
| Overview tiles, tasks by client | `tasks`, `clients` (counts by status, overdue = deadline before today IST and not done) |
| Agent vitals | live health snapshot; uptime history from UptimeRobot's read-only API when `UPTIMEROBOT_READ_KEY` is set, otherwise from the agent's own up/down log (new, 4.8) |
| AI spend | `spend` table plus `SpendGuard` (cap, holds) |
| Tasks, task detail | `tasks`, `task_events`, source quote and date |
| Meetings | `meetings` (status, stage, summary, doc link, account) |
| Activity | `task_events`, `batches`, meeting stage changes, publish events, audit log |
| Tracker | kv Drive ids, publish health, per-client counts |
| Connections | gateway status, sender status, per-account Google state (`lostAccounts()`), publish health, heartbeat |
| Audit logs | new `audit_log` table (4.8) |

### 4.4 Groups (about 250 today)

- The list comes live from the running gateway's `listGroups()` (id and name only) while WhatsApp is open. It is cached in memory for 10 minutes and refreshed on demand. Group names are never written to disk unless the group is approved.
- The screen is built for hundreds of groups: search, filter (approved / not approved), sort by name, and a one-click **Approve**. Approving opens the small form agreed in the mockup: client name (prefilled), code (suggested, 3–4 capital letters, locked once the client has tasks), and an optional "More" fold for meeting keywords and client email domains. Drag-and-drop stays for desktop; phones use switches.
- Saving writes `config/allowed-groups.json` the safe way: validate with the existing `parseGroupsFile`, write a temporary file, keep the previous version as `allowed-groups.json.bak`, then rename. The existing watcher applies it within about 2 seconds through `app.reloadClients`. Removing a group makes the client inactive; nothing is deleted (`syncClients`). Codes stay permanent, as today.
- The screen states the truth about history: from approval on the agent reads the group's new messages; recent history WhatsApp re-sends on reconnect may be read too.

### 4.5 WhatsApp from the dashboard

**Founder's phone (relink):** the owner clicks Reconnect and confirms ("reading pauses while you scan"). The agent stops the current gateway, keeps a copy of the current session rows, resets the session, and starts a new gateway with a QR handler. Each QR is pushed to the browser over a server-sent-events stream (`/dashboard/api/whatsapp/link/stream`); WhatsApp rotates it about every 20 seconds. When the phone scans and the connection opens, the new gateway replaces the old one in the app and reading resumes. If the owner cancels or 5 minutes pass, the agent restores the saved session and reconnects as before. The audit log records who did it and when.

**Spare phone (link):** the same flow using the existing `linkSender` logic in-process, including its refusal when the scan comes from the founder's own number. On success the report scheduler gets the new sender without a restart.

The QR is shown only to a signed-in owner, never logged, and the stream closes as soon as the link opens or is cancelled.

### 4.6 Google accounts from the dashboard

- Today's tokens were issued to the **desktop** OAuth client, which only allows `127.0.0.1` redirects. A dashboard on the company domain needs a **web** OAuth client (`DASHBOARD_GOOGLE_CLIENT_ID` / `_SECRET` in `.env`), with redirects `https://waagent.agentsolutionbowl.si/dashboard/auth/callback` (owner sign-in) and `/dashboard/connect/google/callback` (account reconnect), plus the same paths on `http://localhost:8787` for use on the Mac itself.
- The agent records which client issued each refresh token (kv `google_client:<label>`). Existing desktop-issued tokens keep working unchanged; an account moves to the web client the first time it is reconnected from the dashboard. No account has to be re-linked on day one.
- Reconnect uses the same safeguards as `google-auth` today: PKCE, a random `state`, offline access with consent, refusal when the refresh token or a required scope is missing. The new token is encrypted with the existing `TokenStore`, and the account's Google client is swapped in place so meetings and Drive resume without a restart.

### 4.7 Settings the dashboard may change

Stored in a new `settings` table, applied live, each change written to the audit log. `.env` keeps the defaults; a dashboard value wins and the screen shows where each value comes from.

| Setting | Dashboard control | Today |
|---|---|---|
| Morning briefing on/off | switch with confirmation; disabled until the spare phone is linked | `REPORT_ENABLED` at startup |
| Briefing days | weekdays / Mon–Sat / every day | `REPORT_DAYS` at startup |
| Founder's number for the briefing | shown masked; change needs typing the full number twice | `REPORT_RECIPIENT` at startup |

The report scheduler reads these through a settings getter on each tick instead of keeping a startup copy. The spend cap stays in `.env` (raising a spending limit stays a deliberate step on the Mac).

### 4.8 New tables (migration v9, new migration only)

| Table | Holds |
|---|---|
| `web_sessions` | SHA-256 of the session id, owner email, created, expires (7 days), last seen, short user-agent label |
| `audit_log` | time, actor email (or `agent`), event, detail, request id. Never tokens, cookies, QR codes or message text |
| `settings` | key, value, updated at, updated by |
| `uptime_log` | up/down transitions with time, for the vitals strip when UptimeRobot's API is not set |

Existing tables and data are not touched.

## 5. Security

- **Sign-in:** Google OpenID Connect with the web client; scopes `openid email profile` only. The ID token is verified (signature, issuer, audience, expiry, nonce) with `google-auth-library`, already in the dependency tree through `@googleapis/drive`. The email must be verified and listed in `DASHBOARD_OWNER_EMAILS`. Anyone else sees "This account can't open the dashboard" and the attempt is logged.
- **Session cookie:** random 32-byte id, `HttpOnly`, `Secure` (behind HTTPS), `SameSite=Lax`, `Path=/dashboard`. Only its SHA-256 is stored. Sign out deletes the row at once. Sessions expire after 7 days and after 24 hours without use.
- **Requests that change something** need a valid session, a matching `Origin`, and a per-session CSRF token in a header. Reconnects, group changes and the briefing switch also need the dashboard's confirmation step.
- **Rate limits** on sign-in, callbacks and every action endpoint.
- **What leaves the Mac:** only what each screen needs. No tokens, keys, cookies, full phone numbers or raw errors in any response; errors go to the agent's log, and the browser gets a plain message.
- **Headers:** a strict Content-Security-Policy (self only; no inline script), `frame-ancestors 'none'`, `Referrer-Policy: same-origin`, `X-Content-Type-Options: nosniff`.
- **Network:** the server binds to 127.0.0.1; the tunnel is the only way in. Optional extra wall: Cloudflare Access with Google in front of `/dashboard` (free for small teams).
- **Untrusted content:** group names, message quotes and meeting text are always rendered as text, never as HTML.

## 6. Dashboard front end

- **Plain ES modules, CSS and HTML, no build step**, served by the agent from `src/web/public/`. This matches the agent's own "TypeScript runs directly on Node, no build" setup, so the Mac's update keeps working as today. The front-end files are type-checked by `tsc` (`checkJs`).
- GSAP, Three.js, Geist and the Hugeicons set are normal npm dependencies served from `node_modules` by the agent (no CDN, works offline on the Mac). After this change, the Mac's update step must run `npm ci` after pulling.
- Screens and behaviour exactly as in `pages/dashboard.html`: sidebar (collapsible; slide-out on phones), top bar with search, health pill and theme switch, the 11 screens, drawers for task, client and meeting detail, the QR and Google dialogs, toasts, and per-screen addresses (`/dashboard/tasks`, `/dashboard/clients/groups`, …) that survive sign-in.
- Live updates: the browser polls `/dashboard/api/status` every 10 seconds while visible. The QR uses a server-sent-events stream.
- Every screen has loading, empty, disconnected and error states. Reduced motion is respected. Status is never shown by colour alone.

## 7. Public website

- **New private repo `wa-agent-website`** (created only on the owner's approval), so website changes never update the Mac.
- Next.js with static export, TypeScript, GSAP and Three.js, Hugeicons, Geist. Pages and sections exactly as in `pages/site.html`, `demo.html`, `contact.html`, `privacy.html`, `terms.html`, `404.html`:
  - Hero zoom-through (particle core).
  - Integrations strip.
  - 3D feature carousel.
  - How it works.
  - Product preview with client tabs.
  - Integrations cards.
  - The "who it's for" wheel.
  - Security scene.
  - Time calculator with its formula.
  - FAQ with glowing answers.
  - Ending with the planet and the footer.
- **Request a demo** posts to a form service that emails the owner (its public form id lives in the site config; no secret in the browser). Hidden spam trap, clear errors, confirmation.
- **Privacy and Terms** are drafts and must be reviewed before launch.
- "Sign in" and "Owner sign in" link to `/dashboard`.

## 8. Routes

| Route | Served by |
|---|---|
| `/`, `/demo`, `/contact`, `/privacy`, `/terms`, everything else | Cloudflare Pages (404 page for unknown paths) |
| `/dashboard`, `/dashboard/<screen>` | Agent: sign-in page or the app shell |
| `/dashboard/auth/login`, `/dashboard/auth/callback`, `/dashboard/auth/logout` | Agent: owner sign-in |
| `/dashboard/connect/google/start`, `/dashboard/connect/google/callback` | Agent: account reconnect |
| `/dashboard/api/...` | Agent: JSON API (session required) |
| `/dashboard/api/whatsapp/link/stream` | Agent: QR stream (session required) |
| `/dashboard/*` when the Mac does not answer | Cloudflare: the "Agent offline" page |

## 9. Hosting

```
visitor ──► Cloudflare (waagent.agentsolutionbowl.si)
              ├─ /dashboard*  ──► Cloudflare Tunnel ──► cloudflared on the Mac ──► agent 127.0.0.1:8787
              │                    (if the Mac is off: "Agent offline" page)
              └─ everything else ─► Cloudflare Pages (website)
```

- The domain's DNS moves to Cloudflare (free plan). The hostname is served by a small Cloudflare Worker that sends `/dashboard*` to the tunnel and everything else to Pages. The tunnel's own hostname accepts only the Worker (Cloudflare Access service token), so the agent cannot be reached around it.
- `cloudflared` runs on the Mac as a launchd service, next to `com.wa-agent`. No ports are opened on the office network.
- Google Cloud: add `agentsolutionbowl.si` as an authorized domain (Google asks for proof of ownership), add the redirect URIs from 4.6, and keep the app "In production". The privacy page can move to `/privacy` on the new site.

## 10. New settings (`.env`, names only)

`DASHBOARD_ENABLED`, `DASHBOARD_PORT`, `DASHBOARD_PUBLIC_URL`, `DASHBOARD_OWNER_EMAILS`, `DASHBOARD_GOOGLE_CLIENT_ID`, `DASHBOARD_GOOGLE_CLIENT_SECRET`, optional `UPTIMEROBOT_READ_KEY`. Session and CSRF keys are derived from the existing master key (HKDF), so no new secret has to be stored. The dashboard is off unless `DASHBOARD_ENABLED=true`.

## 11. Build order (each phase: plan, build with tests and review, then the owner's "push")

| Phase | Delivers | The owner can then |
|---|---|---|
| **D1 Foundation** | web server, owner sign-in, sessions, audit log, CSRF, app shell, Overview, Connections (status only), setup mode | sign in and see the real agent's health and numbers |
| **D2 Groups and clients** | 250-group screen with search and approve, safe file writes, Clients screen | pick the client groups without the Mac |
| **D3 Reconnect** | founder relink and spare link with QR, Google reconnect, upload tracker, test Claude, test beat | fix any connection from the dashboard |
| **D4 Work screens** | Tasks (filters, detail, done/reopen/edit), Meetings (assign/skip/retry), Activity, Tracker | run the day from the dashboard |
| **D5 Control screens** | AI usage, Automations (briefing switch, days, number), Audit logs, Settings | switch the briefing on, check costs and history |
| **W1 Website** | the public site in its own repo, demo form | show the product |
| **G1 Go live** | Cloudflare DNS, Pages, Worker, tunnel, Google redirects, checklist | use `waagent.agentsolutionbowl.si` |

The dashboard comes first because it is what the owner needs for daily work. The website can be built in parallel once D1 is done.

**Before D1 goes to the Mac:** back up the Mac's `data` folder (tracker database, sessions, keys) and check that the backup opens. The push restarts the agent once; WhatsApp reconnects by itself with the saved session.

**Branch:** this work is on `feat/web-dashboard`, branched from `feat/short-morning-link` (PR #10, built and held). That branch should be merged first. Every push and merge waits for the owner's go, because each push updates the Mac.

## 12. Errors and risks

| Risk | Handling |
|---|---|
| Dashboard exposed to the internet | 127.0.0.1 bind, tunnel only, owner allowlist, optional Cloudflare Access, rate limits, CSRF, audit |
| A relink goes wrong | session copy kept; cancel or a 5-minute timeout restores it and reconnects as before |
| A bad allow-list write | validated before writing; temporary file and rename; `.bak` of the previous version; the watcher keeps the old list on a parse error |
| Mac off or offline | the website stays up; `/dashboard` shows "Agent offline"; the agent carries on when back |
| Owner locked out (Google account issue) | the CLI keeps working on the Mac; `DASHBOARD_OWNER_EMAILS` can list a second owner |
| Briefing switched on by mistake | confirmation dialog, audit log, off with one click |
| Old desktop-issued Google tokens | keep working; they move to the web client only when reconnected |

## 13. Testing

- **Unit (vitest):**
  - Sign-in: ID-token checks, nonce and state, allowlist, unverified email.
  - Sessions: expiry, idle timeout, sign-out deletes the row.
  - Protection: CSRF and Origin rules, rate limits.
  - Allow-list writer: validation, `.bak`, atomic rename, code lock.
  - Settings: precedence and live apply.
  - Relink state machine with fake sockets: success, cancel, timeout restore, wrong-number refusal for the spare phone.
  - Google reconnect: missing scope, missing refresh token, client recorded per token.
  - Every API handler's response shape: no secrets, masked numbers.
- **Integration:** the agent started with fakes for WhatsApp, Google and Claude, driven through the HTTP API.
- **Browser smoke test:** sign in (test owner), visit every screen at desktop and phone width, no script errors, no sideways scrolling, both themes. Same link crawl as the mockups for the website.
- **Security review** of the web layer before D1 is pushed.

## 14. Open items for the owner

- Confirm the domain spelling, `agentsolutionbowl.si`, before Google redirects are registered.
- Which emails go in `DASHBOARD_OWNER_EMAILS`.
- Review the draft Privacy and Terms before the website goes live.
- Approve creating the `wa-agent-website` repo when W1 starts.

## Amendment, 27 Oct 2026: everything runs on the Mac (owner decision)

This replaces section 9 where they differ.

- The website and the dashboard live in **this repo** and are both served by the agent on the office Mac: the website at `/`, the dashboard at `/dashboard`. One merge to main updates both through the Mac's normal auto-update.
- **There is no Cloudflare Pages, no routing Worker and no "Agent offline" page.** When the Mac is off, the whole site is down.
- **Claude deploys nothing.** The owner merges, and the owner does any hosting or domain set-up, for example a tunnel from the domain straight to the agent's port. The go-live guide describes these steps; it does not run them.
- The website is built as a static export (W1, in its own local folder), then copied into this repo and served by the agent's web server with its own CSP. Its inline scripts are allowed by hash, kept separate from the dashboard's strict CSP. The Mac never runs the website's build.
