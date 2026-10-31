import type { CopyTarget } from '../../src/migrate/target.ts';
import { ensurePlatformSchema } from '../../src/platform/schema.ts';
import { ensureFounderTenant } from '../../src/platform/store.ts';
import { openDb, type Db } from '../../src/store/db.ts';
import type { Sql } from '../../src/store/engine/types.ts';

// SQLite by design: the stand-in for Postgres the flow tests copy into (the real server is copyPg.test.ts).
// A stand-in for Postgres, so the copy's whole flow (dry run, apply, a mismatch, the refusals) is tested with no
// server: an in-memory SQLite with the same tables (the tracker schema, the platform tables, and wa_auth as Postgres has
// it), the founder's row seeded as Postgres's P1 seeds it, and a transaction that rolls back on a throw. It keeps no
// tenant_id: these tests are about the flow; customers kept apart is Postgres's job (S2.9), checked under test:pg.

export class FakeTarget implements CopyTarget {
  readonly db: Db;
  latestVersion = 3;
  version = 3;
  readonly setvals: string[] = [];
  /** Tables whose ids Postgres would already have given out (another customer's rows); setval adds its table too. */
  readonly idsUsed = new Set<string>();
  tenants: string[] = [];
  beforeVerify?: (q: Sql) => Promise<void>;

  private constructor(db: Db) {
    this.db = db;
  }

  static async open(): Promise<FakeTarget> {
    const db = openDb(':memory:');
    await ensurePlatformSchema(db);
    await db.exec(`CREATE TABLE wa_auth (phone TEXT NOT NULL, slot TEXT NOT NULL DEFAULT 'live', k TEXT NOT NULL, v BLOB NOT NULL, PRIMARY KEY (phone, slot, k))`);
    await ensureFounderTenant(db, { name: 'Founder', at: '2026-10-29T00:00:00.000Z' });
    return new FakeTarget(db);
  }

  tx<T>(tenantId: string, fn: (q: Sql) => Promise<T>): Promise<T> {
    this.tenants.push(tenantId);
    return this.db.tx(fn);
  }

  async schemaVersion(): Promise<number> {
    return this.version;
  }

  async identityTables(q: Sql): Promise<Set<string>> {
    const tables = (await q.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")).map((t) => t.name);
    const out = new Set<string>();
    for (const t of tables) {
      const id = await q.get<{ type: string; pk: number }>(`SELECT type, pk FROM pragma_table_info('${t}') WHERE name = 'id'`);
      if (id && id.pk === 1 && id.type.toUpperCase() === 'INTEGER') out.add(t);
    }
    return out;
  }

  insertPrefix(table: string, columns: readonly string[]): string {
    return `INSERT INTO ${table} (${columns.join(', ')}) VALUES`;
  }

  async idsGivenOut(_q: Sql, table: string): Promise<boolean> {
    return this.idsUsed.has(table);
  }

  async setval(_q: Sql, table: string): Promise<void> {
    this.setvals.push(table);
    this.idsUsed.add(table);
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  /** Rows in a table, for the tests' checks. */
  async count(table: string): Promise<number> {
    return (await this.db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))!.n;
  }
}
