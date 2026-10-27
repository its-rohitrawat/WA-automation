import { describe, expect, it } from 'vitest';
import { trackerSummary } from '../../src/control/trackerQueries.ts';
import { TRACKER_ID_KEY } from '../../src/output/trackerKey.ts';
import { syncClients } from '../../src/store/clients.ts';
import type { Db } from '../../src/store/db.ts';
import { setKv } from '../../src/store/kv.ts';
import { createTask } from '../../src/store/tasks.ts';
import { MEHTA, NOW, seededDb, SHARMA } from '../helpers/db.ts';

// 13:30 IST on Monday 19 Oct.
const now = new Date(NOW);
const ID = '1AbCdEfGhIjKlMnOp_qr-st';

function task(db: Db, clientId: number, o: { status?: 'open' | 'maybe_done' | 'done'; deadline?: string; closedOn?: string } = {}) {
  const t = createTask(db, { clientId, side: 'us', title: 'x', category: 'design', priority: 'medium', assignedTo: null, askedBy: null, raisedOn: '2026-10-01',
    deadline: o.deadline ?? null, latestProgress: null, sourceQuote: null, sourceDate: null, sourceWaId: null, origin: 'whatsapp' }, NOW);
  db.prepare('UPDATE tasks SET status = ?, closed_on = ? WHERE id = ?').run(o.status ?? 'open', o.closedOn ?? null, t.id);
}

function audit(db: Db, at: string, event: string, detail: string) {
  db.prepare("INSERT INTO audit_log (at, actor, event, kind, detail) VALUES (?, 'agent', ?, 'ops', ?)").run(at, event, detail);
}

