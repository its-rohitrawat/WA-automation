# Phase 2c (Morning Report) Implementation Plan

**Goal:** Every day at 06:00 IST, Sundays included, the founder receives one WhatsApp message from a spare number the business owns. Per active client it gives the open and overdue counts and up to 3 most urgent open tasks (tagged `us` or `client`), then a totals line with the "Built ... IST" time, and it attaches the current tracker as `Tracker-YYYY-MM-DD.xlsx`. A missed 06:00 is caught up until 12:00 IST; after that the day is skipped. At most one report per IST date. No AI calls, so no spend. The founder-number reader stays passive, with no send method.

**Architecture:** Migration v6 adds a `reports` table with one row per IST date. `ReportScheduler.tick(now)` runs from the app's existing 30-second tick. Inside the 06:00-12:00 window it claims today's row (status `sending`) with one atomic upsert before anything is sent, builds the text (`buildMorningText`) and the workbook (the existing `loadTrackerView` and `buildWorkbook`), and hands both to a `ReportSender`. `SenderGateway` implements `ReportSender` with a second Baileys session on the spare number, stored in `data/sender-session.db` under its own HKDF subkey (`whatsapp-sender-session`) of the DPAPI master key. It connects only for a send, sends the text and then the document to `REPORT_RECIPIENT` (fixed when it is made), and disconnects. A definite failure before sending becomes `retry` (waits of 2, 5, then 10 minutes); anything after the send started becomes `unknown` and is never retried automatically. At service start a row still `sending` becomes `unknown`. After the deadline a day without a sent row becomes `skipped`. Health and `cli status` gain a morning-report line. The CLI gains `link-sender`, `report status` and `report send-now`.

**Tech Stack:** Node.js 24 (type stripping, erasable TypeScript only), TypeScript 7 (type-check only), vitest 5, Baileys 7.0.0-rc14 (a second `makeWASocket` and `sendMessage` with text and document content), better-sqlite3 13 (schema v6), zod 4.6.7 (settings), exceljs 4.4 through the existing `buildWorkbook`, commander 15, qrcode-terminal. No new dependencies.

> **For agentic workers:** use superpowers:subagent-driven-development to implement this plan task by task (superpowers:executing-plans also works). Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-10-23-morning-report-design.md` (approved 2026-10-23, binding). It amends `2026-10-19-wa-agent-design.md`: the founder's number still never sends.

---

## Ground rules

1. **No WhatsApp sends, no network, no paid calls.** Tests use fakes only (`FakeSocket`, `FakeReportSender`, `FakeDrive`, `FakeAi`) and files made in the test. Do not run the CLI, `src/main.ts` or `scripts/golden.ts`. Never read or print `.env`.
2. **No AI spend.** The morning report is built from the tracker database only. Nothing under `src/report/` imports from `src/brain/` or uses `SpendGuard`.
3. **The founder-number reader keeps no send method.** Do not add send-type methods to `WhatsAppGateway` or `SocketLike` in `src/wa/gateway.ts`. The existing tests "never calls a send-type socket method" and "exposes no send-type methods" stay as they are.
4. **The sender may message only `REPORT_RECIPIENT`.** The recipient is fixed when `SenderGateway` is made; `sendReport(text, xlsx, fileName)` takes no recipient; `checkRecipient` guards the one `sendMessage` call. Only `src/wa/senderGateway.ts` may name a Baileys send method (`tests/wa/sendScan.test.ts` enforces it). No groups, no clients, no team members, no presence, no read receipts.
5. **Claim before send.** No send happens without a successful `claimReport`. If the claim fails, nothing is sent.
6. **Never retry an unknown outcome.** Once the first `sendMessage` has started, any failure is `unknown`. Only the owner's `report send-now`, after checking the founder's phone, sends that day again.
7. **Migrations.** Add version 6 only, and only additive SQL. Never edit, re-run or reorder versions 1 to 5 (a hash test guards them).
8. **Personal data and secrets.** `REPORT_RECIPIENT` is never logged or printed in full; use `maskNumber` (last 4 digits). Logs carry dates, counts and reason codes, never message text. The spare number's session is encrypted like the founder's.
9. **Node 24 type stripping: erasable TypeScript only.** No `enum`, `namespace` or constructor parameter properties. Use `#private` fields. Relative imports end in `.ts`. Type-only imports use `import type`.
10. **Running tests on this PC.** Run from an uppercase working directory: Git Bash `cd /c/Users/Dell/Desktop/WA_agent`, or PowerShell `Set-Location 'C:\Users\Dell\Desktop\WA_agent'`. A lowercase `c:\` makes Vitest load twice.
11. **Branch and commits.** Work on `feat/phase-2c-morning-report`. Commit after every task, staging only the files the task names. End every commit message with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push, amend, reset or switch branches.
12. **Known flake.** Under full-suite load, one test in `tests/appMedia.test.ts` can time out in `vi.waitFor` on this PC. It happens on the unchanged branch too. If that file is the only failure, run `npx vitest run tests/appMedia.test.ts` alone; it must pass.
13. **This code was compiled and its tests run** against a copy of this branch (all files type-check; every new and existing test passed). If something still fails, make the smallest change that fixes it and report every deviation.

## Decisions

1. **`report send-now` goes through the running service; the CLI never opens the spare number's session to send.**
   - The CLI checks, asks for typed confirmation, then stores today's date under the kv key `report_send_requested`. The service's next tick (within 30 s) takes the request once and makes a forced claim.
   - Why: only one process (the service) ever uses the spare number's session, so two sockets never fight over it ("replaced"), and a row still `sending` at service start can only be a send cut off by a crash or a stop. That makes "sending becomes unknown at start" safe.
   - The CLI refuses when the service has not reported in the last 2 minutes (the same freshness rule as `cli status`), when today is already `sent` or `sending`, and when the report is off.
   - `link-sender` is the only CLI command that opens the spare session, and it takes the single-instance lock, so the service must be stopped (spec §6 step 3).
2. **Two messages: the text, then the document.** Not one document with a caption: captions are short and do not show in full in the notification. Once the first message has started, any failure is `unknown`, because the founder may already have part of the report. The row records both WhatsApp message ids as `id1,id2`.
3. **Retry waits and attempts.** `attempts` counts claims. After a definite failure the next try is 2 minutes later, then 5, then 10 minutes for every later try, until the deadline. A forced claim (`send-now`) ignores the window and the wait, and takes a `retry`, `unknown` or `skipped` row, never a `sent` or `sending` one.
4. **An `unknown` row stays `unknown` after 12:00.** Spec §4 step 7 turns "a day with no sent row" into `skipped`. That is applied to days with no row and to `retry` rows. An `unknown` row is kept as it is, so the "check WhatsApp" warning is not hidden; it clears the next day. `retry` rows of earlier days (the service stopped before their deadline) become `skipped` on the next tick and keep their reason.
5. **Sender session store.** The same encrypted store as the founder's session (`useEncryptedAuthState`), keyed by `deriveSubkey(master, 'whatsapp-sender-session')`, in its own file `data/sender-session.db`. Neither key opens the other's file. A missing or unreadable spare session never stops the service: each day's report fails as `not_linked` until the deadline and is then skipped, and Health tells the owner to run `link-sender`.
6. **Sender connection.** Connects only for a send: 60 s to open, 120 s per message (the document upload is part of it), then stays open 15 s for WhatsApp's acks and the founder phone's retry requests, then disconnects. `markOnlineOnConnect: false` (Baileys announces "unavailable"), no history sync, `enableRecentMessageCache: true` (it holds only this socket's own outgoing report, so a retry request can be answered). It listens only to `creds.update` and `connection.update`, so it never reads chats. A QR code during a send means the session is no longer valid: the send fails as `not_linked` and nothing is printed.
7. **Health.** The report adds a warning to the main health line only when the owner must act: an `unknown` outcome, or a spare number that is not linked, logged out, refused (403) or replaced. It ranks after the shared-file lines and before low disk. Every other state shows only on the new `Report:` line of `cli status` and in `report status`. The workbook's health line can therefore show the report warning too.
8. **Settings.** `REPORT_ENABLED` must be exactly `true` or `false`; empty means off. `REPORT_TIME` and `REPORT_DEADLINE` are `HH:MM` IST, default 06:00 and 12:00, and the time must be earlier than the deadline. `REPORT_RECIPIENT` is 8 to 15 digits and is required when the report is on. All four are empty in `.env.example`. A bad value fails startup with the variable name only, never its value.
9. **Message text.** Plain text with WhatsApp bold for client names. For example:

   ```text
   Morning report · 23 Oct

   *Mehta Foods*: no open tasks

   *Sharma Interiors*: 5 open, 2 overdue
   • [client] SHA-005 Approve sitemap (due 21 Oct, overdue)
   • [client] SHA-002 Send logo files (due 20 Oct, overdue)
   • [us] SHA-003 Write about page (due today)

   Total: 5 open, 2 overdue · Built 23 Oct 06:00 IST
   ```

   "Open" means not done, as in the workbook (it includes "maybe done", which is noted). Titles are flattened to one line and cut at 70 characters, at a space when one is near the end, never inside an emoji.
10. **No new dependencies.** QR printing reuses `qrcode-terminal`; the workbook reuses `buildWorkbook`; the MIME type reuses `XLSX_MIME`.

## File map

```
src/
  report/
    types.ts            ReportSettings, SendResult, SenderState, SenderStatus, ReportSender, ReportHealth
    morningReport.ts    buildMorningText(view, today): the WhatsApp text, from the tracker view only
    scheduler.ts        ReportScheduler (recover, tick, health, stop), describeReport, retryWaitMs, reason texts
  store/reports.ts      reports table: claimReport, finishReport, retryReport, skipReport, markInterruptedReports, closeOldRetries, reportFor, recentReports
  wa/senderGateway.ts   SenderGateway (sendReport, status, stop), linkSender, baileysSenderSocketFactory, recipientJid, checkRecipient
tests/
  helpers/fakeReportSender.ts
  store/reports.test.ts, report/morningReport.test.ts, report/scheduler.test.ts
  wa/senderAuth.test.ts, wa/senderGateway.test.ts, wa/sendScan.test.ts
  health/healthReport.test.ts, appReport.test.ts, cli/report.test.ts, docs/setup.test.ts
```

Modified: `src/store/migrations.ts`, `src/config/env.ts`, `src/config/paths.ts`, `src/crypto/keyProvider.ts`, `src/wa/authState.ts`, `src/health/health.ts`, `src/cli/status.ts`, `src/app.ts`, `src/main.ts`, `src/cli/commands.ts`, `src/cli.ts`, `.env.example`, `docs/SETUP.md`, `tests/store/db.test.ts`, `tests/store/media.test.ts`, `tests/config/env.test.ts`, `tests/cli/status.test.ts`.

New settings: `REPORT_ENABLED`, `REPORT_TIME`, `REPORT_DEADLINE`, `REPORT_RECIPIENT` (empty in `.env.example`). New data file: `data/sender-session.db`. New kv key: `report_send_requested`.

---

### Task 1: Reports table (schema v6) and the reports store

**Files:**
- Modify: `src/store/migrations.ts` (append version 6; never edit 1-5)
- Create: `src/store/reports.ts`
- Modify: `tests/store/db.test.ts`, `tests/store/media.test.ts` (schema version 5 becomes 6)
- Test: `tests/store/reports.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/store/reports.test.ts`:

```ts
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../../src/store/db.ts';
import { MIGRATIONS } from '../../src/store/migrations.ts';
import {
  claimReport, closeOldRetries, finishReport, markInterruptedReports, recentReports, reportFor, retryReport, skipReport,
} from '../../src/store/reports.ts';

const DAY = '2026-10-23';
const T0 = '2026-10-23T00:30:00.000Z'; // 06:00 IST
const T1 = '2026-10-23T00:32:00.000Z';
const T2 = '2026-10-23T00:33:00.000Z';

describe('migration v6', () => {
  it('upgrades a version-5 database and keeps its data', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
    for (const m of MIGRATIONS.filter((x) => x.version <= 5)) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version);
    }
    db.prepare("INSERT INTO clients (code, name, group_id, phases) VALUES ('SHA', 'Sharma', '1@g.us', '[]')").run();
    migrate(db);
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(6);
    expect((db.prepare('SELECT COUNT(*) AS n FROM clients').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM reports').get() as { n: number }).n).toBe(0);
  });

  it('adds version 6 as a new, additive migration and leaves versions 1 to 5 unchanged', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6]);
    const text = MIGRATIONS.filter((m) => m.version <= 5).map((m) => `${m.version}\n${m.sql}`).join('\n---\n');
    expect(createHash('sha256').update(text).digest('hex')).toBe('53081fb02c22d829badad1e5b7f5d7c0855a67b631a353244b1e5828f81c02df');
    expect(MIGRATIONS[5]!.sql).toMatch(/^\s*CREATE TABLE reports \(/);
    expect(MIGRATIONS[5]!.sql).not.toMatch(/\b(DROP|ALTER|DELETE|UPDATE|INSERT)\b/i);
  });
});

describe('reports store', () => {
  it('claims a date once, before anything is sent', () => {
    const db = openDb(':memory:');
    expect(reportFor(db, DAY)).toBeUndefined();
    expect(claimReport(db, DAY, T0)).toBe(true);
    expect(claimReport(db, DAY, T1)).toBe(false);
    expect(reportFor(db, DAY)).toEqual({
      date: DAY, status: 'sending', detail: null, attempts: 1, nextAttemptAt: null, forced: false, createdAt: T0, updatedAt: T0,
    });
  });

  it('takes a retry row again only once its wait is over', () => {
    const db = openDb(':memory:');
    claimReport(db, DAY, T0);
    expect(retryReport(db, DAY, 'connect_timeout', T1, T0)).toBe(true);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'retry', detail: 'connect_timeout', nextAttemptAt: T1 });
    expect(claimReport(db, DAY, T0)).toBe(false);
    expect(claimReport(db, DAY, T1)).toBe(true);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'sending', attempts: 2, nextAttemptAt: null, updatedAt: T1 });
  });

  it('finishes only a row that is sending, and a sent row is never claimed again, even forced', () => {
    const db = openDb(':memory:');
    expect(finishReport(db, DAY, 'sent', 'msg-1', T0)).toBe(false);
    claimReport(db, DAY, T0);
    expect(finishReport(db, DAY, 'sent', 'msg-1,msg-2', T1)).toBe(true);
    expect(finishReport(db, DAY, 'unknown', 'timeout', T2)).toBe(false);
    expect(retryReport(db, DAY, 'closed', T2, T2)).toBe(false);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'sent', detail: 'msg-1,msg-2', updatedAt: T1 });
    expect(claimReport(db, DAY, T2)).toBe(false);
    expect(claimReport(db, DAY, T2, { force: true })).toBe(false);
  });

  it('a forced claim takes unknown, skipped and waiting retry rows, but never a row that is sending', () => {
    const db = openDb(':memory:');
    claimReport(db, '2026-10-20', T0);
    finishReport(db, '2026-10-20', 'unknown', 'timeout', T0);
    skipReport(db, '2026-10-21', 'not_running', T0);
    claimReport(db, '2026-10-22', T0);
    retryReport(db, '2026-10-22', 'closed', T2, T0);
    claimReport(db, DAY, T0);
    for (const date of ['2026-10-20', '2026-10-21', '2026-10-22']) {
      expect(claimReport(db, date, T1, { force: true })).toBe(true);
      expect(reportFor(db, date)).toMatchObject({ status: 'sending', forced: true, nextAttemptAt: null });
    }
    expect(claimReport(db, DAY, T1, { force: true })).toBe(false);
  });

  it('skips a day with no row or a retry row, and leaves unknown and sent rows alone', () => {
    const db = openDb(':memory:');
    expect(skipReport(db, '2026-10-20', 'not_running', T0)).toBe(true);
    expect(reportFor(db, '2026-10-20')).toMatchObject({ status: 'skipped', detail: 'not_running', attempts: 0 });
    claimReport(db, '2026-10-21', T0);
    retryReport(db, '2026-10-21', 'connect_timeout', T1, T0);
    expect(skipReport(db, '2026-10-21', 'connect_timeout', T2)).toBe(true);
    expect(reportFor(db, '2026-10-21')).toMatchObject({ status: 'skipped', detail: 'connect_timeout', nextAttemptAt: null });
    claimReport(db, '2026-10-22', T0);
    finishReport(db, '2026-10-22', 'unknown', 'timeout', T0);
    expect(skipReport(db, '2026-10-22', 'not_running', T2)).toBe(false);
    expect(reportFor(db, '2026-10-22')!.status).toBe('unknown');
    expect(skipReport(db, '2026-10-20', 'again', T2)).toBe(false);
    expect(reportFor(db, '2026-10-20')!.detail).toBe('not_running');
  });

  it('turns rows left sending into unknown at start', () => {
    const db = openDb(':memory:');
    claimReport(db, '2026-10-22', T0);
    claimReport(db, DAY, T0);
    finishReport(db, DAY, 'sent', 'msg-1', T0);
    expect(markInterruptedReports(db, T1)).toBe(1);
    expect(reportFor(db, '2026-10-22')).toMatchObject({ status: 'unknown', detail: 'interrupted', updatedAt: T1 });
    expect(reportFor(db, DAY)!.status).toBe('sent');
  });

  it('closes retry rows of earlier dates and keeps their reason', () => {
    const db = openDb(':memory:');
    for (const date of ['2026-10-22', DAY]) {
      claimReport(db, date, T0);
      retryReport(db, date, 'connect_timeout', T1, T0);
    }
    expect(closeOldRetries(db, DAY, T2)).toBe(1);
    expect(reportFor(db, '2026-10-22')).toMatchObject({ status: 'skipped', detail: 'connect_timeout', nextAttemptAt: null });
    expect(reportFor(db, DAY)!.status).toBe('retry');
  });

  it('lists recent reports newest first', () => {
    const db = openDb(':memory:');
    for (const date of ['2026-10-21', DAY, '2026-10-22']) skipReport(db, date, 'not_running', T0);
    expect(recentReports(db, 2).map((r) => r.date)).toEqual([DAY, '2026-10-22']);
  });
});
```

In `tests/store/db.test.ts`, replace:

```ts
'reactions', 'schema_version',
```

with:

```ts
'reactions', 'reports', 'schema_version',
```

In `tests/store/db.test.ts`, replace:

```ts
  it('is at schema version 5 straight after openDb', () => {
    const db = openDb(':memory:');
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(5);
  });

  it('is safe to migrate twice', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect((db.prepare('SELECT COUNT(*) AS n FROM schema_version').get() as { n: number }).n).toBe(5);
  });
