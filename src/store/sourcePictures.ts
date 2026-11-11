import type { Sql } from './db.ts';

// The chat pictures (owner request, 11 Nov 2026): which open tasks still need a picture of their source message, what
// became of each try, and the links the tracker shows. One row per task (source_pictures, v14/P8). Parameterised reads
// and writes only; ON CONFLICT (task_id) gains tenant_id on Postgres (src/store/engine/translate.ts).

/** A picture that failed is tried at most this often; then the task keeps its plain quote. */
export const PICTURE_TRIES = 5;
/** A failed picture is tried again after this long, at the earliest. */
const RETRY_MS = 10 * 60_000;

/** An open task whose source message is stored and that has no current picture. */
export interface PictureDue {
  taskId: number;
  code: string;
  clientId: number;
  /** The source message's row: what the picture shows and the Chat link opens. */
  messageId: number;
}

/**
 * Up to `limit` tasks that need a picture, newest first. These are open (not done) tasks whose source message is
 * stored for the same client, with either no picture row, a picture of another message (the source changed), or a
 * failed one that is due again (fewer than PICTURE_TRIES, the last at least RETRY_MS ago).
 */
export async function picturesDue(db: Sql, now: Date, limit: number): Promise<PictureDue[]> {
  const rows = await db.all<PictureDue>(
    `SELECT t.id AS taskId, t.code, t.client_id AS clientId, m.id AS messageId
       FROM tasks t
       JOIN messages m ON m.client_id = t.client_id AND m.wa_id = t.source_wa_id
       LEFT JOIN source_pictures p ON p.task_id = t.id
      WHERE t.status <> 'done'
        AND (p.id IS NULL OR p.message_id <> m.id
          OR (p.drive_file_id IS NULL AND p.attempts < @tries AND p.tried_at <= @retry))
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT @limit`,
    { tries: PICTURE_TRIES, retry: new Date(now.getTime() - RETRY_MS).toISOString(), limit },
  );
  return rows.map((r) => ({ taskId: Number(r.taskId), code: r.code, clientId: Number(r.clientId), messageId: Number(r.messageId) }));
}

/** The picture reached Drive. A picture of another message (the source changed) is replaced by this one. */
export async function recordPictureMade(db: Sql, p: PictureDue & { driveFileId: string; at: string }): Promise<void> {
  await db.run(
    `INSERT INTO source_pictures (task_id, client_id, message_id, drive_file_id, error_code, attempts, made_at, tried_at)
     VALUES (@task, @client, @message, @file, NULL, 1, @at, @at)
     ON CONFLICT (task_id) DO UPDATE SET
       attempts = CASE WHEN source_pictures.message_id = excluded.message_id THEN source_pictures.attempts + 1 ELSE 1 END,
       message_id = excluded.message_id, drive_file_id = excluded.drive_file_id, error_code = NULL,
       made_at = excluded.made_at, tried_at = excluded.tried_at`,
    { task: p.taskId, client: p.clientId, message: p.messageId, file: p.driveFileId, at: p.at },
  );
}

/** A try failed: its error code (never a message) and one more attempt. A failure for a new source starts the count again. */
export async function recordPictureFailed(db: Sql, p: PictureDue & { errorCode: string; at: string }): Promise<void> {
  await db.run(
    `INSERT INTO source_pictures (task_id, client_id, message_id, drive_file_id, error_code, attempts, made_at, tried_at)
     VALUES (@task, @client, @message, NULL, @code, 1, NULL, @at)
     ON CONFLICT (task_id) DO UPDATE SET
       attempts = CASE WHEN source_pictures.message_id = excluded.message_id AND source_pictures.drive_file_id IS NULL
         THEN source_pictures.attempts + 1 ELSE 1 END,
       message_id = excluded.message_id, drive_file_id = NULL, error_code = excluded.error_code, made_at = NULL,
       tried_at = excluded.tried_at`,
    { task: p.taskId, client: p.clientId, message: p.messageId, code: p.errorCode.slice(0, 60), at: p.at },
  );
}

/** A task's source message, and its picture's Drive id when the picture shows that message (null: none, or stale). */
export interface SourceLink {
  messageId: number;
  driveFileId: string | null;
}

/** Every task's source link, by task id: the tracker's Source and Chat links. Tasks whose source is not stored have none. */
export async function sourceLinks(db: Sql): Promise<Map<number, SourceLink>> {
  const rows = await db.all<{ taskId: number; messageId: number; driveFileId: string | null; pictureOf: number | null }>(
    `SELECT t.id AS taskId, m.id AS messageId, p.drive_file_id AS driveFileId, p.message_id AS pictureOf
       FROM tasks t
       JOIN messages m ON m.client_id = t.client_id AND m.wa_id = t.source_wa_id
       LEFT JOIN source_pictures p ON p.task_id = t.id`,
  );
  return new Map(rows.map((r) => [Number(r.taskId), {
    messageId: Number(r.messageId),
    driveFileId: r.pictureOf !== null && Number(r.pictureOf) === Number(r.messageId) ? r.driveFileId : null,
  }]));
}
