import { PLATFORM_TABLES, type CatalogRow } from '../../../src/store/pg/accessRules.ts';
import { CUSTOMER_TABLES } from '../../../src/store/pg/migrations.ts';

// What the access check (ACCESS_SQL) reads on a database db-migrate made, for the tests that fake the server: every
// customer table with forced row security, owned by wa_owner, with its one customer policy; the platform tables out of
// wa_app's reach; the sequences readable by nobody but their owner.

export function healthyCatalog(): CatalogRow[] {
  return [
    ...CUSTOMER_TABLES.map((name) => ({ name, kind: 'r', rls: true, forced: true, owner: 'wa_owner', app: true, policies: 1, tenant_policies: 1 })),
    ...PLATFORM_TABLES.map((name) => ({ name, kind: 'r', rls: false, forced: false, owner: 'wa_owner', app: false, policies: 0, tenant_policies: 0 })),
    { name: 'messages_id_seq', kind: 'S', rls: false, forced: false, owner: 'wa_owner', app: false, policies: 0, tenant_policies: 0 },
  ];
}

/** True for the access check's query (ACCESS_SQL), however the fake receives it. */
export const isAccessQuery = (text: string): boolean => /\bpg_policy\b/.test(text);
