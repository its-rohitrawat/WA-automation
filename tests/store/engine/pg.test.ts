import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { TxMisuseError } from '../../../src/store/engine/errors.ts';
import { PgPlatformDb, PgTenantDb, withTenant, type PgClient, type PgPool } from '../../../src/store/engine/pg.ts';

// The Postgres engine with no server: a fake pool records every statement each connection receives. The same rules on
// a real Postgres (RLS, the lock, a pooled connection carrying no customer) are S2.7's and S2.9's tests.

const T1 = '00000000-0000-4000-8000-000000000001';

class FakePool implements PgPool {
  readonly connections: { log: [string, unknown[]][]; released: Error | boolean | undefined; releasedAt: number }[] = [];
  /** A statement that fails when it matches. */
  failOn: RegExp | undefined;
  rows: Record<string, unknown>[] = [{ n: 1 }];
  ended = false;

  async connect(): Promise<PgClient> {
    const conn = { log: [] as [string, unknown[]][], released: undefined as Error | boolean | undefined, releasedAt: -1 };
    this.connections.push(conn);
    return {
      query: async (text, values) => {
        conn.log.push([text, [...(values ?? [])]]);
        if (this.failOn?.test(text)) throw new Error(`fake failure: ${text}`);
        return { rows: this.rows, rowCount: this.rows.length };
      },
      release: (err) => {
        conn.released = err ?? false;
        conn.releasedAt = conn.log.length;
      },
    };
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  texts(i = 0): string[] {
    return this.connections[i]!.log.map(([t]) => t);
  }
}

const SET = "SELECT set_config('app.tenant_id', $1, true)";
const LOCK = "SELECT pg_advisory_xact_lock(hashtextextended('wa:' || $1, 0))";

describe('PgTenantDb: one customer, every call its own withTenant transaction', () => {
  it('a read: BEGIN, the customer for this transaction only, the statement translated, COMMIT, released; no lock', async () => {
    const pool = new FakePool();
    const db = new PgTenantDb(pool, T1);
    expect(await db.get('SELECT n FROM t WHERE a = ?', [5])).toEqual({ n: 1 });
    expect(pool.connections[0]!.log).toEqual([
      ['BEGIN', []],
      [SET, [T1]],
      ['SELECT n FROM t WHERE a = $1', [5]],
      ['COMMIT', []],
    ]);
    expect(pool.connections[0]!.released).toBe(false);
  });

  it('a write takes the customer’s advisory lock; so does a write through get (INSERT … RETURNING) and every tx', async () => {
    const pool = new FakePool();
    const db = new PgTenantDb(pool, T1);
    await db.run('UPDATE t SET a = ? WHERE id = ?', [1, 2]);
    await db.get('INSERT INTO t (a) VALUES (?) RETURNING id', [3]);
    await db.tx(async (q) => q.all('SELECT 1'));
    for (const i of [0, 1, 2]) expect(pool.texts(i).slice(0, 3), String(i)).toEqual(['BEGIN', SET, LOCK]);
    expect(pool.connections[0]!.log[2]![1]).toEqual([T1]);
  });

  it('customer tables get tenant_id first in ON CONFLICT; ? becomes $n', async () => {
    const pool = new FakePool();
    await new PgTenantDb(pool, T1).run('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', ['a', 'b']);
    expect(pool.texts()[3]).toBe('INSERT INTO kv (k, v) VALUES ($1, $2) ON CONFLICT (tenant_id, k) DO UPDATE SET v = excluded.v');
  });

  it('a throw rolls back and releases the connection; a failed ROLLBACK destroys it instead', async () => {
    const pool = new FakePool();
    const db = new PgTenantDb(pool, T1);
    await expect(db.tx(async () => {
      throw new Error('the change failed');
    })).rejects.toThrow('the change failed');
    expect(pool.texts(0).at(-1)).toBe('ROLLBACK');
    expect(pool.connections[0]!.released).toBe(false);
    pool.failOn = /^(UPDATE|ROLLBACK)/;
    await expect(db.run('UPDATE t SET a = 1')).rejects.toThrow(/fake failure: UPDATE/);
    expect(pool.connections[1]!.released).toBeInstanceOf(Error); // never back in the pool with a transaction open
  });

  it('a nested tx is a savepoint, rolled back alone when it throws', async () => {
    const pool = new FakePool();
    await new PgTenantDb(pool, T1).tx(async (q) => {
      await q.tx(async (inner) => inner.run('UPDATE t SET a = 1'));
      await expect(q.tx(async () => {
        throw new Error('inner');
      })).rejects.toThrow('inner');
    });
    expect(pool.texts().slice(3)).toEqual([
      'SAVEPOINT sp1', 'UPDATE t SET a = 1', 'RELEASE SAVEPOINT sp1', 'SAVEPOINT sp2', 'ROLLBACK TO SAVEPOINT sp2', 'COMMIT',
    ]);
  });

  it('the outer db inside its own tx is refused (it would wait on the lock its own transaction holds)', async () => {
    const pool = new FakePool();
    const db = new PgTenantDb(pool, T1);
    await expect(db.tx(async () => db.get('SELECT 1'))).rejects.toThrow(TxMisuseError);
    await expect(db.tx(async () => db.tx(async () => 1))).rejects.toThrow(TxMisuseError);
    expect(pool.connections).toHaveLength(2); // one per outer tx: the refused inner calls took none
  });

  it('refuses anything but a UUID for the customer, and never runs exec (migrations run as wa_owner)', async () => {
    expect(() => new PgTenantDb(new FakePool(), 'founder')).toThrow(/UUID/);
    await expect(withTenant(new FakePool(), "x'; DROP TABLE t; --", async () => 1, { write: false })).rejects.toThrow(/UUID/);
    await expect(new PgTenantDb(new FakePool(), T1).exec()).rejects.toThrow(/wa_owner/);
  });

  it('close ends the pool', async () => {
    const pool = new FakePool();
    await new PgTenantDb(pool, T1).close();
    expect(pool.ended).toBe(true);
  });
});

describe('PgPlatformDb: the platform tables, no customer', () => {
  it('plain transactions: no set_config, no lock, ON CONFLICT as written', async () => {
    const pool = new FakePool();
    const db = new PgPlatformDb(pool);
    await db.run('INSERT INTO users (id, email) VALUES (?, ?) ON CONFLICT (email) DO NOTHING', ['u1', 'a@b.c']);
    expect(pool.connections[0]!.log).toEqual([
      ['BEGIN', []],
      ['INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING', ['u1', 'a@b.c']],
      ['COMMIT', []],
    ]);
    await expect(db.tx(async () => db.all('SELECT 1'))).rejects.toThrow(TxMisuseError);
  });
});

describe('numbers come back as numbers, as on SQLite', () => {
  it('int8 (COUNT, ids) and numeric (SUM of a bigint) are parsed', () => {
    expect(pg.types.getTypeParser(20)('42')).toBe(42);
    expect(pg.types.getTypeParser(1700)('1.25')).toBe(1.25);
  });
});
