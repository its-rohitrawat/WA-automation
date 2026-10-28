# Owner dashboard D2: groups and clients

> **For agentic workers:** use superpowers:subagent-driven-development or superpowers:executing-plans, task by task, tests first.

**Goal:** the owner picks which of the founder's ~250 WhatsApp groups the agent works with, from the dashboard, and sees each client's numbers. No terminal and no file editing.

**Architecture:**
- `AgentControl` gains a `groups` part. It lists the live groups through the running gateway's `listGroups()` and writes `config/allowed-groups.json` safely.
- The existing file watcher (`watchGroupsFile` → `app.reloadClients`) applies each save within about 2 seconds, exactly as a hand edit does today.
- A Clients screen and a Manage groups screen are added to the front end.

**Depends on:** D1 merged into `feat/web-dashboard`.

**Spec:** sections 4.3, 4.4, 5.

**Ground rules:** as in D1 (no `.env`, fakes only in tests, tests first, suite and typecheck clean, no secrets in responses or logs, commit on `feat/web-dashboard`, never push). In addition:
- Group names from WhatsApp are untrusted text. Render them as text only, and never write them to disk for groups that aren't approved.
- `syncClients` rules stay. A client is never deleted, only made inactive. Codes are permanent.

---

## Task 1: Live group list (`src/control/groups.ts`)

- **`GroupDirectory({ gateway, clock, ttlMs = 600_000 })`:**
  - `list({ refresh?: boolean })` calls `gateway.listGroups()` when the cache is empty, older than the TTL, or `refresh` is set.
  - When the gateway isn't `open`, it returns the last cache with `stale: true` and the reason (`whatsapp_not_connected`); with no cache it returns `{ groups: [], stale: true }`.
  - Concurrent calls share one in-flight request.
- **`AgentControl.groups.overview({ q, filter: 'all'|'approved'|'not_approved', limit = 500 })`** merges the live list with the parsed allow-list and the `clients` table. Each row has:
  - `groupId`, `name` (from WhatsApp), `approved`;
  - for approved groups: `client: { name, code, active, hasTasks, codeLocked, emailDomains, meetingKeywords }`, where `codeLocked` is true when the client row exists in the DB;
  - `inWhatsApp: false` for an approved group no longer in the live list, shown as "No longer in WhatsApp".
- **Search:** case-insensitive and accent-insensitive on the group name and the client name. Sort approved first, then by name.
- **Tests:**
  - TTL and refresh behaviour;
  - a shared in-flight call;
  - not-open gives a stale cache;
  - the merge with 250 fake groups;
  - search with accents and mixed case;
  - an approved group missing from the live list;
  - a client with tasks has `codeLocked`.

## Task 2: Safe allow-list writer (`src/config/groupsWriter.ts`)

- **`applyGroupChanges(path, changes, { clock })`:**
  - `changes`: `{ approve: [{ groupId, name, code, emailDomains?, meetingKeywords? }], unapprove: [groupId], edit: [{ groupId, name?, emailDomains?, meetingKeywords? }] }`.
- **Steps:**
  1. Read the file as **raw JSON**, so the untouched clients' fields (`phases`, keywords, domains) are preserved exactly.
  2. Apply the changes in order: unapprove, edit, approve.
  3. Serialise with 2-space indentation and a trailing newline.
  4. **Validate** with the existing `parseGroupsFile(text)`. On a validation error, throw a `GroupChangeError` with a friendly message and the field (for example "Code SHA is already used by Sharma Interiors"); nothing is written.
  5. Write `allowed-groups.json.tmp`.
  6. Copy the current file to `allowed-groups.json.bak` (overwriting the previous backup).
  7. Rename the tmp file over the original.
- **Code rules, checked before writing:**
  - the code matches `/^[A-Z]{3,4}$/`;
  - it is unique across the file **and** across the `clients` table (a code once used by any client, active or not, cannot be reused for another group, matching `syncClients`);
  - an approved group's code can't change when its client row exists.
- **Concurrency:** one in-process mutex around the whole read–write; a second call waits.
- **Tests** (temp folder):
  - approve, unapprove and edit each change only their entry;
  - untouched entries are byte-identical;
  - a validation failure leaves the file and `.bak` untouched;
  - `.bak` holds the previous content;
  - a crash between the tmp write and the rename leaves the original intact (simulated by a failing rename);
  - every code rule;
  - the example group id is refused by the existing parser;
  - concurrent calls apply in order.

## Task 3: Groups and clients API (`src/web/routes/groups.ts`, `src/web/routes/clients.ts`)

- `GET /dashboard/api/groups?q=&filter=&refresh=1` returns `groups.overview(...)` plus `{ stale, reason, fetchedAt }`.
- `POST /dashboard/api/groups/apply` (owner and CSRF) with body `{ approve, unapprove, edit }`:
  - validated with zod: max 300 items, names 1–80 characters, keywords and domains as in `ClientSchema`;
  - calls `applyGroupChanges`, then audits one line per change (`Group approved · Desai Foods (DES)`, `Group removed · …`, `Client edited · …`, kind `config`);
  - returns the fresh overview;
  - a `GroupChangeError` gives 422 with its message.
- `GET /dashboard/api/clients`: active clients with their counts (open, overdue, review, done this week), phase list and current phase, group name, last activity, and sheet name.
- `GET /dashboard/api/clients/:code`: detail with open tasks (code, title, owner, deadline, status), meetings matched to the client, and last sync time. An unknown code gives 404.
- **Suggest code:** `GET /dashboard/api/groups/suggest-code?name=` returns the first free code from the name (first three letters, then initials, then the first four letters), checked against the file and the DB.
- **Tests:**
  - 401 and 403 rules;
  - zod limits;
  - the apply → audit lines;
  - 422 message text;
  - suggest-code avoids used codes;
  - client detail counts match the queries.

## Task 4: Front end: Clients and Manage groups

**Files:** `src/web/public/views/clients.js`, `views/groups.js`, `views/clientDrawer.js`.

- **Clients:**
  - cards as in the mockup (name, code, group, phase progress, Open / Overdue / Review, phase and last active);
  - a click opens the client drawer (tasks, meetings, sheet);
  - **Open sheet** links to the tracker in Drive.
- **Manage groups** (`/dashboard/clients/groups`), built for hundreds of rows:
  - a search box (debounced 150 ms), filter chips (All, Approved, Not approved) and the counts;
  - the list renders in batches of 60 as you scroll (no framework);
  - each row shows the group name, an approved badge with the client code, and an **Approve** or **Remove** button;
  - drag-and-drop between the two boards stays on desktop (as in the mockup); phones use switches.
  - **Approve** opens the drawer from the mockup:
    - client name, prefilled from the group name before " x " / " – ";
    - code from suggest-code, typed in capitals, with the "SHA-001" example; locked with an explanation when the client already exists;
    - a "More: meeting matching" fold;
    - the truthful note about history from the spec.
  - Changes collect in a **save bar** ("3 changes not saved · Undo · Save"). Save sends one `/groups/apply`; a success toast reads "Saved. The agent picks up the new groups within 2 seconds."; on a 422 the message shows inside the drawer of the failing item.
  - When the list is stale: a banner "WhatsApp isn't connected, showing the last list from <time>" with a link to Connections.
- **Smoke test:** extend `scripts/dashboard-smoke.ts` with the fake directory (250 groups): search, approve flow, save, both themes, phone width.

## Task 5: Docs

- **`docs/SETUP.md` and `docs/SETUP-mac.md`:** "Choosing client groups" now points to the dashboard. The hand-edit route stays documented as the fallback.
- Lock the wording in `tests/docs/setup.test.ts`.
