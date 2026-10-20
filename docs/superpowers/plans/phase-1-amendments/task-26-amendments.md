# Task 26 amendments (controller decisions; apply on top of the task text)

Earlier amendments changed some interfaces:
- `MessageRow` has `requeueReason: 'edit' | 'reaction' | null`. Add `requeueReason: null` to the `msg()` factory in tests/golden/cases.ts.
- `AiOp` has `status` and OP_NAMES includes `reopen_task`. `Expectation.op` already uses `AiOp['op']`, so no change is needed there.
- `ClaudeClient.reconcile` returns `invalidOps`. The script prints `invalid ops: N` per case when N > 0. This is informational and does not count as a failure.

Add a fourth golden case:

- **name:** 'client rejects a reported delivery'
- **open tasks:** SHA-012 'Revise homepage banner' with status 'maybe_done'. Give the `task()` factory an optional status parameter.
- **batch:** g8 from Mr. Sharma at 13:00: "Dekha, abhi bhi dark hai. Thoda aur bright karo."
- **expect:** `[{ op: 'reopen_task', taskCode: 'SHA-012' }]`
- **forbid:** `[{ op: 'close_task', taskCode: 'SHA-012' }, { op: 'add_task', side: 'us' }]`

Update the dry-run expectation text: there are now 4 cases.
