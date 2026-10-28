# Owner dashboard D3: reconnect everything from the dashboard

> **For agentic workers:** use superpowers:subagent-driven-development or superpowers:executing-plans, task by task, tests first. This phase changes how the running service holds its WhatsApp and Google connections. Read `src/main.ts`, `src/app.ts`, `src/wa/gateway.ts`, `src/wa/authState.ts`, `src/wa/senderGateway.ts`, `src/output/googleAuth.ts` and `src/meetings/multiAccount.ts` before starting.

**Goal:** from Connections, the owner can do every fix without the Mac terminal:
- relink the founder's phone (QR in the browser);
- link the spare phone;
- reconnect or add a Google account;
- upload the tracker now, test Claude, and send a test heartbeat.

The service also starts in "setup mode" instead of exiting when something isn't linked.

**Architecture:**
- The running service gets two holders that can be swapped in place without a restart:
  - `SwitchableGateway`, for the founder's WhatsApp connection;
  - `GoogleAuthHub`, for one OAuth client per Google account.
- A `LinkSession` state machine runs a relink in-process and streams QR codes to the browser over server-sent events.
- Google reconnect uses the dashboard's **web** OAuth client with PKCE.

**Depends on:** D1, D2.

**Spec:** sections 4.2 (items 3–4), 4.5, 4.6, 5, 12.

**Ground rules:** as in D1. In addition:
- A relink touches the founder's WhatsApp session. Keep a copy of the session rows before resetting, and restore it on cancel, timeout or failure. Every relink and reconnect is audited.
- QR strings are never logged or stored. The stream is owner-only and closes when the link ends.
- The spare-phone link keeps its refusal of the founder's own number.
- When `DASHBOARD_ENABLED` is false, startup behaves exactly as today (`exitEarly` on a missing link or token).
- Never read `.env`. In tests, fakes stand in for the Baileys socket factory, the Google token endpoint and the Anthropic client.

---

## Task 1: `SwitchableGateway` (`src/wa/switchableGateway.ts`)

- Implements everything `createApp` and `AgentControl` use from `WhatsAppGateway`: `onEvent`, `onStatus`, `start`, `stop`, `status()` and `listGroups()`.
- Forwards each to the current inner gateway, and re-attaches the registered handlers when the inner one changes.
- `swap(next)`: stops the current inner gateway, if any (capped at 5 s), installs `next`, and starts it.
- `clear(state)`: stops and leaves no inner gateway; `status()` then reports `{ state }`, which is one of the new states `not_linked` or `linking`. Add both to `GatewayState`.
- `main.ts` wraps the real gateway in it. Behaviour is identical when nothing is swapped.
- **Tests:**
  - forwarding;
  - handlers survive a swap;
  - events from the old gateway after a swap are ignored;
  - `listGroups` throws a typed `NotConnectedError` when there is no open inner gateway;
  - the existing app tests pass unchanged.

## Task 2: `GoogleAuthHub` (`src/output/googleAuthHub.ts`)

- **Owns one `OAuth2Client` per account label** (`main` plus the meeting accounts). Each client is built from the issuing OAuth client recorded for that token:
  - new kv `google_client:<label>`, either `desktop` or `web`;
  - a missing value means `desktop`, so today's tokens keep working.
- **Methods:**
  - `client(label)`, `labels()`;
  - `setToken(label, refreshToken, issuer)`: saves through `TokenStore` (encrypted, as today), records the issuer, and replaces that label's client;
  - `onChange(listener)`.
- **The Drive publisher, media uploader and meetings API take a getter** (`() => OAuth2Client`) instead of a fixed client, so a reconnect applies on the next call. `combineMeetingAccounts` is rebuilt on change.
- `main.ts` builds the hub from the stored tokens. When `main` has no token and the dashboard is on, Drive publishing waits in a new `not_connected` state instead of exiting.
- **Tests:**
  - desktop and web issuers;
  - a missing issuer means desktop;
  - `setToken` swaps the client, and the next Drive call uses it (a fake client records which credentials it saw);
  - a meetings rebuild on change;
  - the token is still encrypted at rest (read the raw kv value: it is not the token text).

