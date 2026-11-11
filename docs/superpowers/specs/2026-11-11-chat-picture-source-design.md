# A chat picture as each task's source

**Status:** approved by the owner on 11 Nov 2026 (brainstorm). Built 11 Nov 2026 on feat/chat-picture; where this differs from the code, the code and the plan's notes win (`docs/superpowers/plans/2026-11-11-chat-picture-source.md`).

**Goal:** in Tracker.xlsx, a task's source is a quoted line today. The owner wants to *see* the moment in the chat it came from. Each task gets a WhatsApp-style picture of its source message with a few messages around it, the source highlighted, and a link to the same message in the dashboard's Open chat.

**Depends on:** the tag fix (`fix/mention-names`, 11 Nov), so a tag reads as a name in the picture too. It reuses that fix's resolver for who a person is.

## What the owner sees

**Tracker.xlsx, each task row:**
- **Source message** keeps the short quote, as today, with its tags as names too (the quote is stored as the raw message text, so today a tag in it still shows as raw digits). The cell becomes a link to the task's picture.
- **Chat**, a new column added at the end of the row (after Sentiment, so no existing column moves), says "Open". It links to that message in the dashboard: `<DASHBOARD_PUBLIC_URL>/dashboard/clients?client=<code>&chat=<message id>` (the Clients screen already takes its filters from the address).
  - Without `DASHBOARD_PUBLIC_URL` the column is still there, but empty.
- With no picture yet, or when it failed, the Source cell is the plain quote, exactly as today.

**The picture** (PNG, about 100 KB):
- The client's name, its code and the source's date at the top (WhatsApp's group subject is not stored), then up to 4 messages before the source and 2 after it, in order. If the source is a reply, the message it replies to is shown as WhatsApp shows a quoted reply.
- After Delete chat, the messages around the source are only those Open chat still shows. The source itself is always shown; when Delete chat hid it too, it is shown alone.
- The source message is **highlighted**.
- **Senders by name, never by number.** A person the agent has no name for shows as "Member". A tag reads as the person's name (the tag fix's resolver), or "@member".
- Media messages are a labelled bubble with their text: "Photo", "Video", "Document", and "Voice note: <transcript>" when there is one. A message deleted before the picture is drawn shows "This message was deleted".
- Long messages wrap. A message longer than 600 characters is cut, with "…".
- It is drawn **once**, as the chat was when the task was found. A later edit changes nothing. If the source message is later deleted, the Source cell keeps today's "(deleted)" note.

**Where the pictures live:** in each client's folder on Drive, in a **Sources** subfolder next to Files and Meetings, named `<task code>.png` (for example `SHA-012.png`). A customer's pictures go on the customer's own Drive, through its own runtime.

**Which tasks get one:**
- every new task, once it has a source message;
- the tasks open at go-live, over the first tracker updates.

Closed tasks keep the plain quote.

## How it works

### Units

1. **`pictureWindow` in `src/control/chatQueries.ts`: which messages.** `pictureWindow(db, client, messageId, members?)` returns the source message (by its row id), up to 4 before and 2 after it, oldest first, each with the quote of the message it replies to, if any. It reuses Open chat's read. Each message carries a display sender (name, or "Member") and its text with tags turned into names. The function only reads that client's messages, with parameterised queries. It returns null when the message is not that client's.
2. **`src/output/chatPicture.ts`: drawing.** `drawChatPicture(window)` returns a PNG buffer. It uses **sharp**, which is already a dependency:
   - each bubble's text is rendered by sharp's text renderer (Pango), which wraps lines and draws Hindi and emoji with the machine's fonts;
   - the wall, the bubbles, the highlight and the header are raw pixels under the text, not an SVG: the app blocks sharp's SVG loader.

   Every piece of text from WhatsApp is **escaped for Pango markup** (`&`, `<`, `>`) before it is drawn, so a message can never change the picture's layout or styling. The function has no I/O, and the process draws one picture at a time.
3. **`source_pictures`: a new table.** One row per task: `task_id`, `client_id`, `message_id` (the source message the picture shows), `drive_file_id`, `error_code`, `attempts`, `made_at`, `tried_at` and `next_at` (the earliest next try after a failure).
   - SQLite v14 and Postgres P8.
   - On Postgres it is a customer table, with row-level security like every other customer table, and it is added to the access-rules check.
   - A row whose `message_id` is no longer the task's source message is stale. The task gets a new picture.
