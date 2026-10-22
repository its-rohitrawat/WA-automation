# Task 14 amendments (controller decisions; apply on top of the task text)

Since Task 13 was amended, `AiOp` (src/brain/schema.ts) has an extra field `status: 'maybe_done' | 'done' | null`, and OP_NAMES includes `reopen_task`. `tests/helpers/ai.ts` `op()` already sets `status: null`.

Change the validator as follows (src/brain/validator.ts), keeping everything else from the task text:

1. **Unknown source ids are dropped, not fatal.** After normalising ids, filter `sourceMessageIds` to ids present in `batchIds` or `contextIds`. Then: if none remain, reject with `'no source messages'`; if none of the remaining ids is in `batchIds`, reject with `'no evidence from new messages'`. The accepted op carries the filtered ids. (The model sometimes cites an old `source [..]` id; that must not discard an otherwise good operation.) Remove the `'unknown source message id'` rejection.
2. **`reopen_task`** is a task operation (add it to TASK_OPS). It is accepted only when the task's status is `'maybe_done'`; otherwise reject with `'only a maybe-done task can be reopened'`. The human status-lock rule applies exactly as for close_task/mark_maybe_done: if `statusLockedAt` is set, at least one batch source id must have a message timestamp later than it, otherwise reject with `'status was set by a human; needs newer evidence'`.
3. **`add_task` with `status`** ('maybe_done' or 'done') is allowed; no extra checks.

Test changes (tests/brain/validator.test.ts):
- The existing case `addTask({ sourceMessageIds: ['n1', 'zz'] })` is now **accepted** with `sourceMessageIds` `['n1']` (replace the old expectation). `['zz']` alone gives `'no source messages'`.
- reopen_task on an open task → `'only a maybe-done task can be reopened'`; on a maybe_done task → accepted; on a maybe_done task with `statusLockedAt` later than n1 and citing only n1 → `'status was set by a human; needs newer evidence'`.
- add_task with `status: 'done'` is accepted.
