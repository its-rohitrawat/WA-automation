import { PLATFORM_TABLES } from '../platform/pgSchema.ts';
import type { Sql } from '../store/engine/types.ts';

// What the copy tool (S3) copies, as data: each SQLite table with its target table, its columns and whether it is a
// platform table, in foreign-key order (parents first). Every table in tracker.db is either planned or in SKIPPED with
// a reason, so a table added later cannot be missed silently (tests/migrate/plan.test.ts). The table names come only
// from the file's own sqlite_master, never from outside input.

export interface TablePlan {
  source: 'tracker' | 'session' | 'sender';
  table: string;
  target: string;
  columns: string[];
  /** Values the target needs that the source has no column for (wa_auth's phone and slot). */
  fixed: Record<string, string>;
  platform: boolean;
}

export const SKIPPED: Readonly<Record<string, string>> = {
  schema_version: "SQLite's own migration record; Postgres has pg_schema_version",
  web_sessions: 'sign-in sessions are never copied; the owner signs in again after the switch',
};

/** A name as a SQL string literal, for the pragma table functions. */
const lit = (name: string) => `'${name.replaceAll("'", "''")}'`;

export async function copyPlan(tracker: Sql): Promise<TablePlan[]> {
  const names = (await tracker.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"))
    .map((t) => t.name)
    .filter((n) => !Object.hasOwn(SKIPPED, n));
  const parents = new Map<string, string[]>();
  for (const n of names) {
    const fks = await tracker.all<{ t: string }>(`SELECT "table" AS t FROM pragma_foreign_key_list(${lit(n)})`);
    parents.set(n, [...new Set(fks.map((f) => f.t))].filter((t) => t !== n));
  }
  const order: string[] = [];
  const visit = (n: string, path: string[]) => {
    if (order.includes(n)) return;
    if (path.includes(n)) throw new Error(`foreign keys loop: ${[...path, n].join(' -> ')}`);
    for (const p of parents.get(n) ?? []) visit(p, [...path, n]);
    order.push(n);
  };
  for (const n of names) visit(n, []);

  const out: TablePlan[] = [];
  for (const t of order) {
    const columns = (await tracker.all<{ name: string }>(`SELECT name FROM pragma_table_info(${lit(t)}) ORDER BY cid`)).map((c) => c.name);
    out.push({ source: 'tracker', table: t, target: t, columns, fixed: {}, platform: (PLATFORM_TABLES as readonly string[]).includes(t) });
  }
  return out;
}

/** The WhatsApp session files (session.db, sender-session.db) into wa_auth: each phone, live and backup (gap G2). */
export const SESSION_PLANS: readonly TablePlan[] = [
  { source: 'session', table: 'auth', target: 'wa_auth', columns: ['k', 'v'], fixed: { phone: 'founder', slot: 'live' }, platform: false },
  { source: 'session', table: 'auth_backup', target: 'wa_auth', columns: ['k', 'v'], fixed: { phone: 'founder', slot: 'backup' }, platform: false },
  { source: 'sender', table: 'auth', target: 'wa_auth', columns: ['k', 'v'], fixed: { phone: 'spare', slot: 'live' }, platform: false },
  { source: 'sender', table: 'auth_backup', target: 'wa_auth', columns: ['k', 'v'], fixed: { phone: 'spare', slot: 'backup' }, platform: false },
];
