# SaaS invites and sign-up: hookups for the owning lanes

Branch `feat/saas-invites` (S5: design sections 5, 6 and 4.3) adds **new files only**. Everything that has to change in a
file another lane owns is listed here as an exact patch, for that lane to apply after its own task on the file. The
feature is tested without these hookups, through its own test harness (`tests/web/platformRoutes.test.ts` and the
preview script).

Each entry gives: the file, its owner, where, and the change. Nothing here is applied yet.

## 1. Platform tables: created by `ensurePlatformSchema`, not by a migration

- **No change to `src/store/migrations.ts`** (lane A/B). The platform tables (`tenants`, `users`, `memberships`,
  `invites`, `platform_audit`) are in `src/platform/schema.ts` and created with `CREATE TABLE IF NOT EXISTS` by
  `ensurePlatformSchema(db)`.
- **In S2** they become the Postgres *platform* schema, owned by `wa_owner`. `wa_app` reaches them only through
  `SECURITY DEFINER` functions (design 4.2). The query bodies in `src/platform/store.ts` and `src/platform/invites.ts`
  are those functions' bodies, so S2 can move them as they are:
  - find the memberships for a verified email: `membershipsFor`;
  - redeem an invite: `redeemInvite` (one transaction);
  - list the customers, for the founder: the Customers query (piece f);
  - create a customer: `createInvite` (customer and invite together).
- **Hookup (lane A, `src/main.ts`)**, at start, after the tracker database is opened and before the web server starts:

  ```ts
  import { ensurePlatformSchema } from './platform/schema.ts';
  import { ensureFounderTenant } from './platform/store.ts';
  // …
  await ensurePlatformSchema(db);
  // PLATFORM_FOUNDER_NAME would be a new optional .env setting (src/config/env.ts); until then the literal.
  await ensureFounderTenant(db, { name: 'Your business', at: systemClock.now().toISOString() });
  ```

  Until this is applied, nothing in the running agent reads or writes the platform tables.

## 2. The invite API and the Invite screen (piece b)

### 2.1 `src/web/mountRoutes.ts` (lane A): register the platform routes

- Imports, with the other route imports:

  ```ts
  import { mountPlatformRoutes, type PlatformRouteDeps } from './routes/platform.ts';
  ```

- `AgentRoutesDeps`, after `links: LinkSessions;`:

  ```ts
  /** The platform screens (SaaS S5): invites, later customers. Absent: no platform routes. */
  platform?: Omit<PlatformRouteDeps, 'isFounder'>;
  ```

- In `mountAgentRoutes`, after the `read`/`change` registrars are defined (next to the clients routes,
  `read('/dashboard/api/clients', …)`):

  ```ts
  // The platform owner is a dashboard owner (DASHBOARD_OWNER_EMAILS) until customer sessions exist.
  if (d.platform) mountPlatformRoutes({ read, change }, { ...d.platform, isFounder: (o) => owners.has(o.actor.trim().toLowerCase()) });
  ```

### 2.2 `src/main.ts` (lane A): the platform deps

In the `mount: (m) => mountAgentRoutes(m, { … })` object, next to `clients:`:

