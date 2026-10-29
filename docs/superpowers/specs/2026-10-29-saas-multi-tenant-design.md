# WA Agent as a multi-customer service (SaaS): design

Date: 29 Oct 2026. Status: draft for the owner's approval. No code is written from this until it is approved.

## 1. What the owner asked for

- The founder (platform owner) invites other businesses ("customers") from the System panel. The invite goes out as an email from the founder's Gmail, with a link.
- The invited person opens the link, reaches a sign-up page, and signs in with Google, using the Gmail address that was invited and no other.
- They land on their own dashboard. A checklist shows what they still have to connect: their WhatsApp, a second (spare) number, Google Drive, and their groups.
- Each customer's data is kept apart with **row level security (RLS)**. The owner chose **Postgres with real RLS** (29 Oct), not one SQLite file per customer.

## 2. Owner decisions this design depends on

| Decision | Choice (29 Oct) |
|---|---|
| How customers are kept apart | Postgres with real RLS |
| Open chat | Read and send, with a confirm step per message (built separately, see section 11) |
| Priority and sentiment | Keywords plus the same AI call (built separately) |
| AI assistant | Answers, and acts only after a confirm (built separately) |

Still open, to decide before the matching phase starts (section 12): the customer limit, who pays for Claude, and Google's review of the Gmail sending permission.

## 3. Today, in one paragraph

There is one process on the Intel Mac (launchd, user `waagent`, `/opt/wa-agent`), Node 24 running TypeScript directly, with one owner. It uses one WhatsApp link (`data/session.db`), one spare number (`data/sender-session.db`) and one tracker database (`data/tracker.db`: 23 tables, 11 migrations). The code has **232 queries in 42 files**, all synchronous (better-sqlite3), across 30,700 lines of source and 178 test files. Owner sign-in is Google OIDC, limited to `DASHBOARD_OWNER_EMAILS`. Saved logins are encrypted with AES-256-GCM using `data/keys/master.key`.

## 4. The target

```
Browser (founder or customer)
   │  Google sign-in, session cookie, CSRF
   ▼
Agent on the Mac (one Node process)
   ├── Web server: /, /signup, /dashboard
   ├── Platform layer: customers, users, invites (founder only)
   ├── Customer runtimes, one per active customer:
   │      WhatsApp reader · spare-number sender · batcher + Claude ·
   │      Drive tracker · meetings · morning report
   └── Database access: every query runs inside withTenant(customerId)
   ▼
Postgres 17 on the same Mac (127.0.0.1 only)
   role wa_owner   owns the tables and runs migrations, never used at run time
   role wa_app     what the agent uses: NOBYPASSRLS, not a table owner
   every customer table: tenant_id + RLS ENABLED + FORCED
```

### 4.1 How RLS is enforced

- Every customer table gets `tenant_id uuid NOT NULL REFERENCES tenants(id)`, plus an index that starts with `tenant_id`.
- Each table has `ALTER TABLE … ENABLE ROW LEVEL SECURITY; ALTER TABLE … FORCE ROW LEVEL SECURITY;`.
- There is one policy per table:
  `USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (same)`.
- The agent connects as `wa_app`, which is not the table owner and has `NOBYPASSRLS`, so the policy always applies.
- All database work goes through one helper:
  `withTenant(tenantId, async (tx) => …)`. It opens a transaction, then runs `SELECT set_config('app.tenant_id', $1, true)` (the setting lasts for that transaction only), then the work, then the commit.
- **It fails closed.** Without the setting, `current_setting(…, true)` is NULL, the policy matches nothing, and reads return no rows. Inserts fail the `WITH CHECK`.
- Because the setting lives only inside the transaction, a pooled connection can't carry one customer's id into the next request.
- A test checks that no code outside the database helper talks to the pool directly.

### 4.2 Platform tables (not per customer)

`tenants`, `users`, `memberships`, `invites` and `platform_audit`.

- `wa_app` can't read them directly.
- It reaches them only through a few `SECURITY DEFINER` functions owned by `wa_owner`, each doing one narrow job:
  - find the memberships for a verified email;
  - redeem an invite;
  - list the customers, for the founder's view;
  - create a customer.
- Each function checks its inputs and returns only the fields it needs.

### 4.3 Who can see what

| Role | Sees |
|---|---|
| Platform owner (the founder) | Their own business, which is customer #1 (all of today's data). The **Customers** screen shows each customer's name, status, onboarding step, last activity and spend, but **never their messages or tasks**. |
| Customer owner | Only their own customer's data, through RLS. |
| Customer member (later) | The same as the customer owner, minus settings. Not in the first release. |

The founder has no "view as customer" button. If one is needed later, it becomes its own audited, time-limited feature.

## 5. Invites and sign-up

1. **System panel, Invite.** The founder enters the customer's business name and their Gmail address.
   - The server creates the customer (status `invited`) and an invite.
   - The invite token is 32 random bytes. Only its SHA-256 hash is stored. It expires in 7 days, works once, and is bound to that email.
2. **The email.** It's sent through the Gmail API from the founder's own Google account.
   - This needs a new permission, `gmail.send`. The founder is asked to approve it once, in the same Google connect flow as now.
   - The email holds the link `https://<site>/signup?invite=<token>` and a short plain message.
   - There is always a **Copy link** button too, so invites still work if Gmail isn't connected.
   - The send is logged *before* the Gmail call, and the result is recorded. If the outcome is unclear, the invite shows "unknown" and isn't sent again by itself.
3. **The sign-up page** (`/signup`). It shows who invited them and a "Continue with Google" button.
   - Google's verified email must equal the invited email, compared case-insensitively.
   - If it doesn't match, the page says "This invite is for a different Google account" and gives no other detail.
   - When it matches, the invite is used up, a membership is created, the customer becomes `onboarding`, and the session starts.
