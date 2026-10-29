import type { Db } from './db.ts';

export interface BatchSummary {
  clientId: number;
  status: 'running' | 'ok' | 'failed';
  errorCode: string | null;
  finishedAt: string | null;
}

export function startBatch(db: Db, clientId: number, messageCount: number, at: string): number {
  return Number(
    db.raw.prepare("INSERT INTO batches (client_id, started_at, status, message_count) VALUES (?, ?, 'running', ?)").run(clientId, at, messageCount).lastInsertRowid,
  );
}

export function finishBatch(
  db: Db,
  id: number,
  r: { status: 'ok' | 'failed'; errorCode: string | null; accepted: number | null; rejected: number | null; at: string },
): void {
  db.raw.prepare('UPDATE batches SET status = @status, error_code = @errorCode, accepted = @accepted, rejected = @rejected, finished_at = @at WHERE id = @id').run({
    id,
    ...r,
  });
}

export function latestBatches(db: Db): BatchSummary[] {
  return db
    .raw.prepare(`SELECT b.client_id AS clientId, b.status, b.error_code AS errorCode, b.finished_at AS finishedAt FROM batches b
      WHERE b.id = (SELECT MAX(id) FROM batches WHERE client_id = b.client_id) ORDER BY b.client_id`)
    .all() as BatchSummary[];
}
