# Task 17 amendments, round 3 (controller decisions from the review of b42b8ca)

Apply on top of everything already committed. Keep everything else.

## 1. Validate against fresh state, inside the transaction (Important)
The AI call can take minutes. A human correction from the CLI (a separate process) can land during it. Today the `ValidationState` is built from data read before the call, so the AI can overwrite a locked field or status. It can also overwrite a human phase or role and remove that lock.

Inside the apply transaction in `run()`, before validating:
- re-read the client (`getClient`), the open tasks (`listTasks(db, clientId, ['open','maybe_done'])`) and the people (`listPeople`);
- build the `ValidationState` from that fresh data;
- then call `validateOps`, apply the accepted ops, mark messages, and finish the batch.

Message ids and timestamps (`batchIds`, `contextIds`, `messageTs`) still come from the rows read before the call. better-sqlite3 is synchronous, so nothing can interleave inside the transaction.

Log the rejected ops after the transaction commits, as today. If the transaction throws, the existing apply_failed path still applies.

## 2. Edits and reactions that arrive during the call are not lost (Important)
Today `markProcessed` marks every batch message processed, even one that was edited or got a ✅ while the call was in flight. The AI never sees the change, and "react ✅ to close" silently fails.

**New migration v3** (src/store/migrations.ts; never edit v1 or v2):

```sql
ALTER TABLE messages ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN touch_reason TEXT CHECK (touch_reason IN ('edit','reaction'));
```

**src/store/messages.ts:**
- `MessageRow` gains `version: number`. `touch_reason` stays internal; do not add it to MessageRow.
- `applyEdit` also sets `version = version + 1, touch_reason = 'edit'` in its UPDATE.
- `upsertReaction`: when it decides the reaction is significant (non-empty emoji that is new or changed, the same condition as the re-queue), it also bumps the target row. That means `version = version + 1, touch_reason = CASE WHEN touch_reason = 'edit' THEN 'edit' ELSE 'reaction' END`, for the target message that is not revoked, whether or not it was processed. The existing re-queue of processed rows stays as it is.
- New function `markProcessedIfUnchanged(db, rows: { id: number; version: number }[], at: string): number`. It returns how many rows it skipped.
  - For each row, run `UPDATE messages SET processed_at = @at, requeue_reason = NULL, touch_reason = NULL WHERE id = @id AND version = @version`.
  - If that changed 0 rows, the message changed during the call. Leave it unprocessed and run `UPDATE messages SET requeue_reason = COALESCE(touch_reason, requeue_reason) WHERE id = @id`. The next run then shows "(re-check: edited)" or "(re-check: new reaction)", because the ops from the old version were already applied.
  - Run it inside the caller's transaction; it does not open its own.
- Keep `markProcessed` as it is, for other callers.

**src/brain/reconciler.ts:**
- Use `markProcessedIfUnchanged(db, batch.map((m) => ({ id: m.id, version: m.version })), appliedAt.toISOString())`.
- When it skipped rows, log `log.info({ clientId, batchId, requeued: n }, 'messages changed during the AI call; queued again')`. The debouncer already re-runs a client whose messages arrived during a run.

**Revoked mid-call:** at the end of the apply transaction, run `UPDATE tasks SET source_revoked = 1 WHERE client_id = ? AND source_revoked = 0 AND source_wa_id IN (SELECT wa_id FROM messages WHERE client_id = ? AND revoked = 1)`. This covers a source message deleted for everyone while the call was running.

## 3. Smaller fixes
- **Re-check date (item 3):**
  - Use `sources.some((m) => m.requeueReason !== null) ? istDate(at) : dateOf(last)` as the "last source" date for close_task, mark_maybe_done, reopen_task and log_reminder.
  - Before: only the latest source message was checked.
- **sourceQuote:** cut by code points (`[...s].slice(0, 120).join('')`), not `slice(0, 120)`.
- **Pause logging:** both paused returns (the quick check and SpendCapReachedError) log `log.info({ clientId }, 'spend cap: run paused')`.

## Tests to add
- **Fresh-state validation:** use a gated FakeAi.
  - While the call is pending, a "human" `updateTaskFields(db, ..., { title: 'Human title' }, ..., 'human')` locks the title. Release the gate with an AI `update_task` that sets the title. The title stays 'Human title' and the op is in `rejected`.
  - Same pattern for `setRole(..., 'human')` during the call, followed by an AI `set_person_role` → rejected, and role_set_by is still 'human'.
- **Edit during the call:** gated FakeAi; batch message m1. During the call, run `applyEdit` on m1. After the run:
  - m1 is still unprocessed, with requeue_reason 'edit';
  - the other batch messages are processed;
  - the outcome is ok.
- **Reaction during the call:** same pattern with `upsertReaction` ✅ on m1 → m1 unprocessed, with requeue_reason 'reaction'.
- **Edit before processing:** a message edited before it was ever processed, with no run in flight, is processed normally by the next run, and touch_reason ends up NULL. There is no false re-check marker.
- **Revoke during the call:** an add_task citing m1, where m1 is revoked during the call, ends with the task's `sourceRevoked` true.
- **Generic error:** a plain `new Error('boom')` from the AI settles at the estimate, with a detail ending `(unknown, estimated)`, and leaves no reservation.
- **Atomicity:** the existing atomicity test also asserts that the next task created afterwards is still SHA-001.
- **Store tests (tests/store/messages.test.ts):**
  - `applyEdit` and a significant `upsertReaction` bump `version`;
  - a repeated identical reaction does not bump it;
  - `markProcessedIfUnchanged` skips a row whose version changed, sets its requeue_reason from touch_reason, and returns 1.
- **Schema version:** tests/store/db.test.ts expects schema version 3.

Commit message: `fix: reconciler validates fresh state and keeps mid-call edits queued`
