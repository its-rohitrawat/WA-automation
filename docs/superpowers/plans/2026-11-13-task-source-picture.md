# Task panel: the source picture and the meeting's notes. Implementation plan

> **For agentic workers:** use superpowers:subagent-driven-development. Work in `C:\Users\Dell\Desktop\WA_agent-pic`, branch `feat/task-source-picture`, based on main 5c77302. Its node_modules is a junction to WA_agent-nov's: never npm install here. Files are CRLF: keep them CRLF. One test run at a time, `--maxWorkers=2`. Never push.

**Goal:** the owner's request (13 Nov 2026, after PR #23): "in tasks, you should have a source/image where that came from like you did in excel". Choices approved the same day:

1. **A chat task** shows, in the task panel's Proof, a preview of the same WhatsApp-style chat picture the tracker links to: the source message highlighted, with 4 messages before it and 2 after.
   - Tap it to see it full size.
   - The dashboard draws the picture itself (`pictureWindow` and `drawChatPicture`), so it shows even before the Drive copy exists.
   - When the Drive copy exists, there is also an **Open on Drive** link.
2. **A meeting task** shows an **Open the meeting notes** link (the meeting's Google Doc, when there is one) and a **See the meeting** button that opens that meeting on the Meetings screen.

**No database change.**

---

### Task A: the server

**Files:** `src/control/taskQueries.ts`, `src/web/routes/work.ts`, the wiring in `src/web/mountRoutes.ts` and `src/runtime/customerRuntime.ts` (only if a new dependency is needed), and tests in `tests/control/taskQueries.test.ts`, `tests/web/workApi.test.ts` and `tests/web/customerData.test.ts`.

1. `DashboardTaskDetail` gains:
   - `pictureDriveUrl: string | null`: the Drive view link of the saved picture, only when the `source_pictures` row is current (its `message_id` is the task's source message) and has a `drive_file_id`. Build the link exactly as `driveUrl` in src/output/workbook.ts does (export and reuse it, with its id check). Do not write the URL by hand.
   - `meetingId: number | null` and `meetingDocUrl: string | null`: use `meetingDocUrl()` from src/control/meetingQueries.ts on the meeting's doc file id.
2. New route `GET /dashboard/api/tasks/:code/picture` returns a PNG:
   - Answer 403 to `Sec-Fetch-Site: cross-site` first, as the export route does. Then `requireOwner`.
   - Answer 404 with a plain message when there is no task, no stored source message, the client is inactive, or `pictureWindow` returns null. Use the same code checks as `taskDetail`.
   - Otherwise call `drawChatPicture(await pictureWindow(db, client, sourceMessageId, members))`. `members` is the group-member source the chat routes already receive (`groupMembers` in src/web/routes/chat.ts deps). Pass the same source into the work routes when it is available; without it, pictureWindow still works.
   - Headers: `Content-Type: image/png`, `Cache-Control: private, max-age=300`, `X-Content-Type-Options: nosniff`.
   - Limit: at most 30 pictures a minute per owner (reuse the RateLimiter used elsewhere in src/web). Answer 429 with a plain message. Drawing already goes one at a time through chatPicture's process-wide queue.
   - When drawing fails, answer 500 with a plain message, and log only the error code or name.
   - Each workspace draws from its **own** db: same wiring as the export route.
3. **Tests:**
   - the detail fields for a task with a current picture, a stale one, none, a meeting task with a doc, and one without;
   - the route answers 200 with a PNG (the body starts with the PNG signature, 89 50 4E 47), 404 for a meeting task, a dashboard task and an inactive client, 401 when signed out, 403 for cross-site, and 429 after 30;
   - in customerData.test.ts, customer A cannot get the picture of a task code that only exists in another workspace (404);
   - Postgres runs of the changed tests with `TEST_PG_PORT=56432`.

### Task B: the screen

**Files:** `src/web/public/views/taskDrawer.js`, `src/web/public/views/meetings.js`, `src/web/public/styles.css`, and tests in `tests/web/taskProof.test.ts` and a meetings test if one exists.

1. **Chat task** (`typeof sourceMessageId === 'number'` and `clientActive !== false`): under the message bubble, a figure:
   - `<a class="src-pic" href="/dashboard/api/tasks/<code>/picture" target="_blank" rel="noopener"><img src="…same URL…" alt="The chat around the source message, with it highlighted" loading="lazy" width="…" height="…"></a>`, with the caption "Chat picture · tap to see it full size";
   - when `pictureDriveUrl` is set, a link "Open on Drive" (`target="_blank" rel="noopener"`).
   - The code must be URL-encoded and escaped.
   - The image must not stretch the drawer: max-width 100%, rounded corners like the bubbles, both themes.
   - When the image fails to load (404 or 500), hide the figure. Attach an `error` listener in JS: inline `onerror` is blocked by the CSP. No inline style either.
2. **Meeting task:**
   - "Open the meeting notes" (`meetingDocUrl`, new tab, `rel="noopener"`), only when set;
   - a "See the meeting" button that goes to `/dashboard/meetings?meeting=<meetingId>` with the dashboard's router: see how other screens navigate, and how clients.js reads `?client&chat` once.
3. **meetings.js:** read `?meeting=<digits>` once on mount. When that meeting is in the list, open it (`openMeeting`) and clean the address, as clients.js does for `?chat`. Otherwise show a toast, "That meeting isn't in this workspace."
4. **Tests:**
   - the render of the figure and the Drive link;
   - no figure for a meeting task, a dashboard task or an inactive client;
   - the meeting links, including when `meetingDocUrl` is null;
   - escaping;
   - any pure helper for `?meeting`.

### Task C: fake data, smoke, gate (after A and B)

- In `scripts/dashboardScreensFake.ts`:
  - a `source_pictures` row for the Ajay Jain task (ACM-004), with a fake Drive id that passes the id check;
  - a doc file id on the "Kickoff call" meeting.
- In `scripts/dashboard-smoke.ts`:
  - the ACM-004 panel shows the picture loaded (`img.naturalWidth > 0`) and the Open on Drive link;
  - the ACM-005 panel shows the notes link, and See the meeting opens that meeting on the Meetings screen;
  - keep a screenshot of the picture in the panel.
- **Gate:**
  - `npm run typecheck`;
  - the full suite (`npx vitest run --maxWorkers=2`);
  - `TEST_PG_PORT=56432 npm run test:pg`;
  - `npm run smoke:dashboard`.
