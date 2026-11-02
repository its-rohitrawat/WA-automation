import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isAuthFailure, type DriveApi } from '../output/drive.ts';
import { withClientSubfolder } from '../output/folders.ts';
import type { Db } from '../store/db.ts';
import { getKv } from '../store/kv.ts';
import { isUploadCandidate, markUploaded, markUploadFailed, uploadCandidates, type UploadCandidate } from '../store/media.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { displayName } from './labels.ts';

export const UPLOAD_MAX_ATTEMPTS = 8;
/** Per-request time limit for one client file (up to 50 MB on a slow line). The tracker upload keeps the client's 120 s. */
export const FILE_UPLOAD_TIMEOUT_MS = 600_000;
/** How long the uploader pauses after a Google sign-in failure. */
const AUTH_RETRY_MS = 15 * 60_000;
/** How long the uploader pauses when the database cannot save an upload result. */
const LEDGER_RETRY_MS = 15 * 60_000;
/** Delay before the next try after `attempt` failed tries: 2, 4, 8 ... minutes, at most 6 hours. Exported for tests. */
export const retryMs = (attempt: number): number => Math.min(60_000 * 2 ** attempt, 6 * 3_600_000);
const MIME = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;

function safeMime(m: string | null): string {
  const v = ((m ?? '').toLowerCase().split(';')[0] ?? '').trim();
  return MIME.test(v) ? v : 'application/octet-stream';
}

export interface UploaderOptions {
  db: Db;
  api: DriveApi;
  dataDir: string;
  clock: Clock;
  log: Logger;
  /** At least one file reached Drive: the workbook can show its link. */
  onUploaded: () => void;
  batchSize?: number;
}

/** Why the uploader is paused: the database cannot save results, or Google sign-in failed. */
type PauseReason = 'ledger' | 'auth';

/**
 * Uploads files shared by client members to WA Agent/Clients/<Client>/Files/ in Drive. One pass at a time; never
 * deletes or replaces anything in Drive.
 *
 * Duplicate copies are possible, and accepted. Drive can store a file while its answer never arrives: a timeout or a
 * dropped connection after the bytes arrived, or a crash before the id is saved. The next try then uploads the file
 * again, leaving a second copy in the Files folder. The app has only the drive.file scope, and checking whether the
 * first copy arrived would need a listing call on every retry, which this uploader does not make. A duplicate is
 * visible to the owner, and nothing is lost. Drive's files.generateIds would avoid this: save an id on the row before
 * the first try, reuse it on every retry, and take Drive's 409 "already exists" as success. It is not used because it
 * has not been verified under the drive.file scope, so it stays a later option.
 *
 * When Drive answers but the database cannot save the id, the id is kept in memory and only the save is retried,
 * never the upload. stop() tries each such save once more. A restart before it is saved forgets it, so the file is
 * uploaded once more.
 *
 * When the database cannot save a result, or Google sign-in fails, the pass stops and no pass starts for 15 minutes
 * (in memory: a restart also ends the pause). So a file is never uploaded again on every tick, and a sign-in problem
 * does not call Google on every tick.
 *
 * A new folder's id is saved right after Drive makes the folder. If that save fails, the folder stays in Drive, empty,
 * and the next try makes another. A database that cannot write cannot save the failed try either, so the uploader
 * pauses: this can leave one orphan empty folder per pause.
 */
export class DriveFileUploader {
  readonly #o: UploaderOptions;
  #current: Promise<void> | undefined;
  #stopped = false;
  #paused: { until: number; reason: PauseReason } | undefined;
  /** Files that reached Drive but whose id could not be saved, by media id. */
  readonly #unsaved = new Map<number, { clientId: number; fileId: string }>();

  constructor(o: UploaderOptions) {
    this.#o = o;
  }

