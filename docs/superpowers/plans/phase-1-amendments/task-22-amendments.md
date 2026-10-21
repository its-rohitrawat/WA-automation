# Task 22 amendments (controller decisions; apply on top of the task text)

These changes come from the reviews of Tasks 17 and 18.

1. **onError never throws.** Log `{ clientId, err }`, the error object itself. The logger's serializer keeps the type, code and stack, drops the message, and copes with non-Error values. Do not log `err.name` as a string; that loses the type. Keep the `health.recordOutcome(clientId, { status: 'failed', errorCode: 'crash' })` call.
2. **Stop waits for paid calls in flight.** `stop()` runs these steps in order:
   1. `clearInterval(poll)`
   2. `debouncer.stop()`
   3. `await debouncer.drain(d.drainMs ?? 120_000)`
   4. `await publisher.stop(10_000)` (it is async now, see task-20-amendments-r2.md; 10 s keeps the whole stop inside the service's 150 s stop timeout)
   5. `await d.gateway.stop()`

   `drainMs` is a new optional dependency, for tests. Without the drain step, a result we already paid for is thrown away, so the messages are sent and paid for again on restart.
3. **Removed groups are cancelled.** In `reloadClients(configs)`, collect the ids of clients that were active before `syncClients` (use `listClients(d.db)`). After syncing, call `debouncer.cancel(id)` for each id that is no longer active. The reconciler also returns noop for inactive clients, as a second guard.
4. **`onNewMessages` fires for edits and non-empty reactions too**, not only new messages (src/wa/ingest.ts). Keep wiring it to `debouncer.notify`. Edits and reactions that land during an AI call leave messages queued and need that follow-up run. Do not rename it in this task.
5. **Other interfaces that changed since the task text was written:**
   - `ClaudeClient` takes `prices` (Task 23 builds it).
   - `ReconcileOutcome` failure codes are 'refusal', 'invalid_output', 'timeout', 'network', 'api_<status>', 'apply_failed' and 'unknown'.
   - `Health` keeps a paused set (task-21-amendments.md).
   - `FakeAi` results carry `costUsd` and `fallbackUsed`.

Tests to add (tests/app.test.ts):
- **Stop waits for the call:** a gated FakeAi run in flight. `app.stop()` does not resolve until the gate is released (or until `drainMs` passes, in a second test with a small drainMs).
- **Removed group is cancelled:** after `reloadClients` removes a client that had a pending quiet timer, advancing the timers does not call the AI.
- In "Removed group is cancelled", also assert that the debouncer's `run` wrapper was never called for that client. Spy on `reconciler.run`, or check that `vi.getTimerCount()` dropped. The reconciler's own inactive check would hide a missing `cancel()` wiring.
- `drainMs` defaults to 120_000. Task 27 sets the WinSW `stoptimeout` to 150 sec, so drain (120 s) plus publisher stop (10 s) plus gateway stop fit inside it.

## From the Task 20 review
- **Publisher failures reach Health:** wire `onFailure: (f) => health.markPublishFailed(f)` and keep `onPublished: () => health.markPublished()` (see task-21-amendments.md).
- **Interfaces:**
  - `DrivePublisher.stop()` is async.
  - `TokenStore.load()` can throw `TokenDecryptError`; Task 23 handles it.
  - `DriveAuthError` is exported from src/output/drive.ts.