```ts
platform: {
  db: trackerStore, clock: systemClock, log,
  publicUrl: env.DASHBOARD_PUBLIC_URL ?? `http://localhost:${env.DASHBOARD_PORT}`,
  founderName: 'Rohit', // or a new optional .env setting, PLATFORM_FOUNDER_NAME (src/config/env.ts)
  mailer: null, // piece c: the founder's Gmail sender, once gmail.send is granted (section 3)
},
```

### 2.3 `src/web/public/app.js` (lane A): the platform screens

After line 16, `import './views/screens.js';`:

```js
import './views/platform.js';
```

### 2.4 `src/web/public/router.js` (lane A): the nav entries

In `NAV`, the `System` group (line 10), at its start:

```js
['System', [['customers', 'Customers', 'store'], ['invite', 'Invite a customer', 'mail'], ['connections', 'Connections', 'plug'], …
```

These two System entries are for the founder only. The Getting started entry is not part of 2.4: it is for customer
sessions only (5.1), never the founder.

(The preview and smoke test apply 2.3, 2.4 and the 5.1 entry to the copies they serve: `scripts/platformFake.ts`,
`patchedShell`. The preview shows Getting started to the founder too, only because its one signed-in person is both the
founder and a customer's member, and the shell has no session role yet.)

### 2.5 `src/web/oidc.ts` (lane A): the screens a sign-in may return to

In `DASHBOARD_SCREENS`, add `'customers'` and `'invite'` (and `'onboarding'`, piece e), so a founder signed out on one of
these screens comes back to it after signing in.

## 3. Sending invites from the founder's Gmail (piece c)

The sender is `src/platform/gmailSender.ts`: Gmail's `messages.send` through the founder's existing Google sign-in
(`OAuth2Client.request` from google-auth-library, which refreshes the token), so **no new package**. It needs the
`gmail.send` permission. Until these hookups are applied, `mailer` stays `() => null` and invites go by Copy link.

### 3.1 `src/output/googleAuth.ts` (lane B): ask for `gmail.send` on the main account

`requestedScopes` (line 32) decides what the main account's Google connect asks for, in the dashboard
(`src/web/routes/google.ts`, line 108) and in `cli google-auth`. Add the send permission when invites by email are on:

```ts
import { GMAIL_SEND_SCOPE } from '../platform/gmailSender.ts';
// …
export function requestedScopes(env: Pick<Env, 'MEETINGS_ENABLED' | 'INVITES_GMAIL'>): string[] {
  return [...DRIVE_SCOPES, ...(env.MEETINGS_ENABLED ? MEETING_SCOPES : []), ...(env.INVITES_GMAIL ? [GMAIL_SEND_SCOPE] : [])];
}
```

and in `SCOPE_NAMES`: `[GMAIL_SEND_SCOPE]: 'Send email as you (invites only)'`.

- `INVITES_GMAIL` is a new optional boolean in `src/config/env.ts` (default false): turning it on asks the founder to
  approve `gmail.send` once, at the next Google connect. Google allows it for **test users only** (up to 100) until it
  reviews the app (design section 2).
- `src/web/routes/google.ts` line 108 passes `{ MEETINGS_ENABLED: …, INVITES_GMAIL: … }` (lane A).

### 3.2 `src/main.ts` (lane A): the mailer

Replace `mailer: null` from 2.2 with:

```ts
import { founderMailer, oauthGmailTransport } from './platform/gmailSender.ts';
// …
mailer: () => {
  const client = google.hub.client(MAIN_ACCOUNT);
  if (!client) return null;
  return founderMailer({
    grantedScopes: grantedScopes(trackerStore, MAIN_ACCOUNT),
    from: accountEmail(trackerStore, MAIN_ACCOUNT),
    transport: oauthGmailTransport(() => google.hub.client(MAIN_ACCOUNT)!),
  });
},
```

The getter runs on every request, so a reconnect that grants `gmail.send` applies at once. If `grantedScopes` and
`accountEmail` become async in S1 (lane B, S1.12), read both at start and after each Google reconnect into a variable,
and have the getter read that variable.

## 4. The public sign-up: `/signup` (piece d)

`mountSignupRoutes(router, deps)` in `src/web/routes/platform.ts` adds four public routes: `GET /signup` (the page,
`public/signup.html` + `views/signup.js`), `GET /signup/api/invite`, `GET /signup/google` and `GET /signup/callback`.
They take no owner session (the visitor has none yet). Each is rate-limited per address, and sign-in attempts per link
too. The router is matched before the website, so `/signup` needs no change to `src/web/site.ts`.

### 4.1 Where to mount it (lane A)

In `src/web/start.ts` (or `mountAgentRoutes`, which receives `m.router`), once, when the platform is on:

```ts
import { mountSignupRoutes } from './routes/platform.ts';
// …
mountSignupRoutes(m.router, {
  db: d.db, clock: d.clock, log: d.log,
  publicUrl: env.DASHBOARD_PUBLIC_URL!,   // the Google client's redirect URI list must include <publicUrl>/signup/callback
  founderName: 'Rohit',
  google: web ? { clientId: web.clientId, exchange: googleCodeExchanger(web), verify: googleIdVerifier(web.clientId) } : null,
  startSession: (ctx, o) => …, // 4.2
  secure: m.secureFor,         // the same Secure-cookie rule as the owner's session
});
```

`web` is `googleCredentials(env).web` (as for the owner sign-in). In the Google Cloud console, add
`<DASHBOARD_PUBLIC_URL>/signup/callback` to the web client's authorised redirect URIs.

### 4.2 Starting the customer's session (lane A, with S4)

`startSession` receives `{ email, name?, tenantId, userId }` after the invite is redeemed. Today's sessions are for
owners on `DASHBOARD_OWNER_EMAILS` only, so a customer session needs:

- the session record to carry `tenantId` (and the role, `owner` of that tenant);
- the guard to accept a session whose email has a membership (`membershipsFor`), not only the owner list;
- every data route to run through `withTenant(tenantId)` (S2), so the customer sees only their own data.

Until then, `startSession` can create the session (`SessionStore.create`) for the email with the tenant noted, and the
guard keeps refusing it everywhere except the onboarding screen (piece e). The sign-up itself (invite used, membership,
customer `onboarding`) is complete and tested without it.

### 4.3 `src/web/oidc.ts` (lane A)

Nothing to change: the sign-up reuses `PendingSignIns`, `authorizeUrl`, `checkClaims` and the verifier as they are.

## 5. Getting started: the onboarding checklist (piece e)

`src/platform/onboarding.ts` builds the checklist (design section 6), `views/onboarding.js` draws it, and
`GET /dashboard/api/platform/onboarding` (mounted with the other platform routes, 2.1) answers it for the signed-in
person's own workspace (their membership). A customer becomes `active` once WhatsApp and the API key are both done.

### 5.1 The nav (lane A)

- `src/web/public/router.js`: a `Getting started` entry, `['onboarding', 'Getting started', 'flash']`. For a **customer**
  session it is the first Workspace entry, and Clients, Tasks, Meetings and Tracker are shown locked until the
  workspace is active (the approved demo's customer nav). For the founder it is not shown. This needs the shell to know
  the session's role, which arrives with customer sessions (4.2), so it is one change there.
- `src/web/oidc.ts` `DASHBOARD_SCREENS`: add `'onboarding'` (see 2.5).

### 5.2 The step probes (S4, the customer runtimes)

`mountPlatformRoutes` takes `probes?: OnboardingProbes`. Today none is passed, so every step says
"coming with the customer workspace" and steps 3 to 6 stay locked. S4 passes real probes, one answer per step:

| Step | Done when |
|---|---|
| `whatsapp` | the customer's runtime has a linked WhatsApp session |
| `key` | the customer's Anthropic key is stored and passed its test call |
| `spare` | the customer's spare number is linked |
| `drive` | the customer's own Google token is stored |
| `groups` | at least one group is approved in the customer's allow-list |
| `report` | the customer saved a report time |

A step that exists but is not done answers `todo`; the screen then needs that step's own panel (the QR code, the key
form and so on), which S4 adds to `views/onboarding.js` in place of the "coming" note.

## 6. Customers: setup and health (piece f)

`src/platform/customers.ts` lists every business (the founder's first) with status, onboarding progress, last
activity, memory and AI key state, and pauses or resumes a customer. `views/customers.js` draws it. The routes are
founder only and mounted with the others (2.1):

- `GET /dashboard/api/platform/customers`
- `POST /dashboard/api/platform/customers/:id/pause` (never the founder's own business; active or onboarding only)
- `POST /dashboard/api/platform/customers/:id/resume` (back to active when WhatsApp and the key are done, else
  onboarding; refused when it would pass the limit of active customers)

Both changes are audited (`tenant.paused`, `tenant.resumed`). The nav entry and `DASHBOARD_SCREENS` are already in 2.4
and 2.5. Nothing here reads a customer's messages, tasks, files or keys.

### 6.1 What S4 passes in (main.ts, lane A)

`mountPlatformRoutes` takes two more optional deps; until S4 neither is passed, so memory shows "—" and the limit is 20.

```ts
mountPlatformRoutes(m, {
  // ...the deps from 2.2, 3.2 and 5.2...
  health: supervisor.health,                  // { memoryMb(tenantId): number | null }, from each customer runtime
  maxActive: settings.platformMaxActive ?? 20, // PLATFORM_MAX_ACTIVE, a setting on the Mac (design 7)
});
```

### 6.2 Pause and resume start or stop the runtime (S4)

Today Pause and Resume only change `tenants.status`. The Supervisor (S4) watches that status: `paused` stops the
customer's WhatsApp reader and AI work, `active` or `onboarding` starts them again. Nothing is deleted either way.

### 6.3 The AI key column

It comes from the `key` onboarding probe (5.2): `done` shows Configured, `todo` shows Missing, and "coming" shows "—".
The key itself is never read or shown.

## 7. S2 amendments: the Postgres platform tables (task A3, lane A)

The plan is [2026-10-29-saas-s3-s6.md](2026-10-29-saas-s3-s6.md), section 3. Lane C wrote the SQL in
`src/platform/pgSchema.ts` (`PLATFORM_PG_SQL`, `PLATFORM_TABLES`, `S2_TENANT_COLUMNS`), and
`tests/platform/pgSchema.test.ts` checks it against the SQLite platform tables column by column. Lane A applies these
when it writes S2.4:

### 7.1 `src/store/pg/migrations.ts`: P3

P1 keeps S2's four-column `tenants` (`S2_TENANT_COLUMNS`) and its customer #1 seed. P3 is the platform SQL, followed by
A4's grants (decision D1, 30 Oct: the `wa_platform` role):

```ts
import { PLATFORM_PG_SQL } from '../../platform/pgSchema.ts';
// …after P2:
{
  version: 3,
  sql: `${PLATFORM_PG_SQL}
REVOKE ALL ON tenants, users, memberships, invites, platform_audit, tenant_keys, web_sessions FROM wa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, users, memberships, invites, platform_audit, tenant_keys, web_sessions TO wa_platform;
GRANT USAGE, SELECT ON SEQUENCE platform_audit_id_seq TO wa_platform;`,
},
```

`web_sessions` must exist before these grants: A4 step 3 creates it in P3's position as a platform table (with
`tenant_id uuid NOT NULL REFERENCES tenants (id)`, no RLS), and takes it out of `CUSTOMER_TABLES`.

### 7.2 `tests/store/pg/rls.test.ts`: the catalog test skips the platform tables

In S2.9's last test, `c.relname NOT IN ('tenants', 'pg_schema_version')` becomes:

```ts
import { PLATFORM_TABLES } from '../../../src/platform/pgSchema.ts';
// …
WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'pg_schema_version' AND NOT (c.relname = ANY($1))`, [[...PLATFORM_TABLES]]
```

and the `REVOKE ALL ON tenants, pg_schema_version FROM wa_app;` line in P2 stays as it is (P3 revokes the rest).

### 7.3 `tests/helpers/pg.ts`: lane C's Postgres test for P3

With S2.7's test server in place, lane C adds the run-on-Postgres half of `tests/platform/pgSchema.test.ts` (the
`describe.runIf(process.env.DB_ENGINE === 'postgres')` test in the plan, task A3 step 1). It needs `ownerClient()`
from `tests/helpers/pg.ts`, which S2.4's own schema test also uses; lane A owns that helper.

## 8. The customer's own Anthropic key (S4.2, lane A with S4.4)

`src/platform/aiKey.ts` (`AiKeys`, `modelsListTester`) and two routes in `src/web/routes/platform.ts`
(`POST /dashboard/api/platform/ai-key` with `{ key }`, and `POST /dashboard/api/platform/ai-key/remove`) are done and
tested with fakes. The routes answer `not_ready` until `main.ts` passes `aiKeys`. With S4.4, in the platform deps
(2.2):

```ts
import Anthropic from '@anthropic-ai/sdk';
import { AiKeys, modelsListTester } from './platform/aiKey.ts';
import { keepConnectTimeoutCode } from './brain/claudeClient.ts';
// …once, at start:
const keyTester = modelsListTester((apiKey) => new Anthropic({ apiKey, fetch: keepConnectTimeoutCode }));
// …in the platform deps:
aiKeys: (tenantId) => {
  const rt = supervisor.runtimeDb(tenantId); // that customer's PgTenantDb; null when their runtime is not built
  return rt ? new AiKeys({ db: rt, platform: platformDb, tenantId, dataKey: () => tenantKeys.dataKey(tenantId), tester: keyTester, clock: systemClock }) : null;
},
```

The customer runtime (S4.4) builds its Claude clients from `await aiKeys.load()`, and never from `ANTHROPIC_API_KEY`;
`null` means no AI work for that customer (design 7). The founder's runtime keeps `ANTHROPIC_API_KEY`.

## 9. The Supervisor (S4.5, lane A with S4.4)

`src/runtime/supervisor.ts` (`Supervisor`), `src/runtime/context.ts` (`tenantContext`, `crashOwner`, `guarded`) and
`src/runtime/backoff.ts` are done and tested with fake runtimes (`tests/runtime`). On SQLite only the founder runs. In
`src/main.ts`, once S4.4's `buildCustomerRuntime` exists:

```ts
import { crashOwner } from './runtime/context.ts';
import { Supervisor } from './runtime/supervisor.ts';
import { FOUNDER_TENANT_ID } from './platform/store.ts';
// …after the platform store is open and before the web server starts:
const supervisor = new Supervisor({
  db: platformDb, clock: systemClock, log, engine: env.DB_ENGINE,
  maxActive: env.PLATFORM_MAX_ACTIVE, maxRssMb: env.PLATFORM_MAX_RSS_MB, rssMb: () => process.memoryUsage.rss() / 1_048_576,
  factory: { start: (t) => buildCustomerRuntime(t, shared) }, // t.crashed goes to the runtime's guarded() entry points (S4.6)
});
await supervisor.reconcile();
const tick = setInterval(() => supervisor.poke(), 60_000);
tick.unref();
// A throw that reaches the process: the customer whose code threw is restarted alone; the founder's (or no one's)
// keeps today's behaviour, exit, and launchd starts the agent again.
for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, (e: unknown) => {
    const owner = crashOwner();
    if (owner && owner !== FOUNDER_TENANT_ID) return void supervisor.crashed(owner, e);
    log.fatal({ err: { name: (e as Error)?.name } }, event);
    process.exit(1);
  });
}
```

- Shutdown: `await supervisor.stopAll()` in the stop handlers, before the database closes, and `clearInterval(tick)`.
- Platform deps (hookup 6.2): `poke: () => supervisor.poke()`, called by the platform routes after a pause, a resume or an
  activation. That is one optional dep in `src/web/routes/platform.ts` (lane C adds it with S4.9).
- `env.PLATFORM_MAX_RSS_MB` (default 4096) is new in `src/config/env.ts` (D4), next to `PLATFORM_MAX_ACTIVE` (S5H.3).

## 10. Probes, health and pokes from the Supervisor (S4.9, lane A with S4.4)

`src/runtime/probes.ts` (`runtimeProbes`, `runtimeHealth`), `Supervisor.facts(id)` and the `poke` deps of both route
groups are done and tested. This replaces the placeholders in 5.2, 6.1 and 9. In `src/main.ts`:

```ts
import { runtimeHealth, runtimeProbes } from './runtime/probes.ts';
// …before supervisor.reconcile() (section 9), so the share counts only what the runtimes add:
const baselineMb = process.memoryUsage.rss() / 1_048_576;
// …in the platform deps (2.2):
probes: runtimeProbes(supervisor),
health: runtimeHealth(supervisor, { rssMb: () => process.memoryUsage.rss() / 1_048_576, baselineMb }),
maxActive: env.PLATFORM_MAX_ACTIVE,
poke: () => supervisor.poke(),
// …and in the sign-up deps (4.1):
poke: () => supervisor.poke(),
```

- Each customer runtime (S4.4) returns `facts()` from its handle (`RuntimeFacts` in `src/runtime/supervisor.ts`):
  whatsapp linked, spare linked, Drive connected, groups approved, report time set, and the AI key's state. They are read
  synchronously from what the runtime holds in memory; nothing in a probe touches the network.
- The routes poke after a pause, a resume, a sign-up (setup runtime) and an activation (full runtime). The 60 s tick in
  section 9 catches anything else.

## 11. `startSession` says whether it started a session (lane A, with S5H.6 and S4.8)

`SignupDeps.startSession` now returns `Promise<boolean>`. Customer sessions exist on Postgres only (plan S4.8 step 1,
decided 30 Oct). On `false` the sign-up callback sends the new customer to `/signup?note=waiting`, a "You're signed up;
your workspace opens once WA Agent has finished an upgrade" card. The invite is still used, the membership made, and the
customer `onboarding`. Both paths are tested (`tests/web/platformSignup.test.ts`).

In the sign-up deps (4.1), lane A's `startSession`:

```ts
startSession: async (ctx, s) => {
  if (env.DB_ENGINE !== 'postgres') return false; // SQLite: founder-only sessions; the customer gets the waiting page
  // Postgres (S4.8): the sign-in's audit row in the customer's own Db first, then the session row in the platform Db,
  // which cannot share one transaction (lane A's note, 30 Oct). A failed session write leaves the audit row.
  // …audit, then sessions.create({ email: s.email, tenantId: s.tenantId, role: 'owner' }), then the cookie on ctx.res…
  return true;
},
```

Until S5H.6 is applied nothing calls it. Before S4.8, with `DB_ENGINE=sqlite`, it is just the first line.
