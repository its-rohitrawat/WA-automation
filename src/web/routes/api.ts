import type { AgentControl } from '../../control/agentControl.ts';
import type { Guard } from '../guard.ts';
import { sendJson } from '../http.ts';
import type { Router } from '../router.ts';

// The dashboard's read API (D1 Task 6): status, overview and connections, for a signed-in owner only. Each answer is
// JSON with Cache-Control: no-store (sendJson). A refusal is the guard's 401; any other error goes to the server, which
// logs it with the request id and answers the plain 500, so no detail reaches the browser.

export interface ReadApiDeps {
  guard: Pick<Guard, 'requireOwner'>;
  control: Pick<AgentControl, 'status' | 'overview' | 'connections'>;
}

export function registerReadApi(router: Router, d: ReadApiDeps): void {
  const read = (path: string, answer: () => unknown) =>
    router.get(path, async ({ req, res }) => {
      d.guard.requireOwner(req); // before any work: a request without an owner session reads nothing
      sendJson(res, 200, await answer());
    });
  read('/dashboard/api/status', async () => (await d.control.status()));
  read('/dashboard/api/overview', async () => (await d.control.overview()));
  read('/dashboard/api/connections', async () => (await d.control.connections()));
}
