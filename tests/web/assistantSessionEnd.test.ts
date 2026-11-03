import { afterEach, describe, expect, it, vi } from 'vitest';
import { Assistant } from '../../src/assistant/assistant.ts';
import { UptimeLog } from '../../src/health/uptimeLog.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { manualClock } from '../../src/util/clock.ts';
import { silentLogger } from '../../src/util/logger.ts';
import { mountAgentRoutes, type AgentRoutesDeps } from '../../src/web/mountRoutes.ts';
import { createRouter } from '../../src/web/router.ts';
import type { SessionEnd } from '../../src/web/sessions.ts';
import type { DashboardMount } from '../../src/web/start.ts';
import { NOW, seededDb } from '../helpers/db.ts';
import { OWNER } from '../helpers/web.ts';

// The assistant's listener for ended sessions (final review N1): a customer's routes are mounted again each time its
// runtime restarts, on the one session store, and each mount used to add a listener that kept its Assistant alive. Now
// each workspace has one, the latest mount's, per session store. The store here keeps its listeners as SessionStore does
// (tests/web/sessions.test.ts covers its onEnd and the function that removes a listener).

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const PRICES = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.4 };

afterEach(() => {
  vi.restoreAllMocks();
});

/** A session store's listeners, as SessionStore keeps them. */
function sessionStore() {
  const listeners = new Set<(e: SessionEnd) => void>();
  const sessions = {
    onEnd: (fn: (e: SessionEnd) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  } as unknown as DashboardMount['sessions'];
  return { sessions, listeners, end: (e: SessionEnd) => [...listeners].forEach((fn) => fn(e)) };
}

async function mounter() {
  const db = await seededDb();
  const clock = manualClock(NOW);
  const never = {} as never;
  const deps: AgentRoutesDeps = {
    db, clock, log: silentLogger(), control: never, spend: new SpendGuard({ db, clock, capUsd: 10 }) as never, health: never,
    voiceLocal: true, uptime: { log: new UptimeLog(db, clock) }, ownerEmails: [OWNER], settings: never, priority: never,
    groups: never, clients: never, google: never, actions: never, links: never,
    assistant: { ai: never, paid: never, prices: PRICES },
  };
  /** A workspace's routes mounted on `sessions`, as the dashboard mounts them (a new router each time). */
  return (sessions: DashboardMount['sessions'], tenantId?: string) => {
    const m: DashboardMount = {
      router: createRouter(), guard: never, sessions, audit: never, actions: never, secureFor: () => false, port: () => undefined, audited: never,
    };
    mountAgentRoutes(m, { ...deps, ...(tenantId ? { tenantId } : {}) });
  };
}

describe('the assistant\'s listener for ended sessions (final review N1)', () => {
  it('a workspace mounted again (its runtime restarted) leaves exactly one listener; each workspace keeps its own', async () => {
    const mount = await mounter();
    const forgot = vi.spyOn(Assistant.prototype, 'forget');
    const one = sessionStore();
    mount(one.sessions); // the founder's
    mount(one.sessions, A);
    mount(one.sessions, A); // A's runtime restarted twice
    mount(one.sessions, A);
    mount(one.sessions, B);
    expect(one.listeners.size).toBe(3);
    one.end({ email: OWNER });
    expect(forgot).toHaveBeenCalledTimes(3); // the founder's, A's latest and B's: never A's earlier Assistants
  });

  it('another session store keeps its own listeners', async () => {
    const mount = await mounter();
    const one = sessionStore();
    const two = sessionStore();
    mount(one.sessions, A);
    mount(two.sessions, A);
    mount(two.sessions, A);
    expect(one.listeners.size).toBe(1);
    expect(two.listeners.size).toBe(1);
  });
});
