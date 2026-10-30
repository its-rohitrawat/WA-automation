import { describe, expect, it } from 'vitest';
import { loadTrackerView, type TrackerView } from '../../src/output/view.ts';
import {
  buildShortMorningText, byMorningUrgency, MAX_TITLE_CHARS, shortTitle, taskNotes, TOP_TASKS, trackerLink, TRACKER_ID_KEY,
} from '../../src/report/morningReport.ts';
import { syncClients } from '../../src/store/clients.ts';
import type { Db } from '../../src/store/db.ts';
import { setKv } from '../../src/store/kv.ts';
import { createTask, setTaskStatus, type NewTask, type TaskRow } from '../../src/store/tasks.ts';
import { seededDb, SHARMA } from '../helpers/db.ts';

const NOW = new Date('2026-10-23T00:30:00.000Z'); // 06:00 IST
const TODAY = '2026-10-23';
const OK = { ok: true, text: '✅ Connected · waiting for new messages' };
const LINK = 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp_qRsTuV-wxyz0123/view';

const task = (o: Partial<NewTask> = {}): NewTask => ({
  clientId: 1, side: 'us', title: 'A task', category: 'design', priority: 'medium', assignedTo: null, askedBy: null, raisedOn: '2026-10-01',
  deadline: null, latestProgress: null, sourceQuote: null, sourceDate: null, sourceWaId: null, origin: 'whatsapp', ...o,
});

const view = (db: Db): Promise<TrackerView> => loadTrackerView(db, NOW, OK);
const text = async (db: Db) => buildShortMorningText(await view(db), TODAY, LINK);
/** The open tasks of one client (1 = Sharma), most urgent first, as task codes. */
const urgent = async (db: Db, clientId = 1): Promise<string[]> => {
  const c = (await view(db)).clients.find((x) => x.client.id === clientId)!;
  return [...c.usOpen, ...c.clientOpen].sort(byMorningUrgency(TODAY)).map((t) => t.code);
};
const openTask = async (db: Db, code: string): Promise<TaskRow> => {
  for (const c of (await view(db)).clients) for (const t of [...c.usOpen, ...c.clientOpen]) if (t.code === code) return t;
  throw new Error(`no open task ${code}`);
};

describe('buildShortMorningText', () => {
  it('gives the totals and the link in one line, many open and overdue tasks', async () => {
    const db = await seededDb();
    await createTask(db, task({ title: 'Fix contact form', priority: 'major' }), NOW.toISOString());
    await createTask(db, task({ side: 'client', title: 'Send logo files', deadline: '2026-10-20' }), NOW.toISOString());
    await createTask(db, task({ title: 'Write about page', deadline: TODAY }), NOW.toISOString());
    await createTask(db, task({ clientId: 2, side: 'client', title: 'Approve menu', deadline: '2026-10-21' }), NOW.toISOString());
    await createTask(db, task({ clientId: 2, title: 'Print menu' }), NOW.toISOString());
    expect(await text(db)).toBe(`Good morning. 5 open tasks, 2 overdue. Today's tracker: ${LINK}`);
  });

  it('leads with the critical count when there are critical open tasks, and leaves done ones out', async () => {
    const db = await seededDb();
    await createTask(db, task({ title: 'Site down', priority: 'critical' }), NOW.toISOString());
    await createTask(db, task({ clientId: 2, side: 'client', title: 'Payment', priority: 'critical' }), NOW.toISOString());
    const done = await createTask(db, task({ title: 'Fixed', priority: 'critical' }), NOW.toISOString());
    await setTaskStatus(db, done.id, 'done', TODAY, NOW.toISOString(), 'ai');
    await createTask(db, task({ title: 'Plain' }), NOW.toISOString());
    expect(await text(db)).toBe(`Good morning. 2 critical, 3 open tasks, 0 overdue. Today's tracker: ${LINK}`);
  });

  it('uses the singular for 1 open task and 1 overdue', async () => {
    const db = await seededDb();
    await createTask(db, task({ side: 'client', title: 'Send logo files', deadline: '2026-10-20' }), NOW.toISOString());
    expect(await text(db)).toBe(`Good morning. 1 open task, 1 overdue. Today's tracker: ${LINK}`);
  });

  it('says 0 open tasks, 0 overdue when the active clients have nothing open, and leaves done tasks out', async () => {
    const db = await seededDb();
    const done = await createTask(db, task({ title: 'Share moodboard', deadline: '2026-10-01' }), NOW.toISOString());
    await setTaskStatus(db, done.id, 'done', '2026-10-15', NOW.toISOString(), 'ai');
    expect(await text(db)).toBe(`Good morning. 0 open tasks, 0 overdue. Today's tracker: ${LINK}`);
  });

  it('counts maybe-done tasks as open, like the tracker does, on our side and on the client side', async () => {
    const db = await seededDb();
    const maybe = await createTask(db, task({ title: 'Maybe finished', deadline: '2026-10-22' }), NOW.toISOString());
    await setTaskStatus(db, maybe.id, 'maybe_done', TODAY, NOW.toISOString(), 'ai');
    const clientMaybe = await createTask(db, task({ side: 'client', title: 'Client maybe', deadline: '2026-10-22' }), NOW.toISOString());
    await setTaskStatus(db, clientMaybe.id, 'maybe_done', TODAY, NOW.toISOString(), 'ai');
    await createTask(db, task({ title: 'Other' }), NOW.toISOString());
    expect(await text(db)).toBe(`Good morning. 3 open tasks, 2 overdue. Today's tracker: ${LINK}`);
  });

  it('leaves inactive clients out of the totals', async () => {
    const db = await seededDb();
    await createTask(db, task({ clientId: 2, title: 'Mehta menu', deadline: '2026-10-01' }), NOW.toISOString());
    await createTask(db, task({ title: 'Sharma task' }), NOW.toISOString());
    syncClients(db, [SHARMA]); // Mehta taken off the allow-list
    expect(await text(db)).toBe(`Good morning. 1 open task, 0 overdue. Today's tracker: ${LINK}`);
  });

  it('says no open tasks when there are no active clients', async () => {
    const db = await seededDb();
    await createTask(db, task({ title: 'Left behind' }), NOW.toISOString());
    syncClients(db, []);
    expect(await text(db)).toBe(`Good morning. No open tasks. Today's tracker: ${LINK}`);
  });

  it('carries no client name, task title or code, and leaves the view it is given unchanged', async () => {
    const db = await seededDb();
    await createTask(db, task({ title: 'Secret banner work', priority: 'major' }), NOW.toISOString());
    await createTask(db, task({ side: 'client', title: 'Client overdue', deadline: '2026-10-21' }), NOW.toISOString());
    const v = await view(db);
    const codes = () => v.clients.map((c) => [c.usOpen.map((t) => t.code), c.clientOpen.map((t) => t.code)]);
    const before = codes();
    const out = buildShortMorningText(v, TODAY, LINK);
    for (const bad of ['Sharma', 'Mehta', 'Secret', 'SHA-', '\n']) expect(out).not.toContain(bad);
    expect(codes()).toEqual(before);
  });
});

