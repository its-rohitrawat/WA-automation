import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { loadTrackerView } from '../../src/output/view.ts';
import { buildWorkbook } from '../../src/output/workbook.ts';
import { insertMessage } from '../../src/store/messages.ts';
import { upsertPerson } from '../../src/store/people.ts';
import { recordPictureMade } from '../../src/store/sourcePictures.ts';
import { createTask, setTaskStatus, type NewTask } from '../../src/store/tasks.ts';
import { NOW, seeded } from '../helpers/db.ts';

const healthy = { ok: true, text: '✅ Connected' };
const now = new Date('2026-11-03T08:00:00Z');
const task = (clientId: number, o: Partial<NewTask> = {}): NewTask => ({
  clientId, side: 'us', title: 'Brighter banner', category: 'design', priority: 'major', assignedTo: null, askedBy: null,
  raisedOn: '2026-11-03', deadline: null, latestProgress: null, sourceQuote: 'banner bright karo', sourceDate: '2026-11-03', sourceWaId: 'w1', origin: 'whatsapp', ...o,
});

async function sheet(o: { dashboardUrl?: string; picture?: boolean; quote?: string; done?: boolean } = {}) {
  const { db, ids } = await seeded();
  await upsertPerson(db, { clientId: ids.sharma, jid: '201111111111111@lid', number: null, name: 'Priya', fromMe: false });
  await insertMessage(db, { waId: 'w1', clientId: ids.sharma, senderJid: 'x@s.whatsapp.net', senderNumber: null, senderName: null, fromMe: false, ts: NOW, text: 'banner', quotedWaId: null, mediaType: null });
  const t = await createTask(db, task(ids.sharma, o.quote ? { sourceQuote: o.quote } : {}), NOW);
  const messageId = (await db.get<{ id: number }>("SELECT id FROM messages WHERE wa_id = 'w1'"))!.id;
  if (o.picture) await recordPictureMade(db, { taskId: t.id, code: t.code, clientId: ids.sharma, messageId, driveFileId: 'PIC123', at: NOW });
  // Done, the task is on the Done table only, whose Closed on column comes before the appended ones.
  if (o.done) await setTaskStatus(db, t.id, 'done', '2026-11-03', NOW, 'human');
  const view = await loadTrackerView(db, now, healthy, o.dashboardUrl ? { dashboardUrl: o.dashboardUrl } : {});
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await buildWorkbook(view)) as unknown as ExcelJS.Buffer);
  const ws = wb.getWorksheet('Sharma Interiors')!;
  let row: ExcelJS.Row | undefined;
  ws.eachRow((r) => {
    if (!row && r.getCell(1).value === t.code) row = r;
  });
  return { ws, row: row!, messageId };
}

describe('the tracker links each task to its chat picture and its chat (11 Nov 2026)', () => {
  it('links the Source cell to the picture and the Chat cell to the message in the dashboard', async () => {
    const { row, messageId } = await sheet({ picture: true, dashboardUrl: 'https://agent.example.com' });
    expect(row.getCell(13).value).toEqual({ text: '"banner bright karo" (3 Nov)', hyperlink: 'https://drive.google.com/file/d/PIC123/view' });
    expect(row.getCell(16).value).toEqual({ text: 'Open', hyperlink: `https://agent.example.com/dashboard/clients?client=SHA&chat=${messageId}` });
  });

  it('keeps the plain quote with no picture yet, and an empty Chat cell with no dashboard address', async () => {
    const { row } = await sheet();
    expect(row.getCell(13).value).toBe('"banner bright karo" (3 Nov)');
    expect(row.getCell(16).value ?? '').toBe('');
  });

  it('with a dashboard address but no picture yet, keeps the plain quote and still links the Chat cell', async () => {
    const { row, messageId } = await sheet({ dashboardUrl: 'https://agent.example.com' });
    expect(row.getCell(13).value).toBe('"banner bright karo" (3 Nov)');
    expect(row.getCell(16).value).toEqual({ text: 'Open', hyperlink: `https://agent.example.com/dashboard/clients?client=SHA&chat=${messageId}` });
  });

  it('on the Done table, the Chat cell is column 17 (Q), after Closed on, Priority level and Sentiment', async () => {
    const { ws, row, messageId } = await sheet({ done: true, picture: true, dashboardUrl: 'https://agent.example.com' });
    const header = ws.getRow(row.number - 1);
    expect([14, 15, 16, 17].map((c) => header.getCell(c).value)).toEqual(['Closed on', 'Priority level', 'Sentiment', 'Chat']);
    expect(row.getCell(13).value).toEqual({ text: '"banner bright karo" (3 Nov)', hyperlink: 'https://drive.google.com/file/d/PIC123/view' });
    expect(row.getCell(17).value).toEqual({ text: 'Open', hyperlink: `https://agent.example.com/dashboard/clients?client=SHA&chat=${messageId}` });
    expect(row.getCell(16).value ?? '').toBe(''); // Sentiment, empty while it is off
  });

  it('shows a tag in the quote as the name, or @member, never the digits', async () => {
    const { row } = await sheet({ quote: '@201111111111111 and @209999999999999 please check' });
    expect(row.getCell(13).value).toBe('"@Priya and @member please check" (3 Nov)');
  });
});
