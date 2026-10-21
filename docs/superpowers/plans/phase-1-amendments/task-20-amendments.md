# Task 20 amendments (controller decisions; apply on top of the task text)

## 1. Say which step failed
`#publish` can fail while building the workbook or while talking to Drive. Today the log only says `err: 'Error'`, so a build bug would look like a Drive outage.

- Wrap the `build()` call so a failure carries `step: 'build'`. Drive calls carry `step: 'drive'`. For example, catch and rethrow a small `PublishError(step, cause)`, or track the current step in a local variable.
- Log `{ step, err: <name>, failures }`. Never log the error message: Google errors can echo request details.

## 2. A build failure is not retried as fast as a network failure
A build failure is almost always a bug in our code, and retrying it does not fix it. Keep the same backoff, and log it at `error` level instead of `warn`. Network and Drive failures stay at `warn`.

## Tests to add
- `build` rejecting → the log shows `step: 'build'` at error level, and the Drive API was never called.
- `updateFile` rejecting with a non-404 error → the log shows `step: 'drive'` at warn level.

## Interface notes from Task 19
- `buildWorkbook(view)` resolves a `Buffer` (the .xlsx bytes).
- `XLSX_MIME` is exported from src/output/workbook.ts.
- `loadTrackerView(db, now, health)` takes `health: { ok: boolean; text: string }`.