4. **`src/output/sourcePictures.ts`: the queue (`SourcePictures`).**
   - It runs after each tracker upload and on the agent's tick.
   - It picks open tasks that have a source message and no current picture: newest first, **at most 20 per run**.
   - It finds or makes the client's Sources folder (`withClientSubfolder`, which gains `'Sources'`), then draws each picture and uploads it there.
   - It records the Drive id. A failure is recorded by its error code only. The task is tried again after a wait that grows with each try (2, 4, 8 ... minutes, as the file uploader), at most 8 times. A Drive failure stops the run and pauses runs for 2 minutes; a drawing failure concerns that picture only.
5. **The workbook (`src/output/workbook.ts`).** The Source cell gets the picture's link when there is one (`setLink`, as the Files sheet does today), and the Chat column gets the dashboard link.
6. **The dashboard: jump to a message.**
   - No new read. Open chat pages back with the existing `before` read until the message is shown, at most 20 pages (1,000 messages). Further back, it says so.
   - The Clients screen reads `?client=<code>&chat=<id>`: it opens that client's Open chat, pages back to the message, scrolls to it and highlights it for a few seconds. A client not in the list gets a notice instead.
   - A person who is not signed in signs in first and then lands there.

### Data flow

```
batch finds a task (source_wa_id)
  -> after a tracker upload, or on the tick: SourcePictures.run()
       -> pictureWindow(db, client, message id) -> Drive Sources folder -> drawChatPicture() -> Sources/<code>.png
       -> source_pictures row (drive_file_id)
  -> the next tracker upload: Source cell = link to the picture, Chat cell = dashboard link
owner taps Source -> picture on Drive
owner taps Chat   -> /dashboard/clients?client=<code>&chat=<id> -> Open chat scrolled to the message, highlighted
```

### Errors and limits

- Drive is down, or the Sources folder cannot be made: the task keeps the plain quote, the row records the error code, the run stops there, and no run starts for 2 minutes. The task is tried again after a wait that grows with each try (2, 4, 8 ... minutes), at most 8 times. So an outage costs one try per run, and nothing is drawn while the folder cannot be made. The tracker upload is never held up by pictures.
- The Google sign-in is lost: nothing is recorded, and runs pause for 15 minutes, as the file uploader does.
- A drawing error (for example a font problem) is recorded for that picture only, and the run goes on to the next task. Errors are logged by code or name only. Message text never goes in logs.
- At most 20 pictures per run, and one drawn at a time in the whole process (every customer's runtime shares it), to keep memory low on the Mac.
- No AI calls, so no cost beyond Drive storage (about 100 MB per 1,000 tasks).

### Security and privacy

- No phone number is added by the agent: senders and tags are names only. A number someone typed in their own message is shown as written, as the tracker's quote already shows it. Logs and the audit carry no phone number.
- Message text is escaped before drawing. The picture shows only that client's group.
- The dashboard link still needs a dashboard sign-in, and Open chat's existing reads check that the client belongs to the session's own workspace, as every chat read does.
- Pictures inherit the sharing of the client's Drive folder, as the tracker and Files already do.

## Testing

- **pictureWindow:**
  - the window's edges: the first message in a group, and fewer than 4 before;
  - a reply's quoted message;
  - a deleted message;
  - another client's messages never included;
  - after Delete chat, only what Open chat shows around the source;
  - names, with "Member" for a person with no name and never a number.
- **drawChatPicture:**
  - text with `<b>`, `&` and Pango markup is drawn literally;
  - Hindi and emoji text draws without error;
  - the PNG is non-empty, with the expected width;
  - a sample picture is saved for the owner to look at before go-live.
- **The queue:**
  - 20 per run;
  - newest first;
  - a failure records its code and is retried after a growing wait, at most 8 times;
  - a Drive failure stops the run and pauses it; a drawing failure goes on to the next task;
  - a changed source makes a new picture;
  - closed tasks are skipped.
- **Workbook:** the Source link and the Chat link; no link when there is no picture or no public URL; the existing columns stay where they are.
- **Dashboard:**
  - Open chat pages back with `before` to the linked message, and says when it is too far back or gone;
  - the dashboard smoke opens `?client=<code>&chat=<id>` and sees the message highlighted, and sees the notice for a client not in the list.
- **Postgres:** `source_pictures` under row-level security, with the access-rules check updated (the `dbAccess` and `noBypass` locks).

## Go-live (owner, on the Mac)

The table is a database change. The steps are GO-LIVE-postgres Part 11: stop the agent and back up before the merge, then `git pull`, `npm ci`, and `npm run cli -- db-migrate` (expect "Applied P8"). Then start the agent, check one task's Source and Chat links, and look at a sample picture made on the Mac (`node scripts/picture-sample.ts`) to check its fonts.

## Out of scope

- Redrawing pictures after edits.
- Pictures for closed tasks.
- Embedding pictures inside the Excel file.
- A real screenshot of the phone.
