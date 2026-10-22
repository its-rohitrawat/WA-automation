import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { loadTrackerView } from '../../src/output/view.ts';
import { buildWorkbook, fileRowHeight } from '../../src/output/workbook.ts';
import type { Db } from '../../src/store/db.ts';
import { CLIENT_FILES_LIMIT, finishMedia, insertMedia, listClientFiles, markUploaded, messageRowId, type MediaKind, type MediaStatus } from '../../src/store/media.ts';
import { applyRevoke, insertMessage } from '../../src/store/messages.ts';
import { setRole, upsertPerson } from '../../src/store/people.ts';
import { NOW, seededDb } from '../helpers/db.ts';
import { RAHUL_PN, SHARMA_PN } from '../helpers/wa.ts';

const FOUNDER = '919800000099@s.whatsapp.net';

function file(
  db: Db,
  o: {
    waId: string; jid: string; name: string; kind: MediaKind; fileName: string | null; mimeType: string; ts: string;
    status?: MediaStatus; errorCode?: string | null; forwarded?: boolean; fromMe?: boolean; seconds?: number | null;
  },
): number {
  insertMessage(db, { waId: o.waId, clientId: 1, senderJid: o.jid, senderNumber: null, senderName: o.name, fromMe: o.fromMe ?? false, ts: o.ts, text: null, quotedWaId: null, mediaType: o.kind });
  return insertMedia(db, {
    messageId: messageRowId(db, 1, o.waId)!, clientId: 1, kind: o.kind, status: o.status ?? 'pending', mimeType: o.mimeType, fileName: o.fileName, fileSize: 24_576,
    seconds: o.seconds ?? null, forwarded: o.forwarded ?? false, refEnc: null, errorCode: o.errorCode ?? null, createdAt: NOW,
  });
}

function seed(): Db {
  const db = seededDb();
  upsertPerson(db, { clientId: 1, jid: SHARMA_PN, number: '919800000001', name: 'Mr. Sharma', fromMe: false });
  setRole(db, 1, SHARMA_PN, 'client', 'human');
  upsertPerson(db, { clientId: 1, jid: RAHUL_PN, number: '919800000002', name: 'Rahul', fromMe: false });
  setRole(db, 1, RAHUL_PN, 'team', 'human');
  // The message carries the sender's own WhatsApp name; the workbook shows the name in People instead.
  const pdf = file(db, { waId: 'D1', jid: SHARMA_PN, name: 'Sharma ji', kind: 'document', fileName: 'brief.pdf', mimeType: 'application/pdf', ts: '2026-10-15T06:00:00.000Z' });
  finishMedia(db, pdf, { textKind: 'extract', text: 'Homepage brief\nHero banner with the new logo', pageCount: 3, note: null, at: NOW });
  markUploaded(db, pdf, 'drivefile123');
  const img = file(db, { waId: 'I1', jid: SHARMA_PN, name: 'Mr. Sharma', kind: 'image', fileName: null, mimeType: 'image/jpeg', ts: '2026-10-16T06:00:00.000Z' });
  finishMedia(db, img, { textKind: 'description', text: 'A payment receipt. Visible text: Paid ₹42,000', pageCount: null, note: null, at: NOW });
  file(db, { waId: 'T1', jid: RAHUL_PN, name: 'Rahul', kind: 'document', fileName: 'team-only.pdf', mimeType: 'application/pdf', ts: '2026-10-17T06:00:00.000Z' });
  file(db, { waId: 'F1', jid: SHARMA_PN, name: 'Mr. Sharma', kind: 'document', fileName: '=HYPERLINK("http://evil")', mimeType: 'application/pdf', ts: '2026-10-14T06:00:00.000Z' });
  return db;
}

const now = new Date('2026-10-19T08:00:00Z');
const healthy = { ok: true, text: '✅ Connected · waiting for new messages' };

async function sheet(db: Db, name: string): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await buildWorkbook(loadTrackerView(db, now, healthy))) as unknown as ExcelJS.Buffer);
  return wb.getWorksheet(name)!;
}

function rowWhere(ws: ExcelJS.Worksheet, pred: (r: ExcelJS.Row) => boolean): ExcelJS.Row {
  let found: ExcelJS.Row | undefined;
  ws.eachRow((r) => {
    if (!found && pred(r)) found = r;
  });
  if (!found) throw new Error('row not found');
  return found;
}

