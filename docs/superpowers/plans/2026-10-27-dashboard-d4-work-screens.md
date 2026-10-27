# Owner dashboard D4: Tasks, Meetings, Activity, Tracker

> **For agentic workers:** use superpowers:subagent-driven-development or superpowers:executing-plans, task by task, tests first.

**Goal:** the owner runs the day from the dashboard. They can find and fix tasks, handle meetings that need a client, follow what the agent did, and check the tracker.

**Architecture:**
- Read queries live in `src/control/queries.ts`: plain parameterised SQL over `tasks`, `task_events`, `meetings`, `batches`, `clients` and `audit_log`.
- Changes reuse the existing correction functions in `src/cli/corrections.ts` and `src/cli/meetings.ts`, run in-process inside `tx`. They already call `requestRebuild`, so the tracker refreshes on the next tick.

**Depends on:** D1–D3.

**Spec:** sections 4.3, 5, 6.

**Ground rules:**
- As in D1.
- Message quotes and meeting text are untrusted: render them as text only.
- Every change is audited with the task code or meeting id, never with message text.
- A "retry" of a meeting costs money. It shows the cost warning the CLI shows and respects the spend cap.

---

## Task 1: Tasks queries and API (`src/web/routes/tasks.ts`)

- **`GET /dashboard/api/tasks`**:
  - **Query parameters:**
    - `q`: matches code, title, client name or owner, case-insensitive;
    - `client`: a code;
    - `status`: `overdue|open|review|done`, where `open` excludes overdue and `review` is `maybe_done`;
    - `owner`;
    - `deadline`: `past|week|none` (a week is today through today+6 IST);
    - `priority`;
    - `sort`: `deadline|code|client|owner|status`, with `dir`;
    - `limit` (max 500) and `offset`.
  - **Returns:** `{ total, rows: [{ code, title, client: { code, name }, side, owner, askedBy, deadline, status, overdue, priority, category, source: 'whatsapp'|'meeting'|'voice', updatedAt }] }`.
  - **Source kind:** from `meeting_id` (meeting) or the media kind of the source message (voice); otherwise `whatsapp`.
- **`GET /dashboard/api/tasks/:code`** adds `sourceQuote`, `sourceDate`, `latestProgress`, `remindedCount` and `history` from `task_events`: `{ at, actor: 'agent'|'owner', what }` in plain words (for example "Created from WhatsApp", "Marked done by the owner").
- **Tests:**
  - every filter, including the overdue IST edge and the week bucket;
  - sorting;
  - paging;
  - search escaping (no SQL `LIKE` wildcard injection; `%` and `_` in `q` are escaped);
  - detail history wording;
  - 404 for an unknown code.

## Task 2: Task actions (`src/control/taskActions.ts`)

- **`POST /dashboard/api/tasks/:code/<action>`** (owner and CSRF), where the action is:
  - `done`: `closeTask`;
  - `reopen`: `reopenTask`;
  - `unlock`: `unlockTask`;
  - `edit` with a body of any of `{ title, assignedTo, deadline, priority, side, category, latestProgress }`, validated like the CLI's `task edit` options (deadline `YYYY-MM-DD` and a real date; the enums; title 1–200 characters): `editTask`.
- Each runs in-process, audits `Task <code> marked done` / `reopened` / `edited (<fields>)` (kind `task`), and returns the fresh detail.
- **Tests:**
  - each action changes the row as the CLI does (compare with calling the CLI function directly on a twin DB);
  - `rebuild_requested` is set;
  - the audit line;
  - invalid edits give 422 with a field message;
  - CSRF.

## Task 3: Meetings API and actions (`src/web/routes/meetings.ts`)

- **`GET /dashboard/api/meetings?view=all|ready|progress|attention`:**
  - `ready` is `done`; `progress` is `queued` or a stage before `tracked`; `attention` is `unassigned|too_long|no_access|failed`.
  - Rows: `{ id, title, when, minutes, account (masked email), client, status, stageLabel, actionItems, docUrl? }`.
- **`GET /dashboard/api/meetings/:id`:** the summary, and the action items from tasks with this `meeting_id`.
- **Actions** (owner and CSRF):
  - `POST …/:id/assign` with body `{ client }`: `assignMeetingToClient`;
  - `…/skip`: `skipMeetingById`;
  - `…/retry`: `retryMeetingById`. Its response includes the warning "Processing a meeting costs money", and it refuses when the spend cap is reached.
  - Each is audited (kind `meeting`).
- **Tests:**
  - the view filters;
  - stage labels;
  - each action matches the CLI result;
  - a retry while paused at the cap is refused;
  - the doc link is built only from a valid Drive id.

## Task 4: Activity API (`src/web/routes/activity.ts`)

- **`GET /dashboard/api/activity?kind=all|msg|task|meet|tracker|issue&before=&limit=`** merges, newest first:
  - `batches` → "N messages read · <client> · M tasks changed";
  - `task_events` → task created, updated or marked maybe done;
  - meeting stage changes;
  - tracker publishes and publish failures (from health events kept in the new `audit_log` with actor `agent`, written by the publisher's `onFailure` / success hook);
  - `audit_log` connection and config entries.
- Items are grouped by IST day on the client.
- **Tests:**
  - merge order across sources;
  - kind filters;
  - paging with `before`;
  - publisher hooks write `agent` audit rows without detail text from messages.

## Task 5: Tracker API (`src/web/routes/tracker.ts`)

- **`GET /dashboard/api/tracker`:**
  - the workbook link (`https://drive.google.com/file/d/<id>/view` from the stored Drive id, validated);
  - the last successful publish and the last failure (with a plain reason);
  - health;
  - sheets: Today, then one per active client, with not-done (`notDone`, the workbook's "Open"), overdue, review and done-this-week counts.
- **Tests:** a missing Drive id gives `{ uploaded: false }`; the counts; the link validation.

## Task 6: Front end: Tasks, Meetings, Activity, Tracker

**Files:** `views/tasks.js`, `views/taskDrawer.js`, `views/meetings.js`, `views/activity.js`, `views/tracker.js`.

- **Match the mockup screens:**
  - **Tasks:** the toolbar with search and five filters, the sortable table, red overdue dates, status pills, the source icon, and a card list on phones.
  - **Task drawer:**
    - the WhatsApp-style quote bubble and the history timeline;
    - **Mark done** / **Reopen**;
    - **Edit owner or deadline** opens a small inline form; Save calls `edit`.
  - **Meetings:** the segmented filter and the drawer.
    - **Assign** uses a client select.
    - **Retry** asks "This costs money. Continue?".
    - **Open summary doc** opens the Drive doc in a new tab.
  - **Activity:** filter chips, and items grouped by day.
  - **Tracker:** the hero card with **Open in Drive**, the sheets table, sync health, and the note "Edits made inside the spreadsheet are replaced on the next upload."
- **Filters and the selected tab live in the URL query**, so a view can be bookmarked and survives sign-in (for example `/dashboard/tasks?status=overdue`).
- **The top search box** goes to Tasks with `q`.
- Loading skeletons, empty states, and error states with **Retry**.
- **Smoke test:** each screen with fake data, the drawer actions, phone width, both themes.
