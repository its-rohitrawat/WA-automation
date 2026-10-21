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

export interface DriveApi {
  createFolder(name: string): Promise<string>;
  createFile(name: string, mimeType: string, body: Buffer, parentId: string): Promise<string>;
  updateFile(fileId: string, mimeType: string, body: Buffer): Promise<void>;
}

const isNotFound = (e: unknown) => (e as { code?: number }).code === 404;

export function googleDriveApi(client: OAuth2Client): DriveApi {
  const api = drive({ version: 'v3', auth: client });
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
}

class PublishError extends Error {
  readonly step: 'build' | 'drive';
  constructor(step: 'build' | 'drive', original: unknown) {
    super(`Publish failed at step ${step}`);
    this.name = (original as Error | undefined)?.name ?? 'Error';
    this.step = step;
  }
}

/** Overwrites the same Drive file so its link never changes. At most one upload per minute. Never deletes or trashes anything. */
export class DrivePublisher {
  readonly #o: PublisherOptions;
  readonly #minInterval: number;
  #lastRun = Number.NEGATIVE_INFINITY;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;
  #pending = false;
  #failures = 0;
  #stopped = false;

  constructor(o: PublisherOptions) {
    this.#o = o;
    this.#minInterval = o.minIntervalMs ?? 60_000;
  }

  schedule(): void {
    if (this.#stopped) return;
    if (this.#running) {
      this.#pending = true;
      return;
    }
    if (this.#timer) return;
    const wait = Math.max(0, this.#lastRun + this.#minInterval - Date.now());
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#run();
    }, wait);
  }

  async publishNow(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#run();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
  }

  async #run(): Promise<void> {
    this.#running = true;
    this.#lastRun = Date.now();
    try {
      await this.#publish();
      this.#failures = 0;
      this.#o.onPublished?.();
    } catch (e) {
      this.#failures++;
      const step = e instanceof PublishError ? e.step : 'drive';
      const fields = { step, err: (e as Error).name, failures: this.#failures };
      // Never the error message: Google errors can echo request details.
      if (step === 'build') this.#o.log.error(fields, 'Tracker build failed');
      else this.#o.log.warn(fields, 'Drive publish failed');
      this.#running = false;
      if (!this.#stopped) {
        const backoff = Math.min(60_000 * 2 ** (this.#failures - 1), 15 * 60_000);
        clearTimeout(this.#timer);
        this.#timer = setTimeout(() => {
          this.#timer = undefined;
          void this.#run();
        }, backoff);
      }
      return;
    }
    this.#running = false;
    if (this.#pending) {
      this.#pending = false;
      this.schedule();
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
      if (e instanceof DriveNotFoundError) setKv(db, 'drive_root_id', ''); // folder removed: recreate next time
      throw e;
    }
  }
}
