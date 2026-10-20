# Task 14 amendments, round 2 (controller decisions from the review of 83be158)

Apply these on top of task-14.md and task-14-amendments.md (src/brain/validator.ts, tests/brain/validator.test.ts). Keep everything else.

## 1. One reminder and one add_task per piece of work, per response
- **log_reminder:** keep a `Set` of task codes that already have an accepted log_reminder in this response. Reject a repeat with `'duplicate reminder in one response'`.
- **add_task:** the key is `side` + title, lower-cased with whitespace runs collapsed to one space and the ends trimmed. Keep a `Set` of these keys for accepted add_tasks. Reject a repeat with `'duplicate task in one response'`.

## 2. Length limits on every free-text task field
Add one constant table, checked in **both** add_task and update_task **before** locked fields are stripped:

```ts
const MAX_LEN = { title: 200, assignedTo: 80, askedBy: 80, latestProgress: 600 } as const;
```

- Count code points (`[...s].length`), not UTF-16 units.
- A non-null field over its limit rejects the op with `'field too long'`.
- Use this table in place of the existing title check. The add_task title-missing case keeps its existing reason.
- Keep the existing 600 limit for `text` (add_decision / set_status) as it is.
- `reason`: do not reject. Cut it to 300 code points on the accepted op.

## 3. Status ops: the last one per task wins
- close_task, mark_maybe_done and reopen_task are status ops. When several status ops for the same task are accepted in one response, keep only the last one.
- Earlier ones go to `rejected` with `'superseded by a later operation'`.
- Do the same for the existing keep-last set_status: superseded set_status ops now also appear in `rejected` with that reason, so `accepted.length + rejected.length` always equals the number of input ops.
- Keep the accepted ops in their original relative order.

## 4. Source ids are de-duplicated
After normalising and filtering, remove duplicates and keep first-seen order: `[...new Set(ids)]`.

## 5. Task codes must belong to this client
For every task op, if `taskCode` does not start with `` `${clientCode}-` `` reject with `'task belongs to another client'` before the lookup. Use the existing `clientCode` from the validation state.

## Tests to add (one `expect` each where possible)
- Two log_reminder ops for SHA-001 in one response → first accepted, second `'duplicate reminder in one response'`. A reminder for a different task in the same response is accepted.
- Two add_task ops, side us, titles `Revise  Banner` and `revise banner` → second rejected `'duplicate task in one response'`. Same title with side client → accepted.
- `'field too long'` for each of these:
  - add_task with a 201-code-point title;
  - add_task with an 81-character assignedTo;
  - update_task with a 201-character title;
  - update_task with a 601-character latestProgress.

  A 200-code-point title made of emoji, which is over 200 UTF-16 units, is accepted.
- A 400-character reason is accepted and cut to 300.
- `[close_task SHA-001, mark_maybe_done SHA-001]` on an open task → only mark_maybe_done accepted; close_task rejected `'superseded by a later operation'`. Two set_status ops → the first is in `rejected` with the same reason. Also assert `accepted.length + rejected.length === input length`.
- Source ids `['n1', '[n1]', 'm:n1']` → accepted with `['n1']`.
- `close_task` with `taskCode: 'MEH-001'` while the client code is SHA → `'task belongs to another client'`.
- The untested existing paths:
  - `'task already maybe done'` (mark_maybe_done on a maybe_done task);
  - `'text missing or too long'` for add_decision with null text and for set_status with 601 characters;
  - `'unknown person or missing role'` (set_person_role for a jid not in the people list);
  - `'role was set by a human or is the founder'` with roleSetBy `'human'`;
  - an accepted log_reminder on an open task.

Commit message: `fix: validator blocks duplicates, long fields and cross-client codes`
