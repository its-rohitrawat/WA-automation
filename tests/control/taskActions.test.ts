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

async function withTask(): Promise<Db> {
  const db = await seededDb();
  await createTask(db, { clientId: 1, side: 'us', title: 'Banner', category: 'design', priority: 'major', assignedTo: null, askedBy: null, raisedOn: '2026-10-10',
    deadline: null, latestProgress: null, sourceQuote: 'send the banner', sourceDate: '2026-10-10', sourceWaId: null, origin: 'whatsapp' }, NOW);
  return db;
}

/** Everything a correction changes: the task row, its events and the rebuild request. */
async function state(db: Db) {
  return {
    task: db.raw.prepare('SELECT * FROM tasks').all(),
    events: db.raw.prepare('SELECT task_id, client_id, actor, op, detail, reason, source_ids, at FROM task_events ORDER BY id').all(),
    rebuild: await getKv(db, 'rebuild_requested'),
  };
}

async function run(db: Db, code: string, action: string, body?: unknown) {
  const audits: AuditEntry[] = [];
  const detail = await runTaskAction(db, { code, action, body }, { actor: OWNER, now, audit: async (_q, e) => { audits.push(e); } });
  return { detail, audits };
}

async function refusal(fn: () => unknown): Promise<ControlError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ControlError) return e;
    throw e;
  }
  throw new Error('expected a ControlError');
}

describe('runTaskAction matches the CLI', () => {
  it('done, reopen and unlock change the row exactly as the CLI does, set rebuild_requested and audit with the code', async () => {
    const web = await withTask();
    const cli = await withTask();
    const steps: [string, (db: Db) => unknown, string][] = [
      ['done', (db) => closeTask(db, 'SHA-001', now), 'Task SHA-001 marked done'],
      ['reopen', (db) => reopenTask(db, 'SHA-001', now), 'Task SHA-001 reopened'],
      ['unlock', (db) => unlockTask(db, 'SHA-001', now), 'Task SHA-001 handed back to the agent'],
    ];
    for (const [action, viaCli, line] of steps) {
      const { detail, audits } = await run(web, 'sha-001', action);
      await viaCli(cli);
      expect(await state(web)).toEqual(await state(cli));
      expect(await getKv(web, 'rebuild_requested')).toBe(now.toISOString());
      expect(audits).toEqual([{ actor: OWNER, event: `task.${action}`, kind: 'task', detail: line }]);
      expect(detail.code).toBe('SHA-001');
    }
  });

  it('returns the fresh detail', async () => {
    const db = await withTask();
    expect((await run(db, 'SHA-001', 'done')).detail).toMatchObject({ code: 'SHA-001', status: 'done', history: [{ actor: 'owner', what: 'Marked done by the owner' }] });
  });

  it('edit matches the CLI and audits the field names only', async () => {
    const web = await withTask();
    const cli = await withTask();
    const { detail, audits } = await run(web, 'SHA-001', 'edit', { deadline: '2026-10-30', assignedTo: 'Rahul', latestProgress: 'secret words' });
    await editTask(cli, 'SHA-001', { deadline: '2026-10-30', assignedTo: 'Rahul', latestProgress: 'secret words' }, now);
    expect(await state(web)).toEqual(await state(cli));
    expect(detail).toMatchObject({ deadline: '2026-10-30', owner: 'Rahul', latestProgress: 'secret words' });
    expect(audits).toEqual([{ actor: OWNER, event: 'task.edit', kind: 'task', detail: 'Task SHA-001 edited (owner, deadline, progress)' }]);
    expect(JSON.stringify(audits)).not.toContain('secret');
    expect(JSON.stringify(audits)).not.toContain('Rahul');
  });

  it('edit clears optional fields with null or an empty string, as the CLI does with none', async () => {
    const web = await withTask();
    const cli = await withTask();
    await run(web, 'SHA-001', 'edit', { deadline: '2026-10-30', assignedTo: 'Rahul' });
    await editTask(cli, 'SHA-001', { deadline: '2026-10-30', assignedTo: 'Rahul' }, now);
    await run(web, 'SHA-001', 'edit', { deadline: null, assignedTo: '' });
    await editTask(cli, 'SHA-001', { deadline: 'none', assignedTo: 'none' }, now);
    expect(await state(web)).toEqual(await state(cli));
  });
});

