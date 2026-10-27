import { existsSync } from 'node:fs';
import { createApp, type AppReportDeps } from './app.ts';
import type { AppMeetingsDeps } from './app.ts';
import { ClaudeClient } from './brain/claudeClient.ts';
import { ClaudeMediaClient } from './brain/mediaClient.ts';
import { ClaudeMeetingClient } from './brain/meetingClient.ts';
import { loadEnv, requireKey } from './config/env.ts';
import type { Env } from './config/env.ts';
import { GROUPS_FILE_MISSING_MESSAGE, loadGroupsFile, watchGroupsFile } from './config/groups.ts';
import type { ClientConfig } from './config/groups.ts';
import { masterKeyPath, sessionDbPath, trackerDbPath } from './config/paths.ts';
import { DpapiKeyProvider, MasterKeyError } from './crypto/keyProvider.ts';
import { Heartbeat } from './health/heartbeat.ts';
import { baileysFetcher } from './media/fetch.ts';
import { MediaRefSealer } from './media/ref.ts';
import { combineMeetingAccounts, storedMeetingAccounts } from './meetings/multiAccount.ts';
import { createMeetingTranscriber } from './meetings/transcribe.ts';
import { googleDriveApi } from './output/drive.ts';
import { createOAuthClient, TokenDecryptError, TokenStore } from './output/googleAuth.ts';
import { meetingsReady, type OAuth2Client } from './output/googleAuth.ts';
import { openMorningReport } from './report/start.ts';
import { pricesFromEnv } from './spend/pricing.ts';
import type { Prices } from './spend/pricing.ts';
import { syncClients } from './store/clients.ts';
import { openDb, type Db } from './store/db.ts';
import { Ffmpeg, findFfmpeg } from './stt/audio.ts';
import { systemClock } from './util/clock.ts';
import { acquireLock, AlreadyRunningError } from './util/lock.ts';
import { createLogger, silentLogger } from './util/logger.ts';
import type { Logger } from './util/logger.ts';
import { AllowList } from './wa/allowlist.ts';
import { openSessionDb, SessionDecryptError, useEncryptedAuthState } from './wa/authState.ts';
import { baileysSocketFactory, WhatsAppGateway } from './wa/gateway.ts';
import { baileysSenderSocketFactory, linkedNumber } from './wa/senderGateway.ts';
import { buildVoiceDeps } from './voiceDeps.ts';

/** Expected startup refusal. The message is safe to print. */
class StartupExit extends Error {}

/**
 * The meeting dependencies (Phase 3), built only when MEETINGS_ENABLED is true. Nothing here calls Google: without the
 * meeting scopes the app keeps meetings paused (google_scopes) and makes no Google meeting call. Logs codes only.
 */
