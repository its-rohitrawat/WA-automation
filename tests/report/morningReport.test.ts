import { describe, expect, it } from 'vitest';
import { loadTrackerView } from '../../src/output/view.ts';
import { buildMorningText, MAX_TITLE_CHARS, shortTitle } from '../../src/report/morningReport.ts';
import { syncClients } from '../../src/store/clients.ts';
import type { Db } from '../../src/store/db.ts';
import { createTask, setTaskStatus, type NewTask } from '../../src/store/tasks.ts';
import { seededDb, SHARMA } from '../helpers/db.ts';

const NOW = new Date('2026-10-23T00:30:00.000Z'); // 06:00 IST
const TODAY = '2026-10-23';
const OK = { ok: true, text: '✅ Connected · waiting for new messages' };

const task = (o: Partial<NewTask> = {}): NewTask => ({
  clientId: 1, side: 'us', title: 'A task', category: 'design', priority: 'medium', assignedTo: null, askedBy: null, raisedOn: '2026-10-01',
  deadline: null, latestProgress: null, sourceQuote: null, sourceDate: null, sourceWaId: null, origin: 'whatsapp', ...o,
});

const text = (db: Db) => buildMorningText(loadTrackerView(db, NOW, OK), TODAY);

describe('buildMorningText', () => {
  it('counts open and overdue tasks and lists the 3 most urgent, overdue first, then due today, then priority, then oldest', () => {
    const db = seededDb();
    createTask(db, task({ title: 'Fix contact form', priority: 'high', raisedOn: '2026-10-01' }), NOW.toISOString()); // SHA-001
    createTask(db, task({ side: 'client', title: 'Send logo files', priority: 'low', deadline: '2026-10-20', raisedOn: '2026-10-15' }), NOW.toISOString()); // SHA-002
    createTask(db, task({ title: 'Write about page', deadline: TODAY, raisedOn: '2026-10-05' }), NOW.toISOString()); // SHA-003
    createTask(db, task({ title: 'Old low task', priority: 'low', raisedOn: '2026-09-01' }), NOW.toISOString()); // SHA-004
    createTask(db, task({ side: 'client', title: 'Approve sitemap', deadline: '2026-10-21', raisedOn: '2026-10-10' }), NOW.toISOString()); // SHA-005
    expect(text(db)).toBe(
      [
        'Morning report · 23 Oct',
        '',
        '*Mehta Foods*: no open tasks',
        '',
        '*Sharma Interiors*: 5 open, 2 overdue',
        '• [client] SHA-005 Approve sitemap (due 21 Oct, overdue)',
        '• [client] SHA-002 Send logo files (due 20 Oct, overdue)',
        '• [us] SHA-003 Write about page (due today)',
        '',
        'Total: 5 open, 2 overdue · Built 23 Oct 06:00 IST',
      ].join('\n'),
    );
  });

  it('ranks high priority above older tasks and notes high priority, later deadlines and maybe done', () => {
    const db = seededDb();
    createTask(db, task({ title: 'Oldest', raisedOn: '2026-09-01' }), NOW.toISOString()); // SHA-001
    createTask(db, task({ title: 'Urgent one', priority: 'high', raisedOn: '2026-10-20' }), NOW.toISOString()); // SHA-002
    const maybe = createTask(db, task({ title: 'Maybe finished', deadline: '2026-10-30', raisedOn: '2026-10-02' }), NOW.toISOString()); // SHA-003
    setTaskStatus(db, maybe.id, 'maybe_done', TODAY, NOW.toISOString(), 'ai');
    const out = text(db);
    expect(out).toContain(
      ['*Sharma Interiors*: 3 open, 0 overdue', '• [us] SHA-002 Urgent one (high priority)', '• [us] SHA-001 Oldest', '• [us] SHA-003 Maybe finished (due 30 Oct, maybe done)'].join(
        '\n',
      ),
    );
  });

  it('shows a client whose tasks are all done as having no open tasks, and leaves done tasks out of the totals', () => {
    const db = seededDb();
    const done = createTask(db, task({ title: 'Share moodboard', deadline: '2026-10-01' }), NOW.toISOString());
    setTaskStatus(db, done.id, 'done', '2026-10-15', NOW.toISOString(), 'ai');
    const out = text(db);
    expect(out).toContain('*Sharma Interiors*: no open tasks');
    expect(out).not.toContain('Share moodboard');
    expect(out).toContain('Total: 0 open, 0 overdue');
  });

  it('leaves inactive clients out', () => {
    const db = seededDb();
    createTask(db, task({ clientId: 2, title: 'Mehta menu' }), NOW.toISOString());
    syncClients(db, [SHARMA]); // Mehta taken off the allow-list
    const out = text(db);
    expect(out).not.toContain('Mehta');
    expect(out).toContain('Total: 0 open, 0 overdue');
  });

  it('says so when there are no active clients', () => {
    const db = seededDb();
    syncClients(db, []);
    expect(text(db)).toBe(['Morning report · 23 Oct', '', 'No active clients.', '', 'Total: 0 open, 0 overdue · Built 23 Oct 06:00 IST'].join('\n'));
  });

  it('breaks a full tie by task id, whichever side each task is on', () => {
    const db = seededDb();
    createTask(db, task({ side: 'client', title: 'Client first' }), NOW.toISOString()); // SHA-001
    createTask(db, task({ title: 'Us second' }), NOW.toISOString()); // SHA-002
    createTask(db, task({ title: 'Us third' }), NOW.toISOString()); // SHA-003
    expect(text(db)).toContain(
      ['*Sharma Interiors*: 3 open, 0 overdue', '• [client] SHA-001 Client first', '• [us] SHA-002 Us second', '• [us] SHA-003 Us third'].join('\n'),
    );
  });

  it('leaves the tracker view it is given unchanged', () => {
    const db = seededDb();
    createTask(db, task({ title: 'Us high', priority: 'high' }), NOW.toISOString());
    createTask(db, task({ title: 'Us overdue', deadline: '2026-10-20' }), NOW.toISOString());
    createTask(db, task({ side: 'client', title: 'Client high', priority: 'high' }), NOW.toISOString());
    createTask(db, task({ side: 'client', title: 'Client overdue', priority: 'low', deadline: '2026-10-21' }), NOW.toISOString());
    const view = loadTrackerView(db, NOW, OK);
    const codes = () => view.clients.map((c) => [c.usOpen.map((t) => t.code), c.clientOpen.map((t) => t.code)]);
    const before = codes();
    expect(before.flat(2)).toHaveLength(4);
    buildMorningText(view, TODAY);
    expect(codes()).toEqual(before);
  });

  it('cuts long titles cleanly to one line', () => {
    const db = seededDb();
    createTask(db, task({ title: 'Revise the homepage banner so that it matches the new brand colours and the approved moodboard' }), NOW.toISOString());
    expect(text(db)).toContain('• [us] SHA-001 Revise the homepage banner so that it matches the new brand colours…');
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
