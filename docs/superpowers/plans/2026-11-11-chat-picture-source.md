# Chat Picture as Each Task's Source: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** each open task in Tracker.xlsx gets a WhatsApp-style picture of its source message (4 messages before it, 2 after, the source highlighted), linked from the Source cell, plus a Chat column that opens the message in the dashboard.

**Architecture:**
- A new `source_pictures` table (SQLite v14, Postgres P8) records each task's picture.
- A runner (`SourcePictures`, shaped like the media `DriveFileUploader`) runs after every tracker upload and on the tick. It does four things: it picks up to 20 open tasks with no current picture; reads the messages around each source (`pictureWindow` in chatQueries, with tags as names and never numbers); draws a PNG with **sharp**, which is already a dependency (`drawChatPicture`); and uploads it to `WA Agent/Clients/<Client>/Sources/`. A new picture asks for another tracker upload.
- The workbook links the Source cell to the picture and adds a Chat column at the end of the row.
- Open chat learns to open at a given message (`?client=<code>&chat=<row id>`), paging back with the existing reads.

**Tech stack:** TypeScript (Node 22+, run with `node --experimental-strip-types` style `.ts` imports), vitest, sharp 0.35 (Pango text), exceljs, plain-JS dashboard (checkJs), Playwright smoke.

**Spec:** `docs/superpowers/specs/2026-11-11-chat-picture-source-design.md`. The code check led to these decisions, which this plan follows:

1. The window query is `pictureWindow` in `src/control/chatQueries.ts`, not a new `chatWindow.ts`. It reuses Open chat's `SELECT` and `toMessage`.
2. The dashboard has no new `around` read. Open chat pages back with the existing `before` read until the message is shown, at most 20 pages (1,000 messages). Further back, it says so.
3. The picture's header is the client's name, its code and the source's date. WhatsApp's group subject is not in the database.
4. A document bubble says "Document". Open chat's message view has no file name.
5. A failed picture is tried again at most 5 times, at least 10 minutes apart. After that, the task keeps the plain quote.
6. Sign-in returns to the Chat link: `safeReturnPath` accepts exactly `/dashboard/clients?client=<CODE>&chat=<digits>`.
7. Pictures run after each tracker upload, the way file uploads do, not inside the workbook build. The first upload is what makes the Drive root.

**Revised in review.** The code in the branch is the reference wherever it differs from this plan's code blocks for these tasks:
- **Task 3** (43cc84a): the quote's sender reads "Member", and the number guard uses `LOOKS_LIKE_NUMBER`.
- **Task 4** (e48ab08): lines are capped (12 for text, 6 for transcripts), the header is cleaned with `oneLine`, it uses `formatDuration`, and a reply to a deleted message reads "deleted message".
- **Task 6** (320045f): unsaved Drive ids are held (`#unsaved`), runs pause when the database can't write, the Drive root is checked before any drawing, and logs carry `{ taskId, code }`.

**House rules for every task:**
- Match the code around you: comments say *why*, in full sentences, and use the same density as the file.
- On this low-memory PC:
  - one test run at a time;
  - always `--maxWorkers=2`;
  - never raise `testTimeout`.
- Postgres runs use `TEST_PG_PORT=56432 npm run test:pg -- <files> --maxWorkers=2`. `docker rm -f wa-test-pg` is allowed only if that container fails to start.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never push. Pushing and merging are the owner's call.
- Working copies use CRLF. Edit with the Edit tool, or keep CRLF if you script an edit.

## File map

| File | Change | Responsibility |
|---|---|---|
| `src/store/migrations.ts` | modify | SQLite v14: `source_pictures` |
| `src/store/pg/migrations.ts` | modify | Postgres P8 + `P8_TABLES` in `CUSTOMER_TABLES` |
| `src/store/sourcePictures.ts` | create | due list, record made/failed, the tracker's links |
| `src/control/chatQueries.ts` | modify | `withTagNames`, `pictureWindow` |
| `src/output/chatPicture.ts` | create | `markup`, `drawChatPicture` (pure, no I/O) |
| `src/output/folders.ts` | modify | `'Sources'` subfolder |
| `src/output/sourcePictures.ts` | create | the runner `SourcePictures` |
| `src/output/view.ts` | modify | `sources`, `dashboardUrl`, named tags in quotes |
| `src/output/workbook.ts` | modify | Source link, Chat column |
| `src/app.ts` | modify | wire the runner, `dashboardUrl` |
| `src/runtime/customerRuntime.ts` | modify | pass `DASHBOARD_PUBLIC_URL` |
| `src/web/oidc.ts`, `src/web/public/views/signin.js` | modify | return to the Chat link after sign-in |
| `src/web/public/views/chat.js`, `views/clients.js`, `styles.css` | modify | open at a message, highlight |
| `scripts/dashboard-smoke.ts` | modify | the Chat link in a browser |
| `scripts/picture-sample.ts` | create | a sample PNG for the owner to look at |
| `docs/GO-LIVE-postgres.md` | modify | Part 11, the P8 update on the Mac |
| tests (each task names its own) | create/modify | |

---

### Task 1: The `source_pictures` table (SQLite v14, Postgres P8)

**Files:**
- Modify: `src/store/migrations.ts` (append to `MIGRATIONS`, after version 13)
- Modify: `src/store/pg/migrations.ts:33-41` (table lists), after `P7_SQL` (new `P8_SQL`), and `PG_MIGRATIONS`
- Modify: `tests/store/db.test.ts`, `tests/store/media.test.ts` (latest version 13 → 14)
- Modify: `tests/store/pg/migrations.test.ts` (a P8 test)

- [ ] **Step 1: Write the failing tests**

In `tests/store/db.test.ts`:
- change the latest-version expectations from 13 to 14: the test title "is at schema version 13 straight after openDb", both `toBe(13)` in that `describe`, and the two messages `'database is at v13 but …'` (lines 65 and 74);
- then add this block after the `migration v13` describe (around line 470):

```ts
describe.runIf(onSqlite)('migration v14 (a chat picture as each task\u2019s source, 11 Nov 2026)', () => {
  it('adds source_pictures only, one row per task', () => {
    const v14 = MIGRATIONS.find((m) => m.version === 14)!;
    expect(v14.sql).not.toMatch(/\b(DROP|DELETE|UPDATE|INSERT|RENAME|ALTER)\b/i);
    expect(v14.sql.match(/\bCREATE TABLE (\w+)/g)).toEqual(['CREATE TABLE source_pictures']);
    expect(v14.sql).toContain('task_id INTEGER NOT NULL UNIQUE REFERENCES tasks(id)');
  });
});
```

In `tests/store/media.test.ts`, lines 75 and 95: `toBe(13)` → `toBe(14)`.

In `tests/store/pg/migrations.test.ts`:
- add `P8_SQL` to the import from `../../../src/store/pg/migrations.ts`;
- in the P6 test (line 259), change `expect(CUSTOMER_TABLES.slice(-2))` to `expect(CUSTOMER_TABLES.slice(-3, -1))`, because P8's table now comes last;
- add this test after the P6 test (around line 268):

```ts
  it('P8 makes the chat pictures per customer, with forced row-level security on that table only (11 Nov 2026)', () => {
    expect(PG_MIGRATIONS.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(PG_MIGRATIONS[7]!.sql).toBe(P8_SQL);
    expect(CUSTOMER_TABLES.at(-1)).toBe('source_pictures');
    expect([...pgTables(P8_SQL).keys()]).toEqual(['source_pictures']);
    expect(P8_SQL).toContain('ALTER TABLE source_pictures ENABLE ROW LEVEL SECURITY;\nALTER TABLE source_pictures FORCE ROW LEVEL SECURITY;');
    expect(P8_SQL).toContain('UNIQUE (tenant_id, task_id)');
    expect([...P8_SQL.matchAll(/ENABLE ROW LEVEL SECURITY/g)]).toHaveLength(1);
    expect(P8_SQL).not.toMatch(/\b(DROP|GRANT|DELETE|UPDATE|INSERT)\b|ALTER TABLE (?!source_pictures)/);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/store/db.test.ts tests/store/media.test.ts tests/store/pg/migrations.test.ts --maxWorkers=2`
Expected: FAIL. The version is still 13, and `P8_SQL` is not exported.

- [ ] **Step 3: Add the migrations**

Append to `MIGRATIONS` in `src/store/migrations.ts`, after the version 13 entry:

```ts
  {
    // A chat picture for each task's source message (owner request, 11 Nov 2026): the WhatsApp-style picture in the
    // client's Drive Sources folder that the tracker's Source cell links to. One row per task. message_id is the source
    // message the picture shows, so a task whose source changed gets a new one. drive_file_id is set once Drive has the
    // picture; a failure keeps its code and is tried again (attempts, tried_at). Additive only.
    version: 14,
    sql: `
CREATE TABLE source_pictures (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL UNIQUE REFERENCES tasks(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  message_id INTEGER NOT NULL REFERENCES messages(id),
  drive_file_id TEXT CHECK (drive_file_id IS NULL OR length(drive_file_id) BETWEEN 1 AND 200),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 60),
  attempts INTEGER NOT NULL DEFAULT 0,
  made_at TEXT,
  tried_at TEXT NOT NULL
);
CREATE INDEX source_pictures_client ON source_pictures(client_id);
`,
  },
```

In `src/store/pg/migrations.ts`, below `const P6_TABLES …`:

```ts
/** The chat pictures (P8, 11 Nov 2026). */
const P8_TABLES = ['source_pictures'] as const;
```

Then change `CUSTOMER_TABLES` to:

```ts
export const CUSTOMER_TABLES = [...P1_TABLES, ...P6_TABLES, ...P8_TABLES] as const;
```

Add after `P7_SQL`:

```ts
/**
 * P8 (owner request, 11 Nov 2026): the chat pictures, per customer as SQLite's v14, with row-level security as P6 gives
 * its tables. The default privileges give wa_app their rows (and, after P5, no SELECT on the id sequence); wa_backup
 * reads them.
 */
export const P8_SQL = `
CREATE TABLE source_pictures (
  ${TENANT},
  ${ID},
  task_id bigint NOT NULL,
  client_id bigint NOT NULL,
  message_id bigint NOT NULL,
  drive_file_id text CHECK (drive_file_id IS NULL OR length(drive_file_id) BETWEEN 1 AND 200),
  error_code text CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 60),
  attempts integer NOT NULL DEFAULT 0,
  made_at text,
  tried_at text NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, task_id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks (tenant_id, id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id),
  FOREIGN KEY (tenant_id, message_id) REFERENCES messages (tenant_id, id)
);
CREATE INDEX source_pictures_client ON source_pictures (tenant_id, client_id);
${rlsSql(P8_TABLES)}`;
```

