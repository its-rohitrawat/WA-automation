import type { IncomingMessage } from 'node:http';
import type { SpendView } from '../../app.ts';
import type { PrioritySettings } from '../../config/prioritySettings.ts';
import type { SettingsStore } from '../../config/settingsStore.ts';
import { listAudit, parseAuditParams } from '../../control/auditQueries.ts';
import { ControlError, type AuditEntry } from '../../control/errors.ts';
import { usageSummary } from '../../control/usage.ts';
import type { UptimeLog } from '../../health/uptimeLog.ts';
import { uptimeReport, type UptimeRobotClient } from '../../health/uptimeRobot.ts';
import type { Db } from '../../store/db.ts';
import type { Clock } from '../../util/clock.ts';
import type { AuditLog } from '../audit.ts';
import type { Guard } from '../guard.ts';
import { sendJson } from '../http.ts';
import type { Router } from '../router.ts';
import { clearSessionCookie, hashToken, type SessionStore } from '../sessions.ts';
import { actionSession, controlled, readBody, type ActionGuard } from './respond.ts';

// The control screens' API (D5 Task 1-4 logic, served here): AI usage, uptime, audit logs, the morning briefing's
// settings and the owner's session. Reads need a signed-in owner; changes also the Origin and CSRF checks and the action
// rate limit. The founder's number is never sent back: settings answer with settings.view(), masked.

export interface ControlApiDeps extends ActionGuard {
  guard: Pick<Guard, 'requireOwner' | 'requireCsrf'>;
  db: Db;
  clock: Clock;
  audit: Pick<AuditLog, 'record' | 'recordSync'>;
  spend: SpendView;
  /** VOICE_STT_PROVIDER is local: voice notes show at $0. */
  voiceLocal: boolean;
  uptime: { log: UptimeLog; robot?: UptimeRobotClient };
  /** Whether an email is in DASHBOARD_OWNER_EMAILS: the audit screen shows only owners' emails in full. */
  isOwner: (email: string) => boolean;
  settings: Pick<SettingsStore, 'view' | 'set'>;
  /** The priority keywords and the sentiment switch (Settings screen). */
  priority: Pick<PrioritySettings, 'view' | 'set'>;
  sessions: Pick<SessionStore, 'destroyAllFor'>;
  /**
   * Whether this request came in over the https public address (secureRequest): the session cookie is cleared with the
   * attributes sign-in set it with, so a browser on http://localhost (where Secure cookies are dropped) is signed out too.
   */
  secureFor: (req: IncomingMessage) => boolean;
}

const digits = (v: unknown) => (typeof v === 'string' ? v.replace(/\D/g, '') : '');

export function registerControlApi(router: Router, d: ControlApiDeps): void {
  const read = (path: string, answer: (ctx: Parameters<Parameters<Router['get']>[1]>[0]) => unknown) =>
    router.get(path, controlled(async (ctx) => {
      await d.guard.requireOwner(ctx.req);
      sendJson(ctx.res, 200, await answer(ctx));
    }));
  const auditFor = (actor: string, requestId: string) => (e: AuditEntry) => d.audit.recordSync({ ...e, actor, requestId });

  read('/dashboard/api/usage', async () => await usageSummary(d.db, d.spend, d.clock.now(), { voiceLocal: d.voiceLocal }));
  read('/dashboard/api/uptime', () => uptimeReport({ log: d.uptime.log, robot: d.uptime.robot, now: d.clock.now() }));
  read('/dashboard/api/audit', async ({ url }) => await listAudit(d.db, parseAuditParams(url.searchParams), d.isOwner));
  read('/dashboard/api/settings', () => d.settings.view());

  router.post('/dashboard/api/settings', controlled(async (ctx) => {
    const s = await actionSession(ctx, d);
    const body = await readBody(ctx);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ControlError(422, 'Send the setting as a JSON object', 'body');
    const { key, value, confirm } = body as Record<string, unknown>;
    if (typeof key !== 'string') throw new ControlError(422, 'key must be the name of a setting', 'key');
    // The founder's number is typed twice; the two must be the same number.
    if (key === 'reportRecipient' && (digits(value) === '' || digits(value) !== digits(confirm))) {
      throw new ControlError(422, 'The two numbers do not match', 'confirm');
    }
    // Switching the briefing on starts messages to the founder: the dashboard's confirmation step must come with it.
    if (key === 'reportEnabled' && value === true && confirm !== true) {
      throw new ControlError(422, 'Confirm that the morning briefing should start sending', 'confirm');
    }
    // Sending from the dashboard puts messages on the founder's WhatsApp: the warning must have been confirmed.
    if (key === 'dashboardSend' && value === true && confirm !== true) {
      throw new ControlError(422, "Confirm that the dashboard may send from the founder's WhatsApp", 'confirm');
    }
    d.settings.set(key, value, s.email, auditFor(s.email, ctx.requestId));
    sendJson(ctx.res, 200, d.settings.view());
  }));

  // Priority keywords and the sentiment switch: the owner's own words and a boolean, checked by PrioritySettings.set.
  read('/dashboard/api/settings/priority', () => d.priority.view());
  router.post('/dashboard/api/settings/priority', controlled(async (ctx) => {
    const s = await actionSession(ctx, d);
    const body = await readBody(ctx);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ControlError(422, 'Send the setting as a JSON object', 'body');
    const { key, value } = body as Record<string, unknown>;
    if (typeof key !== 'string') throw new ControlError(422, 'key must be the name of a setting', 'key');
    sendJson(ctx.res, 200, d.priority.set(key, value, s.email, auditFor(s.email, ctx.requestId)));
  }));

  read('/dashboard/api/session', async ({ req }) => {
    const s = await d.guard.requireOwner(req);
    // The browser label sign-in saved (cleaned there, for example "Safari on macOS"); null for an older session.
    const row = await d.db.get<{ agent_label: string | null }>('SELECT agent_label FROM web_sessions WHERE id_hash = ?', [hashToken(s.id)]);
    return { email: s.email, createdAt: s.createdAt, expiresAt: s.expiresAt, browser: row?.agent_label ?? null };
  });

  router.post('/dashboard/api/session/signout-everywhere', controlled(async (ctx) => {
    const s = await actionSession(ctx, d);
    // The sessions end and the audit row is written together: if the row cannot be written, nothing ends.
    const ended = await d.db.tx(async (q) => {
      const n = await d.sessions.destroyAllFor(s.email, q);
      await d.audit.record({ actor: s.email, event: 'auth.signout_everywhere', kind: 'auth', detail: `Signed out everywhere (${n} ${n === 1 ? 'session' : 'sessions'})`, requestId: ctx.requestId }, q);
      return n;
    });
    ctx.res.setHeader('Set-Cookie', clearSessionCookie({ secure: d.secureFor(ctx.req) }));
    sendJson(ctx.res, 200, { ended });
  }));
}
