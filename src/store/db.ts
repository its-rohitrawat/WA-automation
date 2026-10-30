import { SqliteDb } from './engine/sqlite.ts';
import { migrate as migrateFile } from './engine/sqliteMigrate.ts';
import type { Db as DbInterface } from './engine/types.ts';
import { MIGRATIONS, type Migration } from './migrations.ts';

/** The database the agent uses: the async engine (src/store/engine/). Every statement goes through it. */
export type Db = DbInterface;
export type { Sql } from './engine/types.ts';

/** Opens tracker.db (or :memory:) and applies new migrations on its own handle, before it is handed out. */
export function openDb(file: string): Db {
  return SqliteDb.open(file, { migrations: MIGRATIONS });
}

/** The migration runner (src/store/engine/sqliteMigrate.ts), with today's migrations by default (for tests). */
export function migrate(db: Parameters<typeof migrateFile>[0], migrations: readonly Migration[] = MIGRATIONS): void {
  migrateFile(db, migrations);
}
