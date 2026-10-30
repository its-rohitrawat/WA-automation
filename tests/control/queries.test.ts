import { describe, expect, it } from 'vitest';
import { overview } from '../../src/control/queries.ts';
import { finishBatch, startBatch } from '../../src/store/batches.ts';
import { syncClients } from '../../src/store/clients.ts';
import type { Db } from '../../src/store/db.ts';
import { insertFound } from '../../src/store/meetings.ts';
import { createTask, recordEvent } from '../../src/store/tasks.ts';
import { MEHTA, NOW, seededDb, SHARMA } from '../helpers/db.ts';
import { rawOf } from '../../src/store/engine/sqlite.ts';

// 13:30 IST on Monday 19 Oct.
const now = new Date(NOW);

async function task(db: Db, clientId: number, o: { status?: 'open' | 'maybe_done' | 'done'; deadline?: string; closedOn?: string } = {}) {
  const t = await createTask(db, { clientId, side: 'us', title: 'Task', category: 'design', priority: 'medium', assignedTo: null, askedBy: null, raisedOn: '2026-10-01',
    deadline: o.deadline ?? null, latestProgress: null, sourceQuote: null, sourceDate: null, sourceWaId: null, origin: 'whatsapp' }, NOW);
  rawOf(db).prepare('UPDATE tasks SET status = ?, closed_on = ? WHERE id = ?').run(o.status ?? 'open', o.closedOn ?? null, t.id);
  return t;
}

let n = 0;
async function meeting(db: Db, startedAt: string, title = `Meeting ${++n}`): Promise<number> {
  return (await insertFound(db, {
    recording: `conferenceRecords/o${n}/recordings/r`, conference: `conferenceRecords/o${n}`, driveFileId: `d${n}`, meetingCode: null, title,
    startedAt, endedAt: null, attendees: [], participants: [], clientId: 1, matchKind: 'title', status: 'queued', driveSeconds: 1800, createdAt: NOW,
  }))!;
}

describe('overview', () => {
  it('counts active clients and the four task numbers, split as the Tasks screen splits them', async () => {
    const db = await seededDb();
    await task(db, 1); // open
    await task(db, 1, { deadline: '2026-10-18' }); // overdue
    await task(db, 1, { status: 'maybe_done', deadline: '2026-10-18' }); // overdue (not review)
    await task(db, 1, { status: 'maybe_done' }); // review
    await task(db, 2, { status: 'done', closedOn: '2026-10-13' }); // done this week (6 days ago)
    await task(db, 2, { status: 'done', closedOn: '2026-10-12' }); // 7 days ago: not this week
    expect(await overview(db, now)).toMatchObject({ clients: 2, tasks: { open: 1, overdue: 2, review: 1, doneThisWeek: 1 } });
  });

  it('dates overdue by the IST day at the midnight edges', async () => {
    const db = await seededDb();
    await task(db, 1, { deadline: '2026-10-19' });
    expect((await overview(db, new Date('2026-10-19T18:29:00Z'))).tasks).toMatchObject({ overdue: 0, open: 1 }); // 23:59 IST on the 19th
    expect((await overview(db, new Date('2026-10-19T18:30:00Z'))).tasks).toMatchObject({ overdue: 1, open: 0 }); // 00:00 IST on the 20th
  });

  it('leaves inactive clients and their tasks out', async () => {
    const db = await seededDb();
    await task(db, 1);
    await task(db, 2, { deadline: '2026-10-01' });
    await syncClients(db, [SHARMA]); // Mehta leaves the allow-list
    const o = await overview(db, now);
    expect(o.clients).toBe(1);
    expect(o.tasks).toEqual({ open: 1, overdue: 0, review: 0, doneThisWeek: 0 });
    expect(o.byClient.map((c) => c.client.code)).toEqual(['SHA']);
  });

  it('gives each active client its segments in the agreed stack order: overdue, open, review, done', async () => {
    const db = await seededDb();
    await syncClients(db, [SHARMA, MEHTA, { ...SHARMA, groupId: '120363000000000003@g.us', code: 'AAA', name: 'Aarav Tiles' }]);
    await task(db, 1, { deadline: '2026-10-01' });
    await task(db, 1);
    await task(db, 1);
    await task(db, 1, { status: 'maybe_done' });
    await task(db, 1, { status: 'done', closedOn: '2026-10-19' });
    expect((await overview(db, now)).byClient).toEqual([
      { client: { code: 'AAA', name: 'Aarav Tiles' }, segments: [{ key: 'overdue', count: 0 }, { key: 'open', count: 0 }, { key: 'review', count: 0 }, { key: 'done', count: 0 }] },
      { client: { code: 'MEH', name: 'Mehta Foods' }, segments: [{ key: 'overdue', count: 0 }, { key: 'open', count: 0 }, { key: 'review', count: 0 }, { key: 'done', count: 0 }] },
      { client: { code: 'SHA', name: 'Sharma Interiors' }, segments: [{ key: 'overdue', count: 1 }, { key: 'open', count: 2 }, { key: 'review', count: 1 }, { key: 'done', count: 1 }] },
    ]);
  });

  it('lists the latest 4 meetings, newest first, with their plain status', async () => {
    const db = await seededDb();
    const ids: number[] = [];
    for (const d of ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14']) ids.push(await meeting(db, `${d}T05:00:00.000Z`));
    const m = (await overview(db, now)).meetings;
    expect(m.map((x) => x.id)).toEqual(ids.slice(1).reverse());
    expect(m[0]).toEqual({ id: ids[4], title: expect.any(String), status: 'queued', stageLabel: 'Downloading the recording', when: '2026-10-14T05:00:00.000Z', minutes: 30 });
  });

  it('merges the latest 5 activity items from batches and task events only, newest first', async () => {
    const db = await seededDb();
    const t = await task(db, 1);
    const at = (m: number) => `2026-10-19T05:0${m}:00.000Z`;
    for (const i of [0, 2, 4]) {
      const b = await startBatch(db, 1, i + 1, at(i));
      await finishBatch(db, b, { status: 'ok', errorCode: null, accepted: 0, rejected: 0, at: at(i) });
    }
    for (const i of [1, 3, 5]) await recordEvent(db, { taskId: t.id, clientId: 1, actor: 'ai', op: 'update_task', detail: {}, reason: null, sourceIds: [], at: at(i) });
    await meeting(db, at(6)); // never in the Overview's activity
    rawOf(db).prepare("UPDATE meetings SET updated_at = ? WHERE id = 1").run(at(9));
    rawOf(db).prepare("INSERT INTO audit_log (at, actor, event, kind, detail) VALUES (?, 'agent', 'tracker.published', 'ops', 'x')").run(at(8));
    const a = (await overview(db, now)).activity;
    expect(a.map((x) => x.id)).toEqual(['e:3', 'b:3', 'e:2', 'b:2', 'e:1']);
  });

  it('gives the last upload and the health line for the tracker card', async () => {
    const db = await seededDb();
    rawOf(db).prepare("INSERT INTO audit_log (at, actor, event, kind, detail) VALUES ('2026-10-19T07:00:00.000Z', 'agent', 'tracker.published', 'ops', 'x')").run();
    expect((await overview(db, now)).tracker).toEqual({ lastPublishedAt: '2026-10-19T07:00:00.000Z', health: null });
    const health = { line: { ok: true, text: '✅ Connected' }, lastPublishedAt: '2026-10-19T07:30:00.000Z', publishFailingSince: null };
    expect((await overview(db, now, health)).tracker).toEqual({ lastPublishedAt: '2026-10-19T07:30:00.000Z', health: { ok: true, text: '✅ Connected' } });
  });
});
