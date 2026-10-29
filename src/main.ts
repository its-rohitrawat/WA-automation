import { existsSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { createApp, type AppReportDeps } from './app.ts';
import type { AppMeetingsDeps } from './app.ts';
import { ClaudeClient, keepConnectTimeoutCode } from './brain/claudeClient.ts';
import { ClaudeMediaClient } from './brain/mediaClient.ts';
import { ClaudeMeetingClient } from './brain/meetingClient.ts';
import { loadEnv, requireKey } from './config/env.ts';
import type { Env } from './config/env.ts';
import { GROUPS_FILE_MISSING_MESSAGE, loadGroupsFile, watchGroupsFile } from './config/groups.ts';
import type { ClientConfig } from './config/groups.ts';
import { masterKeyPath, sessionDbPath, trackerDbPath } from './config/paths.ts';
import { SettingsStore } from './config/settingsStore.ts';
import { sentTextFor, settleInterrupted } from './store/outbox.ts';
import { ActionRateLimiter, claudeModelsCheck } from './control/actions.ts';
import { historyReadEntry, publisherAuditHooks } from './control/activityQueries.ts';
import { GroupDirectory } from './control/groups.ts';
import { deriveSubkey, DpapiKeyProvider, MasterKeyError } from './crypto/keyProvider.ts';
import { Heartbeat } from './health/heartbeat.ts';
import { UptimeLog } from './health/uptimeLog.ts';
import { UptimeRobotClient } from './health/uptimeRobot.ts';
import { baileysFetcher } from './media/fetch.ts';
import { MediaRefSealer } from './media/ref.ts';
import type { LiveMeetingsApi } from './meetings/multiAccount.ts';
import { buildMeetingTranscriber } from './meetings/transcribe.ts';
import { TokenDecryptError, TokenStore } from './output/googleAuth.ts';
import { meetingsReady } from './output/googleAuth.ts';
import { fillAccountEmails } from './output/accountEmail.ts';
import { googleIdVerifier } from './web/oidc.ts';
import { buildGoogle, founderGateway, googleCredentials, planStartup, WHATSAPP_NOT_LINKED_EXIT } from './setupMode.ts';
import { LiveReport } from './report/liveReport.ts';
import { briefingSettings, spareDriver, spareLinked } from './report/dashboardReport.ts';
import { openMorningReport, senderOpener } from './report/start.ts';
import { pricesFromEnv } from './spend/pricing.ts';
import type { Prices } from './spend/pricing.ts';
import { getClient, syncClients } from './store/clients.ts';
import { openDb, type Db } from './store/db.ts';
import { Ffmpeg, findFfmpeg } from './stt/audio.ts';
import { sharedLocalEngine, type LocalEngine } from './stt/local.ts';
import { systemClock } from './util/clock.ts';
import { acquireLock, AlreadyRunningError } from './util/lock.ts';
import { createLogger, silentLogger } from './util/logger.ts';
import type { Logger } from './util/logger.ts';
import { istDate } from './util/time.ts';
import { AllowList } from './wa/allowlist.ts';
import { openSessionDb, readFounderNumber, SessionDecryptError, useEncryptedAuthState } from './wa/authState.ts';
import { baileysSocketFactory, WhatsAppGateway } from './wa/gateway.ts';
import { founderLinkDriver, LinkSessions } from './wa/linkSession.ts';
import { baileysSenderSocketFactory, linkedNumber } from './wa/senderGateway.ts';
import { buildVoiceDeps } from './voiceDeps.ts';
import { AuditLog } from './web/audit.ts';
import { mountAgentRoutes } from './web/mountRoutes.ts';
import { makeGroupKey } from './web/routes/groups.ts';
import { startDashboard } from './web/start.ts';
import type { DashboardMount } from './web/start.ts';
import { AgentControl } from './control/agentControl.ts';

/** Expected startup refusal. The message is safe to print. */
class StartupExit extends Error {}

/** How often the dashboard's uptime log is brought up to date, and how long it and the audit log are kept. */
const UPTIME_TICK_MS = 30_000;
const UPTIME_KEEP_DAYS = 90;
const AUDIT_KEEP_DAYS = 90;
/** The HKDF label of the secret that turns group ids into the opaque keys the browser gets (D2). */
const GROUP_KEY_INFO = 'wa-agent dashboard group keys v1';

/**
 * The meeting dependencies (Phase 3), built only when MEETINGS_ENABLED is true. Nothing here calls Google: without the
 * meeting scopes the app keeps meetings paused (google_scopes) and makes no Google meeting call. Logs codes only.
 */
async function meetingDeps(
  o: {
    env: Env; db: Db; api: LiveMeetingsApi; apiKey: string; prices: Prices; configs: ClientConfig[]; log: Logger;
    /** The local engine shared with voice notes (sharedLocalEngine); undefined unless a setting is local. */
    localEngine: LocalEngine | undefined;
  },
): Promise<AppMeetingsDeps> {
  const { env, log, api } = o;
  if (!meetingsReady(o.db)) log.warn({ code: 'google_scopes' }, 'meetings paused: Google sign-in needs meeting access. Run: npm run cli -- google-auth');
  // The main sign-in plus every extra account (google-auth --account), from the hub: rebuilt when one is reconnected.
  let exe: string | null = null;
  try {
    exe = await findFfmpeg(env.FFMPEG_PATH);
  } catch {
    exe = null;
  }
  if (exe === null) log.warn({ code: 'no_ffmpeg' }, 'meetings paused: ffmpeg not found');
  const ffmpeg = exe === null ? null : new Ffmpeg(exe);
  // STT_API_KEY goes to the provider only. STT_PROVIDER=local: the shared engine, or none when its files are missing
  // (sttProblem, shown in Health); none: meetings wait. Logs codes and setting names only (tested).
  const { transcriber, sttProblem } = buildMeetingTranscriber(env, { ffmpeg, log, ...(o.localEngine ? { localEngine: o.localEngine } : {}) });
  return {
    api,
    // Empty with one account, so that account's refusal still pauses meetings as before.
    lostAccounts: () => api.lostAccounts(),
    ai: new ClaudeMeetingClient({ apiKey: o.apiKey, model: env.AI_MODEL, prices: o.prices }),
    transcriber,
    sttProblem,
    ffmpeg,
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
  /** Spare-number session files a dashboard link opened and handed to a new sender: closed after app.stop(). */
  const adoptedDbs: Db[] = [];

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
    syncClients(db, configs, systemClock.now()); // a group approved while the service was stopped gets its history queued
    const allow = new AllowList(configs.map((c) => c.groupId));

    // openSessionDb has already restored a session left by a dashboard link that never finished (D3).
    const auth = useEncryptedAuthState(sessionDb, key);
    // Setup mode (src/setupMode.ts, tested): with the dashboard off, a missing link or token stops the service as before,
    // in the same order (the link is checked before the token is read). With it on, the service starts and the dashboard
    // links what is missing; an unreadable token waits the same way.
    if (!env.DASHBOARD_ENABLED && !auth.hasSession) exitEarly(WHATSAPP_NOT_LINKED_EXIT);
    let googleToken: boolean;
    try {
      googleToken = new TokenStore(db, key).load() !== undefined;
    } catch (e) {
      if (!(env.DASHBOARD_ENABLED && e instanceof TokenDecryptError)) throw e;
      googleToken = false;
    }
    const plan = planStartup({ dashboardEnabled: env.DASHBOARD_ENABLED, whatsappLinked: auth.hasSession, googleToken });
    if ('exit' in plan) exitEarly(plan.exit);
    if (plan.whatsapp === 'not_linked') log.warn('setup mode: WhatsApp is not linked; link the founder\'s phone in the dashboard');
    if (plan.google === 'not_connected') log.warn('setup mode: Google is not connected; connect it in the dashboard');
    // One Google client per account, swapped in place on a reconnect: Drive and meetings read theirs on every call.
    const google = buildGoogle({ db, key, credentials: googleCredentials(env), meetingsEnabled: env.MEETINGS_ENABLED, log });

    // Phase 2c: the morning report from the spare number. A missing, damaged or undecryptable spare-number session never
    // stops the service: the founder-number reader runs as usual, each day's report fails until the deadline and is then
    // skipped, and Health says to run link-sender (or link-sender --reset).
    // openMorningReport (tested) opens data/sender-session.db only, and logs only the recipient's last 4 digits.
    // founderNumber: the founder reader's own linked number. A spare-number link to it never sends, even when it is
    // not REPORT_RECIPIENT.
    let report: AppReportDeps | undefined;
    // The founder reader's number at each check, so a relink from the dashboard is followed (falls back to the number
    // linked at start when the file cannot be read: refusing that one too is the safe side).
    const founderNumber = () => readFounderNumber(sessionDbPath(env.DATA_DIR), key) ?? linkedNumber(auth);
    const senderFactory = baileysSenderSocketFactory(silentLogger());
    // With the dashboard: the briefing's settings are changed on its Automations screen (tracker.db; .env gives the
    // defaults), and LiveReport opens the spare number's sender only once it is on with a number (tested). Off: as before.
    let live: LiveReport | undefined;
    let settings: SettingsStore | undefined;
    /** A spare-phone link from the dashboard is running: the session file is being reset, so it is not read meanwhile. */
    let spareLinking = false;
    /** Whether the spare phone is linked: the open sender's state, else its saved session (the briefing may be off). */
    let spareCheck: (() => boolean) | undefined;
    if (env.DASHBOARD_ENABLED) {
      const briefing: { live?: LiveReport } = {};
      spareCheck = spareLinked({ dataDir: env.DATA_DIR, key, briefing: { sender: () => briefing.live?.sender() }, linking: () => spareLinking });
      const store = new SettingsStore({ db, env, clock: systemClock, log, spareLinked: spareCheck });
      settings = store;
      live = new LiveReport({
        db, clock: systemClock, log,
        settings: briefingSettings(store),
        open: senderOpener({ env, masterKey: key, log, factory: senderFactory, founderNumber }),
        healthLine: () => app.health.workbookLine(),
      });
      briefing.live = live;
    } else if (env.REPORT_ENABLED) {
      const started = openMorningReport({
        env, masterKey: key, log, factory: baileysSenderSocketFactory(silentLogger()), founderNumber: linkedNumber(auth),
      });
      senderDb = started.senderDb;
      report = started.report;
    }

    const prices = pricesFromEnv(env);
    const apiKey = requireKey(env, 'ANTHROPIC_API_KEY');
    // A member's phone that could not read a message asks for it again: only messages sent from Open chat are answered.
    const outboxDb = db;
    const sentText = (waId: string, groupId: string) => sentTextFor(outboxDb, waId, groupId);
    // The founder's gateway inside its holder, so a relink from the dashboard replaces it in place. None in setup mode.
    const gateway = founderGateway({
      linked: plan.whatsapp === 'linked',
      build: () => new WhatsAppGateway({ allow, factory: baileysSocketFactory(silentLogger(), sentText), auth: auth.state, saveCreds: auth.saveCreds }),
    });
    // One start time for every wait that counts from the service start: the reconciler's wait for a file, the
    // processor's 24 hours of waits for Claude, and Health's long-wait count (amendments 10f, 12a, 15a, 15f).
    const startedAt = systemClock.now();
    // Phase 3: off (the default) means no meeting dependency is built and no meeting call of any kind is made.
    // One local engine for voice notes and meetings (STT_PROVIDER or VOICE_STT_PROVIDER local), so only one model runs on
    // the CPU at a time; each one's work folder is inside its DATA_DIR/tmp. It checks no file and runs nothing yet.
    const localEngine = sharedLocalEngine(env);
    const meetings = env.MEETINGS_ENABLED ? await meetingDeps({ env, db, api: google.meetings!, apiKey, prices, configs, log, localEngine }) : undefined;
    // Phase 2b: the voice transcriber VOICE_STT_PROVIDER names (src/voiceDeps.ts, tested). A local engine that is not set
    // up, or no ffmpeg, never stops the service: voice notes are then kept, not transcribed, and Health says why.
    const voiceDeps = await buildVoiceDeps(env, { findFfmpeg, log, ...(localEngine ? { localEngine } : {}) });
    // The dashboard's audit log (tracker.db audit_log): sign-in, the owner's changes, phone links and the agent's uploads.
    const auditLog = env.DASHBOARD_ENABLED ? new AuditLog(db, systemClock) : undefined;
    const historyDb = db;
    const app = createApp({
      db,
      clock: systemClock,
      log,
      gateway,
      allow,
      ai: new ClaudeClient({ apiKey, model: env.AI_MODEL, effort: env.AI_EFFORT, prices }),
      drive: google.drive,
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
      ...(live ? { liveReport: live } : {}),
      ...(auditLog ? { publishHooks: publisherAuditHooks((e) => auditLog.record(e), systemClock) } : {}),
      // The Activity row when a newly approved group's earlier messages were read: a count and the client's name.
      ...(auditLog ? { onHistoryRead: ({ clientId, found }: { clientId: number; found: number }) => auditLog.record(historyReadEntry(found, getClient(historyDb, clientId).name)) } : {}),
    });

    // watchGroupsFile catches a throwing onChange (including reloadClients conflicts) and calls onError.
    let currentConfigs = configs;
    const stopWatching = watchGroupsFile(
      env.GROUPS_FILE,
      (next) => {
        app.reloadClients(next);
        currentConfigs = next;
        log.info({ groups: next.length }, 'allow-list reloaded');
      },
      (err) =>
        log.error({ problem: err instanceof Error ? err.message : String(err) }, 'allowed-groups.json change rejected; keeping the previous allow-list'),
    );

    // Only with the dashboard on: its line points there. Off, a Google problem shows when publishing fails, as before.
    if (env.DASHBOARD_ENABLED) app.health.setGoogleConnected(google.connected());
    // Older accounts' emails (for the owner's Connections screen), once; never awaited, never fatal.
    const emailDb = db;
    void fillAccountEmails({ db: emailDb, hub: google.hub, log }).catch(() => {});
    google.hub.onChange((label) => {
      void fillAccountEmails({ db: emailDb, hub: google.hub, log, labels: [label] }).catch(() => {});
      if (env.DASHBOARD_ENABLED) app.health.setGoogleConnected(google.connected());
      // A reconnected main account uploads now, not after the failure backoff (up to 15 minutes).
      if (label === 'main') void app.publisher.publishNow().catch((err: unknown) => log.error({ err }, 'upload after the Google reconnect failed'));
    });
    app.start();
    log.info({ groups: configs.length }, 'WA Agent started');
    // Optional uptime heartbeat: visits HEARTBEAT_URL (never logged) every 5 minutes while the agent is up.
    const heartbeat = env.HEARTBEAT_URL ? new Heartbeat({ url: env.HEARTBEAT_URL, isUp: () => app.health.isUp(), log }) : undefined;
    heartbeat?.start();
    if (heartbeat) log.info('uptime heartbeat on');
    // Owner dashboard: off (the default) means no web server and no port. Not awaited here, so the stop handlers below
    // are in place before anything else is awaited. It never rejects: a dashboard that cannot start resolves to undefined.
    // AgentControl is the dashboard's only way into the agent (read side: status, overview, connections).
    // Only what it reads: the health and the read-only spend view, two settings (no key or link), and status wrappers in
    // place of the live gateway and sender. It queries tracker.db (parameterised reads only).
    const sender = report?.sender;
    const liveReport = live;
    const control = new AgentControl({
      app: { health: app.health, spend: app.spend }, db, clock: systemClock,
      env: { MEETINGS_ENABLED: env.MEETINGS_ENABLED, VOICE_STT_PROVIDER: env.VOICE_STT_PROVIDER },
      gateway: { status: () => gateway.status() },
      ...(liveReport ? { sender: () => liveReport.sender() } : sender ? { sender: { status: () => sender.status(), maskedRecipient: () => sender.maskedRecipient() } } : {}),
      ...(heartbeat ? { heartbeat: { lastBeatAt: () => heartbeat.lastBeatAt() } } : {}),
      ...(spareCheck ? { spareLinked: spareCheck } : {}),
    });
    let links: LinkSessions | undefined;
    let uptime: UptimeLog | undefined;
    let uptimeTimer: NodeJS.Timeout | undefined;
    /** What startDashboard gets besides its own parts: the shared audit log and the agent's routes. */
    let agentRoutes: { audit: AuditLog; mount: (m: DashboardMount) => void } | undefined;
    if (env.DASHBOARD_ENABLED && live && settings && auditLog) {
      const store = settings;
      const audit = auditLog;
      const trackerStore = db;
      // Phone links from the dashboard (D3), one at a time. The founder's relinks the gateway in place; the spare one
      // pauses the briefing while it resets the session file the sender may be using, then hands it the new sender.
      const spare = spareDriver({
        dataDir: env.DATA_DIR, key, factory: senderFactory, founderNumber, briefing: live,
        settingsNumber: () => store.get().reportRecipient,
        adoptDb: (d) => adoptedDbs.push(d),
        linking: (on) => (spareLinking = on),
        log,
      });
      const founder = founderLinkDriver({
        sessionDb, trackerDb: db, key, switchable: gateway, log,
        buildGateway: (a, onQr) => new WhatsAppGateway({
          allow, factory: baileysSocketFactory(silentLogger(), sentText), auth: a.state, saveCreds: a.saveCreds, ...(onQr ? { onQr } : {}),
        }),
      });
      links = new LinkSessions({
        drivers: { founder, spare }, log,
        audit: (event, actor) => audit.record({ actor, event, kind: 'connection', detail: '' }),
      });
      // The 30-day uptime strip: a row whenever up changes, and the daily retention of both logs.
      const log30 = new UptimeLog(db, systemClock);
      uptime = log30;
      let purgedDay = '';
      const keepUptime = () => {
        try {
          log30.tick(app.health.isUp(), app.health.downReason());
          const today = istDate(systemClock.now());
          if (today !== purgedDay) {
            log30.purgeOlderThan(UPTIME_KEEP_DAYS);
            audit.purgeOlderThan(AUDIT_KEEP_DAYS);
            purgedDay = today; // only once both ran: a failed purge is tried again at the next tick
          }
        } catch (err) {
          log.error({ err }, 'uptime log update failed');
        }
      };
      try {
        log30.start(app.health.isUp(), app.health.downReason());
      } catch (err) {
        log.error({ err }, 'uptime log could not start');
      }
      keepUptime();
      uptimeTimer = setInterval(keepUptime, UPTIME_TICK_MS);
      uptimeTimer.unref();
      const directory = new GroupDirectory({ gateway, clock: systemClock });
      // Open chat: a message the last run claimed but never asked WhatsApp for is failed; one it was asking about may
      // have gone and stays unknown. Neither is ever sent again.
      const settled = settleInterrupted(trackerStore, systemClock.now().toISOString());
      if (settled.failed + settled.unknown > 0) log.warn(settled, 'dashboard messages interrupted by the last stop');
      const meetingsApi = google.meetings;
      const phoneLinks = links;
      agentRoutes = {
        audit,
        // On the guard, session store and limiter startDashboard builds: every route shares them.
        mount: (m) => mountAgentRoutes(m, {
          db: trackerStore, clock: systemClock, log, control, spend: app.spend, health: () => app.health.snapshot(),
          ...(meetingsApi ? { accountOf: (c: string) => meetingsApi.accountOf(c) } : {}),
          voiceLocal: env.VOICE_STT_PROVIDER === 'local',
          uptime: { log: log30, ...(env.UPTIMEROBOT_READ_KEY ? { robot: new UptimeRobotClient({ apiKey: env.UPTIMEROBOT_READ_KEY, clock: systemClock, log }) } : {}) },
          ownerEmails: env.DASHBOARD_OWNER_EMAILS,
          settings: store,
          groups: {
            db: trackerStore, directory, groupsFile: env.GROUPS_FILE, configs: () => currentConfigs,
            groupKey: makeGroupKey(deriveSubkey(key, GROUP_KEY_INFO)), log, clock: systemClock,
          },
          clients: { db: trackerStore, directory, clock: systemClock, quietMinutes: env.QUIET_MINUTES },
          // Open chat. Sending goes through the founder gateway's own check (an approved group, while open) and only
          // while the owner has it switched on in Settings.
          chat: {
            db: trackerStore, configs: () => currentConfigs, sendingOn: () => store.get().dashboardSend,
            connected: () => gateway.status().state === 'open', groupSocket: (groupId) => gateway.groupSocket(groupId),
            directory, log, clock: systemClock,
          },
          google: {
            db: trackerStore, hub: google.hub, publicUrl: env.DASHBOARD_PUBLIC_URL ?? `http://localhost:${env.DASHBOARD_PORT}`,
            web: googleCredentials(env).web, meetingsEnabled: env.MEETINGS_ENABLED, log, clock: systemClock,
            // The chosen account's email comes from its ID token, checked like the owner sign-in's.
            ...(googleCredentials(env).web ? { verifier: googleIdVerifier(googleCredentials(env).web!.clientId) } : {}),
          },
          actions: {
            publisher: app.publisher, clock: systemClock, limiter: new ActionRateLimiter(systemClock),
            // One models list, no tokens: its own client, so the test never shares the agent's retries.
            listModels: claudeModelsCheck(new Anthropic({ apiKey, fetch: keepConnectTimeoutCode })),
            ...(heartbeat ? { heartbeat } : {}),
          },
          links: phoneLinks,
        }),
      };
    }
    const webReady = env.DASHBOARD_ENABLED ? startDashboard({ env, db, log, control, ...agentRoutes }) : Promise.resolve(undefined);

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
      // The dashboard stops first (in-flight requests get up to 5 s), so no request reaches the app while it drains.
      // Then a phone link still running is undone (its driver restores what it changed), at most 10 s, before the app stops.
      const webStopped = webReady
        .then((w) => w?.stop())
        .catch((err: unknown) => log.error({ err }, 'error while stopping the dashboard'))
        .then(() => Promise.race([links?.stop(), new Promise((r) => setTimeout(r, 10_000).unref())]))
        .catch((err: unknown) => log.error({ err }, 'error while stopping a phone link'));
      void heartbeat?.stop();
      stopWatching();
      void webStopped
        .then(() => app.stop())
        .catch((err) => log.error({ err }, 'error while stopping'))
        .finally(() => {
          // Databases are closed only after app.stop() has settled, so after the morning report's stop() has returned.
          // The uptime log keeps recording through the drain; the stopped time then counts as down.
          clearInterval(uptimeTimer);
          const bestEffort = (fn: () => void) => {
            try {
              fn();
            } catch {
              // best effort: the next close still runs
            }
          };
          bestEffort(() => uptime?.stop());
          for (const d of adoptedDbs) bestEffort(() => d.close());
          bestEffort(() => trackerDb.close());
          bestEffort(() => sessionStore.close());
          bestEffort(() => senderStore?.close());
          void startedLock.release().finally(() => process.exit(0));
          setTimeout(() => process.exit(0), 2000).unref();
        });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (e) {
    try {
      for (const d of adoptedDbs) d.close();
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
