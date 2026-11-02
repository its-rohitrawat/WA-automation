import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/store/db.ts';
import { idOf, MEHTA, onSqlite, row, rows, seeded, SHARMA } from '../helpers/db.ts';

// The test helpers that let a test run on either engine (S2.7): the seeded clients' real ids, and reads through the Db
// in place of rawOf. On SQLite the ids are 1 and 2, as before; on Postgres they come from a shared sequence.

const opened: Db[] = [];
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
});

describe('the engine-neutral test helpers', () => {
  it('seeded() gives Sharma’s and Mehta’s real ids, which idOf reads back', async () => {
    const { db, ids } = await seeded();
    opened.push(db);
    if (onSqlite) expect(ids).toEqual({ sharma: 1, mehta: 2 });
    expect(ids.sharma).not.toBe(ids.mehta);
    expect(await idOf(db, SHARMA.code)).toBe(ids.sharma);
    expect(await idOf(db, MEHTA.code)).toBe(ids.mehta);
    await expect(idOf(db, 'NOPE')).rejects.toThrow(/no client with code NOPE/);
  });

  it('rows and row read through the Db, with ? or @name values', async () => {
    const { db, ids } = await seeded();
    opened.push(db);
    expect(await rows(db, 'SELECT code FROM clients ORDER BY id')).toEqual([{ code: 'SHA' }, { code: 'MEH' }]);
    expect(await row(db, 'SELECT code FROM clients WHERE id = ?', [ids.mehta])).toEqual({ code: 'MEH' });
    expect(await row(db, 'SELECT code FROM clients WHERE id = @id', { id: -1 })).toBeUndefined();
  });
});
