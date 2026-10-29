import type { ServerResponse } from 'node:http';
import type { SpendView } from '../app.ts';
import type { SettingsStore } from '../config/settingsStore.ts';
import { actionHandler, type ActionDeps } from '../control/actions.ts';
import type { AgentControl } from '../control/agentControl.ts';
import type { AccountOf } from '../control/meetingQueries.ts';
import type { HealthSnapshot } from '../health/health.ts';
import type { UptimeLog } from '../health/uptimeLog.ts';
import type { UptimeRobotClient } from '../health/uptimeRobot.ts';
import type { Db } from '../store/db.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import type { AuditLog } from './audit.ts';
import type { OwnerSession } from './guard.ts';
import { HttpError, sendJson } from './http.ts';
import { registerReadApi } from './routes/api.ts';
import { clientDetailHandler, clientsListHandler, type ClientsDeps } from './routes/clients.ts';
import type { ApiResult, AuditFn, OwnerContext } from './routes/context.ts';
import { registerControlApi } from './routes/controlScreens.ts';
import { CALLBACK_PATH, GoogleConnectRoutes, type GoogleConnectDeps } from './routes/google.ts';
import { groupsApplyHandler, groupsBulkHandler, groupsListHandler, suggestCodeHandler, type GroupsDeps } from './routes/groups.ts';
import { actionSession, readBody } from './routes/respond.ts';
import { WhatsAppLinkRoutes } from './routes/whatsapp.ts';
import { registerWorkApi } from './routes/work.ts';
import type { RequestContext } from './router.ts';
import { hashToken } from './sessions.ts';
import type { DashboardMount } from './start.ts';
import type { LinkSessions } from '../wa/linkSession.ts';

// Every agent route of the dashboard, registered behind D1's guard (startDashboard's mount). Reads need a signed-in
// owner; changes also the Origin and CSRF checks and the shared action limit (actionSession). The D2/D3 handlers are
// plain functions (src/web/routes/context.ts): they get the owner's context here and their ApiResult is sent as JSON.

export interface AgentRoutesDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  control: Pick<AgentControl, 'status' | 'overview' | 'connections'>;
  spend: SpendView;
  /** The live health snapshot, for the Tracker screen. */
  health: () => Pick<HealthSnapshot, 'line' | 'lastPublishedAt' | 'publishFailingSince'>;
  accountOf?: AccountOf;
  /** VOICE_STT_PROVIDER is local. */
  voiceLocal: boolean;
  uptime: { log: UptimeLog; robot?: UptimeRobotClient };
  /** DASHBOARD_OWNER_EMAILS (lower-cased). */
  ownerEmails: readonly string[];
  settings: Pick<SettingsStore, 'view' | 'set'>;
  groups: Omit<GroupsDeps, 'audit'>;
  clients: ClientsDeps;
  /** Google reconnect and add-account; the audit is bound here. */
  google: Omit<GoogleConnectDeps, 'audit'>;
  actions: Omit<ActionDeps, 'audit'>;
  links: LinkSessions;
}

/** The owner's context for a D2/D3 handler. sessionId is the session's hash, never the cookie value. */
const ownerOf = (ctx: RequestContext, s: OwnerSession): OwnerContext => ({ actor: s.email, sessionId: hashToken(s.id), requestId: ctx.requestId });

function send(res: ServerResponse, r: ApiResult): void {
  const retry = (r.body as { error?: { retryAfterSec?: unknown } } | null)?.error?.retryAfterSec;
  if (r.status === 429 && typeof retry === 'number') res.setHeader('Retry-After', String(retry));
  sendJson(res, r.status, r.body);
}

