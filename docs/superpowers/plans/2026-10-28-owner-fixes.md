# Owner fixes after go-live (28 Oct 2026)

> **For agentic workers:** use superpowers:subagent-driven-development or superpowers:executing-plans, task by task, tests first. Same branch as the local-meetings work: `feat/meetings-local-stt` in `C:\Users\Dell\Desktop\WA_agent-meet-local`. Read the code each task names before changing it.

**Goal:** four things the owner noticed in the first hours on the Mac Pro:
1. "Upload tracker" made a new Excel file.
2. Clients needs a sync button.
3. The Connections cards should show each account's email.
4. A newly approved group's recent past messages should be read.

**Owner decisions (28 Oct 2026):**
- Old messages are read **automatically when a group is approved**, **up to 7 days back**.
- All four ship in one PR with the local-meetings change.

**Ground rules:**
- Keep every safety rule:
  - the founder reader never sends;
  - unapproved groups are never read or stored;
  - logs carry no message text, names, full phone numbers, file paths or tokens;
  - the spend cap applies to all AI work.
- The dashboard is owner-only, so full account emails may be shown on its screens. Audit rows keep emails masked, as today.
- Front-end rules: no inline scripts or styles, untrusted text through `esc()`, and the `tests/web/public.test.ts` rules.
- Tests first. Full `npm test` and `npm run typecheck` before each commit. Extend `npm run smoke:dashboard` for the screens touched.

---

## Task 1: Tracker: keep one file, and say which one

Read `src/output/drive.ts` (`DrivePublisher.#publish`, `googleDriveApi`), `src/web/routes/work.ts` (tracker) and `src/web/public/views/tracker.js`.

- **Today:** a new `Tracker.xlsx` is created only when Drive answers 404 for the stored file id. Usually that's because the Google login changed (another account, or another Google Cloud project), so the old file is invisible under the `drive.file` scope.
- **Before creating a new file:** list `Tracker.xlsx` files (not trashed) inside the stored `WA Agent` folder that this login can see. If one exists, use the newest and store its id. Only if none is found, create one.
- **When a new file had to be created** (the old one is gone or invisible):
  - keep its id;
  - write one agent audit row of kind `ops`: "The old tracker file could not be reached; a new Tracker.xlsx was made". No ids or emails in the detail;
  - show it once on the Tracker screen, as a plain note: "A new tracker file was started on <date>. The old one may belong to a different Google account."
