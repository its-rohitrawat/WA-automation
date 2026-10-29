// The work and control screens' API (Tasks, Meetings, Activity, Tracker, AI usage, Automations, Audit logs, Settings)
// for the smoke test and the local preview: the real route code (src/web/routes/work.ts and controlScreens.ts) on an
// in-memory database of made-up clients, tasks and meetings. No file is opened; nothing reaches the agent, WhatsApp,
// Google or any data folder. The owner session is the fake's flag, checked by a stand-in for D1's guard.
import type { ServerResponse } from 'node:http';
import { parseEnv } from '../src/config/env.ts';
import { PrioritySettings } from '../src/config/prioritySettings.ts';
import { SettingsStore } from '../src/config/settingsStore.ts';
import { UptimeLog } from '../src/health/uptimeLog.ts';
import { SpendGuard } from '../src/spend/spendGuard.ts';
import { TRACKER_ID_KEY, TRACKER_NEW_FILE_KEY } from '../src/output/trackerKey.ts';
import { syncClients } from '../src/store/clients.ts';
import { openDb, type Db } from '../src/store/db.ts';
import { setKv } from '../src/store/kv.ts';
import { insertFound } from '../src/store/meetings.ts';
import { insertMessage } from '../src/store/messages.ts';
import { upsertPerson } from '../src/store/people.ts';
import { createTask, PRIORITIES, SENTIMENTS } from '../src/store/tasks.ts';
import { systemClock } from '../src/util/clock.ts';
import { silentLogger } from '../src/util/logger.ts';
import { AuditLog } from '../src/web/audit.ts';
import type { Guard, OwnerSession } from '../src/web/guard.ts';
import { HttpError } from '../src/web/http.ts';
import { chatReadHandler, chatSendHandler, type ChatDeps } from '../src/web/routes/chat.ts';
import { registerControlApi } from '../src/web/routes/controlScreens.ts';
import { registerWorkApi } from '../src/web/routes/work.ts';
import { Assistant } from '../src/assistant/assistant.ts';
import { PendingActions } from '../src/assistant/proposals.ts';
import { registerAssistantApi } from '../src/web/routes/assistant.ts';
import { ScriptedAssistantAi } from './assistantFake.ts';
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
  // The assistant with a scripted Claude (scripts/assistantFake.ts): no API call is ever made.
  const pending = new PendingActions(clock);
  const status = { at: day(0), up: true, line: { ok: true, text: 'All good' }, parts: [], lastMessageAt: day(0.01), spentToday: 0.42, capUsd: 3 };
  const assistant = new Assistant({
    ai: new ScriptedAssistantAi(), paid: spend, prices: { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.4 }, pending, settings,
    log: silentLogger(), clock, db, control: { status: () => status }, spend, voiceLocal: true,
  });
  registerAssistantApi(web.router, { ...action, db, clock, assistant, pending, settings, audit });

  // Open chat: the real chat routes (src/web/routes/chat.ts) on this database, with a stand-in socket that reaches no
  // one. It answers with a made-up message id and, a moment later, stores the founder's own copy, as WhatsApp does.
  seedChat(db);
  const ACME = '120363000000000101@g.us';
  let sent = 0;
  const socket = {
    sendMessage: async (_jid: string, content: { text: string }) => {
      const id = `FAKESENT${String(++sent).padStart(12, '0')}`;
      setTimeout(() => {
        insertMessage(db, { waId: id, clientId: 1, senderJid: 'me', senderNumber: null, senderName: null, fromMe: true, ts: new Date().toISOString(), text: content.text, quotedWaId: null, mediaType: null });
      }, 1500);
      return { key: { id } };
    },
  };
  const chat: ChatDeps = {
    db, clock, configs: () => [
      { groupId: ACME, name: 'Acme Traders', code: 'ACM', phases: PHASES, emailDomains: [], meetingKeywords: [] },
      { groupId: '120363000000000102@g.us', name: 'Mehta Foods <b>', code: 'MEH', phases: PHASES, emailDomains: [], meetingKeywords: [] },
    ],
    sendingOn: () => settings.get().dashboardSend, connected: () => true,
    groupSocket: (groupId) => (groupId === ACME ? socket : null),
    directory: { cachedGroups: () => [{ id: ACME, subject: 'Acme Traders x Studio' }] },
    audit: (e) => audit.record({ ...e, detail: e.detail ?? '' }), log: silentLogger(),
  };
  const ownerCtx = { actor: OWNER, sessionId: 'fake', requestId: 'fake00000000' };
  const answer = (res: ServerResponse, r: { status: number; body: unknown }) => {
    res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(r.body));
  };
  web.router.get('/dashboard/api/clients/:code/chat', ({ req, res, params, url }) => {
    guard.requireOwner(req);
    answer(res, chatReadHandler(chat, ownerCtx, params.code ?? '', { before: url.searchParams.get('before'), limit: url.searchParams.get('limit') }));
  });
  web.router.post('/dashboard/api/clients/:code/chat/send', async ({ req, res, params }) => {
    guard.requireCsrf(req, guard.requireOwner(req));
    let body: unknown = null;
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      body = null;
    }
    answer(res, await chatSendHandler(chat, ownerCtx, params.code ?? '', body));
  });
}

