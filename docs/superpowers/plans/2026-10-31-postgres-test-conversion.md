# Postgres test conversion: what it found, and how it stays found

31 October 2026. For the final review and the merge proposal of feat/saas-s1. Written by lane C from the git log, the
test:pg runs and a read-only sweep of tests/ at fb20231.

The test suite used to run on SQLite only. `npm run test:pg` now runs it against a real Postgres 17 in Docker, using the
same roles and migrations as the Mac. Converting the tests (real client ids, no raw SQLite handle, the platform tables
on the platform role) found twelve real bugs in the agent's own SQL or code. Each one would have broken
something on Postgres that SQLite let through.

## The real bugs

The fix commits are on feat/saas-s1. A "scan" is a test that reads every file in src/ and fails if the pattern comes
back.

| # | What it was | Fix commits | Guard |
|---|---|---|---|
| 1 | `SUM(<condition>)`: Postgres has no sum over a boolean. | a6ea970 (lane A), 0a18c4f (lane B) | scan tests/store/pg/sumPortable.test.ts |
| 2 | `@x IS NULL OR …` on a bare parameter: Postgres cannot type it ("could not determine data type"). It broke the voice backlog and the assistant's search. | a0e8830 (lane B), ea83071 (lane A) | scan tests/store/pg/nullParam.test.ts |
| 3 | Two-argument `MAX(a, b)` / `MIN(a, b)`: SQLite only. It broke every task reminder on Postgres. | 442ce55 (lane B) | scan tests/store/pg/minMaxPortable.test.ts |
| 4 | `COALESCE(<comparison>, 0)`: a boolean cannot meet an integer. It broke the meeting lists. | 76efa7a (lane A), 9e5f921 (lane B) | scan tests/store/pg/coalescePortable.test.ts |
| 5 | A comparison selected as a value comes back as a boolean, not 1 or 0. | 3aaac75 (lane A), 55300ca (lane B) | scan tests/store/pg/booleanValue.test.ts |
| 6 | `id IN (SELECT value FROM json_each(?))`: the values are text on Postgres, so an id never matched. Every reconcile failed before its AI call; the uptime prune too. | 3aaac75 (lane A), 6a2be88 (lane B) | scan tests/store/pg/jsonEachCast.test.ts |
| 7 | Text order and comparison followed the database's locale, not byte order as on SQLite. A prefix range missed rows. | 9710a2a (the guard: db-bootstrap makes a C database; openStore and db-migrate refuse any other), 6c90ac0 (lane B's range) | tests/store/open.test.ts, tests/store/pg/admin.test.ts |
| 8 | Health snapshots were written behind each change, unordered: on a pool an older one could land last, and `cli status` showed stale health. | 1949523 | tests/health/persistOrder.test.ts |
| 9 | The spend guard's refresh replaced its total with the database's, dropping bookings not yet written: spend under-counted, so the daily cap could be passed. | 7d79023 | tests/spend/neverUnder.test.ts (with a real open transaction) |
| 10 | Two sign-ups from one invite at once: the loser hit the users table's unique email and got a 500, not "link already used". | 1400e0b (lane C) | tests/platform/invites.test.ts (the race, a refusal never uses the invite, a failed step gives the claim back) |
| 11 | The CLI (connectAndIngest) and a relinked service closed the database before the messages already taken were stored: on Postgres the last ones were lost without a word, and the printed count was wrong. | 2ec726a | tests/cli/commands.test.ts ("stores and counts a message still being written when the wait ends, before the database closes"), tests/wa/switchableGateway.test.ts ("idle() waits for what the old gateway was storing…") |
| 12 | A relink dropped events: those still queued on the gateway it detached, and the new gateway's events from before the swap. Now the old gateway's queue drains into the handlers, and a relink follows the new gateway from its start (and stops following it when the relink is undone). | a5d9ac0 (lane A), in src/wa/switchableGateway.ts and src/wa/linkSession.ts | tests/wa/switchableGateway.test.ts (the drain, the unfollow), tests/wa/linkSession.test.ts (messages between open and the hand-over are stored; a cancelled relink stores no doubles, and nothing from a group that is not allowed; the last in d876363). Mutation-checked: with the drain off 4 fail, without follow() 1 fails. |

**The numbering** (confirmed by the coordinator, 31 Oct). The commits label bugs 1 and 4 to 10. Bugs 2 and 3 are the
IS NULL and MAX/MIN fixes, in the order they were found. json_valid is counted with bug 1: its fix is in the same
first-run commit (0a18c4f: the meeting lists decide in TypeScript, not with `json_valid` or `json_type`), and it has
no scan of its own.

