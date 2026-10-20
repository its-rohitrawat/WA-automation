# Task 21 amendments (controller decisions; apply on top of the task text)

## Show "paused" whenever the reconciler is paused
The reconciler returns `{ status: 'paused' }` whenever the budget left today is smaller than one call's ceiling estimate (about $0.32–0.50). Spend almost never lands exactly on the cap, so `spend.isPaused()` alone would leave the line green all evening while every client is paused.

- Keep a `#paused = new Set<number>()` next to `#failed`.
- `recordOutcome`:
  - On `'paused'`, add the client to `#paused` and leave `#failed` unchanged.
  - On any other status, remove the client from `#paused`. The existing `#failed` handling stays as it is.
- `line()`: show the cap message when `this.#spend.isPaused() || this.#paused.size > 0`, at the same priority as today, with the same text.
- The snapshot and the `cli status` output follow automatically from `line()`.

Tests to add:
- `recordOutcome(1, { status: 'paused' })` while `spentToday()` is below the cap shows the cap message.
- A later `recordOutcome(1, { status: 'ok', ... })` clears it.

## Interface notes (from Tasks 15–17)
- `ReconcileOutcome` failure codes include 'refusal', 'invalid_output', 'timeout', 'network', 'api_<status>', 'apply_failed' and 'unknown'. 'spend_cap' never reaches Health, because the reconciler returns paused instead.
- `SpendGuard` has `isPaused()`, `spentToday()` and the `capUsd` getter as before. Reservations are internal to it.
