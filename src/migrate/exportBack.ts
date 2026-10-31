import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePlatformSchema } from '../platform/schema.ts';
import { openDb, type Db } from '../store/db.ts';
import { openSessionFile } from '../store/engine/sessionFile.ts';

import type { Sql } from '../store/engine/types.ts';
import { acquireLock, AlreadyRunningError } from '../util/lock.ts';
import { tableChecksum } from './canonical.ts';
import type { CopyReport, TableResult } from './copy.ts';
import { copyPlan, SESSION_PLANS, type TablePlan } from './plan.ts';
import type { CopyTarget } from './target.ts';

// export-to-sqlite (plan 2026-10-29-saas-s3-s6.md, S3.5; the go-live guide's rollback B): one customer's rows in
// Postgres back into NEW SQLite files (tracker.db, session.db, sender-session.db when the spare phone has keys), in a
// folder that must not exist yet. It never writes into data/: the owner moves the files in by hand. Postgres is only
// read (the transaction is rolled back at the end). Each table is checked as the copy checks it: the rows read from
// Postgres against the rows read back from the new file. A mismatch leaves the files with a DO-NOT-USE.txt beside them.

export interface ExportOptions {
  /** The agent's data folder: its instance lock must be free (the agent stopped), so nothing writes meanwhile. */
  dataDir: string;
  tenantId: string;
  /** A folder that does not exist yet. */
  out: string;
  /**
   * Tests only: false leaves the platform tables out (customer tables only). On a test server other tests write the
   * platform tables meanwhile, which one read transaction cannot keep consistent. The owner's rollback always takes them.
   */
  platform?: boolean;
  /** Tests only: a change to the new files after they are written and before they are checked. */
  afterWrite?: (files: { tracker: Db }) => Promise<void>;
}

/** Rolls the read transaction back, carrying the report out. */
class Done extends Error {
  readonly report: CopyReport;
  constructor(report: CopyReport) {
    super('done');
    this.report = report;
  }
}

const VALUES_PER_INSERT = 20_000;

async function pgRows(q: Sql, p: TablePlan): Promise<Record<string, unknown>[]> {
  const keys = Object.keys(p.fixed);
  const where = keys.length ? ` WHERE ${keys.map((k) => `${k} = ?`).join(' AND ')}` : '';
  return q.all<Record<string, unknown>>(`SELECT ${p.columns.join(', ')} FROM ${p.target}${where}`, keys.map((k) => p.fixed[k]));
}

async function writeRows(db: Db, table: string, columns: readonly string[], rows: readonly Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return;
  const per = Math.max(1, Math.floor(VALUES_PER_INSERT / columns.length));
  const tuple = `(${columns.map(() => '?').join(', ')})`;
  await db.tx(async (t) => {
    for (let i = 0; i < rows.length; i += per) {
      const chunk = rows.slice(i, i + per);
      await t.run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${chunk.map(() => tuple).join(', ')}`, chunk.flatMap((r) => columns.map((c) => r[c] ?? null)));
    }
  });
}

export async function exportToSqlite(o: ExportOptions, source: CopyTarget): Promise<CopyReport> {
  if (existsSync(o.out)) throw new Error(`The folder already exists: ${o.out}. Choose a new one.`);
  let lock: { release(): Promise<void> };
  try {
    lock = await acquireLock(o.dataDir);
  } catch (e) {
    if (e instanceof AlreadyRunningError) throw new Error('The agent is running. Stop it first (docs/GO-LIVE-postgres.md, part 4.2).');
    throw e;
  }
  mkdirSync(o.out, { recursive: true, mode: 0o700 });
  const tracker = openDb(join(o.out, 'tracker.db')); // every SQLite migration, as the agent would make it
  const session = openSessionFile(join(o.out, 'session.db'));
  let sender: Db | undefined;
  try {
    await ensurePlatformSchema(tracker);
    const plans: TablePlan[] = [...(await copyPlan(tracker)), ...SESSION_PLANS].filter((p) => o.platform !== false || !p.platform);
    try {
      return await source.tx(o.tenantId, async (q) => {
        const pv = await source.schemaVersion(q);
        if (pv !== source.latestVersion) throw new Error(`Postgres is at P${pv}; this version reads P${source.latestVersion}.`);
        const read = new Map<TablePlan, Record<string, unknown>[]>();
        for (const p of plans) read.set(p, await pgRows(q, p));
        // The spare phone's file only when it has keys, as on a Mac where the spare number was never linked.
        if (plans.some((p) => p.source === 'sender' && read.get(p)!.length > 0)) sender = openSessionFile(join(o.out, 'sender-session.db'));
        const fileFor = (p: TablePlan): Db | undefined => (p.source === 'tracker' ? tracker : p.source === 'session' ? session : sender);
        for (const p of plans) {
          const db = fileFor(p);
          if (db) await writeRows(db, p.table, p.columns, read.get(p)!);
        }
        await o.afterWrite?.({ tracker });
        const tables: TableResult[] = [];
        for (const p of plans) {
          const db = fileFor(p);
          if (!db) continue; // no spare-phone file: nothing was read for it either
          const pgSide = tableChecksum(p.columns, read.get(p)!);
          const fileSide = tableChecksum(p.columns, await db.all<Record<string, unknown>>(`SELECT ${p.columns.join(', ')} FROM ${p.table}`));
          tables.push({ table: `${p.source}:${p.table}`, targetTable: p.target, source: pgSide, target: fileSide, match: pgSide.rows === fileSide.rows && pgSide.sha256 === fileSide.sha256 });
        }
        const ok = tables.every((t) => t.match);
        if (!ok) writeFileSync(join(o.out, 'DO-NOT-USE.txt'), 'These files did not match Postgres when they were checked. Do not move them into data/.\n');
        throw new Done({ ok, applied: true, tables, backup: null });
      });
    } catch (e) {
      if (e instanceof Done) return e.report;
      throw e;
    }
  } finally {
    await tracker.close().catch(() => undefined);
    await session.close().catch(() => undefined);
    await sender?.close().catch(() => undefined);
    await lock.release();
  }
}
