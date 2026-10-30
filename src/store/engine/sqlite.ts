import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Migration } from '../migrations.ts';
import { SerialQueue } from './queue.ts';
import { migrate } from './sqliteMigrate.ts';
import type { Db, Params, RunResult, Sql } from './types.ts';

/**
 * TESTS AND SCRIPTS ONLY: the better-sqlite3 handle under a SQLite Db, to set up or inspect a database directly. Nothing
 * in src may call it outside src/store/engine (tests/store/dbAccess.test.ts enforces that): the agent reaches the
 * database only through the async Db interface, which Postgres serves too (S2). While another flow holds a transaction
 * it throws TxMisuseError, as a synchronous statement then would break that transaction's isolation.
 */
export function rawOf<T extends Db | undefined>(db: T): T extends undefined ? undefined : Database.Database;
export function rawOf(db: Db | undefined): Database.Database | undefined {
  if (db === undefined) return undefined;
  if (!(db instanceof SqliteDb)) throw new Error('rawOf: not a SQLite database');
  return SqliteDb.rawOf(db);
}

// better-sqlite3 behind the async Db interface (SaaS S1, plan section 2). One connection; every call waits its turn in one
// FIFO queue, which makes today's single writer explicit: an async transaction (BEGIN IMMEDIATE … COMMIT) holds the
// queue across its awaits, so nothing else on the connection runs inside it. A nested transaction is a savepoint.

/** Using the outer handle inside a transaction, or raw while another flow holds one. */
export class TxMisuseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TxMisuseError';
  }
}

const inTx = new AsyncLocalStorage<SqliteDb>();
const STATEMENTS_MAX = 500;

function bind(params?: Params): unknown[] {
  if (params === undefined) return [];
  return Array.isArray(params) ? [...params] : [params];
}

export class SqliteDb implements Db {
  readonly engine = 'sqlite' as const;
  readonly #raw: Database.Database;
  readonly #queue = new SerialQueue();
  readonly #statements = new Map<string, Database.Statement>();
  readonly #txMaxMs: number;
  #held = false;
  #savepoints = 0;

  private constructor(raw: Database.Database, o: { txMaxMs?: number }) {
    this.#raw = raw;
    this.#txMaxMs = o.txMaxMs ?? (process.env.NODE_ENV === 'test' || process.env.VITEST ? 1_000 : 0);
  }

  /**
   * Opens the file with today's pragmas. `migrations` (store/db.ts's openDb): applied on the file's own handle before the
   * Db is handed out, so opening stays synchronous. `readonly` (the copy tool, S3): the file must exist, every write is
   * refused, and the pragmas that write (journal_mode, secure_delete) and the folder creation are skipped; a -wal or -shm
   * file SQLite itself needs may still appear beside a WAL file.
   */
  static open(file: string, o: { txMaxMs?: number; readonly?: boolean; migrations?: readonly Migration[] } = {}): SqliteDb {
    const readonly = o.readonly === true;
    if (file !== ':memory:' && !readonly) mkdirSync(dirname(file), { recursive: true });
    const raw = readonly ? new Database(file, { readonly: true, fileMustExist: true }) : new Database(file);
    try {
      if (!readonly) raw.pragma('journal_mode = WAL');
      raw.pragma('foreign_keys = ON');
      raw.pragma('busy_timeout = 5000');
      // Deleted content is overwritten, so wiped download details (media.ref_enc) do not stay in free pages.
      if (!readonly) raw.pragma('secure_delete = ON');
      if (o.migrations) migrate(raw, o.migrations);
    } catch (e) {
      raw.close();
      throw e;
    }
    return new SqliteDb(raw, o);
  }

  /** A handle opened elsewhere with its own pragmas (the WhatsApp session files, src/wa/authState.ts). */
  static wrap(raw: Database.Database, o: { txMaxMs?: number } = {}): SqliteDb {
    return new SqliteDb(raw, o);
  }

  /** The better-sqlite3 handle, for tests only: see rawOf. */
  static rawOf(db: SqliteDb): Database.Database {
    if (db.#held && inTx.getStore() !== db) throw new TxMisuseError('a synchronous statement ran while another flow holds a transaction');
    return db.#raw;
  }

  #stmt(sql: string): Database.Statement {
    let s = this.#statements.get(sql);
    if (!s) {
      if (this.#statements.size >= STATEMENTS_MAX) this.#statements.clear();
      s = this.#raw.prepare(sql);
      this.#statements.set(sql, s);
    }
    return s;
  }

  #outside(): void {
    if (inTx.getStore() === this) throw new TxMisuseError('inside db.tx, use the transaction handle');
  }

  /** The handle a transaction's fn gets: the same connection, no queue (the transaction holds it). */
  #handle(): Sql {
    const now = <T>(fn: () => T) => Promise.resolve().then(fn);
    return {
      get: <T>(sql: string, p?: Params) => now(() => this.#stmt(sql).get(...bind(p)) as T | undefined),
      all: <T>(sql: string, p?: Params) => now(() => this.#stmt(sql).all(...bind(p)) as T[]),
      run: (sql, p) => now(() => ({ changes: this.#stmt(sql).run(...bind(p)).changes })),
      exec: (sql) => now(() => void this.#raw.exec(sql)),
      tx: (fn) => this.#savepoint(fn),
    };
  }

  async #savepoint<T>(fn: (q: Sql) => Promise<T>): Promise<T> {
    const name = `sp${++this.#savepoints}`;
    this.#raw.exec(`SAVEPOINT ${name}`);
    try {
      const r = await fn(this.#handle());
      this.#raw.exec(`RELEASE ${name}`);
      return r;
    } catch (e) {
      this.#raw.exec(`ROLLBACK TO ${name}`);
      this.#raw.exec(`RELEASE ${name}`);
      throw e;
    }
  }

  get<T>(sql: string, p?: Params): Promise<T | undefined> {
    this.#outside();
    return this.#queue.run(async () => this.#stmt(sql).get(...bind(p)) as T | undefined);
  }

  all<T>(sql: string, p?: Params): Promise<T[]> {
    this.#outside();
    return this.#queue.run(async () => this.#stmt(sql).all(...bind(p)) as T[]);
  }

  run(sql: string, p?: Params): Promise<RunResult> {
    this.#outside();
    return this.#queue.run(async () => ({ changes: this.#stmt(sql).run(...bind(p)).changes }));
  }

  exec(sql: string): Promise<void> {
    this.#outside();
    return this.#queue.run(async () => void this.#raw.exec(sql));
  }

  tx<T>(fn: (q: Sql) => Promise<T>): Promise<T> {
    this.#outside();
    return this.#queue.run(async () => {
      const started = performance.now();
      this.#raw.exec('BEGIN IMMEDIATE');
      this.#held = true;
      try {
        const r = await inTx.run(this, () => fn(this.#handle()));
        const ms = performance.now() - started;
        if (this.#txMaxMs > 0 && ms > this.#txMaxMs) throw new Error(`a transaction held the database for ${Math.round(ms)} ms`);
        this.#raw.exec('COMMIT');
        return r;
      } catch (e) {
        if (this.#raw.inTransaction) this.#raw.exec('ROLLBACK');
        throw e;
      } finally {
        this.#held = false;
      }
    });
  }

  async close(): Promise<void> {
    await this.#queue.run(async () => void this.#raw.close());
  }
}