describe('trackerLink', () => {
  it('builds the Drive view link from the tracker id the publisher stored', async () => {
    const db = await seededDb();
    setKv(db, TRACKER_ID_KEY, '1AbCdEfGhIjKlMnOp_qRsTuV-wxyz0123');
    expect(trackerLink(db)).toBe(LINK);
  });

  it('accepts an id of exactly 10 safe characters', async () => {
    const db = await seededDb();
    setKv(db, TRACKER_ID_KEY, 'aZ09_-aZ09');
    expect(trackerLink(db)).toBe('https://drive.google.com/file/d/aZ09_-aZ09/view');
  });

  it('gives undefined when the tracker was never uploaded', async () => {
    expect(trackerLink(await seededDb())).toBeUndefined();
  });

  it('gives undefined for an id that is short, empty or holds anything but letters, digits, _ and -', async () => {
    const bad = [
      '', 'file-1', 'aZ09_-aZ0', '1AbCdEfGhIj/../x', '1AbCdEfGhIj?x=y', '1AbCdEfGhIj Kl', '1AbCdEfGhIjKl\n', 'https://evil.example/1AbCdEfGhIj',
      '1AbCdEfGhIj.kl',
    ];
    for (const id of bad) {
      const db = await seededDb();
      setKv(db, TRACKER_ID_KEY, id);
      expect(trackerLink(db), JSON.stringify(id)).toBeUndefined();
    }
  });
});

