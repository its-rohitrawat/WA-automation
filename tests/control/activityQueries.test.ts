import { describe, expect, it } from 'vitest';
import { closeTask } from '../../src/cli/corrections.ts';
import { listActivity, parseActivityParams, publisherAuditHooks } from '../../src/control/activityQueries.ts';
import { ControlError, type AuditEntry } from '../../src/control/errors.ts';
import { DrivePublisher } from '../../src/output/drive.ts';
import { finishBatch, startBatch } from '../../src/store/batches.ts';
import type { Db } from '../../src/store/db.ts';
import { insertFound, type MeetingStatus } from '../../src/store/meetings.ts';
import { createTask, recordEvent } from '../../src/store/tasks.ts';
import { silentLogger } from '../../src/util/logger.ts';
import { FakeDrive } from '../helpers/fakeDrive.ts';
import { NOW, seededDb } from '../helpers/db.ts';

const at = (hhmm: string) => `2026-10-19T${hhmm}:00.000Z`;

function batch(db: Db, o: { at: string; status: 'ok' | 'failed'; messages: number; accepted?: number; clientId?: number }) {
  const id = startBatch(db, o.clientId ?? 1, o.messages, o.at);
  finishBatch(db, id, { status: o.status, errorCode: o.status === 'failed' ? 'ai_error' : null, accepted: o.accepted ?? null, rejected: null, at: o.at });
}

function task(db: Db, title: string, clientId = 1) {
  return createTask(db, { clientId, side: 'us', title, category: 'design', priority: 'medium', assignedTo: null, askedBy: null, raisedOn: '2026-10-19',
    deadline: null, latestProgress: null, sourceQuote: null, sourceDate: null, sourceWaId: null, origin: 'whatsapp' }, NOW);
}

let n = 0;
function meeting(db: Db, status: MeetingStatus, updatedAt: string, o: { title?: string; seconds?: number } = {}) {
  n++;
  const id = insertFound(db, {
    recording: `conferenceRecords/c${n}/recordings/r`, conference: `conferenceRecords/c${n}`, driveFileId: `d${n}`, meetingCode: null,
    title: status === 'internal' ? '' : (o.title ?? 'Weekly sync'), startedAt: NOW, endedAt: null, attendees: [], participants: [],
    clientId: status === 'unassigned' || status === 'internal' ? null : 1, matchKind: null, status, driveSeconds: o.seconds ?? 1800, createdAt: NOW,
  })!;
  db.prepare("UPDATE meetings SET updated_at = ?, stage = CASE WHEN status = 'done' THEN 'tracked' ELSE stage END WHERE id = ?").run(updatedAt, id);
  return id;
}

function audit(db: Db, a: { at: string; actor: string; event: string; kind: string; detail: string }) {
  db.prepare('INSERT INTO audit_log (at, actor, event, kind, detail) VALUES (?, ?, ?, ?, ?)').run(a.at, a.actor, a.event, a.kind, a.detail);
}

const params = (o: Record<string, string> = {}) => parseActivityParams(new URLSearchParams(o));
const titles = (r: { items: { title: string }[] }) => r.items.map((i) => i.title);

describe('parseActivityParams', () => {
  it('defaults, caps the limit and refuses bad values', () => {
    expect(params()).toEqual({ kind: 'all', limit: 50 });
    expect(params({ limit: '999' }).limit).toBe(200);
    for (const [field, value] of [['kind', 'chat'], ['limit', '0'], ['before', 'yesterday'], ['before', '2026-10-19T08:00:00Z|x|1']] as const) {
      expect(() => params({ [field]: value }), `${field}=${value}`).toThrowError(ControlError);
    }
    expect(params({ before: '2026-10-19T08:00:00.000Z' }).before).toEqual({ at: '2026-10-19T08:00:00.000Z' });
    expect(params({ before: '2026-10-19T08:00:00.000Z|e|12' }).before).toEqual({ at: '2026-10-19T08:00:00.000Z', src: 'e', id: 12 });
  });
});

