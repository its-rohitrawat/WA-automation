# Task 17 amendments (controller decisions; apply on top of the task text)

Earlier amendments changed some interfaces:
- `AiCallResult` (src/brain/claudeClient.ts) has an extra field `invalidOps: number`.
- `AiOp` has `status: 'maybe_done' | 'done' | null` and OP_NAMES includes `reopen_task`.
- `MessageRow` has `requeueReason: 'edit' | 'reaction' | null`. A message marked 'reaction' or 'edit' was processed before and was put back in the queue because of a new reaction or an edit.

Changes:

1. **FakeAi** (tests/helpers/ai.ts) returns `invalidOps: 0` in its result. Allow a test to make it return a different count by passing `{ output, invalidOps }` objects in the queue, in addition to plain `AiOutput` objects and Errors.
2. **Log dropped ops:** after a successful call, when `invalidOps > 0`, log `log.warn({ clientId, batchId, invalidOps }, 'model returned invalid operations')`. Never log the content. `#callWithRetry` returns `{ output, invalidOps }` instead of just the output.
3. **Dates for re-checked messages:** for close_task, mark_maybe_done, reopen_task and log_reminder, the "last source" date is the processing date (`istDate(at)`) when the latest source message has `requeueReason` set. The original message's date would be wrong for a new reaction. add_task, add_decision and raisedOn keep using the first source message's date.
4. **add_task with status:** after createTask, when `op.status` is 'maybe_done' or 'done', call `setTaskStatus(db, t.id, op.status, <last-source date per item 3>, nowIso, 'ai')`. Include the status in the event detail.
5. **reopen_task:** `setTaskStatus(db, t.id, 'open', today, nowIso, 'ai')`, plus an event with `{ status: 'open' }`.

Extra tests (tests/brain/reconciler.test.ts):
- add_task with `status: 'done'` creates a task with status done and closedOn set;
- reopen_task on a maybe_done task makes it open with closedOn null;
- a close_task whose only batch source is a message re-queued by a reaction (store a message with an old ts, `markProcessed` it, then `upsertReaction` with ✅ so it re-queues) gets closedOn equal to today's IST date, not the message's date;
- invalidOps > 0 is logged: pass a logger whose `warn` is a spy and assert it was called with an object containing `invalidOps: 2` and no `text` field.