describe('byMorningUrgency', () => {
  it('orders overdue first, then due today, then priority, then oldest raised', async () => {
    const db = await seededDb();
    await createTask(db, task({ title: 'Fix contact form', priority: 'major', raisedOn: '2026-10-01' }), NOW.toISOString()); // SHA-001
    await createTask(db, task({ side: 'client', title: 'Send logo files', priority: 'low', deadline: '2026-10-20', raisedOn: '2026-10-15' }), NOW.toISOString()); // SHA-002
    await createTask(db, task({ title: 'Write about page', deadline: TODAY, raisedOn: '2026-10-05' }), NOW.toISOString()); // SHA-003
    await createTask(db, task({ title: 'Old low task', priority: 'low', raisedOn: '2026-09-01' }), NOW.toISOString()); // SHA-004
    await createTask(db, task({ side: 'client', title: 'Approve sitemap', deadline: '2026-10-21', raisedOn: '2026-10-10' }), NOW.toISOString()); // SHA-005
    expect(await urgent(db)).toEqual(['SHA-005', 'SHA-002', 'SHA-003', 'SHA-001', 'SHA-004']);
    expect(TOP_TASKS).toBe(3);
  });

  it('ranks high priority above older tasks', async () => {
    const db = await seededDb();
    await createTask(db, task({ title: 'Oldest', raisedOn: '2026-09-01' }), NOW.toISOString()); // SHA-001
    await createTask(db, task({ title: 'Urgent one', priority: 'major', raisedOn: '2026-10-20' }), NOW.toISOString()); // SHA-002
    await createTask(db, task({ title: 'Later', raisedOn: '2026-10-02' }), NOW.toISOString()); // SHA-003
    expect(await urgent(db)).toEqual(['SHA-002', 'SHA-001', 'SHA-003']);
  });

  it('puts critical tasks first, even before overdue ones, and ranks a task from before levels by its old priority', async () => {
    const db = await seededDb();
    await createTask(db, task({ title: 'Overdue', deadline: '2026-10-20' }), NOW.toISOString()); // SHA-001
    await createTask(db, task({ title: 'Critical', priority: 'critical', raisedOn: '2026-10-20' }), NOW.toISOString()); // SHA-002
    await createTask(db, task({ title: 'Old high', priority: 'major', raisedOn: '2026-10-21' }), NOW.toISOString()); // SHA-003
    db.raw.prepare("UPDATE tasks SET priority_level = NULL WHERE code = 'SHA-003'").run(); // old column stays 'high'
    await createTask(db, task({ title: 'Medium', raisedOn: '2026-09-01' }), NOW.toISOString()); // SHA-004
    expect(await urgent(db)).toEqual(['SHA-002', 'SHA-001', 'SHA-003', 'SHA-004']);
  });

  it('breaks a full tie by task id, whichever side each task is on', async () => {
    const db = await seededDb();
    await createTask(db, task({ side: 'client', title: 'Client first' }), NOW.toISOString()); // SHA-001
    await createTask(db, task({ title: 'Us second' }), NOW.toISOString()); // SHA-002
    await createTask(db, task({ title: 'Us third' }), NOW.toISOString()); // SHA-003
    expect(await urgent(db)).toEqual(['SHA-001', 'SHA-002', 'SHA-003']);
  });
});

describe('taskNotes', () => {
  it('notes critical, and a task without a level (from before levels) gets no priority note', async () => {
    const db = await seededDb();
    await createTask(db, task({ title: 'Down', priority: 'critical' }), NOW.toISOString()); // SHA-001
    await createTask(db, task({ title: 'Old high', priority: 'major' }), NOW.toISOString()); // SHA-002
    db.raw.prepare("UPDATE tasks SET priority_level = NULL WHERE code = 'SHA-002'").run();
    expect(taskNotes(await openTask(db, 'SHA-001'), TODAY)).toEqual(['critical']);
    expect(taskNotes(await openTask(db, 'SHA-002'), TODAY)).toEqual([]);
  });

  it('notes due today, a later deadline, overdue, major and maybe done', async () => {
    const db = await seededDb();
    await createTask(db, task({ title: 'Today', deadline: TODAY }), NOW.toISOString()); // SHA-001
    await createTask(db, task({ title: 'Late', priority: 'major', deadline: '2026-10-21' }), NOW.toISOString()); // SHA-002
    const maybe = await createTask(db, task({ title: 'Maybe', deadline: '2026-10-30' }), NOW.toISOString()); // SHA-003
    await setTaskStatus(db, maybe.id, 'maybe_done', TODAY, NOW.toISOString(), 'ai');
    await createTask(db, task({ title: 'Plain' }), NOW.toISOString()); // SHA-004
    expect(taskNotes(await openTask(db, 'SHA-001'), TODAY)).toEqual(['due today']);
    expect(taskNotes(await openTask(db, 'SHA-002'), TODAY)).toEqual(['due 21 Oct', 'overdue', 'major']);
    expect(taskNotes(await openTask(db, 'SHA-003'), TODAY)).toEqual(['due 30 Oct', 'maybe done']);
    expect(taskNotes(await openTask(db, 'SHA-004'), TODAY)).toEqual([]);
  });
});

describe('shortTitle', () => {
  it('keeps short titles and flattens line breaks', () => {
    expect(shortTitle('Send\n  logo   files ')).toBe('Send logo files');
  });

  it('cuts at a space near the end, or mid-word when there is none', () => {
    const cut = shortTitle('word '.repeat(30));
    expect(Array.from(cut).length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
    expect(cut.endsWith('word…')).toBe(true);
    expect(shortTitle('x'.repeat(100))).toBe(`${'x'.repeat(MAX_TITLE_CHARS - 1)}…`);
  });

  it('keeps a title of exactly the limit and cuts one a character longer', () => {
    expect(shortTitle('x'.repeat(MAX_TITLE_CHARS))).toBe('x'.repeat(MAX_TITLE_CHARS));
    expect(shortTitle('x'.repeat(MAX_TITLE_CHARS + 1))).toBe(`${'x'.repeat(MAX_TITLE_CHARS - 1)}…`);
  });

  it('cuts mid-word rather than at a space in the first half', () => {
    expect(shortTitle(`Hi ${'x'.repeat(100)}`)).toBe(`Hi ${'x'.repeat(MAX_TITLE_CHARS - 4)}…`);
  });

  it('never splits an emoji', () => {
    expect(shortTitle(`${'a'.repeat(68)}😀😀😀`)).toBe(`${'a'.repeat(68)}😀…`);
  });
});
