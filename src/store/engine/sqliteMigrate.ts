import type Database from 'better-sqlite3';
import type { Migration } from '../migrations.ts';

/**
 * Applies new migrations (those above the highest recorded version) in order, on the file's own handle while it is
 * opened (SqliteDb.open with migrations), before the Db is handed out. Never edits or re-runs an applied one.
 *
 * Fails loudly, applying nothing, when the code knows a migration below the recorded maximum that the database never
 * recorded: a database that ran a later version first (for example v7 from a branch before v6 merged) would otherwise
 * never get it. A number missing from the code itself (v6 on a branch that does not have it yet) is not an error.
 */
export function migrate(db: Database.Database, migrations: readonly Migration[]): void {
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
