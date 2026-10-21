# Task 19 amendments, round 2 (controller decisions from the review of 38f3099)

Apply these on top of task-19.md (src/output/*, tests/output/*). Item 9 touches src/util/time.ts. Keep everything else.

## 1. Sheet names never crash the build (Important)
`sanitizeSheetName`:
- Replace `: \ / ? * [ ] !` with spaces. `!` breaks exceljs's internal-link detection, so the Overview link would not jump to the tab.
- Collapse whitespace.
- Cut to 31 **code points** with `[...s].slice(0, 31).join('')`, so an emoji is never split.
- Only then strip leading and trailing spaces and apostrophes.
- If nothing is left, return `'Client'`.

`uniqueSheetNames` default reserved list: `['Overview', 'History']`. Both are compared case-insensitively, as today. When a `" (2)"` suffix is added, apply the same code-point cut and edge strip, so the result is never over 31 characters and never ends in an apostrophe.

**Stable suffixes:** assign sheet names in client **id** order, which is creation order. Adding a new client with a colliding name must never move an existing client's suffix. Tabs are still shown in name order (see item 6).

## 2. Phase progress never shows 100% early
Use `Math.floor` instead of `Math.round` for % done.

## 3. Age stops at closing
Age is `daysBetween(t.raisedOn, t.closedOn ?? today)`.

## 4. "Maybe done" beats "overdue" for colour
A maybe_done task gets the yellow fill even when past its deadline: someone has to check it. Red is only for open tasks past their deadline.

## 5. Revoked note without a quote
The Source cell shows "source message deleted by sender" whenever `sourceRevoked` is true, whether or not a quote exists. With a quote, keep the current form (the quote plus the note).

## 6. Ordering
- **Open and maybe_done tasks:** priority high → medium → low, then deadline earliest first with no deadline last, then task code.
- **Done list:** newest `closedOn` first, then code.
- **Tabs and Overview rows:** order by client name, case-insensitively (`localeCompare` with `{ sensitivity: 'base' }`).
- "Next deadline" stays as it is: the earliest deadline among open tasks, even if it has passed. The Overview's overdue count tells the rest.

## 7. Dates and percentages are real values
- **Dates:** every date column (Raised, Deadline, Closed on, Decision date, Next deadline, Last activity if it is a date) is written as a real date. Use `new Date(Date.UTC(y, m - 1, d))` from the IST `YYYY-MM-DD` string, with `numFmt = 'd mmm yyyy'`. Then Excel and Google Sheets sort and filter them correctly, and the year is visible.
- **Date-time cells** (the health line's "last update" text stays text): leave as text.
- **Percent cells:** write a number between 0 and 1 with `numFmt = '0%'`.
- **Tests:** update the tests that compare `'18 Oct'` to check the cell value as a Date (UTC midnight of that day) and the numFmt.

## 8. AutoFilter covers the data
Set the AutoFilter ref from the header row to the last data row of that table. With no data rows, keep the header only.

## 9. Faster date formatting (src/util/time.ts)
`parts()` builds a new `Intl.DateTimeFormat` on every call. Cache one formatter per option set in a module-level `Map`. No behaviour change; the existing time tests must still pass.

## 10. Small fixes
- The client tab's title row says `(inactive)` for an inactive client, as the Overview does.
- The source label renders "WhatsApp", not "Whatsapp".

## Tests to add
- **Sheet names:**
  - `"Sharma & Sons Interior Design' Studio"` → a valid name that does not end in `'`.
  - `"History"` and `"history"` → not equal to any reserved name.
  - 30 characters plus 😀 → no broken character.
  - `"Yahoo! Studio"` → no `!`.
  - Names with only forbidden characters → `'Client'`.
- **Build end to end:** clients named `"History"` and the long-apostrophe name build without throwing. Load the result back with exceljs.
- **Suffix stability:** clients A (id 1, `"Acme"`) and B (id 2, `"acme"`) give A `Acme` and B `acme (2)`. Adding C (id 3, `"ACME"`) leaves A and B unchanged.
- **Values and formatting:**
  - % done is 99% (0.99, floored) for 199 of 200 done tasks.
  - A Done task's age equals raisedOn → closedOn.
  - A maybe_done task past its deadline is yellow.
  - Open tasks follow the item-6 order.
  - The Done list is ordered by closedOn.
- **Revoked:** a revoked source with no quote shows the note.
- **Rendering:**
  - milestones ✅/🔄/⏳;
  - a Decisions row (date as a real date, text, source);
  - a People row;
  - zero clients → an Overview with the header only;
  - the injection test also covers decision text, status text and a person's name.
- **Inactive:** the inactive client's tab title contains `(inactive)`.

Commit message: `fix: safe sheet names, real dates, ordering and workbook polish`
