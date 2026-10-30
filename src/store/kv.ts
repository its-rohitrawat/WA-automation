import type { Sql } from './db.ts';

export async function getKv(db: Sql, k: string): Promise<string | undefined> {
  return (await db.get<{ v: string }>('SELECT v FROM kv WHERE k = ?', [k]))?.v;
}

export async function deleteKv(db: Sql, k: string): Promise<void> {
  await db.run('DELETE FROM kv WHERE k = ?', [k]);
}

export async function setKv(db: Sql, k: string, v: string): Promise<void> {
  await db.run('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', [k, v]);
}
