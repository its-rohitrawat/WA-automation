# Tasks screen: asked order, export, proof and the chat jump. Implementation plan

> **For agentic workers:** use superpowers:subagent-driven-development. One implementer per task, then a spec review and a quality review. One test run at a time, `--maxWorkers=2`. Files are CRLF: keep them CRLF. Never push.

**Goal:** five owner requests (13 Nov 2026) for the dashboard's Tasks screen, design approved the same day:

1. Sort by **when the task was asked**: oldest first by default, with a toolbar button for newest first.
2. An **Export** button that downloads the full **Tracker.xlsx**, built fresh: the same workbook as on Drive.
3. **Proof** in the task panel: the source message as a bubble, with the sender's name (never a number), its text, and the date and time it was sent.
4. **When it was created**: an "Asked" column in the table; "Asked" and "Found by the agent" in the panel.
5. Tapping the message opens the client's **Open chat at that message**, highlighted, with the messages before and after it. **Back** returns to the task.

**No database change.** Nothing new is stored. The work is reads, one download route and screens.

**Definitions:**
- **asked at:** the source message's `messages.ts` (same client, `wa_id = tasks.source_wa_id`). For a meeting task, the meeting's `started_at`. Otherwise (a task added on the dashboard, or a source message no longer stored), `tasks.created_at`.
- **found at:** `tasks.created_at`.

---

### Task 1: the reads (`src/control/taskQueries.ts`)

**Files:** `src/control/taskQueries.ts`, `src/web/public/views/workLib.js` (TASK_SORTS only), `tests/control/taskQueries.test.ts`, plus the Postgres run of the same tests.

- `DashboardTaskRow` gains `askedAt: string` and `createdAt: string` (ISO). Work out `askedAt` in SQL with a `COALESCE` of correlated subqueries (message `ts`, then meeting `started_at`, then `t.created_at`), parameterised, SQLite-style SQL that `src/store/engine/translate.ts` turns into Postgres. Check that the three columns hold ISO strings in the same format, so they compare and sort correctly. If one doesn't, normalise it.
- `TASK_SORTS` gains `'asked'`, on the server and in workLib.js. `orderBy('asked', d)` orders by asked at, then the existing tie. The **server default stays `'deadline'`**: the assistant's tool (`src/assistant/tools.ts`) relies on it.
- `DashboardTaskDetail` gains:
  - `sourceSender: string | null`: the source message's sender, shown as the chat shows senders. Use the same rule as `pictureWindow`: the person's name, else "Member". **Never a number** (`LOOKS_LIKE_NUMBER` guard). It is null when the message is not stored.
  - `sourceMessageId: number | null`: `messages.id` of the source message (same client), for the chat jump. It is null when the message is not stored or the task came from a meeting or the dashboard.
  - `meetingTitle: string | null`: the meeting's title, for a meeting task.
  - `sourceQuote` with **tags turned into names** (`withTagNames`, as `namedQuotes` in src/output/view.ts does), never raw digits.
