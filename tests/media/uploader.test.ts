import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DriveFileUploader, FILE_UPLOAD_TIMEOUT_MS, UPLOAD_MAX_ATTEMPTS } from '../../src/media/uploader.ts';
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

function setup(o: { root?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'wa-up-'));
  dirs.push(dataDir);
  const db = seededDb();
  const drive = new FakeDrive();
  const clock = manualClock('2026-10-19T08:00:00Z');
  const onUploaded = vi.fn();
  const up = new DriveFileUploader({ db, api: drive, dataDir, clock, log: silentLogger(), onUploaded });
  if (o.root !== false) setKv(db, 'drive_root_id', 'root-1');
  return { db, dataDir, drive, clock, onUploaded, up };
}

/** A file that a person shared, saved on disk and read. */
function savedFile(
  db: Db,
  dataDir: string,
  o: { waId: string; jid?: string; role?: Role; kind?: MediaKind; fileName?: string | null; mimeType?: string; fromMe?: boolean },
): number {
  const jid = o.jid ?? SHARMA_PN;
  const kind = o.kind ?? 'document';
  const fromMe = o.fromMe ?? false;
  insertMessage(db, { waId: o.waId, clientId: 1, senderJid: jid, senderNumber: null, senderName: 'Mr. Sharma', fromMe, ts: '2026-10-10T08:00:00.000Z', text: null, quotedWaId: null, mediaType: kind });
  upsertPerson(db, { clientId: 1, jid, number: null, name: 'Mr. Sharma', fromMe });
  if (o.role) setRole(db, 1, jid, o.role, 'human');
  const id = insertMedia(db, {
    messageId: messageRowId(db, 1, o.waId)!, clientId: 1, kind, status: 'pending', mimeType: o.mimeType ?? 'application/pdf',
    fileName: o.fileName === undefined ? 'brief.pdf' : o.fileName, fileSize: 9, seconds: null, forwarded: false, refEnc: null, errorCode: null, createdAt: NOW,
  });
  const rel = `media/SHA/2026-10/${o.waId}.bin`;
  mkdirSync(join(dataDir, 'media', 'SHA', '2026-10'), { recursive: true });
  writeFileSync(join(dataDir, ...rel.split('/')), 'pdf-bytes');
  markDownloaded(db, id, { localPath: rel, sha256: 'x', fileSize: 9, at: NOW });
  finishMedia(db, id, { textKind: 'extract', text: 'Brief', pageCount: 1, note: null, at: NOW });
  return id;
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
    for (let i = 1; i < UPLOAD_MAX_ATTEMPTS; i++) {
      clock.advance(7 * 3_600_000);
      await up.run();
    }
    expect(driveState(db, a)).toMatchObject({ attempts: UPLOAD_MAX_ATTEMPTS, failed: 1, nextAt: null });
    expect(resetUploadFailures(db)).toBe(1);
    expect(driveState(db, a)).toMatchObject({ attempts: 0, failed: 0 });
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
});