describe('runTaskAction refusals', () => {
  it('404 for an unknown task, before anything changes or is audited', async () => {
    const db = await withTask();
    const audits: AuditEntry[] = [];
    const e = await refusal(async () => await runTaskAction(db, { code: 'SHA-999', action: 'done' }, { actor: OWNER, now, audit: async (_q, x) => { audits.push(x); } }));
    expect(e).toMatchObject({ status: 404, message: 'No task called SHA-999' });
    expect(await refusal(async () => await run(db, "x'--", 'done'))).toMatchObject({ status: 404 });
    expect(audits).toEqual([]);
  });

  it('409 for a status it already has, with nothing changed or audited', async () => {
    const db = await withTask();
    const before = await state(db);
    const audits: AuditEntry[] = [];
    expect(await refusal(async () => await runTaskAction(db, { code: 'SHA-001', action: 'reopen' }, { actor: OWNER, now, audit: async (_q, x) => { audits.push(x); } })))
      .toMatchObject({ status: 409, message: 'Task SHA-001 is already open' });
    expect(await state(db)).toEqual(before);
    expect(audits).toEqual([]);
  });

  it('400 for an unknown action', async () => {
    const db = await withTask();
    expect(await refusal(async () => await run(db, 'SHA-001', 'delete'))).toMatchObject({ status: 400, field: 'action' });
  });

  it('rolls the change back when the audit cannot be written', async () => {
    const db = await withTask();
    const before = await state(db);
    await expect(runTaskAction(db, { code: 'SHA-001', action: 'done' }, { actor: OWNER, now, audit: async () => { throw new Error('disk full'); } }))
      .rejects.toThrowError('disk full');
    expect(await state(db)).toEqual(before);
  });
});

describe('parseTaskEdit', () => {
  const bad = async (body: unknown, field: string) => {
    const e = await refusal(() => parseTaskEdit(body));
    expect(e.status, JSON.stringify(body)).toBe(422);
    expect(e.field, JSON.stringify(body)).toBe(field);
    return e;
  };

  it('takes each allowed field, trimming text and lower-casing the choices', () => {
    expect(parseTaskEdit({ title: '  Logo  ', assignedTo: 'Rahul', deadline: '2026-10-30', priority: 'MAJOR', side: 'Client', category: 'payment',
      latestProgress: 'Half done' })).toEqual({ title: 'Logo', assignedTo: 'Rahul', deadline: '2026-10-30', priority: 'major', side: 'client',
      category: 'payment', latestProgress: 'Half done' });
    expect(parseTaskEdit({ deadline: null, assignedTo: ' ', latestProgress: null })).toEqual({ deadline: '', assignedTo: '', latestProgress: '' });
  });

  it('refuses each bad value with the field named', async () => {
    await bad(null, 'body');
    await bad('title=x', 'body');
    await bad([], 'body');
    await bad({}, 'body');
    await bad({ askedBy: 'x' }, 'askedBy');
    await bad({ status: 'done' }, 'status');
    await bad({ title: '' }, 'title');
    await bad({ title: null }, 'title');
    await bad({ title: 'x'.repeat(201) }, 'title');
    await bad({ title: 5 }, 'title');
    await bad({ deadline: '2026-02-30' }, 'deadline');
    await bad({ deadline: '30/10/2026' }, 'deadline');
    await bad({ priority: 'urgent' }, 'priority');
    await bad({ priority: null }, 'priority');
    await bad({ side: 'them' }, 'side');
    await bad({ category: 'misc' }, 'category');
    await bad({ assignedTo: 'x'.repeat(101) }, 'assignedTo');
    await bad({ latestProgress: 'x'.repeat(1001) }, 'latestProgress');
    expect((await bad({ priority: 'urgent' }, 'priority')).message).toBe('priority must be one of: critical, major, medium, low');
  });

  it('accepts the longest title and a title called none is refused like the CLI', async () => {
    expect(parseTaskEdit({ title: 'x'.repeat(200) }).title).toHaveLength(200);
    const db = await withTask();
    expect(await refusal(async () => await run(db, 'SHA-001', 'edit', { title: 'none' }))).toMatchObject({ status: 422, field: 'title' });
  });

  it('an edit body on done, reopen or unlock is ignored', async () => {
    const db = await withTask();
    expect((await run(db, 'SHA-001', 'done', { title: 'ignored' })).detail).toMatchObject({ title: 'Banner', status: 'done' });
  });
});

describe('parseTaskEdit review fixes', () => {
  it('never repeats an unknown key in the message, and names it only when it is a short plain word', async () => {
    const long = `x${'<script>'.repeat(20)}`;
    expect(await refusal(() => parseTaskEdit({ [long]: 'a' }))).toMatchObject({ status: 422, field: 'body', message: 'That field cannot be changed here' });
    expect(await refusal(() => parseTaskEdit({ askedBy: 'a' }))).toMatchObject({ field: 'askedBy', message: 'That field cannot be changed here' });
  });

  it('refuses the word none, which editTask would read as clearing the field', async () => {
    for (const field of ['assignedTo', 'latestProgress', 'title']) {
      expect(await refusal(() => parseTaskEdit({ [field]: ' None ' })), field).toMatchObject({ status: 422, field });
    }
  });
});
