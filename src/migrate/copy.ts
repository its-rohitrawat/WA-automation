import { existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { senderSessionDbPath, sessionDbPath, trackerDbPath } from '../config/paths.ts';
import { SqliteDb } from '../store/engine/sqlite.ts';
import type { Sql } from '../store/engine/types.ts';
import { MIGRATIONS } from '../store/migrations.ts';
import { acquireLock, AlreadyRunningError } from '../util/lock.ts';
import { tableChecksum, type TableSum } from './canonical.ts';
import { copyPlan, SESSION_PLANS, type TablePlan } from './plan.ts';
import type { CopyTarget } from './target.ts';

// migrate-to-postgres (design 8.3; plan 2026-10-29-saas-s3-s6.md, S3.4): the founder's SQLite files into Postgres as one
// customer, in ONE transaction.
// - The SQLite files are only read (opened read-only, so SQLite itself refuses any write).
// - Dry run by default: everything is inserted and checked (row count and checksum per table, read back inside the same
//   transaction), then rolled back. A dry run that passes means --apply passes on the same files.
// - --apply: first a VACUUM INTO backup of each file into a new folder, checked table by table against its source; the
//   rows are then read from that backup. Ids are kept (the target's identity columns take them as given), and only
//   when every table matched are the sequences moved on and the transaction committed.
// - Refused before anything is written: the agent running (its instance lock), tracker.db not at the latest version,
//   Postgres not at the latest schema, or a target table it would write into already holding rows.
// Nothing here prints row contents: the report has table names, counts and checksums only.

export interface CopyOptions {
  dataDir: string;
  /** The customer the rows go to: customer #1, the founder, for the cutover. */
  tenantId: string;
  apply: boolean;
  /** --apply only: a folder that does not exist yet, for the checked backup. */
  backupDir?: string;
}

export interface TableResult {
  /** source:table, e.g. tracker:messages or session:auth_backup. */
  table: string;
  targetTable: string;
  source: TableSum;
  target: TableSum;
  match: boolean;
}

export interface CopyReport {
  ok: boolean;
  applied: boolean;
  tables: TableResult[];
  backup: string | null;
}

type Source = TablePlan['source'];
type Sources = Partial<Record<Source, SqliteDb>>;

const LATEST_SQLITE = MIGRATIONS.at(-1)!.version;
/** Rows per INSERT, so no statement passes Postgres's limit of 65,535 values. */
const VALUES_PER_INSERT = 20_000;

/** Ends the transaction without keeping anything, carrying the report out (a dry run, or a mismatch). */
class Rollback extends Error {
  readonly report: CopyReport;
  constructor(report: CopyReport) {
    super('rolled back');
    this.report = report;
  }
}

function files(dataDir: string): Record<Source, string> {
  return { tracker: trackerDbPath(dataDir), session: sessionDbPath(dataDir), sender: senderSessionDbPath(dataDir) };
}

function openSources(paths: Record<Source, string>): Sources {
  const out: Sources = {};
  for (const k of ['tracker', 'session', 'sender'] as const) if (existsSync(paths[k])) out[k] = SqliteDb.open(paths[k], { readonly: true });
  return out;
}

async function closeAll(s: Sources): Promise<void> {
  for (const db of Object.values(s)) await db?.close().catch(() => undefined);
}

const quote = (path: string) => `'${path.replaceAll("'", "''")}'`;
const rowsOf = (db: SqliteDb, p: TablePlan) => db.all<Record<string, unknown>>(`SELECT ${p.columns.join(', ')} FROM ${p.table}`);

/** VACUUM INTO each source (a read: the source does not change), then checks each backup against its source. */
async function backupAndVerify(sources: Sources, paths: Record<Source, string>, dir: string, plans: readonly TablePlan[]): Promise<Record<Source, string>> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = {} as Record<Source, string>;
  for (const k of ['tracker', 'session', 'sender'] as const) {
    const src = sources[k];
    if (!src) continue;
    out[k] = join(dir, basename(paths[k]));
    await src.exec(`VACUUM INTO ${quote(out[k])}`);
    const copy = SqliteDb.open(out[k], { readonly: true });
    try {
      for (const p of plans.filter((x) => x.source === k)) {
        const a = tableChecksum(p.columns, await rowsOf(src, p));
        const b = tableChecksum(p.columns, await rowsOf(copy, p));
        if (a.sha256 !== b.sha256) throw new Error(`The backup of ${p.table} does not match its source. Nothing was copied.`);
      }
    } finally {
      await copy.close();
    }
  }
  return out;
}

/** The target rows a plan's check compares: the rows with its fixed values (wa_auth's phone and slot). */
async function targetRows(q: Sql, p: TablePlan): Promise<Record<string, unknown>[]> {
  const keys = Object.keys(p.fixed);
  const where = keys.length ? ` WHERE ${keys.map((k) => `${k} = ?`).join(' AND ')}` : '';
  return q.all<Record<string, unknown>>(`SELECT ${p.columns.join(', ')} FROM ${p.target}${where}`, keys.map((k) => p.fixed[k]));
}