describe('trackerSummary', () => {
  it('says the tracker is not uploaded while no Drive id is stored, or the stored one is not a Drive id', () => {
    const db = seededDb();
    expect(trackerSummary(db, now)).toMatchObject({ uploaded: false, url: null });
    for (const bad of ['short', 'https://evil.example/x', '1AbCdEfGhIj/../x', '1AbCdEfGhIj?x=1']) {
      setKv(db, TRACKER_ID_KEY, bad);
      expect(trackerSummary(db, now), bad).toMatchObject({ uploaded: false, url: null });
    }
  });

  it('links the workbook from the stored Drive id', () => {
    const db = seededDb();
    setKv(db, TRACKER_ID_KEY, ID);
    expect(trackerSummary(db, now)).toMatchObject({ uploaded: true, url: `https://drive.google.com/file/d/${ID}/view` });
  });

  it('counts Today (active clients) and each active client in tab order, using the workbook sheet names', () => {
    const db = seededDb();
    syncClients(db, [SHARMA, MEHTA, { ...SHARMA, groupId: '120363000000000003@g.us', code: 'SHB' }]); // a second "Sharma Interiors"
    task(db, 1); // open
    task(db, 1, { deadline: '2026-10-18' }); // overdue
    task(db, 1, { status: 'maybe_done', deadline: '2026-10-18' }); // overdue, not review
    task(db, 1, { status: 'maybe_done' }); // review
    task(db, 1, { status: 'done', closedOn: '2026-10-13' }); // done 6 days ago: this week
    task(db, 1, { status: 'done', closedOn: '2026-10-12' }); // 7 days ago: not
    task(db, 2, { status: 'done', closedOn: '2026-10-19' });
    task(db, 3);
    expect(trackerSummary(db, now).sheets).toEqual([
      { name: 'Today', client: null, notDone: 5, overdue: 2, review: 1, doneThisWeek: 2 },
      { name: 'Mehta Foods', client: { code: 'MEH', name: 'Mehta Foods' }, notDone: 0, overdue: 0, review: 0, doneThisWeek: 1 },
      { name: 'Sharma Interiors', client: { code: 'SHA', name: 'Sharma Interiors' }, notDone: 4, overdue: 2, review: 1, doneThisWeek: 1 },
      { name: 'Sharma Interiors (2)', client: { code: 'SHB', name: 'Sharma Interiors' }, notDone: 1, overdue: 0, review: 0, doneThisWeek: 0 },
    ]);
  });

  it('leaves inactive clients out of Today and the list, without moving the others\' sheet names', () => {
    const db = seededDb();
    syncClients(db, [SHARMA, MEHTA, { ...SHARMA, groupId: '120363000000000003@g.us', code: 'SHB' }]);
    task(db, 1);
    syncClients(db, [MEHTA, { ...SHARMA, groupId: '120363000000000003@g.us', code: 'SHB' }]); // SHA leaves the allow-list
    expect(trackerSummary(db, now).sheets).toEqual([
      { name: 'Today', client: null, notDone: 0, overdue: 0, review: 0, doneThisWeek: 0 },
      { name: 'Mehta Foods', client: { code: 'MEH', name: 'Mehta Foods' }, notDone: 0, overdue: 0, review: 0, doneThisWeek: 0 },
      { name: 'Sharma Interiors (2)', client: { code: 'SHB', name: 'Sharma Interiors' }, notDone: 0, overdue: 0, review: 0, doneThisWeek: 0 },
    ]);
  });

  it('reports the last upload and the last failure with its plain reason, and the health line', () => {
    const db = seededDb();
    expect(trackerSummary(db, now)).toMatchObject({ lastPublishedAt: null, lastFailure: null, failingSince: null, health: null });
    audit(db, '2026-10-19T06:00:00.000Z', 'tracker.published', 'Tracker.xlsx uploaded to Drive');
    audit(db, '2026-10-19T07:00:00.000Z', 'tracker.publish_failed', 'Tracker upload failed: Google sign-in expired');
    audit(db, '2026-10-19T05:00:00.000Z', 'tracker.published', 'Tracker.xlsx uploaded to Drive');
    expect(trackerSummary(db, now, {
      line: { ok: false, text: '❌ Google sign-in expired' }, lastPublishedAt: null, publishFailingSince: '2026-10-19T07:00:00.000Z',
    })).toMatchObject({
      lastPublishedAt: '2026-10-19T06:00:00.000Z',
      lastFailure: { at: '2026-10-19T07:00:00.000Z', reason: 'Google sign-in expired' },
      failingSince: '2026-10-19T07:00:00.000Z',
      health: { ok: false, text: '❌ Google sign-in expired' },
    });
  });

  it('takes the later of the health snapshot and the audit log for the last upload', () => {
    const db = seededDb();
    audit(db, '2026-10-19T06:00:00.000Z', 'tracker.published', 'x');
    const health = { line: { ok: true, text: '✅' }, lastPublishedAt: '2026-10-19T07:30:00.000Z', publishFailingSince: null };
    expect(trackerSummary(db, now, health).lastPublishedAt).toBe('2026-10-19T07:30:00.000Z');
    expect(trackerSummary(db, now, { ...health, lastPublishedAt: '2026-10-19T05:00:00.000Z' }).lastPublishedAt).toBe('2026-10-19T06:00:00.000Z');
  });
});

describe('trackerSummary review fixes', () => {
  it('counts a task due today as open, not overdue', () => {
    const db = seededDb();
    task(db, 1, { deadline: '2026-10-19' });
    expect(trackerSummary(db, now).sheets[0]).toMatchObject({ notDone: 1, overdue: 0 });
  });

  it('takes the newest failure, and ignores tracker rows not written by the agent', () => {
    const db = seededDb();
    audit(db, '2026-10-19T05:00:00.000Z', 'tracker.publish_failed', 'Tracker upload failed: Drive did not accept the upload');
    audit(db, '2026-10-19T07:00:00.000Z', 'tracker.publish_failed', 'Tracker upload failed: Google sign-in expired');
    audit(db, '2026-10-19T06:00:00.000Z', 'tracker.publish_failed', 'Tracker upload failed: the workbook could not be built');
    const owner = db.prepare("INSERT INTO audit_log (at, actor, event, kind, detail) VALUES (?, 'owner@example.com', ?, 'ops', 'x')");
    owner.run('2026-10-19T09:00:00.000Z', 'tracker.published');
    owner.run('2026-10-19T09:00:00.000Z', 'tracker.publish_failed');
    expect(trackerSummary(db, now)).toMatchObject({ lastPublishedAt: null, lastFailure: { at: '2026-10-19T07:00:00.000Z', reason: 'Google sign-in expired' } });
  });
});
