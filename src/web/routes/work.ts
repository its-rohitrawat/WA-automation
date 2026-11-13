import type { SpendView } from '../../app.ts';
import { listActivity, parseActivityParams } from '../../control/activityQueries.ts';
import type { AuditEntry } from '../../control/errors.ts';
import { ControlError } from '../../control/errors.ts';
import { runMeetingAction } from '../../control/meetingActions.ts';
import { listDashboardMeetings, meetingDetail, parseMeetingList, type AccountOf } from '../../control/meetingQueries.ts';
import { runTaskAction } from '../../control/taskActions.ts';
import { listDashboardTasks, parseTaskQuery, taskDetail } from '../../control/taskQueries.ts';
import { trackerSummary } from '../../control/trackerQueries.ts';
import type { HealthSnapshot } from '../../health/health.ts';
import type { Db, Sql } from '../../store/db.ts';
import { XLSX_MIME } from '../../output/workbook.ts';
import type { Clock } from '../../util/clock.ts';
import { istDate } from '../../util/time.ts';
import type { Logger } from '../../util/logger.ts';
import type { AuditLog } from '../audit.ts';
import { sendJson } from '../http.ts';
import { RateLimiter, type Guard, type RateLimit } from '../guard.ts';
import type { Router } from '../router.ts';
import { actionSession, controlled, readBody, type ActionGuard } from './respond.ts';

// The work screens' API (D4 Task 1-5 logic, served here): Tasks, Meetings, Activity, Tracker. Reads need a signed-in
// owner; changes also need the Origin and CSRF checks and pass the action rate limit. Each change is the CLI's own
// correction, run with its audit line in one transaction (src/control/taskActions.ts, meetingActions.ts).

export interface WorkApiDeps extends ActionGuard {
  guard: Pick<Guard, 'requireOwner' | 'requireCsrf'>;
  db: Db;
  clock: Clock;
  audit: Pick<AuditLog, 'record'>;
  spend: Pick<SpendView, 'isPaused'>;
  /** The live health snapshot, for the Tracker screen. */
  health?: () => Pick<HealthSnapshot, 'line' | 'lastPublishedAt' | 'publishFailingSince'>;
  accountOf?: AccountOf;
  /**
   * This workspace's tracker workbook, built fresh for a download (App.trackerWorkbook). Left out in a setup shell: the
   * export then answers 503.
   */
  trackerWorkbook?: () => Promise<Buffer>;
  log?: Pick<Logger, 'warn'>;
  /** The export limit; EXPORT_LIMIT when not given. */
  exports?: Pick<RateLimiter, 'take' | 'retryAfter'>;
}

/** One tracker export per 10 seconds per signed-in owner. */
export const EXPORT_LIMIT: Readonly<RateLimit> = Object.freeze({ capacity: 1, refillPerSec: 1 / 10 });

const NOT_READY = 'The tracker is not ready yet. Try again in a moment.';
const EXPORT_FAILED = 'The tracker could not be exported. Try again in a moment.';

export function registerWorkApi(router: Router, d: WorkApiDeps): void {
  const read = (path: string, answer: (ctx: Parameters<Parameters<Router['get']>[1]>[0]) => unknown) =>
    router.get(path, controlled(async (ctx) => {
      await d.guard.requireOwner(ctx.req);
      sendJson(ctx.res, 200, await answer(ctx));
    }));
  const exportLimit = d.exports ?? new RateLimiter({ ...EXPORT_LIMIT, clock: d.clock });
  const auditFor = (actor: string, requestId: string) => (q: Sql, e: AuditEntry) => d.audit.record({ ...e, actor, requestId }, q);

  read('/dashboard/api/tasks', async ({ url }) => await listDashboardTasks(d.db, parseTaskQuery(url.searchParams), d.clock.now()));
  read('/dashboard/api/tasks/:code', async ({ params }) => {
    const t = await taskDetail(d.db, params.code!, d.clock.now());
    if (!t) throw new ControlError(404, 'No task with that code');
    return t;
  });
  router.post('/dashboard/api/tasks/:code/:action', controlled(async (ctx) => {
    const s = await actionSession(ctx, d);
    const body = ctx.params.action === 'edit' ? await readBody(ctx) : undefined;
    const detail = await runTaskAction(d.db, { code: ctx.params.code!, action: ctx.params.action!, body },
      { actor: s.email, now: d.clock.now(), audit: auditFor(s.email, ctx.requestId) });
    sendJson(ctx.res, 200, detail);
  }));

  read('/dashboard/api/meetings', async ({ url }) => await listDashboardMeetings(d.db, parseMeetingList(url.searchParams), d.clock.now(), d.accountOf));
  read('/dashboard/api/meetings/:id', async ({ params }) => {
    const m = await meetingDetail(d.db, params.id!, d.clock.now(), d.accountOf);
    if (!m) throw new ControlError(404, 'No meeting with that id');
    return m;
  });
  router.post('/dashboard/api/meetings/:id/:action', controlled(async (ctx) => {
    const s = await actionSession(ctx, d);
    const body = ctx.params.action === 'assign' ? await readBody(ctx) : undefined;
    const result = await runMeetingAction(d.db, { id: ctx.params.id!, action: ctx.params.action!, body }, {
      actor: s.email, now: d.clock.now(), audit: auditFor(s.email, ctx.requestId), spend: d.spend, ...(d.accountOf ? { accountOf: d.accountOf } : {}),
    });
    sendJson(ctx.res, 200, result);
  }));

  read('/dashboard/api/activity', async ({ url }) => await listActivity(d.db, parseActivityParams(url.searchParams)));
  read('/dashboard/api/tracker', async () => await trackerSummary(d.db, d.clock.now(), d.health?.()));

  // The whole tracker as an Excel file, built fresh (the same workbook as on Drive; nothing is uploaded). Read-only, so
  // no CSRF check; one a signed-in owner per 10 seconds, audited without any of the file's content.
  router.get('/dashboard/api/tracker/export', controlled(async (ctx) => {
    const s = await d.guard.requireOwner(ctx.req);
    if (!d.trackerWorkbook) return sendJson(ctx.res, 503, { error: { code: 'not_ready', message: NOT_READY } });
    if (!exportLimit.take(s.email)) {
      ctx.res.setHeader('Retry-After', String(exportLimit.retryAfter(s.email)));
      return sendJson(ctx.res, 429, { error: { code: 'rate_limited', message: 'One export every 10 seconds. Wait a moment and try again.' } });
    }
    let book: Buffer;
    try {
      book = await d.trackerWorkbook();
    } catch (e) {
      d.log?.warn({ code: (e as Error | null)?.name ?? 'Error', requestId: ctx.requestId }, 'tracker export could not be built');
      return sendJson(ctx.res, 500, { error: { code: 'internal', message: EXPORT_FAILED } });
    }
    await d.audit.record({ actor: s.email, kind: 'ops', requestId: ctx.requestId, event: 'tracker.export', detail: 'Tracker exported as an Excel file' });
    ctx.res.statusCode = 200;
    ctx.res.setHeader('Content-Type', XLSX_MIME);
    ctx.res.setHeader('Content-Disposition', `attachment; filename="Tracker-${istDate(d.clock.now())}.xlsx"`);
    ctx.res.setHeader('Cache-Control', 'no-store');
    ctx.res.setHeader('X-Content-Type-Options', 'nosniff');
    ctx.res.setHeader('Content-Length', book.length);
    ctx.res.end(book);
  }));
}
