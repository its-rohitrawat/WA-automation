# Morning report (Phase 2c): design

Status: approved by the owner on 2026-10-23, amended on 2026-10-27 (see "Amendment, 27 Oct 2026" at the end). It amends the main design (`2026-10-19-wa-agent-design.md`), which says the agent never sends on WhatsApp. That rule still holds for the founder's number. This phase adds one narrow sender on a separate spare number.

## 1. What it does

- Every day at **06:00 IST**, including Sundays, the founder receives one WhatsApp message from a **spare number** owned by the business.
- **Message text, per active client:**
  - how many tasks are open, and how many of those are overdue;
  - up to **3 most urgent** open tasks, each tagged `us` or `client`, ordered: overdue first, then due today, then high priority, then oldest raised.
- A final line gives the totals and the "Built … IST" time.
- **Attachment:** the current tracker as `Tracker-YYYY-MM-DD.xlsx`, built by the existing `buildWorkbook`.
- **Missed 06:00** (PC off, offline, or WhatsApp not connected): send as soon as possible, but only until **12:00 IST**. After 12:00 that day is skipped, and the status line says "Morning report skipped today (reason)".
- **At most one report per IST date.** It is never sent twice.
- **No AI calls**, so no spend. The report is built from the tracker database.

## 2. Non-goals

- No messages to anyone except the configured founder number. No groups, no clients, no team members.
- No replies, commands, or reading of the spare number's chats.
- No change to the founder-number reader. It stays passive, with no send method.

## 3. Components

| Unit | Purpose | Interface | Depends on |
|---|---|---|---|
| `src/report/morningReport.ts` | Build the message text from the tracker view | `buildMorningText(view: TrackerView, today: string): string` | `output/view.ts` |
| `src/wa/senderGateway.ts` | The second Baileys session, on the spare number | `sendReport(text: string, xlsx: Buffer, fileName: string): Promise<SendResult>`, `status()` and `stop()`. No other send method. The recipient comes from config and cannot be passed in. | Baileys, `authState` (its own encrypted store) |
| `src/report/scheduler.ts` | Decide when to send, and record each attempt | `tick(now)`, called from the app tick | store, `senderGateway`, `buildWorkbook`, `loadTrackerView`, clock |
| `src/store/reports.ts` + migration v6 | One row per IST date | `claimReport(date)`, `finishReport(date, status, detail)`, `reportFor(date)` | db |
| CLI `link-sender`, `report status`, `report send-now` | Link the spare number by QR, show today's state, send now | see §6 | the above |
| Health and `cli status` | A "Morning report" line | `setReport(state)` | `health.ts` |

**Sender isolation**
- The spare number's session lives in its own encrypted file, `data/sender-session.db`. It uses a separate HKDF subkey (`whatsapp-sender-session`) of the same DPAPI master key.
- `senderGateway` refuses any recipient JID other than `REPORT_RECIPIENT`, normalised to `<digits>@s.whatsapp.net`.
- It connects only while a send is due, then disconnects. It sets no online presence and sends no read receipts.
- A source-scan test fails if any module other than `senderGateway` calls a Baileys send method. The existing test that the reader gateway has no send method stays.

## 4. Data flow and idempotency

1. The app tick (every 30 s) calls `scheduler.tick(now)`.
2. If `REPORT_ENABLED` is true, the IST time is between 06:00 and 12:00, and today has no row: claim it with status `sending`. The claim is written before any send. If the claim fails, nothing is sent.
3. Build the view and the xlsx, connect the sender, and send the text plus the document. Record `sent`, with the WhatsApp message id.
4. **A definite failure before sending** leaves the row in `retry`, such as not connected, or WhatsApp rejecting the session before the message left. The next tick tries again, with growing waits of 2, 5 and 10 minutes, until 12:00.
5. **An unknown outcome** is a timeout or a crash after the send started. It is recorded as `unknown`, and that row is **never retried automatically**. Health shows "Morning report: unknown, check WhatsApp". The owner can run `report send-now` after checking.
6. A row still `sending` at service start, left by a crash mid-send, becomes `unknown`.
7. After 12:00, a day with no `sent` row becomes `skipped`, with its reason.

## 5. Settings (`.env`)

- `REPORT_ENABLED=true`
- `REPORT_TIME=06:00`, IST
- `REPORT_DEADLINE=12:00`
- `REPORT_RECIPIENT=<founder's number with country code, digits only>`. This is personal data, kept out of code and logs; logs show only the last 4 digits.
  - Owner decision (2026-10-23): only an Indian mobile is accepted, `91` then 10 digits starting 6-9. Logs show only the last 4 digits, so a number typed without `91` would look the same there but go to a foreign number; refusing it at startup stops that.