```

with:

```ts
  it('is at schema version 6 straight after openDb', () => {
    const db = openDb(':memory:');
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(6);
  });

  it('is safe to migrate twice', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect((db.prepare('SELECT COUNT(*) AS n FROM schema_version').get() as { n: number }).n).toBe(6);
  });
```

In `tests/store/media.test.ts`, replace **both** occurrences of:

```ts
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(5);
```

with:

```ts
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(6);
```

In `tests/store/media.test.ts`, replace:

```ts
    expect(MIGRATIONS.map((m) => m.version)).toEqual([1, 2, 3, 4, 5]);
```

with:

```ts
    expect(MIGRATIONS.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6]);
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run tests/store/reports.test.ts tests/store/db.test.ts tests/store/media.test.ts`

Expected: FAIL. `reports.test.ts` cannot resolve `../../src/store/reports.ts`, and `db.test.ts` and `media.test.ts` still see schema version 5.

- [ ] **Step 3: Implement**

The SQL hash in the test covers versions 1 to 5 exactly as they are today; appending version 6 does not change it.

Create `src/store/reports.ts`:

```ts
import type { Db } from './db.ts';

export type ReportStatus = 'sending' | 'sent' | 'retry' | 'unknown' | 'skipped';

/** kv key: `report send-now` stores today's IST date here, and the service's next tick takes it. */
export const REPORT_REQUEST_KEY = 'report_send_requested';

export interface ReportRow {
  /** IST date, YYYY-MM-DD. */
  date: string;
  status: ReportStatus;
  /** sent: WhatsApp message ids. retry, unknown, skipped: a reason code. Never message text or a phone number. */
  detail: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  /** True when the last claim came from `report send-now`. */
  forced: boolean;
  createdAt: string;
  updatedAt: string;
}

interface RawReport {
  date: string;
  status: ReportStatus;
  detail: string | null;
  attempts: number;
  next_attempt_at: string | null;
  forced: number;
  created_at: string;
  updated_at: string;
}

function toRow(r: RawReport): ReportRow {
  return {
    date: r.date,
    status: r.status,
    detail: r.detail,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    forced: r.forced === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function reportFor(db: Db, date: string): ReportRow | undefined {
  const r = db.prepare('SELECT * FROM reports WHERE date = ?').get(date) as RawReport | undefined;
  return r ? toRow(r) : undefined;
}

/** Newest date first. */
export function recentReports(db: Db, limit: number): ReportRow[] {
  return (db.prepare('SELECT * FROM reports ORDER BY date DESC LIMIT ?').all(limit) as RawReport[]).map(toRow);
}

/**
 * Claims the report for an IST date by setting it to 'sending'. It is one statement, so two callers can never both win.
 * Normal claim: only a date with no row, or a 'retry' row whose wait is over. Forced claim (`report send-now`): also an
 * 'unknown' or 'skipped' row, or a 'retry' row still waiting. Never a 'sent' or 'sending' row.
 * Returns true when this call claimed the date.
 */
export function claimReport(db: Db, date: string, at: string, opts: { force?: boolean } = {}): boolean {
  const reclaim = opts.force ? "reports.status IN ('retry', 'unknown', 'skipped')" : "reports.status = 'retry' AND reports.next_attempt_at <= @at";
  const info = db
    .prepare(`INSERT INTO reports (date, status, attempts, forced, created_at, updated_at)
      VALUES (@date, 'sending', 1, @forced, @at, @at)
      ON CONFLICT (date) DO UPDATE SET status = 'sending', attempts = reports.attempts + 1, next_attempt_at = NULL, forced = @forced,
        updated_at = @at
      WHERE ${reclaim}`)
    .run({ date, at, forced: opts.force ? 1 : 0 });
  return info.changes === 1;
}

/** 'sending' becomes 'sent' or 'unknown'. Returns false, changing nothing, when the row is not 'sending'. */
export function finishReport(db: Db, date: string, status: 'sent' | 'unknown', detail: string | null, at: string): boolean {
  const info = db
    .prepare("UPDATE reports SET status = @status, detail = @detail, next_attempt_at = NULL, updated_at = @at WHERE date = @date AND status = 'sending'")
    .run({ date, status, detail, at });
  return info.changes === 1;
}

/** 'sending' becomes 'retry': a definite failure before anything left. A normal claim takes it again from nextAttemptAt. */
export function retryReport(db: Db, date: string, detail: string, nextAttemptAt: string, at: string): boolean {
  const info = db
    .prepare("UPDATE reports SET status = 'retry', detail = @detail, next_attempt_at = @nextAttemptAt, updated_at = @at WHERE date = @date AND status = 'sending'")
    .run({ date, detail, nextAttemptAt, at });
  return info.changes === 1;
}

/** Past the deadline: no row, or a 'retry' row, becomes 'skipped'. A 'sent', 'sending', 'unknown' or 'skipped' row is left as it is. */
export function skipReport(db: Db, date: string, reason: string, at: string): boolean {
  const info = db
    .prepare(`INSERT INTO reports (date, status, detail, created_at, updated_at) VALUES (@date, 'skipped', @reason, @at, @at)
      ON CONFLICT (date) DO UPDATE SET status = 'skipped', detail = @reason, next_attempt_at = NULL, updated_at = @at
      WHERE reports.status = 'retry'`)
    .run({ date, reason, at });
  return info.changes === 1;
}

/** At service start: a row still 'sending' was cut off mid-send, so its outcome is unknown. Returns how many rows changed. */
export function markInterruptedReports(db: Db, at: string): number {
  return db.prepare("UPDATE reports SET status = 'unknown', detail = 'interrupted', updated_at = ? WHERE status = 'sending'").run(at).changes;
}

/** A 'retry' row of an earlier date (the service stopped before its deadline) becomes 'skipped' and keeps its reason. */
export function closeOldRetries(db: Db, beforeDate: string, at: string): number {
  return db
    .prepare("UPDATE reports SET status = 'skipped', next_attempt_at = NULL, updated_at = @at WHERE status = 'retry' AND date < @beforeDate")
    .run({ beforeDate, at }).changes;
}
```

In `src/store/migrations.ts`, replace:

```ts
    sql: 'ALTER TABLE media ADD COLUMN requeued_for_text INTEGER NOT NULL DEFAULT 0;',
  },
];
```

with:

```ts
    sql: 'ALTER TABLE media ADD COLUMN requeued_for_text INTEGER NOT NULL DEFAULT 0;',
  },
  {
    // Phase 2c: one row per IST date for the morning report. The row is claimed ('sending') before anything is sent.
    version: 6,
    sql: `
CREATE TABLE reports (
  date TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'retry', 'unknown', 'skipped')),
  detail TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  forced INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
];
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/store/reports.test.ts tests/store/db.test.ts tests/store/media.test.ts`

Expected: PASS (all tests in the three files).

- [ ] **Step 5: Run the full suite and the type-check**

Run: `npm test`, then `npm run typecheck`

Expected: every test passes and tsc prints nothing. (If only `tests/appMedia.test.ts` fails, see ground rule 12.)

- [ ] **Step 6: Commit**

```bash
git add src/store/migrations.ts src/store/reports.ts tests/store/db.test.ts tests/store/media.test.ts tests/store/reports.test.ts
git commit -m "feat: reports table (schema v6) and store for the morning report" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Morning report text builder

**Files:**
- Create: `src/report/morningReport.ts`
- Test: `tests/report/morningReport.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/report/morningReport.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadTrackerView } from '../../src/output/view.ts';
import { buildMorningText, MAX_TITLE_CHARS, shortTitle } from '../../src/report/morningReport.ts';
import { syncClients } from '../../src/store/clients.ts';
import type { Db } from '../../src/store/db.ts';
import { createTask, setTaskStatus, type NewTask } from '../../src/store/tasks.ts';
import { seededDb, SHARMA } from '../helpers/db.ts';

const NOW = new Date('2026-10-23T00:30:00.000Z'); // 06:00 IST
const TODAY = '2026-10-23';
const OK = { ok: true, text: '✅ Connected · waiting for new messages' };

const task = (o: Partial<NewTask> = {}): NewTask => ({
  clientId: 1, side: 'us', title: 'A task', category: 'design', priority: 'medium', assignedTo: null, askedBy: null, raisedOn: '2026-10-01',
  deadline: null, latestProgress: null, sourceQuote: null, sourceDate: null, sourceWaId: null, origin: 'whatsapp', ...o,
});

const text = (db: Db) => buildMorningText(loadTrackerView(db, NOW, OK), TODAY);

describe('buildMorningText', () => {
  it('counts open and overdue tasks and lists the 3 most urgent, overdue first, then due today, then priority, then oldest', () => {
    const db = seededDb();
    createTask(db, task({ title: 'Fix contact form', priority: 'high', raisedOn: '2026-10-01' }), NOW.toISOString()); // SHA-001
    createTask(db, task({ side: 'client', title: 'Send logo files', priority: 'low', deadline: '2026-10-20', raisedOn: '2026-10-15' }), NOW.toISOString()); // SHA-002
    createTask(db, task({ title: 'Write about page', deadline: TODAY, raisedOn: '2026-10-05' }), NOW.toISOString()); // SHA-003
    createTask(db, task({ title: 'Old low task', priority: 'low', raisedOn: '2026-09-01' }), NOW.toISOString()); // SHA-004
    createTask(db, task({ side: 'client', title: 'Approve sitemap', deadline: '2026-10-21', raisedOn: '2026-10-10' }), NOW.toISOString()); // SHA-005
    expect(text(db)).toBe(
      [
        'Morning report · 23 Oct',
        '',
        '*Mehta Foods*: no open tasks',
        '',
        '*Sharma Interiors*: 5 open, 2 overdue',
        '• [client] SHA-005 Approve sitemap (due 21 Oct, overdue)',
        '• [client] SHA-002 Send logo files (due 20 Oct, overdue)',
        '• [us] SHA-003 Write about page (due today)',
        '',
        'Total: 5 open, 2 overdue · Built 23 Oct 06:00 IST',
      ].join('\n'),
    );
  });

  it('ranks high priority above older tasks and notes high priority, later deadlines and maybe done', () => {
    const db = seededDb();
    createTask(db, task({ title: 'Oldest', raisedOn: '2026-09-01' }), NOW.toISOString()); // SHA-001
    createTask(db, task({ title: 'Urgent one', priority: 'high', raisedOn: '2026-10-20' }), NOW.toISOString()); // SHA-002
    const maybe = createTask(db, task({ title: 'Maybe finished', deadline: '2026-10-30', raisedOn: '2026-10-02' }), NOW.toISOString()); // SHA-003
    setTaskStatus(db, maybe.id, 'maybe_done', TODAY, NOW.toISOString(), 'ai');
    const out = text(db);
    expect(out).toContain(
      ['*Sharma Interiors*: 3 open, 0 overdue', '• [us] SHA-002 Urgent one (high priority)', '• [us] SHA-001 Oldest', '• [us] SHA-003 Maybe finished (due 30 Oct, maybe done)'].join(
        '\n',
      ),
    );
  });

  it('shows a client whose tasks are all done as having no open tasks, and leaves done tasks out of the totals', () => {
    const db = seededDb();
    const done = createTask(db, task({ title: 'Share moodboard', deadline: '2026-10-01' }), NOW.toISOString());
    setTaskStatus(db, done.id, 'done', '2026-10-15', NOW.toISOString(), 'ai');
    const out = text(db);
    expect(out).toContain('*Sharma Interiors*: no open tasks');
    expect(out).not.toContain('Share moodboard');
    expect(out).toContain('Total: 0 open, 0 overdue');
  });

  it('leaves inactive clients out', () => {
    const db = seededDb();
    createTask(db, task({ clientId: 2, title: 'Mehta menu' }), NOW.toISOString());
    syncClients(db, [SHARMA]); // Mehta taken off the allow-list
    const out = text(db);
    expect(out).not.toContain('Mehta');
    expect(out).toContain('Total: 0 open, 0 overdue');
  });

  it('says so when there are no active clients', () => {
    const db = seededDb();
    syncClients(db, []);
    expect(text(db)).toBe(['Morning report · 23 Oct', '', 'No active clients.', '', 'Total: 0 open, 0 overdue · Built 23 Oct 06:00 IST'].join('\n'));
  });

  it('cuts long titles cleanly to one line', () => {
    const db = seededDb();
    createTask(db, task({ title: 'Revise the homepage banner so that it matches the new brand colours and the approved moodboard' }), NOW.toISOString());
    expect(text(db)).toContain('• [us] SHA-001 Revise the homepage banner so that it matches the new brand colours…');
  });
});