describe('listActivity', () => {
  it('merges every source, newest first, in plain words', () => {
    const db = seededDb();
    batch(db, { at: at('05:00'), status: 'ok', messages: 18, accepted: 2, clientId: 2 });
    const t = task(db, 'Revise <b>landing</b> page');
    recordEvent(db, { taskId: t.id, clientId: 1, actor: 'ai', op: 'add_task', detail: { title: 'chat words' }, reason: null, sourceIds: [], at: at('05:10') });
    recordEvent(db, { taskId: t.id, clientId: 1, actor: 'ai', op: 'mark_maybe_done', detail: {}, reason: null, sourceIds: [], at: at('05:20') });
    closeTask(db, t.code, new Date(at('05:30')));
    meeting(db, 'done', at('05:40'));
    audit(db, { at: at('05:50'), actor: 'agent', event: 'tracker.published', kind: 'ops', detail: 'Tracker.xlsx uploaded to Drive' });
    meeting(db, 'too_long', at('06:00'), { title: 'Launch prep', seconds: 196 * 60 });
    batch(db, { at: at('06:10'), status: 'failed', messages: 4 });
    audit(db, { at: at('06:20'), actor: 'agent', event: 'tracker.publish_failed', kind: 'ops', detail: 'Tracker upload failed: Google sign-in expired' });
    audit(db, { at: at('06:30'), actor: 'owner@example.com', event: 'whatsapp.relink', kind: 'connection', detail: "Founder's phone relinked" });
    audit(db, { at: at('06:40'), actor: 'owner@example.com', event: 'settings.report', kind: 'config', detail: 'Morning briefing switched on' });
    audit(db, { at: at('06:50'), actor: 'owner@example.com', event: 'auth.signin', kind: 'auth', detail: 'Signed in' }); // not activity
    meeting(db, 'internal', at('07:00')); // never listed
    const r = listActivity(db, params());
    expect(r.items.map(({ kind, title, detail, who }) => ({ kind, title, detail, who }))).toEqual([
      { kind: 'config', title: 'Setting changed', detail: 'Morning briefing switched on', who: 'by owner@example.com' },
      { kind: 'connection', title: 'Connection changed', detail: "Founder's phone relinked", who: 'by owner@example.com' },
      { kind: 'issue', title: 'Tracker upload failed', detail: 'Tracker upload failed: Google sign-in expired', who: 'by the agent' },
      { kind: 'issue', title: 'Could not read 4 messages', detail: 'Sharma Interiors', who: 'the agent tries again' },
      { kind: 'issue', title: 'Meeting too long to process', detail: 'Launch prep · Sharma Interiors (196 min)', who: 'over the length limit' },
      { kind: 'tracker', title: 'Tracker updated', detail: 'Tracker.xlsx uploaded to Drive', who: 'by the agent' },
      { kind: 'meet', title: 'Meeting summary ready', detail: 'Weekly sync · Sharma Interiors', who: '0 action items' },
      { kind: 'task', title: 'Marked done', detail: 'SHA-001 · Revise <b>landing</b> page', who: 'by the owner · Sharma Interiors' },
      { kind: 'task', title: 'Marked maybe done', detail: 'SHA-001 · Revise <b>landing</b> page', who: 'by the agent · Sharma Interiors' },
      { kind: 'task', title: 'Task created', detail: 'SHA-001 · Revise <b>landing</b> page', who: 'from WhatsApp · Sharma Interiors' },
      { kind: 'msg', title: '18 messages read', detail: 'Mehta Foods', who: '2 tasks changed' },
    ]);
    expect(r.items[0]!.at).toBe(at('06:40'));
    expect(JSON.stringify(r)).not.toContain('chat words');
  });

  it('labels the meeting states the owner cares about', () => {
    const db = seededDb();
    meeting(db, 'unassigned', at('05:00'), { title: 'Client call' });
    meeting(db, 'queued', at('05:01'));
    meeting(db, 'skipped', at('05:02'));
    meeting(db, 'no_access', at('05:03'));
    meeting(db, 'failed', at('05:04'));
    expect(listActivity(db, params()).items.map(({ kind, title, detail }) => [kind, title, detail])).toEqual([
      ['issue', 'Meeting could not be processed', 'Weekly sync · Sharma Interiors'],
      ['issue', 'No access to a meeting recording', 'Weekly sync · Sharma Interiors'],
      ['meet', 'Meeting skipped', 'Weekly sync · Sharma Interiors'],
      ['meet', 'Meeting being processed', 'Weekly sync · Sharma Interiors'],
      ['meet', 'Meeting needs a client', 'Client call'],
    ]);
  });

  it('filters by kind', () => {
    const db = seededDb();
    batch(db, { at: at('05:00'), status: 'ok', messages: 3 });
    batch(db, { at: at('05:01'), status: 'failed', messages: 3 });
    const t = task(db, 'Logo');
    recordEvent(db, { taskId: t.id, clientId: 1, actor: 'ai', op: 'add_task', detail: {}, reason: null, sourceIds: [], at: at('05:02') });
    meeting(db, 'done', at('05:03'));
    meeting(db, 'failed', at('05:04'));
    audit(db, { at: at('05:05'), actor: 'agent', event: 'tracker.published', kind: 'ops', detail: 'Tracker.xlsx uploaded to Drive' });
    audit(db, { at: at('05:06'), actor: 'agent', event: 'tracker.publish_failed', kind: 'ops', detail: 'Tracker upload failed' });
    expect(titles(listActivity(db, params({ kind: 'msg' })))).toEqual(['3 messages read']);
    expect(titles(listActivity(db, params({ kind: 'task' })))).toEqual(['Task created']);
    expect(titles(listActivity(db, params({ kind: 'meet' })))).toEqual(['Meeting summary ready']);
    expect(titles(listActivity(db, params({ kind: 'tracker' })))).toEqual(['Tracker updated']);
    expect(titles(listActivity(db, params({ kind: 'issue' })))).toEqual(['Tracker upload failed', 'Meeting could not be processed', 'Could not read 3 messages']);
    expect(listActivity(db, params()).items).toHaveLength(7);
  });

  it('pages with before, never losing items that share a time', () => {
    const db = seededDb();
    for (let i = 0; i < 5; i++) batch(db, { at: at('05:00'), status: 'ok', messages: i + 1 });
    audit(db, { at: at('05:00'), actor: 'agent', event: 'tracker.published', kind: 'ops', detail: 'x' });
    batch(db, { at: at('04:00'), status: 'ok', messages: 9 });
    const seen: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = listActivity(db, params({ limit: '2', ...(before ? { before } : {}) }));
      seen.push(...r.items.map((i) => i.id));
      if (!r.next) break;
      before = r.next;
    }
    expect(seen).toEqual(['b:5', 'b:4', 'b:3', 'b:2', 'b:1', 'a:1', 'b:6']);
    // A plain time: everything strictly before it.
    expect(titles(listActivity(db, params({ before: at('05:00') })))).toEqual(['9 messages read']);
  });

  it('gives next only when the page is full', () => {
    const db = seededDb();
    batch(db, { at: at('05:00'), status: 'ok', messages: 1 });
    expect(listActivity(db, params({ limit: '1' })).next).toBe(`${at('05:00')}|b|1`);
    expect(listActivity(db, params({ limit: '2' })).next).toBeNull();
  });

  it('skips running batches and events not about a task', () => {
    const db = seededDb();
    startBatch(db, 1, 5, at('05:00'));
    recordEvent(db, { taskId: null, clientId: 1, actor: 'ai', op: 'set_status', detail: { status: 'chat words' }, reason: null, sourceIds: [], at: at('05:01') });
    expect(listActivity(db, params()).items).toEqual([]);
  });
});

