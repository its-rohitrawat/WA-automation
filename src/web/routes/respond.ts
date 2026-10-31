import type { ServerResponse } from 'node:http';
import { ControlError } from '../../control/errors.ts';
import { readJson, sendJson } from '../http.ts';
import type { Guard, OwnerSession, RateLimiter } from '../guard.ts';
import type { RequestContext } from '../router.ts';

// Shared by the D4/D5 routes. A ControlError's message is fixed text (codes, ids, field names, allowed values), so it
// goes to the browser as it is, with the field a form shows it beside. Anything else is the server's plain 500.

const CODES: Record<ControlError['status'], string> = { 400: 'bad_request', 404: 'not_found', 409: 'conflict', 422: 'invalid' };

/** The server's error shape, plus the field for a refused value. */
export function sendControlError(res: ServerResponse, e: ControlError): void {
  sendJson(res, e.status, { error: { code: CODES[e.status], message: e.message, ...(e.field === undefined ? {} : { field: e.field }) } });
}

/** Runs a handler, answering a ControlError in the dashboard's terms; any other error goes on to the server. */
export function controlled(fn: (ctx: RequestContext) => void | Promise<void>): (ctx: RequestContext) => Promise<void> {
  return async (ctx) => {
    try {
      await fn(ctx);
    } catch (e) {
      if (e instanceof ControlError) return sendControlError(ctx.res, e);
      throw e;
    }
  };
}

export interface ActionGuard {
  guard: Pick<Guard, 'requireOwner' | 'requireCsrf'>;
  /** Requests that change something: 30 a minute per client (ACTION_LIMIT). */
  actions: Pick<RateLimiter, 'hit'>;
}

/** For a request that changes something: a signed-in owner, then the Origin and CSRF checks, then the rate limit. */
export async function actionSession(ctx: RequestContext, d: ActionGuard): Promise<OwnerSession> {
  const session = await d.guard.requireOwner(ctx.req);
  d.guard.requireCsrf(ctx.req, session);
  d.actions.hit(ctx.req, ctx.res);
  return session;
}

/** A JSON body of at most 16 KiB (the dashboard's forms are small). */
export const readBody = (ctx: RequestContext): Promise<unknown> => readJson(ctx.req, 16_384);
