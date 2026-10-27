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

const view = (db: Db): TrackerView => loadTrackerView(db, NOW, OK);
const text = (db: Db) => buildShortMorningText(view(db), TODAY, LINK);
/** The open tasks of one client (1 = Sharma), most urgent first, as task codes. */
const urgent = (db: Db, clientId = 1): string[] => {
  const c = view(db).clients.find((x) => x.client.id === clientId)!;
  return [...c.usOpen, ...c.clientOpen].sort(byMorningUrgency(TODAY)).map((t) => t.code);
};
const openTask = (db: Db, code: string): TaskRow => {
  for (const c of view(db).clients) for (const t of [...c.usOpen, ...c.clientOpen]) if (t.code === code) return t;
  throw new Error(`no open task ${code}`);
};

describe('buildShortMorningText', () => {
  it('gives the totals and the link in one line, many open and overdue tasks', () => {
    const db = seededDb();
    createTask(db, task({ title: 'Fix contact form', priority: 'high' }), NOW.toISOString());
    createTask(db, task({ side: 'client', title: 'Send logo files', deadline: '2026-10-20' }), NOW.toISOString());
    createTask(db, task({ title: 'Write about page', deadline: TODAY }), NOW.toISOString());
    createTask(db, task({ clientId: 2, side: 'client', title: 'Approve menu', deadline: '2026-10-21' }), NOW.toISOString());
    createTask(db, task({ clientId: 2, title: 'Print menu' }), NOW.toISOString());
    expect(text(db)).toBe(`Good morning. 5 open tasks, 2 overdue. Today's tracker: ${LINK}`);
  });

  it('uses the singular for 1 open task and 1 overdue', () => {
    const db = seededDb();
    createTask(db, task({ side: 'client', title: 'Send logo files', deadline: '2026-10-20' }), NOW.toISOString());
    expect(text(db)).toBe(`Good morning. 1 open task, 1 overdue. Today's tracker: ${LINK}`);
  });

  it('says 0 open tasks, 0 overdue when the active clients have nothing open, and leaves done tasks out', () => {
    const db = seededDb();
    const done = createTask(db, task({ title: 'Share moodboard', deadline: '2026-10-01' }), NOW.toISOString());
    setTaskStatus(db, done.id, 'done', '2026-10-15', NOW.toISOString(), 'ai');
    expect(text(db)).toBe(`Good morning. 0 open tasks, 0 overdue. Today's tracker: ${LINK}`);
  });

  it('counts maybe-done tasks as open, like the tracker does', () => {
    const db = seededDb();
    const maybe = createTask(db, task({ title: 'Maybe finished', deadline: '2026-10-22' }), NOW.toISOString());
    setTaskStatus(db, maybe.id, 'maybe_done', TODAY, NOW.toISOString(), 'ai');
    createTask(db, task({ title: 'Other' }), NOW.toISOString());
    expect(text(db)).toBe(`Good morning. 2 open tasks, 1 overdue. Today's tracker: ${LINK}`);
  });

  it('leaves inactive clients out of the totals', () => {
    const db = seededDb();
    createTask(db, task({ clientId: 2, title: 'Mehta menu', deadline: '2026-10-01' }), NOW.toISOString());
    createTask(db, task({ title: 'Sharma task' }), NOW.toISOString());
    syncClients(db, [SHARMA]); // Mehta taken off the allow-list
    expect(text(db)).toBe(`Good morning. 1 open task, 0 overdue. Today's tracker: ${LINK}`);
  });

  it('says no open tasks when there are no active clients', () => {
    const db = seededDb();
    createTask(db, task({ title: 'Left behind' }), NOW.toISOString());
    syncClients(db, []);
    expect(text(db)).toBe(`Good morning. No open tasks. Today's tracker: ${LINK}`);
  });

  it('carries no client name, task title or code, and leaves the view it is given unchanged', () => {
    const db = seededDb();
    createTask(db, task({ title: 'Secret banner work', priority: 'high' }), NOW.toISOString());
    createTask(db, task({ side: 'client', title: 'Client overdue', deadline: '2026-10-21' }), NOW.toISOString());
    const v = view(db);
    const codes = () => v.clients.map((c) => [c.usOpen.map((t) => t.code), c.clientOpen.map((t) => t.code)]);
    const before = codes();
    const out = buildShortMorningText(v, TODAY, LINK);
    for (const bad of ['Sharma', 'Mehta', 'Secret', 'SHA-', '\n']) expect(out).not.toContain(bad);
    expect(codes()).toEqual(before);
  });
});