- **Tests:**
  - askedAt for each case: message, meeting, dashboard, and a message no longer stored;
  - sort=asked in both directions with the tie;
  - the sender is a name, "Member", or null, and never digits;
  - sourceMessageId comes from the same client only (another client's message with the same wa_id is never used);
  - the quote has tags as names.
- Run `npx vitest run tests/control --maxWorkers=2`, then the Postgres run of these tests (`npm run test:pg -- tests/control/taskQueries.test.ts`; see scripts/test-pg.ts; Docker wa-test-pg on TEST_PG_PORT=56432).

### Task 2: the Export route

**Files:**
- `src/app.ts`: expose `trackerWorkbook(): Promise<Buffer>`. It builds exactly as the publisher's `build` does, with `health.workbookLine()`, `loadTrackerView` (with dashboardUrl when set) and `buildWorkbook`. It reads only and uploads nothing.
- `src/web/routes/work.ts`, `src/web/mountRoutes.ts`, and the owner and customer wiring (`src/main.ts` or wherever `health:` is passed, and `src/runtime/customerRuntime.ts` ~line 566). Each workspace passes its **own** app's builder.
- Tests: `tests/web/workApi.test.ts`.

**The route:** `GET /dashboard/api/tracker/export`.
- `requireOwner`, as every read.
- Rate limit: one export per 10 seconds per signed-in owner, answered with 429 `rate_limited` (reuse the RateLimit helpers already used in src/web).
- Response headers:
  - `Content-Type`: the existing `XLSX_MIME`;
  - `Content-Disposition: attachment; filename="Tracker-YYYY-MM-DD.xlsx"` (the IST date);
  - `Cache-Control: no-store`;
  - `X-Content-Type-Options: nosniff`.
- An audit line, kind `ops`, with the actor and requestId, saying the tracker was exported. No file content goes in it.
- Errors go through `controlled` as plain messages. No stack or detail reaches the browser, and logs carry error codes only.
- Without the builder dependency (a setup shell), the route answers 503 with a plain "not ready" message.
- **Tests:**
  - signed out gets 401 and no body;
  - signed in gets 200 with the headers, and the body starts with the zip signature `PK`;
  - a second export within 10 s gets 429;
  - the audit line is recorded;
  - a customer workspace exports its own workbook, never the founder's.

### Task 3: the Tasks screen (`src/web/public/views/tasks.js`)

**Files:** `src/web/public/views/tasks.js`, `src/web/public/views/workLib.js`, `src/web/public/styles.css` (only if needed), `tests/web/workLib.test.ts`, and the screen's existing tests.

- The client-side default sort becomes `asked`, `asc`. `taskQueryFromSearch` and `taskQueryToSearch` treat `asked`/`asc` as the default, so the address stays clean. `load()` **always** sends `sort` and `dir` to the API, because the server default is still deadline.
- **Toolbar:**
  - a sort button, "Oldest first" or "Newest first" (an `aria-pressed` toggle or a clear label), that sets `sort=asked` and flips `dir`;
  - an **Export** link: `<a class="btn" href="/dashboard/api/tracker/export" download>` with an icon and the label "Export Excel". It is a plain link, with no inline script or style (CSP `style-src 'self'`).
- **Table:** an **Asked** column, sortable through the existing `th()`, showing the date and time in IST (for example "11 Nov, 18:42", with the year when it isn't this year). Use the existing format helpers in src/web/public/format.js. Phone cards get its `data-label`. The empty-row colspan follows the new column count.
- Every value still goes through `esc()`.

### Task 4: the task panel (`src/web/public/views/taskDrawer.js`, `chat.js`)

- Replace "Where it came from" with **Proof**:
  - **A message task:** a bubble with the sender's name, the quote (tags as names), and the sent date and time. Then the lines "Asked: <date, time>" and "Found by the agent: <date, time>". Keep the existing "the sender deleted this message" note.
  - **A meeting task:** "From the meeting <title>, <date, time>", plus "Found by the agent".
  - **A dashboard task:** "Added by you on <date, time>".
- When `sourceMessageId` is set, the bubble is a **button** ("Open in chat", keyboard-reachable). It calls `openChat(client.code, () => openTaskDrawer(code, sameOptions), sourceMessageId, { backLabel: 'Back to the task' })`.
- `openChat` in chat.js gains an optional 4th argument, `{ backLabel?: string }`, for the back button's `aria-label`. The default stays "Back to the client". Nothing else in chat.js changes: the jump, the "too far back" toast and the highlight are already built (11 Nov).
- Every value goes through `esc()`.

### Task 5: fake data, smoke and the full gate

- `scripts/dashboardFake.ts`:
  - the new fields on its task rows and details: askedAt, createdAt, sourceSender, sourceMessageId and meetingTitle;
  - the export route answering with a small valid xlsx (build one with `buildWorkbook` from a tiny view, or the fake's own).
- `scripts/dashboard-smoke.ts`:
  - the Tasks screen shows the Asked column, oldest first;
  - the sort button flips the order;
  - the Export link answers 200 with the xlsx type;
  - a task panel shows the Proof;
  - tapping the message opens the chat with the message highlighted, and Back returns to the task.
- **Gate:**
  - `npm run typecheck`;
  - the full suite, `npx vitest run --maxWorkers=2`;
  - `npm run test:pg` for the changed tests;
  - `npm run smoke:dashboard`;
  - the platform smoke, if it covers the work routes.
