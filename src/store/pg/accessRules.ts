import { CUSTOMER_TABLES } from './migrations.ts';

// The Postgres access rules, checked on the live catalog (security review S1, S2): db-migrate sets them (P2, P3, P5),
// but a hand fix, a restore with another owner or a later migration that forgets them would pass every test that only
// reads the migrations' text. openStore refuses to start on a database that breaks one, and db-migrate refuses to end
// on one. The words name tables and roles only, never a URL or a password.

/** The tables wa_app must not reach at all: the platform's (P3, D1) and the schema version (P2). */
export const PLATFORM_TABLES = ['tenants', 'users', 'memberships', 'invites', 'platform_audit', 'tenant_keys', 'web_sessions', 'pg_schema_version'] as const;

/**
 * Every table and sequence in public, with what the rules need: row security, its owner, whether wa_app can reach it
 * (any privilege on a table, SELECT on a sequence: its last_value), and its policies (the customer one: named
 * <table>_tenant, for every command, permissive, both USING and WITH CHECK on app.tenant_id). Every role can read these
 * catalogs.
 */
export const ACCESS_SQL = `SELECT c.relname AS name, c.relkind AS kind, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
  pg_get_userbyid(c.relowner) AS owner,
  CASE WHEN c.relkind = 'S' THEN has_sequence_privilege('wa_app', c.oid, 'SELECT')
    ELSE has_table_privilege('wa_app', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') END AS app,
  (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies,
  (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = c.relname || '_tenant' AND p.polcmd = '*'
    AND p.polpermissive AND p.polroles = '{0}'
    AND pg_get_expr(p.polqual, p.polrelid) LIKE '%current_setting(''app.tenant_id''%'
    AND pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%current_setting(''app.tenant_id''%')::int AS tenant_policies
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S')
ORDER BY c.relname`;

export interface CatalogRow {
  name: string;
  kind: string;
  rls: boolean;
  forced: boolean;
  owner: string;
  app: boolean;
  policies: number;
  tenant_policies: number;
}

/** What is wrong, in plain words, one item per problem; empty when every rule holds. */
export function accessProblems(rows: readonly CatalogRow[]): string[] {
  const by = new Map(rows.map((r) => [r.name, r]));
  const problems: string[] = [];
  for (const t of CUSTOMER_TABLES) {
    const r = by.get(t);
    if (!r || r.kind === 'S') {
      problems.push(`table ${t} is missing`);
      continue;
    }
    if (!r.rls) problems.push(`table ${t} has row security off`);
    else if (!r.forced) problems.push(`table ${t} has row security not forced`);
    if (r.owner !== 'wa_owner') problems.push(`table ${t} is owned by ${r.owner}, not wa_owner`);
    if (r.policies !== 1 || r.tenant_policies !== 1) problems.push(`table ${t} does not have exactly its one customer policy`);
  }
  for (const t of PLATFORM_TABLES) {
    const r = by.get(t);
    if (!r || r.kind === 'S') problems.push(`table ${t} is missing`);
    else if (r.app) problems.push(`wa_app can reach platform table ${t}`);
  }
  const known = new Set<string>([...CUSTOMER_TABLES, ...PLATFORM_TABLES]);
  for (const r of rows) {
    if (r.kind === 'S') {
      if (r.app) problems.push(`wa_app can read sequence ${r.name}`);
    } else if (!known.has(r.name) && !r.rls && r.app) {
      problems.push(`table ${r.name} has no row security and wa_app can reach it`);
    }
  }
  return problems;
}

/** The words openStore refuses with (docs/GO-LIVE-postgres.md, part 8). */
export function accessRefused(problems: readonly string[]): string {
  return `This database's access rules are not as db-migrate sets them: ${problems.join('; ')}. The agent did not start, and nothing was changed: contact the developer.`;
}

/** The words db-migrate ends with when its migrations left a rule broken (they were applied; nothing is undone). */
export function accessRefusedAfterMigrate(problems: readonly string[]): string {
  return `db-migrate applied its migrations, but this database's access rules are not as it sets them: ${problems.join('; ')}. Do not start the agent: contact the developer.`;
}
