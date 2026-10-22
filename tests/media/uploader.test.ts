import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DriveFileUploader, FILE_UPLOAD_TIMEOUT_MS, retryMs, UPLOAD_MAX_ATTEMPTS } from '../../src/media/uploader.ts';
import type { Db } from '../../src/store/db.ts';
import { setKv } from '../../src/store/kv.ts';
import { finishMedia, getMedia, insertMedia, markDownloaded, messageRowId, resetUploadFailures, type MediaKind } from '../../src/store/media.ts';
import { applyRevoke, insertMessage } from '../../src/store/messages.ts';
import { setRole, upsertPerson, type Role } from '../../src/store/people.ts';
import { manualClock } from '../../src/util/clock.ts';
import { silentLogger } from '../../src/util/logger.ts';
import { NOW, seededDb } from '../helpers/db.ts';
import { FakeDrive } from '../helpers/fakeDrive.ts';
import { RAHUL_PN, SHARMA_PN } from '../helpers/wa.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(o: { root?: boolean; batchSize?: number } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'wa-up-'));
  dirs.push(dataDir);
  const db = seededDb();
  const drive = new FakeDrive();
  const clock = manualClock('2026-10-19T08:00:00Z');
  const onUploaded = vi.fn();
  const up = new DriveFileUploader({
    db, api: drive, dataDir, clock, log: silentLogger(), onUploaded, ...(o.batchSize === undefined ? {} : { batchSize: o.batchSize }),
  });
  if (o.root !== false) setKv(db, 'drive_root_id', 'root-1');
  return { db, dataDir, drive, clock, onUploaded, up };
}

/**
 * A file that a person shared in a client group (Sharma, id 1, unless clientId says otherwise), saved on disk and read.
 * saved: false leaves it pending download, with no local_path.
 */
function savedFile(
  db: Db,
  dataDir: string,
  o: { waId: string; clientId?: number; jid?: string; role?: Role; kind?: MediaKind; fileName?: string | null; mimeType?: string; fromMe?: boolean; saved?: boolean },
): number {
  const clientId = o.clientId ?? 1;
  const jid = o.jid ?? SHARMA_PN;
  const kind = o.kind ?? 'document';
  const fromMe = o.fromMe ?? false;
  insertMessage(db, { waId: o.waId, clientId, senderJid: jid, senderNumber: null, senderName: 'Mr. Sharma', fromMe, ts: '2026-10-10T08:00:00.000Z', text: null, quotedWaId: null, mediaType: kind });
  upsertPerson(db, { clientId, jid, number: null, name: 'Mr. Sharma', fromMe });
  if (o.role) setRole(db, clientId, jid, o.role, 'human');
  const id = insertMedia(db, {
    messageId: messageRowId(db, clientId, o.waId)!, clientId, kind, status: 'pending', mimeType: o.mimeType ?? 'application/pdf',
    fileName: o.fileName === undefined ? 'brief.pdf' : o.fileName, fileSize: 9, seconds: null, forwarded: false, refEnc: null, errorCode: null, createdAt: NOW,
  });
  if (o.saved !== false) saveOriginal(db, dataDir, id, clientId, o.waId);
  return id;
}

/** The download finished: the original is on disk and the file has been read. */
function saveOriginal(db: Db, dataDir: string, id: number, clientId: number, waId: string): void {
  const code = clientId === 1 ? 'SHA' : 'MEH';
  const rel = `media/${code}/2026-10/${waId}.bin`;
  mkdirSync(join(dataDir, 'media', code, '2026-10'), { recursive: true });
  writeFileSync(join(dataDir, ...rel.split('/')), 'pdf-bytes');
  markDownloaded(db, id, { localPath: rel, sha256: 'x', fileSize: 9, at: NOW });
  finishMedia(db, id, { textKind: 'extract', text: 'Brief', pageCount: 1, note: null, at: NOW });
}

const driveState = (db: Db, id: number) =>
  db.prepare('SELECT drive_file_id AS fileId, drive_attempts AS attempts, drive_failed AS failed, drive_next_at AS nextAt FROM media WHERE id = ?').get(id);

