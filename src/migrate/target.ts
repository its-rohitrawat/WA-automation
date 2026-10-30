import { openPgPool, withTenant } from '../store/engine/pg.ts';
import type { Sql } from '../store/engine/types.ts';
import { PG_LATEST } from '../store/pg/migrations.ts';

// The Postgres side of the copy tool and of the export back (S3.4, S3.5): one transaction bound to one customer, plus
// the few statements that are Postgres's own (identity columns, setval, the schema version). The copy and the export
// talk to this interface only, so their whole flow is tested against a SQLite stand-in (tests/migrate/fakeTarget.ts),
// and against the real server under npm run test:pg.
//
// It goes through the engine (src/store/engine/pg.ts): withTenant opens the transaction and sets the customer for it
// alone, on a pool for the URL given (wa_owner's, DATABASE_OWNER_URL): keeping the ids (OVERRIDING SYSTEM VALUE) and
// moving the identity sequences on (setval) are the owner's rights. RLS is forced, so the owner is still bound to that
// one customer for every customer table.

export interface CopyTarget {
  /** One transaction for this customer: committed when fn returns, rolled back when it throws. */
  tx<T>(tenantId: string, fn: (q: Sql) => Promise<T>): Promise<T>;
  /** The schema version the target is at, and the one this code needs. */
  schemaVersion(q: Sql): Promise<number>;
  readonly latestVersion: number;
  /** The tables whose `id` is an identity column (their ids are kept, then their sequence moved on). */
  identityTables(q: Sql): Promise<Set<string>>;
  /** `INSERT INTO t (cols)`, with what keeps the given ids, up to `VALUES`. */
  insertPrefix(table: string, columns: readonly string[], keepIds: boolean): string;
  /** Moves the table's identity sequence past its highest id, so new rows get new ids. */
  setval(q: Sql, table: string): Promise<void>;
  /** Tests only: a change made after the inserts and before the checks (the mismatch path). Never set in production. */
  beforeVerify?(q: Sql): Promise<void>;
  close(): Promise<void>;
}

/** The real target: a one-connection pool for `ownerUrl` (never logged) and the engine's withTenant. */
export function postgresTarget(ownerUrl: string): CopyTarget {
  const pool = openPgPool(ownerUrl, { max: 1 });
  return {
    tx: (tenantId, fn) => withTenant(pool, tenantId, fn, { write: true }),
    schemaVersion: async (q) => Number((await q.get<{ v: number | null }>('SELECT max(version) AS v FROM pg_schema_version'))?.v ?? 0),
    latestVersion: PG_LATEST,
    identityTables: async (q) =>
      new Set((await q.all<{ t: string }>("SELECT table_name AS t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'id' AND is_identity = 'YES'")).map((r) => r.t)),
    insertPrefix: (table, columns, keepIds) => `INSERT INTO ${table} (${columns.join(', ')})${keepIds ? ' OVERRIDING SYSTEM VALUE' : ''} VALUES`,
    setval: async (q, table) => {
      // The ids are shared by every customer, but RLS shows this transaction only this customer's rows: max(id) may be
      // below ids other customers already have. So the sequence only ever moves forward: past this customer's highest
      // id, and never below where it already was. The next id is then one above both.
      await q.get(
        `SELECT setval(pg_get_serial_sequence(?, 'id'), GREATEST(COALESCE((SELECT max(id) FROM ${table}), 0), COALESCE(pg_sequence_last_value(pg_get_serial_sequence(?, 'id')::regclass), 0), 1)) AS v`,
        [table, table],
      );
    },
    close: () => pool.end(),
  };
}
