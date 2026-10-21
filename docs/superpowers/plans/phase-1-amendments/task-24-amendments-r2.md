# Task 24 amendments, round 2 (controller decisions from the review of c04c34a)

Apply these on top of task-24.md and task-24-amendments.md. Keep everything else.

**Files touched:**
- src/cli.ts, src/cli/commands.ts, src/cli/status.ts
- src/config/groups.ts, src/config/paths.ts (new)
- src/main.ts (paths only)
- src/health/health.ts, src/output/drive.ts (text only), plus their tests

## 1. Testable commands (deps seam)
Give the command handlers one `deps` argument with production defaults:

```ts
export interface CliDeps {
  env: Env;
  keyProvider: KeyProvider;          // default: DpapiKeyProvider at the usual path
  socketFactory: SocketFactory;      // default: baileysSocketFactory(silentLogger())
  createConsentClient?: ...;         // passed through to runLoopbackConsent's createClient
  out: (line: string) => void;       // default: console.log
  confirm: (question: string) => Promise<boolean>;  // default: readline prompt, true only for "yes"
  linkTimeoutMs: number;             // default 300_000 (QR / connect)
  quietMs: { link: number; listGroups: number };   // defaults 60_000 / 15_000
  maxIngestMs: { link: number; listGroups: number };   // defaults 180_000 / 60_000 (see item 2)
}
```

- `src/cli.ts` builds the defaults and passes them in.
- Export the handlers (`linkCommand`, `listGroupsCommand`, `statusCommand`, `googleAuthCommand`, or whatever the names are) so tests can call them.
- Keep behaviour identical except for the items below.

## 2. link and list-groups tell the operator what is happening, with a bounded wait
- **After `open`**, print once:
  - link: `WhatsApp linked. Saving recent messages from the allowed groups (about a minute). Leave this window open.`
  - list-groups: `Connected. Reading your groups…`
- **Bounded wait:** the quiet-time wait still restarts on each allowed event, but the whole post-open phase is capped at `maxIngestMs` (3 min for link, 1 min for list-groups). Later messages reach the service anyway.
- **Final message:** at the end, if the gateway state is not `open` (e.g. logged_out or replaced during the wait), say so with the matching advice from item 6 instead of "Linked."
- **Ingest failures:** if `gateway.failedCount() > 0`, add a line: `N messages could not be saved; the service will pick them up later.`
- **QR display:** do not call `console.clear()`. Print a blank line and `Scan this QR code with WhatsApp on the founder's phone (Settings → Linked devices → Link a device):` before each QR, so earlier notes stay visible.

## 3. `link --reset` asks first
- If no session is stored (`hasSession` is false), skip the reset and print `No saved WhatsApp link to reset.`, then continue with a normal link.
- Otherwise ask, via `deps.confirm`:

  `This removes the saved WhatsApp link. The founder will have to scan a new QR code. First remove the old "WA Agent" device on his phone (Settings → Linked devices). Your tasks and tracker data are not touched. Type yes to continue:`

  - Anything other than `yes` → print `Nothing was changed.` and exit 0 without deleting.
- **Audit row:** after a confirmed reset, write kv `session_reset_at` = ISO time.

## 4. google-auth says a restart is needed
- **Success message:** `Google Drive connected. If the WA Agent service is running, restart it so it uses the new sign-in: net stop wa-agent, then net start wa-agent`
- **Health line (src/health/health.ts):** `❌ Google sign-in expired. Run: npm run cli -- google-auth, then restart the service`
- **`DriveAuthError` message (src/output/drive.ts):** `Google sign-in has expired or was revoked. Run: npm run cli -- google-auth, then restart the service`
- Update the tests that compare those texts.

## 5. CLI crash policy
- **Handlers:** in src/cli.ts, add `uncaughtException` and `unhandledRejection` handlers, as in main.ts. They print `${name}: ${message}` to stderr (never the raw error object) and exit 1. Wrap them in try/finally so the exit always happens.
- **Top-level catch:** keep the existing catch for thrown errors.

