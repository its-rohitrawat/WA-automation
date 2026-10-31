import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onSqlite } from '../../helpers/db.ts';
import { SqliteDb, TxMisuseError, rawOf } from '../../../src/store/engine/sqlite.ts';

const open = () => SqliteDb.open(':memory:', { txMaxMs: 1_000 });

// SQLite only (S2.7), like every block in this file: the SQLite engine itself.
describe.runIf(onSqlite)('SqliteDb.open read-only (S3.3)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wa-ro-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('opens a file read-only: writes are refused and the file is not changed', async () => {
    const file = join(tmp, 'ro.db');
    const w = SqliteDb.open(file);
    await w.exec('CREATE TABLE t (a INTEGER)');
    await w.run('INSERT INTO t VALUES (7)');
    await w.close();
    const before = readFileSync(file);
    const r = SqliteDb.open(file, { readonly: true });
    try {
      await expect(r.run('INSERT INTO t VALUES (1)')).rejects.toThrow(/readonly/);
      await expect(r.exec('CREATE TABLE u (b INTEGER)')).rejects.toThrow(/readonly/);
      expect(await r.all('SELECT a FROM t')).toEqual([{ a: 7 }]);
    } finally {
      await r.close(); // closed even when a check fails, so the folder can be removed
    }
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('never creates a missing file or its folder', () => {
    const file = join(tmp, 'missing', 'tracker.db');
    expect(() => SqliteDb.open(file, { readonly: true })).toThrow();
    expect(existsSync(join(tmp, 'missing'))).toBe(false);
  });
});

describe.runIf(onSqlite)('SqliteDb', () => {
  it('runs get, all and run with positional and named values', async () => {
    const db = open();
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, k TEXT, n INTEGER)');
    expect(await db.run('INSERT INTO t (k, n) VALUES (?, ?)', ['a', 1])).toEqual({ changes: 1 });
    await db.run('INSERT INTO t (k, n) VALUES (@k, @n)', { k: 'b', n: 2 });
    expect(await db.get('SELECT k FROM t WHERE n = ?', [2])).toEqual({ k: 'b' });
    expect(await db.all('SELECT k FROM t ORDER BY id')).toEqual([{ k: 'a' }, { k: 'b' }]);
    expect(await db.get('INSERT INTO t (k, n) VALUES (?, ?) RETURNING id', ['c', 3])).toEqual({ id: 3 });
  });

  it('a transaction commits on success and rolls back on a throw, across awaits', async () => {
    const db = open();
    await db.exec('CREATE TABLE t (k TEXT)');
    await db.tx(async (q) => {
      await q.run('INSERT INTO t VALUES (?)', ['in']);
      await new Promise((r) => setTimeout(r, 5));
      await q.run('INSERT INTO t VALUES (?)', ['in2']);
    });
    await expect(db.tx(async (q) => {
      await q.run('INSERT INTO t VALUES (?)', ['lost']);
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await db.all('SELECT k FROM t ORDER BY k')).toEqual([{ k: 'in' }, { k: 'in2' }]);
  });

  it('nothing runs between the statements of a transaction (the single writer)', async () => {
    const db = open();
    await db.exec('CREATE TABLE t (n INTEGER)');
    await db.run('INSERT INTO t VALUES (0)');
    const bump = () => db.tx(async (q) => {
      const r = await q.get<{ n: number }>('SELECT n FROM t');
      await new Promise((res) => setTimeout(res, 2));
      await q.run('UPDATE t SET n = ?', [r!.n + 1]);
    });
    await Promise.all(Array.from({ length: 20 }, bump));
    expect(await db.get('SELECT n FROM t')).toEqual({ n: 20 });
  });

  it('a nested transaction is a savepoint', async () => {
    const db = open();
    await db.exec('CREATE TABLE t (k TEXT)');
    await db.tx(async (q) => {
      await q.run('INSERT INTO t VALUES (?)', ['outer']);
      await expect(q.tx(async (q2) => {
        await q2.run('INSERT INTO t VALUES (?)', ['inner']);
        throw new Error('inner fails');
      })).rejects.toThrow('inner fails');
    });
    expect(await db.all('SELECT k FROM t')).toEqual([{ k: 'outer' }]);
  });

  it('the outer handle inside a transaction throws instead of deadlocking', async () => {
    const db = open();
    await db.exec('CREATE TABLE t (k TEXT)');
    await expect(db.tx(async () => {
      await db.run('INSERT INTO t VALUES (?)', ['x']);
    })).rejects.toBeInstanceOf(TxMisuseError);
  });

  it('raw is refused while another flow holds a transaction, and allowed inside it', async () => {
    const db = open();
    await db.exec('CREATE TABLE t (k TEXT)');
    let release!: () => void;
    const held = db.tx(async (q) => {
      rawOf(db).prepare('INSERT INTO t VALUES (?)').run('inside'); // same transaction: allowed
      await new Promise<void>((r) => (release = r));
      await q.run('INSERT INTO t VALUES (?)', ['after']);
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(() => rawOf(db)).toThrow(TxMisuseError);
    release();
    await held;
    expect(rawOf(db).prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 2 });
  });

  it('wraps a handle opened elsewhere, keeping its own pragmas', async () => {
    const raw = new Database(':memory:');
    raw.pragma('busy_timeout = 1234');
    const db = SqliteDb.wrap(raw);
    expect(rawOf(db)).toBe(raw);
    expect(raw.pragma('busy_timeout', { simple: true })).toBe(1234); // wrap sets nothing (open sets 5000)
    await db.exec('CREATE TABLE t (k TEXT)');
    await db.run('INSERT INTO t VALUES (?)', ['a']);
    expect(raw.prepare('SELECT k FROM t').all()).toEqual([{ k: 'a' }]);
  });

  it('a transaction held too long fails under test', async () => {
    const db = SqliteDb.open(':memory:', { txMaxMs: 20 });
    await expect(db.tx(() => new Promise((r) => setTimeout(r, 60)))).rejects.toThrow(/held the database for/);
  });
});
