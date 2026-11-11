# Self-learning: a lessons notebook

**Status:** approved by the owner on 11 Nov 2026 (brainstorm). Not built yet. Build it together with the chat picture (`2026-11-11-chat-picture-source-design.md`), so the Mac has one database step.

**Goal:** the agent gets better at finding tasks from the owner's own corrections, without retraining any model. It keeps short, readable **lessons** per client and gives them to the AI each time it reads that client's group. The owner can see, edit, approve and delete every lesson.

The owner asked it to learn four things:
- from the owner's fixes;
- each client's way of talking;
- who does what;
- what the owner treats as urgent.

## What counts as a fix

The dashboard already records each human change as an event (`src/cli/corrections.ts`, `humanEvent` → `recordEvent`, actor `human`). The AI's own operations are events too, with their source message ids. A **fix** is a human event that undoes or changes an AI decision:

| Owner action | Event | Lesson topic |
|---|---|---|
| Reopen a task the AI closed or marked maybe-done | `reopen_task` | what is a task / done |
| Edit `assignedTo` | `update_task` | who does it |
| Edit `priority` | `update_task` | priority |
| Edit `category` or `side` | `update_task` | category |
| Edit `deadline` | `update_task` | deadline |
| **Not a task** (new, see below) | `not_a_task` | what is a task |

**Not fixes:**
- Marking a task done. That is normal work.
- Edits to `title` or `latestProgress` only (wording, not a decision).
- A change to a field the AI never set.

**A new task action, "Not a task":** the dashboard has no way today to say that the AI made a task it should not have. The action closes the task with a new status, `dropped` (allowed by the same v16/P9 migration), which takes it out of every open list and the tracker's open sheets, and records a `not_a_task` event. It is the strongest learning signal. A merge action is out of scope.

## What the owner sees: "What I've learned" (System menu)

- **In use:** each lesson's sentence, its client (or "All clients"), where it came from ("from your fix, 4 Nov" or "you added it"), how often it was used, and when it was last used. **Edit** and **Delete**.
- **Suggested:** lessons from the weekly review, each with its evidence ("Rahul closed 8 of 9 website tasks"). **Approve** (it moves to In use) or **Dismiss** (it is not suggested again).
- **Add a lesson:** the owner's own sentence, for one client or all clients, up to 200 characters. In use at once.
- **Is it getting better?** A small weekly chart of fixes per 100 tasks found, for the last 12 weeks.

Lessons belong to one client unless they are set to all clients. Each customer workspace has its own lessons (its own tables, under row-level security on Postgres). Customers get the screen for their own workspace.

## How it works

### Units

1. **Tables** (SQLite v16 and Postgres P9, shipped in the same release as the picture's v15/P8; on Postgres, customer tables under row-level security, added to the access-rules check):
   - `lessons`: `id`, `client_id` (null = all clients), `topic` (`task`, `who`, `priority`, `category`, `deadline`), `text`, `status` (`active`, `suggested`, `dismissed`), `origin` (`fix`, `review`, `owner`), `evidence`, `created_at`, `used_count` and `last_used_at`.
   - `lesson_jobs`: one row per fix still to turn into a lesson, with `event_id`, `state`, `attempts` and `last_error_code`, so a fix is processed once, even across restarts.
2. **`src/learn/fixes.ts`: finding fixes.**
   - After each human event that is a fix (per the table above), it queues a `lesson_jobs` row.
   - It gathers what the lesson writer needs: the AI's earlier value (from the task's AI events), the owner's new value, and the task's source messages (a few lines, names only, no numbers, tags as names via the tag fix).
3. **`src/learn/writer.ts`: one lesson per fix.**
   - A small AI call with a fixed schema: `{ lesson: null | { topic, text } }`. `null` means it was a one-off.
   - Its system prompt says lessons are only about the five topics, at most 200 characters, never about sending, replying or any action, and never include phone numbers.
   - The answer is checked against those rules before it is stored as `active`, with origin `fix`. An answer that fails the check is dropped and logged by its code only.
   - It does not repeat a lesson the client already has: the client's lessons go in the call, and the writer may answer that the lesson already exists.