Add `{ version: 8, sql: P8_SQL },` to the end of `PG_MIGRATIONS`.

- [ ] **Step 4: Run the store tests (SQLite)**

Run: `npx vitest run tests/store tests/migrate --maxWorkers=2`
Expected: PASS. The schema-parity test ("has every SQLite table") now includes `source_pictures` on both sides. If any other test pins version 13 or `[1..7]`, change it to 14 or `[1..8]` and say so in the commit.

- [ ] **Step 5: Run them on Postgres**

Run: `TEST_PG_PORT=56432 npm run test:pg -- tests/store tests/migrate --maxWorkers=2`
Expected: `Applied P8`, `Access rules checked …`, PASS. The `dbAccess` and `noBypass` locks are under tests/store.

- [ ] **Step 6: Commit**

```bash
git add src/store/migrations.ts src/store/pg/migrations.ts tests/store/db.test.ts tests/store/media.test.ts tests/store/pg/migrations.test.ts
git commit -m "feat: source_pictures table (SQLite v14, Postgres P8)"
```

---

### Task 2: The pictures store (`src/store/sourcePictures.ts`)

**Files:**
- Create: `src/store/sourcePictures.ts`
- Test: `tests/store/sourcePictures.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { insertMessage } from '../../src/store/messages.ts';
import { picturesDue, PICTURE_TRIES, recordPictureFailed, recordPictureMade, sourceLinks } from '../../src/store/sourcePictures.ts';
import { createTask, setTaskStatus, type NewTask } from '../../src/store/tasks.ts';
import { NOW, seeded } from '../helpers/db.ts';

const task = (clientId: number, sourceWaId: string | null, o: Partial<NewTask> = {}): NewTask => ({
  clientId, side: 'us', title: 'Brighter banner', category: 'design', priority: 'major', assignedTo: null, askedBy: null,
  raisedOn: '2026-11-03', deadline: null, latestProgress: null, sourceQuote: 'banner bright karo', sourceDate: '2026-11-03',
  sourceWaId, origin: 'whatsapp', ...o,
});

async function fixture() {
  const { db, ids } = await seeded();
  for (const w of ['w1', 'w2', 'w3']) {
    await insertMessage(db, { waId: w, clientId: ids.sharma, senderJid: '919800000002@s.whatsapp.net', senderNumber: null, senderName: 'Rahul', fromMe: false, ts: NOW, text: w, quotedWaId: null, mediaType: null });
  }
  const msg = async (w: string) => (await db.get<{ id: number }>('SELECT id FROM messages WHERE client_id = ? AND wa_id = ?', [ids.sharma, w]))!.id;
  const a = await createTask(db, task(ids.sharma, 'w1'), '2026-11-03T05:00:00.000Z');
  const b = await createTask(db, task(ids.sharma, 'w2'), '2026-11-03T06:00:00.000Z');
  const done = await createTask(db, task(ids.sharma, 'w3'), '2026-11-03T07:00:00.000Z');
  await setTaskStatus(db, done.id, 'done', '2026-11-03', NOW, 'human');
  await createTask(db, task(ids.sharma, null, { origin: 'human' }), NOW); // no source message
  await createTask(db, task(ids.sharma, 'never-stored'), NOW); // its message is not stored
  return { db, ids, a, b, msg };
}

describe('the chat pictures store (11 Nov 2026)', () => {
  it('lists open tasks with a stored source and no picture, newest first, at most limit', async () => {
    const { db, a, b, msg } = await fixture();
    const now = new Date(NOW);
    expect(await picturesDue(db, now, 10)).toEqual([
      { taskId: b.id, code: b.code, clientId: b.clientId, messageId: await msg('w2') },
      { taskId: a.id, code: a.code, clientId: a.clientId, messageId: await msg('w1') },
    ]);
    expect((await picturesDue(db, now, 1)).map((d) => d.taskId)).toEqual([b.id]);
  });

  it('a made picture leaves the list and links from the tracker; a changed source brings the task back', async () => {
    const { db, a, b, msg } = await fixture();
    const [first] = await picturesDue(db, new Date(NOW), 1);
    await recordPictureMade(db, { ...first!, driveFileId: 'file-1', at: NOW });
    expect((await picturesDue(db, new Date(NOW), 10)).map((d) => d.taskId)).toEqual([a.id]);
    expect((await sourceLinks(db)).get(b.id)).toEqual({ messageId: await msg('w2'), driveFileId: 'file-1' });
    expect((await sourceLinks(db)).get(a.id)).toEqual({ messageId: await msg('w1'), driveFileId: null });
    await db.run("UPDATE tasks SET source_wa_id = 'w3' WHERE id = ?", [b.id]);
    expect((await sourceLinks(db)).get(b.id)).toEqual({ messageId: await msg('w3'), driveFileId: null }); // the old picture is stale
    expect((await picturesDue(db, new Date(NOW), 10)).map((d) => d.taskId)).toEqual([b.id, a.id]);
  });

  it('a failure waits 10 minutes before it is tried again, and stops after PICTURE_TRIES', async () => {
    const { db, a, b } = await fixture();
    const t0 = new Date(NOW).getTime();
    const due = await picturesDue(db, new Date(t0), 10);
    const bDue = due.find((d) => d.taskId === b.id)!;
    await recordPictureFailed(db, { ...bDue, errorCode: 'ECONNRESET', at: new Date(t0).toISOString() });
    expect((await picturesDue(db, new Date(t0 + 5 * 60_000), 10)).map((d) => d.taskId)).toEqual([a.id]);
    expect((await picturesDue(db, new Date(t0 + 11 * 60_000), 10)).map((d) => d.taskId)).toEqual([b.id, a.id]);
    for (let i = 1; i < PICTURE_TRIES; i++) await recordPictureFailed(db, { ...bDue, errorCode: 'ECONNRESET', at: new Date(t0).toISOString() });
    expect((await picturesDue(db, new Date(t0 + 60 * 60_000), 10)).map((d) => d.taskId)).toEqual([a.id]);
    expect(await db.get('SELECT error_code AS code, attempts FROM source_pictures WHERE task_id = ?', [b.id])).toEqual({ code: 'ECONNRESET', attempts: PICTURE_TRIES });
  });

  it('never lists another client\u2019s message for a task', async () => {
    const { db, ids } = await fixture();
    await insertMessage(db, { waId: 'm-mehta', clientId: ids.mehta, senderJid: 'x@s.whatsapp.net', senderNumber: null, senderName: null, fromMe: false, ts: NOW, text: 'x', quotedWaId: null, mediaType: null });
    await createTask(db, task(ids.sharma, 'm-mehta'), NOW); // a Sharma task naming Mehta's message id
    const due = await picturesDue(db, new Date(NOW), 10);
    expect(due.every((d) => d.clientId === ids.sharma)).toBe(true);
    expect(due).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/store/sourcePictures.test.ts --maxWorkers=2`
Expected: FAIL with "Failed to load url ../../src/store/sourcePictures.ts".

- [ ] **Step 3: Write the module**

```ts
import type { Sql } from './db.ts';

// The chat pictures (owner request, 11 Nov 2026): which open tasks still need a picture of their source message, what
// became of each try, and the links the tracker shows. One row per task (source_pictures, v14/P8). Parameterised reads
// and writes only; ON CONFLICT (task_id) gains tenant_id on Postgres (src/store/engine/translate.ts).

/** A picture that failed is tried at most this often; then the task keeps its plain quote. */
export const PICTURE_TRIES = 5;
/** A failed picture is tried again after this long, at the earliest. */
const RETRY_MS = 10 * 60_000;

/** An open task whose source message is stored and that has no current picture. */
export interface PictureDue {
  taskId: number;
  code: string;
  clientId: number;
  /** The source message's row: what the picture shows and the Chat link opens. */
  messageId: number;
}

/**
 * Up to `limit` tasks that need a picture, newest first. These are open (not done) tasks whose source message is
 * stored for the same client, with either no picture row, a picture of another message (the source changed), or a
 * failed one that is due again (fewer than PICTURE_TRIES, the last at least RETRY_MS ago).
 */
export async function picturesDue(db: Sql, now: Date, limit: number): Promise<PictureDue[]> {
  const rows = await db.all<PictureDue>(
    `SELECT t.id AS taskId, t.code, t.client_id AS clientId, m.id AS messageId
       FROM tasks t
       JOIN messages m ON m.client_id = t.client_id AND m.wa_id = t.source_wa_id
       LEFT JOIN source_pictures p ON p.task_id = t.id
      WHERE t.status <> 'done'
        AND (p.id IS NULL OR p.message_id <> m.id
          OR (p.drive_file_id IS NULL AND p.attempts < @tries AND p.tried_at <= @retry))
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT @limit`,
    { tries: PICTURE_TRIES, retry: new Date(now.getTime() - RETRY_MS).toISOString(), limit },
  );
  return rows.map((r) => ({ taskId: Number(r.taskId), code: r.code, clientId: Number(r.clientId), messageId: Number(r.messageId) }));
}

/** The picture reached Drive. A picture of another message (the source changed) is replaced by this one. */
export async function recordPictureMade(db: Sql, p: PictureDue & { driveFileId: string; at: string }): Promise<void> {
  await db.run(
    `INSERT INTO source_pictures (task_id, client_id, message_id, drive_file_id, error_code, attempts, made_at, tried_at)
     VALUES (@task, @client, @message, @file, NULL, 1, @at, @at)
     ON CONFLICT (task_id) DO UPDATE SET
       attempts = CASE WHEN source_pictures.message_id = excluded.message_id THEN source_pictures.attempts + 1 ELSE 1 END,
       message_id = excluded.message_id, drive_file_id = excluded.drive_file_id, error_code = NULL,
       made_at = excluded.made_at, tried_at = excluded.tried_at`,
    { task: p.taskId, client: p.clientId, message: p.messageId, file: p.driveFileId, at: p.at },
  );
}

/** A try failed: its error code (never a message) and one more attempt. A failure for a new source starts the count again. */
export async function recordPictureFailed(db: Sql, p: PictureDue & { errorCode: string; at: string }): Promise<void> {
  await db.run(
    `INSERT INTO source_pictures (task_id, client_id, message_id, drive_file_id, error_code, attempts, made_at, tried_at)
     VALUES (@task, @client, @message, NULL, @code, 1, NULL, @at)
     ON CONFLICT (task_id) DO UPDATE SET
       attempts = CASE WHEN source_pictures.message_id = excluded.message_id AND source_pictures.drive_file_id IS NULL
         THEN source_pictures.attempts + 1 ELSE 1 END,
       message_id = excluded.message_id, drive_file_id = NULL, error_code = excluded.error_code, made_at = NULL,
       tried_at = excluded.tried_at`,
    { task: p.taskId, client: p.clientId, message: p.messageId, code: p.errorCode.slice(0, 60), at: p.at },
  );
}

/** A task's source message, and its picture's Drive id when the picture shows that message (null: none, or stale). */
export interface SourceLink {
  messageId: number;
  driveFileId: string | null;
}

/** Every task's source link, by task id: the tracker's Source and Chat links. Tasks whose source is not stored have none. */
export async function sourceLinks(db: Sql): Promise<Map<number, SourceLink>> {
  const rows = await db.all<{ taskId: number; messageId: number; driveFileId: string | null; pictureOf: number | null }>(
    `SELECT t.id AS taskId, m.id AS messageId, p.drive_file_id AS driveFileId, p.message_id AS pictureOf
       FROM tasks t
       JOIN messages m ON m.client_id = t.client_id AND m.wa_id = t.source_wa_id
       LEFT JOIN source_pictures p ON p.task_id = t.id`,
  );
  return new Map(rows.map((r) => [Number(r.taskId), {
    messageId: Number(r.messageId),
    driveFileId: r.pictureOf !== null && Number(r.pictureOf) === Number(r.messageId) ? r.driveFileId : null,
  }]));
}
```

