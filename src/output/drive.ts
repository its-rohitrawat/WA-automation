import { Readable } from 'node:stream';
import { drive, type drive_v3 } from '@googleapis/drive';
import type { Db } from '../store/db.ts';
import { getKv, setKv } from '../store/kv.ts';
import type { Logger } from '../util/logger.ts';
import { isAuthFailure } from './authFailure.ts';
import type { OAuth2Client } from './googleAuth.ts';
import { DRIVE_ROOT_NAME, TRACKER_FILE_NAME, TRACKER_ID_KEY, TRACKER_NEW_FILE_KEY } from './trackerKey.ts';
import { XLSX_MIME } from './workbook.ts';

export class DriveNotFoundError extends Error {
  constructor(id: string) {
    super(`Drive item ${id} not found`);
    this.name = 'DriveNotFoundError';
  }
}

export class DriveAuthError extends Error {
  constructor(cause?: unknown) {
    super('Google sign-in has expired or was revoked. Run: npm run cli -- google-auth, then restart the service', { cause });
    this.name = 'DriveAuthError';
  }
}

// In its own module so the meetings client can use it without loading this one (and, through it, the workbook).
export { isAuthFailure };

export interface DriveApi {
  /** Creates a folder at the top of My Drive, or inside parentId. */
  createFolder(name: string, parentId?: string): Promise<string>;
  /** timeoutMs: a per-request time limit instead of the client's 120 s (large client files need longer). */
  createFile(name: string, mimeType: string, body: Buffer, parentId: string, timeoutMs?: number): Promise<string>;
  updateFile(fileId: string, mimeType: string, body: Buffer): Promise<void>;
  /**
   * The newest file named name (not in the trash) directly inside parentId that this sign-in can see, or undefined. Under
   * the drive.file scope that is a file this app made or opened with the same Google project. A missing parent counts as none.
   */
  findFile(name: string, parentId: string): Promise<string | undefined>;
  /**
   * Up to five folders named name (not in the trash), anywhere in My Drive, that this sign-in can see, newest first. Under
   * drive.file these are folders this app made with the same Google project and account.
   */
  findFolders(name: string): Promise<string[]>;
  /**
   * Uploads HTML that Drive converts into a Google Doc inside parentId; returns the Doc id. A missing parent throws
   * DriveNotFoundError and a Google sign-in failure DriveAuthError.
   */
  createDoc(name: string, html: string, parentId: string): Promise<string>;
}

export const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

const isNotFound = (e: unknown) => (e as { code?: number }).code === 404;