## Task 3: Setup mode (`src/main.ts`, `src/app.ts`, `src/health/health.ts`)

- When `DASHBOARD_ENABLED` and WhatsApp was never linked:
  - start with `SwitchableGateway.clear('not_linked')`;
  - ingest, debounce and publish of new messages simply have nothing to do;
  - the health line reads `WhatsApp is not linked. Open the dashboard → Connections.`
- When `DASHBOARD_ENABLED` and Google `main` has no token: publish and meetings pause with `not_connected`, and the health line says to connect Google in the dashboard.
- `isUp()` stays false in both cases, so the uptime monitor tells the truth.
- **Tests:**
  - a start with no session and no token does not exit;
  - the health text for each case;
  - `isUp()` is false;
  - with the dashboard off, the old exits still happen (a source scan plus a unit test of the decision function).

## Task 4: Founder relink (`src/wa/linkSession.ts`)

- **States:** `idle → confirming → waiting_qr → qr → opening → linked | cancelled | timed_out | failed`. Only one link session can run at a time (a second start gives 409).
- **`start({ target: 'founder', actor })`:**
  1. Copy every row of `session.db`'s `auth` table into memory. The rows are already encrypted.
  2. `switchable.clear('linking')`.
  3. `resetSession(sessionDb)`.
  4. Build fresh encrypted auth state, then a new `WhatsAppGateway` with `onQr` (each QR goes to the session's subscribers; only the latest is kept).
  5. Start it.
- **On `open`:**
  - `switchable.swap(newGateway)` (it is already running: hand it over without a restart);
  - kv `session_reset_at`;
  - audit `WhatsApp relinked · founder's phone`;
  - the state becomes `linked` with the device name.
  - The founder's number may change only if the scan came from a different phone. Log that as a warning, with the old and new numbers masked.
- **On cancel, a 5-minute timeout, or a terminal close** (`logged_out`, `forbidden`, `replaced`) before `open`:
  - stop the new gateway;
  - restore the copied rows in one transaction (delete all, insert the copy);
  - rebuild the auth state and the gateway as at startup, and swap it in;
  - audit `WhatsApp relink cancelled` or `… timed out` / `… failed (<code>)`.
- **Tests** (fake socket factory):
  - happy path: the QR events arrive in order, `open` swaps the gateway, and the old gateway was stopped;
  - cancel restores byte-identical rows and reconnects;
  - the timeout restores;
  - `logged_out` during the link restores;
  - a second start gives 409;
  - subscribers get only the latest QR;
  - no QR appears in any log line (capture the logger).

## Task 5: Spare phone link (`src/report/senderLink.ts`)

- Reuses `linkSender({ factory, auth, onQr, timeoutMs })` in-process. It opens the sender session database when the report module isn't open (`openSenderSession(senderSessionDbPath)`), and keeps the `--reset` behaviour: rows are reset, and a damaged file is moved aside.
- It refuses a scan from the founder's number exactly as the CLI does (`readFounderNumber`, `linkedNumber`), with the CLI's advice text.
- **On success:**
  - when the report scheduler exists, it gets the new `SenderGateway` through a new `replaceSender(sender)`, so it is used on the next tick;
  - audit `Spare phone linked`;
  - the state becomes `linked`.
- It shares `LinkSession`'s state machine (`target: 'spare'`) and the one-at-a-time rule.
- **Tests:**
  - success with and without a running scheduler;
  - founder-number refusal (no rows kept, refusal message);
  - a damaged file is moved aside;
  - the timeout;
  - `replaceSender` is used on the next tick.

## Task 6: Google reconnect and add account (`src/web/routes/google.ts`)

- **`POST /dashboard/api/google/connect`** (owner and CSRF) with body `{ account: 'main' | <label> | { add: <label> } }`:
  - new labels are checked with `checkAccountLabel`;
  - creates a pending record bound to the session: `state`, PKCE verifier, account, expiry 10 minutes;
  - returns `{ url }` for Google's consent page with the web client, `access_type=offline`, `prompt=consent`, `login_hint` set to the account's stored email when known, the redirect `<origin>/dashboard/connect/google/callback`, and these scopes:
    - `main`: `requestedScopes(env)` (Drive, plus meetings when on);
    - other accounts: `MEETING_SCOPES`.
- **`GET /dashboard/connect/google/callback`** (owner; checks `state` against that session's pending record, one use):
  - exchanges the code with the verifier;
  - refuses when there is no `refresh_token` or a required scope is missing (the same rules as `runLoopbackConsent`);
  - on success: `hub.setToken(label, token, 'web')`, saves the granted scopes, `saveMeetingAccount(label)` for a new label, audits `Google account reconnected · <label> · <masked email>`, and redirects to `/dashboard/connections?connected=<label>`.
  - On refusal it redirects with `?google_error=<code>`, and the page shows a plain message.
- **Tests** (fake token endpoint):
  - happy path for `main`, an existing label and a new label;
  - missing refresh token;
  - missing scope;
  - a wrong, replayed or expired `state`;
  - another owner's session can't complete someone else's pending record;
  - no token or code appears in responses or logs.

## Task 7: Quick actions (`src/control/actions.ts`)

- **`uploadTrackerNow()`:** `app.publisher.publishNow()` (new: it schedules at once and resolves with `{ ok, at }` or `{ ok: false, reason }` within 60 s).
- **`testClaude()`:** one `client.models.list({ limit: 1 })` call through the existing Anthropic client. It spends no tokens. Times out after 15 s, and returns `{ ok, ms }` or `{ ok: false, reason }` with no key.
- **`sendTestBeat()`:** a new `heartbeat.beatNow()`, returning `{ ok, status? }`. When no heartbeat is set up, it returns `not_configured`.
- **Routes:** `POST /dashboard/api/actions/<name>` (owner and CSRF, 5 per minute each). Each is audited.
- **Tests:**
  - each action's success and failure;
  - timeouts;
  - rate limits;
  - no secrets in results.

## Task 8: Link and reconnect API, QR stream (`src/web/routes/whatsapp.ts`)

- **`POST /dashboard/api/whatsapp/link/start`** with body `{ target: 'founder'|'spare', confirm: true }` (owner and CSRF) returns `{ linkId }`.
- **`GET /dashboard/api/whatsapp/link/stream?id=`** (owner) is server-sent events. Events:
  - `qr { svg }`: the QR rendered server-side as SVG with the `qrcode` npm package, added as a pinned dependency;
  - `state { state, label }`;
  - `done { device }`;
  - `error { code, message }`.
  - A heartbeat comment every 15 s. Only the session that started the link may read it.
- **`POST /dashboard/api/whatsapp/link/cancel`** with body `{ linkId }` (owner and CSRF).
- **Tests:**
  - the event sequence for a fake session;
  - another session gets 403 on the stream;
  - cancel;
  - the SVG has no script and is a valid image;
  - the stream closes after `done`.

## Task 9: Front end: Connections actions, QR dialog, Google dialog, attention states

- **Connections cards** get the real buttons from the mockup (`Reconnect`, `Link phone`, `Upload tracker now`, `Test connection`, `Send test beat`), plus `Add Google account`.
- **WhatsApp dialog:**
  - the confirm step for a relink;
  - the phone steps;
  - the spare-phone warning;
  - the live QR from the stream, with "new code in N s";
  - the states: waiting, scanned, linking;
  - success "Linked as "WA Agent - Tracker"";
  - Cancel calls the API.
  - It works at phone width, and focus is trapped inside the dialog.
- **Google dialog:** the access list from the mockup. "Continue with Google" calls `/api/google/connect` and navigates to the URL. On return, a toast reads "Reconnected".
- **Attention states** (top pill, sidebar box, Overview banner with **Fix now**, nav badge on Connections) come from the real `status()`. **Fix now** opens the right dialog.
- **Setup mode screens:** with no founder link, Overview shows a single "Link the founder's phone" call to action.
- **Smoke test:** a fake `AgentControl` with a fake link session that emits QR, then done; the Google dialog; both themes; phone width.

## Task 10: Docs

- **`docs/SETUP.md` and `SETUP-mac.md`:** "Fixing a connection" now starts in the dashboard. The CLI commands stay documented as the fallback when the dashboard can't be reached.
- Lock the new wording in `tests/docs/setup.test.ts`.