Two related fixes are not numbered: the copy tool now refuses a database that already gave out ids (220ef47), and
membershipsFor orders by `created_at, tenant_id` (db60dc4).

## Tests that run on SQLite only, by design

Each has its reason written next to it. On a test:pg run they are skipped, or they use an in-memory SQLite store on
purpose.

Marked `runIf(onSqlite)`, each describe or test with its reason:
- **SQLite itself**: tests/store/db.test.ts (openDb and SQLite's migrations), tests/store/engine/sqlite.test.ts, tests/store/tx.test.ts (the file's write lock), the SQLite migration tests in tests/store/media.test.ts (3 to 5), tests/store/meetings.test.ts (7) and tests/store/reports.test.ts (v6).
- **The session files** (data/session.db and data/sender-session.db; Postgres keeps them as wa_auth rows, tested in tests/wa/authStatePg.test.ts): tests/wa/authState.test.ts, tests/wa/senderAuth.test.ts, tests/wa/senderSessionOpen.test.ts, tests/report/senderLink.test.ts, tests/report/start.test.ts (2 describes).
- **A SQLite trigger or temp trigger**, which a customer's role cannot make on Postgres: tests/control/meetingActions.test.ts (1 test), tests/report/scheduler.test.ts (1 test).
- **Process-wide timers or the SQLite file closing**: tests/report/scheduler.test.ts (2 tests).
- **Foreign keys switched off**, which Postgres never allows: tests/media/processor.test.ts (1 test).
- **The copy tool's flow** (the founder's SQLite files into a SQLite stand-in; the real server is tests/migrate/copyPg.test.ts): tests/migrate/copy.test.ts (4 describes), exportBack.test.ts, plan.test.ts (2).
- **SQLite's layouts**: tests/web/auditedWrite.test.ts ("one Db" for audit and sessions), tests/web/sessions.test.ts (only the founder's session on SQLite; the code's own defence against a session without its customer), tests/platform/invites.test.ts (ensurePlatformSchema).

Marked `runIf(!onSqlite)` or `runIf(onPg)`, Postgres only:
- tests/web/sessions.test.ts: a customer's session read back as that customer's only, and a session without its customer refused by the database.
- tests/platform/invites.test.ts: the founder's row seeded by P1.
- tests/platform/pgSchema.test.ts: the platform tables' columns as migrated.
- tests/spend/neverUnder.test.ts: refresh during a real open transaction.
- tests/migrate/copyPg.test.ts and tests/store/pg/server.test.ts: the real server.

On an in-memory SQLite store on both runs, with the reason written: the fake-timer tests in tests/output/drive.test.ts and tests/brain/meetingTracker.test.ts. They test timing; their SQL runs on Postgres in the tests around them.

## Not yet converted (read-only sweep at fb20231)

These still run on their own SQLite store even under test:pg. They were found by the sweep and are now lane C's:
- **tests/store/reports.test.ts**, the "reports store" describe: every test opens its own SQLite store (only "migration v6" above it is marked).
- **tests/cli/report.test.ts**: tracker.db by file path, plus rawOf. To be converted the way the CLI is proven on Postgres (lane A's tests/helpers/cliEnv.ts), with only the truly file-specific parts marked.

Left unmarked on purpose: **tests/store/open.test.ts** and **tests/store/pg/migrations.test.ts** run the same under both
commands, and a skip would lose coverage.

In flight elsewhere, and left out of the sweep: tests/appMedia.test.ts and tests/cli/meetings.test.ts (lane B), tests/cli/commands.test.ts (lane A), and the app* Postgres timing.

## The test:pg runs (as lane C saw them)

| When | What | Files | Tests | Time |
|---|---|---|---|---|
| First full run, 31 Oct | the whole suite, before any conversion | 81 failed, 154 passed, 6 skipped (241) | 1259 failed, 3366 passed, 108 skipped (4733) | |
| Lane C batches 1 to 5 | output, meetings, brain/control, runtime/web, routes/spend | green after bugs 3 and 6 were fixed (5 files at a time) | 111 to 196 a batch | 3 to 27 s |
| Lane C batches 6 to 8, first try | a fresh database per test | 9 failed (hook limits) | 425 passed | 95 s |
| The same, one database per file | batches 6 to 8, health, spend, platform, runtime, migrate, the 3 scans | 37 passed, 3 skipped (42), then the last 2 fixed | 551 passed, 26 skipped, 3 fixed after | 28 s |
| Bug 12, at d876363 (lane A) | lane A's test:pg run for the fix | 17 passed | 118 passed | |
| The full SQLite run, at d876363 | the whole suite under npm test | | 4,760 passed, 19 skipped, 0 failed | |

The test database container is reused between runs. Each run resets it inside the container, and nothing is written
outside it.
