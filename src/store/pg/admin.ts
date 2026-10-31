import type { AdminConnection } from '../engine/pg.ts';
import { COLLATION_REFUSED, COLLATION_SQL, isByteOrder } from './collation.ts';
import { PG_MIGRATIONS } from './migrations.ts';

// db-bootstrap and db-migrate (SaaS S2.3 and S2.4, plan 4.2 and 4.9). Plain SQL through an admin connection that
// src/store/engine/pg.ts opens (the only file that imports pg). No password or URL is ever printed: every line `out`
// gets is fixed text with role and database names only.

/** The four roles, and what each may do. wa_backup alone bypasses RLS, and it can only read (the nightly dump). */
export const ROLES = {
  wa_owner: 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  wa_app: 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  wa_platform: 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  wa_backup: 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS',
} as const;
export type RoleName = keyof typeof ROLES;

/** The database's own grants, run as the superuser in the new database (plan 4.2, 4.9). */
export function databaseGrants(dbName: string): string[] {
  const db = quoteIdent(dbName);
  return [
    `REVOKE CONNECT, TEMPORARY ON DATABASE ${db} FROM PUBLIC`,
    `GRANT CONNECT ON DATABASE ${db} TO wa_owner, wa_app, wa_platform, wa_backup`,
    'REVOKE ALL ON SCHEMA public FROM PUBLIC',
    'GRANT USAGE, CREATE ON SCHEMA public TO wa_owner',
    'GRANT USAGE ON SCHEMA public TO wa_app, wa_platform, wa_backup',
    // Every table wa_owner creates later: rows for wa_app (P2 then scopes them per customer; P3 takes the platform
    // tables back), and SELECT only for wa_backup, so a later migration stays in the nightly dump.
    'ALTER DEFAULT PRIVILEGES FOR ROLE wa_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wa_app',
    'ALTER DEFAULT PRIVILEGES FOR ROLE wa_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO wa_app',
    'ALTER DEFAULT PRIVILEGES FOR ROLE wa_owner IN SCHEMA public GRANT SELECT ON TABLES TO wa_backup',
    'ALTER DEFAULT PRIVILEGES FOR ROLE wa_owner IN SCHEMA public GRANT SELECT ON SEQUENCES TO wa_backup',
  ];
}

/** A name as a Postgres identifier: lower-case letters, digits and _, as every name here is. */
function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error('a database or role name must be lower-case letters, digits or _');
  return `"${name}"`;
}

export interface BootstrapDeps {
  /** Connects as the superuser to a database ('postgres' first, then the new one). */
  connect: (database: string) => Promise<AdminConnection>;
  /** Each role's password: the three agent roles' from their .env URLs, wa_backup's typed at the prompt. */
  passwords: Record<RoleName, string>;
  dbName: string;
  out: (line: string) => void;
}

/**
 * Creates (or brings up to date) the four roles and the database, then the database's grants. Safe to run again: a role
 * that exists gets its attributes and password set again, a database that exists is kept. Passwords travel as bind
 * values: the server quotes them itself (format %L), so no password is ever pasted into SQL text here.
 */
export async function bootstrap(d: BootstrapDeps): Promise<void> {
  const db = quoteIdent(d.dbName);
  const server = await d.connect('postgres');
  try {
    // A database that is there already must be in byte order (C): checked before anything is changed.
    const there = (await server.sql('SELECT datcollate AS "collate", datctype AS "ctype" FROM pg_database WHERE datname = $1', [d.dbName])).rows[0];
    if (there && !isByteOrder(there)) throw new Error(COLLATION_REFUSED);
    for (const [role, attrs] of Object.entries(ROLES) as [RoleName, string][]) {
      const password = d.passwords[role];
      if (!password) throw new Error(`no password for ${role}`);
      const exists = (await server.sql('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rows.length > 0;
      const verb = exists ? 'ALTER' : 'CREATE';
      const built = await server.sql(`SELECT format('${verb} ROLE %I ${attrs} PASSWORD %L', $1::text, $2::text) AS sql`, [role, password]);
      await server.sql(String(built.rows[0]!.sql));
      d.out(`${exists ? 'Updated' : 'Created'} role ${role}`);
    }
    if (there) d.out(`Database ${d.dbName} is already there: kept`);
    else {
      // Byte-order text (collation and character type C), as SQLite compares text; template0 takes any locale.
      await server.sql(`CREATE DATABASE ${db} OWNER wa_owner ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`);
      d.out(`Created database ${d.dbName}, owned by wa_owner`);
    }
  } finally {
    await server.end();
  }
  const inDb = await d.connect(d.dbName);
  try {
    for (const sql of databaseGrants(d.dbName)) await inDb.sql(sql);
    d.out(`Granted ${d.dbName}: wa_app and wa_platform reach rows only, wa_backup reads only, PUBLIC nothing`);
  } finally {
    await inDb.end();
  }
}

const VERSION_TABLE = `CREATE TABLE IF NOT EXISTS pg_schema_version (
  version integer PRIMARY KEY,
  applied_at text NOT NULL
)`;

/**
 * db-migrate, as wa_owner: applies the migrations above the highest recorded one, each with its version row in one
 * transaction. Never edits or re-runs an applied one. Refuses, applying nothing, when the code knows a migration below the
 * recorded maximum that the database never recorded (as SQLite's runner does). Returns the versions it applied.
 */
export async function migrate(c: AdminConnection, o: { now: () => string; out: (line: string) => void; migrations?: readonly { version: number; sql: string }[] }): Promise<number[]> {
  const migrations = o.migrations ?? PG_MIGRATIONS;
  if (!isByteOrder((await c.sql(COLLATION_SQL)).rows[0])) throw new Error(COLLATION_REFUSED);
  await c.sql(VERSION_TABLE);
  const recorded = new Set((await c.sql('SELECT version FROM pg_schema_version')).rows.map((r) => Number(r.version)));
  const current = Math.max(0, ...recorded);
  const skipped = migrations.filter((m) => m.version < current && !recorded.has(m.version)).map((m) => `P${m.version}`);
  if (skipped.length > 0) {
    throw new Error(`the database is at P${current} but ${skipped.join(', ')} ${skipped.length === 1 ? 'was' : 'were'} never applied; restore a backup or contact the developer`);
  }
  const applied: number[] = [];
  for (const m of migrations) {
    if (m.version <= current) continue;
    await c.sql('BEGIN');
    try {
      await c.sql(m.sql);
      await c.sql('INSERT INTO pg_schema_version (version, applied_at) VALUES ($1, $2)', [m.version, o.now()]);
      await c.sql('COMMIT');
    } catch (e) {
      await c.sql('ROLLBACK').catch(() => undefined);
      throw e;
    }
    applied.push(m.version);
    o.out(`Applied P${m.version}`);
  }
  if (applied.length === 0) o.out(`Already at P${current}: nothing to apply`);
  return applied;
}

/** The role a URL names and its password, checked against the role it must be. Messages name the setting only. */
export function roleOf(setting: string, url: string | undefined, role: RoleName): string {
  if (!url) throw new Error(`${setting} is not configured`);
  const u = new URL(url);
  if (decodeURIComponent(u.username) !== role) throw new Error(`${setting} must connect as ${role}`);
  const password = decodeURIComponent(u.password);
  if (password === '') throw new Error(`${setting} has no password`);
  return password;
}
