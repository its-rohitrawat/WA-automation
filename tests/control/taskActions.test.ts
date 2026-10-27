import { describe, expect, it } from 'vitest';
import { closeTask, editTask, reopenTask, unlockTask } from '../../src/cli/corrections.ts';
import { ControlError, type AuditEntry } from '../../src/control/errors.ts';
import { parseTaskEdit, runTaskAction } from '../../src/control/taskActions.ts';
import type { Db } from '../../src/store/db.ts';
import { getKv } from '../../src/store/kv.ts';
import { createTask } from '../../src/store/tasks.ts';
import { NOW, seededDb } from '../helpers/db.ts';

const now = new Date('2026-10-19T08:00:00Z');
const OWNER = 'owner@example.com';

function withTask(): Db {
  const db = seededDb();
  createTask(db, { clientId: 1, side: 'us', title: 'Banner', category: 'design', priority: 'high', assignedTo: null, askedBy: null, raisedOn: '2026-10-10',
    deadline: null, latestProgress: null, sourceQuote: 'send the banner', sourceDate: '2026-10-10', sourceWaId: null, origin: 'whatsapp' }, NOW);
  return db;
}

/** Everything a correction changes: the task row, its events and the rebuild request. */
function state(db: Db) {
  return {
    task: db.prepare('SELECT * FROM tasks').all(),
    events: db.prepare('SELECT task_id, client_id, actor, op, detail, reason, source_ids, at FROM task_events ORDER BY id').all(),
    rebuild: getKv(db, 'rebuild_requested'),
  };
}

function run(db: Db, code: string, action: string, body?: unknown) {
  const audits: AuditEntry[] = [];
  const detail = runTaskAction(db, { code, action, body }, { actor: OWNER, now, audit: (e) => audits.push(e) });
  return { detail, audits };
}

function refusal(fn: () => unknown): ControlError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ControlError) return e;
    throw e;
  }
  throw new Error('expected a ControlError');
}

describe('runTaskAction matches the CLI', () => {
  it('done, reopen and unlock change the row exactly as the CLI does, set rebuild_requested and audit with the code', () => {
    const web = withTask();
    const cli = withTask();
    const steps: [string, (db: Db) => unknown, string][] = [
      ['done', (db) => closeTask(db, 'SHA-001', now), 'Task SHA-001 marked done'],
      ['reopen', (db) => reopenTask(db, 'SHA-001', now), 'Task SHA-001 reopened'],
      ['unlock', (db) => unlockTask(db, 'SHA-001', now), 'Task SHA-001 handed back to the agent'],
    ];
    for (const [action, viaCli, line] of steps) {
      const { detail, audits } = run(web, 'sha-001', action);
      viaCli(cli);
      expect(state(web)).toEqual(state(cli));
      expect(getKv(web, 'rebuild_requested')).toBe(now.toISOString());
      expect(audits).toEqual([{ actor: OWNER, event: `task.${action}`, kind: 'task', detail: line }]);
      expect(detail.code).toBe('SHA-001');
    }
  });

  it('returns the fresh detail', () => {
    const db = withTask();
    expect(run(db, 'SHA-001', 'done').detail).toMatchObject({ code: 'SHA-001', status: 'done', history: [{ actor: 'owner', what: 'Marked done by the owner' }] });
  });

  it('edit matches the CLI and audits the field names only', () => {
    const web = withTask();
    const cli = withTask();
    const { detail, audits } = run(web, 'SHA-001', 'edit', { deadline: '2026-10-30', assignedTo: 'Rahul', latestProgress: 'secret words' });
    editTask(cli, 'SHA-001', { deadline: '2026-10-30', assignedTo: 'Rahul', latestProgress: 'secret words' }, now);
    expect(state(web)).toEqual(state(cli));
    expect(detail).toMatchObject({ deadline: '2026-10-30', owner: 'Rahul', latestProgress: 'secret words' });
    expect(audits).toEqual([{ actor: OWNER, event: 'task.edit', kind: 'task', detail: 'Task SHA-001 edited (owner, deadline, progress)' }]);
    expect(JSON.stringify(audits)).not.toContain('secret');
    expect(JSON.stringify(audits)).not.toContain('Rahul');
  });

  it('edit clears optional fields with null or an empty string, as the CLI does with none', () => {
    const web = withTask();
    const cli = withTask();
    run(web, 'SHA-001', 'edit', { deadline: '2026-10-30', assignedTo: 'Rahul' });
    editTask(cli, 'SHA-001', { deadline: '2026-10-30', assignedTo: 'Rahul' }, now);
    run(web, 'SHA-001', 'edit', { deadline: null, assignedTo: '' });
    editTask(cli, 'SHA-001', { deadline: 'none', assignedTo: 'none' }, now);
    expect(state(web)).toEqual(state(cli));
  });
});