- [ ] **Step 4: Run it to see it pass (both engines)**

Run: `npx vitest run tests/store/sourcePictures.test.ts --maxWorkers=2`, then `TEST_PG_PORT=56432 npm run test:pg -- tests/store/sourcePictures.test.ts --maxWorkers=2`
Expected: PASS on both. On Postgres, `ON CONFLICT (task_id)` becomes `(tenant_id, task_id)`, which matches P8's `UNIQUE (tenant_id, task_id)`.

- [ ] **Step 5: Commit**

```bash
git add src/store/sourcePictures.ts tests/store/sourcePictures.test.ts
git commit -m "feat: the chat pictures store: due tasks, made, failed, tracker links"
```

---

### Task 3: The picture's messages (`pictureWindow`, `withTagNames`)

**Files:**
- Modify: `src/control/chatQueries.ts`. Add to the `groupMembers.ts` import: `replaceTags`. Add new exports after `tagNames` (around line 270).
- Test: `tests/control/pictureWindow.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { pictureWindow, withTagNames } from '../../src/control/chatQueries.ts';
import { getClientByCode } from '../../src/store/clients.ts';
import { applyRevoke, insertMessage, type NewMessage } from '../../src/store/messages.ts';
import { upsertPerson } from '../../src/store/people.ts';
import { seeded, SHARMA } from '../helpers/db.ts';

const RAHUL = '919800000002@s.whatsapp.net';
const at = (min: number) => new Date(Date.UTC(2026, 10, 3, 5, min)).toISOString();

async function chat() {
  const { db, ids } = await seeded();
  const c = (await getClientByCode(db, SHARMA.code))!;
  await upsertPerson(db, { clientId: ids.sharma, jid: RAHUL, number: '919800000002', name: 'Rahul', fromMe: false });
  const put = (o: Partial<NewMessage> & { waId: string; ts: string }) => insertMessage(db, {
    clientId: ids.sharma, senderJid: RAHUL, senderNumber: '919800000002', senderName: 'Rahul', fromMe: false, text: null, quotedWaId: null, mediaType: null, ...o,
  });
  for (let i = 1; i <= 9; i++) await put({ waId: `w${i}`, ts: at(i), text: `message ${i}` });
  await insertMessage(db, { waId: 'other', clientId: ids.mehta, senderJid: RAHUL, senderNumber: null, senderName: null, fromMe: false, ts: at(5), text: 'Mehta only', quotedWaId: null, mediaType: null });
  const id = async (waId: string, client = ids.sharma) => (await db.get<{ id: number }>('SELECT id FROM messages WHERE client_id = ? AND wa_id = ?', [client, waId]))!.id;
  return { db, c, ids, put, id };
}

describe('pictureWindow (a chat picture as each task\u2019s source, 11 Nov 2026)', () => {
  it('shows the source, the 4 before it and the 2 after it, oldest first, with only the source marked', async () => {
    const { db, c, id } = await chat();
    const w = (await pictureWindow(db, c, await id('w5')))!;
    expect(w.client).toEqual({ code: 'SHA', name: 'Sharma Interiors' });
    expect(w.messages.map((m) => m.text)).toEqual(['message 1', 'message 2', 'message 3', 'message 4', 'message 5', 'message 6', 'message 7']);
    expect(w.messages.map((m) => m.source)).toEqual([false, false, false, false, true, false, false]);
    expect(w.messages.every((m) => m.sender === 'Rahul')).toBe(true);
  });

  it('at the start of the chat shows what there is', async () => {
    const { db, c, id } = await chat();
    expect((await pictureWindow(db, c, await id('w1')))!.messages.map((m) => m.text)).toEqual(['message 1', 'message 2', 'message 3']);
  });

  it('is null for another client\u2019s message, which it never shows', async () => {
    const { db, c, ids, id } = await chat();
    expect(await pictureWindow(db, c, await id('other', ids.mehta))).toBeNull();
    const w = (await pictureWindow(db, c, await id('w9')))!;
    expect(w.messages.map((m) => m.text)).not.toContain('Mehta only');
  });

  it('names people only: someone with no name is Member, never a number', async () => {
    const { db, c, put, id } = await chat();
    await put({ waId: 'u1', ts: at(30), senderJid: '919800000099@s.whatsapp.net', senderNumber: '919800000099', senderName: '+91 98000 00099', text: 'who am I' });
    const w = (await pictureWindow(db, c, await id('u1')))!;
    expect(w.messages.at(-1)!.sender).toBe('Member');
    expect(JSON.stringify(w)).not.toMatch(/9800000099|98000 00099/);
  });

  it('shows a tag as the person\u2019s name, or @member, never the digits; in a reply\u2019s quote too', async () => {
    const { db, c, ids, put, id } = await chat();
    await upsertPerson(db, { clientId: ids.sharma, jid: '201111111111111@lid', number: null, name: 'Priya', fromMe: false });
    await put({ waId: 't1', ts: at(40), text: '@201111111111111 please check, @209999999999999 too' });
    await put({ waId: 't2', ts: at(41), text: 'on it', quotedWaId: 't1' });
    const w = (await pictureWindow(db, c, await id('t2')))!;
    expect(w.messages.at(-2)!.text).toBe('@Priya please check, @member too');
    expect(w.messages.at(-1)!.quote?.text).toBe('@Priya please check, @member too');
    expect(JSON.stringify(w)).not.toContain('201111111111111');
  });

  it('a deleted message is shown as deleted, with no text', async () => {
    const { db, c, ids, id } = await chat();
    await applyRevoke(db, ids.sharma, 'w5');
    const w = (await pictureWindow(db, c, await id('w5')))!;
    expect(w.messages[4]).toMatchObject({ deleted: true, text: '', source: true });
  });
});

describe('withTagNames', () => {
  it('names each tag, or @member; never a number, even one WhatsApp gives', async () => {
    const { db, c } = await chat();
    expect(await withTagNames(db, c, ['hi @919800000002', '@919800000055 hello', 'no tags'])).toEqual(['hi @Rahul', '@member hello', 'no tags']);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/control/pictureWindow.test.ts --maxWorkers=2`
Expected: FAIL with "pictureWindow is not a function" (or a failed import).

- [ ] **Step 3: Write the code**

In `src/control/chatQueries.ts`:
- extend the import: `import { memberTagged, mentionTags, peopleOfMember, peopleTagged, replaceTags, tagOf, type GroupMember } from '../wa/groupMembers.ts';`
- add after `tagNames`:

```ts
/**
 * The texts with every tag ("@<digits>") as the person's name, or "@member" when the agent has none: never a number,
 * not even the one WhatsApp gives for a group member. A chat picture and the tracker go beyond the dashboard (owner
 * decision, 11 Nov 2026). The members are asked for only when this client's people leave a tag unnamed, as tagNames does.
 */
export async function withTagNames(db: Db, c: ClientRow, texts: readonly string[], members?: () => Promise<readonly GroupMember[] | null>): Promise<string[]> {
  const names = await tagNames(db, c, texts, members);
  return texts.map((t) => replaceTags(t, (tag) => {
    const n = names[tag];
    return `@${n !== undefined && !n.startsWith('+') ? n : 'member'}`; // tagNames gives a number as shownNumber, "+…"
  }));
}

/** How many messages a chat picture shows before and after its source (owner decision, 11 Nov 2026). */
export const PICTURE_BEFORE = 4;
export const PICTURE_AFTER = 2;

/** A message in a chat picture: as Open chat shows it, and whether it is the task's source (the highlighted one). */
export type PictureMessage = ChatMessage & { source: boolean };

export interface PictureWindow {
  client: { code: string; name: string };
  /** Oldest first. */
  messages: PictureMessage[];
}

/**
 * The messages a task's chat picture shows (owner request, 11 Nov 2026): this client's message `messageId`, the
 * PICTURE_BEFORE before it and the PICTURE_AFTER after it (by time, then row), oldest first, as Open chat shows them.
 * Senders and tags are by name only: someone with no name is "Member", a tag with no name "@member", never a number. A
 * reply's quote comes with its message. Null when the message is not this client's. Parameterised reads only.
 */
export async function pictureWindow(db: Db, c: ClientRow, messageId: number, members?: () => Promise<readonly GroupMember[] | null>): Promise<PictureWindow | null> {
  const src = await db.get<RawMessage>(`${SELECT} WHERE m.client_id = ? AND m.id = ?`, [c.id, messageId]);
  if (!src) return null;
  const before = await db.all<RawMessage>(
    `${SELECT} WHERE m.client_id = @client AND (m.ts < @ts OR (m.ts = @ts AND m.id < @id)) ORDER BY m.ts DESC, m.id DESC LIMIT @limit`,
    { client: c.id, ts: src.at, id: src.id, limit: PICTURE_BEFORE },
  );
  const after = await db.all<RawMessage>(
    `${SELECT} WHERE m.client_id = @client AND (m.ts > @ts OR (m.ts = @ts AND m.id > @id)) ORDER BY m.ts, m.id LIMIT @limit`,
    { client: c.id, ts: src.at, id: src.id, limit: PICTURE_AFTER },
  );
  const shown = [...before.reverse(), src, ...after].map((r) => {
    const m = toMessage(r);
    // senderLabel's "Someone" (no name, or a name that is really a number) reads as a member of the group here.
    return { ...m, sender: !m.mine && m.sender === 'Someone' ? 'Member' : m.sender, source: r.id === src.id };
  });
  const named = await withTagNames(db, c, shown.flatMap((m) => [m.text, m.quote?.text ?? '']), members);
  return {
    client: { code: c.code, name: c.name },
    messages: shown.map((m, i) => ({ ...m, text: named[2 * i]!, quote: m.quote ? { ...m.quote, text: named[2 * i + 1]! } : null })),
  };
}
```

