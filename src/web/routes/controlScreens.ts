import type { SpendView } from '../../app.ts';
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
import { sendJson, serializeCookie } from '../http.ts';
import type { Router } from '../router.ts';
import { SESSION_COOKIE, type SessionStore } from '../sessions.ts';
import { actionSession, controlled, readBody, type ActionGuard } from './respond.ts';

// The control screens' API (D5 Task 1-4 logic, served here): AI usage, uptime, audit logs, the morning briefing's
// settings and the owner's session. Reads need a signed-in owner; changes also the Origin and CSRF checks and the action
// rate limit. The founder's number is never sent back: settings answer with settings.view(), masked.

export interface ControlApiDeps extends ActionGuard {
  guard: Pick<Guard, 'requireOwner' | 'requireCsrf'>;
  db: Db;
  clock: Clock;
  audit: Pick<AuditLog, 'record'>;
  spend: SpendView;
  /** VOICE_STT_PROVIDER is local: voice notes show at $0. */
  voiceLocal: boolean;
  uptime: { log: UptimeLog; robot?: UptimeRobotClient };
  /** Whether an email is in DASHBOARD_OWNER_EMAILS: the audit screen shows only owners' emails in full. */
  isOwner: (email: string) => boolean;
  settings: Pick<SettingsStore, 'view' | 'set'>;
  sessions: Pick<SessionStore, 'destroyAllFor'>;
}

const digits = (v: unknown) => (typeof v === 'string' ? v.replace(/\D/g, '') : '');

export function registerControlApi(router: Router, d: ControlApiDeps): void {
  const read = (path: string, answer: (ctx: Parameters<Parameters<Router['get']>[1]>[0]) => unknown) =>
    router.get(path, controlled(async (ctx) => {
      d.guard.requireOwner(ctx.req);
      sendJson(ctx.res, 200, await answer(ctx));
    }));
  const auditFor = (actor: string, requestId: string) => (e: AuditEntry) => d.audit.record({ ...e, actor, requestId });

  read('/dashboard/api/usage', () => usageSummary(d.db, d.spend, d.clock.now(), { voiceLocal: d.voiceLocal }));
  read('/dashboard/api/uptime', () => uptimeReport({ log: d.uptime.log, robot: d.uptime.robot, now: d.clock.now() }));
  read('/dashboard/api/audit', ({ url }) => listAudit(d.db, parseAuditParams(url.searchParams), d.isOwner));
  read('/dashboard/api/settings', () => d.settings.view());

  router.post('/dashboard/api/settings', controlled(async (ctx) => {
    const s = actionSession(ctx, d);
    const body = await readBody(ctx);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ControlError(422, 'Send the setting as a JSON object', 'body');
    const { key, value, confirm } = body as Record<string, unknown>;
    if (typeof key !== 'string') throw new ControlError(422, 'key must be the name of a setting', 'key');
    // The founder's number is typed twice; the two must be the same number.
    if (key === 'reportRecipient' && (digits(value) === '' || digits(value) !== digits(confirm))) {
      throw new ControlError(422, 'The two numbers do not match', 'confirm');
    }
    d.settings.set(key, value, s.email, auditFor(s.email, ctx.requestId));
    sendJson(ctx.res, 200, d.settings.view());
  }));

  read('/dashboard/api/session', ({ req }) => {
    const s = d.guard.requireOwner(req);
    return { email: s.email, createdAt: s.createdAt, expiresAt: s.expiresAt };
  });

  router.post('/dashboard/api/session/signout-everywhere', controlled((ctx) => {
    const s = actionSession(ctx, d);
    const ended = d.sessions.destroyAllFor(s.email);
    d.audit.record({ actor: s.email, event: 'auth.signout_everywhere', kind: 'auth', detail: `Signed out everywhere (${ended} ${ended === 1 ? 'session' : 'sessions'})`, requestId: ctx.requestId });
    ctx.res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'Lax', path: '/dashboard', maxAge: 0 }));
    sendJson(ctx.res, 200, { ended });
  }));
}
