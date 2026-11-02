import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/config/env.ts';
import { SettingsStore } from '../../src/config/settingsStore.ts';
import { loadTrackerView, type TrackerView } from '../../src/output/view.ts';
import { briefingSettings } from '../../src/report/dashboardReport.ts';
import { LiveReport } from '../../src/report/liveReport.ts';
import {
  buildShortMorningText, DEFAULT_MESSAGE, fillMessage, MESSAGE_MAX_CHARS, MESSAGE_PLACEHOLDERS, messageEditorView, messageProblem, messageValues,
  normalizeMessage, TRACKER_ID_KEY,
} from '../../src/report/morningReport.ts';
import { ReportScheduler } from '../../src/report/scheduler.ts';
import type { ReportSettings } from '../../src/report/types.ts';
import { syncClients } from '../../src/store/clients.ts';
import type { Db } from '../../src/store/db.ts';
import { setKv } from '../../src/store/kv.ts';
import { createTask, type NewTask } from '../../src/store/tasks.ts';
import { manualClock } from '../../src/util/clock.ts';
import { silentLogger } from '../../src/util/logger.ts';
import { idOf, seededDb } from '../helpers/db.ts';
import { FakeReportSender } from '../helpers/fakeReportSender.ts';

// The morning message editor (November release, change 5): the owner's own text with placeholders the report fills in.

const NOW = new Date('2026-10-23T00:30:00.000Z'); // Friday 23 Oct, 06:00 IST
const TODAY = '2026-10-23';
const OK = { ok: true, text: '✅ Connected' };
const TRACKER_ID = '1AbCdEfGhIjKlMnOp_qRsTuV-wxyz0123';
const LINK = `https://drive.google.com/file/d/${TRACKER_ID}/view`;
const ON: ReportSettings = { enabled: true, time: '06:00', deadline: '12:00', days: 'weekdays' };

const task = async (db: Db, o: Partial<Omit<NewTask, 'clientId'>> & { client?: 'SHA' | 'MEH' } = {}): Promise<NewTask> => {
  const { client, ...rest } = o;
  return {
    clientId: await idOf(db, client ?? 'SHA'), side: 'us', title: 'A task', category: 'design', priority: 'medium', assignedTo: null, askedBy: null,
    raisedOn: '2026-10-01', deadline: null, latestProgress: null, sourceQuote: null, sourceDate: null, sourceWaId: null, origin: 'whatsapp', ...rest,
  };
};

/** Sharma: a critical task, one due today, one overdue (client side). Mehta: one plain task. */
async function busyDb(): Promise<Db> {
  const db = await seededDb();
  await createTask(db, await task(db, { title: 'Secret banner work', priority: 'critical' }), NOW.toISOString());
  await createTask(db, await task(db, { title: 'About page', deadline: TODAY }), NOW.toISOString());
  await createTask(db, await task(db, { side: 'client', title: 'Send logo files', deadline: '2026-10-20' }), NOW.toISOString());
  await createTask(db, await task(db, { client: 'MEH', title: 'Print menu' }), NOW.toISOString());
  return db;
}
const view = (db: Db): Promise<TrackerView> => loadTrackerView(db, NOW, OK);

describe('fillMessage', () => {
  const values = { greeting: 'Good morning', open: '5', tracker_link: LINK };

  it('fills each placeholder it knows, in one pass, and sends any other text as written', () => {
    expect(fillMessage('{greeting}! {open} open. {tracker_link}', values)).toBe(`Good morning! 5 open. ${LINK}`);
    expect(fillMessage('{name}, {Open}, { open }, {open, {}, {{open}}', values)).toBe('{name}, {Open}, { open }, {open, {}, {5}');
    // A value is never read again as a placeholder.
    expect(fillMessage('{a}', { a: '{open}', open: '5' })).toBe('{open}');
    expect(fillMessage('', values)).toBe('');
  });

  it('never throws, whatever the text', () => {
    for (const t of ['{', '}', '{{{{', '\\{open\\}', '{__proto__}', '{constructor}', '{toString}']) expect(() => fillMessage(t, values)).not.toThrow();
    expect(fillMessage('{constructor} {toString} {__proto__}', values)).toBe('{constructor} {toString} {__proto__}');
  });
});

