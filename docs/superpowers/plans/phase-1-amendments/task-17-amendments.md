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

---

## Round 2 (from the Task 15 review): reserve before paying, settle every outcome

`SpendGuard` now has `reserve(estimate): number | null`, `settle(id, kind, usd, detail)` and `release(id)`, and `canSpend` counts reservations. `ClaudeClient` exports `MAX_OUTPUT_TOKENS` and `SDK_MAX_RETRIES`, and results and AI errors carry `costUsd` (fallback attempts are already priced in). Changes:

6. **Estimate:** `const estimate = estimateCostUsd(SYSTEM_PROMPT.length + user.length, prices, MAX_OUTPUT_TOKENS)`. `run()` keeps the quick `if (!spend.canSpend(estimate)) return { status: 'paused' }` before `startBatch`.
   - Known and accepted: a call that falls back can cost up to about 2.25× its reservation, because a declined primary attempt is followed by a full fallback attempt at 1.25× rates. `settle` records the true `costUsd`, so the books stay right. The cap can be overshot only by that gap per call in flight.
   - Put this note in a comment above the estimate line.
7. **`#callWithRetry(user, batchId, estimate)`:** every attempt, including the retry after invalid output, starts with `const rid = spend.reserve(estimate)`. If that returns null, it throws `new SpendCapReachedError()` (a small exported class in reconciler.ts). Only `await ai.reconcile(...)` sits inside the try. Settling happens outside the classification logic:
   - **success:** `spend.settle(rid, 'ai', r.costUsd, `batch ${batchId}` + (r.fallbackUsed ? ' (fallback)' : ''))`, then return `{ output, invalidOps }`;
   - **AiRefusalError / AiInvalidOutputError:** `settle(rid, 'ai', e.costUsd ?? estimate, `batch ${batchId} (failed)`)`;
   - **`Anthropic.APIConnectionError`, including its subclass `APIConnectionTimeoutError`:** check this before `APIError`, because it is a subclass of `APIError`.
     - If the error's cause chain shows the request never left the machine, call `release(rid)`. Walk `.cause` up to 4 levels and look for a string `code` in `NEVER_SENT = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'])`.
     - Otherwise the outcome is unknown. A connection reset after sending, or a timeout, may have been billed, and the SDK may have made up to `SDK_MAX_RETRIES + 1` attempts. Call `settle(rid, 'ai', estimate * (SDK_MAX_RETRIES + 1), `batch ${batchId} (connection lost, estimated)`)`.
   - **any other `Anthropic.APIError`:** the server answered with an HTTP error status, so nothing was billed. Call `release(rid)`.
   - **any other error:** call `settle(rid, 'ai', estimate, `batch ${batchId} (unknown, estimated)`)`.

   Then retry once on AiInvalidOutputError at attempt 0; otherwise rethrow.
8. **`errorCodeOf`:** check `SpendCapReachedError` → `'spend_cap'` and `Anthropic.APIConnectionTimeoutError` → `'timeout'` before the APIConnectionError check.
9. **FakeAi:** results carry `costUsd: 0.01` and `fallbackUsed: false` by default. Queue objects `{ output, invalidOps?, costUsd?, fallbackUsed? }` override them. Thrown AI errors carry whatever `costUsd` the test gave them.
10. **Hitting the cap mid-run counts as paused:** when `#callWithRetry` throws `SpendCapReachedError`, `run()` still finishes the batch as failed with errorCode `'spend_cap'`, but returns `{ status: 'paused' }`, so the health line says "paused" and not "AI error".
11. **Reservations expire (src/spend/spendGuard.ts):**
    - Store the clock time with each reservation.
    - The pending total ignores reservations older than 45 minutes (600 s × 3 attempts, plus margin).
    - Add one test in tests/spend/spend.test.ts: a reservation made at T no longer counts at T + 46 minutes.
    - This is a safety net only; every reconciler path settles or releases.

Extra tests:
- **Parallel runs:** cap set so only one estimate fits; FakeAi's reconcile awaits a promise the test resolves. Start `run(SHARMA)` and `run(MEHTA)` without awaiting. The second resolves `{ status: 'paused' }` and the first then completes ok.
- **Retry blocked by the cap:** the first call returns AiInvalidOutputError with a `costUsd` large enough that the retry's reservation no longer fits. The outcome is `{ status: 'paused' }`, the batch row says failed / `'spend_cap'`, and the AI was called once.
- **Timeout:** an `APIConnectionTimeoutError` gives errorCode `'timeout'`. `spentToday()` equals estimate × (SDK_MAX_RETRIES + 1).
- **Connection reset:** an `APIConnectionError` whose cause has `code: 'ECONNRESET'` gives errorCode `'network'` and is settled at estimate × 3.
- **Never sent:** an `APIConnectionError` with cause `{ cause: { code: 'ENOTFOUND' } }` (nested, like Node's fetch errors) records nothing.
- **Server error:** an `Anthropic.APIError` with status 500 records nothing (`spentToday()` 0).
- **No leftover reservation:** after the success, refusal, invalid-output, timeout, never-sent and server-error tests, `spend.reserve(cap - spentToday())` succeeds.
- **Fallback:** a result with `fallbackUsed: true` is recorded with a detail ending in `(fallback)` (read the `spend` table).
