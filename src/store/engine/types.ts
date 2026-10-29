// The one database API the rest of the code uses (SaaS S1): the same on SQLite and, from S2, Postgres.

/** Positional values (`?`) or named values (`@name`). Booleans are never passed: flags are 0 and 1. */
export type Params = readonly unknown[] | Readonly<Record<string, unknown>>;

export interface RunResult {
  /** Rows written by the statement. */
  changes: number;
}

/** A connection, or a transaction on one. */
export interface Sql {
  get<T>(sql: string, params?: Params): Promise<T | undefined>;
  all<T>(sql: string, params?: Params): Promise<T[]>;
  run(sql: string, params?: Params): Promise<RunResult>;
  /** Several statements and no values: migrations and PRAGMAs only. */
  exec(sql: string): Promise<void>;
  /** A transaction; inside one, a savepoint. fn must use the handle it is given, and must not wait on the network. */
  tx<T>(fn: (q: Sql) => Promise<T>): Promise<T>;
}

export interface Db extends Sql {
  readonly engine: 'sqlite' | 'postgres';
  close(): Promise<void>;
}
