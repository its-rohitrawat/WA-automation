import { describe, expect, it } from 'vitest';
import { insertMessage } from '../../src/store/messages.ts';
import { picturesDue, PICTURE_TRIES, recordPictureFailed, recordPictureMade, sourceLinks } from '../../src/store/sourcePictures.ts';
import { createTask, setTaskStatus, type NewTask } from '../../src/store/tasks.ts';
import { NOW, seeded } from '../helpers/db.ts';

const task = (clientId: number, sourceWaId: string | null, o: Partial<NewTask> = {}): NewTask => ({
  clientId, side: 'us', title: 'Brighter banner', category: 'design', priority: 'major', assignedTo: null, askedBy: null,
  raisedOn: '2026-11-03', deadline: null, latestProgress: null, sourceQuote: 'banner bright karo', sourceDate: '2026-11-03',
  sourceWaId, origin: 'whatsapp', ...o,
});

async function fixture() {
  const { db, ids } = await seeded();
  for (const w of ['w1', 'w2', 'w3']) {
    await insertMessage(db, { waId: w, clientId: ids.sharma, senderJid: '919800000002@s.whatsapp.net', senderNumber: null, senderName: 'Rahul', fromMe: false, ts: NOW, text: w, quotedWaId: null, mediaType: null });
  }
  const msg = async (w: string) => (await db.get<{ id: number }>('SELECT id FROM messages WHERE client_id = ? AND wa_id = ?', [ids.sharma, w]))!.id;
  const a = await createTask(db, task(ids.sharma, 'w1'), '2026-11-03T05:00:00.000Z');
  const b = await createTask(db, task(ids.sharma, 'w2'), '2026-11-03T06:00:00.000Z');
  const done = await createTask(db, task(ids.sharma, 'w3'), '2026-11-03T07:00:00.000Z');
  await setTaskStatus(db, done.id, 'done', '2026-11-03', NOW, 'human');
  await createTask(db, task(ids.sharma, null, { origin: 'human' }), NOW); // no source message
  await createTask(db, task(ids.sharma, 'never-stored'), NOW); // its message is not stored
  return { db, ids, a, b, msg };
}

describe('the chat pictures store (11 Nov 2026)', () => {
  it('lists open tasks with a stored source and no picture, newest first, at most limit', async () => {
    const { db, a, b, msg } = await fixture();
    const now = new Date(NOW);
    expect(await picturesDue(db, now, 10)).toEqual([
      { taskId: b.id, code: b.code, clientId: b.clientId, messageId: await msg('w2') },
      { taskId: a.id, code: a.code, clientId: a.clientId, messageId: await msg('w1') },
    ]);
    expect((await picturesDue(db, now, 1)).map((d) => d.taskId)).toEqual([b.id]);
  });

  it('a made picture leaves the list and links from the tracker; a changed source brings the task back', async () => {
    const { db, a, b, msg } = await fixture();
    const [first] = await picturesDue(db, new Date(NOW), 1);
    await recordPictureMade(db, { ...first!, driveFileId: 'file-1', at: NOW });
    expect((await picturesDue(db, new Date(NOW), 10)).map((d) => d.taskId)).toEqual([a.id]);
    expect((await sourceLinks(db)).get(b.id)).toEqual({ messageId: await msg('w2'), driveFileId: 'file-1' });
    expect((await sourceLinks(db)).get(a.id)).toEqual({ messageId: await msg('w1'), driveFileId: null });
    await db.run("UPDATE tasks SET source_wa_id = 'w3' WHERE id = ?", [b.id]);
    expect((await sourceLinks(db)).get(b.id)).toEqual({ messageId: await msg('w3'), driveFileId: null }); // the old picture is stale
    expect((await picturesDue(db, new Date(NOW), 10)).map((d) => d.taskId)).toEqual([b.id, a.id]);
  });

  it('a failure waits 10 minutes before it is tried again, and stops after PICTURE_TRIES', async () => {
    const { db, a, b } = await fixture();
    const t0 = new Date(NOW).getTime();
    const due = await picturesDue(db, new Date(t0), 10);
    const bDue = due.find((d) => d.taskId === b.id)!;
    await recordPictureFailed(db, { ...bDue, errorCode: 'ECONNRESET', at: new Date(t0).toISOString() });
    expect((await picturesDue(db, new Date(t0 + 5 * 60_000), 10)).map((d) => d.taskId)).toEqual([a.id]);
    expect((await picturesDue(db, new Date(t0 + 11 * 60_000), 10)).map((d) => d.taskId)).toEqual([b.id, a.id]);
    for (let i = 1; i < PICTURE_TRIES; i++) await recordPictureFailed(db, { ...bDue, errorCode: 'ECONNRESET', at: new Date(t0).toISOString() });
    expect((await picturesDue(db, new Date(t0 + 60 * 60_000), 10)).map((d) => d.taskId)).toEqual([a.id]);
    expect(await db.get('SELECT error_code AS code, attempts FROM source_pictures WHERE task_id = ?', [b.id])).toEqual({ code: 'ECONNRESET', attempts: PICTURE_TRIES });
  });

  it('never lists another client’s message for a task', async () => {
    const { db, ids } = await fixture();
    await insertMessage(db, { waId: 'm-mehta', clientId: ids.mehta, senderJid: 'x@s.whatsapp.net', senderNumber: null, senderName: null, fromMe: false, ts: NOW, text: 'x', quotedWaId: null, mediaType: null });
    await createTask(db, task(ids.sharma, 'm-mehta'), NOW); // a Sharma task naming Mehta's message id
    const due = await picturesDue(db, new Date(NOW), 10);
    expect(due.every((d) => d.clientId === ids.sharma)).toBe(true);
    expect(due).toHaveLength(2);
  });
});