describe('messageValues and the default message', () => {
  it('has a value for every placeholder the editor lists, from today\'s tracker view', async () => {
    const db = await busyDb();
    const v = messageValues(await view(db), TODAY, LINK);
    expect(Object.keys(v).sort()).toEqual(MESSAGE_PLACEHOLDERS.map((p) => p.key).sort());
    expect(v).toEqual({
      greeting: 'Good morning', date: 'Fri 23 Oct', summary: '1 critical, 4 open tasks, 1 overdue', open: '4', overdue: '1', critical: '1',
      due_today: '1', clients: '2', tracker_link: LINK,
    });
  });

  it('the default text is the message as it was before the editor, word for word', async () => {
    const db = await busyDb();
    const v = await view(db);
    expect(DEFAULT_MESSAGE).toBe("{greeting}. {summary}. Today's tracker: {tracker_link}");
    expect(buildShortMorningText(v, TODAY, LINK)).toBe(`Good morning. 1 critical, 4 open tasks, 1 overdue. Today's tracker: ${LINK}`);
    expect(buildShortMorningText(v, TODAY, LINK, DEFAULT_MESSAGE)).toBe(buildShortMorningText(v, TODAY, LINK));
    await syncClients(db, []);
    expect(buildShortMorningText(await view(db), TODAY, LINK)).toBe(`Good morning. No open tasks. Today's tracker: ${LINK}`);
    expect(messageValues(await view(db), TODAY, LINK)).toMatchObject({ summary: 'No open tasks', open: '0', overdue: '0', clients: '0' });
  });

  it('builds the owner\'s own text, line breaks kept, with no client name or task title in the values', async () => {
    const db = await busyDb();
    const text = buildShortMorningText(await view(db), TODAY, LINK, '{greeting}, {date}\n{open} open, {due_today} due today, {critical} critical\n{tracker_link} {unknown}');
    expect(text).toBe(`Good morning, Fri 23 Oct\n4 open, 1 due today, 1 critical\n${LINK} {unknown}`);
    expect(JSON.stringify(messageValues(await view(db), TODAY, LINK))).not.toMatch(/Sharma|Mehta|Secret|SHA-/);
  });
});

describe('messageProblem and normalizeMessage (the server-side check)', () => {
  it('accepts text with line breaks up to the limit, counting an emoji as one character', () => {
    expect(messageProblem('Hello {open}\nBye')).toBeNull();
    expect(messageProblem('😀'.repeat(MESSAGE_MAX_CHARS))).toBeNull();
    expect(MESSAGE_MAX_CHARS).toBe(1000);
  });

  it('refuses what is not text, blank text, text over the limit and control characters other than a line break', () => {
    expect(messageProblem(42)).toBe('The message must be text');
    expect(messageProblem(null)).toBe('The message must be text');
    expect(messageProblem(' \n ')).toBe('Write the message, or reset it to the default');
    expect(messageProblem('x'.repeat(MESSAGE_MAX_CHARS + 1))).toBe('The message can be at most 1000 characters');
    for (const bad of ['a\u0007b', 'a\tb', 'a\u0000b', 'a\u007fb', 'a\u009bb']) {
      expect(messageProblem(bad), JSON.stringify(bad)).toBe('The message can have line breaks, but no other control characters');
    }
  });

  it('keeps Windows line breaks as plain ones and trims the ends', () => {
    expect(normalizeMessage('  Hi\r\nthere\r ')).toBe('Hi\nthere');
    expect(messageProblem('Hi\r\nthere')).toBeNull();
  });
});

