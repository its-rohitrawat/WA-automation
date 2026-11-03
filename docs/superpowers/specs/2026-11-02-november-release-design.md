# November release: ten dashboard changes and more WhatsApp phones

Owner request, 2 Nov 2026. Everything ships in **one merge**: `feat/release-nov` from main `d61bd9d`. Lanes build on
their own branches, and each piece lands on `feat/release-nov` as soon as it is done and reviewed. Nothing is pushed
or merged until the owner says so.

The Mac runs on **Postgres** (port 5433) since 2 Nov. Any schema change must ship as a SQLite version and a Postgres
migration together, and the go-live needs `db-migrate` on the Mac (see "Go-live").

## Owner decisions (2 Nov)

- **Delete chat** deletes the chat on the phone's WhatsApp too, and hides it in the dashboard. The agent's saved
  messages and tasks stay.
- **More phones:** every workspace (the founder and each customer) can link **up to 5** WhatsApp phones for reading
  groups.
- **Invite screens:** already built. They are switched on after the merge (`PLATFORM_ENABLED=true` plus the Google
  steps, GO-LIVE-postgres part 7). No new invite code.
- **Assistant:** a full page like ChatGPT, with **past chats listed on the left**, stored per workspace.

## The changes

### 1 and 8. The assistant as its own page (lane A)

- A new **Assistant** entry in the side menu (founder and customers). A button at the **bottom of the side menu**
  (bottom left) opens the same page. The floating button at the bottom right goes away.
- Layout like ChatGPT, in the dashboard's own theme (WhatsApp palette, Geist, Hugeicons, light and dark):
  - left column: **New chat**, then past chats grouped Today, Yesterday, Previous 7 days, Older; each can be renamed or
    deleted (delete asks first);
  - middle: the conversation, answers streaming in as today, the confirm-only change cards as today;
  - bottom: the composer (Enter sends, Shift+Enter is a new line), a Stop button while an answer streams;
  - on a phone, the chat list is a drawer.
- A new chat's title comes from its first question (trimmed), and the owner can rename it.
- **Storage:** chats and their messages are stored per workspace in the database (customer tables, with `tenant_id`
  and row-level security). This replaces "nothing of the chat is stored". Deleting a chat deletes its rows.
- **Change 8 (lag):** the assistant is a screen now, so opening anything else leaves it and stops its work in the
  browser: nothing stays open behind the next screen. An answer still streaming when the owner leaves finishes on the
  agent and is saved, so it is there when the chat is opened again.
- Schema: **SQLite v13 and Postgres P6 are reserved for lane A.** Add the new tables to `CUSTOMER_TABLES` so the
  access-rules check covers them.
- Spend and audit stay as today: answers count against the cap; confirmed changes are audited.

### 2. Open chat like WhatsApp (lane B)

- **Group info:** tapping the group's picture or name opens a panel with the group name and its **members** (name when
  the agent knows it, otherwise the number as WhatsApp shows it), from WhatsApp's group data.
- **Tagging:** typing `@` in the composer opens a member picker, as in WhatsApp; tapping a member in the group info panel
  also adds `@Name` to the message. The sent message carries real WhatsApp mentions, so the member is tagged on their
  phone. Mentions show highlighted in the chat.
