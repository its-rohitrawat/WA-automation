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

(The preview and smoke test apply exactly 2.3 and 2.4 to the copies they serve: `scripts/platformFake.ts`, `patchedShell`.)

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