async function insertRows(q: Sql, target: CopyTarget, p: TablePlan, rows: readonly Record<string, unknown>[], keepIds: boolean): Promise<void> {
  const columns = [...p.columns, ...Object.keys(p.fixed)];
  const per = Math.max(1, Math.floor(VALUES_PER_INSERT / columns.length));
  const tuple = `(${columns.map(() => '?').join(', ')})`;
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    const values = chunk.flatMap((r) => columns.map((c) => (c in p.fixed ? p.fixed[c] : r[c] ?? null)));
    await q.run(`${target.insertPrefix(p.target, columns, keepIds)} ${chunk.map(() => tuple).join(', ')}`, values);
  }
}

/** tenants: Postgres seeds customer #1's row, so a row is updated when its id is there, else inserted. */
async function upsertTenants(q: Sql, target: CopyTarget, p: TablePlan, rows: readonly Record<string, unknown>[]): Promise<void> {
  const rest = p.columns.filter((c) => c !== 'id');
  for (const r of rows) {
    const updated = await q.run(`UPDATE tenants SET ${rest.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...rest.map((c) => r[c] ?? null), r.id]);
    if (updated.changes === 0) await insertRows(q, target, p, [r], false);
  }
}

export async function copyToPostgres(o: CopyOptions, target: CopyTarget): Promise<CopyReport> {
  if (o.apply && !o.backupDir) throw new Error('--apply needs --backup-dir <a new folder> for the fresh backup');
  if (o.backupDir && existsSync(o.backupDir)) throw new Error(`The backup folder already exists: ${o.backupDir}. Choose a new one.`);
  const paths = files(o.dataDir);
  if (!existsSync(paths.tracker)) throw new Error(`There is no tracker.db in ${o.dataDir}.`);
  // The agent's own instance lock, held for the whole copy: the agent cannot start and write meanwhile.
  let lock: { release(): Promise<void> };
  try {
    lock = await acquireLock(o.dataDir);
  } catch (e) {
    if (e instanceof AlreadyRunningError) throw new Error('The agent is running. Stop it first (docs/GO-LIVE-postgres.md, part 4.2).');
    throw e;
  }
  const sources = openSources(paths);
  let backups: Sources = {};
  try {
    const v = (await sources.tracker!.get<{ v: number | null }>('SELECT max(version) AS v FROM schema_version'))?.v ?? 0;
    if (v !== LATEST_SQLITE) throw new Error(`tracker.db is at v${v}; this version copies v${LATEST_SQLITE}. Start the agent once on SQLite to bring it up to date.`);
    const plans: TablePlan[] = [...(await copyPlan(sources.tracker!)), ...SESSION_PLANS.filter((p) => sources[p.source] !== undefined)];

    let backup: string | null = null;
    let from: Sources = sources;
    if (o.apply) {
      const made = await backupAndVerify(sources, paths, o.backupDir!, plans);
      backup = o.backupDir!;
      backups = openSources(made);
      from = backups; // copied from the checked backup, never from files that could still change
    }
    const rowsBy = new Map<TablePlan, Record<string, unknown>[]>();
    for (const p of plans) rowsBy.set(p, await rowsOf(from[p.source]!, p));

    try {
      return await target.tx(o.tenantId, async (q) => {
        const pv = await target.schemaVersion(q);
        if (pv !== target.latestVersion) throw new Error(`Postgres is at P${pv}; run npm run cli -- db-migrate first.`);
        const identity = await target.identityTables(q);
        // Copying twice is refused: a table the copy would write into must be empty (a customer table: this customer's
        // rows; a platform table: any row; tenants: any customer other than this one, which Postgres seeds).
        for (const p of plans) {
          if (rowsBy.get(p)!.length === 0) continue;
          const n = p.target === 'tenants'
            ? (await q.get<{ n: number }>('SELECT count(*) AS n FROM tenants WHERE id <> ?', [o.tenantId]))!.n
            : (await targetRows(q, p)).length;
          if (n > 0) throw new Error(`Postgres already has data in ${p.target}. Nothing was changed.`);
        }
        for (const p of plans) {
          const rows = rowsBy.get(p)!;
          if (p.target === 'tenants') await upsertTenants(q, target, p, rows);
          else await insertRows(q, target, p, rows, identity.has(p.target));
        }
        await target.beforeVerify?.(q);
        const tables: TableResult[] = [];
        for (const p of plans) {
          const rows = rowsBy.get(p)!;
          let back = await targetRows(q, p);
          if (p.platform) {
            // A platform table holds every customer's rows: the check reads back exactly the keys the copy wrote (a
            // customer table needs no filter, RLS already shows only this customer's rows).
            const keyOf = (r: Record<string, unknown>) => JSON.stringify(p.key.map((k) => r[k]));
            const wrote = new Set(rows.map(keyOf));
            back = back.filter((r) => wrote.has(keyOf(r)));
          }
          const source = tableChecksum(p.columns, rows);
          const targetSum = tableChecksum(p.columns, back);
          tables.push({ table: `${p.source}:${p.table}`, targetTable: p.target, source, target: targetSum, match: source.rows === targetSum.rows && source.sha256 === targetSum.sha256 });
        }
        const ok = tables.every((t) => t.match);
        if (!o.apply || !ok) throw new Rollback({ ok, applied: false, tables, backup });
        for (const t of new Set(plans.map((p) => p.target))) if (identity.has(t)) await target.setval(q, t);
        return { ok, applied: true, tables, backup };
      });
    } catch (e) {
      if (e instanceof Rollback) return e.report;
      throw e;
    }
  } finally {
    await closeAll(backups);
    await closeAll(sources);
    await lock.release();
  }
}
