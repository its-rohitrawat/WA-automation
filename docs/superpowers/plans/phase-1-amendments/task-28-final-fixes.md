# Final fixes before the pilot (controller decisions from the whole-branch review of 1ff7525)

These are small changes across modules. Keep everything else. Every item gets tests.

## 1. Replay guard covers every message the AI ever used on a task (Important)
Today a re-queued follow-up message that once produced a `log_reminder` (or update / maybe-done / close) can become evidence for a brand-new `add_task` after the original task was closed. Done tasks are not in the prompt.

- `taskSourceIds` (src/store/tasks.ts) must also include every id in `source_ids` of **all** `task_events` rows for this client where `task_id IS NOT NULL`, whatever the op or actor.
- Keep the existing members: tasks' `source_wa_id` and add_task events.
- Test (reconciler):
  1. m1 creates SHA-001.
  2. m2 logs a reminder on it.
  3. A human closes SHA-001.
  4. `requestReprocess` from m2's day.
  5. The AI returns add_task citing m2 → rejected, and there is no SHA-002.

## 2. Only edit re-checks skip the replay guard
`requeuedIds` in ValidationState becomes `editedIds`: batch messages whose `requeueReason === 'edit'`. A reaction does not change the text, so reaction re-checks are guarded like fresh messages.

Also fix the reminder rule (`fresh.every` around validator.ts:114). It must look only at the guarded ids. A reminder is rejected when every guarded batch id was already counted for that task, and there is at least one guarded id.

Tests:
- a 👍 reaction re-check on an already-counted chaser does not count the reminder again;
- an edit re-check that adds new work still creates a task.

## 3. Status-lock evidence uses the time of the new evidence
For a batch message re-queued because of a reaction, the evidence time used for the human status-lock check is the latest reaction's `ts` on that message. For an edit re-check, it is the message's `editedAt`. Otherwise it is the message's `ts`.

The reconciler builds `messageTs` that way. It already has the reactions list.

Test: a human reopens SHA-001 at T. Then the asker reacts ✅ (at T+1h) to the old delivery message (sent before T). The AI's close_task citing that message is accepted.

## 4. The last result reaches Drive at shutdown
Add `DrivePublisher.flush(timeoutMs): Promise<void>`:
- wait for the upload in flight, if any;
- then, if a publish is pending or was scheduled, run exactly one more upload;
- all within `timeoutMs`;
- then behave like `stop()`: block new runs, clear timers, leave no timer behind.

`app.stop()` calls `await publisher.flush(10_000)` instead of `publishNow()` + `stop()`.

Tests:
- an upload in flight when stop begins, plus a result applied during the drain → the uploaded workbook contains the new task;
- a hung upload → flush resolves at its timeout with 0 timers.

## 5. Lost incoming messages are visible
- **Health:** new `setIngestFailures(n: number)` stores the count. The snapshot gains `ingestFailures: number`. The `cli status` output prints `Messages not saved: N (see wa-agent.out.log)` when N > 0.
- **Health line:** after the creds-save warning and before the tracker-failing line, add `⚠️ N incoming messages could not be saved. See docs/SETUP.md.`
- **Where the count comes from:** app.ts updates it from `gateway.failedCount()` on each tick (persisted with the snapshot).
- **readHealthSnapshot:** accept a missing `ingestFailures` as 0, so older snapshots still parse.
- **SETUP.md:** add a status-table row saying these messages are lost from the tracker. Check the log, and add anything important by hand.

## 6. A deleted message refreshes the workbook
In app.ts's onEvent wrapper, call `publisher.schedule()` after a `revoke` event for an allowed client has been ingested. The "source message deleted by sender" note then appears without waiting.

Test: a revoke of a task's source message triggers an upload, and that workbook shows the note.

## 7. Context for a reprocess window comes from before the window
`listRecentProcessed(db, clientId, limit, beforeTs?)` returns the latest processed messages with `ts < beforeTs` when given. The reconciler passes the first batch message's `ts`.

Test: with processed messages before and after a re-queued window, the context holds only the earlier ones.

## 8. In-flight calls are booked at shutdown
Add `SpendGuard.settlePending(detail: string): number`. It records each still-pending reservation's estimate as spend, with `detail`, clears them, and returns the count.

`app.stop()` calls `spend.settlePending('shutdown before the AI call finished (estimated)')` after the drain. If the drain finished cleanly there is nothing pending, and it records nothing.

Tests:
- spend: settlePending records pending estimates;
- app: a hung AI call at stop is booked at its estimate.

## 9. Logged-out advice points to the safe procedure
The health line for logged_out becomes `❌ WhatsApp unlinked since <time>. Follow docs/SETUP.md → "Status logged_out".`

Update the health and app tests, and the SETUP.md status table row.

## 10. Logger hardening
Add these keys to the logger's redaction list, at the top level and one level deep: `name`, `pushName`, `number`, `phone`, `jid`, `token`, `refreshToken`, `refresh_token`, `accessToken`, `access_token`, `apiKey`, `secret`, `password`.

Check that no current log call relies on logging those keys. grep `log\.` in src. `clientId`/`batchId`/`count` style keys stay visible.

Test: logging `{ jid: 'x', token: 'y', clientId: 1 }` shows `[REDACTED]` (or whatever censor the logger uses) for jid and token, and keeps clientId.

## 11. SETUP.md wording
- The reprocess note says it will not re-create tasks you closed, and will not count reminders or decisions twice. It cannot add a missed second task from a message that already produced a task.
- Mention that config errors exit with code 1 and refusals with code 2. Either way WinSW restarts the service and err.log shows one line.

Commit as one or more commits, e.g. `fix: replay guard covers all task evidence; shutdown flush and spend booking; visible ingest failures`, each ending with the Co-Authored-By line.