function redirect(res: ServerResponse, location: string): void {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

export function mountAgentRoutes(m: DashboardMount, d: AgentRoutesDeps): void {
  const { router, guard } = m;
  const owners = new Set(d.ownerEmails);
  const audit: AuditFn = (e) => m.audit.record({ ...e, detail: e.detail ?? '' });
  const action = { guard, actions: m.actions };

  registerReadApi(router, { guard, control: d.control });
  registerWorkApi(router, {
    ...action, db: d.db, clock: d.clock, audit: m.audit, spend: d.spend, health: d.health, ...(d.accountOf ? { accountOf: d.accountOf } : {}),
  });
  registerControlApi(router, {
    ...action, db: d.db, clock: d.clock, audit: m.audit, spend: d.spend, voiceLocal: d.voiceLocal, uptime: d.uptime,
    isOwner: (email) => owners.has(email.trim().toLowerCase()), settings: d.settings, sessions: m.sessions, secureFor: m.secureFor,
  });

  // An owner read: the guard first, then the handler.
  const read = (path: string, answer: (ctx: RequestContext, o: OwnerContext) => ApiResult | Promise<ApiResult>) =>
    router.get(path, async (ctx) => {
      const s = guard.requireOwner(ctx.req);
      send(ctx.res, await answer(ctx, ownerOf(ctx, s)));
    });
  // An owner change: guard, Origin and CSRF, the action limit, then the JSON body.
  const change = (path: string, answer: (ctx: RequestContext, o: OwnerContext, body: unknown) => ApiResult | Promise<ApiResult>) =>
    router.post(path, async (ctx) => {
      const s = actionSession(ctx, action);
      send(ctx.res, await answer(ctx, ownerOf(ctx, s), await readBody(ctx)));
    });

  // Clients and groups (D2).
  const groups: GroupsDeps = { ...d.groups, audit };
  read('/dashboard/api/groups', ({ url }, o) =>
    groupsListHandler(groups, o, { q: url.searchParams.get('q'), filter: url.searchParams.get('filter'), refresh: url.searchParams.get('refresh') }));
  change('/dashboard/api/groups/apply', (_ctx, o, body) => groupsApplyHandler(groups, o, body));
  change('/dashboard/api/groups/bulk', (_ctx, o, body) => groupsBulkHandler(groups, o, body));
  read('/dashboard/api/groups/suggest-code', ({ url }, o) => suggestCodeHandler(groups, o, url.searchParams.get('name') ?? ''));
  read('/dashboard/api/clients', (_ctx, o) => clientsListHandler(d.clients, o));
  read('/dashboard/api/clients/:code', ({ params }, o) => clientDetailHandler(d.clients, o, params.code!));

  // Google reconnect and add-account (D3).
  const google = new GoogleConnectRoutes({ ...d.google, audit });
  change('/dashboard/api/google/connect', (_ctx, o, body) => google.connect(o, body));
  // Google sends the browser back here: a top-level navigation, so every answer is a redirect, never JSON.
  router.get(CALLBACK_PATH, async (ctx) => {
    let s: OwnerSession;
    try {
      s = guard.requireOwner(ctx.req);
    } catch (err) {
      if (err instanceof HttpError) return redirect(ctx.res, '/dashboard');
      throw err;
    }
    const p = ctx.url.searchParams;
    let location: string;
    try {
      location = (await google.callback(ownerOf(ctx, s), { state: p.get('state'), code: p.get('code'), error: p.get('error') })).location;
    } catch (err) {
      d.log.error({ rid: ctx.requestId, err }, 'Google connect callback failed');
      location = '/dashboard/connections?google_error=internal';
    }
    redirect(ctx.res, location);
  });

  // Quick actions (D3): upload the tracker now, test Claude, send a test heartbeat. Each has its own limit as well.
  const actions: ActionDeps = { ...d.actions, audit };
  router.post('/dashboard/api/actions/:name', async (ctx) => {
    const s = actionSession(ctx, action);
    send(ctx.res, await actionHandler(ctx.params.name!, actions, ownerOf(ctx, s)));
  });

  // Phone links (D3): start, cancel, and the QR stream (server-sent events).
  const links = new WhatsAppLinkRoutes({ sessions: d.links });
  change('/dashboard/api/whatsapp/link/start', (_ctx, o, body) => links.start(o, body));
  change('/dashboard/api/whatsapp/link/cancel', (_ctx, o, body) => links.cancel(o, body));
  router.get('/dashboard/api/whatsapp/link/stream', async (ctx) => {
    const s = guard.requireOwner(ctx.req);
    const r = links.stream(ownerOf(ctx, s), ctx.url.searchParams.get('id') ?? '', ctx.res);
    if (r instanceof Promise) await r;
    else send(ctx.res, r);
  });
}
