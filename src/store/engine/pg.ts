import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { TxMisuseError } from './errors.ts';
import { translate } from './translate.ts';
import type { Db, Params, RunResult, Sql } from './types.ts';

// Postgres behind the async Db interface (SaaS S2, plan 4.5). The only file in src that imports pg
// (tests/store/pg/noBypass.test.ts enforces it). A customer's statements and transactions run only inside withTenant:
// one transaction with app.tenant_id set for that transaction alone, so a pooled connection never carries one
// customer's id into the next use, and row-level security (P2) sees exactly that customer.

// Numbers as numbers, as SQLite gives them: int8 (COUNT(*), the identity ids, SUM of integers) and numeric (SUM of a
// bigint, ROUND). Every count, id and amount here stays far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

/** A customer id: a UUID (customer #1's is 00000000-0000-4000-8000-000000000001). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A statement that only reads: no advisory lock. Anything else (INSERT … RETURNING through get, WITH …) is a write. */
const READ = /^\s*(?:SELECT|VALUES)\b/i;

/** The parts of a connection pool the engine uses: the real pg.Pool, or a test's fake. */
export interface PgPool {
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}
export interface PgClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  release(err?: Error | boolean): void;
}

/**
 * A pool for one role's URL (wa_app for customers, wa_platform for the platform tables). onError: an idle connection
 * that drops (the server restarted) is reported here, not left to crash the process. The URL is never logged.
 */
export function openPgPool(url: string, o: { max?: number; onError?: (err: Error) => void } = {}): PgPool {
  const pool = new pg.Pool({ connectionString: url, max: o.max ?? 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, application_name: 'wa-agent' });
  pool.on('error', o.onError ?? ((err) => console.error('postgres: an idle connection failed', err.message)));
  return pool;
}

/** Which Db a flow is inside (its transaction): using that Db's outer methods there is refused, as on SQLite. */
const inTx = new AsyncLocalStorage<object>();

/** The handle a transaction's fn gets: its connection, with savepoints for a nested tx. */
function handle(c: PgClient, tenantKeys: boolean, depth = { n: 0 }): Sql {
  const run = async (sql: string, p?: Params) => {
    const t = translate(sql, p, { tenantKeys });
    return c.query(t.text, t.values);
  };
  return {
    get: async <T>(sql: string, p?: Params) => (await run(sql, p)).rows[0] as T | undefined,
    all: async <T>(sql: string, p?: Params) => (await run(sql, p)).rows as T[],
    run: async (sql: string, p?: Params): Promise<RunResult> => ({ changes: (await run(sql, p)).rowCount ?? 0 }),
    exec: async (sql: string) => {
      await c.query(sql);
    },
    tx: async <T>(fn: (q: Sql) => Promise<T>): Promise<T> => {
      const name = `sp${++depth.n}`;
      await c.query(`SAVEPOINT ${name}`);
      try {
        const r = await fn(handle(c, tenantKeys, depth));
        await c.query(`RELEASE SAVEPOINT ${name}`);
        return r;
      } catch (e) {
        await c.query(`ROLLBACK TO SAVEPOINT ${name}`);
        throw e;
      }
    },
  };
}

/**
 * One transaction on one pooled connection: BEGIN, `setup` (the customer and its lock), fn, COMMIT; ROLLBACK on a throw.
 * A connection whose ROLLBACK failed is destroyed, never returned to the pool with a transaction open.
 */
async function transaction<T>(owner: object, pool: PgPool, tenantKeys: boolean, setup: (c: PgClient) => Promise<void>, fn: (q: Sql) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  let broken: Error | undefined;
  try {
    await c.query('BEGIN');
    await setup(c);
    const r = await inTx.run(owner, () => fn(handle(c, tenantKeys)));
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch((err: unknown) => {
      broken = err instanceof Error ? err : new Error('rollback failed');
    });
    throw e;
  } finally {
    c.release(broken);
  }
}

/**
 * The only way to a customer's rows on Postgres. app.tenant_id is set for this transaction alone (set_config's third
 * argument, true), so it ends with the transaction. A write also takes the customer's advisory lock until it ends: one
 * writer per customer, as SQLite's queue gives one writer per process.
 */
export async function withTenant<T>(pool: PgPool, tenantId: string, fn: (q: Sql) => Promise<T>, o: { write: boolean; owner?: object }): Promise<T> {
  if (!UUID.test(tenantId)) throw new Error('withTenant needs a customer id (a UUID)');
  return transaction(o.owner ?? pool, pool, true, async (c) => {
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    if (o.write) await c.query("SELECT pg_advisory_xact_lock(hashtextextended('wa:' || $1, 0))", [tenantId]);
  }, fn);
}