describe('runTaskAction refusals', () => {
  it('404 for an unknown task, before anything changes or is audited', () => {
    const db = withTask();
    const audits: AuditEntry[] = [];
    const e = refusal(() => runTaskAction(db, { code: 'SHA-999', action: 'done' }, { actor: OWNER, now, audit: (x) => audits.push(x) }));
    expect(e).toMatchObject({ status: 404, message: 'No task called SHA-999' });
    expect(refusal(() => run(db, "x'--", 'done'))).toMatchObject({ status: 404 });
    expect(audits).toEqual([]);
  });

  it('409 for a status it already has, with nothing changed or audited', () => {
    const db = withTask();
    const before = state(db);
    const audits: AuditEntry[] = [];
    expect(refusal(() => runTaskAction(db, { code: 'SHA-001', action: 'reopen' }, { actor: OWNER, now, audit: (x) => audits.push(x) })))
      .toMatchObject({ status: 409, message: 'Task SHA-001 is already open' });
    expect(state(db)).toEqual(before);
    expect(audits).toEqual([]);
  });

  it('400 for an unknown action', () => {
    expect(refusal(() => run(withTask(), 'SHA-001', 'delete'))).toMatchObject({ status: 400, field: 'action' });
  });

  it('rolls the change back when the audit cannot be written', () => {
    const db = withTask();
    const before = state(db);
    expect(() => runTaskAction(db, { code: 'SHA-001', action: 'done' }, { actor: OWNER, now, audit: () => { throw new Error('disk full'); } }))
      .toThrowError('disk full');
    expect(state(db)).toEqual(before);
  });
});

describe('parseTaskEdit', () => {
  const bad = (body: unknown, field: string) => {
    const e = refusal(() => parseTaskEdit(body));
    expect(e.status, JSON.stringify(body)).toBe(422);
    expect(e.field, JSON.stringify(body)).toBe(field);
    return e;
  };

  it('takes each allowed field, trimming text and lower-casing the choices', () => {
    expect(parseTaskEdit({ title: '  Logo  ', assignedTo: 'Rahul', deadline: '2026-10-30', priority: 'HIGH', side: 'Client', category: 'payment',
      latestProgress: 'Half done' })).toEqual({ title: 'Logo', assignedTo: 'Rahul', deadline: '2026-10-30', priority: 'high', side: 'client',
      category: 'payment', latestProgress: 'Half done' });
    expect(parseTaskEdit({ deadline: null, assignedTo: ' ', latestProgress: null })).toEqual({ deadline: '', assignedTo: '', latestProgress: '' });
  });

  it('refuses each bad value with the field named', () => {
    bad(null, 'body');
    bad('title=x', 'body');
    bad([], 'body');
    bad({}, 'body');
    bad({ askedBy: 'x' }, 'askedBy');
    bad({ status: 'done' }, 'status');
    bad({ title: '' }, 'title');
    bad({ title: null }, 'title');
    bad({ title: 'x'.repeat(201) }, 'title');
    bad({ title: 5 }, 'title');
    bad({ deadline: '2026-02-30' }, 'deadline');
    bad({ deadline: '30/10/2026' }, 'deadline');
    bad({ priority: 'urgent' }, 'priority');
    bad({ priority: null }, 'priority');
    bad({ side: 'them' }, 'side');
    bad({ category: 'misc' }, 'category');
    bad({ assignedTo: 'x'.repeat(101) }, 'assignedTo');
    bad({ latestProgress: 'x'.repeat(1001) }, 'latestProgress');
    expect(bad({ priority: 'urgent' }, 'priority').message).toBe('priority must be one of: high, medium, low');
  });

  it('accepts the longest title and a title called none is refused like the CLI', () => {
    expect(parseTaskEdit({ title: 'x'.repeat(200) }).title).toHaveLength(200);
    const db = withTask();
    expect(refusal(() => run(db, 'SHA-001', 'edit', { title: 'none' }))).toMatchObject({ status: 422, field: 'title' });
  });

  it('an edit body on done, reopen or unlock is ignored', () => {
    const db = withTask();
    expect(run(db, 'SHA-001', 'done', { title: 'ignored' }).detail).toMatchObject({ title: 'Banner', status: 'done' });
  });
});

describe('parseTaskEdit review fixes', () => {
  it('never repeats an unknown key in the message, and names it only when it is a short plain word', () => {
    const long = `x${'<script>'.repeat(20)}`;
    expect(refusal(() => parseTaskEdit({ [long]: 'a' }))).toMatchObject({ status: 422, field: 'body', message: 'That field cannot be changed here' });
    expect(refusal(() => parseTaskEdit({ askedBy: 'a' }))).toMatchObject({ field: 'askedBy', message: 'That field cannot be changed here' });
  });

  it('refuses the word none, which editTask would read as clearing the field', () => {
    for (const field of ['assignedTo', 'latestProgress', 'title']) {
      expect(refusal(() => parseTaskEdit({ [field]: ' None ' })), field).toMatchObject({ status: 422, field });
    }
  });
});