- [ ] **Step 4: Run it to see it pass (both engines)**

Run: `npx vitest run tests/control/pictureWindow.test.ts tests/control --maxWorkers=2`, then `TEST_PG_PORT=56432 npm run test:pg -- tests/control/pictureWindow.test.ts --maxWorkers=2`
Expected: PASS.

If the `quote` test fails because Open chat's quote text is `oneLine(…)` of the stored text, check that the replaced text still matches. `oneLine` keeps the words and only joins the lines.

- [ ] **Step 5: Commit**

```bash
git add src/control/chatQueries.ts tests/control/pictureWindow.test.ts
git commit -m "feat: pictureWindow and withTagNames: a task source's messages, names only"
```

---

### Task 4: Drawing the picture (`src/output/chatPicture.ts`)

**Files:**
- Create: `src/output/chatPicture.ts`
- Test: `tests/output/chatPicture.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { PictureMessage, PictureWindow } from '../../src/control/chatQueries.ts';
import { drawChatPicture, markup, PICTURE_WIDTH } from '../../src/output/chatPicture.ts';

const msg = (o: Partial<PictureMessage> = {}): PictureMessage => ({
  id: 1, at: '2026-11-03T05:12:00.000Z', mine: false, sender: 'Rahul', text: 'Banner thoda bright karo', kind: 'text', seconds: null,
  transcript: null, quote: null, edited: false, deleted: false, source: false, ...o,
});
const win = (messages: PictureMessage[]): PictureWindow => ({ client: { code: 'SHA', name: 'Sharma Interiors' }, messages });
const size = async (png: Buffer) => {
  const m = await sharp(png).metadata();
  return { format: m.format, width: m.width, height: m.height ?? 0 };
};

describe('drawChatPicture (11 Nov 2026)', () => {
  it('escapes Pango markup, so text is always drawn as text', () => {
    expect(markup('<b>Tom & "Jerry"</b>')).toBe('&lt;b&gt;Tom &amp; "Jerry"&lt;/b&gt;');
  });

  it('draws a PNG of the picture width, taller with more messages', async () => {
    const one = await size(await drawChatPicture(win([msg({ source: true })])));
    const four = await size(await drawChatPicture(win([msg(), msg({ mine: true, sender: 'Founder', text: 'ok, today' }), msg({ source: true }), msg()])));
    expect(one).toMatchObject({ format: 'png', width: PICTURE_WIDTH });
    expect(four.height).toBeGreaterThan(one.height);
  });

  it('draws markup-looking, Hindi and emoji text, replies, media and deleted messages without error', async () => {
    const png = await drawChatPicture(win([
      msg({ text: '<span foreground="red">x</span> & <b>bold?</b>' }),
      msg({ text: 'बैनर थोड़ा ब्राइट करो 👍', quote: { sender: 'Priya', text: 'logo final?', kind: 'text' } }),
      msg({ kind: 'voice', seconds: 42, text: '', transcript: 'The blue one works' }),
      msg({ kind: 'image', text: 'see this' }),
      msg({ deleted: true, text: '' }),
      msg({ source: true, edited: true }),
    ]));
    expect((await size(png)).width).toBe(PICTURE_WIDTH);
  });

  it('cuts a very long message, so a picture stays a picture', async () => {
    const { height } = await size(await drawChatPicture(win([msg({ source: true, text: 'word '.repeat(2000) })])));
    expect(height).toBeLessThan(2600);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/output/chatPicture.test.ts --maxWorkers=2`
Expected: FAIL with a failed import of `chatPicture.ts`.

- [ ] **Step 3: Write the module**

