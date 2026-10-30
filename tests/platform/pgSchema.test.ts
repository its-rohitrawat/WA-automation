import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLATFORM_PG_SQL, PLATFORM_TABLES, S2_TENANT_COLUMNS } from '../../src/platform/pgSchema.ts';
import { ensurePlatformSchema } from '../../src/platform/schema.ts';
import { SqliteDb } from '../../src/store/engine/sqlite.ts';

// Until S2's test server exists (S2.7), this checks the Postgres platform SQL against the SQLite platform tables by
// reading it: every SQLite column has its Postgres column, and nothing extra. The test that runs the SQL on a real
// Postgres comes with S2.7 (plan 2026-10-29-saas-s3-s6.md, task A3).

let db: SqliteDb;
beforeEach(async () => {
  db = SqliteDb.open(':memory:');
  await ensurePlatformSchema(db);
});
afterEach(async () => {
  await db.close();
});

/** The columns a CREATE TABLE block in the Postgres SQL defines (constraint lines skipped). */
function pgColumns(table: string): string[] {
  if (table === 'tenants') return [...S2_TENANT_COLUMNS, ...[...PLATFORM_PG_SQL.matchAll(/ADD COLUMN (\w+)/g)].map((m) => m[1]!)];
  const block = new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`).exec(PLATFORM_PG_SQL);
  if (!block) return [];
  return block[1]!.split('\n').map((l) => l.trim()).filter((l) => l && !/^(PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY|CONSTRAINT)\b/.test(l)).map((l) => l.split(/\s+/)[0]!);
}

describe('the Postgres platform schema (P3)', () => {
  it('has every SQLite platform table with exactly its columns', async () => {
    const lite = (await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).map((t) => t.name);
    expect(lite.every((t) => (PLATFORM_TABLES as readonly string[]).includes(t))).toBe(true);
    for (const t of lite) {
      const cols = (await db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${t}')`)).map((c) => c.name).sort();
      expect(pgColumns(t).sort(), t).toEqual(cols);
    }
  });

  it('adds the wrapped data keys, and knows web_sessions is a platform table (moved there by lane A, A4)', () => {
    expect(pgColumns('tenant_keys').sort()).toEqual(['created_at', 'tenant_id', 'wrapped']);
    expect(PLATFORM_TABLES).toContain('web_sessions');
  });

  it('makes customer #1 the founder, with its fixed id', () => {
    expect(PLATFORM_PG_SQL).toContain("UPDATE tenants SET kind = 'founder', updated_at = created_at WHERE id = '00000000-0000-4000-8000-000000000001';");
  });

  it('uses Postgres types only: uuid ids, bytea keys, an identity for the audit log', () => {
    expect(PLATFORM_PG_SQL).not.toMatch(/\bINTEGER PRIMARY KEY\b|\bBLOB\b|\bTEXT PRIMARY KEY\b/);
    expect(PLATFORM_PG_SQL).toMatch(/platform_audit \(\n {2}id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY/);
    expect(PLATFORM_PG_SQL).toMatch(/wrapped bytea NOT NULL/);
  });
});
