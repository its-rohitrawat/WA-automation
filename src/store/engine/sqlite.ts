import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { SerialQueue } from './queue.ts';
import type { Db, Params, RunResult, Sql } from './types.ts';

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

  /** Opens the file with today's pragmas. The caller migrates (store/db.ts). */
  static open(file: string, o: { txMaxMs?: number } = {}): SqliteDb {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    const raw = new Database(file);
    try {
      raw.pragma('journal_mode = WAL');
      raw.pragma('foreign_keys = ON');
      raw.pragma('busy_timeout = 5000');
      // Deleted content is overwritten, so wiped download details (media.ref_enc) do not stay in free pages.
      raw.pragma('secure_delete = ON');
    } catch (e) {
      raw.close();
      throw e;
    }
    return new SqliteDb(raw, o);
  }

  /** S1 only (removed in S1.15): the better-sqlite3 handle, for code not converted yet. */
  get raw(): Database.Database {
    if (this.#held && inTx.getStore() !== this) throw new TxMisuseError('a synchronous statement ran while another flow holds a transaction');
    return this.#raw;
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
