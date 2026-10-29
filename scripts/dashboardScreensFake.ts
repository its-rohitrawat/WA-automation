// The work and control screens' API (Tasks, Meetings, Activity, Tracker, AI usage, Automations, Audit logs, Settings)
// for the smoke test and the local preview: the real route code (src/web/routes/work.ts and controlScreens.ts) on an
// in-memory database of made-up clients, tasks and meetings. No file is opened; nothing reaches the agent, WhatsApp,
// Google or any data folder. The owner session is the fake's flag, checked by a stand-in for D1's guard.
import { parseEnv } from '../src/config/env.ts';
import { PrioritySettings } from '../src/config/prioritySettings.ts';
import { SettingsStore } from '../src/config/settingsStore.ts';
import { UptimeLog } from '../src/health/uptimeLog.ts';
import { SpendGuard } from '../src/spend/spendGuard.ts';
import { TRACKER_ID_KEY, TRACKER_NEW_FILE_KEY } from '../src/output/trackerKey.ts';
import { syncClients } from '../src/store/clients.ts';
import { openDb } from '../src/store/db.ts';
import { setKv } from '../src/store/kv.ts';
import { insertFound } from '../src/store/meetings.ts';
import { createTask, PRIORITIES, SENTIMENTS } from '../src/store/tasks.ts';
import { systemClock } from '../src/util/clock.ts';
import { AuditLog } from '../src/web/audit.ts';
import type { Guard, OwnerSession } from '../src/web/guard.ts';
import { HttpError } from '../src/web/http.ts';
import { registerControlApi } from '../src/web/routes/controlScreens.ts';
import { registerWorkApi } from '../src/web/routes/work.ts';
import type { WebServer } from '../src/web/server.ts';

const PHASES = ['Discovery', 'Design', 'Development', 'Review', 'Launch'];
const OWNER = 'owner@example.com';
const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

/** Adds the screens' routes to the fake server. `signedIn` and `csrf` are the fake's own session flag and token. */
export function mountFakeScreens(web: WebServer, o: { signedIn: () => boolean; csrf: string }): void {
  const db = openDb(':memory:');
  const clock = systemClock;
  syncClients(db, [
    { groupId: '120363000000000101@g.us', name: 'Acme Traders', code: 'ACM', phases: PHASES, emailDomains: [], meetingKeywords: [] },
    { groupId: '120363000000000102@g.us', name: 'Mehta Foods <b>', code: 'MEH', phases: PHASES, emailDomains: [], meetingKeywords: [] },
  ]);
  const titles = ['Send the revised quote', 'Share moodboard v2', 'Confirm the launch date', 'Fix the footer on mobile', 'Book the photo shoot', 'A very long task title that goes on and on to check that nothing scrolls sideways on a phone'];
  titles.forEach((title, i) => createTask(db, {
    clientId: (i % 2) + 1, side: i % 3 === 0 ? 'client' : 'us', title, category: 'design', priority: PRIORITIES[i % PRIORITIES.length]!,
    prioritySource: i === 0 ? 'keyword' : 'ai', priorityKeyword: i === 0 ? 'urgent' : null, sentiment: SENTIMENTS[i % SENTIMENTS.length]!,
    assignedTo: i % 2 ? 'Rohit' : null, askedBy: null, raisedOn: day(i + 1).slice(0, 10), deadline: i < 2 ? day(i - 2).slice(0, 10) : null,
    latestProgress: null, sourceQuote: 'made-up words', sourceDate: day(i + 1).slice(0, 10), sourceWaId: null, origin: 'whatsapp',
  }, day(i + 1)));
  // One task from before priority levels: no level, shown as "—".
  db.prepare("UPDATE tasks SET priority_level = NULL, priority_source = NULL, sentiment = NULL WHERE id = 5").run();
  db.prepare("UPDATE clients SET sentiment = 'frustrated', sentiment_at = ? WHERE id = 1").run(day(0.1));
  insertFound(db, {
    recording: 'conferenceRecords/a/recordings/b', conference: 'conferenceRecords/a', driveFileId: 'd1', meetingCode: null, title: 'Weekly sync',
    startedAt: day(1), endedAt: null, attendees: [], participants: [], clientId: null, matchKind: null, status: 'unassigned', driveSeconds: 1800, createdAt: day(1),
  });
  // A tracker that had to be started again after the Google login changed, written as the main account's made-up email.
  setKv(db, TRACKER_ID_KEY, '1FakeTrackerFileId_000');
  setKv(db, TRACKER_NEW_FILE_KEY, day(1));
  setKv(db, 'google_account_email:main', OWNER);
  const audit = new AuditLog(db, clock);
  audit.record({ actor: OWNER, event: 'Task closed · ACM-001', kind: 'task', detail: 'Closed from the dashboard' });
  audit.record({ actor: 'agent', event: 'Tracker uploaded', kind: 'ops', detail: 'Tracker.xlsx uploaded to Drive' });
  const spend = new SpendGuard({ db, clock, capUsd: 3 });
  spend.record('ai', 0.42, 'batch');
  // Made-up outages for the uptime strip's exact times: one this morning, one around midnight two days ago.
  const put = db.prepare('INSERT INTO uptime_log (at, up, reason) VALUES (?, ?, ?)');
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  for (const [h, up, reason] of [[60, 1, null], [48.5, 0, 'whatsapp_disconnected'], [48, 1, null], [6, 0, 'stopped'], [1.7, 1, null]] as const) put.run(hoursAgo(h), up, reason);
  const uptime = new UptimeLog(db, clock);
  uptime.start(true);
  // The briefing is on from .env (the spare phone's link is gone in the fake), so the screen shows the next report.
  const settings = new SettingsStore({ db, env: parseEnv({ REPORT_ENABLED: 'true', REPORT_RECIPIENT: '919800000000' }), clock, spareLinked: () => false });
  // Sentiment on, so every screen shows the moods; the switch on Settings turns it off again.
  const priority = new PrioritySettings({ db, clock });
  priority.set('sentimentEnabled', true, OWNER, () => {});

  const session = (): OwnerSession => {
    if (!o.signedIn()) throw new HttpError(401, 'unauthenticated', 'Sign in first.');
    const now = new Date();
    return { id: 'fake', email: OWNER, csrfHash: '', createdAt: new Date(now.getTime() - 300_000).toISOString(), expiresAt: new Date(now.getTime() + 6 * 86_400_000).toISOString() };
  };
  const guard: Pick<Guard, 'requireOwner' | 'requireCsrf'> = {
    requireOwner: () => session(),
    requireCsrf: (req) => {
      if (req.headers['x-csrf-token'] !== o.csrf) throw new HttpError(403, 'csrf', 'Refused.');
    },
  };
  const action = { guard, actions: { hit: () => {} } };
  registerWorkApi(web.router, { ...action, db, clock, audit, spend, health: () => ({ line: { ok: true, text: 'All good' }, lastPublishedAt: day(0.01), publishFailingSince: null }) });
  registerControlApi(web.router, {
    ...action, db, clock, audit, spend, voiceLocal: true, uptime: { log: uptime }, isOwner: (e) => e === OWNER, settings, priority,
    sessions: { destroyAllFor: () => 0 }, secureFor: () => false,
  });
}
