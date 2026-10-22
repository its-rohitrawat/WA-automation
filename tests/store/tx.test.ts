import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, tx } from '../../src/store/db.ts';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('tx', () => {
  it('takes the write lock at BEGIN, so a second writer cannot slip in after a read', () => {
    dir = mkdtempSync(join(tmpdir(), 'wa-tx-'));
    const file = join(dir, 'a.db');
    const a = openDb(file);
    const b = openDb(file);
    b.pragma('busy_timeout = 0');
    try {
      tx(a, () => {
        a.prepare('SELECT COUNT(*) FROM kv').get();
        // With a deferred BEGIN this write would succeed and A's later write would hit SQLITE_BUSY_SNAPSHOT.
        expect(() => b.prepare("INSERT INTO kv (k, v) VALUES ('x', '1')").run()).toThrowError(/locked|busy/i);
      });
      b.prepare("INSERT INTO kv (k, v) VALUES ('x', '1')").run();
    } finally {
      a.close();
      b.close();
    }
  });
});
