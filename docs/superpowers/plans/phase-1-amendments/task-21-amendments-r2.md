# Task 21 amendments, round 2 (controller decisions from the review of d571275)

Apply on top of task-21.md and task-21-amendments.md (src/health/health.ts, tests/health/health.test.ts). Item 5 touches src/wa/gateway.ts and tests/wa/gateway.test.ts. Keep everything else.

## 1. A separate line for the uploaded workbook
The workbook is built right before an upload. If the upload succeeds, publishing works, so a "sign-in expired" or "tracker update failing" line inside that file is always a false alarm, and it would stay until the next publish.

Add `workbookLine(): HealthLine`. It is the same as `line()` but skips the publish-failure branch. `line()` itself is unchanged and is used by `cli status` and the snapshot. Task 22 passes `health.workbookLine()` to `loadTrackerView`.

## 2. `forget(clientId)` for removed groups
Add `forget(clientId)`. It deletes the client from both `#failed` and `#paused`. Task 22's `reloadClients` calls it for every client that became inactive, next to `debouncer.cancel`. Without it, "1 group waiting (AI error)" stays until a restart, because a removed client is never run again.

## 3. Every ❌ before every ⚠️
Move the "❌ Google sign-in expired" check above the "⚠️ The WhatsApp session could not be saved" check. The order becomes:
1. terminal WhatsApp states (unlinked / replaced / forbidden);
2. disconnected for more than 30 minutes;
3. sign-in expired;
4. creds save failures;
5. tracker update failing for more than 60 minutes;
6. spend cap / paused;
7. failed groups;
8. low disk;
9. green.

## 4. Paused entries expire at midnight IST
Store the IST day with each paused entry, as a `Map<number, string>`. `line()` and the snapshot ignore entries from an earlier IST day, so "Paused until midnight IST" disappears at midnight without waiting for the next run.

## 5. The creds-save warning clears after a good save (src/wa/gateway.ts)
When `saveCreds` succeeds after one or more failures, reset `#credsSaveFailures` to 0 and emit the status once. Add a gateway test: one rejected save, then a successful save → the emitted status has `credsSaveFailures: 0`.

## 6. `readHealthSnapshot` never throws
Wrap the parse in try/catch. Return `undefined` when the JSON is malformed or the shape is wrong. At minimum, `at` must be a string and `line.text` must be a string. The CLI then prints its "no report yet" text.

## 7. Keep `publishFailingSince`
Keep it in the snapshot. Task 24 prints it, and its fixture gains the field (see task-24-amendments.md).

## Tests to add
- `workbookLine()`:
  - after an auth failure, it is green while `line()` shows the sign-in line;
  - after a drive failure longer than 60 minutes, it is green while `line()` shows the failing line.
- `forget(1)` after a failed outcome → green. Same after a paused outcome.
- Priority: with creds save failures > 0 and an auth publish failure at the same time, the sign-in ❌ line wins.
- A paused outcome at 23:50 IST → the cap line shows. At 00:01 IST the next day, with spend below the cap, the line is green.
- An auth failure followed by a non-auth failure → no sign-in line. The latest failure decides.
- Failed, then paused, for the same client → after the IST day changes, the failed-groups line still shows, because `#failed` was kept.
- `readHealthSnapshot`:
  - malformed JSON → `undefined`;
  - `{}` → `undefined`;
  - a valid snapshot round-trips, including `publishFailingSince`.
- Gateway: the creds-save counter resets after a successful save, as described in item 5.

Commit message: `fix: health workbook line, forget removed groups, clearer priorities`
