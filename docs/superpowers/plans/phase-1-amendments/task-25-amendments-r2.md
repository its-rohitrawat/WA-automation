# Task 25 amendments, round 2 (controller decisions from the review of 904ccae)

Apply these on top of task-25.md.

Files touched:
- src/brain/validator.ts, src/brain/reconciler.ts
- src/store/db.ts, src/store/messages.ts, src/store/tasks.ts, and src/store/decisions if decisions live elsewhere
- src/cli/corrections.ts, src/cli.ts
- their tests

## 1. A message can never produce the same task, reminder or decision twice (Important)
`reprocess` re-queues already-processed messages as ordinary new messages. Done tasks are not in the prompt, so the AI re-creates a task a human closed and counts reminders again. The fix is a deterministic guard in the validator, built from fresh state inside the reconciler's apply transaction.

- **New `ValidationState` fields:**
  - `taskSourceIds: Set<string>`: `source_wa_id` of **every** task of this client, any status.
  - `reminderSourceIds: Map<string, Set<string>>`: task code → message ids already cited by an applied `log_reminder` event for that task. Read from `task_events` where `op = 'log_reminder'`, parsing `source_ids` JSON and joining to tasks for the code.
  - `decisionSourceIds: Set<string>`: `source_wa_id` of every decision of this client.
  - `requeuedIds: Set<string>`: batch message ids whose `requeueReason` is not null (edit/reaction re-checks).
- **Fresh source ids:** the guard only looks at the op's batch source ids whose message is **not** in `requeuedIds`. Edit and reaction re-checks are already handled by the prompt's "(re-check …)" marker, and an edit may legitimately add new work. Brand-new messages are never in these sets, so the guard only fires for messages that were processed before and came back without a marker. That means reprocess, or a crash before marking.
- **Rejections:**
  - `add_task`: if any fresh batch source id is in `taskSourceIds` → reject `'task already exists for this message'`.
  - `log_reminder`: if any fresh batch source id is in `reminderSourceIds.get(taskCode)` → reject `'reminder already counted for this message'`.
  - `add_decision`: if any fresh batch source id is in `decisionSourceIds` → reject `'decision already recorded for this message'`.
- **Store queries:** add small functions, one per set, e.g. `taskSourceIds(db, clientId)`, `reminderSourceIds(db, clientId)`, `decisionSourceIds(db, clientId)`. The reconciler builds these sets inside the apply tx together with the other fresh state.
- **Validator tests:**
  - an add_task citing a fresh id that is an existing *done* task's source → rejected;
  - the same id but the message has requeueReason 'edit' → accepted;
  - a second log_reminder citing the same message → rejected;
  - add_decision duplicate → rejected;
  - a brand-new id → accepted in all three cases.
- **Reconciler test:**
  1. The AI creates SHA-001 from m1.
  2. A human closes it.
  3. `requestReprocess` re-queues m1.
  4. The AI returns add_task citing m1 → rejected, no SHA-002.

## 2. Writers take the write lock at BEGIN (src/store/db.ts and messages.ts)
A CLI correction that commits inside the reconciler's apply transaction makes the service's first write fail with SQLITE_BUSY_SNAPSHOT (deferred BEGIN, read first). The result is `apply_failed` and a wasted paid call.

- `tx(db, fn)` becomes `db.transaction(fn).immediate()`.
- The direct `db.transaction(...)()` calls in src/store/messages.ts (applyEdit, upsertReaction and the one near line 138) and src/store/clients.ts use `.immediate()` too.
- Migrations can stay as they are.
- Test: open two connections to one temp DB file. Inside a `tx` on connection A that first reads, a write on connection B waits (busy timeout) instead of making A's later write fail. If that is hard to test deterministically, at least assert that `tx` uses BEGIN IMMEDIATE, e.g. via `db.inTransaction` and a second connection's write being blocked.

## 3. reprocess is bounded, honest and confirmed
- **Count only real re-queues:** `resetProcessedSince` gains an optional `untilIso` and only re-queues rows with `processed_at IS NOT NULL`, so the count is the number of messages actually re-queued.
- **Inactive clients:** `requestReprocess` rejects an inactive client with `CorrectionError('Client X is not in the allow-list; nothing to reprocess')`.
- **CLI options:** `reprocess <client> --since <date> [--until <date>] [--yes]`.
  - `--until` is inclusive of that IST day. Check it is on or after `--since`.
- **Preview:** add a counting function, e.g. `countReprocess(db, code, since, until)`, that returns the number without changing anything. The CLI calls it first:
  - If the count is 0, say so.
  - If the count is above 200 and `--yes` is missing, print `This would send N old messages to the AI again (about $X at most). Re-run with --yes to confirm.` and exit 0 without changes. Here X = `ceil(N / 200) * 0.5`, formatted to 2 decimals.
  - Otherwise re-queue and print the count and the cost note.

## 4. person set accepts a WhatsApp id and gives clear messages
- The `<number>` argument also accepts a jid (contains `@`). Match on `jid` exactly in that case.
- A number must contain digits after stripping `+`, spaces and dashes. Otherwise throw `CorrectionError('Give the full phone number with country code, e.g. 919812345678, or a WhatsApp id')`.
- When a person has both a LID row and a phone-number row, update every row that matches the number **or** whose jid is the matching LID. Look at how src/store/people.ts relates them. If there is no link between LID and phone-number rows in the schema, update only the matches and print how many rows changed.
- No match:
  - `No one with that number has posted in an allowed group yet` when nothing matches at all;
  - `That number has posted, but not in client X` when `--client` filtered everything out.

## 5. Friendlier task commands
- `task close` on a done task → `CorrectionError('Task X is already done')`. No change, no event.
- `task reopen` on an open task → `CorrectionError('Task X is already open')`.
- Empty strings for optional text fields (`--assigned-to ""`, `--asked-by ""`, `--latest-progress ""`) clear the field, the same as `none`. An empty `--title` stays rejected.
- `side`, `category`, `priority` and `role` values are matched case-insensitively and stored lower-case.

## 6. Handing control back to the AI
- `task unlock <code>` clears `locked_fields` and `status_locked_at`. It records a human event `unlock` and sets `rebuild_requested`.
- `phase unlock <client>` clears `phase_locked`. It records a human event and sets the rebuild flag.

## 7. Test gaps
For every command, assert the event's `op` and `detail`, and that `rebuild_requested` is set. Also cover:
- `--client` scoping in person set;
- reopening a done task (it returns to open with a status lock);
- the reprocess event (`{ since, until, messages }`);
- the inactive-client rejection;
- the preview without `--yes`.

Commit message: `fix: no duplicate tasks from reprocess, immediate transactions, safer corrections`