- **Delete chat:** in the chat's menu. The confirm names the group and says: it deletes the chat on your phone's
  WhatsApp and hides it here; it can't be undone; the agent's saved messages and tasks stay. Then the WhatsApp delete
  runs (Baileys `chatModify` delete, which needs the last message's key and time), it is audited, and the chat is hidden
  in the dashboard. As in WhatsApp, a new message in the group brings the chat back. The group stays approved: the
  agent keeps reading it.
- The hidden state needs no schema change (use the key-value store); ask the coordinator before any schema change.
- `tests/wa/sendScan.test.ts` gets the delete as a named exception, locked like the send and history exceptions.
- Sending keeps every existing rule: the "Allow sending" switch, the confirm with the exact text, the rate limits.

### 3. Settings: remove the ban-risk note (lane D)

Remove the warning note only. The "Allow sending from the dashboard" switch, its limits and its audit entries stay.

### 4. AI usage: fix the screen (lane D)

Check it at phone, tablet and laptop widths, in light and dark, with little and much data. Fix what is broken or
misaligned: KPI row, the 14-day chart (dataviz rules: one axis, the cap as a dashed line, tooltips), today by kind.

### 5. The morning message, fully customisable (lane D)

In Automations, Morning briefing: an editor for the whole message.
- Free text with placeholders, for example `{greeting}`, `{date}`, `{open}`, `{overdue}`, `{due_today}`,
  `{tracker_link}`, `{name}` (use what the report code really has; list them beside the editor).
- A live preview with today's real numbers, **Reset to default**, and a length limit.
- Stored per workspace in the settings store (no schema change); the report composer uses it. An unknown placeholder is
  sent as written, never an error at 08:00.
- The time, days and recipient settings stay as they are.

### 6. Keywords: add one at a time (lane D)

Both **Priority keywords** (Settings) and **Meeting keywords** (Groups): an input, an **Add** button (Enter adds too),
and the keywords listed below as chips, each with a remove button. Duplicates are ignored; pasting "a, b" adds both.

### 7. More WhatsApp phones (lane C)

- Every workspace can link up to 5 phones whose groups the agent reads. **Connections** lists each phone: label, number
  (masked), status, Link, Relink, Unlink. Linking is the same QR flow as today.
- **Groups** shows which phone each group comes from. Approving a group ties it to that phone. If two phones are in the
  same group, it is read once.
- Open chat sends, and Delete chat runs, through the group's own phone.
- The status monitor and health show each phone.
- The **spare phone** (the morning briefing sender) stays separate and unchanged.
- Today's phone becomes phone 1 automatically, with no relink.
- **Unlink** logs that linked device out and stops reading it. The saved messages and tasks stay, and its groups show
  as "phone unlinked".
- WhatsApp sessions per phone: SQLite session files for the founder on SQLite; Postgres session rows for everyone on
  Postgres (customer sessions stay Postgres-only).
- Schema: **SQLite v14 and Postgres P7 are reserved for lane C**, after lane A's.
- **Lane C writes its design and plan first and sends them to the coordinator for review before any code.**

### 9. Select all: fix (lane D)

The Groups select-all control: alignment, states (none, some, all) and its count. Check on phone and laptop.

### 10. The collapsed side menu (lane D)

- When the side menu is collapsed, a visible button opens it again.
- The status monitor in the collapsed menu shows properly, as a compact monitor with a tooltip.

## Lanes and files

| Lane | Who | Folder and branch | Changes | Owns |
|---|---|---|---|---|
| A | session wa-agent-e7 | `WA_agent-saas-s1`, `feat/nov-a` | 1, 8 | `views/assistant.js`, `assistant.css`, `routes/assistant.ts`, `src/brain/assistant*`, a new store file for chats, **`app.js`, `router.js`, `index.html`** (the shell) |
| B | session wa-agent-fe | `WA_agent-saas-s1-b`, `feat/nov-b` | 2 | `views/chat.js`, `routes/chat.ts`, `src/store/outbox.ts`, the chat parts of `contract.js`, the send and delete code in `src/wa` |
| C | session wa-agent-d2 | `WA_agent-saas-invites`, `feat/nov-c` | 7 | `src/wa` (apart from lane B's send and delete code, until B lands), `src/runtime`, `views/connections.js`, `views/connect.js`, `views/linkQr.js`, the phone parts of `views/groups.js` (after D lands) |
| D | a background agent | `WA_agent-nov-d`, `feat/nov-d` | 3, 4, 5, 6, 9, 10 | `views/settings.js`, `views/priorityPanel.js`, `views/usage.js`, `views/automations.js`, `views/groups.js` (keywords and select all), `styles.css`, `src/report` and its settings |

- A file outside your list: ask the coordinator, who lends it for one round or files a hookup ticket for its owner.
  The collapse button (change 10) needs `app.js` and `index.html`: lane D gets them on loan after lane A's shell lands.
- `src/store/migrations.ts`, `src/store/pg/migrations.ts` and `src/store/pg/accessRules.ts`: lane A for v13 and P6,
  then lane C for v14 and P7, one at a time, lent by the coordinator.
- `contract.js` and `styles.css` are shared: keep your edits in your own blocks, and land small.

## How each lane works

- Write your own plan to `docs/superpowers/plans/2026-11-02-nov-<lane>.md` (lane C sends its design first), then build
  it test-first, with small commits.
- Theme: WhatsApp palette, Geist, Hugeicons, light theme = WhatsApp Web's light theme, no emojis. Check every screen in
  the browser at phone and laptop widths, light and dark.
- Every value from the agent goes into the page through `esc()` or `textContent`. Group messages and member names are
  untrusted.
- **Tests and memory:** this PC is low on memory. One typecheck or test run at a time across all lanes; ask the
  coordinator for a slot. Never raise `testTimeout`. Every gate includes `tests/wa/sendScan.test.ts`,
  `tests/store/dbAccess.test.ts` and `tests/store/pg/noBypass.test.ts`.
- **Landing:** when a piece is done, tell the coordinator. The coordinator reviews it, then rebases and fast-forwards it
  onto `feat/release-nov` in one gated command (typecheck, the piece's tests and the three locks). Stop on any rebase
  conflict.
- Never push, merge or deploy. Never read or print `.env`.

## At the end

1. Full suites, one at a time: SQLite, then Postgres (the test container `wa-test-pg`).
2. A final review: security (tenant isolation of the new tables, the delete and mention paths, XSS), data safety (the
   migrations on a copy of real data), and the UI at phone and laptop widths.
3. The coordinator updates `docs/GO-LIVE-postgres.md`: the port is the one chosen (5433 on the office Mac), and the data
   zip is made private (`chmod 600`).
4. Push and one PR, with the owner's go. The owner merges, or gives a specific go.

## Go-live (the owner, on the Mac)

The release changes the database, so the merge needs its steps in this order:
1. Stop the agent; back up: a fresh `pg_dump` (the nightly job, run now) and the data folder.
2. Merge; `git pull --ff-only`; `npm ci` (waagent window).
3. `npm run cli -- db-migrate`: `Applied P6`, `Applied P7`, then `Access rules checked: …`.
4. Start the agent and check it as after the switch (status, dashboard, a test message).
5. Then, when ready: the invite screens (Google steps, then `PLATFORM_ENABLED=true`).

Rollback: stop the agent, revert the PR, and restore the `pg_dump` taken in step 1 into a fresh database (Claude gives
those steps), or flip to SQLite (rollback A) for the short term.
