import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DriveNotFoundError, isAuthFailure, type DriveApi } from '../output/drive.ts';
import type { Db } from '../store/db.ts';
import { getKv, setKv } from '../store/kv.ts';
import { markUploaded, markUploadFailed, uploadCandidates, type UploadCandidate } from '../store/media.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { displayName } from './labels.ts';
import { sanitizeFileName } from './paths.ts';

export const UPLOAD_MAX_ATTEMPTS = 8;
/** Per-request time limit for one client file (up to 50 MB on a slow line). The tracker upload keeps the client's 120 s. */
export const FILE_UPLOAD_TIMEOUT_MS = 600_000;
const AUTH_RETRY_MS = 15 * 60_000;
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

/**
 * Uploads files shared by client members to WA Agent/Clients/<Client>/Files/ in Drive. One pass at a time; never
 * deletes or replaces anything in Drive. A crash between Drive accepting a file and its id being saved can leave one
 * duplicate copy in the Files folder; nothing is lost.
 */
export class DriveFileUploader {
  readonly #o: UploaderOptions;
  #current: Promise<void> | undefined;
  #stopped = false;

  constructor(o: UploaderOptions) {
    this.#o = o;
  }

  /** One pass over the files that are due. A pass already running is shared. Never rejects. */
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

  /** Starts no more passes and waits for the one in flight, up to timeoutMs. Leaves no timer. */
  async stop(timeoutMs: number): Promise<void> {
    this.#stopped = true;
    const current = this.#current;
    if (!current) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([current, new Promise<void>((r) => (t = setTimeout(r, timeoutMs)))]);
    clearTimeout(t);
  }

  async #pass(): Promise<void> {
    const { db, dataDir, clock, log } = this.#o;
    const root = getKv(db, 'drive_root_id');
    if (!root) return; // the publisher creates the root folder on its first upload
    let uploaded = 0;
    for (const c of uploadCandidates(db, clock.now().toISOString(), this.#o.batchSize ?? 5)) {
      if (this.#stopped) break;
      try {
        const bytes = await readFile(join(dataDir, ...c.localPath.split('/')));
        const name = displayName({ kind: c.kind, fileName: c.fileName, mimeType: c.mimeType, ts: c.ts, mediaId: c.id });
        markUploaded(db, c.id, await this.#upload(root, c, name, safeMime(c.mimeType), bytes));
        uploaded++;
      } catch (e) {
        const now = clock.now().getTime();
        if (isAuthFailure(e)) {
          // Not the file's fault. The publisher reports the sign-in problem; the rest would fail the same way.
          markUploadFailed(db, c.id, { failed: false, nextAt: new Date(now + AUTH_RETRY_MS).toISOString(), countAttempt: false });
          log.warn({ mediaId: c.id, clientId: c.clientId, step: 'upload', err: e }, 'file upload to Drive needs Google sign-in');
          break;
        }
        const attempts = c.driveAttempts + 1;
        const failed = (e as NodeJS.ErrnoException).code === 'ENOENT' || attempts >= UPLOAD_MAX_ATTEMPTS;
        markUploadFailed(db, c.id, { failed, nextAt: failed ? null : new Date(now + retryMs(attempts)).toISOString(), countAttempt: true });
        log.warn({ mediaId: c.id, clientId: c.clientId, step: 'upload', attempts, err: e }, 'file upload to Drive failed');
      }
    }
    if (uploaded > 0) {
      try {
        this.#o.onUploaded();
      } catch (err) {
        log.error({ err }, 'onUploaded failed');
      }
    }
  }

  async #upload(root: string, c: UploadCandidate, name: string, mime: string, bytes: Buffer): Promise<string> {
    const { db, api } = this.#o;
    for (let step = 0; ; step++) {
      try {
        return await api.createFile(name, mime, bytes, await this.#filesFolder(root, c), FILE_UPLOAD_TIMEOUT_MS);
      } catch (e) {
        if (!(e instanceof DriveNotFoundError) || step === 2) throw e;
        // A folder was removed in Drive. First rebuild this client's folders; if the Clients folder is gone too, that as well.
        setKv(db, `drive_files_folder:${c.clientId}`, '');
        setKv(db, `drive_client_folder:${c.clientId}`, '');
        if (step === 1) setKv(db, 'drive_clients_folder', '');
      }
    }
  }

  async #filesFolder(root: string, c: UploadCandidate): Promise<string> {
    const { db, api } = this.#o;
    const filesKey = `drive_files_folder:${c.clientId}`;
    const cached = getKv(db, filesKey);
    if (cached) return cached;
    let clients = getKv(db, 'drive_clients_folder');
    if (!clients) {
      clients = await api.createFolder('Clients', root);
      setKv(db, 'drive_clients_folder', clients);
    }
    const clientKey = `drive_client_folder:${c.clientId}`;
    let client = getKv(db, clientKey);
    if (!client) {
      client = await api.createFolder(sanitizeFileName(c.clientName) ?? `Client ${c.clientId}`, clients);
      setKv(db, clientKey, client);
    }
    const files = await api.createFolder('Files', client);
    setKv(db, filesKey, files);
    return files;
  }
}
