import { Readable } from 'node:stream';
import { drive } from '@googleapis/drive';
import type { Db } from '../store/db.ts';
import { getKv, setKv } from '../store/kv.ts';
import type { Logger } from '../util/logger.ts';
import type { OAuth2Client } from './googleAuth.ts';
import { XLSX_MIME } from './workbook.ts';

export class DriveNotFoundError extends Error {
  constructor(id: string) {
    super(`Drive item ${id} not found`);
    this.name = 'DriveNotFoundError';
  }
}

export class DriveAuthError extends Error {
  constructor(cause?: unknown) {
    super('Google sign-in has expired or was revoked. Run: npm run cli -- google-auth', { cause });
    this.name = 'DriveAuthError';
  }
}

/** A gaxios error with HTTP 401 or an invalid_grant body, or an error that says invalid_grant. */
export function isAuthFailure(e: unknown): boolean {
  const x = e as { code?: unknown; status?: unknown; name?: string; message?: string; response?: { status?: number; data?: { error?: unknown } } } | null;
  if (!x || typeof x !== 'object') return false;
  if (x.name === 'DriveAuthError') return true;
  if (Number(x.code) === 401 || x.status === 401 || x.response?.status === 401) return true;
  if (x.response?.data?.error === 'invalid_grant') return true;
  return /invalid_grant/.test(`${x.name ?? ''} ${x.message ?? ''}`);
}

export interface DriveApi {
  createFolder(name: string): Promise<string>;
  createFile(name: string, mimeType: string, body: Buffer, parentId: string): Promise<string>;
  updateFile(fileId: string, mimeType: string, body: Buffer): Promise<void>;
}

const isNotFound = (e: unknown) => (e as { code?: number }).code === 404;

export function googleDriveApi(client: OAuth2Client): DriveApi {
  const api = drive({ version: 'v3', auth: client, timeout: 120_000 });
  return {
    async createFolder(name) {
      const r = await api.files.create({ requestBody: { name, mimeType: 'application/vnd.google-apps.folder' }, fields: 'id' });
      if (!r.data.id) throw new Error('Drive returned no folder id');
      return r.data.id;
    },
    async createFile(name, mimeType, body, parentId) {
      try {
        const r = await api.files.create({ requestBody: { name, parents: [parentId] }, media: { mimeType, body: Readable.from(body) }, fields: 'id' });
        if (!r.data.id) throw new Error('Drive returned no file id');
        return r.data.id;
      } catch (e) {
        if (isNotFound(e)) throw new DriveNotFoundError(parentId);
        throw e;
      }
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

/** Overwrites the same Drive file so its link never changes. At most one upload per minute. Never deletes or trashes anything. */
export class DrivePublisher {
  readonly #o: PublisherOptions;
  readonly #minInterval: number;
  #lastRun = Number.NEGATIVE_INFINITY;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #pending = false;
  #failures = 0;
  #stopped = false;
  #current: Promise<void> | undefined;

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
   */
  async publishNow(): Promise<void> {
    if (this.#stopped) return;
    if (this.#current) {
      this.#pending = true;
      await this.#current;
      return;
    }
    clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#start();
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

  #start(): Promise<void> {
    const run = this.#run().finally(() => {
      if (this.#current === run) this.#current = undefined;
      // Changes that arrived during the run get exactly one follow-up (after a failure, the backoff retry covers them).
      if (this.#pending) {
        this.#pending = false;
        this.schedule();
      }
    });
    this.#current = run;
    return run;
  }

  async #run(): Promise<void> {
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
      return;
    }
    if (published) {
      try {
        this.#o.onPublished?.();
      } catch (hookErr) {
        this.#o.log.error({ err: hookErr }, 'onPublished failed');
      }
    }
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
    if (!root) {
      root = await api.createFolder('WA Agent');
      setKv(db, 'drive_root_id', root);
    }
    const tracker = getKv(db, 'drive_tracker_id');
    if (tracker) {
      try {
        await api.updateFile(tracker, XLSX_MIME, body);
        return;
      } catch (e) {
        if (!(e instanceof DriveNotFoundError)) throw e;
      }
    }
    try {
      setKv(db, 'drive_tracker_id', await api.createFile('Tracker.xlsx', XLSX_MIME, body, root));
    } catch (e) {
      if (!(e instanceof DriveNotFoundError)) throw e;
      // The root folder was removed: re-create it and retry once, in the same run.
      root = await api.createFolder('WA Agent');
      setKv(db, 'drive_root_id', root);
      setKv(db, 'drive_tracker_id', await api.createFile('Tracker.xlsx', XLSX_MIME, body, root));
    }
  }
}
