import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './app.ts';
import { ClaudeClient } from './brain/claudeClient.ts';
import { loadEnv, requireKey } from './config/env.ts';
import { loadGroupsFile, watchGroupsFile } from './config/groups.ts';
import { DpapiKeyProvider, MasterKeyError } from './crypto/keyProvider.ts';
import { googleDriveApi } from './output/drive.ts';
import { createOAuthClient, TokenDecryptError, TokenStore } from './output/googleAuth.ts';
import { pricesFromEnv } from './spend/pricing.ts';
import { syncClients } from './store/clients.ts';
import { openDb, type Db } from './store/db.ts';
import { systemClock } from './util/clock.ts';
import { acquireLock, AlreadyRunningError } from './util/lock.ts';
import { createLogger, silentLogger } from './util/logger.ts';
import { AllowList } from './wa/allowlist.ts';
import { openSessionDb, SessionDecryptError, useEncryptedAuthState } from './wa/authState.ts';
import { baileysSocketFactory, WhatsAppGateway } from './wa/gateway.ts';

/** Expected startup refusal. The message is safe to print. */
class StartupExit extends Error {}

async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger(env.LOG_LEVEL);

  if (!existsSync(env.GROUPS_FILE)) {
    log.error({ file: env.GROUPS_FILE }, 'Allow-list file missing. Copy config/allowed-groups.example.json and fill it in.');
    process.exit(2);
  }

  let lock: { release(): Promise<void> } | undefined;
  let db: Db | undefined;
  let sessionDb: Db | undefined;

  /** Stops startup with a one-line message; the catch below cleans up and exits with code 2. */
  function exitEarly(message: string): never {
    throw new StartupExit(message);
  }

  try {
    // The lock comes first: nothing opens a database while another instance may be running.
    lock = await acquireLock(env.DATA_DIR);
    const key = new DpapiKeyProvider(join(env.DATA_DIR, 'keys', 'master.key.dpapi')).getKey();
    db = openDb(join(env.DATA_DIR, 'tracker.db'));
    sessionDb = openSessionDb(join(env.DATA_DIR, 'session.db'));

    const configs = loadGroupsFile(env.GROUPS_FILE);
    syncClients(db, configs);
    const allow = new AllowList(configs.map((c) => c.groupId));

    const auth = useEncryptedAuthState(sessionDb, key);
    if (!auth.hasSession) exitEarly('WhatsApp is not linked. Stop the service and run: npm run cli -- link');
    const refreshToken = new TokenStore(db, key).load();
    if (!refreshToken) exitEarly('Google Drive is not connected. Run: npm run cli -- google-auth');

    const google = createOAuthClient(requireKey(env, 'GOOGLE_OAUTH_CLIENT_ID'), requireKey(env, 'GOOGLE_OAUTH_CLIENT_SECRET'));
    google.setCredentials({ refresh_token: refreshToken });

    const prices = pricesFromEnv(env);
    const gateway = new WhatsAppGateway({ allow, factory: baileysSocketFactory(silentLogger()), auth: auth.state, saveCreds: auth.saveCreds });
    const app = createApp({
      db,
      clock: systemClock,
      log,
      gateway,
      allow,
      ai: new ClaudeClient({ apiKey: requireKey(env, 'ANTHROPIC_API_KEY'), model: env.AI_MODEL, effort: env.AI_EFFORT, prices }),
      drive: googleDriveApi(google),
      prices,
      spendCapUsd: env.DAILY_SPEND_CAP_USD,
      quietMs: env.QUIET_MINUTES * 60_000,
      maxWaitMs: env.MAX_WAIT_MINUTES * 60_000,
      maxConcurrent: env.MAX_PARALLEL_CLIENTS,
      dataDir: env.DATA_DIR,
    });

    const stopWatching = watchGroupsFile(
      env.GROUPS_FILE,
      (next) => {
        try {
          app.reloadClients(next);
          log.info({ groups: next.length }, 'allow-list reloaded');
        } catch (err) {
          log.error({ problem: err instanceof Error ? err.message : String(err) }, 'allowed-groups.json change rejected; keeping the previous allow-list');
        }
      },
      (err) =>
        log.error({ problem: err instanceof Error ? err.message : String(err) }, 'allowed-groups.json change rejected; keeping the previous allow-list'),
    );

    app.start();
    log.info({ groups: configs.length }, 'WA Agent started');

    const openDb1 = db;
    const openDb2 = sessionDb;
    const heldLock = lock;
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      log.info('WA Agent stopping');
      stopWatching();
      void app
        .stop()
        .catch(() => log.error('error while stopping'))
        .finally(() => {
          // Databases are closed only after app.stop() has settled.
          try {
            openDb1.close();
            openDb2.close();
          } catch {
            // best effort
          }
          void heldLock.release().finally(() => process.exit(0));
          setTimeout(() => process.exit(0), 2000).unref();
        });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (e) {
    try {
      db?.close();
      sessionDb?.close();
    } catch {
      // best effort
    }
    const known =
      e instanceof StartupExit ||
      e instanceof AlreadyRunningError ||
      e instanceof MasterKeyError ||
      e instanceof SessionDecryptError ||
      e instanceof TokenDecryptError;
    try {
      await lock?.release();
    } catch {
      // the OS frees the lock when the process exits
    }
    if (!known) throw e;
    log.error(e.message);
    process.exit(2);
  }
}

main().catch((e: unknown) => {
  // Name and message only: never dump objects that might hold config values.
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : 'Fatal error');
  process.exit(1);
});
