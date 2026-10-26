import { DriveNotFoundError, type DriveApi } from '../../src/output/drive.ts';

export class FakeDrive implements DriveApi {
  folders: string[] = [];
  /** Parent of each created folder, in the same order as `folders` (undefined: top level). */
  folderParents: (string | undefined)[] = [];
  created: { id: string; name: string; parentId: string; bytes: number }[] = [];
  /** Per-request timeout of each created file, in the same order as `created` (undefined: the client's default). */
  createTimeouts: (number | undefined)[] = [];
  /** MIME type sent with each created file, in the same order as `created`. */
  createMimes: string[] = [];
  /** Every createFile call, including the ones that failed. */
  createFileCalls = 0;
  /** When true, every createFile (and createDoc) throws DriveNotFoundError, as if its parent folder were always missing. */
  fileParentsMissing = false;
  /** Every Google Doc created by createDoc, in order. */
  docs: { id: string; name: string; parentId: string; html: string }[] = [];
  /** Every createDoc call, including the ones that failed. */
  createDocCalls = 0;
  updated: { id: string; bytes: number }[] = [];
  missing = new Set<string>();
  failNext = 0;
  /** When set, the next call throws this once (for example a 401 from Google). */
  failNextWith: unknown;
  failUpdateWith: unknown;
  /** When set, createFile and updateFile wait for it (simulates a slow or hung upload). */
  gate: Promise<void> | undefined;
  #n = 0;

  async createFolder(name: string, parentId?: string): Promise<string> {
    this.#maybeFail();
    if (parentId !== undefined && this.missing.has(parentId)) throw new DriveNotFoundError(parentId);
    this.folders.push(name);
    this.folderParents.push(parentId);
    return `folder-${++this.#n}`;
  }

  async createFile(name: string, mime: string, body: Buffer, parentId: string, timeoutMs?: number): Promise<string> {
    this.createFileCalls++;
    this.#maybeFail();
    await this.gate;
    if (this.fileParentsMissing || this.missing.has(parentId)) throw new DriveNotFoundError(parentId);
    const id = `file-${++this.#n}`;
    this.created.push({ id, name, parentId, bytes: body.length });
    this.createTimeouts.push(timeoutMs);
    this.createMimes.push(mime);
    return id;
  }

  /** Fails like createFile: failNext / failNextWith, a missing parent, fileParentsMissing; waits for gate. */
  async createDoc(name: string, html: string, parentId: string): Promise<string> {
    this.createDocCalls++;
    this.#maybeFail();
    await this.gate;
    if (this.fileParentsMissing || this.missing.has(parentId)) throw new DriveNotFoundError(parentId);
    const id = `doc-${++this.#n}`;
    this.docs.push({ id, name, parentId, html });
    return id;
  }

  async updateFile(id: string, _mime: string, body: Buffer): Promise<void> {
    if (this.failUpdateWith) throw this.failUpdateWith;
    this.#maybeFail();
    await this.gate;
    if (this.missing.has(id)) throw new DriveNotFoundError(id);
    this.updated.push({ id, bytes: body.length });
  }

  get uploads(): number {
    return this.created.length + this.updated.length;
  }

  #maybeFail(): void {
    if (this.failNextWith !== undefined) {
      const e = this.failNextWith;
      this.failNextWith = undefined;
      throw e;
    }
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('Drive unavailable');
    }
  }
}