/** About 70 made-up messages in Acme's group over three days: names, a photo, a file, a voice note with its words, a reply, a deleted one. */
function seedChat(db: Db): void {
  const people: [string, string][] = [['919800000011@s.whatsapp.net', 'Rahul Kapoor'], ['919800000012@s.whatsapp.net', 'Neha'], ['919800000013@s.whatsapp.net', 'Ajay Jain']];
  for (const [jid, name] of people) upsertPerson(db, { clientId: 1, jid, number: null, name, fromMe: false });
  const lines = [
    'Morning! Did the revised quote go out?', 'Sending it today after lunch.', 'Can we move the site visit to Thursday?', 'Thursday works for us.',
    'Sharing the moodboard v2 now', 'Looks great, small change on the colours', 'Will update and resend by evening', 'Thanks!',
    'Please check the footer on mobile, it overlaps', 'Noted, fixing it', 'नमस्ते, कल की मीटिंग 11 बजे है', 'Done ✅ footer fixed 👍',
  ];
  let n = 0;
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const put = (o: { minutesAgo: number; who: number; text: string | null; media?: string; quoted?: string }) => {
    const waId = `FAKEMSG${String(++n).padStart(13, '0')}`;
    const mine = o.who === -1;
    const jid = mine ? 'me' : people[o.who]![0];
    insertMessage(db, { waId, clientId: 1, senderJid: jid, senderNumber: null, senderName: null, fromMe: mine, ts: at(o.minutesAgo), text: o.text, quotedWaId: o.quoted ?? null, mediaType: o.media ?? null });
    return waId;
  };
  for (let i = 0; i < 60; i++) put({ minutesAgo: 3 * 24 * 60 - i * 70, who: i % 4 === 3 ? -1 : i % 3, text: lines[i % lines.length]! });
  const photo = put({ minutesAgo: 95, who: 0, text: 'Site photos from today', media: 'image' });
  const voice = put({ minutesAgo: 80, who: 2, text: null, media: 'voice' });
  const rowId = (waId: string) => (db.prepare('SELECT id FROM messages WHERE wa_id = ?').get(waId) as { id: number }).id;
  const stamp = at(80);
  db.prepare("INSERT INTO media (message_id, client_id, kind, status, created_at, updated_at) VALUES (?, 1, 'image', 'done', ?, ?)").run(rowId(photo), stamp, stamp);
  db.prepare("INSERT INTO media (message_id, client_id, kind, status, seconds, text_kind, text, created_at, updated_at) VALUES (?, 1, 'voice', 'done', 42, 'extract', ?, ?, ?)")
    .run(rowId(voice), 'Hi, I checked the samples. The blue one works, please go ahead with it and send the final invoice.', stamp, stamp);
  put({ minutesAgo: 70, who: 1, text: 'Quote attached', media: 'document' });
  const gone = put({ minutesAgo: 60, who: 1, text: 'wrong group, sorry' });
  db.prepare('UPDATE messages SET revoked = 1 WHERE wa_id = ?').run(gone);
  put({ minutesAgo: 45, who: -1, text: 'Going with the blue one 👍', quoted: voice });
  put({ minutesAgo: 30, who: 0, text: 'Text with <b>tags</b> stays text, and a very long line that has to wrap inside the bubble on a phone without scrolling sideways at all' });
  const edited = put({ minutesAgo: 12, who: 2, text: 'See you at 11 tomorrow\nAddress: 2nd floor, the usual place' });
  db.prepare('UPDATE messages SET edited_at = ? WHERE wa_id = ?').run(at(11), edited);
}
