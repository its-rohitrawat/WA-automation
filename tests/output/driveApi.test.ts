import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Google client is replaced by a stub: these tests check what googleDriveApi asks it to send, without any network.
const files = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }));
vi.mock('@googleapis/drive', () => ({ drive: vi.fn(() => ({ files })) }));

import { drive } from '@googleapis/drive';
import { DriveNotFoundError, googleDriveApi } from '../../src/output/drive.ts';
import type { OAuth2Client } from '../../src/output/googleAuth.ts';

const client = {} as unknown as OAuth2Client;

beforeEach(() => {
  files.create.mockReset();
  files.update.mockReset();
  files.create.mockResolvedValue({ data: { id: 'new-id' } });
});

describe('googleDriveApi', () => {
  it('keeps a 120 s default timeout on the client', () => {
    googleDriveApi(client);
    expect(vi.mocked(drive)).toHaveBeenCalledWith(expect.objectContaining({ version: 'v3', timeout: 120_000 }));
  });

  it('createFile passes timeoutMs as the per-request timeout, and no per-request timeout without it', async () => {
    const api = googleDriveApi(client);
    expect(await api.createFile('a.pdf', 'application/pdf', Buffer.from('x'), 'parent-1', 600_000)).toBe('new-id');
    expect(files.create.mock.calls[0]![0]).toMatchObject({ requestBody: { name: 'a.pdf', parents: ['parent-1'] }, fields: 'id' });
    expect(files.create.mock.calls[0]![1]).toEqual({ timeout: 600_000 });
    await api.createFile('Tracker.xlsx', 'application/octet-stream', Buffer.from('x'), 'root-1');
    expect(files.create.mock.calls[1]![1]).not.toHaveProperty('timeout');
  });

  it('createFolder creates inside parentId when given, at the top otherwise', async () => {
    const api = googleDriveApi(client);
    await api.createFolder('Files', 'client-folder');
    await api.createFolder('WA Agent');
    expect(files.create.mock.calls[0]![0]).toEqual({
      requestBody: { name: 'Files', mimeType: 'application/vnd.google-apps.folder', parents: ['client-folder'] },
      fields: 'id',
    });
    expect(files.create.mock.calls[1]![0]).toEqual({ requestBody: { name: 'WA Agent', mimeType: 'application/vnd.google-apps.folder' }, fields: 'id' });
  });

  it('createFolder turns a 404 for a missing parent into DriveNotFoundError', async () => {
    const api = googleDriveApi(client);
    files.create.mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 404 }));
    await expect(api.createFolder('Files', 'gone')).rejects.toBeInstanceOf(DriveNotFoundError);
    files.create.mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 404 }));
    await expect(api.createFolder('WA Agent')).rejects.not.toBeInstanceOf(DriveNotFoundError);
  });
});