const mediaIdOf = (db: Db, waId: string): number =>
  (db.prepare('SELECT m.id FROM media m JOIN messages msg ON msg.id = m.message_id WHERE msg.wa_id = ?').get(waId) as { id: number }).id;

const sharmaFiles = (db: Db) => loadTrackerView(db, now, healthy).clients.find((c) => c.client.code === 'SHA')!.files;

describe('Files received', () => {
  it('lists files from client members only, newest first, with a description and Drive id', () => {
    expect(sharmaFiles(seed())).toEqual([
      { date: '2026-10-16', sentBy: 'Mr. Sharma', name: 'image-2026-10-16-1130-2.jpg', description: 'A payment receipt. Visible text: Paid ₹42,000', driveFileId: null },
      { date: '2026-10-15', sentBy: 'Mr. Sharma', name: 'brief.pdf', description: 'PDF, 3 pages: Homepage brief Hero banner with the new logo', driveFileId: 'drivefile123' },
      { date: '2026-10-14', sentBy: 'Mr. Sharma', name: '=HYPERLINK(_http___evil_)', description: 'PDF, being read', driveFileId: null },
    ]);
  });

  it('adds the section between Decisions and Done, with Drive links and plain-string names', async () => {
    const ws = await sheet(seed(), 'Sharma Interiors');
    const title = (t: string) => rowWhere(ws, (r) => r.getCell(1).value === t).number;
    expect(title('Decisions')).toBeLessThan(title('Files received'));
    expect(title('Files received')).toBeLessThan(title('Done'));
    const header = ws.getRow(title('Files received') + 1);
    expect([1, 2, 3, 4, 13].map((i) => header.getCell(i).value)).toEqual(['Date', 'Sent by', 'File name', 'Description', 'Drive link']);
    const pdf = rowWhere(ws, (r) => r.getCell(3).value === 'brief.pdf');
    expect(pdf.getCell(1).value).toEqual(new Date(Date.UTC(2026, 9, 15)));
    expect(pdf.getCell(2).value).toBe('Mr. Sharma');
    expect(pdf.getCell(4).value).toBe('PDF, 3 pages: Homepage brief Hero banner with the new logo');
    expect(pdf.getCell(13).value).toMatchObject({ text: 'Open', hyperlink: 'https://drive.google.com/file/d/drivefile123/view' });
    const evil = rowWhere(ws, (r) => r.getCell(3).value === '=HYPERLINK(_http___evil_)');
    expect(evil.getCell(3).type).toBe(ExcelJS.ValueType.String);
    expect(evil.getCell(3).formula).toBeUndefined();
    expect(evil.getCell(13).value).toBeNull();
  });

  it('merges the description over columns D to L, in the header and in every file row (amendment 14a)', async () => {
    const ws = await sheet(seed(), 'Sharma Interiors');
    const header = rowWhere(ws, (r) => r.getCell(1).value === 'Files received').number + 1;
    const merges = (ws.model as unknown as { merges: string[] }).merges;
    for (const r of [header, header + 1, header + 2, header + 3]) {
      expect(merges).toContain(`D${r}:L${r}`);
      expect(ws.getCell(r, 12).master.address).toBe(`D${r}`);
      expect(ws.getCell(r, 13).isMerged).toBe(false);
      expect(ws.getCell(r, 3).isMerged).toBe(false);
    }
    expect(merges.filter((m) => m.startsWith('D'))).toHaveLength(4);
  });

  it('sets each file row tall enough for its wrapped name and description, since merged cells do not auto-fit', async () => {
    const db = seed();
    finishMedia(db, mediaIdOf(db, 'D1'), { textKind: 'extract', text: 'word '.repeat(80), pageCount: 3, note: null, at: NOW });
    const ws = await sheet(db, 'Sharma Interiors');
    const header = rowWhere(ws, (r) => r.getCell(1).value === 'Files received').number + 1;
    // image-2026-10-16-1130-2.jpg and =HYPERLINK(_http___evil_) wrap to 3 lines in column C; the long description to 2 lines.
    expect([1, 2, 3].map((i) => ws.getRow(header + i).height)).toEqual([45, 30, 45]);
  });

  describe('fileRowHeight (D4)', () => {
    const short = { sentBy: 'Mr. Sharma', name: 'brief.pdf', description: 'PDF, 3 pages: Homepage brief' };

    it('keeps a one-line row at the normal height of 15 points', () => {
      expect(fileRowHeight(short)).toBe(15);
      expect(fileRowHeight({ ...short, description: '' })).toBe(15);
    });

    it('adds 15 points per wrapped line of the description, 119 characters to a line across D to L', () => {
      expect(fileRowHeight({ ...short, description: 'x'.repeat(119) })).toBe(15);
      expect(fileRowHeight({ ...short, description: 'x'.repeat(120) })).toBe(30);
      expect(fileRowHeight({ ...short, description: 'word '.repeat(40) })).toBe(30);
      // 400 characters, the most the store hands over, is 4 lines.
      expect(fileRowHeight({ ...short, description: 'word '.repeat(80) })).toBe(60);
    });

    it('counts characters, not UTF-16 units', () => {
      expect(fileRowHeight({ ...short, description: '😀'.repeat(119) })).toBe(15);
    });
  });

  it('gives the workbook row the estimated height, with wrap text on (D4)', async () => {
    const view = loadTrackerView(seed(), now, healthy);
    const files = view.clients.find((c) => c.client.code === 'SHA')!.files;
    const brief = files.find((f) => f.name === 'brief.pdf')!;
    brief.description = 'word '.repeat(80);
    const img = files.find((f) => f.name.startsWith('image-'))!;
    img.name = 'receipt.jpg';
    img.description = 'A payment receipt';
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildWorkbook(view)) as unknown as ExcelJS.Buffer);
    const ws = wb.getWorksheet('Sharma Interiors')!;
    const long = rowWhere(ws, (r) => r.getCell(3).value === 'brief.pdf');
    expect(long.height).toBe(60);
    expect(long.height).toBe(fileRowHeight(brief));
    expect(long.getCell(4).alignment).toMatchObject({ wrapText: true, vertical: 'top' });
    expect(rowWhere(ws, (r) => r.getCell(3).value === 'receipt.jpg').height).toBe(15);
  });

  it('does not link a Drive id that is not a plain id', async () => {
    const db = seed();
    markUploaded(db, mediaIdOf(db, 'F1'), 'abc/../evil?x=1');
    const ws = await sheet(db, 'Sharma Interiors');
    expect(rowWhere(ws, (r) => r.getCell(3).value === '=HYPERLINK(_http___evil_)').getCell(13).value).toBeNull();
  });

  it('shows (none) for a client without files', async () => {
    const ws = await sheet(seed(), 'Mehta Foods');
    const at = rowWhere(ws, (r) => r.getCell(1).value === 'Files received').number;
    expect(ws.getRow(at + 2).getCell(1).value).toBe('(none)');
  });

  it('keeps a file deleted for everyone in the list, with (deleted by sender) and no Drive link (amendment 14b, D3)', () => {
    const db = seed();
    applyRevoke(db, 1, 'D1');
    expect(sharmaFiles(db).find((f) => f.name === 'brief.pdf')).toEqual({
      date: '2026-10-15', sentBy: 'Mr. Sharma', name: 'brief.pdf', description: '(deleted by sender)', driveFileId: null,
    });
    expect(sharmaFiles(db)).toHaveLength(3);
  });

  it('does not link or describe an uploaded file that was then deleted for everyone, but still links other uploaded files (D3)', async () => {
    const db = seed();
    markUploaded(db, mediaIdOf(db, 'I1'), 'driveimage456');
    applyRevoke(db, 1, 'D1');
    const ws = await sheet(db, 'Sharma Interiors');
    const deleted = rowWhere(ws, (r) => r.getCell(3).value === 'brief.pdf');
    expect(deleted.getCell(4).value).toBe('(deleted by sender)');
    expect(deleted.getCell(13).value).toBeNull();
    const kept = rowWhere(ws, (r) => r.getCell(3).value === 'image-2026-10-16-1130-2.jpg');
    expect(kept.getCell(13).value).toMatchObject({ text: 'Open', hyperlink: 'https://drive.google.com/file/d/driveimage456/view' });
    // Nothing in the tab points at the deleted file's Drive copy or shows what it said.
    const texts: string[] = [];
    ws.eachRow((r) => r.eachCell((c) => texts.push(JSON.stringify(c.value))));
    expect(texts.filter((t) => t.includes('drivefile123') || t.includes('Homepage'))).toEqual([]);
  });

  it('says (forwarded image) and (forwarded scanned PDF) for forwarded files that were not described (D2, amendment 14c)', () => {
    const db = seed();
    const img = file(db, { waId: 'FW1', jid: SHARMA_PN, name: 'Mr. Sharma', kind: 'image', fileName: null, mimeType: 'image/jpeg', ts: '2026-10-18T06:00:00.000Z', forwarded: true });
    finishMedia(db, img, { textKind: null, text: null, pageCount: null, note: 'forwarded_not_described', at: NOW });
    const scan = file(db, { waId: 'FW2', jid: SHARMA_PN, name: 'Mr. Sharma', kind: 'document', fileName: 'scan.pdf', mimeType: 'application/pdf', ts: '2026-10-18T05:00:00.000Z', forwarded: true });
    finishMedia(db, scan, { textKind: null, text: null, pageCount: 2, note: 'forwarded_not_described', at: NOW });
    const text = file(db, { waId: 'FW3', jid: SHARMA_PN, name: 'Mr. Sharma', kind: 'document', fileName: 'quote.pdf', mimeType: 'application/pdf', ts: '2026-10-18T04:00:00.000Z', forwarded: true });
    finishMedia(db, text, { textKind: 'extract', text: 'Quotation No. 17', pageCount: 1, note: null, at: NOW });
    expect(sharmaFiles(db).slice(0, 3).map((f) => [f.name, f.description])).toEqual([
      [`image-2026-10-18-1130-${img}.jpg`, '(forwarded image)'],
      ['scan.pdf', '(forwarded scanned PDF)'],
      ['quote.pdf', 'PDF, 1 page: Quotation No. 17'],
    ]);
  });

  it('never lists view-once media, the founder’s own files, stickers, voice notes or audio, but lists videos', () => {
    const db = seed();
    upsertPerson(db, { clientId: 1, jid: FOUNDER, number: '919800000099', name: 'Founder', fromMe: true });
    // Even if the founder's own number is marked client, what the founder sent is never listed.
    setRole(db, 1, FOUNDER, 'client', 'human');
    file(db, { waId: 'VO1', jid: SHARMA_PN, name: 'Mr. Sharma', kind: 'image', fileName: null, mimeType: 'image/jpeg', ts: '2026-10-18T06:00:00.000Z', status: 'metadata', errorCode: 'view_once' });
    file(db, { waId: 'ME1', jid: FOUNDER, name: 'Founder', kind: 'document', fileName: 'mine.pdf', mimeType: 'application/pdf', ts: '2026-10-18T06:00:00.000Z', fromMe: true });
    file(db, { waId: 'ST1', jid: SHARMA_PN, name: 'Mr. Sharma', kind: 'sticker', fileName: null, mimeType: 'image/webp', ts: '2026-10-18T06:00:00.000Z', status: 'metadata' });
    file(db, { waId: 'VN1', jid: SHARMA_PN, name: 'Mr. Sharma', kind: 'voice', fileName: null, mimeType: 'audio/ogg', ts: '2026-10-18T06:00:00.000Z' });
    file(db, { waId: 'AU1', jid: SHARMA_PN, name: 'Mr. Sharma', kind: 'audio', fileName: 'song.mp3', mimeType: 'audio/mpeg', ts: '2026-10-18T06:00:00.000Z' });
    const video = file(db, { waId: 'VI1', jid: SHARMA_PN, name: 'Mr. Sharma', kind: 'video', fileName: null, mimeType: 'video/mp4', ts: '2026-10-18T07:00:00.000Z', status: 'metadata', seconds: 42 });
    const files = sharmaFiles(db);
    expect(files.map((f) => f.name)).toEqual([`video-2026-10-18-1230-${video}.mp4`, 'image-2026-10-16-1130-2.jpg', 'brief.pdf', '=HYPERLINK(_http___evil_)']);
    expect(files[0]!.description).toBe('Video, 0:42 (not downloaded)');
  });

  it('uses a person’s role in the file’s own client only', () => {
    const db = seed();
    // Rahul is team in Sharma but a client in Mehta; Mr. Sharma is a client in both.
    upsertPerson(db, { clientId: 2, jid: RAHUL_PN, number: '919800000002', name: 'Rahul', fromMe: false });
    setRole(db, 2, RAHUL_PN, 'client', 'human');
    upsertPerson(db, { clientId: 2, jid: SHARMA_PN, number: '919800000001', name: 'Mr. Sharma', fromMe: false });
    setRole(db, 2, SHARMA_PN, 'client', 'human');
    const files = sharmaFiles(db);
    expect(files.some((f) => f.name === 'team-only.pdf')).toBe(false);
    expect(files.map((f) => f.name)).toEqual(['image-2026-10-16-1130-2.jpg', 'brief.pdf', '=HYPERLINK(_http___evil_)']);
  });

  it('lists files sent at the same moment with the later one first', () => {
    const db = seed();
    const ts = '2026-10-18T06:00:00.000Z';
    const first = file(db, { waId: 'S1', jid: SHARMA_PN, name: 'Mr. Sharma', kind: 'document', fileName: 'first.pdf', mimeType: 'application/pdf', ts });
    const second = file(db, { waId: 'S2', jid: SHARMA_PN, name: 'Mr. Sharma', kind: 'document', fileName: 'second.pdf', mimeType: 'application/pdf', ts });
    expect(second).toBeGreaterThan(first);
    expect(sharmaFiles(db).slice(0, 2).map((f) => f.name)).toEqual(['second.pdf', 'first.pdf']);
  });

  it('shows at most the newest CLIENT_FILES_LIMIT files in the client tab', () => {
    const db = seed();
    for (let i = 0; i < CLIENT_FILES_LIMIT - 2; i++) {
      const ts = new Date(Date.UTC(2026, 9, 18, 0, 0, i)).toISOString();
      file(db, { waId: `N${i}`, jid: SHARMA_PN, name: 'Mr. Sharma', kind: 'document', fileName: `n${i}.pdf`, mimeType: 'application/pdf', ts });
    }
    const files = sharmaFiles(db);
    expect(files).toHaveLength(CLIENT_FILES_LIMIT);
    expect(files.at(-1)!.name).toBe('brief.pdf');
  });

  it('includes earlier files of someone who becomes a client', () => {
    const db = seed();
    expect(sharmaFiles(db).some((f) => f.name === 'team-only.pdf')).toBe(false);
    setRole(db, 1, RAHUL_PN, 'client', 'human');
    expect(sharmaFiles(db)[0]).toMatchObject({ name: 'team-only.pdf', sentBy: 'Rahul', description: 'PDF, being read' });
  });

  it('reads only the start of a long text from the store', () => {
    const db = seed();
    finishMedia(db, mediaIdOf(db, 'D1'), { textKind: 'extract', text: 'z'.repeat(5_000), pageCount: 3, note: null, at: NOW });
    const row = listClientFiles(db, 1).find((f) => f.fileName === 'brief.pdf')!;
    expect(row.textStart).toBe('z'.repeat(400));
    expect(row.revoked).toBe(false);
  });

  it('limits the list to the newest files', () => {
    expect(listClientFiles(seed(), 1, 2).map((f) => f.fileName)).toEqual([null, 'brief.pdf']);
  });

  it('keeps the workbook readable when a file name, file text or sender name holds characters XML does not allow', async () => {
    const db = seed();
    upsertPerson(db, { clientId: 1, jid: SHARMA_PN, number: null, name: 'Mr.\uFFFF Sharma', fromMe: false });
    const id = file(db, { waId: 'X1', jid: SHARMA_PN, name: 'Mr. Sharma', kind: 'document', fileName: 'a\uFFFF.pdf', mimeType: 'application/pdf', ts: '2026-10-18T06:00:00.000Z' });
    finishMedia(db, id, { textKind: 'extract', text: 'Paid\uFFFE amount \u202E000,24', pageCount: 1, note: null, at: NOW });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildWorkbook(loadTrackerView(db, now, healthy))) as unknown as ExcelJS.Buffer);
    const ws = wb.getWorksheet('Sharma Interiors')!;
    const row = rowWhere(ws, (r) => r.getCell(3).value === 'a.pdf');
    expect(row.getCell(2).value).toBe('Mr. Sharma');
    expect(row.getCell(4).value).toBe('PDF, 1 page: Paid amount 000,24');
    const strings: string[] = [];
    wb.eachSheet((s) => s.eachRow((r) => r.eachCell((c) => strings.push(String(c.text)))));
    expect(strings.filter((t) => /[\uFFFE\uFFFF]/.test(t))).toEqual([]);
  });
});
