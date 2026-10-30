import { existsSync } from 'node:fs';
import { loadEnv } from './config/env.ts';
import { GROUPS_FILE_MISSING_MESSAGE, loadGroupsFile } from './config/groups.ts';
import { masterKeyPath } from './config/paths.ts';
import { DpapiKeyProvider, MasterKeyError } from './crypto/keyProvider.ts';
import { TokenDecryptError } from './output/googleAuth.ts';
import { ensurePlatformSchema } from './platform/schema.ts';
import { ensureFounderTenant } from './platform/store.ts';
import { startFounderRuntime, StartupExit } from './runtime/customerRuntime.ts';
import { GlobalSpend } from './spend/globalSpend.ts';
import type { Db } from './store/db.ts';
import { openPlatformStore, openStore } from './store/open.ts';
import { acquireLock, AlreadyRunningError } from './util/lock.ts';
import { createLogger } from './util/logger.ts';
import { SessionDecryptError } from './wa/authState.ts';
import { startDashboard } from './web/start.ts';

// The service (npm start): what the process has once (env, the master key, the instance lock, the stores, the web
// server, the signals and the shutdown order). Everything for one customer is built in src/runtime/customerRuntime.ts.

async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger(env.LOG_LEVEL);
  // Without these Node prints the raw error (Boom data, gaxios request config), bypassing the logger's redaction.
  process.on('uncaughtException', (err) => {
    try {
      log.fatal({ err }, 'uncaught exception');
    } finally {
      process.exit(1);
    }
  });
  process.on('unhandledRejection', (reason) => {
    try {
      log.fatal({ err: reason }, 'unhandled rejection');
    } finally {
      process.exit(1);
    }
  });

  if (!existsSync(env.GROUPS_FILE)) {
    const message = GROUPS_FILE_MISSING_MESSAGE;
    log.error({ file: env.GROUPS_FILE }, message);
    process.stderr.write(`${message}\n`);
    process.exit(2);
  }

  let lock: { release(): Promise<void> } | undefined;
  let db: Db | undefined;
  /** The platform tables (decision D1): the tracker itself on SQLite, wa_platform's own pool on Postgres. */
  let platformDb: Db | undefined;
  /** Set once startFounderRuntime has the databases and the lock: on a failure from then on, it has closed and released them. */
  let handedOver = false;

  try {
    // The lock comes first: nothing opens a database while another instance may be running.
    lock = await acquireLock(env.DATA_DIR);
    const key = new DpapiKeyProvider(masterKeyPath(env.DATA_DIR)).getKey();
    // DB_ENGINE (S2.6): data/tracker.db by default; on Postgres, refused unless its schema is at this version's.
    // A pooled connection that fails while idle (the server restarted) is logged and replaced on the next use.
    const onPoolError = (err: Error) => log.error({ err }, 'a Postgres connection failed while idle');
    db = await openStore(env, { onPoolError });
    platformDb = openPlatformStore(env, db, { onPoolError });
    // The platform tables (S5H.1), only with PLATFORM_ENABLED (off: tracker.db stays as it was): on SQLite in tracker.db,
    // made here if missing; on Postgres P3 made them (db-migrate). Then customer #1, the founder, is there.
    if (env.PLATFORM_ENABLED) {
      if (platformDb.engine === 'sqlite') await ensurePlatformSchema(platformDb);
      await ensureFounderTenant(platformDb, { name: 'Your business', at: new Date().toISOString() });
    }
    const configs = loadGroupsFile(env.GROUPS_FILE);

    // The founder's runtime (S4.4, src/runtime/customerRuntime.ts): everything for customer #1 between the databases
    // and the web server. On a failure it closes the databases and releases the lock itself, then throws to the catch.
    // The platform-wide daily ceiling (S4.3, D3) over spend billed to the founder: the founder's runtime joins it.
    const globalSpend = new GlobalSpend({ capUsd: env.PLATFORM_DAILY_SPEND_CAP_USD });
    handedOver = true;
    const rt = await startFounderRuntime({ tenantId: env.TENANT_ID, env, log, db, platformDb, key, configs, lock, globalSpend });
    const { control, agentRoutes } = rt;
    rt.start();
    // Owner dashboard: off (the default) means no web server and no port. Not awaited here, so the stop handlers below
    // are in place before anything else is awaited. It never rejects: a dashboard that cannot start resolves to undefined.
    const webReady = env.DASHBOARD_ENABLED ? startDashboard({ env, db, platformDb, log, control, platform: rt.platform, ...agentRoutes }) : Promise.resolve(undefined);

    const trackerDb = db;
    const platformStore = platformDb !== db ? platformDb : undefined;
    const startedLock = lock;
    let stopping = false;
    let warnedStopping = false;
    const shutdown = () => {
      if (stopping) {
        if (!warnedStopping) {
          warnedStopping = true;
          log.warn('still stopping: waiting for an AI call or upload in flight (up to about 2.5 minutes)');
        }
        return;
      }
      stopping = true;
      log.info('WA Agent stopping');
      // The heartbeat and the groups file watcher stop at once.
      rt.beginStop();
      // The dashboard stops first (in-flight requests get up to 5 s), so no request reaches the app while it drains.
      // Then the runtime stops: a phone link still running is undone (at most 10 s), app.stop(), then its own databases.
      const webStopped = webReady
        .then((w) => w?.stop())
        .catch((err: unknown) => log.error({ err }, 'error while stopping the dashboard'));
      void webStopped
        .then(() => rt.stop())
        .catch((err) => log.error({ err }, 'error while stopping'))
        .finally(() => {
          // The tracker closes last, after app.stop() and the runtime's own databases (best effort).
          const closeAll = () =>
            Promise.all([trackerDb.close(), platformStore?.close()].map((p) => Promise.resolve(p).catch(() => undefined)));
          void closeAll().then(() => {
            void startedLock.release().finally(() => process.exit(0));
          });
          setTimeout(() => process.exit(0), 2000).unref();
        });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (e) {
    // Start-up failed. Before the runtime had them, each database that was opened is closed and the lock released here,
    // best effort (one that fails never stops the next); after, startFounderRuntime has done both.
    if (!handedOver) {
      if (platformDb !== db) await platformDb?.close().catch(() => undefined); // Postgres only: wa_platform's own pool
      await db?.close().catch(() => undefined);
      try {
        // Bounded: the OS frees the lock when the process exits anyway.
        await Promise.race([lock?.release(), new Promise((r) => setTimeout(r, 2000).unref())]);
      } catch {
        // ignore
      }
    }
    const known =
      e instanceof StartupExit ||
      e instanceof AlreadyRunningError ||
      e instanceof MasterKeyError ||
      e instanceof SessionDecryptError ||
      e instanceof TokenDecryptError;
    if (!known) throw e;
    if (e instanceof MasterKeyError) {
      log.error({ code: e.code }, e.message);
      process.stderr.write(`${e.code}: ${e.message}\n`);
    } else {
      log.error(e.message);
      process.stderr.write(`${e.message}\n`);
    }
    process.exit(2);
  }
}

main().catch((e: unknown) => {
  // Name and message only: never dump objects that might hold config values.
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : 'Fatal error');
  process.exit(1);
});
