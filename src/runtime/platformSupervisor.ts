import Anthropic from '@anthropic-ai/sdk';
import type { Env } from '../config/env.ts';
import { FOUNDER_TENANT_ID } from '../config/env.ts';
import { modelsListTester, type KeyTester } from '../platform/aiKey.ts';
import { TenantKeys } from '../platform/tenantKeys.ts';
import type { Db } from '../store/db.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { crashOwner } from './context.ts';
import type { RuntimeDeps } from './customerRuntime.ts';
import { runtimeHealth, runtimeProbes } from './probes.ts';
import { startSetupShell, type SetupShell } from './setupShell.ts';
import { Supervisor, type RuntimeHandle } from './supervisor.ts';

// The Supervisor as main.ts runs it (SaaS S4.5 Phase A, S4.9; hookups sections 9 and 10), with the platform on only.
// - The founder is ADOPTED: main.ts builds, starts and stops the founder's runtime in today's order; the Supervisor holds
//   a handle whose stop() does nothing, and a founder crash still ends the process as today.
// - A customer gets a SETUP SHELL (src/runtime/setupShell.ts): its Getting started facts from its own Db and its AiKeys,
//   no AI work, no WhatsApp socket, no Google. Its full runtime is Phase B. On SQLite the Supervisor itself refuses every
//   customer (refused:postgres), so only the founder "runs".

export interface PlatformSupervisor {
  readonly supervisor: Supervisor;
  /** What the founder runtime's platform and sign-up routes take (RuntimeDeps.platformHooks). */
  readonly hooks: NonNullable<RuntimeDeps['platformHooks']>;
  /** The first reconcile, then one every 60 s. */
  start(): Promise<void>;
  /** The 60 s tick ends, then every customer's shell stops (each within 10 s). The founder's runtime is main.ts's. */
  stop(): Promise<void>;
  /**
   * For the process's uncaughtException and unhandledRejection: true when the code that threw was a customer's (its
   * runtime is restarted alone); false for the founder's or no one's, which keeps today's exit.
   */
  crashed(e: unknown): boolean;
}

export function platformSupervisor(o: {
  env: Pick<Env, 'DB_ENGINE' | 'PLATFORM_MAX_ACTIVE' | 'PLATFORM_MAX_RSS_MB'>;
  log: Logger;
  clock: Clock;
  /** The platform tables (tenants, tenant_keys, platform_audit). */
  platformDb: Db;
  /** The Mac's master key: each customer's data key is wrapped by a key derived from it (S4.1). */
  master: Buffer;
  /** Each customer's own Db (Postgres; undefined on SQLite, where no customer starts). */
  customerDb: ((tenantId: string) => Db) | undefined;
  /** Checks a key a customer adds (default: one models list call with that key). Tests: a fake. */
  keyTester?: KeyTester;
  rssMb?: () => number;
  tickMs?: number;
}): PlatformSupervisor {
  const rssMb = o.rssMb ?? (() => process.memoryUsage.rss() / 1_048_576);
  // Before any customer starts, so a customer's memory share counts only what the runtimes add (D4).
  const baselineMb = rssMb();
  const tenantKeys = new TenantKeys({ db: o.platformDb, master: o.master, clock: o.clock });
  // The customer's own key, tested only when the customer adds it, never the founder's.
  const keyTester = o.keyTester ?? modelsListTester((apiKey) => new Anthropic({ apiKey }));
  const shells = new Map<string, SetupShell>();
  const founder: RuntimeHandle = { stop: async () => {} }; // adopted: main.ts owns its start and its stop

  const supervisor = new Supervisor({
    db: o.platformDb, clock: o.clock, log: o.log, engine: o.env.DB_ENGINE,
    maxActive: o.env.PLATFORM_MAX_ACTIVE, maxRssMb: o.env.PLATFORM_MAX_RSS_MB, rssMb,
    factory: {
      start: async (t) => {
        if (t.founder) return founder;
        if (!o.customerDb) throw new Error('A customer runtime needs Postgres.');
        const shell = await startSetupShell({
          tenantId: t.id, db: o.customerDb(t.id), platform: o.platformDb, dataKey: () => tenantKeys.dataKey(t.id), keyTester, clock: o.clock, log: o.log,
        });
        shells.set(t.id, shell);
        return {
          facts: () => shell.facts(),
          stop: async () => {
            shells.delete(t.id);
            await shell.stop();
          },
        };
      },
    },
  });
  let tick: ReturnType<typeof setInterval> | undefined;
  return {
    supervisor,
    hooks: {
      probes: runtimeProbes(supervisor),
      health: runtimeHealth(supervisor, { rssMb, baselineMb }),
      maxActive: o.env.PLATFORM_MAX_ACTIVE,
      aiKeys: (tenantId) => shells.get(tenantId)?.aiKeys ?? null,
      poke: () => supervisor.poke(),
    },
    start: async () => {
      await supervisor.reconcile();
      tick = setInterval(() => supervisor.poke(), o.tickMs ?? 60_000);
      tick.unref();
    },
    stop: async () => {
      clearInterval(tick);
      await supervisor.stopAll();
    },
    crashed: (e) => {
      const owner = crashOwner();
      if (!owner || owner === FOUNDER_TENANT_ID) return false;
      void supervisor.crashed(owner, e);
      return true;
    },
  };
}
