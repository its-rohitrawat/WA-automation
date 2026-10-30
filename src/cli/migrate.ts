import type { Env } from '../config/env.ts';
import { copyToPostgres } from '../migrate/copy.ts';
import { exportToSqlite } from '../migrate/exportBack.ts';
import { formatReport } from '../migrate/report.ts';
import { postgresTarget, type CopyTarget } from '../migrate/target.ts';
import { roleOf } from '../store/pg/admin.ts';

// npm run cli -- migrate-to-postgres and export-to-sqlite (SaaS S3.6): the copy tool's two commands, following
// db-migrate's pattern. The owner's URL (DATABASE_OWNER_URL, wa_owner) is the only connection used, and it is never
// printed: every message names a setting, never a value. The tenant is TENANT_ID (customer #1 by default).

export interface MigrateCommandDeps {
  /** The Postgres side (production: postgresTarget on DATABASE_OWNER_URL). Tests: a stand-in. */
  target: (ownerUrl: string) => CopyTarget;
  out: (text: string) => void;
}

export const defaultMigrateDeps = (): MigrateCommandDeps => ({ target: postgresTarget, out: (text) => console.log(text) });

/** Exit code: 0 when every table matched (and, with --apply, the copy committed); 1 otherwise. */
export async function migrateToPostgresCommand(
  env: Env,
  opts: { apply?: boolean; backupDir?: string; dataDir?: string },
  d: MigrateCommandDeps = defaultMigrateDeps(),
): Promise<number> {
  roleOf('DATABASE_OWNER_URL', env.DATABASE_OWNER_URL, 'wa_owner'); // set, and the owner's URL; never printed
  const target = d.target(env.DATABASE_OWNER_URL!);
  try {
    const r = await copyToPostgres(
      { dataDir: opts.dataDir ?? env.DATA_DIR, tenantId: env.TENANT_ID, apply: opts.apply === true, ...(opts.backupDir ? { backupDir: opts.backupDir } : {}) },
      target,
    );
    d.out(formatReport(r, 'copy'));
    return r.ok && (r.applied || opts.apply !== true) ? 0 : 1;
  } finally {
    await target.close();
  }
}

/** Exit code: 0 when every table matched in the new files; 1 otherwise. data/ is never touched. */
export async function exportToSqliteCommand(
  env: Env,
  opts: { out: string; dataDir?: string },
  d: MigrateCommandDeps = defaultMigrateDeps(),
): Promise<number> {
  roleOf('DATABASE_OWNER_URL', env.DATABASE_OWNER_URL, 'wa_owner');
  const source = d.target(env.DATABASE_OWNER_URL!);
  try {
    const r = await exportToSqlite({ dataDir: opts.dataDir ?? env.DATA_DIR, tenantId: env.TENANT_ID, out: opts.out }, source);
    d.out(formatReport(r, 'export'));
    return r.ok ? 0 : 1;
  } finally {
    await source.close();
  }
}
