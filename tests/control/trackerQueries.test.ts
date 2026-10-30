import { describe, expect, it } from 'vitest';
import { trackerSummary } from '../../src/control/trackerQueries.ts';
import { TRACKER_ID_KEY, TRACKER_NEW_FILE_KEY } from '../../src/output/trackerKey.ts';
import { syncClients } from '../../src/store/clients.ts';
import type { Db } from '../../src/store/db.ts';
import { setKv } from '../../src/store/kv.ts';
import { createTask } from '../../src/store/tasks.ts';
import { MEHTA, NOW, seededDb, SHARMA } from '../helpers/db.ts';

// 13:30 IST on Monday 19 Oct.
const now = new Date(NOW);
const ID = '1AbCdEfGhIjKlMnOp_qr-st';

async function task(db: Db, clientId: number, o: { status?: 'open' | 'maybe_done' | 'done'; deadline?: string; closedOn?: string } = {}) {
  const t = await createTask(db, { clientId, side: 'us', title: 'x', category: 'design', priority: 'medium', assignedTo: null, askedBy: null, raisedOn: '2026-10-01',
    deadline: o.deadline ?? null, latestProgress: null, sourceQuote: null, sourceDate: null, sourceWaId: null, origin: 'whatsapp' }, NOW);
  db.raw.prepare('UPDATE tasks SET status = ?, closed_on = ? WHERE id = ?').run(o.status ?? 'open', o.closedOn ?? null, t.id);
}

function audit(db: Db, at: string, event: string, detail: string) {
  db.raw.prepare("INSERT INTO audit_log (at, actor, event, kind, detail) VALUES (?, 'agent', ?, 'ops', ?)").run(at, event, detail);
}