/** One customer's database: every call is its own withTenant transaction (as wa_app, under RLS). */
export class PgTenantDb implements Db {
  readonly engine = 'postgres' as const;
  readonly #pool: PgPool;
  readonly #ownsPool: boolean;
  readonly tenantId: string;

  /** ownsPool false: a customer's Db on a pool another Db owns (forTenant); its close() leaves the pool open. */
  constructor(pool: PgPool, tenantId: string, o: { ownsPool?: boolean } = {}) {
    if (!UUID.test(tenantId)) throw new Error('PgTenantDb needs a customer id (a UUID)');
    this.#pool = pool;
    this.#ownsPool = o.ownsPool !== false;
    this.tenantId = tenantId;
  }

  /** Another customer's Db on this one's pool (wa_app, RLS by that customer). Closing it never ends the pool. */
  forTenant(tenantId: string): PgTenantDb {
    return new PgTenantDb(this.#pool, tenantId, { ownsPool: false });
  }

  #outside(): void {
    if (inTx.getStore() === this) throw new TxMisuseError('inside db.tx, use the transaction handle');
  }

  #one<T>(sql: string, fn: (q: Sql) => Promise<T>): Promise<T> {
    this.#outside();
    return withTenant(this.#pool, this.tenantId, fn, { write: !READ.test(sql), owner: this });
  }

  get<T>(sql: string, p?: Params): Promise<T | undefined> {
    return this.#one(sql, (q) => q.get<T>(sql, p));
  }
  all<T>(sql: string, p?: Params): Promise<T[]> {
    return this.#one(sql, (q) => q.all<T>(sql, p));
  }
  run(sql: string, p?: Params): Promise<RunResult> {
    return this.#one(sql, (q) => q.run(sql, p));
  }
  exec(): Promise<void> {
    return Promise.reject(new Error('exec is for migrations, which run as wa_owner (db-migrate), never as a customer'));
  }
  tx<T>(fn: (q: Sql) => Promise<T>): Promise<T> {
    this.#outside();
    return withTenant(this.#pool, this.tenantId, fn, { write: true, owner: this });
  }
  /** Ends the pool, unless another Db owns it (forTenant). */
  async close(): Promise<void> {
    if (this.#ownsPool) await this.#pool.end();
  }
}

/**
 * The platform tables (tenants, users, memberships, invites, platform_audit, tenant_keys, web_sessions) as wa_platform
 * (decision D1): plain transactions, no customer, no advisory lock, and ON CONFLICT targets as written (these tables
 * have no tenant_id key). Only src/platform/**, src/web/routes/platform.ts and SessionStore get one (S2.8).
 */
export class PgPlatformDb implements Db {
  readonly engine = 'postgres' as const;
  readonly #pool: PgPool;

  constructor(pool: PgPool) {
    this.#pool = pool;
  }

  #outside(): void {
    if (inTx.getStore() === this) throw new TxMisuseError('inside db.tx, use the transaction handle');
  }

  #one<T>(fn: (q: Sql) => Promise<T>): Promise<T> {
    this.#outside();
    return transaction(this, this.#pool, false, async () => undefined, fn);
  }

  get<T>(sql: string, p?: Params): Promise<T | undefined> {
    return this.#one((q) => q.get<T>(sql, p));
  }
  all<T>(sql: string, p?: Params): Promise<T[]> {
    return this.#one((q) => q.all<T>(sql, p));
  }
  run(sql: string, p?: Params): Promise<RunResult> {
    return this.#one((q) => q.run(sql, p));
  }
  exec(): Promise<void> {
    return Promise.reject(new Error('exec is for migrations, which run as wa_owner (db-migrate)'));
  }
  tx<T>(fn: (q: Sql) => Promise<T>): Promise<T> {
    return this.#one(fn);
  }
  async close(): Promise<void> {
    await this.#pool.end();
  }
}

/** A single connection for db-bootstrap and db-migrate: plain SQL (DDL, roles), no translation, no customer. */
export interface AdminConnection {
  sql(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  end(): Promise<void>;
}

/** Connects as the role in `url` (the superuser for db-bootstrap, wa_owner for db-migrate). The URL is never logged. */
export async function openAdminConnection(url: string): Promise<AdminConnection> {
  const c = new pg.Client({ connectionString: url, application_name: 'wa-agent-admin', connectionTimeoutMillis: 10_000 });
  await c.connect();
  return { sql: (text, values) => c.query(text, values), end: () => c.end() };
}
