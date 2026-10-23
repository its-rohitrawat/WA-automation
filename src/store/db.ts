import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS, type Migration } from './migrations.ts';

export type Db = Database.Database;

export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    // Deleted content is overwritten, so wiped download details (media.ref_enc) do not stay in free pages.
    db.pragma('secure_delete = ON');
    migrate(db);
    return db;
  } catch (e) {
    db.close();
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
export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): void {
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

export function tx<T>(db: Db, fn: () => T): T {
  return db.transaction(fn).immediate();
}