async function meetingDeps(
  o: { env: Env; db: Db; key: Buffer; google: OAuth2Client; apiKey: string; prices: Prices; configs: ClientConfig[]; log: Logger },
): Promise<AppMeetingsDeps> {
  const { env, log } = o;
  if (!meetingsReady(o.db)) log.warn({ code: 'google_scopes' }, 'meetings paused: Google sign-in needs meeting access. Run: npm run cli -- google-auth');
  // The main sign-in plus every extra account (google-auth --account); one account is passed through unchanged.
  const accounts = storedMeetingAccounts({
    db: o.db, key: o.key, main: o.google, log,
    newClient: () => createOAuthClient(requireKey(env, 'GOOGLE_OAUTH_CLIENT_ID'), requireKey(env, 'GOOGLE_OAUTH_CLIENT_SECRET')),
  });
  const { api, router } = combineMeetingAccounts(accounts, log);
  if (router) log.info({ accounts: accounts.map((a) => a.label) }, 'meetings: several Google accounts');
  let exe: string | null = null;
  try {
    exe = await findFfmpeg(env.FFMPEG_PATH);
  } catch {
    exe = null;
  }
  if (exe === null) log.warn({ code: 'no_ffmpeg' }, 'meetings paused: ffmpeg not found');
  const transcriber = createMeetingTranscriber(env); // STT_API_KEY goes to the provider only
  if (transcriber === null) log.warn({ code: 'stt_none' }, 'meetings wait: speech-to-text is not set up');
  return {
    api,
    ...(router ? { lostAccounts: () => router.lostAccounts() } : {}),
    ai: new ClaudeMeetingClient({ apiKey: o.apiKey, model: env.AI_MODEL, prices: o.prices }),
    transcriber,
    ffmpeg: exe === null ? null : new Ffmpeg(exe),
    settings: {
      teamDomains: env.TEAM_EMAIL_DOMAINS, pollMinutes: env.MEETING_POLL_MINUTES, maxMinutes: env.MEETING_MAX_MINUTES,
      ...(env.MEETINGS_SINCE !== undefined ? { since: env.MEETINGS_SINCE } : {}), inrPerUsd: env.INR_PER_USD,
    },
    clients: o.configs,
  };
}

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
  let sessionDb: Db | undefined;
  let senderDb: Db | undefined;

  /** Stops startup with a one-line message; the catch below cleans up and exits with code 2. */
  function exitEarly(message: string): never {
    throw new StartupExit(message);
  }

  try {
    // The lock comes first: nothing opens a database while another instance may be running.
    lock = await acquireLock(env.DATA_DIR);
    const key = new DpapiKeyProvider(masterKeyPath(env.DATA_DIR)).getKey();
    db = openDb(trackerDbPath(env.DATA_DIR));
    sessionDb = openSessionDb(sessionDbPath(env.DATA_DIR));

    const configs = loadGroupsFile(env.GROUPS_FILE);
    syncClients(db, configs);
    const allow = new AllowList(configs.map((c) => c.groupId));

    const auth = useEncryptedAuthState(sessionDb, key);
    if (!auth.hasSession) exitEarly('WhatsApp is not linked. Stop the service and run: npm run cli -- link');
    const refreshToken = new TokenStore(db, key).load();
    if (!refreshToken) exitEarly('Google Drive is not connected. Run: npm run cli -- google-auth');

    const google = createOAuthClient(requireKey(env, 'GOOGLE_OAUTH_CLIENT_ID'), requireKey(env, 'GOOGLE_OAUTH_CLIENT_SECRET'));
    google.setCredentials({ refresh_token: refreshToken });

    // Phase 2c: the morning report from the spare number. A missing, damaged or undecryptable spare-number session never
    // stops the service: the founder-number reader runs as usual, each day's report fails until the deadline and is then
    // skipped, and Health says to run link-sender (or link-sender --reset).
    // openMorningReport (tested) opens data/sender-session.db only, and logs only the recipient's last 4 digits.
    // founderNumber: the founder reader's own linked number. A spare-number link to it never sends, even when it is
    // not REPORT_RECIPIENT.
    let report: AppReportDeps | undefined;
    if (env.REPORT_ENABLED) {
      const started = openMorningReport({
        env, masterKey: key, log, factory: baileysSenderSocketFactory(silentLogger()), founderNumber: linkedNumber(auth),
      });
      senderDb = started.senderDb;
      report = started.report;
    }

    const prices = pricesFromEnv(env);
    const apiKey = requireKey(env, 'ANTHROPIC_API_KEY');
    const gateway = new WhatsAppGateway({ allow, factory: baileysSocketFactory(silentLogger()), auth: auth.state, saveCreds: auth.saveCreds });
    // One start time for every wait that counts from the service start: the reconciler's wait for a file, the
    // processor's 24 hours of waits for Claude, and Health's long-wait count (amendments 10f, 12a, 15a, 15f).
    const startedAt = systemClock.now();
    // Phase 3: off (the default) means no meeting dependency is built and no meeting call of any kind is made.
    const meetings = env.MEETINGS_ENABLED ? await meetingDeps({ env, db, key, google, apiKey, prices, configs, log }) : undefined;
    // Phase 2b: the voice transcriber VOICE_STT_PROVIDER names (src/voiceDeps.ts, tested). A local engine that is not set
    // up, or no ffmpeg, never stops the service: voice notes are then kept, not transcribed, and Health says why.
    const voiceDeps = await buildVoiceDeps(env, { findFfmpeg, log });
    const app = createApp({
      db,
      clock: systemClock,
      log,
      gateway,
      allow,
      ai: new ClaudeClient({ apiKey, model: env.AI_MODEL, effort: env.AI_EFFORT, prices }),
      drive: googleDriveApi(google),
      prices,
      spendCapUsd: env.DAILY_SPEND_CAP_USD,
      quietMs: env.QUIET_MINUTES * 60_000,
      maxWaitMs: env.MAX_WAIT_MINUTES * 60_000,
      maxConcurrent: env.MAX_PARALLEL_CLIENTS,
      dataDir: env.DATA_DIR,
      startedAt,
      // Phase 2a: download, keep and read shared images and documents. Phase 2b: transcribe voice notes and audio files
      // with the transcriber VOICE_STT_PROVIDER names (the local engine on this machine by default; none keeps them as in 2a).
      media: { sealer: new MediaRefSealer(key), fetcher: baileysFetcher(), ai: new ClaudeMediaClient({ apiKey, model: env.AI_MODEL, prices }), ...voiceDeps },
      ...(meetings ? { meetings } : {}),
      report,
    });

    // watchGroupsFile catches a throwing onChange (including reloadClients conflicts) and calls onError.
    const stopWatching = watchGroupsFile(
      env.GROUPS_FILE,
      (next) => {
        app.reloadClients(next);
        log.info({ groups: next.length }, 'allow-list reloaded');
      },
      (err) =>
        log.error({ problem: err instanceof Error ? err.message : String(err) }, 'allowed-groups.json change rejected; keeping the previous allow-list'),
    );

    app.start();
    log.info({ groups: configs.length }, 'WA Agent started');
    // Optional uptime heartbeat: visits HEARTBEAT_URL (never logged) every 5 minutes while the agent is up.
    const heartbeat = env.HEARTBEAT_URL ? new Heartbeat({ url: env.HEARTBEAT_URL, isUp: () => app.health.isUp(), log }) : undefined;
    heartbeat?.start();
    if (heartbeat) log.info('uptime heartbeat on');

    const trackerDb = db;
    const sessionStore = sessionDb;
    const senderStore = senderDb;
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
      void heartbeat?.stop();
      stopWatching();
      void app
        .stop()
        .catch((err) => log.error({ err }, 'error while stopping'))
        .finally(() => {
          // Databases are closed only after app.stop() has settled, so after the morning report's stop() has returned.
          try {
            trackerDb.close();
            sessionStore.close();
            senderStore?.close();
          } catch {
            // best effort
          }
          void startedLock.release().finally(() => process.exit(0));
          setTimeout(() => process.exit(0), 2000).unref();
        });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (e) {
    try {
      db?.close();
      sessionDb?.close();
      senderDb?.close();
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
      // Bounded: the OS frees the lock when the process exits anyway.
      await Promise.race([lock?.release(), new Promise((r) => setTimeout(r, 2000).unref())]);
    } catch {
      // ignore
    }
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