```ts
import sharp from 'sharp';
import type { PictureMessage, PictureWindow } from '../control/chatQueries.ts';
import { istShortDate, istTime } from '../util/time.ts';

// A task's chat picture (owner request, 11 Nov 2026): a WhatsApp-style picture of its source message and the few around
// it, drawn with sharp, which the agent already has. Each bubble's words come from sharp's text renderer (Pango: it
// wraps lines and draws Hindi and emoji with the machine's fonts); the wall, the header and the bubbles are an SVG
// underneath, holding no words. Every word from WhatsApp is escaped for Pango markup first (markup()), so a message can
// never change how the picture looks. No I/O: the caller uploads the PNG.

/** Drawn at twice the size it is shown at, so it stays sharp on a phone. */
const SCALE = 2;
export const PICTURE_WIDTH = 720 * SCALE;
const PAD = 16 * SCALE;
const HEADER = 60 * SCALE;
const GAP = 6 * SCALE;
const BUBBLE_MAX = Math.round(PICTURE_WIDTH * 0.72);
const PAD_X = 10 * SCALE;
const PAD_Y = 7 * SCALE;
const RADIUS = 8 * SCALE;
const EDGE = 3 * SCALE;
const DPI = 72 * SCALE;
/** A message longer than this is cut, with "…". */
const TEXT_MAX = 600;
const C = {
  wall: '#efeae2', head: '#008069', headText: '#ffffff', headSub: '#d9fdd3', in: '#ffffff', out: '#d9fdd3',
  hit: '#fff3c4', hitEdge: '#f5a623', name: '#1f7aec', meta: '#667781', text: '#111b21',
} as const;

const KIND: Partial<Record<PictureMessage['kind'], string>> = {
  image: 'Photo', video: 'Video', document: 'Document', sticker: 'Sticker', voice: 'Voice note', audio: 'Audio',
  location: 'Location', contact: 'Contact', poll: 'Poll', event: 'Event', other: 'File',
};

/** Text for Pango markup: &, < and > escaped, so it is drawn as it is. */
export function markup(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** At most max whole characters, "…" when cut. */
function cut(s: string, max: number): string {
  const parts = Array.from(graphemes.segment(s), (g) => g.segment);
  return parts.length > max ? `${parts.slice(0, max - 1).join('').trimEnd()}…` : s;
}

const span = (color: string, text: string, extra = '') => `<span foreground="${color}"${extra}>${text}</span>`;

/** One bubble's words as Pango markup: the sender (theirs only), the quote, the media label, the text, the time. */
function bubbleMarkup(m: PictureMessage): string {
  const lines: string[] = [];
  if (!m.mine) lines.push(span(C.name, markup(m.sender), ' weight="bold"'));
  if (m.deleted) {
    lines.push(span(C.meta, 'This message was deleted', ' style="italic"'));
  } else {
    if (m.quote) lines.push(span(C.meta, `↩ ${markup(m.quote.sender)}: ${markup(cut(m.quote.text || KIND[m.quote.kind] || '', 80))}`, ' size="small"'));
    const label = KIND[m.kind];
    if (label) {
      const length = m.seconds !== null ? ` ${Math.floor(m.seconds / 60)}:${String(m.seconds % 60).padStart(2, '0')}` : '';
      lines.push(span(C.meta, `${label}${length}${m.transcript ? `: ${markup(cut(m.transcript, TEXT_MAX))}` : ''}`, ' style="italic"'));
    }
    if (m.text) lines.push(span(C.text, markup(cut(m.text, TEXT_MAX))));
  }
  lines.push(span(C.meta, `${m.edited && !m.deleted ? 'edited · ' : ''}${istTime(new Date(m.at))}`, ' size="x-small"'));
  return lines.join('\n');
}

/** Markup drawn as a transparent PNG, wrapped at width. */
async function words(text: string, width: number): Promise<{ png: Buffer; width: number; height: number }> {
  const { data, info } = await sharp({ text: { text, font: 'sans 15', width, dpi: DPI, rgba: true, wrap: 'word-char' } })
    .png().toBuffer({ resolveWithObject: true });
  return { png: data, width: info.width, height: info.height };
}

/** The picture of a window (pictureWindow) as a PNG. */
export async function drawChatPicture(w: PictureWindow): Promise<Buffer> {
  const source = w.messages.find((m) => m.source) ?? w.messages[0];
  const sub = `${w.client.code}${source ? ` · ${istShortDate(new Date(source.at))}` : ''}`;
  const head = await words(`${span(C.headText, markup(w.client.name), ' weight="bold"')}\n${span(C.headSub, markup(sub), ' size="small"')}`, PICTURE_WIDTH - 2 * PAD);
  const layers: sharp.OverlayOptions[] = [{ input: head.png, top: Math.max(0, Math.round((HEADER - head.height) / 2)), left: PAD }];
  const rects: string[] = [];
  let y = HEADER + PAD;
  for (const m of w.messages) {
    const t = await words(bubbleMarkup(m), BUBBLE_MAX - 2 * PAD_X);
    const bw = t.width + 2 * PAD_X;
    const bh = t.height + 2 * PAD_Y;
    const x = m.mine ? PICTURE_WIDTH - PAD - bw : PAD;
    const fill = m.source ? C.hit : m.mine ? C.out : C.in;
    rects.push(`<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="${RADIUS}" fill="${fill}"${m.source ? ` stroke="${C.hitEdge}" stroke-width="${EDGE}"` : ''}/>`);
    layers.push({ input: t.png, top: y + PAD_Y, left: x + PAD_X });
    y += bh + GAP;
  }
  const height = y - GAP + PAD;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${PICTURE_WIDTH}" height="${height}"><rect width="100%" height="100%" fill="${C.wall}"/><rect width="100%" height="${HEADER}" fill="${C.head}"/>${rects.join('')}</svg>`;
  return sharp(Buffer.from(svg)).composite(layers).png({ compressionLevel: 9 }).toBuffer();
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run tests/output/chatPicture.test.ts --maxWorkers=2`
Expected: PASS. If the "long message" height bound fails, check the numbers first: TEXT_MAX is 600 characters, at about 40 characters a line at 1,008 px that is about 15 lines. Lower `TEXT_MAX` only if the picture really is too tall, and record why in the commit.

- [ ] **Step 5: Commit**

```bash
git add src/output/chatPicture.ts tests/output/chatPicture.test.ts
git commit -m "feat: drawChatPicture: a WhatsApp-style picture of a task's source, drawn with sharp"
```

---

### Task 5: The Sources folder

**Files:**
- Modify: `src/output/folders.ts:7` (type), `:25-26` (key)
- Test: `tests/output/folders.test.ts` (one new test)

- [ ] **Step 1: Write the failing test** (append to `tests/output/folders.test.ts`, reusing its imports; add `FakeDrive` and `seeded` imports if the file lacks them)

```ts
it('keeps a Sources folder per client, next to Files and Meetings (chat pictures, 11 Nov 2026)', async () => {
  const { db, ids } = await seeded();
  await setKv(db, 'drive_root_id', 'root');
  const drive = new FakeDrive();
  const put = (kind: 'Files' | 'Sources') => withClientSubfolder(db, drive, { clientId: ids.sharma, clientName: 'Sharma Interiors' }, kind, async (id) => id);
  const sources = await put('Sources');
  expect(await put('Sources')).toBe(sources); // made once, then saved
  expect(await put('Files')).not.toBe(sources);
  expect(drive.folders).toEqual(['Clients', 'Sharma Interiors', 'Sources', 'Files']);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/output/folders.test.ts --maxWorkers=2`
Expected: FAIL at type level (`'Sources'` is not assignable), or at runtime, because Sources shares the Meetings key.

- [ ] **Step 3: Change the folder kinds**

```ts
/** The folders kept for each client in WA Agent/Clients/<Client>/: shared files, meeting Docs (team only), and the tasks' chat pictures. */
export type ClientSubfolder = 'Files' | 'Meetings' | 'Sources';
```

```ts
const SUBFOLDER_KEYS: Record<ClientSubfolder, string> = { Files: 'drive_files_folder', Meetings: 'drive_meetings_folder', Sources: 'drive_sources_folder' };
const subfolderKey = (kind: ClientSubfolder, clientId: number): string => `${SUBFOLDER_KEYS[kind]}:${clientId}`;
```

Also update the two doc comments that say "Files or Meetings" to "Files, Meetings or Sources".

- [ ] **Step 4: Run the folder tests**

Run: `npx vitest run tests/output/folders.test.ts tests/media tests/meetings --maxWorkers=2`
Expected: PASS. The Files and Meetings keys are unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/output/folders.ts tests/output/folders.test.ts
git commit -m "feat: a Sources folder per client for the chat pictures"
```

---

### Task 6: The runner (`src/output/sourcePictures.ts`)

**Files:**
- Create: `src/output/sourcePictures.ts`
- Test: `tests/output/sourcePictures.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { SourcePictures } from '../../src/output/sourcePictures.ts';
import { setKv } from '../../src/store/kv.ts';
import { insertMessage } from '../../src/store/messages.ts';
import { createTask, setTaskStatus, type NewTask } from '../../src/store/tasks.ts';
import { manualClock } from '../../src/util/clock.ts';
import { silentLogger } from '../../src/util/logger.ts';
import { NOW, seeded } from '../helpers/db.ts';
import { FakeDrive } from '../helpers/fakeDrive.ts';

const task = (clientId: number, sourceWaId: string): NewTask => ({
  clientId, side: 'us', title: 'Brighter banner', category: 'design', priority: 'major', assignedTo: null, askedBy: null,
  raisedOn: '2026-11-03', deadline: null, latestProgress: null, sourceQuote: 'banner bright karo', sourceDate: '2026-11-03', sourceWaId, origin: 'whatsapp',
});

async function setup(o: { tasks?: number; root?: boolean; perRun?: number } = {}) {
  const { db, ids } = await seeded();
  if (o.root !== false) await setKv(db, 'drive_root_id', 'root');
  const n = o.tasks ?? 2;
  for (let i = 1; i <= n + 1; i++) {
    await insertMessage(db, { waId: `w${i}`, clientId: ids.sharma, senderJid: '919800000002@s.whatsapp.net', senderNumber: null, senderName: 'Rahul', fromMe: false, ts: new Date(Date.UTC(2026, 10, 3, 5, i)).toISOString(), text: `message ${i}`, quotedWaId: null, mediaType: null });
  }
  const tasks = [];
  for (let i = 1; i <= n; i++) tasks.push(await createTask(db, task(ids.sharma, `w${i}`), new Date(Date.UTC(2026, 10, 3, 6, i)).toISOString()));
  const done = await createTask(db, task(ids.sharma, `w${n + 1}`), NOW);
  await setTaskStatus(db, done.id, 'done', '2026-11-03', NOW, 'human');
  const drive = new FakeDrive();
  const clock = manualClock(NOW);
  const onMade = vi.fn();
  const pictures = new SourcePictures({ db, api: drive, clock, log: silentLogger(), onMade, ...(o.perRun ? { perRun: o.perRun } : {}) });
  const sourcesFolder = () => drive.folderIds[drive.folders.indexOf('Sources')];
  return { db, ids, tasks, drive, clock, onMade, pictures, sourcesFolder };
}

describe('SourcePictures (a chat picture as each task\u2019s source, 11 Nov 2026)', () => {
  it('draws and uploads one PNG per open task with a stored source into the client\u2019s Sources folder, then asks for an upload', async () => {
    const { db, tasks, drive, onMade, pictures, sourcesFolder } = await setup();
    await pictures.run();
    expect(drive.created.map((f) => f.name).sort()).toEqual(tasks.map((t) => `${t.code}.png`).sort());
    expect(drive.created.every((f) => f.parentId === sourcesFolder())).toBe(true);
    expect(drive.createMimes.every((m) => m === 'image/png')).toBe(true);
    expect(onMade).toHaveBeenCalledTimes(1);
    expect(await db.all('SELECT drive_file_id AS file FROM source_pictures ORDER BY task_id')).toHaveLength(2);
    await pictures.run(); // nothing is due any more
    expect(drive.created).toHaveLength(2);
    expect(onMade).toHaveBeenCalledTimes(1);
  });

  it('makes at most perRun per run, newest task first', async () => {
    const { tasks, drive, pictures } = await setup({ tasks: 3, perRun: 2 });
    await pictures.run();
    expect(drive.created.map((f) => f.name)).toEqual([`${tasks[2]!.code}.png`, `${tasks[1]!.code}.png`]);
    await pictures.run();
    expect(drive.created.at(-1)!.name).toBe(`${tasks[0]!.code}.png`);
  });

  it('does nothing before the first tracker upload has made the WA Agent folder', async () => {
    const { db, drive, onMade, pictures } = await setup({ root: false });
    await pictures.run();
    expect(drive.created).toEqual([]);
    expect(onMade).not.toHaveBeenCalled();
    expect(await db.all('SELECT id FROM source_pictures')).toEqual([]);
  });

  it('records a Drive failure by its code and tries again 10 minutes later', async () => {
    const { db, drive, clock, pictures } = await setup({ tasks: 1 });
    drive.failNextWith = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    await pictures.run();
    expect(drive.created).toEqual([]);
    expect(await db.get('SELECT error_code AS code, attempts FROM source_pictures')).toEqual({ code: 'ECONNRESET', attempts: 1 });
    await pictures.run();
    expect(drive.created).toEqual([]); // not yet
    clock.advance(11 * 60_000);
    await pictures.run();
    expect(drive.created).toHaveLength(1);
  });

  it('stops at a Google sign-in failure and pauses for 15 minutes', async () => {
    const { drive, clock, pictures } = await setup();
    drive.failNextWith = Object.assign(new Error('unauthorized'), { code: 401 });
    await pictures.run();
    expect(drive.createFileCalls).toBe(0);
    await pictures.run();
    expect(drive.created).toEqual([]); // still paused
    clock.advance(16 * 60_000);
    await pictures.run();
    expect(drive.created).toHaveLength(2);
  });

  it('makes a new picture when a task\u2019s source changes', async () => {
    const { db, tasks, drive, pictures } = await setup({ tasks: 1 });
    await pictures.run();
    await db.run("UPDATE tasks SET source_wa_id = 'w2' WHERE id = ?", [tasks[0]!.id]);
    await pictures.run();
    expect(drive.created.map((f) => f.name)).toEqual([`${tasks[0]!.code}.png`, `${tasks[0]!.code}.png`]);
  });

  it('a run already going is shared; after stop() no run starts', async () => {
    const { drive, pictures } = await setup();
    await Promise.all([pictures.run(), pictures.run()]);
    expect(drive.created).toHaveLength(2);
    await pictures.stop(1000);
    await pictures.run();
    expect(drive.created).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/output/sourcePictures.test.ts --maxWorkers=2`
Expected: FAIL with a failed import of `src/output/sourcePictures.ts`.

- [ ] **Step 3: Write the runner**

```ts
import { pictureWindow } from '../control/chatQueries.ts';
import { getClient } from '../store/clients.ts';
import type { Db } from '../store/db.ts';
import { picturesDue, recordPictureFailed, recordPictureMade } from '../store/sourcePictures.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import type { GroupMember } from '../wa/groupMembers.ts';
import { drawChatPicture } from './chatPicture.ts';
import { isAuthFailure, type DriveApi } from './drive.ts';
import { DriveRootMissingError, withClientSubfolder } from './folders.ts';

/** At most this many pictures per run, to keep the Mac light; the rest come at the next run. */
export const PICTURES_PER_RUN = 20;
/** After a Google sign-in failure no run starts for this long (as the file uploader). */
const PAUSE_MS = 15 * 60_000;

export interface SourcePicturesOptions {
  db: Db;
  api: DriveApi;
  clock: Clock;
  log: Logger;
  /** The group's members, for a tag the client's people do not name (the gateway's 5-minute keep). Absent: people only. */
  members?: (groupId: string) => Promise<readonly GroupMember[] | null>;
  /** At least one picture reached Drive: the tracker can link it (another upload). */
  onMade: () => void;
  perRun?: number;
}

/** An error's code, or its name: never its message. Short and plain, for the row and the log. */
function codeOf(e: unknown): string {
  const x = e as { code?: unknown; name?: unknown } | null;
  const raw = typeof x?.code === 'string' || typeof x?.code === 'number' ? String(x.code) : typeof x?.name === 'string' ? x.name : 'error';
  return raw.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 60) || 'error';
}

/**
 * Makes each open task's chat picture (owner request, 11 Nov 2026). It picks the tasks due (picturesDue), reads the
 * messages around each source (pictureWindow), draws the picture (drawChatPicture) and uploads it to
 * WA Agent/Clients/<Client>/Sources/<task code>.png, then records it. One run at a time; never deletes or replaces
 * anything in Drive. A changed source gets a new file and the old one stays, as the file uploader leaves its copies.
 * Before the first tracker upload has made the WA Agent folder, a run does nothing. A Google sign-in failure pauses
 * runs for 15 minutes; any other failure is recorded by its code and tried again later (picturesDue).
 */
export class SourcePictures {
  readonly #o: SourcePicturesOptions;
  #current: Promise<void> | undefined;
  #stopped = false;
  #pausedUntil = 0;

  constructor(o: SourcePicturesOptions) {
    this.#o = o;
  }

  /** One run over the tasks that are due. A run already going is shared. Does nothing while paused. Never rejects. */
  run(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    if (!this.#current) {
      this.#current = this.#pass()
        .catch((err: unknown) => this.#o.log.error({ err: { name: (err as Error)?.name } }, 'source picture run failed'))
        .finally(() => {
          this.#current = undefined;
        });
    }
    return this.#current;
  }

  /** Starts no more runs and waits for the one going, up to timeoutMs. */
  async stop(timeoutMs: number): Promise<void> {
    this.#stopped = true;
    const current = this.#current;
    if (!current) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([current, new Promise<void>((r) => (t = setTimeout(r, timeoutMs)))]);
    clearTimeout(t);
  }

  async #pass(): Promise<void> {
    const { db, api, clock, log } = this.#o;
    if (clock.now().getTime() < this.#pausedUntil) return;
    const due = await picturesDue(db, clock.now(), this.#o.perRun ?? PICTURES_PER_RUN);
    let made = 0;
    for (const d of due) {
      if (this.#stopped) break;
      const at = clock.now().toISOString();
      try {
        const c = await getClient(db, d.clientId);
        const members = this.#o.members;
        const w = await pictureWindow(db, c, d.messageId, members ? () => members(c.groupId) : undefined);
        if (!w) {
          await recordPictureFailed(db, { ...d, errorCode: 'source_missing', at });
          continue;
        }
        const png = await drawChatPicture(w);
        const fileId = await withClientSubfolder(db, api, { clientId: c.id, clientName: c.name }, 'Sources', (folderId) =>
          api.createFile(`${d.code}.png`, 'image/png', png, folderId));
        await recordPictureMade(db, { ...d, driveFileId: fileId, at });
        made += 1;
      } catch (err) {
        if (err instanceof DriveRootMissingError) break; // the first tracker upload makes it; nothing to record
        if (isAuthFailure(err)) {
          this.#pausedUntil = clock.now().getTime() + PAUSE_MS;
          log.warn({ until: new Date(this.#pausedUntil).toISOString() }, 'source pictures paused: Google sign-in failed');
          break;
        }
        const code = codeOf(err);
        log.warn({ taskId: d.taskId, err: code }, 'source picture not made');
        await recordPictureFailed(db, { ...d, errorCode: code, at }).catch((e: unknown) =>
          log.warn({ taskId: d.taskId, err: codeOf(e) }, 'source picture failure not recorded'));
      }
    }
    if (made > 0) this.#o.onMade();
  }
}
```

- [ ] **Step 4: Run it to see it pass (both engines)**

Run: `npx vitest run tests/output/sourcePictures.test.ts --maxWorkers=2`, then `TEST_PG_PORT=56432 npm run test:pg -- tests/output/sourcePictures.test.ts --maxWorkers=2`
Expected: PASS.

For the 401 test: `failNextWith` throws at the first Drive call, which is the `createFolder` for Sources. `createFileCalls` therefore stays 0, and the 401 is still an auth failure.

- [ ] **Step 5: Commit**

```bash
git add src/output/sourcePictures.ts tests/output/sourcePictures.test.ts
git commit -m "feat: SourcePictures: draw and upload each open task's chat picture"
```

---

### Task 7: The tracker: Source link, Chat column, tags as names

**Files:**
- Modify: `src/output/view.ts:72-83` (TrackerView), `:104` (loadTrackerView), `:120-122` (clients' tasks)
- Modify: `src/output/workbook.ts:18-24` (headers), `:98-121` (addTaskTable), `:130` (widths), `:308-344` (addClientSheet), `:385-393` (buildWorkbook)
- Modify: `tests/output/workbook.test.ts:103-104` (the header rows gain "Chat")
- Test: `tests/output/workbookLinks.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { loadTrackerView } from '../../src/output/view.ts';
import { buildWorkbook } from '../../src/output/workbook.ts';
import { insertMessage } from '../../src/store/messages.ts';
import { upsertPerson } from '../../src/store/people.ts';
import { recordPictureMade } from '../../src/store/sourcePictures.ts';
import { createTask, type NewTask } from '../../src/store/tasks.ts';
import { NOW, seeded } from '../helpers/db.ts';

const healthy = { ok: true, text: '✅ Connected' };
const now = new Date('2026-11-03T08:00:00Z');
const task = (clientId: number, o: Partial<NewTask> = {}): NewTask => ({
  clientId, side: 'us', title: 'Brighter banner', category: 'design', priority: 'major', assignedTo: null, askedBy: null,
  raisedOn: '2026-11-03', deadline: null, latestProgress: null, sourceQuote: 'banner bright karo', sourceDate: '2026-11-03', sourceWaId: 'w1', origin: 'whatsapp', ...o,
});

async function sheet(o: { dashboardUrl?: string; picture?: boolean; quote?: string } = {}) {
  const { db, ids } = await seeded();
  await upsertPerson(db, { clientId: ids.sharma, jid: '201111111111111@lid', number: null, name: 'Priya', fromMe: false });
  await insertMessage(db, { waId: 'w1', clientId: ids.sharma, senderJid: 'x@s.whatsapp.net', senderNumber: null, senderName: null, fromMe: false, ts: NOW, text: 'banner', quotedWaId: null, mediaType: null });
  const t = await createTask(db, task(ids.sharma, o.quote ? { sourceQuote: o.quote } : {}), NOW);
  const messageId = (await db.get<{ id: number }>("SELECT id FROM messages WHERE wa_id = 'w1'"))!.id;
  if (o.picture) await recordPictureMade(db, { taskId: t.id, code: t.code, clientId: ids.sharma, messageId, driveFileId: 'PIC123', at: NOW });
  const view = await loadTrackerView(db, now, healthy, o.dashboardUrl ? { dashboardUrl: o.dashboardUrl } : {});
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await buildWorkbook(view)) as unknown as ExcelJS.Buffer);
  const ws = wb.getWorksheet('Sharma Interiors')!;
  let row: ExcelJS.Row | undefined;
  ws.eachRow((r) => {
    if (!row && r.getCell(1).value === t.code) row = r;
  });
  return { ws, row: row!, messageId };
}

describe('the tracker links each task to its chat picture and its chat (11 Nov 2026)', () => {
  it('links the Source cell to the picture and the Chat cell to the message in the dashboard', async () => {
    const { row, messageId } = await sheet({ picture: true, dashboardUrl: 'https://agent.example.com' });
    expect(row.getCell(13).value).toEqual({ text: '"banner bright karo" (3 Nov)', hyperlink: 'https://drive.google.com/file/d/PIC123/view' });
    expect(row.getCell(16).value).toEqual({ text: 'Open', hyperlink: `https://agent.example.com/dashboard/clients?client=SHA&chat=${messageId}` });
  });

  it('keeps the plain quote with no picture yet, and an empty Chat cell with no dashboard address', async () => {
    const { row } = await sheet();
    expect(row.getCell(13).value).toBe('"banner bright karo" (3 Nov)');
    expect(row.getCell(16).value ?? '').toBe('');
  });

  it('shows a tag in the quote as the name, or @member, never the digits', async () => {
    const { row } = await sheet({ quote: '@201111111111111 and @209999999999999 please check' });
    expect(row.getCell(13).value).toBe('"@Priya and @member please check" (3 Nov)');
  });
});
```

Also, in `tests/output/workbook.test.ts`:
- line 103: append `'Chat'` to the expected header array;
- line 104: `.slice(12)` expects `['Source message', 'Closed on', 'Priority level', 'Sentiment', 'Chat']`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/output/workbookLinks.test.ts tests/output/workbook.test.ts --maxWorkers=2`
Expected: FAIL. There is no hyperlink, no Chat header, and the tags are raw.