describe('DriveFileUploader', () => {
  it('uploads client files into WA Agent/Clients/<Client>/Files, creating the folders once', async () => {
    const { db, dataDir, drive, onUploaded, up } = setup();
    const a = savedFile(db, dataDir, { waId: 'A', role: 'client' });
    const b = savedFile(db, dataDir, { waId: 'B', role: 'client' });
    await up.run();
    expect(drive.folders).toEqual(['Clients', 'Sharma Interiors', 'Files']);
    expect(drive.folderParents).toEqual(['root-1', 'folder-1', 'folder-2']);
    expect(drive.created).toEqual([
      { id: 'file-4', name: 'brief.pdf', parentId: 'folder-3', bytes: 9 },
      { id: 'file-5', name: 'brief.pdf', parentId: 'folder-3', bytes: 9 },
    ]);
    expect(getMedia(db, a)!.driveFileId).toBe('file-4');
    expect(getMedia(db, b)!.driveFileId).toBe('file-5');
    expect(onUploaded).toHaveBeenCalledTimes(1);
    await up.run();
    expect(drive.created).toHaveLength(2);
    expect(onUploaded).toHaveBeenCalledTimes(1);
  });

  it('gives each file upload the long per-request timeout (600 s), not the tracker upload default', async () => {
    const { db, dataDir, drive, up } = setup();
    savedFile(db, dataDir, { waId: 'A', role: 'client' });
    await up.run();
    expect(FILE_UPLOAD_TIMEOUT_MS).toBe(600_000);
    expect(drive.createTimeouts).toEqual([600_000]);
  });

  it('uploads only files from people marked client, including earlier files once someone becomes client', async () => {
    const { db, dataDir, drive, up } = setup();
    savedFile(db, dataDir, { waId: 'T', jid: RAHUL_PN, role: 'team' });
    const u = savedFile(db, dataDir, { waId: 'U', jid: '919811111111@s.whatsapp.net' });
    await up.run();
    expect(drive.created).toHaveLength(0);
    setRole(db, 1, '919811111111@s.whatsapp.net', 'client', 'ai');
    await up.run();
    expect(drive.created).toHaveLength(1);
    expect(getMedia(db, u)!.driveFileId).not.toBeNull();
  });

  it("checks the sender's role in the file's own client group, and files each client's uploads in its own folder", async () => {
    const { db, dataDir, drive, up } = setup();
    const both = '919811111111@s.whatsapp.net'; // team in Sharma's group, client in Mehta's
    const s = savedFile(db, dataDir, { waId: 'S', role: 'client' });
    const t = savedFile(db, dataDir, { waId: 'T', jid: both, role: 'team' });
    const m = savedFile(db, dataDir, { waId: 'M', clientId: 2, jid: both, role: 'client' });
    await up.run();
    await up.run();
    expect(drive.folders).toEqual(['Clients', 'Sharma Interiors', 'Files', 'Mehta Foods', 'Files']);
    expect(drive.folderParents).toEqual(['root-1', 'folder-1', 'folder-2', 'folder-1', 'folder-5']);
    expect(drive.created).toEqual([
      { id: 'file-4', name: 'brief.pdf', parentId: 'folder-3', bytes: 9 },
      { id: 'file-7', name: 'brief.pdf', parentId: 'folder-6', bytes: 9 },
    ]);
    expect(getMedia(db, s)!.driveFileId).toBe('file-4');
    expect(getMedia(db, m)!.driveFileId).toBe('file-7');
    expect(driveState(db, t)).toEqual({ fileId: null, attempts: 0, failed: 0, nextAt: null });
  });

  it('leaves out files whose original is not saved yet, and uploads them once saved', async () => {
    const { db, dataDir, drive, up } = setup();
    const a = savedFile(db, dataDir, { waId: 'A', role: 'client', saved: false });
    await up.run();
    expect(drive.createFileCalls).toBe(0);
    expect(drive.folders).toEqual([]);
    expect(driveState(db, a)).toEqual({ fileId: null, attempts: 0, failed: 0, nextAt: null });
    saveOriginal(db, dataDir, a, 1, 'A');
    await up.run();
    expect(drive.created).toHaveLength(1);
    expect(getMedia(db, a)!.driveFileId).toBe(drive.created[0]!.id);
  });

  it("never uploads the founder's own files, voice notes, or files of an inactive client", async () => {
    const { db, dataDir, drive, up } = setup();
    savedFile(db, dataDir, { waId: 'ME', jid: '919899999999@s.whatsapp.net', role: 'client', fromMe: true });
    savedFile(db, dataDir, { waId: 'V', role: 'client', kind: 'voice', fileName: null, mimeType: 'audio/ogg' });
    const a = savedFile(db, dataDir, { waId: 'A', role: 'client' });
    db.prepare('UPDATE clients SET active = 0 WHERE id = 1').run();
    await up.run();
    expect(drive.created).toHaveLength(0);
    db.prepare('UPDATE clients SET active = 1 WHERE id = 1').run();
    await up.run();
    expect(drive.created).toHaveLength(1);
    expect(getMedia(db, a)!.driveFileId).toBe(drive.created[0]!.id);
  });

  it('skips files whose message was deleted for everyone', async () => {
    const { db, dataDir, drive, up } = setup();
    savedFile(db, dataDir, { waId: 'R', role: 'client' });
    applyRevoke(db, 1, 'R');
    await up.run();
    expect(drive.created).toHaveLength(0);
  });

  it('waits until the publisher has created the root folder', async () => {
    const { db, dataDir, drive, up } = setup({ root: false });
    savedFile(db, dataDir, { waId: 'A', role: 'client' });
    await up.run();
    expect(drive.folders).toEqual([]);
  });

  it('uses safe Drive names', async () => {
    const { db, dataDir, drive, up } = setup();
    savedFile(db, dataDir, { waId: 'A', role: 'client', fileName: 'Q3/brief:final\u202E.pdf' });
    const img = savedFile(db, dataDir, { waId: 'B', role: 'client', kind: 'image', fileName: null, mimeType: 'image/jpeg' });
    await up.run();
    expect(drive.created.map((f) => f.name)).toEqual(['Q3_brief_final.pdf', `image-2026-10-10-1330-${img}.jpg`]);
  });

  it('keeps hidden characters in this test source as escapes, never raw (amendment 13a)', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect([...source].filter((c) => c !== '\n' && c !== '\r' && /[\p{Cc}\p{Cf}]/u.test(c))).toEqual([]);
  });

  it('retries with growing delays, gives up after the last attempt, and a restart tries again', async () => {
    const { db, dataDir, drive, clock, up } = setup();
    const a = savedFile(db, dataDir, { waId: 'A', role: 'client' });
    drive.failNext = 100;
    await up.run();
    expect(driveState(db, a)).toEqual({ fileId: null, attempts: 1, failed: 0, nextAt: '2026-10-19T08:02:00.000Z' });
    await up.run(); // not due yet
    expect(driveState(db, a)).toMatchObject({ attempts: 1 });
    for (let i = 2; i <= UPLOAD_MAX_ATTEMPTS; i++) {
      clock.advance(7 * 3_600_000);
      await up.run();
      // After try i fails, the next one waits 2^i minutes; the last try gives up instead.
      const nextAt = i < UPLOAD_MAX_ATTEMPTS ? new Date(clock.now().getTime() + 2 ** i * 60_000).toISOString() : null;
      expect(driveState(db, a)).toMatchObject({ attempts: i, failed: i < UPLOAD_MAX_ATTEMPTS ? 0 : 1, nextAt });
    }
    // A file that gave up is not tried again in later passes, however much time goes by.
    clock.advance(7 * 3_600_000);
    await up.run();
    expect(driveState(db, a)).toEqual({ fileId: null, attempts: UPLOAD_MAX_ATTEMPTS, failed: 1, nextAt: null });
    expect(resetUploadFailures(db)).toBe(1);
    expect(driveState(db, a)).toMatchObject({ attempts: 0, failed: 0 });
    drive.failNext = 0;
    await up.run();
    expect(drive.created).toHaveLength(1);
    expect(getMedia(db, a)!.driveFileId).toBe(drive.created[0]!.id);
  });

  it('clears the next-try time once a retried file reaches Drive', async () => {
    const { db, dataDir, drive, clock, up } = setup();
    const a = savedFile(db, dataDir, { waId: 'A', role: 'client' });
    drive.failNext = 1;
    await up.run();
    expect(driveState(db, a)).toEqual({ fileId: null, attempts: 1, failed: 0, nextAt: '2026-10-19T08:02:00.000Z' });
    clock.advance(3 * 60_000);
    await up.run();
    expect(driveState(db, a)).toMatchObject({ fileId: 'file-4', failed: 0, nextAt: null });
  });

  it('caps the retry delay at 6 hours', () => {
    expect(retryMs(1)).toBe(2 * 60_000);
    expect(retryMs(7)).toBe(128 * 60_000);
    expect(retryMs(9)).toBe(6 * 3_600_000);
    expect(retryMs(10)).toBe(6 * 3_600_000);
  });

  it('a sign-in problem is not counted against the file and stops the pass', async () => {
    const { db, dataDir, drive, up } = setup();
    const a = savedFile(db, dataDir, { waId: 'A', role: 'client' });
    const b = savedFile(db, dataDir, { waId: 'B', role: 'client' });
    drive.failNextWith = Object.assign(new Error('unauthorized'), { code: 401 });
    await up.run();
    expect(driveState(db, a)).toEqual({ fileId: null, attempts: 0, failed: 0, nextAt: '2026-10-19T08:15:00.000Z' });
    expect(driveState(db, b)).toEqual({ fileId: null, attempts: 0, failed: 0, nextAt: null });
  });

  it('re-creates a Files folder that was removed in Drive, in the same pass', async () => {
    const { db, dataDir, drive, up } = setup();
    savedFile(db, dataDir, { waId: 'A', role: 'client' });
    await up.run();
    drive.missing.add('folder-3');
    const b = savedFile(db, dataDir, { waId: 'B', role: 'client' });
    await up.run();
    expect(drive.folders).toEqual(['Clients', 'Sharma Interiors', 'Files', 'Sharma Interiors', 'Files']);
    expect(drive.created[1]).toMatchObject({ parentId: 'folder-6' });
    expect(getMedia(db, b)!.driveFileId).toBe('file-7');
  });

  it('re-creates the Clients folder too when it was removed in Drive, in the same pass', async () => {
    const { db, dataDir, drive, up } = setup();
    savedFile(db, dataDir, { waId: 'A', role: 'client' });
    await up.run();
    // Removing WA Agent/Clients in Drive removes everything under it.
    for (const id of ['folder-1', 'folder-2', 'folder-3']) drive.missing.add(id);
    const b = savedFile(db, dataDir, { waId: 'B', role: 'client' });
    await up.run();
    expect(drive.folders).toEqual(['Clients', 'Sharma Interiors', 'Files', 'Clients', 'Sharma Interiors', 'Files']);
    expect(drive.folderParents).toEqual(['root-1', 'folder-1', 'folder-2', 'root-1', 'folder-5', 'folder-6']);
    expect(drive.created[1]).toMatchObject({ parentId: 'folder-7' });
    expect(getMedia(db, b)!.driveFileId).toBe('file-8');
  });

  it('counts one failed attempt when the WA Agent folder itself is missing, and creates no folders', async () => {
    const { db, dataDir, drive, up } = setup();
    const a = savedFile(db, dataDir, { waId: 'A', role: 'client' });
    drive.missing.add('root-1');
    await up.run();
    expect(drive.folders).toEqual([]);
    expect(driveState(db, a)).toEqual({ fileId: null, attempts: 1, failed: 0, nextAt: '2026-10-19T08:02:00.000Z' });
  });

  it('rebuilds folders at most twice per file when Drive keeps saying the folder is missing', async () => {
    const { db, dataDir, drive, up } = setup();
    const a = savedFile(db, dataDir, { waId: 'A', role: 'client' });
    drive.fileParentsMissing = true;
    await up.run();
    expect(drive.createFileCalls).toBe(3);
    expect(driveState(db, a)).toMatchObject({ fileId: null, attempts: 1, failed: 0 });
  });

  it('sends Drive a clean MIME type: lower case, no parameters, and octet-stream for anything malformed', async () => {
    const { db, dataDir, drive, up } = setup();
    savedFile(db, dataDir, { waId: 'A', role: 'client', mimeType: 'Application/PDF; charset=x' });
    savedFile(db, dataDir, { waId: 'B', role: 'client', mimeType: 'a/b<script>' });
    savedFile(db, dataDir, { waId: 'C', role: 'client', mimeType: 'not a mime' });
    savedFile(db, dataDir, { waId: 'D', role: 'client', mimeType: 'image/svg+xml' });
    await up.run();
    expect(drive.createMimes).toEqual(['application/pdf', 'application/octet-stream', 'application/octet-stream', 'image/svg+xml']);
  });

  it('cleans the client folder name, and falls back to "Client <id>" when nothing is left', async () => {
    const first = setup();
    first.db.prepare('UPDATE clients SET name = ? WHERE id = 1').run('A/B:\u202EC');
    savedFile(first.db, first.dataDir, { waId: 'A', role: 'client' });
    await first.up.run();
    expect(first.drive.folders).toEqual(['Clients', 'A_B_C', 'Files']);

    const second = setup();
    second.db.prepare('UPDATE clients SET name = ? WHERE id = 1').run('\u0001\u200B\u202E');
    savedFile(second.db, second.dataDir, { waId: 'A', role: 'client' });
    await second.up.run();
    expect(second.drive.folders).toEqual(['Clients', 'Client 1', 'Files']);
  });

  it('uploads at most batchSize files per pass (5 by default)', async () => {
    const small = setup({ batchSize: 2 });
    for (const w of ['A', 'B', 'C']) savedFile(small.db, small.dataDir, { waId: w, role: 'client' });
    await small.up.run();
    expect(small.drive.created).toHaveLength(2);
    await small.up.run();
    expect(small.drive.created).toHaveLength(3);

    const dflt = setup();
    for (const w of ['A', 'B', 'C', 'D', 'E', 'F']) savedFile(dflt.db, dflt.dataDir, { waId: w, role: 'client' });
    await dflt.up.run();
    expect(dflt.drive.created).toHaveLength(5);
  });

  it('run() resolves even when the pass itself fails, and the next run() starts a new pass', async () => {
    const { db, dataDir, drive, up } = setup();
    savedFile(db, dataDir, { waId: 'A', role: 'client' });
    const prepare = vi.spyOn(db, 'prepare').mockImplementation(() => {
      throw new Error('database unavailable');
    });
    await expect(up.run()).resolves.toBeUndefined();
    expect(prepare).toHaveBeenCalled();
    prepare.mockRestore();
    await up.run();
    expect(drive.created).toHaveLength(1);
  });

  it('runs one pass at a time', async () => {
    const { db, dataDir, drive, up } = setup();
    savedFile(db, dataDir, { waId: 'A', role: 'client' });
    await Promise.all([up.run(), up.run()]);
    expect(drive.created).toHaveLength(1);
  });

  it('gives up at once when the saved original is missing', async () => {
    const { db, dataDir, up } = setup();
    const a = savedFile(db, dataDir, { waId: 'A', role: 'client' });
    unlinkSync(join(dataDir, 'media', 'SHA', '2026-10', 'A.bin'));
    await up.run();
    expect(driveState(db, a)).toMatchObject({ failed: 1 });
  });

  it('starts nothing after stop()', async () => {
    const { db, dataDir, drive, up } = setup();
    savedFile(db, dataDir, { waId: 'A', role: 'client' });
    await up.stop(1_000);
    await up.run();
    expect(drive.created).toHaveLength(0);
  });

  it('stop() during a pass waits for the upload in flight and starts no further file', async () => {
    const { db, dataDir, drive, up } = setup();
    const a = savedFile(db, dataDir, { waId: 'A', role: 'client' });
    const b = savedFile(db, dataDir, { waId: 'B', role: 'client' });
    let release!: () => void;
    drive.gate = new Promise<void>((r) => (release = r));
    const running = up.run();
    let stopped = false;
    const stopping = up.stop(10_000).then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(stopped).toBe(false); // the first upload is still held at the gate
    release();
    await Promise.all([running, stopping]);
    expect(drive.created).toHaveLength(1);
    expect(getMedia(db, a)!.driveFileId).toBe(drive.created[0]!.id);
    expect(getMedia(db, b)!.driveFileId).toBeNull();
  });

  it('stop() returns after its time limit when an upload never finishes', async () => {
    const { db, dataDir, drive, up } = setup();
    savedFile(db, dataDir, { waId: 'A', role: 'client' });
    let release!: () => void;
    drive.gate = new Promise<void>((r) => (release = r));
    const running = up.run();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      up.stop(50).then(() => 'stopped'),
      new Promise<string>((r) => (timer = setTimeout(() => r('still waiting'), 1_000))),
    ]);
    clearTimeout(timer);
    expect(outcome).toBe('stopped');
    release(); // let the held upload finish so the test leaves nothing running
    await running;
  });
});
