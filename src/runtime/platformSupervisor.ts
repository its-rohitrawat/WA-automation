import Anthropic from '@anthropic-ai/sdk';
import type { Env } from '../config/env.ts';
import { FOUNDER_TENANT_ID } from '../config/env.ts';
import type { ClientConfig } from '../config/groups.ts';
import { modelsListTester, type AiKeys, type KeyTester } from '../platform/aiKey.ts';
import { TenantKeys } from '../platform/tenantKeys.ts';
import type { Db } from '../store/db.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { crashOwner } from './context.ts';
import type { LocalEngine } from '../stt/local.ts';
import { customerProfile } from './customerProfile.ts';
import { buildCustomerRuntime, type RuntimeDeps } from './customerRuntime.ts';
import { runtimeHealth, runtimeProbes } from './probes.ts';
import { startSetupShell, type SetupShell } from './setupShell.ts';
import { Supervisor, type RuntimeHandle } from './supervisor.ts';

// The Supervisor as main.ts runs it (SaaS S4.5 Phase A, S4.9; hookups sections 9 and 10), with the platform on only.
// - The founder is ADOPTED: main.ts builds, starts and stops the founder's runtime in today's order; the Supervisor holds
//   a handle whose stop() does nothing, and a founder crash still ends the process as today.
// - A customer gets a SETUP SHELL (src/runtime/setupShell.ts): its Getting started facts from its own Db and its AiKeys,
//   no AI work, no WhatsApp socket, no Google. An ACTIVE customer that has added its own Anthropic key gets its FULL
//   runtime instead (Phase B): built from its profile (customerProfile: deny by default), its own Db, its data key and
//   its groups from its own clients rows. Its dashboard routes come with scope (Phase B 4). On SQLite the Supervisor
//   itself refuses every customer (refused:postgres), so only the founder "runs".

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

/** A customer's groups: its own active clients rows (no file). Meetings are off for customers in Phase B. */
export async function customerConfigs(db: Db): Promise<ClientConfig[]> {
  const rows = await db.all<{ code: string; name: string; groupId: string; phases: string }>(
    'SELECT code, name, group_id AS groupId, phases FROM clients WHERE active = 1 ORDER BY id',
  );
  return rows.map((r) => ({ code: r.code, name: r.name, groupId: r.groupId, phases: JSON.parse(r.phases) as string[], emailDomains: [], meetingKeywords: [] }));
}

export function platformSupervisor(o: {
  /** The founder's env: a customer's profile is cut from it, deny by default (customerProfile). */
  env: Env;
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
  /** The process's one local speech engine (processLocalEngine), shared with every runtime. */
  localEngine?: LocalEngine | undefined;
  /** Tests: another way to build a customer's full runtime. */
  build?: typeof buildCustomerRuntime;
  rssMb?: () => number;
  tickMs?: number;
}): PlatformSupervisor {
  const rssMb = o.rssMb ?? (() => process.memoryUsage.rss() / 1_048_576);
  // Before any customer starts, so a customer's memory share counts only what the runtimes add (D4).
  const baselineMb = rssMb();
  const tenantKeys = new TenantKeys({ db: o.platformDb, master: o.master, clock: o.clock });
  // The customer's own key, tested only when the customer adds it, never the founder's.
  const keyTester = o.keyTester ?? modelsListTester((apiKey) => new Anthropic({ apiKey }));
  /** Each started customer's AiKeys (its shell's), for the ai-key route; a full runtime keeps its shell's. */
  const keys = new Map<string, AiKeys>();
  const build = o.build ?? buildCustomerRuntime;
  const founder: RuntimeHandle = { stop: async () => {} }; // adopted: main.ts owns its start and its stop

  const supervisor = new Supervisor({
    db: o.platformDb, clock: o.clock, log: o.log, engine: o.env.DB_ENGINE,
    maxActive: o.env.PLATFORM_MAX_ACTIVE, maxRssMb: o.env.PLATFORM_MAX_RSS_MB, rssMb,
    factory: {
      start: async (t) => {
        if (t.founder) return founder;
        if (!o.customerDb) throw new Error('A customer runtime needs Postgres.');
        const db = o.customerDb(t.id);
        const shell: SetupShell = await startSetupShell({
          tenantId: t.id, db, platform: o.platformDb, dataKey: () => tenantKeys.dataKey(t.id), keyTester, clock: o.clock, log: o.log,
        });
        keys.set(t.id, shell.aiKeys);
        const aiKey = t.setupOnly ? null : await shell.aiKeys.load();
        if (!aiKey) {
          // Onboarding, or active without its own key yet: the setup shell only.
          return {
            facts: () => shell.facts(),
            stop: async () => {
              keys.delete(t.id);
              await shell.stop();
            },
          };
        }
        // Active with its own key: the full runtime, from its profile, its Db and its data key.
        await shell.stop(); // its facts now come from the runtime; its AiKeys stays for the key route
        try {
          const rt = await build(
            { id: t.id, founder: false, crashed: t.crashed },
            {
              env: customerProfile(o.env, { tenantId: t.id, aiKey }), log: o.log, db, key: await tenantKeys.dataKey(t.id),
              configs: await customerConfigs(db), localEngine: o.localEngine,
            },
          );
          rt.start();
          return {
            facts: () => rt.facts(),
            stop: async () => {
              keys.delete(t.id);
              rt.beginStop();
              await rt.stop();
            },
          };
        } catch (e) {
          keys.delete(t.id);
          throw e;
        }
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
      aiKeys: (tenantId) => keys.get(tenantId) ?? null,
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