describe('shortTitle', () => {
  it('keeps short titles and flattens line breaks', () => {
    expect(shortTitle('Send\n  logo   files ')).toBe('Send logo files');
  });

  it('cuts at a space near the end, or mid-word when there is none', () => {
    const cut = shortTitle('word '.repeat(30));
    expect(Array.from(cut).length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
    expect(cut.endsWith('word…')).toBe(true);
    expect(shortTitle('x'.repeat(100))).toBe(`${'x'.repeat(MAX_TITLE_CHARS - 1)}…`);
  });

  it('never splits an emoji', () => {
    expect(shortTitle(`${'a'.repeat(68)}😀😀😀`)).toBe(`${'a'.repeat(68)}😀…`);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run tests/report/morningReport.test.ts`

Expected: FAIL. The test cannot resolve `../../src/report/morningReport.ts`.

- [ ] **Step 3: Implement**

Create `src/report/morningReport.ts`:

```ts
import { isOverdue, type ClientView, type TrackerView } from '../output/view.ts';
import type { TaskRow } from '../store/tasks.ts';
import { displayDate, istShortDate, istTime } from '../util/time.ts';

/** Most urgent open tasks listed per client. */
export const TOP_TASKS = 3;
/** Longest task title in the message, in characters. Longer titles are cut, at a space when one is near the end. */
export const MAX_TITLE_CHARS = 70;

const PRIORITY_RANK: Record<TaskRow['priority'], number> = { high: 0, medium: 1, low: 2 };

/** Overdue first, then due today, then priority (high first), then oldest raised, then task id. */
export function byMorningUrgency(today: string): (a: TaskRow, b: TaskRow) => number {
  const overdue = (t: TaskRow) => (isOverdue(t, today) ? 0 : 1);
  const dueToday = (t: TaskRow) => (t.deadline === today ? 0 : 1);
  return (a, b) =>
    overdue(a) - overdue(b) ||
    dueToday(a) - dueToday(b) ||
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
    a.raisedOn.localeCompare(b.raisedOn) ||
    a.id - b.id;
}

/** One line of at most `max` characters. Counts code points, so an emoji is never cut in half. */
export function shortTitle(title: string, max = MAX_TITLE_CHARS): string {
  const flat = title.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  const cut = chars.slice(0, max - 1).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space >= max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function taskLine(t: TaskRow, today: string): string {
  const notes: string[] = [];
  if (t.deadline) notes.push(t.deadline === today ? 'due today' : `due ${displayDate(t.deadline)}`);
  if (isOverdue(t, today)) notes.push('overdue');
  if (t.priority === 'high') notes.push('high priority');
  if (t.status === 'maybe_done') notes.push('maybe done');
  return `• [${t.side}] ${t.code} ${shortTitle(t.title)}${notes.length ? ` (${notes.join(', ')})` : ''}`;
}

function clientLines(c: ClientView, today: string): string[] {
  const open = [...c.usOpen, ...c.clientOpen];
  if (open.length === 0) return [`*${c.client.name}*: no open tasks`];
  const top = open.sort(byMorningUrgency(today)).slice(0, TOP_TASKS);
  return [`*${c.client.name}*: ${open.length} open, ${c.overdue} overdue`, ...top.map((t) => taskLine(t, today))];
}

/** The morning WhatsApp text, built from the tracker view only (no AI call). Inactive clients are left out. */
export function buildMorningText(view: TrackerView, today: string): string {
  const active = view.clients.filter((c) => c.client.active);
  const lines = [`Morning report · ${displayDate(today)}`];
  let open = 0;
  let overdue = 0;
  if (active.length === 0) lines.push('', 'No active clients.');
  for (const c of active) {
    open += c.usOpen.length + c.clientOpen.length;
    overdue += c.overdue;
    lines.push('', ...clientLines(c, today));
  }
  const built = `${istShortDate(view.generatedAt)} ${istTime(view.generatedAt)}`;
  lines.push('', `Total: ${open} open, ${overdue} overdue · Built ${built} IST`);
  return lines.join('\n');
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/report/morningReport.test.ts`

Expected: PASS (9 tests).

- [ ] **Step 5: Run the full suite and the type-check**

Run: `npm test`, then `npm run typecheck`

Expected: every test passes and tsc prints nothing. (If only `tests/appMedia.test.ts` fails, see ground rule 12.)

- [ ] **Step 6: Commit**

```bash
git add src/report/morningReport.ts tests/report/morningReport.test.ts
git commit -m "feat: morning report text builder" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Settings and report types

**Files:**
- Create: `src/report/types.ts`
- Modify: `src/config/env.ts`
- Modify: `.env.example` (the four settings, empty)
- Test: `tests/config/env.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/config/env.test.ts`, replace:

```ts
import { parseEnv, requireKey } from '../../src/config/env.ts';
```

with:

```ts
import { maskNumber, parseEnv, reportRecipient, reportSettings, requireKey } from '../../src/config/env.ts';
```

Append to the end of `tests/config/env.test.ts` (after one blank line):

```ts
describe('morning report settings', () => {
  it('is off by default, with 06:00 to 12:00 IST', () => {
    const env = parseEnv({ REPORT_ENABLED: '', REPORT_TIME: '', REPORT_DEADLINE: '', REPORT_RECIPIENT: '' });
    expect(reportSettings(env)).toEqual({ enabled: false, time: '06:00', deadline: '12:00' });
    expect(env.REPORT_RECIPIENT).toBeUndefined();
  });

  it('turns on only with REPORT_ENABLED=true and a recipient', () => {
    const env = parseEnv({ REPORT_ENABLED: 'true', REPORT_RECIPIENT: '919800000000', REPORT_TIME: '06:30', REPORT_DEADLINE: '11:00' });
    expect(reportSettings(env)).toEqual({ enabled: true, time: '06:30', deadline: '11:00' });
    expect(reportRecipient(env)).toBe('919800000000');
    expect(parseEnv({ REPORT_ENABLED: 'false' }).REPORT_ENABLED).toBe(false);
  });

  it('refuses REPORT_ENABLED=true without a recipient, naming the variable', () => {
    expect(() => parseEnv({ REPORT_ENABLED: 'true' })).toThrowError('Invalid configuration in: REPORT_RECIPIENT');
    expect(() => reportRecipient(parseEnv({}))).toThrowError('REPORT_RECIPIENT is not configured');
  });

  it('refuses a recipient that is not digits only, without echoing it', () => {
    for (const bad of ['+919800000000', '98000 00000', '1234']) {
      try {
        parseEnv({ REPORT_RECIPIENT: bad });
        expect.unreachable();
      } catch (e) {
        expect((e as Error).message).toBe('Invalid configuration in: REPORT_RECIPIENT');
        expect((e as Error).message).not.toContain(bad);
      }
    }
  });

  it('refuses bad times, and a deadline that is not after the start', () => {
    expect(() => parseEnv({ REPORT_TIME: '6:00' })).toThrowError(/REPORT_TIME/);
    expect(() => parseEnv({ REPORT_ENABLED: 'yes' })).toThrowError(/REPORT_ENABLED/);
    expect(() => parseEnv({ REPORT_TIME: '12:00', REPORT_DEADLINE: '12:00' })).toThrowError('Invalid configuration in: REPORT_DEADLINE');
  });

  it('masks a number down to its last 4 digits', () => {
    expect(maskNumber('919812345678')).toBe('…5678');
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run tests/config/env.test.ts`

Expected: FAIL. The import of `maskNumber`, `reportRecipient` and `reportSettings` fails: `env.ts` does not export them yet.

- [ ] **Step 3: Implement**

`types.ts` holds every type the later tasks share, so `env.ts`, the scheduler, the sender and Health agree on one set of names.

Create `src/report/types.ts`:

```ts
/** When the morning report goes out. Times are IST, "HH:MM". */
export interface ReportSettings {
  enabled: boolean;
  /** Earliest send time, default "06:00". */
  time: string;
  /** From this time on, a day not yet sent is skipped. Default "12:00". */
  deadline: string;
}

/**
 * sent: both messages left, with their WhatsApp ids.
 * failed: a definite failure before anything was sent (not linked, no connection, session refused). Safe to retry.
 * unknown: the send started and did not finish cleanly. It may have reached the founder, so it is never retried automatically.
 */
export type SendResult =
  | { status: 'sent'; messageIds: string[] }
  | { status: 'failed'; code: string }
  | { status: 'unknown'; code: string };

export type SenderState = 'idle' | 'not_linked' | 'connecting' | 'open' | 'logged_out' | 'forbidden' | 'replaced';

export interface SenderStatus {
  state: SenderState;
  since: string;
  lastErrorCode: number | null;
}

/**
 * What the scheduler needs from a sender. The recipient is fixed when the sender is made and cannot be passed in.
 * SenderGateway (Baileys, spare number) implements it today; the official WhatsApp Business API could replace it later.
 */
export interface ReportSender {
  sendReport(text: string, xlsx: Buffer, fileName: string): Promise<SendResult>;
  status(): SenderStatus;
  stop(): Promise<void>;
}

/** The morning report's line in Health and `cli status`. warning is set only when the owner has to act. */
export interface ReportHealth {
  text: string;
  warning: string | null;
}
```

In `src/config/env.ts`, replace:

```ts
import { z } from 'zod';
```

with:

```ts
import { z } from 'zod';
import type { ReportSettings } from '../report/types.ts';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
```

In `src/config/env.ts`, replace:

```ts
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});
```

with:

```ts
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Phase 2c morning report. Off unless REPORT_ENABLED is exactly "true".
  REPORT_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  REPORT_TIME: z.string().regex(HHMM).default('06:00'),
  REPORT_DEADLINE: z.string().regex(HHMM).default('12:00'),
  /** The founder's number with country code, digits only. Personal data: never logged in full. */
  REPORT_RECIPIENT: z.string().regex(/^\d{8,15}$/).optional(),
}).superRefine((env, ctx) => {
  if (env.REPORT_ENABLED && !env.REPORT_RECIPIENT) {
    ctx.addIssue({ code: 'custom', path: ['REPORT_RECIPIENT'], message: 'required when REPORT_ENABLED is true' });
  }
  if (env.REPORT_TIME >= env.REPORT_DEADLINE) {
    ctx.addIssue({ code: 'custom', path: ['REPORT_DEADLINE'], message: 'must be later than REPORT_TIME' });
  }
});
```

In `src/config/env.ts`, replace:

```ts
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}
```

with:

```ts
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export function reportSettings(env: Env): ReportSettings {
  return { enabled: env.REPORT_ENABLED, time: env.REPORT_TIME, deadline: env.REPORT_DEADLINE };
}

/** The founder's number (digits only). parseEnv already refuses REPORT_ENABLED=true without it. */
export function reportRecipient(env: Env): string {
  if (!env.REPORT_RECIPIENT) throw new Error('REPORT_RECIPIENT is not configured');
  return env.REPORT_RECIPIENT;
}

/** For logs and screens: only the last 4 digits of a phone number. */
export function maskNumber(digits: string): string {
  return `…${digits.slice(-4)}`;
}
```

In `.env.example`, replace:

```bash
GROUPS_FILE=config/allowed-groups.json
LOG_LEVEL=info
```

with:

```bash
GROUPS_FILE=config/allowed-groups.json
LOG_LEVEL=info

# Morning report from the spare number (docs/SETUP.md, "Morning report").
# REPORT_ENABLED=true turns it on. REPORT_TIME and REPORT_DEADLINE are IST (HH:MM); empty means 06:00 and 12:00.
# REPORT_RECIPIENT is the founder's number with country code, digits only.
REPORT_ENABLED=
REPORT_TIME=
REPORT_DEADLINE=
REPORT_RECIPIENT=
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/config/env.test.ts`

Expected: PASS (the existing tests and 6 new ones).

- [ ] **Step 5: Run the full suite and the type-check**

Run: `npm test`, then `npm run typecheck`

Expected: every test passes and tsc prints nothing. (If only `tests/appMedia.test.ts` fails, see ground rule 12.)

- [ ] **Step 6: Commit**

```bash
git add .env.example src/config/env.ts src/report/types.ts tests/config/env.test.ts
git commit -m "feat: morning report settings and report types" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: The spare number's encrypted session store

**Files:**
- Modify: `src/config/paths.ts` (`senderSessionDbPath`)
- Modify: `src/crypto/keyProvider.ts` (`deriveSubkey`)
- Modify: `src/wa/authState.ts` (`SENDER_SESSION_INFO`, `SenderSessionDecryptError`, `useSenderAuthState`)
- Test: `tests/wa/senderAuth.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/wa/senderAuth.test.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { senderSessionDbPath, sessionDbPath } from '../../src/config/paths.ts';
import { deriveSubkey } from '../../src/crypto/keyProvider.ts';
import {
  openSessionDb, SENDER_SESSION_INFO, SenderSessionDecryptError, SessionDecryptError, useEncryptedAuthState, useSenderAuthState,
} from '../../src/wa/authState.ts';

const MASTER = randomBytes(32);

describe('sender session store', () => {
  it('lives in its own file next to the founder session', () => {
    expect(senderSessionDbPath('data')).toBe(join('data', 'sender-session.db'));
    expect(senderSessionDbPath('data')).not.toBe(sessionDbPath('data'));
  });

  it('uses its own HKDF subkey of the master key', () => {
    expect(SENDER_SESSION_INFO).toBe('whatsapp-sender-session');
    const sub = deriveSubkey(MASTER, SENDER_SESSION_INFO);
    expect(sub).toHaveLength(32);
    expect(sub.equals(MASTER)).toBe(false);
    expect(sub.equals(deriveSubkey(MASTER, 'media-ref'))).toBe(false);
    expect(deriveSubkey(MASTER, SENDER_SESSION_INFO).equals(sub)).toBe(true);
    expect(() => deriveSubkey(Buffer.alloc(16), SENDER_SESSION_INFO)).toThrow('Master key must be 32 bytes');
  });

  it('persists the spare number session and restores it with the same master key', async () => {
    const db = openSessionDb(':memory:');
    const a = useSenderAuthState(db, MASTER);
    expect(a.hasSession).toBe(false);
    a.state.creds.me = { id: '919800000099:3@s.whatsapp.net', name: 'Spare' };
    await a.saveCreds();
    for (const { v } of db.prepare('SELECT v FROM auth').all() as { v: Buffer }[]) expect(v.toString('latin1')).not.toContain('Spare');
    expect(useSenderAuthState(db, MASTER).hasSession).toBe(true);
  });

  it('cannot be opened with the founder session key, and cannot open the founder session', async () => {
    const senderDb = openSessionDb(':memory:');
    await useSenderAuthState(senderDb, MASTER).saveCreds();
    expect(() => useEncryptedAuthState(senderDb, MASTER)).toThrow(SessionDecryptError);

    const founderDb = openSessionDb(':memory:');
    await useEncryptedAuthState(founderDb, MASTER).saveCreds();
    expect(() => useSenderAuthState(founderDb, MASTER)).toThrow(SenderSessionDecryptError);
  });

  it('names link-sender --reset when another master key wrote the file', async () => {
    const db = openSessionDb(':memory:');
    await useSenderAuthState(db, MASTER).saveCreds();
    expect(() => useSenderAuthState(db, randomBytes(32))).toThrow(/link-sender --reset/);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run tests/wa/senderAuth.test.ts tests/wa/authState.test.ts`

Expected: FAIL. `senderSessionDbPath`, `deriveSubkey`, `SENDER_SESSION_INFO`, `SenderSessionDecryptError` and `useSenderAuthState` are not exported yet.

- [ ] **Step 3: Implement**

`useEncryptedAuthState` already derives its row and value keys from the key it is given, so passing the sender subkey gives the spare number a fully separate store with no change to the founder's.

In `src/config/paths.ts`, replace:

```ts
export const sessionDbPath = (dataDir: string): string => join(dataDir, 'session.db');
```

with:

```ts
export const sessionDbPath = (dataDir: string): string => join(dataDir, 'session.db');
/** The spare number's WhatsApp session (Phase 2c morning report). Never the founder's session. */
export const senderSessionDbPath = (dataDir: string): string => join(dataDir, 'sender-session.db');
```

In `src/crypto/keyProvider.ts`, replace:

```ts
import { randomBytes } from 'node:crypto';
```

with:

```ts
import { hkdfSync, randomBytes } from 'node:crypto';
```

In `src/crypto/keyProvider.ts`, replace:

```ts
export class StaticKeyProvider implements KeyProvider {
```

with:

```ts
/** A 32-byte HKDF-SHA256 subkey of the master key. Each use gets its own `info` label, so one subkey never opens another's data. */
export function deriveSubkey(masterKey: Buffer, info: string): Buffer {
  if (masterKey.length !== 32) throw new Error('Master key must be 32 bytes');
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), info, 32));
}

export class StaticKeyProvider implements KeyProvider {
```

In `src/wa/authState.ts`, replace:

```ts
import { decrypt, encrypt } from '../crypto/envelope.ts';
```

with:

```ts
import { decrypt, encrypt } from '../crypto/envelope.ts';
import { deriveSubkey } from '../crypto/keyProvider.ts';
```

In `src/wa/authState.ts`, replace:

```ts
export function openSessionDb(file: string): Db {
```

with:

```ts
/** HKDF label of the spare number's session key (spec §3, "Sender isolation"). */
export const SENDER_SESSION_INFO = 'whatsapp-sender-session';

export class SenderSessionDecryptError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      `The spare number's WhatsApp session could not be decrypted with the current master key. Running "link-sender --reset" discards it and needs a new QR scan from the spare phone.`,
      options,
    );
    this.name = 'SenderSessionDecryptError';
  }
}

export function openSessionDb(file: string): Db {
```

Append to the end of `src/wa/authState.ts` (after one blank line):

```ts
/**
 * The spare number's session: the same encrypted store, keyed by its own HKDF subkey of the master key, in its own file
 * (data/sender-session.db). The founder's session key cannot open it, and this key cannot open the founder's session.
 */
export function useSenderAuthState(db: Db, masterKey: Buffer): EncryptedAuth {
  try {
    return useEncryptedAuthState(db, deriveSubkey(masterKey, SENDER_SESSION_INFO));
  } catch (cause) {
    if (cause instanceof SessionDecryptError) throw new SenderSessionDecryptError({ cause });
    throw cause;
  }
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/wa/senderAuth.test.ts tests/wa/authState.test.ts`

Expected: PASS (5 new tests, and the existing `authState` tests unchanged).

- [ ] **Step 5: Run the full suite and the type-check**

Run: `npm test`, then `npm run typecheck`

Expected: every test passes and tsc prints nothing. (If only `tests/appMedia.test.ts` fails, see ground rule 12.)

- [ ] **Step 6: Commit**

```bash
git add src/config/paths.ts src/crypto/keyProvider.ts src/wa/authState.ts tests/wa/senderAuth.test.ts
git commit -m "feat: encrypted session store for the spare number, with its own HKDF subkey" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Sender gateway behind ReportSender, and the send-method source scan

**Files:**
- Create: `src/wa/senderGateway.ts`
- Test: `tests/wa/senderGateway.test.ts` (fake socket)
- Test: `tests/wa/sendScan.test.ts` (only senderGateway calls a Baileys send method)

The tests reuse `FakeSocket` from `tests/helpers/fakeSocket.ts`: it already has `sendMessage`, `readMessages`, `sendPresenceUpdate`, `sendReceipt` and `chatModify` as spies, and `closeWith` for close codes.

- [ ] **Step 1: Write the failing tests**

Create `tests/wa/senderGateway.test.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { XLSX_MIME } from '../../src/output/workbook.ts';
import { openSessionDb, useSenderAuthState, type EncryptedAuth } from '../../src/wa/authState.ts';
import { checkRecipient, linkSender, recipientJid, RecipientRefusedError, SenderGateway } from '../../src/wa/senderGateway.ts';
import { closeWith, FakeSocket, SEND_METHODS } from '../helpers/fakeSocket.ts';

const RECIPIENT = '919800000000';
const JID = '919800000000@s.whatsapp.net';
const XLSX = Buffer.from('xlsx bytes');
const FILE = 'Tracker-2026-10-23.xlsx';

type Script = (s: FakeSocket) => void;
const open: Script = (s) => s.emit('connection.update', { connection: 'open' });
const hang: Script = (s) => {
  s.sendMessage.mockImplementation(() => new Promise(() => {}));
  open(s);
};

/** Each new socket answers sendMessage with msg-1, msg-2, ... and runs the next script after the caller added its listeners. */
function scriptedFactory(scripts: Script[] = []) {
  const sockets: FakeSocket[] = [];
  const factory = () => {
    const s = new FakeSocket();
    let n = 0;
    s.sendMessage.mockImplementation(async () => ({ key: { id: `msg-${++n}` } }));
    sockets.push(s);
    const script = scripts.shift() ?? open;
    queueMicrotask(() => script(s));
    return s;
  };
  return { factory, sockets };
}

function senderAuth(linked: boolean): EncryptedAuth {
  const auth = useSenderAuthState(openSessionDb(':memory:'), randomBytes(32));
  return { ...auth, hasSession: linked };
}

function setup(o: { scripts?: Script[]; auth?: EncryptedAuth; noAuth?: boolean; connectTimeoutMs?: number; sendTimeoutMs?: number } = {}) {
  const { factory, sockets } = scriptedFactory(o.scripts);
  const gw = new SenderGateway({
    recipient: RECIPIENT,
    factory,
    auth: o.noAuth ? undefined : (o.auth ?? senderAuth(true)),
    connectTimeoutMs: o.connectTimeoutMs ?? 1_000,
    sendTimeoutMs: o.sendTimeoutMs ?? 1_000,
    lingerMs: 0,
  });
  return { gw, sockets };
}

describe('SenderGateway', () => {
  it('sends the text, then the tracker as a document, to the configured recipient, then disconnects', async () => {
    const { gw, sockets } = setup();
    expect(await gw.sendReport('Morning report · 23 Oct', XLSX, FILE)).toEqual({ status: 'sent', messageIds: ['msg-1', 'msg-2'] });
    const sock = sockets[0]!;
    expect(sock.sendMessage.mock.calls).toEqual([
      [JID, { text: 'Morning report · 23 Oct' }],
      [JID, { document: XLSX, mimetype: XLSX_MIME, fileName: FILE }],
    ]);
    expect(sock.end).toHaveBeenCalled();
    expect(gw.status().state).toBe('idle');
  });

  it('sets no presence, sends no read receipts and changes no chat', async () => {
    const { gw, sockets } = setup();
    await gw.sendReport('hi', XLSX, FILE);
    for (const name of SEND_METHODS.filter((n) => n !== 'sendMessage')) expect(sockets[0]![name]).not.toHaveBeenCalled();
  });

  it('refuses any recipient other than REPORT_RECIPIENT, and takes no recipient from the caller', () => {
    expect(recipientJid(RECIPIENT)).toBe(JID);
    expect(() => checkRecipient(JID, JID)).not.toThrow();
    expect(() => checkRecipient('919811111111@s.whatsapp.net', JID)).toThrow(RecipientRefusedError);
    expect(() => checkRecipient('120363000000000001@g.us', JID)).toThrow(RecipientRefusedError);
    for (const bad of ['+919800000000', '91 98000 00000', '120363000000000001@g.us', '']) {
      expect(() => new SenderGateway({ recipient: bad, factory: scriptedFactory().factory, auth: senderAuth(true) })).toThrow(/digits only/);
    }
    expect(SenderGateway.prototype.sendReport.length).toBe(3); // text, xlsx, fileName
  });

  it('has exactly one send method', () => {
    const names = Object.getOwnPropertyNames(SenderGateway.prototype);
    expect(names.filter((n) => /send|read|presence|react|receipt|chatmodify|delete/i.test(n))).toEqual(['sendReport']);
  });

  it('fails definitely, without connecting, when the spare number is not linked', async () => {
    for (const o of [{ noAuth: true }, { auth: senderAuth(false) }]) {
      const { gw, sockets } = setup(o);
      expect(gw.status().state).toBe('not_linked');
      expect(await gw.sendReport('hi', XLSX, FILE)).toEqual({ status: 'failed', code: 'not_linked' });
      expect(sockets).toHaveLength(0);
    }
  });

  it('fails definitely when WhatsApp shows a QR code, refuses the session or never connects', async () => {
    const cases: { script: Script; code: string; state: string; statusCode: number | null }[] = [
      { script: (s) => s.emit('connection.update', { qr: 'QR-1' }), code: 'not_linked', state: 'not_linked', statusCode: null },
      { script: (s) => closeWith(s, 401), code: 'logged_out', state: 'logged_out', statusCode: 401 },
      { script: (s) => closeWith(s, 403), code: 'forbidden', state: 'forbidden', statusCode: 403 },
      { script: (s) => closeWith(s, 440), code: 'replaced', state: 'replaced', statusCode: 440 },
      { script: (s) => closeWith(s, 428), code: 'closed', state: 'idle', statusCode: 428 },
      { script: () => {}, code: 'connect_timeout', state: 'idle', statusCode: null },
    ];
    for (const c of cases) {
      const { gw, sockets } = setup({ scripts: [c.script], connectTimeoutMs: 20 });
      expect(await gw.sendReport('hi', XLSX, FILE)).toEqual({ status: 'failed', code: c.code });
      expect(sockets[0]!.sendMessage).not.toHaveBeenCalled();
      expect(sockets[0]!.end).toHaveBeenCalled();
      expect(gw.status()).toMatchObject({ state: c.state, lastErrorCode: c.statusCode });
    }
  });

  it('reports unknown when a send times out or fails after it started', async () => {
    const timedOut = setup({ scripts: [hang], sendTimeoutMs: 20 });
    expect(await timedOut.gw.sendReport('hi', XLSX, FILE)).toEqual({ status: 'unknown', code: 'timeout' });

    const docFails: Script = (s) => {
      s.sendMessage.mockResolvedValueOnce({ key: { id: 'msg-1' } }).mockRejectedValueOnce(new Error('upload failed'));
      open(s);
    };
    const failed = setup({ scripts: [docFails] });
    expect(await failed.gw.sendReport('hi', XLSX, FILE)).toEqual({ status: 'unknown', code: 'send_error' });
    expect(failed.sockets[0]!.sendMessage).toHaveBeenCalledTimes(2);
    expect(failed.sockets[0]!.end).toHaveBeenCalled();
  });

  it('sends one report at a time', async () => {
    const { gw } = setup({ scripts: [hang], sendTimeoutMs: 50 });
    const first = gw.sendReport('hi', XLSX, FILE);
    expect(await gw.sendReport('hi', XLSX, FILE)).toEqual({ status: 'failed', code: 'busy' });
    expect(await first).toEqual({ status: 'unknown', code: 'timeout' });
  });

  it('stop ends a send in progress and refuses later sends', async () => {
    const { gw, sockets } = setup({ scripts: [hang], sendTimeoutMs: 50 });
    const p = gw.sendReport('hi', XLSX, FILE);
    await vi.waitFor(() => expect(sockets[0]?.sendMessage).toHaveBeenCalled());
    await gw.stop();
    expect(sockets[0]!.end).toHaveBeenCalled();
    expect(await p).toEqual({ status: 'unknown', code: 'timeout' });
    expect(await gw.sendReport('hi', XLSX, FILE)).toEqual({ status: 'failed', code: 'stopped' });
  });
});

describe('linkSender', () => {
  it('shows the QR code, reconnects once after the scan, saves the session and sends nothing', async () => {
    const { factory, sockets } = scriptedFactory([
      (s) => {
        s.emit('connection.update', { qr: 'QR-1' });
        closeWith(s, 515); // restart required after the scan
      },
      open,
    ]);
    const auth = senderAuth(false);
    const saveCreds = vi.fn(auth.saveCreds);
    const qr: string[] = [];
    expect(await linkSender({ factory, auth: { ...auth, saveCreds }, onQr: (q) => qr.push(q), timeoutMs: 1_000, settleMs: 0 })).toEqual({ ok: true });
    expect(qr).toEqual(['QR-1']);
    expect(saveCreds).toHaveBeenCalled();
    expect(sockets).toHaveLength(2);
    for (const s of sockets) {
      expect(s.end).toHaveBeenCalled();
      for (const name of SEND_METHODS) expect(s[name]).not.toHaveBeenCalled();
    }
  });

  it('stops when WhatsApp refuses the link', async () => {
    const { factory } = scriptedFactory([(s) => closeWith(s, 401)]);
    expect(await linkSender({ factory, auth: senderAuth(false), onQr: () => {}, timeoutMs: 1_000, settleMs: 0 })).toEqual({ ok: false, code: 'logged_out' });
  });
});
```

Create `tests/wa/sendScan.test.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
/** Baileys socket methods that send something to WhatsApp: a message, a receipt, presence, or a chat change. */
const SEND_NAMES = /\b(sendMessage|relayMessage|sendPresenceUpdate|readMessages|sendReceipt|sendReceipts|chatModify|sendMessageAck)\b/;

function sources(): { file: string; text: string }[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: f.replaceAll('\\', '/'), text: readFileSync(join(SRC, f), 'utf8') }));
}

describe('who may send on WhatsApp', () => {
  it('scans the real source tree', () => {
    const files = sources().map((s) => s.file);
    expect(files.length).toBeGreaterThan(40);
    expect(files).toEqual(expect.arrayContaining(['wa/gateway.ts', 'wa/senderGateway.ts', 'app.ts']));
  });

  it('no module except src/wa/senderGateway.ts names a Baileys send method', () => {
    const offenders = sources().filter((s) => s.file !== 'wa/senderGateway.ts' && SEND_NAMES.test(s.text)).map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  it('senderGateway calls sendMessage in one place, and never receipts, presence or chat changes', () => {
    const text = readFileSync(join(SRC, 'wa', 'senderGateway.ts'), 'utf8');
    expect(text.match(/\.sendMessage\(/g)).toHaveLength(1);
    expect(text).not.toMatch(/\b(relayMessage|sendPresenceUpdate|readMessages|sendReceipt|sendReceipts|chatModify|sendMessageAck)\b/);
  });

  it('only the two gateways create a Baileys socket', () => {
    const makers = sources().filter((s) => /\bmakeWASocket\b/.test(s.text)).map((s) => s.file).sort();
    expect(makers).toEqual(['wa/gateway.ts', 'wa/senderGateway.ts']);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run tests/wa/senderGateway.test.ts tests/wa/sendScan.test.ts tests/wa/gateway.test.ts`

Expected: FAIL. `senderGateway.test.ts` cannot resolve `../../src/wa/senderGateway.ts`. In `sendScan.test.ts` the three tests that look for `wa/senderGateway.ts` fail; 'no module except src/wa/senderGateway.ts names a Baileys send method' already passes, because nothing sends today.

- [ ] **Step 3: Implement**

Create `src/wa/senderGateway.ts`:

```ts
import makeWASocket, { Browsers, DisconnectReason, makeCacheableSignalKeyStore } from 'baileys';
import type { AnyMessageContent, AuthenticationState, BaileysEventMap, WAMessage } from 'baileys';
import { XLSX_MIME } from '../output/workbook.ts';
import type { ReportSender, SenderState, SenderStatus, SendResult } from '../report/types.ts';
import { systemClock, type Clock } from '../util/clock.ts';
import type { EncryptedAuth } from './authState.ts';
import type { BaileysLogger } from './gateway.ts';

/** The subset of a Baileys socket the sender uses. Its send method is called in exactly one place: SenderGateway's #send. */
export interface SenderSocketLike {
  ev: { on<T extends keyof BaileysEventMap>(event: T, listener: (arg: BaileysEventMap[T]) => void): void };
  sendMessage(jid: string, content: AnyMessageContent): Promise<WAMessage | undefined>;
  end(error: Error | undefined): Promise<void> | void;
}

export type SenderSocketFactory = (auth: AuthenticationState) => SenderSocketLike;

/**
 * The logger passed in must be silent: Baileys logs JIDs. markOnlineOnConnect false makes Baileys announce "unavailable",
 * never "online". No history sync. enableRecentMessageCache keeps only this socket's own outgoing report in memory, so
 * Baileys can answer a retry request from the founder's phone while the socket is still open.
 */
export function baileysSenderSocketFactory(logger: BaileysLogger): SenderSocketFactory {
  return (auth) =>
    makeWASocket({
      auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(auth.keys, logger) },
      logger,
      browser: Browsers.windows('Desktop'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
      enableRecentMessageCache: true,
      getMessage: async () => undefined,
    });
}

/** "919812345678" becomes "919812345678@s.whatsapp.net". Anything but 8 to 15 digits is refused. */
export function recipientJid(digits: string): string {
  if (!/^\d{8,15}$/.test(digits)) throw new Error('REPORT_RECIPIENT must be the number with country code, digits only');
  return `${digits}@s.whatsapp.net`;
}

export class RecipientRefusedError extends Error {
  constructor() {
    super('The morning report may go only to REPORT_RECIPIENT');
    this.name = 'RecipientRefusedError';
  }
}

/** Throws unless jid is exactly the configured recipient's JID. */
export function checkRecipient(jid: string, allowedJid: string): void {
  if (jid !== allowedJid) throw new RecipientRefusedError();
}

export type OpenFailure = 'not_linked' | 'connect_timeout' | 'logged_out' | 'forbidden' | 'replaced' | 'restart_required' | 'closed';

type Opened = { sock: SenderSocketLike } | { code: OpenFailure; statusCode: number | null };

function closeCode(statusCode: number | null): OpenFailure {
  if (statusCode === DisconnectReason.loggedOut) return 'logged_out';
  if (statusCode === DisconnectReason.forbidden) return 'forbidden';
  if (statusCode === DisconnectReason.connectionReplaced) return 'replaced';
  if (statusCode === DisconnectReason.restartRequired) return 'restart_required';
  return 'closed';
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function endQuietly(sock: SenderSocketLike): Promise<void> {
  try {
    await sock.end(undefined);
  } catch {
    // closing an already-dead socket is fine
  }
}

/**
 * Opens one socket and waits until it is open. Without onQr, a QR code means the session is not linked, so it gives up at
 * once. Listens only to creds.update and connection.update: it never reads chats.
 */
function openSocket(
  factory: SenderSocketFactory,
  auth: EncryptedAuth,
  timeoutMs: number,
  onQr?: (qr: string) => void,
  onSocket?: (sock: SenderSocketLike) => void,
): Promise<Opened> {
  const sock = factory(auth.state);
  onSocket?.(sock);
  sock.ev.on('creds.update', () => {
    // A failed save must not become an unhandled rejection, which would stop the service.
    void auth.saveCreds().catch(() => {});
  });
  return new Promise<Opened>((resolve) => {
    let settled = false;
    const finish = (r: Opened) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if ('code' in r) void endQuietly(sock);
      resolve(r);
    };
    const timer = setTimeout(() => finish({ code: 'connect_timeout', statusCode: null }), timeoutMs);
    sock.ev.on('connection.update', (u) => {
      if (u.qr) {
        if (onQr) onQr(u.qr);
        else finish({ code: 'not_linked', statusCode: null });
      }
      if (u.connection === 'open') finish({ sock });
      else if (u.connection === 'close') {
        const statusCode = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode ?? null;
        finish({ code: closeCode(statusCode), statusCode });
      }
    });
  });
}

export type LinkResult = { ok: true } | { ok: false; code: OpenFailure };

/**
 * Links the spare number by QR code (`cli link-sender`). After the scan WhatsApp asks for one restart, so up to 3 sockets
 * are opened in turn. Sends nothing.
 */
export async function linkSender(o: {
  factory: SenderSocketFactory;
  auth: EncryptedAuth;
  onQr: (qr: string) => void;
  timeoutMs: number;
  /** How long the linked socket stays open so Baileys can finish its first key uploads. Default 5 s. */
  settleMs?: number;
}): Promise<LinkResult> {
  for (let i = 0; i < 3; i++) {
    const r = await openSocket(o.factory, o.auth, o.timeoutMs, o.onQr);
    if ('sock' in r) {
      await delay(o.settleMs ?? 5_000);
      await o.auth.saveCreds();
      await endQuietly(r.sock);
      return { ok: true };
    }
    if (r.code !== 'restart_required') return { ok: false, code: r.code };
  }
  return { ok: false, code: 'closed' };
}

class SendTimeoutError extends Error {
  constructor() {
    super('WhatsApp did not confirm the send in time');
    this.name = 'SendTimeoutError';
  }
}

const FAILURE_STATE: Partial<Record<OpenFailure, SenderState>> = {
  not_linked: 'not_linked',
  logged_out: 'logged_out',
  forbidden: 'forbidden',
  replaced: 'replaced',
};

export interface SenderGatewayOptions {
  /** REPORT_RECIPIENT: the founder's number, digits only. The only chat this sender ever writes to. */
  recipient: string;
  factory: SenderSocketFactory;
  /** The spare number's session. Undefined when the stored session could not be read. */
  auth: EncryptedAuth | undefined;
  clock?: Clock;
  /** How long to wait for the connection to open. Default 60 s. */
  connectTimeoutMs?: number;
  /** How long each message may take, including the document upload. Default 120 s. */
  sendTimeoutMs?: number;
  /** How long the socket stays open after both messages left, for WhatsApp's acks and retry requests. Default 15 s. */
  lingerMs?: number;
}

/**
 * The second Baileys session, on the spare number. Connects only while a report is being sent, then disconnects.
 * It has one send method, and the recipient is fixed at construction.
 */
export class SenderGateway implements ReportSender {
  readonly #jid: string;
  readonly #opts: SenderGatewayOptions;
  readonly #clock: Clock;
  #status: SenderStatus;
  #sock: SenderSocketLike | undefined;
  #busy = false;
  #stopped = false;

  constructor(opts: SenderGatewayOptions) {
    this.#jid = recipientJid(opts.recipient);
    this.#opts = opts;
    this.#clock = opts.clock ?? systemClock;
    this.#status = { state: opts.auth?.hasSession ? 'idle' : 'not_linked', since: this.#clock.now().toISOString(), lastErrorCode: null };
  }

  status(): SenderStatus {
    return { ...this.#status };
  }

  async sendReport(text: string, xlsx: Buffer, fileName: string): Promise<SendResult> {
    const auth = this.#opts.auth;
    if (this.#stopped) return { status: 'failed', code: 'stopped' };
    if (this.#busy) return { status: 'failed', code: 'busy' };
    if (!auth?.hasSession) {
      this.#setState('not_linked', null);
      return { status: 'failed', code: 'not_linked' };
    }
    this.#busy = true;
    this.#setState('connecting', null);
    try {
      const opened = await openSocket(this.#opts.factory, auth, this.#opts.connectTimeoutMs ?? 60_000, undefined, (s) => {
        this.#sock = s;
      });
      if ('code' in opened) {
        this.#setState(FAILURE_STATE[opened.code] ?? 'idle', opened.statusCode);
        return { status: 'failed', code: opened.code };
      }
      if (this.#stopped) return { status: 'failed', code: 'stopped' }; // nothing has been sent yet
      this.#setState('open', null);
      // From here on a failure may hide a message that reached the founder: the outcome is unknown, never retried.
      try {
        const ids = [await this.#send(opened.sock, this.#jid, { text })];
        ids.push(await this.#send(opened.sock, this.#jid, { document: xlsx, mimetype: XLSX_MIME, fileName }));
        await delay(this.#opts.lingerMs ?? 15_000);
        return { status: 'sent', messageIds: ids };
      } catch (err) {
        return { status: 'unknown', code: err instanceof SendTimeoutError ? 'timeout' : 'send_error' };
      }
    } finally {
      const sock = this.#sock;
      this.#sock = undefined;
      if (sock) await endQuietly(sock);
      this.#busy = false;
      if (this.#status.state === 'connecting' || this.#status.state === 'open') this.#setState('idle', null);
    }
  }

  /** Ends a connection in progress. A send cut off this way comes back as unknown. Later sends are refused. */
  async stop(): Promise<void> {
    this.#stopped = true;
    const sock = this.#sock;
    this.#sock = undefined;
    if (sock) await endQuietly(sock);
  }

  /** The only call to a Baileys send method in the codebase (tests/wa/sendScan.test.ts). */
  async #send(sock: SenderSocketLike, jid: string, content: AnyMessageContent): Promise<string> {
    checkRecipient(jid, this.#jid);
    let timer: NodeJS.Timeout | undefined;
    try {
      const msg = await Promise.race([
        sock.sendMessage(jid, content),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SendTimeoutError()), this.#opts.sendTimeoutMs ?? 120_000);
        }),
      ]);
      const id = msg?.key.id;
      if (!id) throw new Error('WhatsApp returned no message id');
      return id;
    } finally {
      clearTimeout(timer);
    }
  }

  #setState(state: SenderState, code: number | null): void {
    this.#status = { state, since: this.#clock.now().toISOString(), lastErrorCode: code };
  }
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/wa/senderGateway.test.ts tests/wa/sendScan.test.ts tests/wa/gateway.test.ts`

Expected: PASS (11 sender tests, 4 scan tests, and the reader gateway tests unchanged).

- [ ] **Step 5: Run the full suite and the type-check**

Run: `npm test`, then `npm run typecheck`

Expected: every test passes and tsc prints nothing. (If only `tests/appMedia.test.ts` fails, see ground rule 12.)

- [ ] **Step 6: Commit**

```bash
git add src/wa/senderGateway.ts tests/wa/sendScan.test.ts tests/wa/senderGateway.test.ts
git commit -m "feat: spare-number sender gateway with a single send method, and a source scan so no other module sends" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Report scheduler

**Files:**
- Create: `src/report/scheduler.ts`
- Create: `tests/helpers/fakeReportSender.ts`
- Test: `tests/report/scheduler.test.ts` (fake clock, fake sender)

- [ ] **Step 1: Write the failing tests**

Create `tests/helpers/fakeReportSender.ts`:

```ts
import type { ReportSender, SenderStatus, SendResult } from '../../src/report/types.ts';

export class FakeReportSender implements ReportSender {
  /** Results handed out in order. Once empty, every send succeeds. */
  results: SendResult[] = [];
  calls: { text: string; xlsx: Buffer; fileName: string }[] = [];
  state: SenderStatus = { state: 'idle', since: '2026-10-23T00:00:00.000Z', lastErrorCode: null };
  /** When set, sendReport waits for it (a slow send). */
  gate: Promise<void> | undefined;
  /** When true, the next sendReport throws. */
  throwNext = false;
  stopped = 0;

  async sendReport(text: string, xlsx: Buffer, fileName: string): Promise<SendResult> {
    this.calls.push({ text, xlsx, fileName });
    await this.gate;
    if (this.throwNext) {
      this.throwNext = false;
      throw new Error('sender crashed');
    }
    return this.results.shift() ?? { status: 'sent', messageIds: ['msg-1', 'msg-2'] };
  }

  status(): SenderStatus {
    return this.state;
  }

  async stop(): Promise<void> {
    this.stopped++;
  }
}
```

Create `tests/report/scheduler.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { describeReport, ReportScheduler, retryWaitMs, UNKNOWN_WARNING, type ReportPayload } from '../../src/report/scheduler.ts';
import type { ReportSettings, SendResult } from '../../src/report/types.ts';
import { getKv, setKv } from '../../src/store/kv.ts';
import { claimReport, finishReport, REPORT_REQUEST_KEY, reportFor, type ReportRow } from '../../src/store/reports.ts';
import { manualClock } from '../../src/util/clock.ts';
import { silentLogger } from '../../src/util/logger.ts';
import { seededDb } from '../helpers/db.ts';
import { FakeReportSender } from '../helpers/fakeReportSender.ts';

const DAY = '2026-10-23';
const IST = (hm: string) => `${DAY}T${hm}:00.000+05:30`;
const iso = (hm: string) => new Date(IST(hm)).toISOString();
const ON: ReportSettings = { enabled: true, time: '06:00', deadline: '12:00' };
const failed = (code: string): SendResult => ({ status: 'failed', code });

function setup(o: { settings?: ReportSettings; build?: (now: Date) => Promise<ReportPayload> } = {}) {
  const db = seededDb();
  const clock = manualClock(IST('05:00'));
  const sender = new FakeReportSender();
  const s = new ReportScheduler({
    db, clock, log: silentLogger(), sender, settings: o.settings ?? ON, healthLine: () => ({ ok: true, text: '✅ Connected' }), build: o.build,
  });
  /** Moves the clock to an IST time today and runs one tick. */
  const at = async (hm: string) => {
    clock.set(IST(hm));
    await s.tick(clock.now());
  };
  return { db, clock, sender, s, at };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

describe('ReportScheduler', () => {
  it('sends once at 06:00, with the tracker attached', async () => {
    const { db, sender, at } = setup();
    await at('05:59');
    expect(sender.calls).toHaveLength(0);
    expect(reportFor(db, DAY)).toBeUndefined();
    await at('06:00');
    expect(sender.calls).toHaveLength(1);
    const call = sender.calls[0]!;
    expect(call.fileName).toBe('Tracker-2026-10-23.xlsx');
    expect(call.text.startsWith('Morning report · 23 Oct')).toBe(true);
    expect(call.xlsx.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(reportFor(db, DAY)).toMatchObject({ status: 'sent', detail: 'msg-1,msg-2', attempts: 1, forced: false });
    for (const hm of ['06:01', '09:00', '11:59']) await at(hm);
    expect(sender.calls).toHaveLength(1);
  });

  it('catches up at 09:30 after downtime', async () => {
    const { db, sender, at } = setup();
    await at('09:30');
    expect(sender.calls).toHaveLength(1);
    expect(reportFor(db, DAY)!.status).toBe('sent');
  });

  it('skips the day after 12:00 and says why', async () => {
    const { db, sender, s, at } = setup();
    await at('12:00');
    expect(sender.calls).toHaveLength(0);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'skipped', detail: 'not_running' });
    expect(s.health()).toEqual({ text: 'Morning report skipped today (the service was not running in time)', warning: null });
  });

  it('retries a definite failure after 2, 5, then 10 minutes', async () => {
    const { db, sender, s, at } = setup();
    sender.results = [failed('connect_timeout'), failed('connect_timeout'), failed('closed'), failed('closed')];
    await at('06:00');
    expect(reportFor(db, DAY)).toMatchObject({ status: 'retry', detail: 'connect_timeout', nextAttemptAt: iso('06:02') });
    expect(s.health().text).toBe('Morning report: not sent yet (could not connect to WhatsApp), next try 06:02 IST');
    await at('06:01');
    expect(sender.calls).toHaveLength(1);
    await at('06:02');
    expect(reportFor(db, DAY)!.nextAttemptAt).toBe(iso('06:07'));
    await at('06:06');
    expect(sender.calls).toHaveLength(2);
    await at('06:07');
    expect(reportFor(db, DAY)!.nextAttemptAt).toBe(iso('06:17'));
    await at('06:17');
    expect(reportFor(db, DAY)!.nextAttemptAt).toBe(iso('06:27'));
    await at('06:27');
    expect(sender.calls).toHaveLength(5);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'sent', attempts: 5 });
  });

  it('stops retrying at 12:00 and keeps the last reason', async () => {
    const { db, sender, at } = setup();
    sender.results = [failed('not_linked'), failed('not_linked')];
    await at('11:55');
    await at('12:00');
    expect(sender.calls).toHaveLength(1);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'skipped', detail: 'not_linked' });
  });

  it('never retries an unknown outcome', async () => {
    const { db, sender, s, at } = setup();
    sender.results = [{ status: 'unknown', code: 'timeout' }];
    await at('06:00');
    for (const hm of ['06:30', '11:00', '12:30']) await at(hm);
    expect(sender.calls).toHaveLength(1);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'unknown', detail: 'timeout' });
    expect(s.health()).toEqual({ text: 'Morning report: unknown, check WhatsApp', warning: UNKNOWN_WARNING });
  });

  it('turns a crash mid-send into unknown at start, and does not send that day again', async () => {
    const { db, clock, sender, s, at } = setup();
    claimReport(db, DAY, iso('06:00')); // the previous run died while sending
    clock.set(IST('06:20'));
    s.recover(clock.now());
    expect(reportFor(db, DAY)).toMatchObject({ status: 'unknown', detail: 'interrupted' });
    await at('06:30');
    expect(sender.calls).toHaveLength(0);
  });

  it('does nothing when disabled, and drops a send-now request', async () => {
    const { db, sender, s, at } = setup({ settings: { ...ON, enabled: false } });
    setKv(db, REPORT_REQUEST_KEY, DAY);
    await at('06:00');
    expect(sender.calls).toHaveLength(0);
    expect(reportFor(db, DAY)).toBeUndefined();
    expect(getKv(db, REPORT_REQUEST_KEY)).toBe('');
    expect(s.health()).toEqual({ text: 'Morning report: off', warning: null });
  });

  it('runs one send at a time', async () => {
    const { clock, sender, s } = setup();
    const g = gate();
    sender.gate = g.promise;
    clock.set(IST('06:00'));
    const first = s.tick(clock.now());
    await vi.waitFor(() => expect(sender.calls).toHaveLength(1));
    await s.tick(clock.now());
    expect(sender.calls).toHaveLength(1);
    g.release();
    await first;
  });

  it('records a sender crash as unknown and a build failure as a retry', async () => {
    const crash = setup();
    crash.sender.throwNext = true;
    await crash.at('06:00');
    expect(reportFor(crash.db, DAY)).toMatchObject({ status: 'unknown', detail: 'crash' });

    const broken = setup({ build: async () => Promise.reject(new Error('disk full')) });
    await broken.at('06:00');
    expect(broken.sender.calls).toHaveLength(0);
    expect(reportFor(broken.db, DAY)).toMatchObject({ status: 'retry', detail: 'build_failed', nextAttemptAt: iso('06:02') });
  });

  it('sends on a send-now request at any time, also after an unknown outcome, but never a second time', async () => {
    const { db, sender, at } = setup();
    claimReport(db, DAY, iso('06:00'));
    finishReport(db, DAY, 'unknown', 'timeout', iso('06:01'));
    setKv(db, REPORT_REQUEST_KEY, DAY);
    await at('15:00');
    expect(sender.calls).toHaveLength(1);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'sent', forced: true, attempts: 2 });
    expect(getKv(db, REPORT_REQUEST_KEY)).toBe('');
    setKv(db, REPORT_REQUEST_KEY, DAY);
    await at('15:01');
    expect(sender.calls).toHaveLength(1);
  });

  it('ignores a send-now request left from an earlier day', async () => {
    const { db, sender, at } = setup();
    setKv(db, REPORT_REQUEST_KEY, '2026-10-22');
    await at('15:00');
    expect(sender.calls).toHaveLength(0);
    expect(getKv(db, REPORT_REQUEST_KEY)).toBe('');
  });

  it('stop waits for the send in flight, stops the sender and starts no new send', async () => {
    const { db, clock, sender, s, at } = setup();
    const g = gate();
    sender.gate = g.promise;
    clock.set(IST('06:00'));
    const first = s.tick(clock.now());
    await vi.waitFor(() => expect(sender.calls).toHaveLength(1));
    const stopping = s.stop(5_000);
    g.release();
    await stopping;
    await first;
    expect(sender.stopped).toBe(1);
    expect(reportFor(db, DAY)!.status).toBe('sent');
    setKv(db, REPORT_REQUEST_KEY, DAY);
    await at('06:30');
    expect(sender.calls).toHaveLength(1);
  });
});

describe('describeReport', () => {
  const row = (o: Partial<ReportRow>): ReportRow => ({
    date: DAY, status: 'sent', detail: null, attempts: 1, nextAttemptAt: null, forced: false, createdAt: iso('06:00'), updatedAt: iso('06:01'), ...o,
  });
  const now = new Date(IST('07:00'));

  it('describes each state in plain words', () => {
    expect(describeReport(undefined, new Date(IST('05:00')), ON, 'idle').text).toBe('Morning report: due at 06:00 IST');
    expect(describeReport(undefined, now, ON, 'idle').text).toBe('Morning report: due now');
    expect(describeReport(row({}), now, ON, 'idle')).toEqual({ text: 'Morning report: sent at 06:01 IST', warning: null });
    expect(describeReport(row({ status: 'sending' }), now, ON, 'idle').text).toBe('Morning report: sending now');
    expect(describeReport(row({ status: 'skipped', detail: 'logged_out' }), now, ON, 'idle').text).toBe(
      'Morning report skipped today (the spare number was logged out)',
    );
    expect(describeReport(row({ status: 'skipped', detail: 'something_new' }), now, ON, 'idle').text).toBe('Morning report skipped today (something_new)');
  });

  it('warns when the owner has to act: unknown outcome, or a spare number that is unlinked or refused', () => {
    expect(describeReport(row({ status: 'unknown' }), now, ON, 'idle').warning).toBe(UNKNOWN_WARNING);
    expect(describeReport(undefined, now, ON, 'not_linked').warning).toContain('npm run cli -- link-sender');
    expect(describeReport(undefined, now, ON, 'logged_out').warning).toContain('link-sender --reset');
    expect(describeReport(undefined, now, ON, 'forbidden').warning).toContain('(403)');
    expect(describeReport(row({}), now, ON, 'idle').warning).toBeNull();
  });

  it('waits 2, 5, then 10 minutes', () => {
    expect([1, 2, 3, 4, 9].map(retryWaitMs)).toEqual([120_000, 300_000, 600_000, 600_000, 600_000]);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run tests/report/scheduler.test.ts`

Expected: FAIL. The test cannot resolve `../../src/report/scheduler.ts`.

- [ ] **Step 3: Implement**

The scheduler builds the real workbook with `buildWorkbook`, so the tests check that the attachment is a zip (it starts with `PK`). The `build` option is only a test seam for a build failure.

Create `src/report/scheduler.ts`:

```ts
import { loadTrackerView, type HealthLine } from '../output/view.ts';
import { buildWorkbook } from '../output/workbook.ts';
import type { Db } from '../store/db.ts';
import { getKv, setKv } from '../store/kv.ts';
import {
  claimReport, closeOldRetries, finishReport, markInterruptedReports, REPORT_REQUEST_KEY, reportFor, retryReport, skipReport, type ReportRow,
} from '../store/reports.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { istDate, istTime } from '../util/time.ts';
import { buildMorningText } from './morningReport.ts';
import type { ReportHealth, ReportSender, ReportSettings, SenderState, SendResult } from './types.ts';

/** Waits after a definite failure: 2 minutes, then 5, then 10 for every later try, until the deadline. */
export const RETRY_WAITS_MS = [2 * 60_000, 5 * 60_000, 10 * 60_000];

export function retryWaitMs(attempts: number): number {
  return RETRY_WAITS_MS[Math.min(Math.max(attempts, 1), RETRY_WAITS_MS.length) - 1]!;
}

/** Reason codes stored in reports.detail, in plain words for the status line. */
export const REASON_TEXT: Record<string, string> = {
  not_running: 'the service was not running in time',
  not_linked: 'the spare number is not linked',
  connect_timeout: 'could not connect to WhatsApp',
  closed: 'the WhatsApp connection closed before sending',
  restart_required: 'WhatsApp asked for a reconnect',
  logged_out: 'the spare number was logged out',
  forbidden: 'WhatsApp refused the spare number (403)',
  replaced: 'another session took over the spare number',
  build_failed: 'the report could not be built',
  busy: 'another send was running',
  stopped: 'the service was stopping',
  timeout: 'WhatsApp did not confirm in time',
  send_error: 'the send failed part-way',
  crash: 'the sender crashed',
  interrupted: 'the service stopped mid-send',
};

export const reasonText = (code: string | null): string => (code ? (REASON_TEXT[code] ?? code) : 'no reason recorded');

export const UNKNOWN_WARNING = '⚠️ Morning report: unknown, check WhatsApp. See docs/SETUP.md → "Morning report".';

const SENDER_WARNINGS: Partial<Record<SenderState, string>> = {
  not_linked: '⚠️ Morning report: the spare number is not linked. Stop the service and run: npm run cli -- link-sender',
  logged_out: '⚠️ Morning report: the spare number was logged out. Stop the service and run: npm run cli -- link-sender --reset',
  forbidden: '⚠️ Morning report: WhatsApp refused the spare number (403). Check the spare phone.',
  replaced: '⚠️ Morning report: another session took over the spare number. Restart the service.',
};

/** The Health and `cli status` line for one day. Pure: reads nothing. */
export function describeReport(row: ReportRow | undefined, now: Date, settings: ReportSettings, sender: SenderState): ReportHealth {
  const text = ((): string => {
    if (!row) {
      const hm = istTime(now);
      if (hm < settings.time) return `Morning report: due at ${settings.time} IST`;
      if (hm < settings.deadline) return 'Morning report: due now';
      return `Morning report skipped today (${reasonText('not_running')})`;
    }
    switch (row.status) {
      case 'sent':
        return `Morning report: sent at ${istTime(new Date(row.updatedAt))} IST`;
      case 'sending':
        return 'Morning report: sending now';
      case 'retry':
        return `Morning report: not sent yet (${reasonText(row.detail)}), next try ${istTime(new Date(row.nextAttemptAt ?? row.updatedAt))} IST`;
      case 'unknown':
        return 'Morning report: unknown, check WhatsApp';
      case 'skipped':
        return `Morning report skipped today (${reasonText(row.detail)})`;
    }
  })();
  return { text, warning: row?.status === 'unknown' ? UNKNOWN_WARNING : (SENDER_WARNINGS[sender] ?? null) };
}

export interface ReportPayload {
  text: string;
  xlsx: Buffer;
  fileName: string;
}

export interface ReportSchedulerOptions {
  db: Db;
  clock: Clock;
  log: Logger;
  sender: ReportSender;
  settings: ReportSettings;
  /** The health line printed in the attached workbook (Health.workbookLine). */
  healthLine: () => HealthLine;
  /** Test seam: replaces building the text and the workbook from the tracker. */
  build?: (now: Date) => Promise<ReportPayload>;
}

/**
 * Decides when the morning report goes out, and records every attempt in the reports table. The row is claimed before
 * any send, so a date is sent at most once; an unknown outcome is never retried automatically. Makes no AI call.
 */
export class ReportScheduler {
  readonly #o: ReportSchedulerOptions;
  #inFlight: Promise<void> | undefined;
  #stopped = false;

  constructor(o: ReportSchedulerOptions) {
    this.#o = o;
  }

  /** At service start: a row still 'sending' was cut off by a crash or a stop mid-send, so its outcome is unknown. */
  recover(now: Date = this.#o.clock.now()): void {
    const count = markInterruptedReports(this.#o.db, now.toISOString());
    if (count > 0) this.#o.log.warn({ count }, 'morning report was cut off mid-send; marked unknown, not retried');
  }

  /** Called from the app tick (every 30 s). Never throws. Resolves when a send it started has finished. */
  async tick(now: Date = this.#o.clock.now()): Promise<void> {
    if (this.#inFlight || this.#stopped) return;
    const run = this.#run(now);
    this.#inFlight = run;
    try {
      await run;
    } finally {
      this.#inFlight = undefined;
    }
  }

  /** Today's line for Health. */
  health(now: Date = this.#o.clock.now()): ReportHealth {
    if (!this.#o.settings.enabled) return { text: 'Morning report: off', warning: null };
    return describeReport(reportFor(this.#o.db, istDate(now)), now, this.#o.settings, this.#o.sender.status().state);
  }

  /** Starts no new send, waits up to waitMs for the send in flight, then stops the sender. Leaves no timers. */
  async stop(waitMs: number): Promise<void> {
    this.#stopped = true;
    const inFlight = this.#inFlight;
    if (inFlight) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([inFlight, new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]);
      clearTimeout(timer);
    }
    try {
      await this.#o.sender.stop();
    } catch (err) {
      this.#o.log.error({ err }, 'stopping the report sender failed');
    }
  }

  async #run(now: Date): Promise<void> {
    const { db, settings, log } = this.#o;
    try {
      const date = istDate(now);
      const at = now.toISOString();
      const requested = getKv(db, REPORT_REQUEST_KEY);
      if (requested) setKv(db, REPORT_REQUEST_KEY, ''); // a request is used once, whatever happens next
      if (!settings.enabled) return;
      closeOldRetries(db, date, at);
      if (requested === date) {
        if (claimReport(db, date, at, { force: true })) await this.#send(date, now);
        else log.info({ date }, 'send-now request ignored: today is already sent or being sent');
        return;
      }
      const hm = istTime(now);
      if (hm < settings.time) return;
      if (hm >= settings.deadline) {
        const row = reportFor(db, date);
        const reason = row?.detail ?? 'not_running';
        if ((!row || row.status === 'retry') && skipReport(db, date, reason, at)) log.warn({ date, reason }, 'morning report skipped today');
        return;
      }
      if (claimReport(db, date, at)) await this.#send(date, now);
    } catch (err) {
      log.error({ err }, 'morning report tick failed');
    }
  }

  async #send(date: string, now: Date): Promise<void> {
    const { db, log, sender } = this.#o;
    let payload: ReportPayload;
    try {
      payload = await (this.#o.build ?? ((n: Date) => this.#build(n)))(now);
    } catch (err) {
      log.error({ err }, 'morning report could not be built');
      this.#retry(date, 'build_failed');
      return;
    }
    let result: SendResult;
    try {
      result = await sender.sendReport(payload.text, payload.xlsx, payload.fileName);
    } catch (err) {
      log.error({ err }, 'morning report sender crashed');
      result = { status: 'unknown', code: 'crash' };
    }
    const at = this.#o.clock.now().toISOString();
    if (result.status === 'sent') {
      finishReport(db, date, 'sent', result.messageIds.join(','), at);
      log.info({ date }, 'morning report sent');
    } else if (result.status === 'unknown') {
      finishReport(db, date, 'unknown', result.code, at);
      log.warn({ date, code: result.code }, 'morning report outcome unknown; not retried automatically');
    } else {
      this.#retry(date, result.code);
    }
  }

  #retry(date: string, code: string): void {
    const now = this.#o.clock.now();
    const next = new Date(now.getTime() + retryWaitMs(reportFor(this.#o.db, date)?.attempts ?? 1)).toISOString();
    retryReport(this.#o.db, date, code, next, now.toISOString());
    this.#o.log.warn({ date, code, nextAttemptAt: next }, 'morning report not sent; will try again');
  }

  async #build(now: Date): Promise<ReportPayload> {
    const view = loadTrackerView(this.#o.db, now, this.#o.healthLine());
    return { text: buildMorningText(view, view.today), xlsx: await buildWorkbook(view), fileName: `Tracker-${view.today}.xlsx` };
  }
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/report/scheduler.test.ts`

Expected: PASS (16 tests).

- [ ] **Step 5: Run the full suite and the type-check**

Run: `npm test`, then `npm run typecheck`

Expected: every test passes and tsc prints nothing. (If only `tests/appMedia.test.ts` fails, see ground rule 12.)

- [ ] **Step 6: Commit**

```bash
git add src/report/scheduler.ts tests/helpers/fakeReportSender.ts tests/report/scheduler.test.ts
git commit -m "feat: morning report scheduler: claim before send, waits of 2/5/10 minutes, unknown never retried" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: Wiring: app, service start, Health and cli status

**Files:**
- Modify: `src/health/health.ts` (`setReport`, snapshot `report`, warning rank)
- Modify: `src/cli/status.ts` (`Report:` line)
- Modify: `src/app.ts` (`AppReportDeps`, scheduler in tick, start and stop)
- Modify: `src/main.ts` (sender session, `SenderGateway`, settings)
- Test: `tests/health/healthReport.test.ts`, `tests/appReport.test.ts`
- Modify: `tests/cli/status.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/health/healthReport.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Health, readHealthSnapshot } from '../../src/health/health.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { getKv, setKv } from '../../src/store/kv.ts';
import { manualClock } from '../../src/util/clock.ts';
import { seededDb } from '../helpers/db.ts';

const SENT = { text: 'Morning report: sent at 06:00 IST', warning: null };
const UNKNOWN = { text: 'Morning report: unknown, check WhatsApp', warning: '⚠️ Morning report: unknown, check WhatsApp. See docs/SETUP.md → "Morning report".' };

function setup(freeBytes: () => number | null = () => 200e9) {
  const db = seededDb();
  const clock = manualClock('2026-10-23T02:00:00Z');
  const spend = new SpendGuard({ db, clock, capUsd: 1 });
  const h = new Health({ db, clock, spend, freeBytes });
  h.setWhatsApp({ state: 'open', since: '2026-10-23T02:00:00.000Z', lastErrorCode: null, credsSaveFailures: 0 });
  return { db, h };
}

describe('Health and the morning report', () => {
  it('warns only when the owner has to act', () => {
    const { h } = setup();
    h.setReport(SENT);
    expect(h.line().ok).toBe(true);
    h.setReport(UNKNOWN);
    expect(h.line()).toEqual({ ok: false, text: UNKNOWN.warning });
    expect(h.workbookLine().text).toBe(UNKNOWN.warning);
    h.setReport(null);
    expect(h.line().ok).toBe(true);
  });

  it('shared-file warnings outrank it, and it outranks low disk', () => {
    const { h } = setup(() => 5e9);
    h.setReport(UNKNOWN);
    expect(h.line().text).toBe(UNKNOWN.warning);
    h.setMedia({ pending: 1, stale: 1, spendCap: 0, failedRecent: 0, uploadFailed: 0 });
    expect(h.line().text).toBe('⚠️ 1 shared file waiting over 30 minutes to be read. See docs/SETUP.md.');
  });

  it('records the report line in the snapshot; snapshots without one still parse, bad ones do not', () => {
    const { db, h } = setup();
    h.persist();
    expect(readHealthSnapshot(db)!.report).toBeUndefined();
    h.setReport(SENT);
    h.persist();
    expect(readHealthSnapshot(db)!.report).toEqual(SENT);
    const stored = JSON.parse(getKv(db, 'health')!) as Record<string, unknown>;
    setKv(db, 'health', JSON.stringify({ ...stored, report: { text: 5, warning: null } }));
    expect(readHealthSnapshot(db)).toBeUndefined();
  });
});
```

Create `tests/appReport.test.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type App, type AppReportDeps } from '../src/app.ts';
import { readHealthSnapshot } from '../src/health/health.ts';
import { UNKNOWN_WARNING } from '../src/report/scheduler.ts';
import type { Prices } from '../src/spend/pricing.ts';
import type { Db } from '../src/store/db.ts';
import { claimReport, reportFor } from '../src/store/reports.ts';
import { systemClock } from '../src/util/clock.ts';
import { silentLogger } from '../src/util/logger.ts';
import { AllowList } from '../src/wa/allowlist.ts';
import { openSessionDb, useEncryptedAuthState } from '../src/wa/authState.ts';
import { WhatsAppGateway } from '../src/wa/gateway.ts';
import { FakeAi } from './helpers/ai.ts';
import { MEHTA, seededDb, SHARMA } from './helpers/db.ts';
import { FakeDrive } from './helpers/fakeDrive.ts';
import { FakeReportSender } from './helpers/fakeReportSender.ts';
import { FakeSocket, SEND_METHODS } from './helpers/fakeSocket.ts';

const P: Prices = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 };
const DAY = '2026-10-23';
const ON = { enabled: true, time: '06:00', deadline: '12:00' };

function setup(report?: AppReportDeps, db: Db = seededDb()) {
  const sockets: FakeSocket[] = [];
  const auth = useEncryptedAuthState(openSessionDb(':memory:'), randomBytes(32));
  const allow = new AllowList([SHARMA.groupId, MEHTA.groupId]);
  const gateway = new WhatsAppGateway({
    allow,
    factory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    auth: auth.state,
    saveCreds: auth.saveCreds,
  });
  const app = createApp({
    db, clock: systemClock, log: silentLogger(), gateway, allow, ai: new FakeAi(), drive: new FakeDrive(), prices: P, spendCapUsd: 15,
    quietMs: 240_000, maxWaitMs: 1_200_000, maxConcurrent: 3, dataDir: '.', freeBytes: () => 500e9, pollMs: 30_000, report,
  });
  app.start();
  sockets[0]!.emit('connection.update', { connection: 'open' });
  return { db, app, sockets };
}

/** stop() ends with a final upload whose workbook build runs on fake timers: advance until it resolves. */
async function stopApp(app: App): Promise<void> {
  let done = false;
  const p = app.stop().then(() => {
    done = true;
  });
  for (let i = 0; i < 30 && !done; i++) await vi.advanceTimersByTimeAsync(1_000);
  await p;
}

describe('app and the morning report', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-23T00:30:00.000Z')); // 06:00 IST
  });
  afterEach(() => vi.useRealTimers());

  it('sends the report from the tick at 06:00, shows it in Health, and the founder-number gateway still sends nothing', async () => {
    const sender = new FakeReportSender();
    const { db, app, sockets } = setup({ sender, settings: ON });
    for (let i = 0; i < 30 && reportFor(db, DAY)?.status !== 'sent'; i++) await vi.advanceTimersByTimeAsync(1_000);
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]!.fileName).toBe('Tracker-2026-10-23.xlsx');
    expect(app.report).toBeDefined();
    await vi.advanceTimersByTimeAsync(30_000); // the next tick records the line
    expect(readHealthSnapshot(db)!.report).toEqual({ text: 'Morning report: sent at 06:00 IST', warning: null });
    for (const name of SEND_METHODS) expect(sockets[0]![name]).not.toHaveBeenCalled();
    await stopApp(app);
    expect(sender.stopped).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('turns a send cut off by a crash into unknown at start, sends nothing, and warns in Health', async () => {
    const db = seededDb();
    claimReport(db, DAY, '2026-10-23T00:29:00.000Z');
    const sender = new FakeReportSender();
    const { app } = setup({ sender, settings: ON }, db);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'unknown', detail: 'interrupted' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sender.calls).toHaveLength(0);
    const snap = readHealthSnapshot(db)!;
    expect(snap.line.text).toBe(UNKNOWN_WARNING);
    expect(snap.report?.warning).toBe(UNKNOWN_WARNING);
    await stopApp(app);
  });

  it('without report settings there is no scheduler, no report row and no report line', async () => {
    const { db, app } = setup();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(app.report).toBeUndefined();
    expect(readHealthSnapshot(db)!.report).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM reports').get()).toEqual({ n: 0 });
    await stopApp(app);
  });
});
```

Append to the end of `tests/cli/status.test.ts` (after one blank line):

```ts
describe('formatStatus and the morning report', () => {
  it('prints the report line when the service reports one', () => {
    expect(formatStatus({ ...base, snapshot })).not.toContain('Report:');
    const out = formatStatus({ ...base, snapshot: { ...snapshot, report: { text: 'Morning report: sent at 06:00 IST', warning: null } } });
    expect(out).toContain('Report:      Morning report: sent at 06:00 IST');
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run tests/health/healthReport.test.ts tests/appReport.test.ts tests/cli/status.test.ts`

Expected: FAIL. `h.setReport` is not a function; `createApp` ignores `report`, so nothing is sent and `app.report` is undefined; `formatStatus` prints no `Report:` line.

- [ ] **Step 3: Implement**

`src/main.ts` has no unit test (tests never start the service); the type-check covers it. When `REPORT_ENABLED` is not true, `main.ts` opens no sender session and passes no `report`, so the app behaves exactly as before.

In `src/health/health.ts`, replace:

```ts
import type { HealthLine } from '../output/view.ts';
```

with:

```ts
import type { HealthLine } from '../output/view.ts';
import type { ReportHealth } from '../report/types.ts';
```

In `src/health/health.ts`, replace:

```ts
  media?: MediaHealth;
}
```

with:

```ts
  media?: MediaHealth;
  /** The morning report's line (Phase 2c). Missing when the report is off, and in older snapshots. */
  report?: ReportHealth;
}
```

In `src/health/health.ts`, replace:

```ts
  #media: MediaHealth = { pending: 0, stale: 0, spendCap: 0, failedRecent: 0, uploadFailed: 0 };
```

with:

```ts
  #media: MediaHealth = { pending: 0, stale: 0, spendCap: 0, failedRecent: 0, uploadFailed: 0 };
  #report: ReportHealth | null = null;
```

In `src/health/health.ts`, replace:

```ts
  forget(clientId: number): void {
```

with:

```ts
  /** Stores the morning report's line; the next persist() records it. Null when the report is off. */
  setReport(r: ReportHealth | null): void {
    this.#report = r;
  }

  forget(clientId: number): void {
```

In `src/health/health.ts`, replace:

```ts
    const free = this.#freeGb();
    if (free !== null && free < LOW_DISK_GB)
```

with:

```ts
    // The morning report warns only when the owner must act: an unknown outcome, or a spare number that is unlinked.
    if (this.#report?.warning) return { ok: false, text: this.#report.warning };
    const free = this.#freeGb();
    if (free !== null && free < LOW_DISK_GB)
```

In `src/health/health.ts`, replace:

```ts
      media: { ...this.#media },
    };
```

with:

```ts
      media: { ...this.#media },
      ...(this.#report ? { report: { ...this.#report } } : {}),
    };
```

In `src/health/health.ts`, replace:

```ts
export function readHealthSnapshot(db: Db): HealthSnapshot | undefined {
```

with:

```ts
const isReportHealth = (r: unknown): r is ReportHealth => {
  const x = r as Record<string, unknown> | null;
  return typeof x === 'object' && x !== null && typeof x.text === 'string' && (x.warning === null || typeof x.warning === 'string');
};

export function readHealthSnapshot(db: Db): HealthSnapshot | undefined {
```

In `src/health/health.ts`, replace:

```ts
    if (o.media !== undefined && !isMediaHealth(o.media)) return undefined;
```

with:

```ts
    if (o.media !== undefined && !isMediaHealth(o.media)) return undefined;
    // Snapshots written before the morning report existed, or with it off, have no report line.
    if (o.report !== undefined && !isReportHealth(o.report)) return undefined;
```

In `src/cli/status.ts`, replace:

```ts
    lines.push(`Spend today: ${lk}$${s.spentToday.toFixed(2)} of $${s.capUsd.toFixed(2)}`);
```

with:

```ts
    if (s.report) lines.push(`Report:      ${lk}${s.report.text}`);
    lines.push(`Spend today: ${lk}$${s.spentToday.toFixed(2)} of $${s.capUsd.toFixed(2)}`);
```

In `src/app.ts`, replace:

```ts
import { buildWorkbook } from './output/workbook.ts';
```

with:

```ts
import { buildWorkbook } from './output/workbook.ts';
import { ReportScheduler } from './report/scheduler.ts';
import type { ReportSender, ReportSettings } from './report/types.ts';
```

In `src/app.ts`, replace:

```ts
export interface AppDeps {
```

with:

```ts
/** The Phase 2c morning report. Only the spare-number sender can send; the founder-number gateway still cannot. */
export interface AppReportDeps {
  sender: ReportSender;
  settings: ReportSettings;
}

export interface AppDeps {
```

In `src/app.ts`, replace:

```ts
  /** The Phase 2a media pipeline. Without it, shared files are recorded as not downloaded. */
  media?: AppMediaDeps;
}
```

with:

```ts
  /** The Phase 2a media pipeline. Without it, shared files are recorded as not downloaded. */
  media?: AppMediaDeps;
  /** The Phase 2c morning report. Without it, no report is sent and Health has no report line. */
  report?: AppReportDeps;
}
```

In `src/app.ts`, replace:

```ts
  /** Undefined without media dependencies. */
  mediaQueue: MediaQueue | undefined;
}
```

with:

```ts
  /** Undefined without media dependencies. */
  mediaQueue: MediaQueue | undefined;
  /** Undefined without report dependencies. */
  report: ReportScheduler | undefined;
}
```

In `src/app.ts`, replace:

```ts
/** Wires gateway -> ingestor -> media queue / debouncer -> reconciler -> publisher. Never sends anything to WhatsApp. */
```

with:

```ts
/**
 * Wires gateway -> ingestor -> media queue / debouncer -> reconciler -> publisher. The founder-number gateway never sends
 * anything. The only sender is the optional morning report's, on the spare number, to REPORT_RECIPIENT only.
 */
```

In `src/app.ts`, replace:

```ts
  const health = new Health({ db: d.db, clock: d.clock, spend, dataDir: d.dataDir, freeBytes: d.freeBytes });
```

with:

```ts
  const health = new Health({ db: d.db, clock: d.clock, spend, dataDir: d.dataDir, freeBytes: d.freeBytes });
  const reportScheduler = d.report
    ? new ReportScheduler({
        db: d.db, clock: d.clock, log: d.log, sender: d.report.sender, settings: d.report.settings, healthLine: () => health.workbookLine(),
      })
    : undefined;
```

In `src/app.ts`, replace:

```ts
      refreshMedia();
      // A line that changes
```

with:

```ts
      refreshMedia();
      if (reportScheduler) {
        // tick() never throws. A send runs on in the background; the claim is already written when it returns.
        void reportScheduler.tick(d.clock.now());
        health.setReport(reportScheduler.health(d.clock.now()));
      }
      // A line that changes
```

In `src/app.ts`, replace:

```ts
    mediaQueue,
    start() {
      if (poll) return; // already started: a second interval would outlive stop()
```

with:

```ts
    mediaQueue,
    report: reportScheduler,
    start() {
      if (poll) return; // already started: a second interval would outlive stop()
      if (reportScheduler) {
        try {
          reportScheduler.recover(d.clock.now()); // a send cut off by a crash becomes unknown, never sent again by itself
        } catch (err) {
          d.log.error({ err }, 'morning report recovery failed');
        }
      }
```

In `src/app.ts`, replace:

```ts
      await Promise.all([publisher.flush(10_000), uploader?.stop(10_000)]);
```

with:

```ts
      // A morning report still sending gets the same 10 s; if it is cut off, the next start marks it unknown.
      await Promise.all([publisher.flush(10_000), uploader?.stop(10_000), reportScheduler?.stop(10_000)]);
```

In `src/main.ts`, replace:

```ts
import { createApp } from './app.ts';
```

with:

```ts
import { createApp, type AppReportDeps } from './app.ts';
```

In `src/main.ts`, replace:

```ts
import { loadEnv, requireKey } from './config/env.ts';
```

with:

```ts
import { loadEnv, maskNumber, reportRecipient, reportSettings, requireKey } from './config/env.ts';
```

In `src/main.ts`, replace:

```ts
import { masterKeyPath, sessionDbPath, trackerDbPath } from './config/paths.ts';
```

with:

```ts
import { masterKeyPath, senderSessionDbPath, sessionDbPath, trackerDbPath } from './config/paths.ts';
```

In `src/main.ts`, replace:

```ts
import { openSessionDb, SessionDecryptError, useEncryptedAuthState } from './wa/authState.ts';
```

with:

```ts
import {
  openSessionDb, SenderSessionDecryptError, SessionDecryptError, useEncryptedAuthState, useSenderAuthState, type EncryptedAuth,
} from './wa/authState.ts';
```

In `src/main.ts`, replace:

```ts
import { baileysSocketFactory, WhatsAppGateway } from './wa/gateway.ts';
```

with:

```ts
import { baileysSocketFactory, WhatsAppGateway } from './wa/gateway.ts';
import { baileysSenderSocketFactory, SenderGateway } from './wa/senderGateway.ts';
```

In `src/main.ts`, replace:

```ts
  let sessionDb: Db | undefined;

  /** Stops startup
```

with:

```ts
  let sessionDb: Db | undefined;
  let senderDb: Db | undefined;

  /** Stops startup
```

In `src/main.ts`, replace:

```ts
    const prices = pricesFromEnv(env);
```

with:

```ts
    // Phase 2c: the morning report from the spare number. A missing or unreadable spare-number session never stops the
    // service: each day's report is skipped and Health says why.
    let report: AppReportDeps | undefined;
    if (env.REPORT_ENABLED) {
      senderDb = openSessionDb(senderSessionDbPath(env.DATA_DIR));
      let senderAuth: EncryptedAuth | undefined;
      try {
        senderAuth = useSenderAuthState(senderDb, key);
      } catch (e) {
        if (!(e instanceof SenderSessionDecryptError)) throw e;
        log.error(e.message);
      }
      const recipient = reportRecipient(env);
      report = {
        settings: reportSettings(env),
        sender: new SenderGateway({ recipient, factory: baileysSenderSocketFactory(silentLogger()), auth: senderAuth }),
      };
      log.info({ recipient: maskNumber(recipient), linked: senderAuth?.hasSession ?? false }, 'morning report enabled');
    }

    const prices = pricesFromEnv(env);
```

In `src/main.ts`, replace:

```ts
      media: { sealer: new MediaRefSealer(key), fetcher: baileysFetcher(), ai: new ClaudeMediaClient({ apiKey, model: env.AI_MODEL, prices }) },
    });
```

with:

```ts
      media: { sealer: new MediaRefSealer(key), fetcher: baileysFetcher(), ai: new ClaudeMediaClient({ apiKey, model: env.AI_MODEL, prices }) },
      report,
    });
```

In `src/main.ts`, replace:

```ts
    const sessionStore = sessionDb;
```

with:

```ts
    const sessionStore = sessionDb;
    const senderStore = senderDb;
```

In `src/main.ts`, replace:

```ts
            trackerDb.close();
            sessionStore.close();
```

with:

```ts
            trackerDb.close();
            sessionStore.close();
            senderStore?.close();
```

In `src/main.ts`, replace:

```ts
      db?.close();
      sessionDb?.close();
    } catch {
```

with:

```ts
      db?.close();
      sessionDb?.close();
      senderDb?.close();
    } catch {
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/health/healthReport.test.ts tests/appReport.test.ts tests/cli/status.test.ts`

Expected: PASS (3 Health tests, 3 app tests, and the status tests including the new one).

- [ ] **Step 5: Run the full suite and the type-check**

Run: `npm test`, then `npm run typecheck`

Expected: every test passes and tsc prints nothing. (If only `tests/appMedia.test.ts` fails, see ground rule 12.)

- [ ] **Step 6: Commit**

```bash
git add src/app.ts src/cli/status.ts src/health/health.ts src/main.ts tests/appReport.test.ts tests/cli/status.test.ts tests/health/healthReport.test.ts
git commit -m "feat: wire the morning report into the app, the service start, Health and cli status" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: CLI: link-sender, report status, report send-now

**Files:**
- Modify: `src/cli/commands.ts` (`linkSenderCommand`, `reportStatusCommand`, `reportSendNowCommand`, optional `senderSocketFactory` and `senderSettleMs` in `CliDeps`)
- Modify: `src/cli.ts` (register the commands)
- Test: `tests/cli/report.test.ts`

The two new `CliDeps` fields are optional, so the existing `deps()` helper in `tests/cli/commands.test.ts` needs no change.

- [ ] **Step 1: Write the failing tests**

Create `tests/cli/report.test.ts`:

```ts
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmCancelled, linkSenderCommand, reportSendNowCommand, reportStatusCommand, type CliDeps } from '../../src/cli/commands.ts';
import { parseEnv } from '../../src/config/env.ts';
import { senderSessionDbPath, sessionDbPath, trackerDbPath } from '../../src/config/paths.ts';
import { StaticKeyProvider } from '../../src/crypto/keyProvider.ts';
import type { HealthSnapshot } from '../../src/health/health.ts';
import { openDb, type Db } from '../../src/store/db.ts';
import { getKv, setKv } from '../../src/store/kv.ts';
import { claimReport, finishReport, REPORT_REQUEST_KEY, skipReport } from '../../src/store/reports.ts';
import { acquireLock } from '../../src/util/lock.ts';
import { openSessionDb, useSenderAuthState } from '../../src/wa/authState.ts';
import { closeWith, FakeSocket, SEND_METHODS } from '../helpers/fakeSocket.ts';

const KEY = Buffer.alloc(32, 7);
const NOW = new Date('2026-10-23T03:30:00.000Z'); // 09:00 IST
const DAY = '2026-10-23';
const NUMBER = '919812345678';

type Script = (s: FakeSocket) => void;
const open: Script = (s) => s.emit('connection.update', { connection: 'open' });

let dir: string;
let dataDir: string;
let lines: string[];
let sockets: FakeSocket[];
let scripts: Script[];
let confirm: ReturnType<typeof vi.fn<(q: string) => Promise<boolean>>>;

function deps(env: Record<string, string> = {}): CliDeps {
  return {
    env: parseEnv({ DATA_DIR: dataDir, GROUPS_FILE: join(dir, 'groups.json'), REPORT_ENABLED: 'true', REPORT_RECIPIENT: NUMBER, ...env }),
    keyProvider: new StaticKeyProvider(KEY),
    socketFactory: () => {
      throw new Error('the founder-number socket must not be used');
    },
    senderSocketFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      const script = scripts.shift() ?? open;
      queueMicrotask(() => script(s));
      return s;
    },
    senderSettleMs: 0,
    out: (l) => void lines.push(l),
    confirm,
    linkTimeoutMs: 1_000,
    quietMs: { link: 5_000, listGroups: 3_000 },
    maxIngestMs: { link: 10_000, listGroups: 6_000 },
  };
}

const out = () => lines.join('\n');

function withTracker<T>(fn: (db: Db) => T): T {
  const db = openDb(trackerDbPath(dataDir));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function writeSnapshot(at: Date): void {
  const snap: HealthSnapshot = {
    at: at.toISOString(), line: { ok: true, text: '✅ Connected' }, whatsapp: { state: 'open', since: at.toISOString(), lastErrorCode: null, credsSaveFailures: 0 },
    downSince: null, failed: [], lastSuccessAt: null, lastPublishedAt: null, spentToday: 0, capUsd: 15, freeGb: 100, publishFailingSince: null,
    ingestFailures: 0,
  };
  withTracker((db) => setKv(db, 'health', JSON.stringify(snap)));
}

async function seedSender(): Promise<void> {
  const sdb = openSessionDb(senderSessionDbPath(dataDir));
  const auth = useSenderAuthState(sdb, KEY);
  auth.state.creds.me = { id: '919800000099:2@s.whatsapp.net', name: 'Spare' };
  await auth.saveCreds();
  sdb.close();
}

const senderLinked = (): boolean => {
  const sdb = openSessionDb(senderSessionDbPath(dataDir));
  try {
    return useSenderAuthState(sdb, KEY).hasSession;
  } finally {
    sdb.close();
  }
};

const request = () => withTracker((db) => getKv(db, REPORT_REQUEST_KEY));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-report-'));
  dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  lines = [];
  sockets = [];
  scripts = [];
  confirm = vi.fn(async () => true);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('cli link-sender', () => {
  it('links the spare number by QR into its own file, without touching the founder session or sending anything', async () => {
    scripts = [
      (s) => {
        s.emit('connection.update', { qr: 'QR-1' });
        closeWith(s, 515);
      },
      open,
    ];
    await linkSenderCommand({ reset: false }, deps());
    expect(out()).toContain('SPARE phone');
    expect(out()).toContain('Spare number linked.');
    expect(existsSync(senderSessionDbPath(dataDir))).toBe(true);
    expect(existsSync(sessionDbPath(dataDir))).toBe(false);
    expect(sockets).toHaveLength(2);
    for (const s of sockets) for (const name of SEND_METHODS) expect(s[name]).not.toHaveBeenCalled();
    const lock = await acquireLock(dataDir); // released by the command
    await lock.release();
  });

  it('refuses while the service holds the data folder', async () => {
    const lock = await acquireLock(dataDir);
    try {
      await expect(linkSenderCommand({ reset: false }, deps())).rejects.toThrow(/Another WA Agent process/);
    } finally {
      await lock.release();
    }
    expect(sockets).toHaveLength(0);
  });

  it('says so when the spare number is already linked, and connects nothing', async () => {
    await seedSender();
    await linkSenderCommand({ reset: false }, deps());
    expect(out()).toContain('already linked');
    expect(sockets).toHaveLength(0);
  });

  it('--reset asks first, and "no" keeps the session', async () => {
    await seedSender();
    confirm.mockResolvedValue(false);
    await linkSenderCommand({ reset: true }, deps());
    expect(confirm.mock.calls[0]![0]).toContain('data/sender-session.db');
    expect(out()).toContain('Nothing was changed.');
    expect(senderLinked()).toBe(true);
    expect(sockets).toHaveLength(0);
  });

  it('--reset with yes deletes only the spare session and links again', async () => {
    await seedSender();
    await linkSenderCommand({ reset: true }, deps());
    expect(out()).toContain('Reset: the saved spare-number session was deleted.');
    expect(out()).toContain('Spare number linked.');
    expect(existsSync(sessionDbPath(dataDir))).toBe(false);
  });

  it('explains a refused link', async () => {
    scripts = [(s) => closeWith(s, 401)];
    await expect(linkSenderCommand({ reset: false }, deps())).rejects.toThrow(/link-sender --reset/);
  });
});

describe('cli report status', () => {
  it('shows the settings, today and the last days, with the number masked', () => {
    withTracker((db) => {
      skipReport(db, '2026-10-21', 'connect_timeout', '2026-10-21T06:30:00.000Z');
      claimReport(db, '2026-10-22', '2026-10-22T00:30:00.000Z');
      finishReport(db, '2026-10-22', 'sent', 'msg-1,msg-2', '2026-10-22T00:31:00.000Z');
      claimReport(db, DAY, '2026-10-23T00:30:00.000Z');
      finishReport(db, DAY, 'unknown', 'timeout', '2026-10-23T00:33:00.000Z');
    });
    reportStatusCommand(deps());
    expect(lines).toEqual([
      'Morning report: on, 06:00 to 12:00 IST, to the number ending …5678',
      'Today (2026-10-23): Morning report: unknown, check WhatsApp',
      'Last days:',
      '  2026-10-22  sent    at 06:01 IST',
      '  2026-10-21  skipped could not connect to WhatsApp',
    ]);
    expect(out()).not.toContain(NUMBER);
  });

  it('says when the report is off', () => {
    reportStatusCommand(deps({ REPORT_ENABLED: 'false' }));
    expect(lines).toEqual(['Morning report: off (set REPORT_ENABLED=true and REPORT_RECIPIENT in .env, then restart the service)']);
  });
});

describe('cli report send-now', () => {
  it('asks, then hands the request to the running service', async () => {
    writeSnapshot(NOW);
    await reportSendNowCommand(deps());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0]).toContain('the number ending …5678');
    expect(confirm.mock.calls[0]![0]).not.toContain(NUMBER);
    expect(request()).toBe(DAY);
    expect(out()).toContain('Requested.');
  });

  it('refuses without asking when today was already sent', async () => {
    writeSnapshot(NOW);
    withTracker((db) => {
      claimReport(db, DAY, '2026-10-23T00:30:00.000Z');
      finishReport(db, DAY, 'sent', 'msg-1,msg-2', '2026-10-23T00:31:00.000Z');
    });
    await reportSendNowCommand(deps());
    expect(out()).toBe("Today's report was already sent at 06:01 IST. Nothing was sent.");
    expect(confirm).not.toHaveBeenCalled();
    expect(request()).toBeUndefined();
  });

  it('refuses while a send is running', async () => {
    writeSnapshot(NOW);
    withTracker((db) => claimReport(db, DAY, '2026-10-23T03:29:00.000Z'));
    await reportSendNowCommand(deps());
    expect(out()).toContain('being sent right now');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('refuses when the service is not running', async () => {
    await reportSendNowCommand(deps());
    writeSnapshot(new Date(NOW.getTime() - 3 * 60_000));
    await reportSendNowCommand(deps());
    expect(lines).toEqual([
      'The service is not running, so nothing can be sent. Start it first (net start wa-agent), then run this again.',
      'The service is not running, so nothing can be sent. Start it first (net start wa-agent), then run this again.',
    ]);
    expect(confirm).not.toHaveBeenCalled();
    expect(request()).toBeUndefined();
  });

  it('warns first when the last try ended unknown', async () => {
    writeSnapshot(NOW);
    withTracker((db) => {
      claimReport(db, DAY, '2026-10-23T00:30:00.000Z');
      finishReport(db, DAY, 'unknown', 'timeout', '2026-10-23T00:33:00.000Z');
    });
    await reportSendNowCommand(deps());
    expect(confirm.mock.calls[0]![0]).toContain("may already be on the founder's phone");
    expect(request()).toBe(DAY);
  });

  it('changes nothing when declined or cancelled', async () => {
    writeSnapshot(NOW);
    confirm.mockResolvedValueOnce(false).mockRejectedValueOnce(new ConfirmCancelled());
    await reportSendNowCommand(deps());
    await reportSendNowCommand(deps());
    expect(lines).toEqual(['Nothing was sent.', 'Cancelled. Nothing was sent.']);
    expect(request()).toBeUndefined();
  });

  it('refuses when the report is off', async () => {
    await reportSendNowCommand(deps({ REPORT_ENABLED: 'false' }));
    expect(out()).toContain('The morning report is off.');
    expect(confirm).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run tests/cli/report.test.ts tests/cli/commands.test.ts`

Expected: FAIL. `linkSenderCommand`, `reportStatusCommand` and `reportSendNowCommand` are not exported yet.

- [ ] **Step 3: Implement**

In `src/cli/commands.ts`, replace:

```ts
import { requireKey, type Env } from '../config/env.ts';
```

with:

```ts
import { maskNumber, reportRecipient, reportSettings, requireKey, type Env } from '../config/env.ts';
```

In `src/cli/commands.ts`, replace:

```ts
import { masterKeyPath, sessionDbPath, trackerDbPath } from '../config/paths.ts';
```

with:

```ts
import { masterKeyPath, senderSessionDbPath, sessionDbPath, trackerDbPath } from '../config/paths.ts';
```

In `src/cli/commands.ts`, replace:

```ts
import { DRIVE_SCOPES, runLoopbackConsent, TokenStore, type ConsentClient } from '../output/googleAuth.ts';
```

with:

```ts
import { DRIVE_SCOPES, runLoopbackConsent, TokenStore, type ConsentClient } from '../output/googleAuth.ts';
import { describeReport, reasonText } from '../report/scheduler.ts';
```

In `src/cli/commands.ts`, replace:

```ts
import { unprocessedCounts } from '../store/messages.ts';
```

with:

```ts
import { unprocessedCounts } from '../store/messages.ts';
import { recentReports, REPORT_REQUEST_KEY, reportFor } from '../store/reports.ts';
```

In `src/cli/commands.ts`, replace:

```ts
import { silentLogger } from '../util/logger.ts';
```

with:

```ts
import { silentLogger } from '../util/logger.ts';
import { istDate, istTime } from '../util/time.ts';
```

In `src/cli/commands.ts`, replace:

```ts
import { openSessionDb, resetSession, SessionDecryptError, useEncryptedAuthState, type EncryptedAuth } from '../wa/authState.ts';
```

with:

```ts
import {
  openSessionDb, resetSession, SenderSessionDecryptError, SessionDecryptError, useEncryptedAuthState, useSenderAuthState, type EncryptedAuth,
} from '../wa/authState.ts';
```

In `src/cli/commands.ts`, replace:

```ts
import { Ingestor } from '../wa/ingest.ts';
```

with:

```ts
import { Ingestor } from '../wa/ingest.ts';
import { baileysSenderSocketFactory, linkSender, type OpenFailure, type SenderSocketFactory } from '../wa/senderGateway.ts';
```

In `src/cli/commands.ts`, replace:

```ts
  /** Hard cap on the whole post-open phase. */
  maxIngestMs: { link: number; listGroups: number };
}
```

with:

```ts
  /** Hard cap on the whole post-open phase. */
  maxIngestMs: { link: number; listGroups: number };
  /** Socket factory for the spare number (link-sender). Default: Baileys with a silent logger. */
  senderSocketFactory?: SenderSocketFactory;
  /** How long link-sender keeps the new link open before closing. Default 5 s. Test seam. */
  senderSettleMs?: number;
}
```

In `src/cli/commands.ts`, replace:

```ts
    maxIngestMs: { link: 180_000, listGroups: 60_000 },
  };
}
```

with:

```ts
    maxIngestMs: { link: 180_000, listGroups: 60_000 },
    senderSocketFactory: baileysSenderSocketFactory(silentLogger()),
  };
}
```

Append to the end of `src/cli/commands.ts` (after one blank line):

```ts
const SENDER_ADVICE: Record<OpenFailure, string> = {
  not_linked: 'The QR code was not scanned. Run link-sender again.',
  connect_timeout: 'No connection to WhatsApp, or the QR code was not scanned within 5 minutes. Check the internet connection, then run link-sender again.',
  logged_out: 'WhatsApp refused the link. On the spare phone remove any old "WA Agent" device (Linked devices), then run: npm run cli -- link-sender --reset',
  forbidden: 'WhatsApp refused the spare number (403). Check the spare phone for a WhatsApp warning.',
  replaced: 'Another session took over the spare number. Close it, then run link-sender again.',
  restart_required: 'WhatsApp kept asking for a restart. Run link-sender again.',
  closed: 'The WhatsApp connection dropped before linking finished. Run link-sender again.',
};

/** Links the spare number that sends the morning report. Only data/sender-session.db is written; it sends nothing. */
export async function linkSenderCommand(opts: { reset: boolean }, deps: CliDeps): Promise<void> {
  const { env, out } = deps;
  // The lock comes first: with the service stopped, only one process ever uses the spare number's session.
  const lock = await acquireLock(env.DATA_DIR);
  let senderDb: Db | undefined;
  try {
    const key = deps.keyProvider.getKey();
    senderDb = openSessionDb(senderSessionDbPath(env.DATA_DIR));
    if (opts.reset) {
      let hasSession: boolean;
      try {
        hasSession = useSenderAuthState(senderDb, key).hasSession;
      } catch (e) {
        if (!(e instanceof SenderSessionDecryptError)) throw e;
        hasSession = true; // a stored session this key cannot read: exactly what a reset is for
      }
      if (!hasSession) {
        out('No saved spare-number link to reset.');
      } else {
        let yes: boolean;
        try {
          yes = await deps.confirm(
            "This removes the saved link of the spare number (data/sender-session.db) only. The founder's WhatsApp link and all tracker data are not touched. You will scan a new QR code from the spare phone. Type yes to continue:",
          );
        } catch (e) {
          if (!(e instanceof ConfirmCancelled)) throw e;
          out('Cancelled. Nothing was changed.');
          return;
        }
        if (!yes) {
          out('Nothing was changed.');
          return;
        }
        resetSession(senderDb); // the spare number's session rows only
        out("Reset: the saved spare-number session was deleted. The founder's link and the tracker were NOT touched.");
      }
    }
    const auth = useSenderAuthState(senderDb, key);
    if (auth.hasSession) {
      out('The spare number is already linked. Use --reset only to link a different number, or after WhatsApp logged it out.');
      return;
    }
    const result = await linkSender({
      factory: deps.senderSocketFactory ?? baileysSenderSocketFactory(silentLogger()),
      auth,
      timeoutMs: deps.linkTimeoutMs,
      settleMs: deps.senderSettleMs,
      onQr: (qr) => {
        out('');
        out("Scan this QR code with WhatsApp on the SPARE phone, not the founder's (WhatsApp > Linked devices > Link a device):");
        qrcode.generate(qr, { small: true }, (art: string) => out(art));
      },
    });
    if (!result.ok) throw new Error(SENDER_ADVICE[result.code]);
    out('Spare number linked. Next: set REPORT_RECIPIENT and REPORT_ENABLED=true in .env, then start the service (net start wa-agent).');
  } finally {
    senderDb?.close();
    await lock.release();
  }
}

/** Today's morning report and the last 7 days. Reads the tracker database only. */
export function reportStatusCommand(deps: CliDeps): void {
  const { env, out } = deps;
  const settings = reportSettings(env);
  const now = new Date();
  const today = istDate(now);
  const db = openDb(trackerDbPath(env.DATA_DIR));
  try {
    out(
      settings.enabled
        ? `Morning report: on, ${settings.time} to ${settings.deadline} IST, to the number ending ${maskNumber(reportRecipient(env))}`
        : 'Morning report: off (set REPORT_ENABLED=true and REPORT_RECIPIENT in .env, then restart the service)',
    );
    const row = reportFor(db, today);
    if (settings.enabled || row) out(`Today (${today}): ${describeReport(row, now, settings, 'idle').text}`);
    const past = recentReports(db, 8).filter((r) => r.date !== today).slice(0, 7);
    if (past.length > 0) {
      out('Last days:');
      for (const r of past) out(`  ${r.date}  ${r.status.padEnd(8)}${r.status === 'sent' ? `at ${istTime(new Date(r.updatedAt))} IST` : reasonText(r.detail)}`);
    }
    const warning = readHealthSnapshot(db)?.report?.warning;
    if (warning) out(warning);
  } finally {
    db.close();
  }
}

/** A health snapshot younger than this means the service is running (cli status uses the same 2 minutes). */
const SERVICE_FRESH_MS = 2 * 60_000;

/**
 * Asks the running service to send today's report now. It refuses if today was already sent or is being sent, and if the
 * service is not running. It sends nothing itself: only the service uses the spare number's session.
 */
export async function reportSendNowCommand(deps: CliDeps): Promise<void> {
  const { env, out } = deps;
  if (!env.REPORT_ENABLED) {
    out('The morning report is off. Set REPORT_ENABLED=true and REPORT_RECIPIENT in .env, then restart the service.');
    return;
  }
  const now = new Date();
  const today = istDate(now);
  const db = openDb(trackerDbPath(env.DATA_DIR));
  try {
    const row = reportFor(db, today);
    if (row?.status === 'sent') {
      out(`Today's report was already sent at ${istTime(new Date(row.updatedAt))} IST. Nothing was sent.`);
      return;
    }
    if (row?.status === 'sending') {
      out("Today's report is being sent right now. Check with: npm run cli -- report status");
      return;
    }
    const snap = readHealthSnapshot(db);
    if (!snap || now.getTime() - Date.parse(snap.at) > SERVICE_FRESH_MS) {
      out('The service is not running, so nothing can be sent. Start it first (net start wa-agent), then run this again.');
      return;
    }
    const caution =
      row?.status === 'unknown'
        ? "The last try ended without a clear answer, so today's report may already be on the founder's phone. Check the founder's WhatsApp first. "
        : '';
    let yes: boolean;
    try {
      yes = await deps.confirm(`${caution}This sends today's morning report to the number ending ${maskNumber(reportRecipient(env))} now. Type yes to continue:`);
    } catch (e) {
      if (!(e instanceof ConfirmCancelled)) throw e;
      out('Cancelled. Nothing was sent.');
      return;
    }
    if (!yes) {
      out('Nothing was sent.');
      return;
    }
    setKv(db, REPORT_REQUEST_KEY, today);
    out('Requested. The service sends it within about a minute. Check with: npm run cli -- report status');
  } finally {
    db.close();
  }
}
```

In `src/cli.ts`, replace:

```ts
import { defaultDeps, googleAuthCommand, linkCommand, listGroupsCommand, statusCommand } from './cli/commands.ts';
```

with:

```ts
import {
  defaultDeps, googleAuthCommand, linkCommand, linkSenderCommand, listGroupsCommand, reportSendNowCommand, reportStatusCommand, statusCommand,
} from './cli/commands.ts';
```

In `src/cli.ts`, replace:

```ts
program.command('google-auth').description('Connect Google Drive through a browser sign-in').action(async () => googleAuthCommand(deps()));
```

with:

```ts
program.command('google-auth').description('Connect Google Drive through a browser sign-in').action(async () => googleAuthCommand(deps()));

program
  .command('link-sender')
  .description('Link the spare number that sends the morning report (stop the service first)')
  .option('--reset', 'discard the saved spare-number session only (the founder link and tracker data are kept); asks first')
  .action(async (opts: { reset?: boolean }) => linkSenderCommand({ reset: opts.reset === true }, deps()));

const report = program.command('report').description('Morning report');
report.command('status').description("Today's morning report and the last 7 days").action(() => reportStatusCommand(deps()));
report
  .command('send-now')
  .description("Ask the running service to send today's report now (asks first; refuses if already sent)")
  .action(async () => reportSendNowCommand(deps()));
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/cli/report.test.ts tests/cli/commands.test.ts`

Expected: PASS (15 new tests, and the existing CLI tests unchanged).

- [ ] **Step 5: Run the full suite and the type-check**

Run: `npm test`, then `npm run typecheck`

Expected: every test passes and tsc prints nothing. (If only `tests/appMedia.test.ts` fails, see ground rule 12.)

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/cli/commands.ts tests/cli/report.test.ts
git commit -m "feat: cli link-sender, report status and report send-now" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: SETUP.md: Morning report section

**Files:**
- Modify: `docs/SETUP.md` (new "Morning report" section, three command rows, two status rows)
- Test: `tests/docs/setup.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/docs/setup.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

describe('morning report documentation', () => {
  it('SETUP.md explains setup, the commands and both warnings', () => {
    const setup = read('docs/SETUP.md');
    expect(setup).toContain('\n## Morning report\n');
    for (const text of [
      'npm run cli -- link-sender',
      'npm run cli -- link-sender --reset',
      'npm run cli -- report status',
      'npm run cli -- report send-now',
      'REPORT_ENABLED=true',
      'REPORT_RECIPIENT=your_founder_number_here',
      '### Status "Morning report: unknown, check WhatsApp"',
      '### Status "Morning report: the spare number is not linked"',
      'sender-session.db',
    ]) {
      expect(setup).toContain(text);
    }
  });

  it('.env.example lists the report settings with empty values', () => {
    const example = read('.env.example');
    for (const name of ['REPORT_ENABLED', 'REPORT_TIME', 'REPORT_DEADLINE', 'REPORT_RECIPIENT']) expect(example).toMatch(new RegExp(`^${name}=$`, 'm'));
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run tests/docs/setup.test.ts`

Expected: FAIL. SETUP.md has no `## Morning report` section yet. (The `.env.example` test already passes after Task 3.)

- [ ] **Step 3: Implement**

In `docs/SETUP.md`, insert this block right before the line `## Everyday commands (run in the waagent window)`, leaving one blank line between the block and that line:

````markdown
## Morning report

Every day at 06:00 IST, Sundays included, the founder gets one WhatsApp message from a **spare number** the business owns. It lists, per active client, how many tasks are open and overdue and the 3 most urgent open tasks (tagged `us` or `client`), then a total line. The current tracker is attached as `Tracker-YYYY-MM-DD.xlsx`. It makes no AI call, so it costs nothing.

- The founder's own number is unchanged: the agent still only reads it and never sends from it.
- The spare number sends only to `REPORT_RECIPIENT`. It reads no chats, sends no read receipts, and is online only for the minute it takes to send.
- If the PC is off or offline at 06:00, the report goes as soon as possible, but only until 12:00 IST. After that the day is skipped.
- It is never sent twice on one day.

### Setup (about 15 minutes)

1. Put the spare SIM in a spare phone and install WhatsApp on it.
2. From the founder's phone, send the spare number one message ("hi"), so it is a known chat.
3. Stop the service safely (see above). Then, in the waagent window:

   ```bat
   npm run cli -- link-sender
   ```

   Scan the QR code from the **spare** phone (WhatsApp > Linked devices > Link a device), not from the founder's phone.
4. In `.env`, set:

   ```env
   REPORT_ENABLED=true
   REPORT_RECIPIENT=your_founder_number_here
   ```

   `REPORT_RECIPIENT` is the founder's number with country code, digits only (for example `919812345678`, with no `+` or spaces). Leave `REPORT_TIME` and `REPORT_DEADLINE` empty for 06:00 and 12:00 IST.
5. Start the service again.
6. Send one test report: `npm run cli -- report send-now`, then type `yes`. It refuses if today's report was already sent. Check the founder's phone.
7. Open WhatsApp on the spare phone at least every 14 days, so the linked device stays valid.

The spare number's session is in `C:\wa-agent\data\sender-session.db`. It is encrypted with its own key, derived from the same master key. Back it up with the rest of `data`.

### Checking it

`npm run cli -- report status` shows today's state and the last 7 days, for example:

```text
Morning report: on, 06:00 to 12:00 IST, to the number ending …5678
Today (2026-10-23): Morning report: sent at 06:00 IST
Last days:
  2026-10-22  sent    at 06:00 IST
  2026-10-21  skipped could not connect to WhatsApp
```

`npm run cli -- status` shows the same line as `Report:`.

### Status "Morning report: unknown, check WhatsApp"

The send started but did not finish cleanly (a timeout, or the service stopped mid-send). The report may or may not have reached the founder, so the agent does **not** try again by itself.

1. Look at the founder's WhatsApp, in the chat with the spare number.
2. If today's report is not there, run `npm run cli -- report send-now` and type `yes`.
3. If it is there, do nothing. The warning clears the next day.

### Status "Morning report: the spare number is not linked" (or "was logged out")

- **Not linked:** stop the service, run `npm run cli -- link-sender`, scan from the spare phone, then start the service.
- **Logged out** (the device was removed on the spare phone, or the phone was not opened for weeks): on the spare phone remove any old "WA Agent" device. Stop the service, run `npm run cli -- link-sender --reset` (type `yes`), scan, then start the service. The founder's link and the tracker are not touched.
- **Refused (403) or banned:** check the spare phone for a WhatsApp warning. To move to a new spare number, repeat the setup with `link-sender --reset`.

The tracker keeps working in every case; only the morning report is skipped.

### Turning it off

Set `REPORT_ENABLED=false` (or leave it empty) in `.env`, then restart the service.
````

In `docs/SETUP.md`, replace:

```markdown
| `npm run cli -- reprocess ABC --since 2026-10-15` | Re-run the AI over recent messages |
```

with:

```markdown
| `npm run cli -- reprocess ABC --since 2026-10-15` | Re-run the AI over recent messages |
| `npm run cli -- report status` | Today's morning report and the last 7 days |
| `npm run cli -- report send-now` | Send today's morning report now (asks first; refuses if already sent) |
| `npm run cli -- link-sender` | Link the spare number for the morning report (stop the service first) |
```

In `docs/SETUP.md`, replace:

```markdown
| Low disk: (number) GB free | Under 10 GB left. | Free up disk space. |
```

with:

```markdown
| Morning report: unknown, check WhatsApp | The morning report's send started but did not finish cleanly. It may have reached the founder. The agent does not resend it by itself. | See "Morning report" above, under its own status heading. |
| Morning report: the spare number is not linked (or was logged out, or was refused) | The spare number cannot send the morning report. The tracker is not affected. | See "Morning report" above. |
| Low disk: (number) GB free | Under 10 GB left. | Free up disk space. |
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/docs/setup.test.ts`

Expected: PASS (2 tests).

- [ ] **Step 5: Run the full suite and the type-check**

Run: `npm test`, then `npm run typecheck`

Expected: every test passes and tsc prints nothing. (If only `tests/appMedia.test.ts` fails, see ground rule 12.)

- [ ] **Step 6: Commit**

```bash
git add docs/SETUP.md tests/docs/setup.test.ts
git commit -m "docs: morning report setup, commands and status lines in SETUP.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Self-review

**Spec coverage**

| Spec | Where |
|---|---|
| §1 06:00 IST daily, Sundays included; spare number | Task 6 (window, every day), Task 5 (sender), Task 7 (wiring) |
| §1 per active client: open and overdue counts; up to 3 most urgent, tagged, ordered overdue, due today, high priority, oldest | Task 2 (`byMorningUrgency`, `TOP_TASKS`) |
| §1 final line with totals and "Built ... IST" | Task 2 |
| §1 attachment `Tracker-YYYY-MM-DD.xlsx` from `buildWorkbook` | Task 6 (`#build`), Task 5 (document send) |
| §1 catch up until 12:00, then skipped with reason in the status line | Task 6 (window, `skipReport`), `describeReport` |
| §1 at most one report per IST date | Task 1 (`claimReport` upsert), Task 6 |
| §1 and §2 no AI calls, no spend | Ground rule 2; no `src/brain` import in `src/report` |
| §2 only the founder number; no groups, replies or chat reading | Task 5 (fixed recipient, `checkRecipient`, listens to two events only) |
| §2 founder-number reader unchanged, no send method | Ground rule 3; existing gateway tests; Task 5 scan |
| §3 `buildMorningText(view, today)` | Task 2 |
| §3 `sendReport(text, xlsx, fileName)`, `status()`, `stop()`; recipient from config | Task 5 |
| §3 `tick(now)` from the app tick | Task 6, Task 7 |
| §3 `claimReport`, `finishReport`, `reportFor` and migration v6 | Task 1 |
| §3 CLI `link-sender`, `report status`, `report send-now` | Task 8 |
| §3 Health and `cli status` line, `setReport` | Task 7 |
| §3 own encrypted file `data/sender-session.db`, HKDF subkey `whatsapp-sender-session` | Task 4 |
| §3 recipient normalised to `<digits>@s.whatsapp.net`, others refused | Task 5 (`recipientJid`, `checkRecipient`) |
| §3 connects only while a send is due; no presence; no read receipts | Task 5 (Decision 6) |
| §3 source scan: only senderGateway calls a Baileys send method; reader test stays | Task 5 |
| §4.2 claim written before any send; failed claim sends nothing | Task 1, Task 6 |
| §4.3 send text and document, record `sent` with the message id | Task 5, Task 6 |
| §4.4 definite failure: `retry`, waits 2, 5, 10, until 12:00 | Task 6 (`retryWaitMs`) |
| §4.5 unknown never retried; Health "Morning report: unknown, check WhatsApp"; owner can `send-now` | Task 6, Task 7, Task 8 |
| §4.6 `sending` at service start becomes `unknown` | Task 1 (`markInterruptedReports`), Task 6 (`recover`), Task 7 (`start`) |
| §4.7 after 12:00 a day with no sent row becomes `skipped` | Task 6 (Decision 4 for `unknown`) |
| §5 `REPORT_ENABLED`, `REPORT_TIME`, `REPORT_DEADLINE`, `REPORT_RECIPIENT`; logs show last 4 digits | Task 3, Task 7 (`maskNumber` in the start log) |
| §6 setup steps, typed confirmation, refuses if already sent, 14-day reminder | Task 8, Task 9 |
| §7 banned or logged out: Health shows it, report skipped, reader unaffected, recovery by `link-sender` | Task 6 (`SENDER_WARNINGS`), Task 8 (`--reset`), Task 9 |
| §7 `ReportSender` interface for a later Business API | Task 3 (`types.ts`) |
| §8 tests: builder, scheduler cases, sender cases, migration v6, no network | Tasks 1, 2, 5, 6 |

**Placeholders:** none. Every step has the real code or the real command, and every changed line of an existing file is shown with the exact text it replaces.

**Type consistency across tasks**

- `ReportSettings { enabled, time, deadline }`: made by `reportSettings(env)` (Task 3), used by `ReportScheduler` (Task 6), `AppReportDeps` (Task 7) and `reportStatusCommand` (Task 8).
- `SendResult` (`sent` with `messageIds`, `failed` with `code`, `unknown` with `code`): returned by `SenderGateway.sendReport` (Task 5) and `FakeReportSender` (Task 6), consumed by `ReportScheduler.#send` (Task 6).
- `SenderState` values (`idle`, `not_linked`, `connecting`, `open`, `logged_out`, `forbidden`, `replaced`): set by `SenderGateway` (Task 5), read by `describeReport` (Task 6).
- `ReportHealth { text, warning }`: returned by `describeReport` and `ReportScheduler.health` (Task 6), stored by `Health.setReport` and the snapshot's `report` (Task 7), printed by `formatStatus` and `reportStatusCommand` (Tasks 7 and 8).
- `ReportRow` and `ReportStatus` (`sending`, `sent`, `retry`, `unknown`, `skipped`): Task 1; used in Tasks 6 and 8. The SQL `CHECK` lists the same five values.
- Reason codes stored in `reports.detail` (`not_running`, `not_linked`, `connect_timeout`, `closed`, `restart_required`, `logged_out`, `forbidden`, `replaced`, `build_failed`, `busy`, `stopped`, `timeout`, `send_error`, `crash`, `interrupted`) all have a `REASON_TEXT` entry (Task 6); `OpenFailure` (Task 5) is a subset, and `SENDER_ADVICE` (Task 8) covers every `OpenFailure`.
- `EncryptedAuth` (existing): returned by `useSenderAuthState` (Task 4), taken by `SenderGateway` and `linkSender` (Task 5), `main.ts` (Task 7) and `linkSenderCommand` (Task 8).
- `REPORT_REQUEST_KEY = 'report_send_requested'`: written by `reportSendNowCommand` (Task 8), taken by `ReportScheduler.#run` (Task 6).