## 6. Clearer error advice
- **`forbidden` (403):** `WhatsApp refused this device (403). Check the founder's phone for a WhatsApp warning; do not reset the link.`
- **`replaced` (440):** `Another WhatsApp Web or WA Agent session took over. Find and close it (another PC or browser). Do not reset the link.`
- **Timeout:** `No connection to WhatsApp within 5 minutes. Check the internet connection, then run link again (without --reset).`
- **Missing groups file:** reuse main.ts's friendly text instead of a raw ENOENT. Export one message constant from src/config/groups.ts and use it in both places.
- **list-groups wording:** fix any output or help text that still says "nothing is saved". Allowed messages are saved, and the list itself is only shown on screen.

## 7. The example allow-list cannot become a real client
- **Reject the example id:** in `parseGroupsFile` (src/config/groups.ts), reject the example group id `120363000000000001@g.us` with `allowed-groups.json still contains the example group. Replace it with real group ids (run list-groups with an empty list first).`
  - Client codes are permanent, so syncing the example would reserve its code forever.
- **Empty list is valid:** `{ "clients": [] }` must parse, so list-groups can be run before any group is known. Check the zod schema allows an empty array; if not, allow it.
- **Tests:** the example file is rejected, and an empty list is accepted.

## 8. status labels stale data
When the stale banner is shown:
- prefix the WhatsApp and spend rows with `last known`;
- show the report age in minutes up to 120, then hours up to 48, then days (e.g. `reported 3 days ago`).

## 9. readHealthSnapshot checks the fields status reads (src/health/health.ts)
Also require:
- `whatsapp.state` (string)
- `spentToday` (number)
- `capUsd` (number)
- `failed` (array)

Return `undefined` otherwise, so status never throws on a partial snapshot.

## 10. One place for file paths
- **New module:** `src/config/paths.ts` exports `trackerDbPath(dataDir)`, `sessionDbPath(dataDir)` and `masterKeyPath(dataDir)`, matching today's literal paths exactly.
- **Callers:** use them in main.ts and src/cli/commands.ts. Task 25 will use them too.

## Tests to add (tests/cli/commands.test.ts)
Use the deps seam, a temp `DATA_DIR`, `StaticKeyProvider`, `FakeSocket` (and `SEND_METHODS`), a fake consent client and `vi.useFakeTimers` where needed.

- **(a) `--reset`:**
  - confirmed → only the session rows are deleted; tracker rows and the key file are unchanged; `session_reset_at` is set;
  - not confirmed → nothing is deleted and the output says `Nothing was changed.`;
  - an invalid allowed-groups.json → throws before anything is deleted.
- **(b) Existing session:** prints "already linked", never calls the socket factory, deletes nothing.
- **(c) link connection flow:**
  - the QR → close(515) → open sequence prints the "WhatsApp linked…" line;
  - an allowed message is stored and another group's message is dropped;
  - `sock.end` is called after the quiet time, and the wait is capped at `maxIngestMs` under a continuous stream of allowed messages;
  - close(401) and close(440) reject with the new texts, and the timeout rejects with the new text;
  - after every path, `acquireLock` succeeds again.
- **(d) list-groups:** prints only `id  subject [allowed]` lines, and no `SEND_METHODS` are called.
- **(e) google-auth:**
  - the raw kv value does not contain the token, and `load()` returns it;
  - the output never contains the token and includes the restart advice;
  - a `getToken` failure stores nothing.
- **(f) Example allow-list:** the example file is rejected; an empty list is accepted.
- **(g) Stale status:** the `last known` labels appear and the age is shown in hours/days.
- **(h) Crash policy:** test the handler function directly if you extract it; otherwise skip.

Commit message: `fix: operator-friendly link/reset, testable commands, safer allow-list`
