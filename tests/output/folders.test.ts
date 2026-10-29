import { describe, expect, it } from 'vitest';
import { DriveNotFoundError } from '../../src/output/drive.ts';
import { DriveRootMissingError, withClientSubfolder, type ClientSubfolder, type FolderClient } from '../../src/output/folders.ts';
import type { Db } from '../../src/store/db.ts';
import { getKv, setKv } from '../../src/store/kv.ts';
import { seededDb } from '../helpers/db.ts';
import { FakeDrive } from '../helpers/fakeDrive.ts';

const SHARMA = { clientId: 1, clientName: 'Sharma Interiors' };

/** The subfolder's id, through withClientSubfolder with a put that only returns it. */
const folderOf = (db: Db, drive: FakeDrive, c: FolderClient, kind: ClientSubfolder): Promise<string> =>
  withClientSubfolder(db, drive, c, kind, async (id) => id);

async function setup(root = true) {
  const db = await seededDb();
  const drive = new FakeDrive();
  if (root) setKv(db, 'drive_root_id', 'root-1');
  return { db, drive };
}

describe('withClientSubfolder: the folder chain', () => {
  it('makes WA Agent/Clients/<Client>/Meetings once and caches every level', async () => {
    const { db, drive } = await setup();
    const id = await folderOf(db, drive, SHARMA, 'Meetings');
    expect(await folderOf(db, drive, SHARMA, 'Meetings')).toBe(id);
    expect(drive.folders).toEqual(['Clients', 'Sharma Interiors', 'Meetings']);
    expect(drive.folderParents).toEqual(['root-1', 'folder-1', 'folder-2']);
    expect(getKv(db, 'drive_clients_folder')).toBe('folder-1');
    expect(getKv(db, 'drive_client_folder:1')).toBe('folder-2');
    expect(getKv(db, 'drive_meetings_folder:1')).toBe('folder-3');
    expect(id).toBe('folder-3');
  });

  it('puts Files and Meetings side by side in the same client folder, with their own keys', async () => {
    const { db, drive } = await setup();
    const files = await folderOf(db, drive, SHARMA, 'Files');
    const meetings = await folderOf(db, drive, SHARMA, 'Meetings');
    expect(drive.folders).toEqual(['Clients', 'Sharma Interiors', 'Files', 'Meetings']);
    expect(drive.folderParents).toEqual(['root-1', 'folder-1', 'folder-2', 'folder-2']);
    expect(getKv(db, 'drive_files_folder:1')).toBe(files);
    expect(getKv(db, 'drive_meetings_folder:1')).toBe(meetings);
  });

  it('cleans the client folder name and falls back to "Client <id>"', async () => {
    const { db, drive } = await setup();
    await folderOf(db, drive, { clientId: 7, clientName: '...' }, 'Meetings');
    expect(drive.folders).toEqual(['Clients', 'Client 7', 'Meetings']);
  });

  it('throws DriveRootMissingError, and makes nothing, before the publisher has made the WA Agent folder', async () => {
    const { db, drive } = await setup(false);
    await expect(folderOf(db, drive, SHARMA, 'Meetings')).rejects.toBeInstanceOf(DriveRootMissingError);
    expect(drive.folders).toEqual([]);
  });
});

describe('withClientSubfolder', () => {
  const putDoc = (drive: FakeDrive) => (folder: string) => drive.createDoc('Doc', '<p>x</p>', folder);

  it('re-creates only a removed Meetings folder, inside the same client folder', async () => {
    const { db, drive } = await setup();
    await folderOf(db, drive, SHARMA, 'Meetings');
    drive.missing.add('folder-3');
    const id = await withClientSubfolder(db, drive, SHARMA, 'Meetings', putDoc(drive));
    expect(drive.folders).toEqual(['Clients', 'Sharma Interiors', 'Meetings', 'Meetings']);
    expect(drive.folderParents).toEqual(['root-1', 'folder-1', 'folder-2', 'folder-2']);
    expect(drive.docs).toEqual([{ id, name: 'Doc', parentId: 'folder-4', html: '<p>x</p>' }]);
    expect(getKv(db, 'drive_meetings_folder:1')).toBe('folder-4');
  });

  it('re-creates a removed client folder and its Meetings folder once, but not the Clients folder', async () => {
    const { db, drive } = await setup();
    await folderOf(db, drive, SHARMA, 'Meetings');
    for (const id of ['folder-2', 'folder-3']) drive.missing.add(id);
    await withClientSubfolder(db, drive, SHARMA, 'Meetings', putDoc(drive));
    expect(drive.folders).toEqual(['Clients', 'Sharma Interiors', 'Meetings', 'Sharma Interiors', 'Meetings']);
    expect(drive.folderParents).toEqual(['root-1', 'folder-1', 'folder-2', 'folder-1', 'folder-4']);
    expect(drive.docs).toHaveLength(1);
    expect(drive.docs[0]).toMatchObject({ parentId: 'folder-5' });
    expect(getKv(db, 'drive_client_folder:1')).toBe('folder-4');
  });

  it('fails without rebuilding when the Doc is refused in a Meetings folder made just now', async () => {
    const { db, drive } = await setup();
    drive.fileParentsMissing = true;
    await expect(withClientSubfolder(db, drive, SHARMA, 'Meetings', putDoc(drive))).rejects.toBeInstanceOf(DriveNotFoundError);
    expect(drive.folders).toEqual(['Clients', 'Sharma Interiors', 'Meetings']);
    expect(drive.createDocCalls).toBe(1);
  });

  it('gives up after rebuilding every level when the WA Agent folder itself is gone', async () => {
    const { db, drive } = await setup();
    drive.missing.add('root-1');
    await expect(withClientSubfolder(db, drive, SHARMA, 'Meetings', putDoc(drive))).rejects.toBeInstanceOf(DriveNotFoundError);
    expect(drive.folders).toEqual([]);
    expect(drive.createDocCalls).toBe(0);
  });

  it('passes other errors through without clearing anything', async () => {
    const { db, drive } = await setup();
    await folderOf(db, drive, SHARMA, 'Meetings');
    drive.failNext = 1;
    await expect(withClientSubfolder(db, drive, SHARMA, 'Meetings', putDoc(drive))).rejects.toThrow('Drive unavailable');
    expect(getKv(db, 'drive_meetings_folder:1')).toBe('folder-3');
  });
});
