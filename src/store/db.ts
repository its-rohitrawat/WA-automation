import type Database from 'better-sqlite3';
import { SqliteDb } from './engine/sqlite.ts';
import type { Db as DbInterface } from './engine/types.ts';
import { MIGRATIONS, type Migration } from './migrations.ts';

/**
 * The database the agent uses: the async engine (src/store/engine/). During SaaS S1, code not converted yet reaches
 * better-sqlite3 through raw (and txSync); each S1 task converts its files, and S1.15 removes both.
 */
export type Db = DbInterface & { readonly raw: Database.Database };
export type { Sql } from './engine/types.ts';

/** Opens tracker.db (or :memory:) and applies new migrations. Synchronous until S1.15, so callers do not change yet. */
export function openDb(file: string): Db {
  const db = SqliteDb.open(file);
  try {
    migrate(db.raw);
    return db;
  } catch (e) {
    db.raw.close();
    throw e;
  }
}

/**
 * Applies new migrations (those above the highest recorded version) in order. Never edits or re-runs an applied one.
 *
 * Fails loudly, applying nothing, when the code knows a migration below the recorded maximum that the database never
 * recorded: a database that ran a later version first (for example v7 from a branch before v6 merged) would otherwise
 * never get it. A number missing from the code itself (v6 on a branch that does not have it yet) is not an error.
 */
export function migrate(db: Database.Database, migrations: readonly Migration[] = MIGRATIONS): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null };
  let current = row.v ?? 0;
  const recorded = new Set((db.prepare('SELECT version FROM schema_version').all() as { version: number }[]).map((r) => r.version));
  const skipped = migrations.filter((m) => m.version < current && !recorded.has(m.version)).map((m) => `v${m.version}`);
  if (skipped.length > 0) {
    const verb = skipped.length === 1 ? 'was' : 'were';
    throw new Error(`database is at v${current} but ${skipped.join(', ')} ${verb} never applied; restore a backup or contact the developer`);
  }
  for (const m of migrations) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version);
    })();
    current = m.version;
  }
}

/** S1 only: today's synchronous transaction, on raw. Removed in S1.15. */
export function txSync<T>(db: Db, fn: () => T): T {
  return db.raw.transaction(fn).immediate();
}