- [ ] **Step 3: Write the view changes**

In `src/output/view.ts`:
- imports:

```ts
import { withTagNames } from '../control/chatQueries.ts';
import { sourceLinks, type SourceLink } from '../store/sourcePictures.ts';
import { mentionTags } from '../wa/groupMembers.ts';
```

- add to `TrackerView`:

```ts
  /** Each task's source message and current chat picture (sourceLinks): the Source and Chat links (11 Nov 2026). */
  sources?: Map<number, SourceLink>;
  /** The dashboard's public address, for the Chat column; absent: the column stays empty. */
  dashboardUrl?: string;
```

- add above `loadTrackerView`:

```ts
/** The tasks with each tag in a source quote as the person's name, or @member: never the digits (11 Nov 2026). */
async function namedQuotes(db: Db, c: ClientRow, tasks: TaskRow[]): Promise<TaskRow[]> {
  const tagged = tasks.filter((t) => t.sourceQuote !== null && mentionTags(t.sourceQuote).size > 0);
  if (tagged.length === 0) return tasks;
  const named = await withTagNames(db, c, tagged.map((t) => t.sourceQuote!));
  const byId = new Map(tagged.map((t, i) => [t.id, named[i]!]));
  return tasks.map((t) => (byId.has(t.id) ? { ...t, sourceQuote: byId.get(t.id)! } : t));
}
```

- change the signature to `export async function loadTrackerView(db: Db, now: Date, health: HealthLine, o: { dashboardUrl?: string } = {}): Promise<TrackerView>`;
- in its returned object, add `sources: await sourceLinks(db), ...(o.dashboardUrl ? { dashboardUrl: o.dashboardUrl } : {}),`;
- in the clients map, replace `const all = await listTasks(db, client.id);` with `const all = await namedQuotes(db, client, await listTasks(db, client.id));`.

Add the `ClientRow` and `TaskRow` type imports if view.ts lacks them. `ClientRow` is from `../store/clients.ts`, `TaskRow` from `../store/tasks.ts`.

- [ ] **Step 4: Write the workbook changes**

In `src/output/workbook.ts`:
- below `ADDED_TASK_HEADERS`:

```ts
/** Appended last (11 Nov 2026), after Priority level and Sentiment: a link to the task's source in the dashboard. */
const CHAT_HEADER = 'Chat';
/** The Source message column (M): its quote links to the task's chat picture when there is one. */
const SOURCE_COLUMN = TASK_HEADERS.length;

/** A task's two links (11 Nov 2026): its chat picture on Drive, and its source message in the dashboard. */
interface TaskLinks {
  picture(t: TaskRow): string | null;
  chat(t: TaskRow): string | null;
}
```

- in `addTaskTable`, add `links?: TaskLinks` to `opts`, then:

```ts
  const headers = [...TASK_HEADERS, ...(opts.closedOn ? ['Closed on'] : []), ...ADDED_TASK_HEADERS, CHAT_HEADER];
```

  and in the loop replace `cells.push(...addedTaskCells(t, opts.sentiment === true));` and `const row = ws.addRow(cells);` with:

