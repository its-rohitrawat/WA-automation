# Morning report: short message with the tracker link (owner change, 27 Oct 2026)

**Goal:** the 6 AM WhatsApp becomes one short line with the totals and a link to the tracker on Google Drive. No Excel attachment. It goes out Monday to Friday only. The spreadsheet gets a "Today" summary tab first, so the link shows what the long message used to show.

**Owner decisions (27 Oct 2026, final):**
- **D1 text:** `Good morning. {open} open tasks, {overdue} overdue. Today's tracker: {link}`
  - "1 open task" / "1 overdue" use the singular.
  - With no active clients: `Good morning. No open tasks. Today's tracker: {link}`
- **D2 days:** Monday to Friday by default. A setting `REPORT_DAYS` accepts `weekdays` (default), `mon-sat` and `daily`.
- **D3 summary tab:** a "Today" worksheet first in the workbook:
  - per active client: open and overdue counts;
  - the 3 most urgent open tasks, using the existing urgency order.
- **D4 no attachment:** only the text is sent.

**Ground rules (unchanged from Phase 2c, all still binding):**
- The founder-number reader never sends.
- The sender may message only `REPORT_RECIPIENT`.
- The send flow is unchanged:
  - claim before send, never twice a day;
  - an unknown outcome is never retried automatically;
  - catch up until the deadline, then skip;
  - no AI spend;
  - `linkPreview: null` on the text, so Baileys fetches nothing.
- The recipient appears only masked (last 4 digits) in logs.
- Only `src/wa/senderGateway.ts` names a Baileys send method (`tests/wa/sendScan.test.ts`).
- Never read `.env`; no real WhatsApp, Google or network in tests.
- Tests first, for every change. Full suite and `npm run typecheck` clean before each commit.

---

## Task 1: Report days (`REPORT_DAYS`)

- **Setting:** `src/config/env.ts` gains `REPORT_DAYS: z.enum(['weekdays','mon-sat','daily']).default('weekdays')`.
  - `ReportSettings` gains `days`, and `reportSettings(env)` passes it through.
  - `.env.example` gets `REPORT_DAYS=` with a one-line comment.
- **New helper** `isReportDay(date: string, days)` in `src/report/scheduler.ts` (or a small module):
  - it checks the IST weekday of the IST date;
  - `weekdays` is Monday to Friday, `mon-sat` adds Saturday, `daily` is every day.
- **Scheduler:** on a day that is not a report day, the scheduled path does nothing at all:
  - no claim, no row, no skipped row;
  - no "due at 06:00" promise.
- **send-now:** a send-now request is still honoured on any day. The owner asked explicitly, and it keeps every send-now rule.
- **Health and report status:** on a non-report day `describeReport` says `Morning report: no report today (weekend)` with no warning. Use `(not a report day)` when `REPORT_DAYS` makes the day off for a reason other than the weekend.
- **Tests:**
  - IST weekday at IST midnight edges, for example 2026-10-30 23:59 IST is Friday and 2026-10-31 00:00 IST is Saturday;
  - each `REPORT_DAYS` value;
  - Saturday and Sunday ticks at 06:00 and 09:00 create no row and send nothing;
  - Monday sends;
  - send-now on a Sunday sends once;
  - health text on a weekend;
  - the default is `weekdays`;
  - a bad value names `REPORT_DAYS` only.

## Task 2: Short text with the tracker link, no attachment

- **Link:** `trackerLink(db): string | undefined` reads kv `drive_tracker_id`, which `src/output/drive.ts` already stores.
  - It returns `https://drive.google.com/file/d/{id}/view`.
  - The id is validated as `^[A-Za-z0-9_-]{10,}$`, else `undefined`.
- **Message:** `buildShortMorningText(view, today, link)` in `src/report/morningReport.ts`, exactly per D1.
  - Totals come only from active clients: open is `usOpen` plus `clientOpen`, and overdue is `overdue`.
  - Keep the existing helpers. Remove `buildMorningText` only if nothing else uses it; otherwise keep it.
- **No link yet** (the tracker was never uploaded): the build step fails as a definite failure with code `no_tracker_link`.
  - Add a `REASON_TEXT` entry: "the tracker is not on Google Drive yet (run google-auth and let it upload once)".
  - It gets the normal retry waits, then is skipped at the deadline with that reason. Nothing is sent.
- **Interface:** `ReportSender.sendReport(text: string): Promise<SendResult>` takes no attachment.
  - `SenderGateway.sendReport` sends the text only, with `{ text, linkPreview: null }`, through the same `#send` path.
  - `messageIds` has one id.
  - The send-scan rule (one `sock.sendMessage` call site) still holds.
  - Remove the xlsx/document code and its constants. `ReportPayload` becomes `{ text }`.
  - The scheduler's `#build` no longer builds a workbook.
- **Unchanged:** the timeouts, the linger, stop handling, the sent/failed/unknown rules and the crash handling. Update the tests that expected two sends to expect one.
- **Tests:**
  - the exact text for 0, 1 and many open and overdue tasks;
  - the link format;
  - a bad or missing drive id gives `no_tracker_link`: retry, then skip at the deadline, never sent;
  - the gateway sends exactly one message, the text with `linkPreview: null`, and no document;
  - the scheduler records the one id;
  - every existing safety test still passes.

## Task 3: "Today" summary tab in the workbook

- **Where:** `src/output/workbook.ts` adds a worksheet named `Today` as the first sheet, before Overview.
- **Content, active clients only:**
  - a title row `Today · {displayDate(today)} · built {HH:MM} IST`;
  - a header row Client | Open | Overdue;
  - one row per active client;
  - under each client row, its top 3 open tasks by `byMorningUrgency`: side, code, title, deadline and notes (overdue, due today, high priority, maybe done);
  - a totals row.
- **Formatting:** follow the existing workbook style (header fill, column widths, frozen header row).
  - Titles are cut like the old message (`shortTitle`).
  - Text gets the same cleaning as the other sheets: no formula injection, so values starting with = + - @ are made safe. Check the existing helper and reuse it.
- **Tests:**
  - the sheet order (Today first);
  - counts and the top-3 order;
  - inactive clients are left out;
  - empty state;
  - a title starting with "=" is not a formula;
  - the existing workbook tests still pass.

## Task 4: Docs and the spec amendment

- **`docs/SETUP.md`, the "Morning report" section:**
  - describe the short message with the link, Monday to Friday, and `REPORT_DAYS`;
  - the founder needs view access to `Tracker.xlsx` on Drive (share it with his Google account), or the link will ask for access;
  - no attachment;
  - the status lines table gets the weekend text and the `no_tracker_link` reason.
- **`docs/SETUP-mac.md` section 7:** the same, short.
- **`tests/docs/setup.test.ts`:** update the locked wording (the attachment wording goes; the link, the weekdays, the share step and every SENDER_WARNINGS row stay checked).
- **Spec:** add an "Amendment, 27 Oct 2026" section to `docs/superpowers/specs/2026-10-23-morning-report-design.md` with D1–D4.