describe('trackerSummary', () => {
  it('says the tracker is not uploaded while no Drive id is stored, or the stored one is not a Drive id', async () => {
    const db = await seededDb();
    expect(await trackerSummary(db, now)).toMatchObject({ uploaded: false, url: null });
    for (const bad of ['short', 'https://evil.example/x', '1AbCdEfGhIj/../x', '1AbCdEfGhIj?x=1']) {
      setKv(db, TRACKER_ID_KEY, bad);
      expect(await trackerSummary(db, now), bad).toMatchObject({ uploaded: false, url: null });
    }
  });

  it('links the workbook from the stored Drive id', async () => {
    const db = await seededDb();
    setKv(db, TRACKER_ID_KEY, ID);
    expect(await trackerSummary(db, now)).toMatchObject({ uploaded: true, url: `https://drive.google.com/file/d/${ID}/view` });
  });

  it('names the file it writes: Tracker.xlsx in the WA Agent folder, and the main account when its email is known', async () => {
    const db = await seededDb();
    expect(await trackerSummary(db, now)).toMatchObject({ file: { name: 'Tracker.xlsx', folder: 'WA Agent', account: null }, newFileAt: null });
    setKv(db, 'google_account_email:main', 'owner@example.com');
    setKv(db, 'google_account_email:org2', 'meetings@example.org');
    expect((await trackerSummary(db, now)).file).toEqual({ name: 'Tracker.xlsx', folder: 'WA Agent', account: 'owner@example.com' });
  });

  it('carries the date a new tracker file had to be started, when one was', async () => {
    const db = await seededDb();
    setKv(db, TRACKER_NEW_FILE_KEY, '2026-10-28T05:00:00.000Z');
    expect((await trackerSummary(db, now)).newFileAt).toBe('2026-10-28T05:00:00.000Z');
    setKv(db, TRACKER_NEW_FILE_KEY, 'not a date');
    expect((await trackerSummary(db, now)).newFileAt).toBeNull();
  });

  it('counts Today (active clients) and each active client in tab order, using the workbook sheet names', async () => {
    const db = await seededDb();
    syncClients(db, [SHARMA, MEHTA, { ...SHARMA, groupId: '120363000000000003@g.us', code: 'SHB' }]); // a second "Sharma Interiors"
    await task(db, 1); // open
    await task(db, 1, { deadline: '2026-10-18' }); // overdue
    await task(db, 1, { status: 'maybe_done', deadline: '2026-10-18' }); // overdue, not review
    await task(db, 1, { status: 'maybe_done' }); // review
    await task(db, 1, { status: 'done', closedOn: '2026-10-13' }); // done 6 days ago: this week
    await task(db, 1, { status: 'done', closedOn: '2026-10-12' }); // 7 days ago: not
    await task(db, 2, { status: 'done', closedOn: '2026-10-19' });
    await task(db, 3);
    expect((await trackerSummary(db, now)).sheets).toEqual([
      { name: 'Today', client: null, notDone: 5, overdue: 2, review: 1, doneThisWeek: 2 },
      { name: 'Mehta Foods', client: { code: 'MEH', name: 'Mehta Foods' }, notDone: 0, overdue: 0, review: 0, doneThisWeek: 1 },
      { name: 'Sharma Interiors', client: { code: 'SHA', name: 'Sharma Interiors' }, notDone: 4, overdue: 2, review: 1, doneThisWeek: 1 },
      { name: 'Sharma Interiors (2)', client: { code: 'SHB', name: 'Sharma Interiors' }, notDone: 1, overdue: 0, review: 0, doneThisWeek: 0 },
    ]);
  });

  it('leaves inactive clients out of Today and the list, without moving the others\' sheet names', async () => {
    const db = await seededDb();
    syncClients(db, [SHARMA, MEHTA, { ...SHARMA, groupId: '120363000000000003@g.us', code: 'SHB' }]);
    await task(db, 1);
    syncClients(db, [MEHTA, { ...SHARMA, groupId: '120363000000000003@g.us', code: 'SHB' }]); // SHA leaves the allow-list
    expect((await trackerSummary(db, now)).sheets).toEqual([
      { name: 'Today', client: null, notDone: 0, overdue: 0, review: 0, doneThisWeek: 0 },
      { name: 'Mehta Foods', client: { code: 'MEH', name: 'Mehta Foods' }, notDone: 0, overdue: 0, review: 0, doneThisWeek: 0 },
      { name: 'Sharma Interiors (2)', client: { code: 'SHB', name: 'Sharma Interiors' }, notDone: 0, overdue: 0, review: 0, doneThisWeek: 0 },
    ]);
  });

  it('reports the last upload and the last failure with its plain reason, and the health line', async () => {
    const db = await seededDb();
    expect(await trackerSummary(db, now)).toMatchObject({ lastPublishedAt: null, lastFailure: null, failingSince: null, health: null });
    audit(db, '2026-10-19T06:00:00.000Z', 'tracker.published', 'Tracker.xlsx uploaded to Drive');
    audit(db, '2026-10-19T07:00:00.000Z', 'tracker.publish_failed', 'Tracker upload failed: Google sign-in expired');
    audit(db, '2026-10-19T05:00:00.000Z', 'tracker.published', 'Tracker.xlsx uploaded to Drive');
    expect(await trackerSummary(db, now, {
      line: { ok: false, text: '❌ Google sign-in expired' }, lastPublishedAt: null, publishFailingSince: '2026-10-19T07:00:00.000Z',
    })).toMatchObject({
      lastPublishedAt: '2026-10-19T06:00:00.000Z',
      lastFailure: { at: '2026-10-19T07:00:00.000Z', reason: 'Google sign-in expired' },
      failingSince: '2026-10-19T07:00:00.000Z',
      health: { ok: false, text: '❌ Google sign-in expired' },
    });
  });

  it('takes the later of the health snapshot and the audit log for the last upload', async () => {
    const db = await seededDb();
    audit(db, '2026-10-19T06:00:00.000Z', 'tracker.published', 'x');
    const health = { line: { ok: true, text: '✅' }, lastPublishedAt: '2026-10-19T07:30:00.000Z', publishFailingSince: null };
    expect((await trackerSummary(db, now, health)).lastPublishedAt).toBe('2026-10-19T07:30:00.000Z');
    expect((await trackerSummary(db, now, { ...health, lastPublishedAt: '2026-10-19T05:00:00.000Z' })).lastPublishedAt).toBe('2026-10-19T06:00:00.000Z');
  });
});

describe('trackerSummary review fixes', () => {
  it('counts a task due today as open, not overdue', async () => {
    const db = await seededDb();
    await task(db, 1, { deadline: '2026-10-19' });
    expect((await trackerSummary(db, now)).sheets[0]).toMatchObject({ notDone: 1, overdue: 0 });
  });

  it('takes the newest failure, and ignores tracker rows not written by the agent', async () => {
    const db = await seededDb();
    audit(db, '2026-10-19T05:00:00.000Z', 'tracker.publish_failed', 'Tracker upload failed: Drive did not accept the upload');
    audit(db, '2026-10-19T07:00:00.000Z', 'tracker.publish_failed', 'Tracker upload failed: Google sign-in expired');
    audit(db, '2026-10-19T06:00:00.000Z', 'tracker.publish_failed', 'Tracker upload failed: the workbook could not be built');
    const owner = db.raw.prepare("INSERT INTO audit_log (at, actor, event, kind, detail) VALUES (?, 'owner@example.com', ?, 'ops', 'x')");
    owner.run('2026-10-19T09:00:00.000Z', 'tracker.published');
    owner.run('2026-10-19T09:00:00.000Z', 'tracker.publish_failed');
    expect(await trackerSummary(db, now)).toMatchObject({ lastPublishedAt: null, lastFailure: { at: '2026-10-19T07:00:00.000Z', reason: 'Google sign-in expired' } });
  });
});