describe('trackerLink', () => {
  it('builds the Drive view link from the tracker id the publisher stored', () => {
    const db = seededDb();
    setKv(db, TRACKER_ID_KEY, '1AbCdEfGhIjKlMnOp_qRsTuV-wxyz0123');
    expect(trackerLink(db)).toBe(LINK);
    expect(TRACKER_ID_KEY).toBe('drive_tracker_id'); // the key src/output/drive.ts writes
  });

  it('accepts an id of exactly 10 safe characters', () => {
    const db = seededDb();
    setKv(db, TRACKER_ID_KEY, 'aZ09_-aZ09');
    expect(trackerLink(db)).toBe('https://drive.google.com/file/d/aZ09_-aZ09/view');
  });

  it('gives undefined when the tracker was never uploaded', () => {
    expect(trackerLink(seededDb())).toBeUndefined();
  });

  it('gives undefined for an id that is short, empty or holds anything but letters, digits, _ and -', () => {
    const bad = [
      '', 'file-1', 'aZ09_-aZ0', '1AbCdEfGhIj/../x', '1AbCdEfGhIj?x=y', '1AbCdEfGhIj Kl', '1AbCdEfGhIjKl\n', 'https://evil.example/1AbCdEfGhIj',
      '1AbCdEfGhIj.kl',
    ];
    for (const id of bad) {
      const db = seededDb();
      setKv(db, TRACKER_ID_KEY, id);
      expect(trackerLink(db), JSON.stringify(id)).toBeUndefined();
    }
  });
});

describe('byMorningUrgency', () => {
  it('orders overdue first, then due today, then priority, then oldest raised', () => {
    const db = seededDb();
    createTask(db, task({ title: 'Fix contact form', priority: 'high', raisedOn: '2026-10-01' }), NOW.toISOString()); // SHA-001
    createTask(db, task({ side: 'client', title: 'Send logo files', priority: 'low', deadline: '2026-10-20', raisedOn: '2026-10-15' }), NOW.toISOString()); // SHA-002
    createTask(db, task({ title: 'Write about page', deadline: TODAY, raisedOn: '2026-10-05' }), NOW.toISOString()); // SHA-003
    createTask(db, task({ title: 'Old low task', priority: 'low', raisedOn: '2026-09-01' }), NOW.toISOString()); // SHA-004
    createTask(db, task({ side: 'client', title: 'Approve sitemap', deadline: '2026-10-21', raisedOn: '2026-10-10' }), NOW.toISOString()); // SHA-005
    expect(urgent(db)).toEqual(['SHA-005', 'SHA-002', 'SHA-003', 'SHA-001', 'SHA-004']);
    expect(TOP_TASKS).toBe(3);
  });

  it('ranks high priority above older tasks', () => {
    const db = seededDb();
    createTask(db, task({ title: 'Oldest', raisedOn: '2026-09-01' }), NOW.toISOString()); // SHA-001
    createTask(db, task({ title: 'Urgent one', priority: 'high', raisedOn: '2026-10-20' }), NOW.toISOString()); // SHA-002
    createTask(db, task({ title: 'Later', raisedOn: '2026-10-02' }), NOW.toISOString()); // SHA-003
    expect(urgent(db)).toEqual(['SHA-002', 'SHA-001', 'SHA-003']);
  });

  it('breaks a full tie by task id, whichever side each task is on', () => {
    const db = seededDb();
    createTask(db, task({ side: 'client', title: 'Client first' }), NOW.toISOString()); // SHA-001
    createTask(db, task({ title: 'Us second' }), NOW.toISOString()); // SHA-002
    createTask(db, task({ title: 'Us third' }), NOW.toISOString()); // SHA-003
    expect(urgent(db)).toEqual(['SHA-001', 'SHA-002', 'SHA-003']);
  });
});

describe('taskNotes', () => {
  it('notes due today, a later deadline, overdue, high priority and maybe done', () => {
    const db = seededDb();
    createTask(db, task({ title: 'Today', deadline: TODAY }), NOW.toISOString()); // SHA-001
    createTask(db, task({ title: 'Late', priority: 'high', deadline: '2026-10-21' }), NOW.toISOString()); // SHA-002
    const maybe = createTask(db, task({ title: 'Maybe', deadline: '2026-10-30' }), NOW.toISOString()); // SHA-003
    setTaskStatus(db, maybe.id, 'maybe_done', TODAY, NOW.toISOString(), 'ai');
    createTask(db, task({ title: 'Plain' }), NOW.toISOString()); // SHA-004
    expect(taskNotes(openTask(db, 'SHA-001'), TODAY)).toEqual(['due today']);
    expect(taskNotes(openTask(db, 'SHA-002'), TODAY)).toEqual(['due 21 Oct', 'overdue', 'high priority']);
    expect(taskNotes(openTask(db, 'SHA-003'), TODAY)).toEqual(['due 30 Oct', 'maybe done']);
    expect(taskNotes(openTask(db, 'SHA-004'), TODAY)).toEqual([]);
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
