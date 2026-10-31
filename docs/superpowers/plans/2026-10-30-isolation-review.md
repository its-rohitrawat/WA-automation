# Customer isolation review, 30 Oct (lane B, read-only)

Reviewed on `feat/saas-s1` at 0658284 (S4.8, Phase A and B so far, c7's platform routes, lane B's Google connect). The
review was by reading the code only: no change was made.

The question for every path: can a customer reach founder data or another customer's? Can a tenant id come from
anywhere but the session record? Can a founder secret reach a customer? Does a failure fall back to the founder? Can a
path escape `DATA_DIR/tenants/<uuid>`? Can spend cross between the founder and a customer? Do the Promise guard and the
RLS assumptions hold?

**Result: no data or secret leak found.** A customer session cannot read founder data or another customer's on any
route that exists today. The findings below are one functional gap that stops the customer paths from working at all,
one availability risk, two design decisions, and defence-in-depth hardening. They are ranked by severity.

## Findings

| # | Severity | Where | What can go wrong | Owner |
|---|---|---|---|---|
| F1 | Medium (functional) | `src/web/routes/api.ts:18`, `work.ts:37`, `controlScreens.ts:50,94`, `assistant.ts:48,53`, `respond.ts:37`; `src/web/mountRoutes.ts:84,176,216` | Every founder route answers a customer session with **403**, and `inScope` answers **503**. Neither serves the customer's own runtime yet. So the customer paths built so far cannot be reached (see below). No leak: this fails closed. | A |
| F2 | Medium (availability) | `src/runtime/platformSupervisor.ts:142-147`; the process handlers in `main.ts` | A customer's crash is kept to that customer only when the code that threw ran inside `tenantContext`. A rejection outside it is attributed to no one, so `crashed()` returns false and the whole process exits, the founder included. Examples: a `pg` pool `'error'` event, a callback a library schedules from its own module-level timer. One customer's fault would then stop every runtime. | A (C for `context.ts`) |
| F3 | Medium (design decision) | `src/runtime/customerRuntime.ts:265`; `src/setupMode.ts:37-48`; `src/runtime/customerProfile.ts:17-24` | A customer's Google token is stored with issuer `web` (S4.7 A1). Their runtime's hub is built from `googleCredentials(customerProfile(env))`, which has no `DASHBOARD_GOOGLE_CLIENT_ID` or `SECRET`, because the profile denies them by default. So the hub reports `no_client`, and the customer's Drive and meetings can never use the token. The fix needs a decision: pass the founder's **web OAuth client** (id and secret) to customer hubs, in-process only and never in a response or a customer env, or give the hub a client factory. | A (decision: coordinator/owner) |
| F4 | Low (fail-open by construction) | `src/web/sessions.ts:151` | `tenantId: row.tenant_id ?? FOUNDER_TENANT_ID`. A Postgres row without a tenant would become a **founder** session. It's safe today, because `web_sessions.tenant_id` is `NOT NULL` (`src/store/pg/migrations.ts:450`) and the column is selected on Postgres. But the default points the wrong way: a future schema or SELECT change would fail open. On Postgres, a missing tenant should end the session (`return undefined`). | A |
| F5 | Low (defence in depth) | `src/store/engine/pg.ts:125`; `src/store/open.ts:11` | `PgTenantDb.forTenant(id)` is a public method, so any code holding one customer's Db can open another's (RLS then scopes it to the other customer, as asked). Only the Supervisor calls it today, with ids from the platform's tenants table. Customers run no code. Still, a customer runtime is handed a Db that can switch tenants. Better: give the Supervisor a separate factory (`(id) => PgTenantDb`) and drop the method from the instance the runtimes receive. | A |
| F6 | Low (consistency) | `src/stt/local.ts` (`TENANT_ID`, `workDirAllowed`) vs `src/runtime/customerProfile.ts:31-35` | The local engine accepts a work folder under `tenants/<any hex UUID>/tmp`, the founder's own id included. `customerDataDir` accepts only a v1-8 RFC 4122 UUID that isn't the founder's. Harmless, since the founder's work folders are under `DATA_DIR/tmp`. But the two rules should be one: reuse customerDataDir's check. | B (mine) |
| F7 | Low (functional) | `src/web/routes/auth.ts:185` | The ordinary dashboard sign-in refuses anyone not on `DASHBOARD_OWNER_EMAILS` (`not_owner`) and makes founder sessions only. Plan S4.8 step 1 says "an accepted invite's member signs in through the ordinary dashboard sign-in, which the member guard accepts". So a customer whose session expires can only come back through `/signup`. Fails closed. | A |
| F8 | Info | `src/runtime/customerRuntime.ts` (its `log`), `src/runtime/platformSupervisor.ts:102` | Every customer runtime logs through the founder process's logger, with no `tenant` field on its lines. Logs still hold ids and counts only, so it isn't a leak. But one customer's lines can't be told from another's or from the founder's, which weakens the audit and makes an incident harder to scope. Better: `log.child({ tenant: t.id })` per runtime. | A |
| F9 | Info | `src/web/http.ts:78-85` | The missing-await guard covers every JSON response (`sendJson`, `sendError`). It doesn't cover redirects, the QR stream (SSE) or a Promise used as a boolean (`if (p)`). It doesn't need to today: every such value I traced is a string or is awaited (`isFounder` is synchronous; `sessionWorkspace`, `memberships`, the Google callback and the sign-up callback are all awaited). | — |

