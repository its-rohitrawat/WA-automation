# Lane C design: up to 5 WhatsApp phones per workspace (change 7)

2 November 2026. Lane C, branch `feat/nov-c` from `feat/release-nov` 5bf2a70. For the coordinator's review before any
code. The release design (2026-11-02-november-release-design.md, section 7) gives the scope; this says how.

## The decision in one paragraph

Each workspace gets up to five **reading phones**, numbered 1 to 5. Phone 1 is today's phone, under its current session
name, file and key, so it needs no relink and no data is moved. Each phone runs its own WhatsApp gateway, with its own
allow-list: the groups approved on that phone. A group is approved on exactly one phone, so it is read once. One new
object, the `PhoneSet`, holds the phones and looks to the app like the single gateway it has today. That keeps `app.ts`,
ingest and the brain unchanged. The phone list lives in the workspace's key-value store, and a group's phone in its
approved-group entry. So the only schema change is one Postgres constraint, widened in P7. SQLite needs no v14.

## Data model

| What | Where | Shape |
|---|---|---|
| The phones | kv `wa_phones` (the workspace's own kv: tracker.db on SQLite, `kv` under row security on Postgres) | `{ "phones": [{ "id": 1, "label": "Phone 1", "state": "active", "addedAt": "…" }, …] }`, at most 5 entries, ids 1-5 |
| A group's phone | its approved-group entry (founder: `config/allowed-groups.json`; customer: kv `allowed_groups`) | an optional `"phone": 2`; missing means phone 1 |
| A phone's WhatsApp session | Postgres `wa_auth` rows; SQLite session files | the session names below |
| A phone's number | read from its session (creds), as today | never stored anywhere else |

- **No kv document means phone 1 alone**, label "Phone 1", active. That is how today's phone becomes phone 1 with no
  backfill and no relink. The document is written the first time the owner adds, renames, unlinks or removes a phone.
- **`state`** is `active` (the agent runs its gateway; it may be linked or waiting for a link) or `unlinked` (stopped
  by the owner). An unlinked phone keeps its id and label, so its groups still say which phone they belong to and show
  as "phone unlinked". **Remove** frees the id, but only when no approved group is on that phone. The owner moves those
  groups first.
- **Labels** are owner text: one line, 1-40 characters, control and direction characters made into spaces (the invite
  name's rule). In the page they go through `esc()`. Two phones cannot share a label.

### Session names, files and keys

| Phone | Postgres `wa_auth.phone` | SQLite file (founder on SQLite only) | Sealing key |
|---|---|---|---|
| 1 | `founder` (unchanged) | `data/session.db` (unchanged) | the workspace key, as today |
| 2-5 | `phone2` … `phone5` | `data/session-2.db` … `data/session-5.db` | `deriveSubkey(workspace key, 'wa-session phone <n>')` |
| spare | `spare` (unchanged) | `data/sender-session.db` (unchanged) | unchanged |

- The workspace key is the master key for the founder, and the customer's data key for a customer, as today.
- Phones 2-5 get their own subkey because `sessionCodec` binds neither the phone nor the slot. Today two phones under
  one key would share row ids, and a row copied from one phone would open under another.
- `Phone` in src/wa/authState.ts becomes `'founder' | 'phone2' | 'phone3' | 'phone4' | 'phone5' | 'spare'`, with one
  `phoneName(id)` mapping. `PgSessionDb` keeps its enum check, so the name it writes into its SQL stays one of these
  literals.
- Customers stay Postgres-only, as today.

## Migration and backfill

**Postgres P7** (after lane A's P6), one statement pair in the migration's transaction:

```sql
ALTER TABLE wa_auth DROP CONSTRAINT wa_auth_phone_check;
ALTER TABLE wa_auth ADD CONSTRAINT wa_auth_phone_check
  CHECK (phone IN ('founder', 'phone2', 'phone3', 'phone4', 'phone5', 'spare'));
```

- P1 declared the check inline, so Postgres named it `wa_auth_phone_check`. A test on a fresh database proves that
  name, and the old check is gone: no other phone check is left.
- **Safe on real data:**
  - Nothing is rewritten or moved.
  - The new check is wider than the old one, so every existing row (`founder`, `spare`) passes its validation.
  - The lock on `wa_auth` is brief, and the agent is stopped at go-live.
  - `CUSTOMER_TABLES`, row security and the access-rules check are untouched, because no table is added.
- **No SQLite v14.** Nothing in tracker.db changes. Phone files 2-5 appear only when the founder on SQLite links a phone
  2-5.
- **Backfill:** none. The missing kv document reads as phone 1, and a group with no `phone` reads as phone 1.
- **Rollback depends on the engine.**
  - **On Postgres (the Mac today), a revert alone does not work.** The old code refuses a database at a later version
    (src/store/open.ts:55, `v !== PG_LATEST`). After the release's db-migrate, the database is at P7, so main's code
    will not start on it. Rolling back on Postgres means either:
    1. stopping the agent and restoring the pg_dump taken just before the release into a fresh database, then starting
       main's code; or
    2. rollback A: `exportBack` to SQLite. That must also carry phones 2-5's rows into `session-2.db` …
       `session-5.db`, or those phones need a relink after it. That is task 12 (src/migrate). The copy tool's plan gets
       the same rows.
  - **On SQLite, a revert works with no restore.** The old code reads `founder` and `spare` only:
    - phones 2-5's files and the kv document stay unread;
    - the old groups-file schema is a plain `z.object`, so it drops the unknown `phone` field and loads the file;
    - groups that were on phones 2-5 are then read only if phone 1 is in them: the old behaviour.
- Go-live: db-migrate prints `Applied P6`, `Applied P7`, then the access-rules line. Nothing else.

## How a runtime holds N gateways

A new `PhoneSet` (src/wa/phoneSet.ts) implements `GatewayLike`. It is the `gateway` that `createApp` gets. For each
active phone it holds:
- the phone's `SwitchableGateway`, built exactly as today's one gateway;
- its own `AllowList`: the groups approved on that phone;
- its session Db and its link driver.

| `GatewayLike` member | `PhoneSet` does |
|---|---|
| `onEvent`, `onHistory` | forwards every phone's events. The allow-lists do not overlap, so a group's events come from one phone. |
| `start`, `stop`, `idle`, `failedCount`, `droppedCount` | runs on every phone, or sums them. `stop` stops every phone, each capped as today. |
| `fetchHistory(groupId, …)`, `groupSocket(groupId)` | goes to **the group's phone** only. Its answer is null or false when that phone is not open. |
| `listGroups()` | unions the open phones' lists, each group with the phones that see it (`phones: number[]`) |
| `status()`, `onStatus` | gives one combined status: `open` only when every active phone is open, otherwise the worst one, naming that phone. So today's single health line still flags any phone down. |
| new `phones()` | gives each phone's id, label, state, status and masked number, for Connections, the monitor and health |
| new `isOpenFor(groupId)` | says whether the group's phone is open. The backfill and Open chat use it. |

- **Allow-lists:** `PhoneSet.setConfigs(configs)` splits the approved groups by phone. The runtime calls it wherever it
  calls `app.reloadClients` today: the founder's file watcher, and a customer's `dbGroupsStore` onChange. The app's own
  `allow` stays the union, so ingest's check is unchanged.
- **Backfill** (src/wa/historyBackfill.ts) asks `isOpenFor(groupId)` instead of the one gateway's state. A group whose
  phone is down waits; the other groups go on.
- **Adding or unlinking a phone** changes the set while it runs. The runtime adds or stops that phone's gateway, and
  nothing else restarts.
- **Link:** one link at a time per workspace, as today. The 409 says another phone is being linked.
  - `LinkSessions` gets one driver per active phone: today's `founderLinkDriver`, given that phone's session Db and
    switchable.
  - Link targets become `founder` (phone 1), `phone2` … `phone5`, and `spare`, so the dashboard's existing `founder`
    calls keep working.
  - `session_reset_at` stays the kv key for phone 1, and phones 2-5 get `session_reset_at:phone<n>`.
- **The same number twice is refused.**
  - A phone linked to a number that is already another reading phone, or the spare, is undone with "This number is
    already Phone 2", as the spare's own check does today.
  - The spare's self-send check covers every reading phone's number. senderGateway.ts is mine. src/report/senderLink.ts
    is lane D's: a hookup.
- **Linked-devices name:** each phone keeps "WA Agent - Tracker". There is one per phone, so the name is the same on
  each.

## Routing

- **Open chat send and Delete chat** take the group's socket from `PhoneSet.groupSocket(groupId)`. That is today's call,
  now routed, so lane B's send code needs no change. When the group's phone is not open, the send fails as today with
  `whatsapp_not_connected`, and the message names the phone.
- **Hookup for lane B:**
  - every new gateway method that takes a group (members, delete chat) gets one routing line in `PhoneSet`;
  - the chat route's `connected` becomes `isOpenFor(groupId)`.
  - I write the `PhoneSet` side when B's methods land.
- **Groups:**
  - the directory lists every open phone's groups, each with the phones that see it;
  - approving ties the group to a phone: the one the owner picks, defaulting to the lowest linked phone that sees it;
  - approving it again on another phone moves it, and is audited.

## Unlink

`POST /dashboard/api/whatsapp/phones/:id/unlink { confirm: true }`, owner only. The confirm names the phone (its label)
and its masked number, and says what stays: messages, tasks and approvals. Phone 1 gets a stronger confirm that names it
as the main phone. The spare phone and the morning briefing are not affected by any unlink. The steps:
1. **Log out.** Baileys `sock.logout()` on that phone's socket, through a new gateway `logout()`. WhatsApp then drops the
   linked device from the phone's Linked devices.
2. **Stop and clear.** The phone's gateway stops, and its session rows (or file rows) are cleared with today's
   `resetSession`. That clears that phone's live and backup rows only.
3. **Mark it.** The kv entry becomes `unlinked`, with the time.
4. **Audit.** One `connection` audit line, with the label and the masked number.

- Messages, tasks and the groups' approvals stay. Its groups show "phone unlinked" and are not read.
- If the logout cannot reach WhatsApp (the phone is offline), steps 2-4 still run. The screen says to remove "WA Agent -
  Tracker" from the phone's Linked devices too.
- Relink is the normal link flow on the same id.
- Unlinking phone 1 is allowed. The workspace is then where a new install is: nothing read until a phone is linked.

## Limits

- At most 5 reading phones per workspace. The routes check it, and `wa_auth`'s check allows only those names.
- **Send limits stay per workspace across all its phones:** 30 sends an hour in all, and one every 3 s per group, as
  today. More phones never mean more sends. A test proves that phones 2 and 3 share one budget.
- The spare is separate and not counted.
- One link at a time per workspace.
- Memory: each linked phone is one more WhatsApp socket. The Supervisor's existing `PLATFORM_MAX_RSS_MB` guard still
  decides whether a customer's runtime may start. A note goes in the go-live text.

## Tenant isolation

- A customer's phones live only in its own runtime, on its own tenant-bound Db:
  - its `wa_auth` rows sit under row security, keyed by tenant, phone and slot;
  - its phone list is in its own `kv`, also under row security;
  - its sessions are sealed with its own data key, and phones 2-5 with subkeys of that key.
- Routes take the phone as an integer from 1 to 5 and map it through a fixed table. The id from the URL is never put in
  SQL or a path.
- New tests: one customer's runtime cannot see, link, unlink or route to another customer's phone. A phone 2 row copied
  into phone 3 does not open.

## Files

**Mine (lane C):**
- src/wa: authState, phoneSet (new), phoneList (new), linkSession, historyBackfill, senderGateway, gateway's new
  `logout()`.
- src/runtime: customerRuntime, platformSupervisor, customerSpare.
- src/web/routes/whatsapp.ts.
- views/connections.js, connect.js, linkQr.js.
- tests/wa, tests/runtime and the new tests.

**Loans needed:**
- src/store/pg/migrations.ts: P7, after lane A.
- src/config/groups.ts and groupsWriter.ts: the `phone` field.
- src/control/groups.ts and src/web/routes/groups.ts: phone per group, and approve on a phone.
- src/control/agentControl.ts: per-phone status and Connections.
- src/health/health.ts and setupLine.ts: name the phone in the line.
- src/migrate (plan, copy, exportBack): phones 2-5.
- contract.js: the phones block only.
- views/groups.js: phone parts, after lane D.

**Hookups for others:**
- Lane B: the gateway methods, and `isOpenFor` in chat.
- Lane D: src/report/senderLink.ts's self-send check over every reading number.
- The CLI's `status` listing every phone (later; `link` stays phone 1).
- gateway.ts is shared with lane B. My `logout()` is one method in its own block, landed after B's, or before it by
  agreement.

## Decisions from the review (coordinator, 2 Nov)

1. When a group's phone is unlinked but another linked phone is in the group: **no automatic switch**. Its row offers
   "Read through Phone N", one click and audited.
2. The monitor keeps its one WhatsApp part, the same shape (lane D is fixing the collapsed monitor), with new text:
   "2 of 3 phones connected". Each phone is in its tooltip and on Connections.
3. Phone 1 may be unlinked, behind a stronger confirm that names it as the main phone.
4. Rollback on Postgres needs the pre-release pg_dump or rollback A (see "Migration and backfill").
5. Send limits are per workspace across all phones.
6. Loans:
   - gateway.ts and switchableGateway.ts are lane B's until B1 lands. `logout()` comes after that.
   - pg/migrations.ts and src/migrate come after lane A's piece 2.
   - senderLink.ts may come to lane C directly if lane D does not touch it.
