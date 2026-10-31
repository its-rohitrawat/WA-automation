import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { onSqlite } from '../helpers/db.ts';
import { openDb } from '../../src/store/db.ts';
import { rawOf } from '../../src/store/engine/sqlite.ts';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

// SQLite only (S2.7): the database file's write lock (BEGIN IMMEDIATE, busy_timeout).
describe.runIf(onSqlite)('tx', () => {
  it('takes the write lock at BEGIN, so a second writer cannot slip in after a read', async () => {
    dir = mkdtempSync(join(tmpdir(), 'wa-tx-'));
    const file = join(dir, 'a.db');
    const a = openDb(file);
    const b = openDb(file);
    rawOf(b).pragma('busy_timeout = 0');
    try {
      await a.tx(async (q) => {
        await q.get('SELECT COUNT(*) FROM kv');
        // With a deferred BEGIN this write would succeed and A's later write would hit SQLITE_BUSY_SNAPSHOT.
        expect(() => rawOf(b).prepare("INSERT INTO kv (k, v) VALUES ('x', '1')").run()).toThrowError(/locked|busy/i);
      });
      rawOf(b).prepare("INSERT INTO kv (k, v) VALUES ('x', '1')").run();
    } finally {
      await a.close();
      await b.close();
    }
  });
});