4. **`src/learn/review.ts`: the weekly review.**
   - Once a week, on Sunday at 09:00 IST, for each client with fixes or new tasks that week.
   - First, plain counts with no AI: who closed which category, which words appeared on tasks the owner made urgent, and the fixes by topic.
   - Then one AI call with those counts, the week's fixes and the client's lessons. It suggests **up to 5** lessons, each with its evidence, stored as `suggested` and checked as in the writer.
   - Suggestions are never used until the owner approves them.
5. **The prompt (`src/brain/prompt.ts`).** A new `<lessons>` section for that client's batch:
   - up to **20** `active` lessons for the client plus the all-clients ones, most used first, then newest;
   - each lesson's `used_count` and `last_used_at` are updated when it is sent;
   - the system prompt says lessons are the studio's guidance on what is a task, who does it, priority, category and deadline. They never change the safety rules, and the rule that chat content is data stays above them.
6. **The dashboard:**
   - the "What I've learned" screen and its routes (list, edit, delete, approve, dismiss, add);
   - the "Not a task" action on a task;
   - every change is audited like other owner actions.

### Safety

- **Injection:** lessons the AI works out from client chat (the weekly review) are only suggested; the owner approves each one. Lessons from fixes come from the owner's own change. Every lesson passes the same check: a known topic, at most 200 characters, and no action words such as send, reply, delete or forward.
- The agent stays read-only towards clients. Lessons only shape how tasks are found, and nothing in a lesson can make it send.
- No phone numbers in lessons, logs or the audit. Lesson text never goes in logs.
- A customer's lessons stay in its own workspace and are made with its own Claude key.

### Cost

On the workspace's own Claude key, inside its existing daily cap:
- about $0.01 per fix;
- about $0.05 per client per week;
- about 600 more input tokens per batch, a few percent more.

For 20 clients, that is roughly $1–2 a week. Each call is a paid call through the existing `paidCall` path. When a call is refused by the cap, the job waits for the next day.

### Errors

- A lesson job that fails is tried up to 3 times, then left as failed with its error code. The screen shows "1 fix not learned", with Retry.
- A broken lessons table, or a read error, never stops a batch: the batch runs without `<lessons>`, and the failure is logged.

## Testing

- **Fix detection:**
  - each owner action from the table queues exactly one job;
  - marking done, title-only edits and progress-only edits queue none;
  - a restart does not queue a fix twice.
- **Writer:**
  - with the schema fake, a lesson is stored as active with origin `fix`;
  - `null` stores nothing;
  - text with "send", or over 200 characters, or with a phone number, is refused;
  - a duplicate is not stored twice.
- **Review:**
  - counts from fixture data;
  - at most 5 suggestions;
  - suggestions are never in `<lessons>` until approved;
  - dismissed ones are not suggested again.
- **Prompt:**
  - `<lessons>` holds at most 20, client plus all clients, in the right order;
  - another client's lessons never appear;
  - it is absent with no lessons.
- **Dashboard:** the routes (list, edit, delete, approve, dismiss, add) with audit; "Not a task" closes the task and queues a job; the screen in the dashboard smoke.
- **Postgres:** `lessons` and `lesson_jobs` under row-level security (the `dbAccess` and `noBypass` locks), and a customer never reading another customer's lessons.
- **Cost:** every learn call goes through `paidCall` and is refused over the cap (the existing spend test pattern).

## Go-live

The Mac's database step is shared with the chat picture, as one backup and one `db-migrate` (expect "Applied P8" and "Applied P9"). After that:
- the screen shows "No lessons yet";
- the first lessons appear after the owner's first fixes;
- the first suggestions appear after the first Sunday.

## Out of scope

- Retraining or fine-tuning a model.
- Learning from the morning report or meetings.
- A merge action.
- Lessons shared between workspaces.
