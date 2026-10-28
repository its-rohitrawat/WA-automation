import { clientCards, clientDetail, type ClientCard, type ClientDetail } from '../../control/clientQueries.ts';
import type { GroupDirectory } from '../../control/groups.ts';
import type { Db } from '../../store/db.ts';
import type { Clock } from '../../util/clock.ts';
import { fail, ok, type ApiError, type ApiResult, type OwnerContext } from './context.ts';

// The Clients screen API (D2), as plain handlers mounted by the router in stage 2, behind D1's owner guard. Read only.

export interface ClientsDeps {
  db: Db;
  /** Only its last list is read (for group names); the Clients screen never makes the agent ask WhatsApp. */
  directory: GroupDirectory;
  clock: Clock;
}

function groupNames(directory: GroupDirectory): Map<string, string> {
  return new Map((directory.cachedGroups() ?? []).map((g) => [g.id, g.subject]));
}

/** GET /dashboard/api/clients */
export function clientsListHandler(deps: ClientsDeps, _ctx: OwnerContext): ApiResult<{ clients: ClientCard[] }> {
  return ok({ clients: clientCards(deps.db, deps.clock.now(), groupNames(deps.directory)) });
}

/** GET /dashboard/api/clients/:code */
export function clientDetailHandler(deps: ClientsDeps, _ctx: OwnerContext, code: string): ApiResult<{ client: ClientDetail } | ApiError> {
  const client = typeof code === 'string' && /^[A-Z]{3,4}$/.test(code) ? clientDetail(deps.db, code, deps.clock.now(), groupNames(deps.directory)) : null;
  return client ? ok({ client }) : fail(404, 'not_found', 'There is no active client with this code.');
}
