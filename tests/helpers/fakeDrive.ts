import { DriveNotFoundError, type DriveApi } from '../../src/output/drive.ts';

export class FakeDrive implements DriveApi {
  folders: string[] = [];
  created: { id: string; name: string; parentId: string; bytes: number }[] = [];
  updated: { id: string; bytes: number }[] = [];
  missing = new Set<string>();
  failNext = 0;
  failUpdateWith: unknown;
  /** When set, createFile and updateFile wait for it (simulates a slow or hung upload). */
  gate: Promise<void> | undefined;
  #n = 0;

  async createFolder(name: string): Promise<string> {
    this.#maybeFail();
    this.folders.push(name);
    return `folder-${++this.#n}`;
  }

  async createFile(name: string, _mime: string, body: Buffer, parentId: string): Promise<string> {
    this.#maybeFail();
    await this.gate;
    if (this.missing.has(parentId)) throw new DriveNotFoundError(parentId);
    const id = `file-${++this.#n}`;
    this.created.push({ id, name, parentId, bytes: body.length });
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
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('Drive unavailable');
    }
  }
}
