import type { Db } from './db.ts';

export function getKv(db: Db, k: string): string | undefined {
  const r = db.raw.prepare('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | undefined;
  return r?.v;
}

export function deleteKv(db: Db, k: string): void {
  db.raw.prepare('DELETE FROM kv WHERE k = ?').run(k);
}

export function setKv(db: Db, k: string, v: string): void {
  db.raw.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').run(k, v);
}