### F1 in detail: why the customer paths are unreachable today

- **Google connect** (S4.7 A1, `src/web/routes/google.ts`): `POST /dashboard/api/google/connect` is mounted with `change`, so `inScope` answers 503 to a customer (`mountRoutes.ts:171`). The callback uses `guard.requireOwner` (`mountRoutes.ts:176`), so a customer coming back from Google is redirected to `/dashboard`. The signed-state and per-customer storage code is correct and tested, but no customer can reach it until these two mounts take a customer's session and that customer's route deps.
- **The customer screens**: Overview, Activity, Settings, Automations and Audit read through `registerReadApi`, `registerWorkApi` and `registerControlApi`, which call `requireOwner`, so a customer gets **403**. The shell's "Your workspace is starting" state is keyed to **503 workspace_starting**, so a customer sees an error card, and the 10 s status poll shows the offline banner.
- **Fix (lane A, Phase B 4 "routes with scope")**: route each request by `session.tenantId` to that customer's runtime deps. Until a customer's runtime is running, answer `503 workspace_starting`, never 403, for the screens the customer nav shows.

## What I checked and found sound

1. **Founder data stays with the founder.**
   - `requireSession` gives `role: 'founder'` only to an owner-list email in `FOUNDER_TENANT_ID` (`guard.ts:91-94`).
   - Every agent route is either `requireOwner` or behind `inScope`.
   - The platform's founder routes all check `isFounder` (`platform.ts:129-220`), which is `o.role === 'founder'` (`mountRoutes.ts:160`).
2. **The tenant comes only from the session record.**
   - `ownerOf` copies `s.tenantId` and `s.role` from the guard's session (`mountRoutes.ts:75-77`).
   - `sessionWorkspace` takes `o.tenantId` and re-checks the membership on every request (`platform.ts:181-186`).
   - A sign-up session's tenant comes from `redeemInvite` (`platform.ts:369-372`).
   - Google connect uses only `ctx.tenantId`, and its signed state must match it (`google.ts`, S4.7 A1).
   - No route reads a tenant id from a body, parameter or header.
3. **No founder secret reaches a customer.**
   - `customerProfile` copies only `CUSTOMER_KEYS` (`customerProfile.ts:17-24`): no `ANTHROPIC_API_KEY`, `STT_API_KEY`, Google client secrets, owner list, database URLs, report or heartbeat.
   - A customer's Anthropic key is their own (`AiKeys`) and is never echoed.
   - `sttEnvFor(…, false)` drops `STT_API_KEY` (`customerRuntime.ts:96`). The master key is used only to unwrap data keys (`TenantKeys`).
   - Crash and start logs carry the error's type and code only (`supervisor.ts:214-217`, `setupShell.ts:58`).
   - The key-test call uses the customer's key (`platformSupervisor.ts:73`).
4. **Failures fail closed** (apart from F4's dormant default).
   - A membership lookup that throws gives 503, not the founder (`guard.ts:96-101`).
   - A customer start that throws (including `StartupExit` from `planStartup`) is caught by the Supervisor and backed off (`supervisor.ts:178-188`). It never reaches main.ts's exit.
   - With no stateKey or resolver, Google connect refuses a customer.
5. **Paths stay inside the customer's folder.**
   - `customerDataDir` refuses a non-UUID, the founder's id, and anything not directly inside `DATA_DIR/tenants` (`customerProfile.ts:31-41`).
   - The process speech engine refuses work folders outside `DATA_DIR/tmp` and `tenants/<id>/tmp` (`src/stt/local.ts`, tested with `../` escapes).
   - On Postgres, WhatsApp sessions are rows in the customer's Db, not files.
6. **Spend.**
   - Only the founder's SpendGuard joins the platform ceiling (`customerRuntime.ts:374`, `t.founder && d.globalSpend`).
   - A customer's cap is their own setting, default US$5 (`customerRuntime.ts:373`).
   - Customers have the assistant, meetings and the report off, and use only local speech, so the founder pays for none of their calls.
7. **RLS and the guard.**
   - Every PgTenantDb statement runs in its own transaction, with `set_config('app.tenant_id', $1, true)` as a bound parameter (`pg.ts:101-105`).
   - Every customer table has `FORCE ROW LEVEL SECURITY` with USING and WITH CHECK on `current_setting('app.tenant_id', true)` (`pg/migrations.ts:420-423`), and the id is checked as a UUID first (`pg.ts:102,118`).
   - `jsonText` refuses a Promise anywhere in a JSON body (`http.ts:78-85`).

## Suggested order

1. **F1**, with Phase B 4: per-customer route scope, and 503 workspace_starting until the runtime runs. Without it, the customer flows built so far (Google connect, the customer screens) stay unreachable.
2. **F3**: decide how customer hubs get the web OAuth client, before any customer connects Google.
3. **F2**: attribute or contain errors raised outside `tenantContext`. For example, attach pg pool `'error'` handlers per customer pool, and on an unattributed rejection log it and exit only when the founder's runtime is the one affected.
4. **F4, F5, F8**: small hardening, any time.
5. **F6** (mine) and **F7**: small, with their next change.
