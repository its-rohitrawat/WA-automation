import { dbGroupsStore } from '../config/groupsStore.ts';
import { AiKeys, type KeyTester } from '../platform/aiKey.ts';
import type { Db } from '../store/db.ts';
import type { Sql } from '../store/engine/types.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import type { RuntimeFacts, RuntimeHandle } from './supervisor.ts';

// A customer's setup shell (SaaS S4.5 Phase A): what the Supervisor starts for a customer until a customer has its own
// full runtime (Phase B, after S4.6 and S4.7). It does no AI work, opens no WhatsApp socket and calls no Google: it only
// reads the customer's own Db for the Getting started checklist (the S4.9 probes) and holds the customer's AiKeys, so
// the customer can add its Anthropic key. Nothing here reads the founder's settings or keys.
// - WhatsApp linked, spare linked and Drive connected stay false: linking a customer's phone and Google come with S4.6
//   and S4.7, and a customer's session rows cannot be read without its own session key.
// - The facts are read at start and then every refreshMs (60 s), and on refresh(), so facts() stays synchronous.

export interface SetupShellDeps {
  tenantId: string;
  /** The customer's own Db (its tables under RLS). */
  db: Db;
  /** The platform tables (AiKeys audits its key changes there). */
  platform: Sql;
  /** The customer's data key (TenantKeys.dataKey): AiKeys seals the Anthropic key with it. */
  dataKey: () => Promise<Buffer>;
  /** Checks a key the customer adds (only when they add one, from the route). */
  keyTester: KeyTester;
  clock: Clock;
  log: Logger;
  refreshMs?: number;
}

export interface SetupShell extends RuntimeHandle {
  readonly tenantId: string;
  /** The customer's Anthropic key store, for the ai-key route. */
  readonly aiKeys: AiKeys;
  facts(): RuntimeFacts;
  /** Reads the facts again now (after the customer changed something). */
  refresh(): Promise<void>;
}

const NONE: RuntimeFacts = { whatsappLinked: false, spareLinked: false, driveConnected: false, groupsApproved: 0, reportTimeSet: false, aiKey: 'missing' };

export async function startSetupShell(d: SetupShellDeps): Promise<SetupShell> {
  const aiKeys = new AiKeys({ db: d.db, platform: d.platform, tenantId: d.tenantId, dataKey: d.dataKey, tester: d.keyTester, clock: d.clock });
  const groups = dbGroupsStore({ db: d.db, onChange: () => undefined, log: d.log });
  let facts: RuntimeFacts = NONE;
  const read = async (): Promise<RuntimeFacts> => ({
    ...NONE,
    groupsApproved: (await groups.list()).length, // its allow-list, as stored in its own database
    reportTimeSet: (await d.db.get("SELECT 1 AS x FROM settings WHERE k = 'reportTime'")) !== undefined,
    aiKey: await aiKeys.state(),
  });
  const refresh = async () => {
    facts = await read();
  };
  await refresh(); // a start that cannot read its customer's Db fails, and the Supervisor backs off
  const timer = setInterval(() => {
    refresh().catch((err: unknown) => d.log.warn({ tenant: d.tenantId, err: { name: (err as Error)?.name } }, 'setup facts not read'));
  }, d.refreshMs ?? 60_000);
  timer.unref();
  return {
    tenantId: d.tenantId,
    aiKeys,
    facts: () => facts,
    refresh,
    stop: async () => clearInterval(timer),
  };
}