- **Tracker screen and the Connections Drive card:** show which file is written: the name, the folder, the Google account it belongs to (the main account's email from Task 3, when known), the last upload time, and **Open in Drive**.
- **Tests:**
  - repeated publishes update the same id and never create a second file;
  - a 404 with a visible `Tracker.xlsx` in the folder reuses it;
  - a 404 with none creates one, writes the audit row and sets the note;
  - the folder-gone path is unchanged;
  - no file id appears in logs.

## Task 2: "Sync tracker now" in Clients

Read `src/web/public/views/clients.js`, `src/web/public/views/connect.js` (the quick action) and `src/control/actions.ts` (`upload-tracker`).

- Put a **Sync tracker now** button in the Clients screen header and in each client's drawer. It calls the existing `upload-tracker` action through the same helper Connections uses, with the same busy state, toast texts and 5-per-minute limit.
- Next to the button, show "Updated <time>" from the tracker's last successful upload. Below it, a short note: "The tracker also updates by itself after the agent reads new messages."
- **Tests:** a unit test for the shared helper (if refactored), and the smoke test pressing the button on Clients (success and 429 paths with the fake).

## Task 3: Account emails on the Connections cards

Read `src/output/googleAuth.ts`, `src/output/googleAuthHub.ts`, `src/web/routes/google.ts`, `src/control/agentControl.ts` (connections) and `src/web/public/views/connections.js`.

- **Store each Google account's email** in kv `google_account_email:<label>`, following the existing `google_*:<label>` key pattern:
  - **When an account is connected or reconnected from the dashboard:** ask for `openid email` in addition to the account's scopes. Take the verified email from the ID token, checked with the same verifier as sign-in, with `email_verified` true.
  - **For accounts connected before (CLI google-auth):** fill it lazily, once per account at startup and after a reconnect. Use Drive `about.get` with fields `user(emailAddress)` when the account has a Drive scope. If that's not possible, leave it empty.
- **Connections:** each Google card shows the **email** (or "Email not known yet: press Reconnect to show it") and what it's used for (Drive tracker, meetings). Below it, the label in small text. The Drive card names the account it writes to. Settings and Overview reuse the same text.
- `connections()` returns the email only to the owner-guarded API (already so). Audit and logs keep it masked.
- **Tests:**
  - email stored from a verified ID token;
  - a token with `email_verified` false stores nothing;
  - about.get fills an old account once;
  - failures leave it empty without breaking the connections answer;
  - the card shows the email, escaped;
  - no email in logs.

## Task 4: Read up to 7 days of past messages when a group is approved

Read `src/wa/gateway.ts` (messages.upsert, messaging-history.set, normalizeMessage, `#allowed`), `src/config/groupsWriter.ts` (`applyGroupChanges`), `src/control/groups.ts`, the ingest path and the debouncer and batches, and Baileys 7.0.0-rc14's `fetchMessageHistory(count, oldestMsgKey, oldestMsgTimestamp)` (results arrive as `messaging-history.set` with an ON_DEMAND sync type).

- **On approve:** when `applyGroupChanges` approves a group (new or re-approved), queue a **history backfill** for it, durably in kv or a small table, so a restart continues it: `{ groupId, untilTs: now, sinceTs: now - 7 days, state }`.
- **Anchor:** `fetchMessageHistory` needs a known message in that chat. Use the oldest stored message of the group when there is one. Otherwise wait for the first new message in the group, ingested as usual, and use it. Show "Waiting for the first new message to read earlier ones" until then.
- **Fetch:** page back in steps (for example 50 messages each), always from the oldest known message, until a message older than `sinceTs` arrives or WhatsApp returns nothing more. At most a fixed number of requests per group (for example 20), spaced a few seconds apart.
  - Only while the founder gateway is `open`.
  - Never for an unapproved group.
  - Stop when the group is unapproved, and on shutdown.
- **Ingest:** history messages go through the same normalize, ingest and batch path as live ones.
  - Duplicates are ignored; the existing unique message keys do this.
  - Messages older than `sinceTs` are dropped.
  - AI work goes through the normal debouncer and the spend cap. If the cap is reached, the backfill pauses and continues the next day.
  - Old messages must not trigger anything that only makes sense live, such as the "new message" timings and reminders; check the debouncer and reminders and treat backfilled messages by their real timestamps.
- **Status:**
  - the client card in Clients shows "Reading earlier messages… <n> found" and then "Earlier messages read (last 7 days)";
  - the Activity feed gets one row per group when it finishes: "<n> earlier messages read · <client>", with no message text.
- **Honest text:** WhatsApp may not return all past messages. The Clients help text and docs say "up to 7 days, as far as WhatsApp provides".
- **Tests (fake socket):**
  - approve queues a backfill;
  - the anchor comes from a stored message, or from waiting for the first one;
  - paging stops at 7 days, at an empty answer and at the request cap;
  - an unapproved group is never fetched;
  - duplicates are ignored;
  - messages older than 7 days are dropped;
  - the spend cap pauses it;
  - unapprove stops it;
  - a restart resumes it;
  - nothing is fetched while the gateway isn't open;
  - no message text in logs.

## Task 5: Docs

- **`docs/SETUP.md`, owner dashboard sections:**
  - approving a group reads up to 7 days back, as far as WhatsApp provides, within the spend cap;
  - the Sync tracker button;
  - the account emails on Connections;
  - what to do if a new tracker file appears: the Google login changed. Reconnect the account that owns the old file, or keep the new one.
- **`docs/SETUP-mac.md` section 10:** a pointer to those.
- Lock the key sentences in `tests/docs/setup.test.ts`.