describe('messageEditorView (GET /dashboard/api/settings/report-message)', () => {
  it('gives the text in force, the default, the limit and each placeholder with today\'s real value', async () => {
    const db = await busyDb();
    await setKv(db, TRACKER_ID_KEY, TRACKER_ID);
    const e = await messageEditorView(db, NOW, undefined);
    expect(e).toMatchObject({ template: DEFAULT_MESSAGE, isDefault: true, defaultTemplate: DEFAULT_MESSAGE, maxChars: 1000, trackerLinked: true });
    expect(e.placeholders.map((p) => p.key)).toEqual(MESSAGE_PLACEHOLDERS.map((p) => p.key));
    expect(e.placeholders.find((p) => p.key === 'open')).toEqual({ key: 'open', hint: 'Open tasks', value: '4' });
    expect(e.placeholders.find((p) => p.key === 'tracker_link')?.value).toBe(LINK);
    expect(await messageEditorView(db, NOW, 'Hi {open}')).toMatchObject({ template: 'Hi {open}', isDefault: false });
  });

  it('before the tracker is on Drive, says so and shows a stand-in for the link', async () => {
    const db = await busyDb();
    const e = await messageEditorView(db, NOW, undefined);
    expect(e.trackerLinked).toBe(false);
    expect(e.placeholders.find((p) => p.key === 'tracker_link')?.value).toBe("(today's tracker link)");
  });
});

describe('the 08:00 send uses the saved text', () => {
  async function scheduler(message?: () => string | undefined) {
    const db = await busyDb();
    await setKv(db, TRACKER_ID_KEY, TRACKER_ID);
    const clock = manualClock(NOW);
    const sender = new FakeReportSender();
    const s = new ReportScheduler({ db, clock, log: silentLogger(), sender, settings: ON, healthLine: () => OK, ...(message ? { message } : {}) });
    await s.recover();
    await s.tick(clock.now());
    return sender.calls.map((c) => c.text);
  }

  it('sends the owner\'s text filled in, an unknown placeholder as written', async () => {
    expect(await scheduler(() => '{greeting}! {open} open, {overdue} overdue. {nope} {tracker_link}')).toEqual([`Good morning! 4 open, 1 overdue. {nope} ${LINK}`]);
  });

  it('sends the default text with no saved text, and when reading or using the saved text fails', async () => {
    const plain = `Good morning. 1 critical, 4 open tasks, 1 overdue. Today's tracker: ${LINK}`;
    expect(await scheduler()).toEqual([plain]);
    expect(await scheduler(() => undefined)).toEqual([plain]);
    expect(await scheduler(() => {
      throw new Error('settings unreadable');
    })).toEqual([plain]);
    expect(await scheduler(() => 'bad \u0007 text')).toEqual([plain]);
    expect(await scheduler(() => '   ')).toEqual([plain]);
  });

  it('goes from the settings store through LiveReport to the sender', async () => {
    const db = await busyDb();
    await setKv(db, TRACKER_ID_KEY, TRACKER_ID);
    const clock = manualClock(NOW);
    const store = await SettingsStore.open({
      db, env: parseEnv({ REPORT_ENABLED: 'true', REPORT_RECIPIENT: '919812345678', REPORT_TIME: '06:00' }), clock, spareLinked: () => true,
    });
    await store.set('reportMessage', 'Hi. {open} open today. {tracker_link}', 'owner@example.com', async () => undefined);
    expect(briefingSettings(store)()).toMatchObject({ message: 'Hi. {open} open today. {tracker_link}' });
    const sender = new FakeReportSender();
    const live = new LiveReport({
      db, clock, log: silentLogger(), healthLine: () => OK, settings: briefingSettings(store), open: async () => ({ sender, close: async () => undefined }),
    });
    await live.tick(clock.now());
    expect(sender.calls.map((c) => c.text)).toEqual([`Hi. 4 open today. ${LINK}`]);
    await live.stop();
  });
});
