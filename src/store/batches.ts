import type { Sql } from './db.ts';

export interface BatchSummary {
  clientId: number;
  status: 'running' | 'ok' | 'failed';
  errorCode: string | null;
  finishedAt: string | null;
}

export async function startBatch(db: Sql, clientId: number, messageCount: number, at: string): Promise<number> {
  const r = await db.get<{ id: number }>("INSERT INTO batches (client_id, started_at, status, message_count) VALUES (?, ?, 'running', ?) RETURNING id", [
    clientId,
    at,
    messageCount,
  ]);
  return r!.id;
}

export async function finishBatch(
  db: Sql,
  id: number,
  r: { status: 'ok' | 'failed'; errorCode: string | null; accepted: number | null; rejected: number | null; at: string },
): Promise<void> {
  await db.run('UPDATE batches SET status = @status, error_code = @errorCode, accepted = @accepted, rejected = @rejected, finished_at = @at WHERE id = @id', {
    id,
    ...r,
  });
}

export async function latestBatches(db: Sql): Promise<BatchSummary[]> {
  return db.all<BatchSummary>(`SELECT b.client_id AS clientId, b.status, b.error_code AS errorCode, b.finished_at AS finishedAt FROM batches b
      WHERE b.id = (SELECT MAX(id) FROM batches WHERE client_id = b.client_id) ORDER BY b.client_id`);
}
