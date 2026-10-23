import { sanitizeFileName } from '../media/paths.ts';
import type { Db } from '../store/db.ts';
import { getKv, setKv } from '../store/kv.ts';
import { DriveNotFoundError, type DriveApi } from './drive.ts';

/** The folders kept for each client in WA Agent/Clients/<Client>/: shared files, and meeting Docs (team only). */
export type ClientSubfolder = 'Files' | 'Meetings';

export interface FolderClient {
  clientId: number;
  clientName: string;
}

/** The WA Agent folder is not made yet: DrivePublisher makes it (kv drive_root_id) on its first upload. */
export class DriveRootMissingError extends Error {
  constructor() {
    super('The WA Agent folder in Drive is not made yet');
    this.name = 'DriveRootMissingError';
  }
}

const CLIENTS_KEY = 'drive_clients_folder';
const clientKey = (clientId: number): string => `drive_client_folder:${clientId}`;
const subfolderKey = (kind: ClientSubfolder, clientId: number): string =>
  kind === 'Files' ? `drive_files_folder:${clientId}` : `drive_meetings_folder:${clientId}`;

/**
 * The client's Files or Meetings folder, made (with any folder above it that is not saved) when no id is saved. Folders
 * are never searched for: a missing id means make one. Each new folder's id is saved right after Drive makes it.
 * created: the subfolder was made just now. Throws DriveRootMissingError when the WA Agent folder is not made yet.
 */
async function subfolder(db: Db, api: DriveApi, c: FolderClient, kind: ClientSubfolder): Promise<{ id: string; created: boolean }> {
  const key = subfolderKey(kind, c.clientId);
  const cached = getKv(db, key);
  if (cached) return { id: cached, created: false };
  const root = getKv(db, 'drive_root_id');
  if (!root) throw new DriveRootMissingError();
  let clients = getKv(db, CLIENTS_KEY);
  if (!clients) {
    clients = await api.createFolder('Clients', root);
    setKv(db, CLIENTS_KEY, clients);
  }
  let client = getKv(db, clientKey(c.clientId));
  if (!client) {
    client = await api.createFolder(sanitizeFileName(c.clientName) ?? `Client ${c.clientId}`, clients);
    setKv(db, clientKey(c.clientId), client);
  }
  const id = await api.createFolder(kind, client);
  setKv(db, key, id);
  return { id, created: true };
}

/** The id of WA Agent/Clients/<Client>/<kind>/ in Drive, made once and saved in kv. See subfolder. */
export async function ensureClientSubfolder(db: Db, api: DriveApi, client: FolderClient, kind: ClientSubfolder): Promise<string> {
  return (await subfolder(db, api, client, kind)).id;
}

/**
 * Runs put(folderId) in the client's Files or Meetings folder. When Drive says a folder is gone (DriveNotFoundError), a
 * folder was removed in Drive: one more level is rebuilt per retry, the subfolder first, then the client folder, then
 * Clients, and put runs again. Creating a folder inside a removed one fails the same way, so a level above the subfolder
 * is rebuilt only when creating a folder in it failed. A rebuilt level gets new folders inside it too, so the inner keys
 * are cleared again (a retry may have saved a new inner id). The WA Agent folder itself is never rebuilt here: the
 * publisher owns it, and the last DriveNotFoundError is thrown.
 *
 * When put is refused in a subfolder made just now, inside folders that were there a moment ago, nothing is missing to
 * rebuild, and moving up would make a second client folder with the same name: the error is thrown.
 *
 * Another client's folders, or this client's other subfolder, that sat in a rebuilt folder are not cleared here: their
 * own next call finds them gone and rebuilds them the same way.
 */
export async function withClientSubfolder<T>(
  db: Db,
  api: DriveApi,
  client: FolderClient,
  kind: ClientSubfolder,
  put: (folderId: string) => Promise<T>,
): Promise<T> {
  // Innermost first: the subfolder, then the client folder, then Clients.
  const levels = [subfolderKey(kind, client.clientId), clientKey(client.clientId), CLIENTS_KEY];
  for (let step = 0; ; step++) {
    let fresh = false;
    try {
      const f = await subfolder(db, api, client, kind);
      fresh = f.created;
      return await put(f.id);
    } catch (e) {
      if (!(e instanceof DriveNotFoundError) || step === levels.length || fresh) throw e;
      for (const key of levels.slice(0, step + 1)) setKv(db, key, '');
    }
  }
}
