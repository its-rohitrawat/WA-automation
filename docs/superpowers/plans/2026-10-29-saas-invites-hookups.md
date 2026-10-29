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
  await ensureFounderTenant(db, { name: env.PLATFORM_FOUNDER_NAME ?? 'Your business', at: systemClock.now().toISOString() });
  ```

  Until this is applied, nothing in the running agent reads or writes the platform tables.