  /** One pass over the files that are due. A pass already running is shared. Does nothing while paused. Never rejects. */
  run(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    if (!this.#current) {
      this.#current = this.#pass()
        .catch((err: unknown) => this.#o.log.error({ err }, 'file upload pass failed'))
        .finally(() => {
          this.#current = undefined;
        });
    }
    return this.#current;
  }

  /**
   * Starts no more passes and waits for the one in flight, up to timeoutMs. Leaves no timer. Then tries once more to save
   * each Drive id still held in memory, even while paused: a restart forgets them, and each such file would be uploaded
   * again. A save that fails is logged and left; nothing is retried after this.
   */
  async stop(timeoutMs: number): Promise<void> {
    this.#stopped = true;
    const current = this.#current;
    if (current) {
      let t: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([current, new Promise<void>((r) => (t = setTimeout(r, timeoutMs)))]);
      clearTimeout(t);
    }
    for (const [id, u] of this.#unsaved) {
      try {
        await markUploaded(this.#o.db, id, u.fileId);
        this.#unsaved.delete(id);
      } catch (err) {
        this.#o.log.warn({ mediaId: id, clientId: u.clientId, step: 'save_id', err }, 'file upload result could not be saved');
      }
    }
  }

  async #pass(): Promise<void> {
    const { db, dataDir, clock, log } = this.#o;
    if (this.#paused) {
      if (clock.now().getTime() < this.#paused.until) return;
      log.info({ reason: this.#paused.reason }, 'file uploads to Drive resume');
      this.#paused = undefined;
    }
    let uploaded = 0;
    try {
      // First the ids that could not be saved last time. Those files are already in Drive and are never uploaded again.
      for (const [id, u] of this.#unsaved) {
        if (!(await this.#save(id, u.clientId, 'save_id', () => markUploaded(db, id, u.fileId)))) return;
        this.#unsaved.delete(id);
        uploaded++;
      }
      const root = await getKv(db, 'drive_root_id');
      if (!root) return; // the publisher creates the root folder on its first upload
      const nowIso = clock.now().toISOString();
      for (const c of await uploadCandidates(db, nowIso, this.#o.batchSize ?? 5)) {
        if (this.#stopped) break;
        // An upload can take minutes: the file may have been deleted for everyone, its sender may no longer be a
        // client, or its client may be inactive by now. Such a file is skipped without counting an attempt.
        if (!(await isUploadCandidate(db, c.id, nowIso))) continue;
        let fileId: string;
        try {
          const bytes = await readFile(join(dataDir, ...c.localPath.split('/')));
          const name = displayName({ kind: c.kind, fileName: c.fileName, mimeType: c.mimeType, ts: c.ts, mediaId: c.id });
          fileId = await this.#upload(c, name, safeMime(c.mimeType), bytes);
        } catch (e) {
          if (isAuthFailure(e)) {
            // Not the file's fault, and every other file would fail the same way: nothing is saved for the file, and the
            // whole uploader pauses so it does not call Google on every tick. The publisher reports the sign-in problem.
            log.warn({ mediaId: c.id, clientId: c.clientId, step: 'upload', err: e }, 'file upload to Drive needs Google sign-in');
            this.#pause('auth', AUTH_RETRY_MS);
            break;
          }
          const now = clock.now().getTime();
          const attempts = c.driveAttempts + 1;
          const failed = (e as NodeJS.ErrnoException).code === 'ENOENT' || attempts >= UPLOAD_MAX_ATTEMPTS;
          log.warn({ mediaId: c.id, clientId: c.clientId, step: 'upload', attempts, err: e }, 'file upload to Drive failed');
          if (!(await this.#save(c.id, c.clientId, 'save_failure', () =>
            markUploadFailed(db, c.id, { failed, nextAt: failed ? null : new Date(now + retryMs(attempts)).toISOString() })))) break;
          continue;
        }
        if (!(await this.#save(c.id, c.clientId, 'save_id', () => markUploaded(db, c.id, fileId)))) {
          this.#unsaved.set(c.id, { clientId: c.clientId, fileId });
          break;
        }
        uploaded++;
      }
    } finally {
      if (uploaded > 0) {
        try {
          this.#o.onUploaded();
        } catch (err) {
          log.error({ err }, 'onUploaded failed');
        }
      }
    }
  }

  /**
   * Saves one upload result. When the database cannot write, it logs ids and the error (the logger keeps its type and
   * code, never its message), pauses the uploader and returns false: the pass must stop.
   */
  async #save(mediaId: number, clientId: number, step: 'save_id' | 'save_failure', write: () => Promise<void>): Promise<boolean> {
    try {
      await write();
      return true;
    } catch (err) {
      this.#o.log.warn({ mediaId, clientId, step, err }, 'file upload result could not be saved');
      this.#pause('ledger', LEDGER_RETRY_MS);
      return false;
    }
  }

  /** The one pause for every reason: no pass starts until ms from now. In memory only, so a restart ends it too. */
  #pause(reason: PauseReason, ms: number): void {
    const until = this.#o.clock.now().getTime() + ms;
    this.#paused = { until, reason };
    this.#o.log.warn({ reason, until: new Date(until).toISOString() }, 'file uploads to Drive paused');
  }

  /** Into the client's Files folder; folders removed in Drive are rebuilt as withClientSubfolder describes. */
  #upload(c: UploadCandidate, name: string, mime: string, bytes: Buffer): Promise<string> {
    const { db, api } = this.#o;
    return withClientSubfolder(db, api, { clientId: c.clientId, clientName: c.clientName }, 'Files', (folderId) =>
      api.createFile(name, mime, bytes, folderId, FILE_UPLOAD_TIMEOUT_MS));
  }
}