describe('publisherAuditHooks', () => {
  async function publish(api: FakeDrive, hooks: ReturnType<typeof publisherAuditHooks>) {
    const db = seededDb();
    const p = new DrivePublisher({ db, api, build: async () => Buffer.from('x'), log: silentLogger(), minIntervalMs: 0, ...hooks });
    await p.publishNow();
    await p.stop(1000);
  }

  it('writes an agent row for a publish and for a failure, in fixed words only', async () => {
    const entries: AuditEntry[] = [];
    const hooks = publisherAuditHooks((e) => entries.push(e));
    await publish(new FakeDrive(), hooks);
    const failing = new FakeDrive();
    failing.failNextWith = new Error('secret words from a chat message');
    await publish(failing, hooks);
    expect(entries).toEqual([
      { actor: 'agent', event: 'tracker.published', kind: 'ops', detail: 'Tracker.xlsx uploaded to Drive' },
      { actor: 'agent', event: 'tracker.publish_failed', kind: 'ops', detail: 'Tracker upload failed: Drive did not accept the upload' },
    ]);
  });

  it('names each failure in plain words', () => {
    const entries: AuditEntry[] = [];
    const { onFailure } = publisherAuditHooks((e) => entries.push(e));
    onFailure({ step: 'drive', auth: true });
    onFailure({ step: 'build', auth: false });
    expect(entries.map((e) => e.detail)).toEqual(['Tracker upload failed: Google sign-in expired', 'Tracker upload failed: the workbook could not be built']);
  });
});
