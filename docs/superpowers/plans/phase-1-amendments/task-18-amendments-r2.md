# Task 18 amendments, round 2 (controller decisions from the review of e6cbb06)

Apply on top of task-18.md (src/brain/debouncer.ts, tests/brain/debouncer.test.ts). The last item changes src/brain/reconciler.ts. Keep everything else.

## 1. A throwing onError never skips the retry or crashes the process
In the rejection path, call `this.#scheduleRetry(clientId)` first. Then call the callback inside `try { this.#onError?.(clientId, err); } catch { /* the callback must not break scheduling */ }`.

## 2. A synchronous throw from `run` cannot wedge a client
Start the run with `Promise.resolve().then(() => this.#run(clientId))`. A synchronous throw then becomes a rejection, and the normal `finally` / rejection path releases the slot and schedules the retry.

## 3. Back off after repeated failures
A batch that keeps failing (refusal, invalid output, apply_failed, network) must not be re-sent, and paid for, on every new message.

- Keep a per-client `failures` count:
  - `failed` outcomes and rejections add 1;
  - `ok` and `noop` reset it to 0;
  - `paused` leaves it unchanged, because the spend check costs nothing.
- Add `export const FAILURES_BEFORE_BACKOFF = 3;`.
- `notify(clientId)`: when `failures >= FAILURES_BEFORE_BACKOFF` and a retry is pending, do not arm the quiet or max timers. The pending hourly retry will pick the new messages up. A client that is running still gets its dirty flag as today.

## 4. `cancel(clientId)` for clients removed from the allow-list
Add a `cancel(clientId)` method that:
- clears that client's quiet, max and retry timers;
- removes it from the queue;
- drops its dirty flag.

If the client is running, the in-flight run finishes, but no follow-up and no retry is scheduled for it. Track a `cancelled` flag on its state that is checked in the `finally`. A later `notify` or `ensure` for that client starts fresh, which is useful if the group is added back.

## 5. `drain(timeoutMs)` for clean shutdown
`async drain(timeoutMs: number): Promise<void>` resolves once no run is in flight (`#active === 0`) or after `timeoutMs`, whichever comes first. Do not leave a timer behind: clear the timeout when the runs finish first. It does not start anything. Call it after `stop()`. Shutting down mid-call today discards a paid result: the messages are re-sent on restart and the spend reservation is never booked.

## 6. The reconciler skips inactive clients (src/brain/reconciler.ts)
At the top of `Reconciler.run`, after `getClient`, add `if (!client.active) return { status: 'noop' };`. A group removed from the allow-list must never be sent to Claude, even if a timer was already pending.

## Tests to add
- `onError` that throws → the retry is still scheduled (the run happens again after retryMs) and nothing is left unhandled. Use `process.on('unhandledRejection')` or vitest's handling to assert none occurred.
- `run` that throws synchronously, with `maxConcurrent: 1` → another client still runs, and the throwing client is retried after retryMs.
- A `paused` outcome retries after retryMs.
- `ensure()` while a retry is pending does not run early.
- A notify during the retry window runs once after the quiet period, and not again when the old retry time passes.
- `stop()` during a gated run, followed by a failed outcome → 0 timers (`vi.getTimerCount()`) and no further runs.
- Backoff:
  - after 3 failed runs, a notify does not trigger a run before the retry fires;
  - when the retry run returns ok, the next notify runs after the quiet period as normal.
- `cancel()`:
  - with a pending quiet timer → no run;
  - during a running run that then fails → no retry;
  - a later `notify` works.
- `drain()`:
  - resolves after a gated run finishes;
  - resolves at the timeout if the run never finishes (fake timers);
  - leaves no timer behind.
- The existing concurrency test also asserts FIFO: the 4th run is client 4.
- Reconciler: an inactive client returns `{ status: 'noop' }` and the AI is not called. Use `setStatus`, or update `clients.active` directly in the test DB, whichever the store supports.

Commit message: `fix: debouncer survives callback errors, backs off, cancels and drains`