## 6. Setup (owner, about 15 minutes)

1. Put the spare SIM in a spare phone and install WhatsApp.
2. From the founder's phone, message the spare number once ("hi"), so it is a known chat.
3. Run `npm run cli -- link-sender` with the service stopped, and scan the QR code from the spare phone (WhatsApp › Linked devices).
4. Set `REPORT_RECIPIENT` and `REPORT_ENABLED=true` in `.env`, then restart the service.
5. `npm run cli -- report send-now` sends one test report. It needs typed confirmation, and refuses if today was already sent.
6. Open WhatsApp on the spare phone at least every 14 days, so the linked device stays valid.

## 7. Errors and risks

- **The spare number is banned or logged out:**
  - Health shows it, and the report is skipped.
  - The founder-number reader is unaffected.
  - Recovery: `link-sender` with a new number.
  - Keeping risk low: one message a day, to one known contact, started by a human "hi"; no bulk, no groups.
- **Upgrade path:** `senderGateway` sits behind a small `ReportSender` interface, so the official WhatsApp Business API can replace it later without touching the scheduler.
- **Large tracker:** WhatsApp documents allow 100 MB; the xlsx is far smaller.
- **Privacy:** the report goes only to the founder, end-to-end encrypted. No client sees it.

## 8. Testing

- Text builder: counts, ordering, the 3-item cap, us and client tags, no tasks, a client with only done tasks, and long titles cut cleanly.
- Scheduler with a fake clock and a fake sender:
  - sends once at 06:00;
  - catches up at 09:30 after downtime;
  - skips after 12:00;
  - retries a definite failure with waits;
  - never retries an unknown outcome;
  - turns a crash mid-send into unknown at start;
  - does nothing when disabled.
- Sender: refuses other recipients; the only send path is the one method; no presence or read receipts (fake socket).
- Migration v6: additive only; v1–v5 untouched.
- No real WhatsApp or network in tests.

## 9. Size

About 1 day, using the same build-and-review loop as Phase 2a.

## Amendment, 27 Oct 2026

Owner decisions, final. Where they differ from §1 to §8 above, they replace them. Plan: `docs/superpowers/plans/2026-10-27-short-morning-link.md`.

- **D1 text:** the message is one short line with the totals and a link to the tracker on Google Drive:
  `Good morning. {open} open tasks, {overdue} overdue. Today's tracker: {link}`
  - "1 open task" and "1 overdue" use the singular.
  - With no active clients: `Good morning. No open tasks. Today's tracker: {link}`
  - Totals count active clients only: open is `us` plus `client` open tasks, overdue is the overdue ones.
  - `{link}` is `https://drive.google.com/file/d/{id}/view`, from the tracker id `src/output/drive.ts` already stores. Until the tracker has reached Drive there is no link: the day is a definite failure with reason `no_tracker_link` ("the tracker is not on Google Drive yet (run google-auth and let it upload once)"), retried with the normal waits and skipped at the deadline. Nothing is sent.
  - The founder needs view access to `Tracker.xlsx` (the **WA Agent** folder shared with his Google account), or the link asks for access.
- **D2 days:** Monday to Friday by default, no longer every day. The setting `REPORT_DAYS` accepts `weekdays` (default), `mon-sat` and `daily`.
  - On a day that is not a report day the scheduled path does nothing: no claim, no row, no skipped row, no "due" promise. The status says `Morning report: no report today (weekend)`, with no warning. A row made by `report send-now` on such a day keeps the normal retry waits and the deadline skip.
  - `report send-now` is still honoured on any day, with every send-now rule.
- **D3 summary tab:** the workbook gets a `Today` worksheet first, before Overview: per active client its open and overdue counts, and its 3 most urgent open tasks in the order of §1 (side, code, title, deadline, notes), then a total row. The link therefore opens on it.
- **D4 no attachment:** only the text is sent, with `linkPreview: null`. `ReportSender.sendReport(text)` takes no file, and `buildMorningText` is replaced by `buildShortMorningText(view, today, link)`. The §7 "Large tracker" risk no longer applies.

Unchanged: §2, and from §3 and §4 the sender isolation and the send rules (except the payload, which D4 replaces, and the report days, which D2 replaces). The founder-number reader never sends; the sender messages only `REPORT_RECIPIENT`; claim before send, at most once per IST date, an unknown outcome is never retried automatically, catch up until the deadline, no AI spend; only `src/wa/senderGateway.ts` names a Baileys send method.