```ts
    cells.push(...addedTaskCells(t, opts.sentiment === true), '');
    const row = ws.addRow(cells);
    const picture = opts.links?.picture(t) ?? null;
    if (picture) setLink(row.getCell(SOURCE_COLUMN), String(cells[SOURCE_COLUMN - 1] || 'Picture'), picture);
    const chat = opts.links?.chat(t) ?? null;
    if (chat) setLink(row.getCell(headers.length), 'Open', chat);
```

- `CLIENT_COLUMN_WIDTHS`: append `10` (Q, the Chat column of the Done table; P holds it for the open tables), and update its comment to "A to Q … Q (P in the open tables) holds Chat";
- add, near `driveUrl`:

```ts
/** A client's task links from the view: the picture when it shows the task's current source, and the dashboard's chat. */
function taskLinks(view: TrackerView, code: string): TaskLinks {
  return {
    picture: (t) => driveUrl(view.sources?.get(t.id)?.driveFileId ?? null),
    chat: (t) => {
      const s = view.sources?.get(t.id);
      return s && view.dashboardUrl ? `${view.dashboardUrl}/dashboard/clients?client=${encodeURIComponent(code)}&chat=${s.messageId}` : null;
    },
  };
}
```

- change `addClientSheet(wb, c, today, sentiment)` to `addClientSheet(wb, c, today, sentiment, links: TaskLinks)` and pass `links` in the three `addTaskTable` calls (`{ autoFilter: true, sentiment, links }`, `{ sentiment, links }`, `{ closedOn: true, sentiment, links }`);
- in `buildWorkbook`: `for (const c of view.clients) addClientSheet(wb, c, view.today, view.sentiment === true, taskLinks(view, c.client.code));`.

- [ ] **Step 5: Run the tracker tests**

Run: `npx vitest run tests/output --maxWorkers=2`
Expected: PASS. If another workbook test pins the client tab's column count or a header row, add `'Chat'` at its end.

- [ ] **Step 6: Commit**

```bash
git add src/output/view.ts src/output/workbook.ts tests/output/workbookLinks.test.ts tests/output/workbook.test.ts
git commit -m "feat: the tracker links each task's Source to its chat picture and adds a Chat column"
```

---

### Task 8: Wire the runner into the app

**Files:**
- Modify: `src/app.ts`:
  - `AppDeps` (line 107): add `dashboardUrl`;
  - publisher `build` (line 253);
  - `onPublished` (line 260);
  - after the uploader (line 368);
  - the tick (line 601);
  - stop (line 712).
- Modify: `src/runtime/customerRuntime.ts:394` (`createApp({`)
- Test: `tests/appPictures.test.ts`

- [ ] **Step 1: Write the failing test**

Before writing it, read `tests/appMedia.test.ts` and copy its app setup helper, i.e. how it builds `createApp` with a fake gateway, `FakeDrive`, clock and db. Keep the same deps, adding `dashboardUrl: 'https://agent.example.com'`. The test:

```ts
it('after a tracker upload, makes the open tasks\u2019 chat pictures, then uploads the tracker again with their links (11 Nov 2026)', async () => {
  // setup as tests/appMedia.test.ts, plus: one stored message 'w1' for Sharma and a task whose sourceWaId is 'w1'
  await app.publisher.publishNow(); // the first upload makes the WA Agent folder
  await vi.waitFor(() => expect(drive.created.some((f) => f.name.endsWith('.png'))).toBe(true));
  await vi.waitFor(() => expect(drive.updated.length).toBeGreaterThan(0)); // the tracker again, now with the link
});
```

If `createApp`'s return value does not expose `publisher`, trigger the upload the way `tests/appMedia.test.ts` does (its first publish), and keep the two `waitFor` checks.

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/appPictures.test.ts --maxWorkers=2`
Expected: FAIL. No PNG is ever created.

- [ ] **Step 3: Wire it**

In `src/app.ts`:
- import `import { SourcePictures } from './output/sourcePictures.ts';`;
- in `AppDeps`:

```ts
  /** The dashboard's public address (DASHBOARD_PUBLIC_URL, when the dashboard is on): the tracker's Chat links. */
  dashboardUrl?: string;
```

- in the publisher's `build`: `return buildWorkbook(await loadTrackerView(d.db, now, line, d.dashboardUrl ? { dashboardUrl: d.dashboardUrl } : {}));`;
- in `onPublished`, right after `runUploads();`:

```ts
      void pictures.run(); // the chat pictures need the WA Agent folder the first upload makes, as the files do
```

- after the `const runUploads = …` line:

```ts
  // A chat picture for each open task's source (owner request, 11 Nov 2026): after each upload and on the tick, as the
  // files are. A new picture asks for another upload, so the tracker links it.
  const pictures = new SourcePictures({
    db: d.db, api: d.drive, clock: d.clock, log: d.log, onMade: () => publisher.schedule(),
    ...(d.gateway.groupMembers ? { members: (groupId: string) => d.gateway.groupMembers!(groupId) } : {}),
  });
```

- in the tick, after `runUploads(); // retries that are due`: `void pictures.run(); // pictures that are due again`;
- in the stop sequence, after `void uploader?.stop(0);`: `void pictures.stop(0);`.

In `src/runtime/customerRuntime.ts`, inside `createApp({ … })` (line 394), add:

```ts
      // The tracker's Chat links open the dashboard (11 Nov 2026): only when it is on and has a public address.
      ...(env.DASHBOARD_ENABLED && env.DASHBOARD_PUBLIC_URL ? { dashboardUrl: env.DASHBOARD_PUBLIC_URL } : {}),
```

- [ ] **Step 4: Run the app tests**

Run: `npx vitest run tests/appPictures.test.ts tests/app.test.ts tests/appMedia.test.ts tests/appMeetings.test.ts tests/appReport.test.ts tests/runtime --maxWorkers=2`
Expected: PASS.

If an existing test asserts the exact list of Drive files and now also sees a chat picture, leave the pictures out of that assertion with this helper rather than switching pictures off:

```ts
const sourcesIds = () => drive.folderIds.filter((_, i) => drive.folders[i] === 'Sources');
const notPictures = (files: typeof drive.created) => files.filter((f) => !sourcesIds().includes(f.parentId));
```

- [ ] **Step 5: Commit**

```bash
git add src/app.ts src/runtime/customerRuntime.ts tests/appPictures.test.ts
git commit -m "feat: the app makes the chat pictures after each tracker upload"
```

---

### Task 9: Sign-in returns to the Chat link

**Files:**
- Modify: `src/web/oidc.ts:118-123` (`safeReturnPath`)
- Modify: `src/web/public/views/signin.js:24` (`back`)
- Test: `tests/web/oidc.test.ts` (the `safeReturnPath` describe)

- [ ] **Step 1: Write the failing test** (inside `describe('safeReturnPath'`)

```ts
  it('returns to a tracker Chat link, exactly that shape and nothing else (11 Nov 2026)', () => {
    expect(safeReturnPath('/dashboard/clients?client=SHA&chat=1234')).toBe('/dashboard/clients?client=SHA&chat=1234');
    for (const bad of [
      '/dashboard/clients?client=SHA&chat=1234&x=1', '/dashboard/clients?client=sha&chat=1', '/dashboard/clients?client=SHA&chat=',
      '/dashboard/clients?chat=1&client=SHA', '//evil.example/dashboard/clients?client=SHA&chat=1', '/dashboard/clients?client=SHAAA&chat=1',
      '/dashboard/clients?client=SHA&chat=1234567890',
    ]) expect(safeReturnPath(bad), bad).toBe('/dashboard');
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/web/oidc.test.ts --maxWorkers=2`
Expected: FAIL. The first expectation gets `/dashboard`.

- [ ] **Step 3: Allow exactly that shape**

```ts
/** A tracker Chat link (11 Nov 2026): a client code as the chat routes take it, and a message row. Nothing else. */
const CHAT_LINK = /^\/dashboard\/clients\?client=[A-Z]{3,4}&chat=\d{1,9}$/;

export function safeReturnPath(raw: string | null | undefined): string {
  if (raw === '/dashboard/clients/groups') return raw;
  if (typeof raw === 'string' && CHAT_LINK.test(raw)) return raw;
  const m = raw === null || raw === undefined ? null : /^\/dashboard\/([a-z]+)$/.exec(raw);
  if (m !== null && DASHBOARD_SCREENS.includes(m[1]!)) return raw!;
  return '/dashboard';
}
```

In `signin.js`, replace the `back` line with:

```js
  // A tracker Chat link keeps its message through sign-in (the agent accepts exactly that shape, oidc.ts CHAT_LINK).
  const chatLink = location.pathname === '/dashboard/clients' && /^\?client=[A-Z]{3,4}&chat=\d{1,9}$/.test(location.search);
  const back = chatLink ? `${location.pathname}${location.search}`
    : location.pathname.startsWith('/dashboard/') && location.pathname !== '/dashboard/' ? location.pathname : '/dashboard';
```

- [ ] **Step 4: Run the web tests and the typecheck**

Run: `npx vitest run tests/web/oidc.test.ts tests/web/authRoutes.test.ts --maxWorkers=2` and `npm run typecheck`
Expected: PASS, and the typecheck is clean.

- [ ] **Step 5: Commit**

```bash
git add src/web/oidc.ts src/web/public/views/signin.js tests/web/oidc.test.ts
git commit -m "feat: sign-in returns to a tracker Chat link"
```

---

### Task 10: Open chat opens at a message and lights it up

**Files:**
- Modify: `src/web/public/views/chat.js`:
  - the chat type (line 41);
  - `bubble` (line 120);
  - `openChat` (line 649);
  - its first load (line 777).
- Modify: `src/web/public/views/clients.js:226` (`mountClients`, read the link) and its poll (line 284)
- Modify: `src/web/public/styles.css` (the Open chat block)
- Modify: `scripts/dashboard-smoke.ts` (after the "open chat" checks, around line 492)

- [ ] **Step 1: Write the failing smoke step**

In `scripts/dashboard-smoke.ts`, right after the "Back to the client's panel" lines of the `open chat ${tag}` step (around line 492), add:

```ts
        // The tracker's Chat link (11 Nov 2026): the chat opens at that message, even one a page back, and lights it up.
        where = `chat link ${tag}`;
        await openAcmeChat();
        const code = ((await p.locator('.chat-sheet .ch-sub').textContent()) ?? '').split(' ')[0]!;
        await p.locator('.chat-sheet .ch-body').hover();
        for (let i = 0; i < 12; i++) {
          await p.mouse.wheel(0, -800);
          await p.waitForTimeout(80);
        }
        const oldest = await p.locator('.chat-sheet .ch-row[data-msg]').first().getAttribute('data-msg');
        await p.goto(`${base}/dashboard/clients?client=${code}&chat=${oldest}`);
        await p.locator(`.chat-sheet .ch-row.ch-hit[data-msg="${oldest}"]`).waitFor();
        if (new URL(p.url()).search !== '') fail(where, 'the address keeps the link after it was used');
        await p.keyboard.press('Escape');
```

