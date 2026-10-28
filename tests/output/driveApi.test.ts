import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Google client is replaced by a stub: these tests check what googleDriveApi asks it to send, without any network.
const files = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }));
vi.mock('@googleapis/drive', () => ({ drive: vi.fn(() => ({ files })) }));

import { drive } from '@googleapis/drive';
import { Readable } from 'node:stream';
import { DriveAuthError, DriveNotFoundError, googleDriveApi } from '../../src/output/drive.ts';
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

  it('with a getter: builds the Drive handle on the first call, again only when the client changes, each with 120 s', async () => {
    vi.mocked(drive).mockClear();
    const other = {} as OAuth2Client;
    let current = client;
    const api = googleDriveApi(() => current);
    expect(vi.mocked(drive)).not.toHaveBeenCalled();
    await api.createFolder('A');
    await api.createFolder('B');
    expect(vi.mocked(drive)).toHaveBeenCalledTimes(1);
    current = other;
    await api.createFolder('C');
    expect(vi.mocked(drive)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(drive).mock.calls.map((c) => c[0] as unknown as { auth: unknown; timeout: number }))
      .toEqual([expect.objectContaining({ auth: client, timeout: 120_000 }), expect.objectContaining({ auth: other, timeout: 120_000 })]);
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
  it('createDoc uploads the HTML as text/html and asks Drive to convert it to a Google Doc in the parent', async () => {
    const api = googleDriveApi(client);
    expect(await api.createDoc('2026-10-19 – Sharma – Kickoff', '<p>Hé</p>', 'meetings-1')).toBe('new-id');
    const [params, options] = files.create.mock.calls[0]!;
    expect(params).toMatchObject({
      requestBody: { name: '2026-10-19 – Sharma – Kickoff', mimeType: 'application/vnd.google-apps.document', parents: ['meetings-1'] },
      media: { mimeType: 'text/html' },
      fields: 'id',
    });
    expect(Object.keys(params as object).sort()).toEqual(['fields', 'media', 'requestBody']);
    const body = (params as { media: { body: Readable } }).media.body;
    expect(body).toBeInstanceOf(Readable);
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(Buffer.from(c as Buffer));
    expect(Buffer.concat(chunks).toString('utf8')).toBe('<p>Hé</p>');
    expect(options).toBeUndefined();
  });

  it('createDoc turns a 404 into DriveNotFoundError and a sign-in failure into DriveAuthError', async () => {
    const api = googleDriveApi(client);
    files.create.mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 404 }));
    await expect(api.createDoc('N', '<p></p>', 'gone')).rejects.toBeInstanceOf(DriveNotFoundError);
    files.create.mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { code: 401 }));
    await expect(api.createDoc('N', '<p></p>', 'p')).rejects.toBeInstanceOf(DriveAuthError);
    files.create.mockRejectedValueOnce(Object.assign(new Error('x'), { response: { status: 400, data: { error: 'invalid_grant' } } }));
    await expect(api.createDoc('N', '<p></p>', 'p')).rejects.toBeInstanceOf(DriveAuthError);
    const other = Object.assign(new Error('server'), { code: 500 });
    files.create.mockRejectedValueOnce(other);
    await expect(api.createDoc('N', '<p></p>', 'p')).rejects.toBe(other);
    files.create.mockResolvedValueOnce({ data: {} });
    await expect(api.createDoc('N', '<p></p>', 'p')).rejects.toThrow('Drive returned no document id');
  });
});