/** A value inside single quotes in a Drive files.list search: backslashes and quotes escaped. */
const quoted = (v: string) => `'${v.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

/**
 * The error to throw for a failed create in parentId: a 404 means the parent folder is gone (DriveNotFoundError). With
 * wrapAuth (createDoc only), a Google sign-in failure becomes DriveAuthError. Anything else is returned as it came.
 */
function mapCreateError(e: unknown, parentId: string, wrapAuth = false): unknown {
  if (isNotFound(e)) return new DriveNotFoundError(parentId);
  if (wrapAuth && isAuthFailure(e) && !(e instanceof DriveAuthError)) return new DriveAuthError(e);
  return e;
}

/**
 * client may be a getter (GoogleAuthHub): it is read on every call, so a reconnected account applies to the next upload
 * without a restart. A new client gets a new Drive handle; the same client keeps its handle.
 */
export function googleDriveApi(client: OAuth2Client | (() => OAuth2Client)): DriveApi {
  const current = typeof client === 'function' ? client : () => client;
  // A fixed client is built at once, as before the getter existed.
  let built: { client: OAuth2Client; api: drive_v3.Drive } | undefined =
    typeof client === 'function' ? undefined : { client, api: drive({ version: 'v3', auth: client, timeout: 120_000 }) };
  const api = {
    get files(): drive_v3.Resource$Files {
      const c = current();
      if (built?.client !== c) built = { client: c, api: drive({ version: 'v3', auth: c, timeout: 120_000 }) };
      return built.api.files;
    },
  };
  return {
    async createFolder(name, parentId) {
      try {
        const r = await api.files.create({
          requestBody: { name, mimeType: 'application/vnd.google-apps.folder', ...(parentId ? { parents: [parentId] } : {}) },
          fields: 'id',
        });
        if (!r.data.id) throw new Error('Drive returned no folder id');
        return r.data.id;
      } catch (e) {
        if (parentId && isNotFound(e)) throw new DriveNotFoundError(parentId);
        throw e;
      }
    },
    async createFile(name, mimeType, body, parentId, timeoutMs) {
      try {
        // Per-request options are deep-merged over the client's (undefined values are ignored); without timeoutMs no
        // per-request timeout is sent, so the client's 120 s applies.
        const r = await api.files.create(
          { requestBody: { name, parents: [parentId] }, media: { mimeType, body: Readable.from(body) }, fields: 'id' },
          timeoutMs === undefined ? {} : { timeout: timeoutMs },
        );
        if (!r.data.id) throw new Error('Drive returned no file id');
        return r.data.id;
      } catch (e) {
        throw mapCreateError(e, parentId);
      }
    },
    async createDoc(name, html, parentId) {
      try {
        const r = await api.files.create({
          requestBody: { name, mimeType: GOOGLE_DOC_MIME, parents: [parentId] },
          media: { mimeType: 'text/html', body: Readable.from(Buffer.from(html, 'utf8')) },
          fields: 'id',
        });
        if (!r.data.id) throw new Error('Drive returned no document id');
        return r.data.id;
      } catch (e) {
        throw mapCreateError(e, parentId, true);
      }
    },
    async findFile(name, parentId) {
      try {
        const r = await api.files.list({
          q: `name = ${quoted(name)} and ${quoted(parentId)} in parents and trashed = false`,
          orderBy: 'modifiedTime desc', pageSize: 1, fields: 'files(id)', spaces: 'drive',
        });
        return r.data.files?.[0]?.id ?? undefined;
      } catch (e) {
        if (isNotFound(e)) return undefined;
        throw e;
      }
    },
    async findFolders(name) {
      const r = await api.files.list({
        q: `name = ${quoted(name)} and mimeType = ${quoted(FOLDER_MIME)} and trashed = false`,
        orderBy: 'modifiedTime desc', pageSize: 5, fields: 'files(id)', spaces: 'drive',
      });
      return (r.data.files ?? []).map((f) => f.id).filter((id): id is string => typeof id === 'string' && id !== '');
    },
    async updateFile(fileId, mimeType, body) {
      try {
        await api.files.update({ fileId, media: { mimeType, body: Readable.from(body) } });
      } catch (e) {
        if (isNotFound(e)) throw new DriveNotFoundError(fileId);
        throw e;
      }
    },
  };
}

export interface PublisherOptions {
  db: Db;
  api: DriveApi;
  build: () => Promise<Buffer>;
  log: Logger;
  minIntervalMs?: number;
  onPublished?: () => void;
  /**
   * Called once when the stored Tracker.xlsx could not be reached, none was visible in the folder, and a new one was made
   * (its date is in kv TRACKER_NEW_FILE_KEY). Errors thrown here are logged and ignored.
   */
  onNewFile?: () => void;
  /** The time stored with a new-file note; the system clock when not given. */
  now?: () => Date;
  /** Called after every failed run. `auth` is true when Google sign-in must be redone. Errors thrown here are logged and ignored. */
  onFailure?: (f: { step: 'build' | 'drive'; auth: boolean }) => void;
}

class PublishError extends Error {
  readonly step: 'build' | 'drive';
  readonly original: unknown;
  constructor(step: 'build' | 'drive', original: unknown) {
    super(`Publish failed at step ${step}`);
    this.name = 'PublishError';
    this.step = step;
    this.original = original;
  }
}

/**
 * Overwrites the same Drive file so its link never changes. At most one upload per minute. Never deletes or trashes anything.
 * When the stored file stops answering (404: usually the Google login changed, and drive.file cannot see the old file),
 * it first reuses the newest Tracker.xlsx this login can see in the WA Agent folder, then in any other WA Agent folder it can
 * see (for example the first login's, after switching back), and only makes a new one if none is.
 */
export class DrivePublisher {
  readonly #o: PublisherOptions;
  readonly #minInterval: number;
  #lastRun = Number.NEGATIVE_INFINITY;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #pending = false;
  #failures = 0;
  #stopped = false;
  /** The run in flight; resolves true when it published. */
  #current: Promise<boolean> | undefined;

  constructor(o: PublisherOptions) {
    this.#o = o;
    this.#minInterval = o.minIntervalMs ?? 60_000;
  }

  schedule(): void {
    if (this.#stopped) return;
    if (this.#current) {
      this.#pending = true;
      return;
    }
    if (this.#timer) return;
    const wait = Math.max(0, this.#lastRun + this.#minInterval - Date.now());
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#start();
    }, wait);
  }

  /**
   * Runs a publish now. If a run is already in flight, it queues one follow-up run and resolves when the
   * CURRENT run ends (not the follow-up), so it never starts two uploads at once.
   * Resolves true when that run published, false when it failed or the publisher is stopped (existing callers ignore it).
   */
  async publishNow(): Promise<boolean> {
    if (this.#stopped) return false;
    if (this.#current) {
      this.#pending = true;
      return this.#current;
    }
    clearTimeout(this.#timer);
    this.#timer = undefined;
    return this.#start();
  }

  /**
   * For shutdown: waits for the upload in flight, then makes exactly one more upload if a publish was pending or
   * scheduled (a failed in-flight upload counts as scheduled: it would have been retried), all within timeoutMs.
   * Like stop(), it then blocks new runs and leaves no timer behind.
   */
  async flush(timeoutMs = 10_000): Promise<void> {
    if (this.#stopped) return this.stop(timeoutMs);
    let wanted = this.#pending || this.#timer !== undefined;
    this.#stopped = true; // from here schedule(), publishNow() and the failure backoff start nothing
    clearTimeout(this.#timer);
    this.#timer = undefined;
    let expired = false;
    const work = (async () => {
      const current = this.#current;
      if (current) {
        const published = await current;
        wanted ||= this.#pending || !published;
      }
      if (wanted && !expired) await this.#start();
    })();
    let t: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((r) => {
      t = setTimeout(() => {
        expired = true;
        r();
      }, timeoutMs);
    });
    await Promise.race([work, deadline]);
    clearTimeout(t);
  }

  /** Blocks new runs, clears timers, and waits for an in-flight run (up to timeoutMs) so its Drive ids get saved. */
  async stop(timeoutMs = 30_000): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const current = this.#current;
    if (!current) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([current, new Promise<void>((r) => (t = setTimeout(r, timeoutMs)))]);
    clearTimeout(t);
  }

  #start(): Promise<boolean> {
    const run = this.#run().finally(() => {
      if (this.#current === run) this.#current = undefined;
      // Changes that arrived during the run get exactly one follow-up (after a failure, the backoff retry covers them).
      // Once stopped, the flag is left for flush() to read.
      if (this.#pending && !this.#stopped) {
        this.#pending = false;
        this.schedule();
      }
    });
    this.#current = run;
    return run;
  }

  async #run(): Promise<boolean> {
    this.#lastRun = Date.now();
    let published = false;
    try {
      await this.#publish();
      this.#failures = 0;
      published = true;
    } catch (e) {
      this.#failures++;
      const step = e instanceof PublishError ? e.step : 'drive';
      let cause: unknown = e instanceof PublishError ? e.original : e;
      const auth = step === 'drive' && isAuthFailure(cause);
      if (auth && !(cause instanceof DriveAuthError)) cause = new DriveAuthError(cause);
      // The logger's err serializer keeps type, code and stack frames, and drops the message.
      const fields = { step, err: cause, failures: this.#failures };
      if (step === 'build') this.#o.log.error(fields, 'Tracker build failed');
      else this.#o.log.warn(fields, 'Drive publish failed');
      this.#pending = false;
      try {
        this.#o.onFailure?.({ step, auth });
      } catch (hookErr) {
        this.#o.log.error({ err: hookErr }, 'onFailure failed');
      }
      if (!this.#stopped) {
        const backoff = Math.min(60_000 * 2 ** (this.#failures - 1), 15 * 60_000);
        clearTimeout(this.#timer);
        this.#timer = setTimeout(() => {
          this.#timer = undefined;
          void this.#start();
        }, backoff);
      }
      return false;
    }
    if (published) {
      try {
        this.#o.onPublished?.();
      } catch (hookErr) {
        this.#o.log.error({ err: hookErr }, 'onPublished failed');
      }
    }
    return published;
  }

  async #publish(): Promise<void> {
    const { db, api, build } = this.#o;
    let body: Buffer;
    try {
      body = await build();
    } catch (e) {
      throw new PublishError('build', e);
    }
    let root = getKv(db, 'drive_root_id');
    let rootIsNew = false;
    if (!root) {
      root = await api.createFolder(DRIVE_ROOT_NAME);
      setKv(db, 'drive_root_id', root);
      rootIsNew = true;
    }
    const stored = getKv(db, TRACKER_ID_KEY);
    if (stored) {
      try {
        await api.updateFile(stored, XLSX_MIME, body);
        return;
      } catch (e) {
        if (!(e instanceof DriveNotFoundError)) throw e;
      }
    }
    // A folder made just now is empty. Otherwise a Tracker.xlsx this login can see there is the one to keep writing.
    if (!rootIsNew) {
      if (await this.#reuse(root, stored, body)) return;
      // After a login change the stored folder is usually invisible too (same login made it): another WA Agent folder
      // this login can see (say, the first login's, after switching back) may hold the tracker to keep writing.
      for (const folder of await api.findFolders(DRIVE_ROOT_NAME)) {
        if (folder === root) continue;
        if (await this.#reuse(folder, stored, body)) {
          setKv(db, 'drive_root_id', folder);
          return;
        }
      }
    }
    try {
      setKv(db, TRACKER_ID_KEY, await api.createFile(TRACKER_FILE_NAME, XLSX_MIME, body, root));
    } catch (e) {
      if (!(e instanceof DriveNotFoundError)) throw e;
      // The root folder was removed: re-create it and retry once, in the same run.
      root = await api.createFolder(DRIVE_ROOT_NAME);
      setKv(db, 'drive_root_id', root);
      setKv(db, TRACKER_ID_KEY, await api.createFile(TRACKER_FILE_NAME, XLSX_MIME, body, root));
    }
    this.#noteNewFile(stored);
  }

  /** Writes the newest Tracker.xlsx this login can see in folder (other than stored) and keeps its id; false when there is none. */
  async #reuse(folder: string, stored: string | undefined, body: Buffer): Promise<boolean> {
    const found = await this.#o.api.findFile(TRACKER_FILE_NAME, folder);
    if (!found || found === stored) return false;
    try {
      await this.#o.api.updateFile(found, XLSX_MIME, body);
    } catch (e) {
      if (e instanceof DriveNotFoundError) return false;
      throw e;
    }
    setKv(this.#o.db, TRACKER_ID_KEY, found);
    return true;
  }

  #noteNewFile(stored: string | undefined): void {
    const { db } = this.#o;
    // The first file ever is no news. A stored one that could not be reached means a new link: say so once.
    if (stored) {
      setKv(db, TRACKER_NEW_FILE_KEY, (this.#o.now?.() ?? new Date()).toISOString());
      try {
        this.#o.onNewFile?.();
      } catch (hookErr) {
        this.#o.log.error({ err: hookErr }, 'onNewFile failed');
      }
    }
  }
}