4. **Limits:**
   - invite creation: 20 a day per founder;
   - sign-up and redeem attempts: rate-limited per IP and per token;
   - the founder can resend or cancel an invite;
   - everything is audit-logged.

## 6. The customer's first dashboard: the onboarding checklist

The checklist has five steps, each with a status and a button:

1. **Connect WhatsApp.** A QR code in the browser, the same as the owner's screen now, per customer.
2. **Add the spare number** (optional, used for the morning report). A QR code for the second phone.
3. **Connect Google Drive**, for the customer's own tracker. This is the customer's own Google account, with its own token, encrypted.
4. **Approve groups.** Manage groups, with the new multi-select.
5. **Set the morning report time.**

The customer becomes `active` once step 1 is done. The rest can follow.

## 7. One process, many customers

- A **Supervisor** starts one **CustomerRuntime** for each `active` customer and stops it when that customer is paused or removed. If one runtime crashes, it's restarted with backoff, and the others keep running.
- Each runtime holds its own Baileys socket (auth state in Postgres, encrypted), its batcher and timers, its Drive publisher, its morning report sender and its meetings. Each one runs every database call through `withTenant(its id)`.
- **Encryption keys per customer.** Each customer gets its own data key, encrypted by the Mac's master key. Customer secrets (WhatsApp auth, Google tokens, pointers to files) are encrypted with that customer's data key.
- **Claude spend:**
  - each customer has its own daily cap (today's `spend` table, per customer);
  - a global daily cap protects the founder's bill;
  - whoever's API key pays, as decided in section 12.
- **Capacity:** each WhatsApp socket uses roughly 60 to 120 MB of memory. We start with a limit of **20 active customers**, change it with a setting, and show memory use on the Customers screen.

## 8. Moving from SQLite to Postgres safely

1. **The async store layer, still on SQLite.** All 232 queries move behind async store functions, and callers use `await`. This is a mechanical change, and the full test suite must stay green. Nothing changes for users. This is the step that touches the most files, so it goes first, on its own.
2. **The Postgres engine behind a switch.** `DB_ENGINE=sqlite|postgres` (default `sqlite`).
   - The Postgres schema is new migrations written for Postgres. SQLite's 11 migrations are never edited.
   - The tests run against both engines. An RLS test file proves that customer A can't read, change or delete customer B's rows, that `wa_app` can't turn RLS off, and that a missing customer id returns nothing.
3. **The copy tool** (`npm run cli -- migrate-to-postgres`):
   - It runs as a dry run by default. It reads `tracker.db` and `session.db`, writes them into Postgres as customer #1 in one transaction, compares the row counts and a checksum per table, and prints a report.
   - The SQLite files are only read, never changed or deleted.
   - It writes for real only with `--apply`, after a fresh backup.
4. **Cutover on the Mac** (the owner's steps, written in the go-live guide):
   - stop the service;
   - back up `data/`;
   - install Postgres (Homebrew), which creates the two roles;
   - run the dry run, then `--apply`;
   - set `DB_ENGINE=postgres`;
   - start the service and check the dashboard.
5. **Rollback:** set `DB_ENGINE=sqlite` and restart. The untouched SQLite files take over again. Messages that arrived during the Postgres period stay in Postgres. A small export tool brings them back to SQLite if that's ever needed.

## 9. Phases and who does them

| Phase | Work | Depends on |
|---|---|---|
| S1 | Async store layer on SQLite (no visible change) | The current feature PRs merged first, so they don't clash |
| S2 | Postgres schema, RLS, `withTenant`, the engine switch, dual-engine tests | S1 |
| S3 | The copy tool, with dry run, counts and checksums | S2 |
| S4 | The Supervisor and per-customer runtimes, keys and spend caps | S2 |
| S5 | Invites, Gmail sending, `/signup`, the onboarding checklist, the Customers screen | S2 (UI can start alongside S4) |
| S6 | The go-live guide and the owner's cutover on the Mac | S3, S4, S5 |

Rough size: **2 to 3 weeks** with three or four sessions working in parallel and a review between phases. S1 and S2 carry most of the risk.

## 10. Security checklist for every phase

- No query outside `withTenant` (enforced by a test).
- `wa_app`: NOBYPASSRLS, not a table owner, no DDL.
- Every customer table: RLS enabled and FORCED, with a policy on both USING and WITH CHECK, covered by the cross-customer tests.
- Invite tokens: hashed, single-use, expiring, bound to an email, rate-limited.
- Sign-up accepts only Google-verified emails that match the invite.
- No customer data in logs. Error messages don't reveal whether an invite or customer exists.
- Customer secrets are encrypted with that customer's own data key.
- The founder can't read customer content.
- Postgres listens on 127.0.0.1 only. Its passwords live in `.env` on the Mac only.

## 11. How the other new features fit

The other new features are built now on SQLite, and S1 and S2 then carry them over:
- multi-select for groups;
- the clickable Overview;
- the report time setting;
- exact outage times;
- priority and sentiment;
- the assistant;
- Open chat.

For **Open chat with sending**, each customer can only send from their own linked WhatsApp. It's off by default, every message needs a confirm, and every send is audit-logged and rate-limited.

## 12. Questions for the owner before S4 and S5

1. **Customer limit:** start at 20 active customers on this Mac?
2. **Who pays for Claude?** The founder's API key with a cap per customer (simplest), or each customer brings their own key?
3. **Gmail sending:** while Google's review of the `gmail.send` permission is pending, invites work only for test users, up to 100, added in the Google console. Fine for now?
4. **Billing:** left out of this release?