- [ ] **Step 2: Run the smoke to see it fail**

Run: `npm run smoke:dashboard -- --out C:/Users/Dell/AppData/Local/Temp/claude/smoke-chatlink`
Expected: FAIL at `chat link`, waiting for `.ch-row.ch-hit`.

- [ ] **Step 3: Open at a message (chat.js)**

- Add to the chat state type (line 41) `hit: number | null` and to the initial state in `openChat` `hit: null,`.
- Add near the other constants:

```js
/** How many older pages Open chat reads, at most, to reach a message a tracker Chat link names (11 Nov 2026). */
const JUMP_PAGES = 20;
/** How long that message stays lit. */
const HIT_MS = 4000;
```

- In `bubble`, change the row class line to:

```js
  const row = `ch-row ${m.mine ? 'out' : 'in'}${first ? ' first' : ''}${chat?.hit === m.id ? ' ch-hit' : ''}`;
```

- Add after `loadOlder`:

```js
/**
 * Shows the message `id` (a tracker Chat link): reads older pages, up to JUMP_PAGES, until it is in the chat, then
 * scrolls to it and lights it up for HIT_MS. Further back than that, it says so and stays at the newest.
 * @param {number} id
 */
async function jumpTo(id) {
  const c = chat;
  if (!c) return;
  for (let i = 0; i < JUMP_PAGES && !c.messages.has(id) && c.hasOlder && chat === c; i++) await loadOlder();
  if (chat !== c) return;
  if (!c.messages.has(id)) return void toast('That message is too far back to show here.', false);
  c.hit = id;
  draw();
  /** @type {HTMLElement | null} */ (c.el.querySelector(`.ch-row[data-msg="${id}"]`))?.scrollIntoView({ block: 'center' });
  setTimeout(() => {
    if (chat !== c || c.hit !== id) return;
    c.hit = null;
    draw();
  }, HIT_MS);
}
```

- Change `openChat`'s signature and its doc comment:

```js
/**
 * Opens the chat of a client. `onBack` reopens what it came from (the client's panel). `at`: a message to open at (a
 * tracker Chat link), or null.
 * @param {string} code @param {() => void} onBack @param {number | null} [at]
 */
export function openChat(code, onBack, at = null) {
```

- Change its first load (line 777) from `void loadNewest(true);` to:

```js
  void loadNewest(true).then(() => (at !== null ? jumpTo(at) : undefined));
```

- [ ] **Step 4: Read the link on the Clients screen (clients.js)**

In `mountClients`, after `view.addEventListener('click', onTab);` and before the `if (ctx.sub === 'groups')` block:

```js
  // A tracker Chat link (11 Nov 2026): ?client=<code>&chat=<message> opens that client's chat at the message, once,
  // when the client is in the list. The address is cleaned at once, so a reload or Back does not open it again.
  const link = new URLSearchParams(location.search);
  const linkAt = link.get('chat');
  /** @type {{ code: string, at: number } | null} */
  let jump = link.get('client') && linkAt !== null && /^\d{1,9}$/.test(linkAt) ? { code: link.get('client') ?? '', at: Number(linkAt) } : null;
  if (link.has('client') || link.has('chat')) history.replaceState(null, '', location.pathname);
```

In the poll, right after `error = null;`:

```js
      if (jump && next.some((c) => c.code === jump?.code)) {
        const { code, at } = jump;
        jump = null;
        openChat(code, () => void clientDrawer(code), at);
      }
```

If `readClients` items call the code something other than `code`, use the field `card()` puts in `data-client` (`c.code` on line 87).

- [ ] **Step 5: The highlight (styles.css)**

In the Open chat block, beside the other `--ch-*` variables, add `--ch-hit: rgba(245, 166, 35, .9);` to both the dark and the light variable lists. Then add:

```css
/* A tracker Chat link's message (11 Nov 2026): lit for a few seconds, a still ring (no motion), cleared by chat.js. */
.ch-row.ch-hit .ch-bub { box-shadow: 0 0 0 3px var(--ch-hit); }
```

- [ ] **Step 6: Check it**

Run: `npm run typecheck`, then `npx vitest run tests/web --maxWorkers=2`, then `npm run smoke:dashboard -- --out C:/Users/Dell/AppData/Local/Temp/claude/smoke-chatlink`
Expected: the typecheck is clean, tests/web passes, and the smoke prints "Dashboard smoke test passed". Look at one `chat-*` screenshot to check the lit message.

- [ ] **Step 7: Commit**

```bash
git add src/web/public/views/chat.js src/web/public/views/clients.js src/web/public/styles.css scripts/dashboard-smoke.ts
git commit -m "feat: Open chat opens at a tracker Chat link's message and lights it up"
```

---

### Task 11: A sample picture, the Mac's go-live steps, the full gate

**Files:**
- Create: `scripts/picture-sample.ts`
- Modify: `docs/GO-LIVE-postgres.md` (a new Part 11 at the end)

- [ ] **Step 1: The sample script**

```ts
// A sample chat picture for the owner to look at before go-live (11 Nov 2026): made from fixed words, with no database,
// no WhatsApp and no Drive. node scripts/picture-sample.ts --out <file.png>
import { writeFileSync } from 'node:fs';
import type { PictureMessage } from '../src/control/chatQueries.ts';
import { drawChatPicture } from '../src/output/chatPicture.ts';

const out = process.argv[process.argv.indexOf('--out') + 1];
if (!out || !out.endsWith('.png')) throw new Error('Give --out <file.png>');
const at = (min: number) => new Date(Date.UTC(2026, 10, 3, 4, min)).toISOString();
const m = (o: Partial<PictureMessage>): PictureMessage => ({
  id: 1, at: at(0), mine: false, sender: 'Mr. Sharma', text: '', kind: 'text', seconds: null, transcript: null, quote: null,
  edited: false, deleted: false, source: false, ...o,
});
const png = await drawChatPicture({
  client: { code: 'SHA', name: 'Sharma Interiors' },
  messages: [
    m({ at: at(8), sender: 'Priya', text: 'Logo final ho gaya?' }),
    m({ at: at(9), mine: true, sender: 'Founder', text: 'Haan, sent yesterday' }),
    m({ at: at(10), kind: 'image', text: 'Yeh dekho' }),
    m({ at: at(11), kind: 'voice', seconds: 42, transcript: 'Banner ka colour thoda dull lag raha hai' }),
    m({ at: at(12), source: true, text: 'Banner thoda bright karo @Priya, aur logo bada 👍', quote: { sender: 'Priya', text: 'Logo final ho gaya?', kind: 'text' } }),
    m({ at: at(14), mine: true, sender: 'Founder', text: 'Ok, aaj shaam tak' }),
    m({ at: at(15), sender: 'Priya', text: 'Thanks!' }),
  ],
});
writeFileSync(out, png);
console.log(`Sample picture: ${out} (${png.length} bytes)`);
```

Run: `node scripts/picture-sample.ts --out C:/Users/Dell/AppData/Local/Temp/claude/picture-sample.png`
Expected: "Sample picture: … bytes". Open the PNG and check four things:
- the bubbles are on the right sides;
- the source is lit amber;
- the Hindi, Hinglish and emoji show;
- nothing is cut off.

Fix the layout constants in `chatPicture.ts` if not. Keep `tests/output/chatPicture.test.ts` passing.

- [ ] **Step 2: The Mac's steps (docs)**

Append to `docs/GO-LIVE-postgres.md`:

```markdown
## Part 11. Updating to the chat-picture release (P8)

This release adds one table, `source_pictures`, for each task's chat picture. It needs the same steps as Part 9.

1. Stop the agent (normal window).
2. Back up twice, as Part 9 step 2, naming the dump `before-pictures.dump`. Check it with `pg_restore -l` (more than 10 `TABLE DATA` lines).
3. After the merge (waagent window): `cd /opt/wa-agent; git pull --ff-only; npm ci`.
4. `npm run cli -- db-migrate`. It prints `Applied P8`, then `Access rules checked: …`. On anything else, don't start; send the output.
5. Start the agent (normal window), then `npm run cli -- status` (waagent window).
6. Check: after the next tracker update, open Tracker.xlsx. An open task's **Source message** is a link to a picture in `WA Agent/Clients/<Client>/Sources/`, and its **Chat** cell opens the message in the dashboard. Pictures come 20 per update, newest tasks first.

**Rollback:** reverting alone is not enough, because the old code refuses a P8 database. Restore `before-pictures.dump` as in Part 9's rollback.
```

If `tests/docs/goLivePostgres.test.ts` checks the document's part list or order, extend that check to Part 11 the same way it checks Part 9.

- [ ] **Step 3: The full gate**

Run each in turn, one at a time:
1. `npm run typecheck`
2. `npx vitest run tests/store tests/migrate tests/control tests/output tests/web tests/runtime tests/app.test.ts tests/appMedia.test.ts tests/appMeetings.test.ts tests/appReport.test.ts tests/appPictures.test.ts tests/docs tests/wa/sendScan.test.ts --maxWorkers=2`
3. `TEST_PG_PORT=56432 npm run test:pg -- tests/store tests/control/pictureWindow.test.ts tests/output/sourcePictures.test.ts tests/output/workbookLinks.test.ts --maxWorkers=2`
4. `npm run smoke:dashboard -- --out C:/Users/Dell/AppData/Local/Temp/claude/smoke-final`
5. `node scripts/platform-smoke.ts --out C:/Users/Dell/AppData/Local/Temp/claude/smoke-platform-final`

Expected: all pass. Then run the full suite once, alone: `npx vitest run --maxWorkers=2`. Expected: every file passes, apart from the one known expected-fail.

- [ ] **Step 4: Secret and number scan of the branch**

Run: `git diff origin/main..HEAD | grep -nE "^\+.*(sk-ant-[A-Za-z0-9_-]{20,}|BEGIN .*PRIVATE|password=)"`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add scripts/picture-sample.ts docs/GO-LIVE-postgres.md tests/docs
git commit -m "docs: the chat-picture release's Mac steps (Part 11), and a sample picture script"
```

---

## After the plan

Report to the owner:
- the sample picture;
- the test counts;
- the two Mac facts: one backup, then `db-migrate` (P8).

Then ask before pushing, opening a PR and merging. Merging auto-updates the Mac, and this release needs the database step first.
