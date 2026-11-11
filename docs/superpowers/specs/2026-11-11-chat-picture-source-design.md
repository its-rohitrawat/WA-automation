# A chat picture as each task's source

**Status:** approved by the owner on 11 Nov 2026 (brainstorm). Not built yet.

**Goal:** in Tracker.xlsx, a task's source is a quoted line today. The owner wants to *see* the moment in the chat it came from. Each task gets a WhatsApp-style picture of its source message with a few messages around it, the source highlighted, and a link to the same message in the dashboard's Open chat.

**Depends on:** the tag fix (`fix/mention-names`, 11 Nov), so a tag reads as a name in the picture too. It reuses that fix's resolver for who a person is.

## What the owner sees

**Tracker.xlsx, each task row:**
- **Source message** keeps the short quote, as today, with its tags as names too (the quote is stored as the raw message text, so today a tag in it still shows as raw digits). The cell becomes a link to the task's picture.
- **Chat**, a new column added at the end of the row (after Sentiment, so no existing column moves), says "Open". It links to that message in the dashboard: `<DASHBOARD_PUBLIC_URL>/dashboard/clients?client=<code>&chat=<message id>` (the Clients screen already takes its filters from the address).
  - Without `DASHBOARD_PUBLIC_URL` the column is still there, but empty.
- With no picture yet, or when it failed, the Source cell is the plain quote, exactly as today.

**The picture** (PNG, about 100 KB):
- The client's group name at the top, then up to 4 messages before the source and 2 after it, in order. If the source is a reply, the message it replies to is shown as WhatsApp shows a quoted reply.
- The source message is **highlighted**.
- **Senders by name, never by number.** A person the agent has no name for shows as "Member". A tag reads as the person's name (the tag fix's resolver).
- Media messages are a labelled bubble with their text: "Photo", "Video", "Document: <file name>", and "Voice note: <transcript>" when there is one. A message deleted before the picture is drawn shows "This message was deleted".
- Long messages wrap. A message longer than 600 characters is cut, with "…".
- It is drawn **once**, as the chat was when the task was found. A later edit changes nothing. If the source message is later deleted, the Source cell keeps today's "(deleted)" note.

**Where the pictures live:** in each client's folder on Drive, in a **Sources** subfolder next to Files and Meetings, named `<task code>.png` (for example `SHA-012.png`). A customer's pictures go on the customer's own Drive, through its own runtime.

**Which tasks get one:**
- every new task, once it has a source message;
- the tasks open at go-live, over the first tracker updates.

Closed tasks keep the plain quote.

## How it works

### Units

1. **`src/output/chatWindow.ts`: which messages.** `chatWindow(db, clientId, sourceWaId)` returns the source message, up to 4 before and 2 after it, and the message it replies to, if any. Each message carries a display sender (name, or "Member") and its text with tags turned into names. The function only reads that client's messages, with parameterised queries. It returns null when the source message is not stored.
2. **`src/output/chatPicture.ts`: drawing.** `drawChatPicture(window, { groupName })` returns a PNG buffer. It uses **sharp**, which is already a dependency:
   - each bubble's text is rendered by sharp's text renderer (Pango), which wraps lines and draws Hindi and emoji with the machine's fonts;
   - the bubbles, the highlight and the header are an SVG that sharp composites under the text.

   Every piece of text from WhatsApp is **escaped for Pango markup** (`&`, `<`, `>`) before it is drawn, so a message can never change the picture's layout or styling. The function has no I/O.
3. **`source_pictures`: a new table.** It holds `task_id`, `source_wa_id`, `drive_file_id`, `link`, `made_at` and `last_error_code`.
   - SQLite v15 and Postgres P8.
   - On Postgres it is a customer table, with row-level security like every other customer table, and it is added to the access-rules check.
   - A row whose `source_wa_id` no longer matches the task's source is stale. The task gets a new picture.
4. **`src/output/sourcePictures.ts`: the queue.**
   - It runs after each tracker update's data is ready.
   - It picks open tasks that have a source message and no current picture: newest first, **at most 20 per update**.
   - It draws each picture and uploads it to the client's Sources folder (`withClientSubfolder`, which gains `'Sources'`).
   - It records the link. A failure is recorded by its error code only, and the task is tried again at the next update.
5. **The workbook (`src/output/workbook.ts`).** The Source cell gets the picture's link when there is one (`setLink`, as the Files sheet does today), and the Chat column gets the dashboard link.
6. **The dashboard: jump to a message.**
   - The chat read gains `around=<message id>`: the page of messages around that message, in this client's chat only. An unknown id answers 404.
   - The Clients screen reads `?client=<code>&chat=<id>`: it opens that client's Open chat, loads that page, scrolls to the message and highlights it for a few seconds.
   - A person who is not signed in signs in first and then lands there.

### Data flow

```
batch finds a task (source_wa_id)
  -> tracker update: sourcePictures.run()
       -> chatWindow(db, client, wa_id) -> drawChatPicture() -> Drive Sources/<code>.png
       -> source_pictures row (link)
  -> workbook: Source cell = link to the picture, Chat cell = dashboard link
owner taps Source -> picture on Drive
owner taps Chat   -> /dashboard/clients?client=<code>&chat=<id> -> Open chat scrolled to the message, highlighted
```

### Errors and limits

- Drive is down, the token is lost, or the Sources folder is missing: the task keeps the plain quote, the row records the error code, and the next update tries again. The tracker upload is never held up by pictures.
- A drawing error (for example a font problem) is handled the same way, logged by error name only. Message text never goes in logs.
- At most 20 pictures per update, and one drawn at a time, to keep memory low on the Mac.
- No AI calls, so no cost beyond Drive storage (about 100 MB per 1,000 tasks).

### Security and privacy

- Phone numbers never appear in a picture, a log or the audit.
- Message text is escaped before drawing. The picture shows only that client's group.
- The dashboard link still needs a dashboard sign-in, and the `around` read checks that the message belongs to the session's own workspace and client, like every chat read.
- Pictures inherit the sharing of the client's Drive folder, as the tracker and Files already do.

## Testing

- **chatWindow:**
  - the window's edges: the first message in a group, and fewer than 4 before;
  - a reply's quoted message;
  - a deleted message;
  - another client's messages never included;
  - names, with "Member" for a person with no name and never a number.
- **drawChatPicture:**
  - text with `<b>`, `&` and Pango markup is drawn literally;
  - Hindi and emoji text draws without error;
  - the PNG is non-empty, with the expected width;
  - a sample picture is saved for the owner to look at before go-live.
- **The queue:**
  - 20 per update;
  - newest first;
  - a failure records its code and is retried;
  - a changed source makes a new picture;
  - closed tasks are skipped.
- **Workbook:** the Source link and the Chat link; no link when there is no picture or no public URL; the existing columns stay where they are.
- **Dashboard:**
  - `around` returns this client's page, 404 for an unknown or another client's id, and nothing for another workspace;
  - the dashboard smoke opens `?client=<code>&chat=<id>` and sees the message highlighted.
- **Postgres:** `source_pictures` under row-level security, with the access-rules check updated (the `dbAccess` and `noBypass` locks).

## Go-live (owner, on the Mac)

The table is a database change. After the merge: stop the agent, back up (GO-LIVE-postgres part 9 style), then `git pull`, `npm ci`, and `npm run cli -- db-migrate` (expect "Applied P8"). Then start the agent and check one task's Source and Chat links.

## Out of scope

- Redrawing pictures after edits.
- Pictures for closed tasks.
- Embedding pictures inside the Excel file.
- A real screenshot of the phone.
