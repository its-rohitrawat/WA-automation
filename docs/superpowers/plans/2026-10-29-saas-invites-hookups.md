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
