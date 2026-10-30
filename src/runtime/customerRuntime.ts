import Anthropic from '@anthropic-ai/sdk';
import { createApp, type App, type AppMeetingsDeps, type AppReportDeps } from '../app.ts';
import { ClaudeAssistantClient } from '../brain/assistantClient.ts';
import { ClaudeClient, keepConnectTimeoutCode } from '../brain/claudeClient.ts';
import { ClaudeMediaClient } from '../brain/mediaClient.ts';
import { ClaudeMeetingClient } from '../brain/meetingClient.ts';
import { parseEnv, requireKey } from '../config/env.ts';
import type { Env } from '../config/env.ts';
import { watchGroupsFile } from '../config/groups.ts';
import type { ClientConfig } from '../config/groups.ts';
import { sessionDbPath } from '../config/paths.ts';
import { PrioritySettings } from '../config/prioritySettings.ts';
import { CUSTOMER_DEFAULT_CAP_USD, SettingsStore } from '../config/settingsStore.ts';
import { ActionRateLimiter, claudeModelsCheck } from '../control/actions.ts';
import { historyReadEntry, publisherAuditHooks } from '../control/activityQueries.ts';
import { AgentControl } from '../control/agentControl.ts';
import { GroupDirectory } from '../control/groups.ts';
import { deriveSubkey } from '../crypto/keyProvider.ts';
import { Heartbeat } from '../health/heartbeat.ts';
import { UptimeLog } from '../health/uptimeLog.ts';
import { UptimeRobotClient } from '../health/uptimeRobot.ts';
import { baileysFetcher } from '../media/fetch.ts';
import { MediaRefSealer } from '../media/ref.ts';
import type { LiveMeetingsApi } from '../meetings/multiAccount.ts';
import { buildMeetingTranscriber } from '../meetings/transcribe.ts';
import { fillAccountEmails } from '../output/accountEmail.ts';
import { accountEmail, grantedScopes, MAIN_ACCOUNT, meetingsReady, TokenDecryptError, TokenStore } from '../output/googleAuth.ts';
import { founderMailer, oauthGmailTransport } from '../platform/gmailSender.ts';
import { briefingSettings, spareDriver, spareLinked } from '../report/dashboardReport.ts';
import { LiveReport } from '../report/liveReport.ts';
import { openMorningReport, senderOpener } from '../report/start.ts';
import { buildGoogle, founderGateway, googleCredentials, planStartup, WHATSAPP_NOT_LINKED_EXIT } from '../setupMode.ts';
import type { GlobalSpend } from '../spend/globalSpend.ts';
import { pricesFromEnv } from '../spend/pricing.ts';
import type { Prices } from '../spend/pricing.ts';
import { getClient, syncClients } from '../store/clients.ts';
import type { Db } from '../store/db.ts';
import { sentTextFor, settleInterrupted } from '../store/outbox.ts';
import { Ffmpeg, findFfmpeg } from '../stt/audio.ts';
import { sharedLocalEngine, type LocalEngine } from '../stt/local.ts';
import { transcriberChoice } from '../stt/transcriberChoice.ts';
import { systemClock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { silentLogger } from '../util/logger.ts';
import { istDate } from '../util/time.ts';
import { buildVoiceDeps } from '../voiceDeps.ts';
import { AllowList } from '../wa/allowlist.ts';
import { FounderNumberWatch, openPhoneSession, readFounderNumber, sessionHomeOf, useEncryptedAuthState } from '../wa/authState.ts';
import { baileysSocketFactory, WhatsAppGateway } from '../wa/gateway.ts';
import { founderLinkDriver, LinkSessions } from '../wa/linkSession.ts';
import { baileysSenderSocketFactory, linkedNumber } from '../wa/senderGateway.ts';
import { AuditLog, type AuditInput } from '../web/audit.ts';
import { mountAgentRoutes } from '../web/mountRoutes.ts';
import { parseCookies } from '../web/http.ts';
import { browserLabel, googleCodeExchanger, googleIdVerifier } from '../web/oidc.ts';
import type { IncomingMessage } from 'node:http';
import type { RequestContext } from '../web/router.ts';
import { SESSION_COOKIE, sessionCookie, type SessionStore } from '../web/sessions.ts';
import { makeGroupKey } from '../web/routes/groups.ts';
import type { PlatformRouteDeps } from '../web/routes/platform.ts';
import type { DashboardMount } from '../web/start.ts';
import type { RuntimeFacts } from './supervisor.ts';

// One customer's runtime (SaaS S4.4): everything main.ts used to build for the founder between opening the databases
// and starting the web server, behind one function, with no behaviour change for the founder. main.ts keeps what the
// process has once (env, the master key, the instance lock, the stores, the web server, the signals and the shutdown
// order); this file builds the rest for one customer. For a customer (Phase B) it is built from that customer's profile
// (src/runtime/customerProfile.ts), its own Db and data key: its groups are its own clients rows, its gateway opens only
// a session already linked, and it has no report, spare phone, heartbeat or dashboard routes yet (scope, Phase B 4).

/** A customer's settings store falls back to these (neutral, never the founder's), given to the store only. */
const CUSTOMER_REPORT_DEFAULTS = (() => {
  const e = parseEnv({});
  return { REPORT_ENABLED: false, REPORT_DAYS: e.REPORT_DAYS, REPORT_RECIPIENT: undefined, REPORT_TIME: e.REPORT_TIME, REPORT_DEADLINE: e.REPORT_DEADLINE };
})();

/** Expected startup refusal. The message is safe to print. */
export class StartupExit extends Error {}

/** How often the dashboard's uptime log is brought up to date, and how long it and the audit log are kept. */
const UPTIME_TICK_MS = 30_000;
const UPTIME_KEEP_DAYS = 90;
const AUDIT_KEEP_DAYS = 90;
/** The HKDF label of the secret that turns group ids into the opaque keys the browser gets (D2). */
const GROUP_KEY_INFO = 'wa-agent dashboard group keys v1';

/**
 * The speech settings a runtime gets (D2, owner 30 Oct): the founder's are as set; a customer never uses the founder's
 * paid speech-to-text, so a paid choice becomes none and STT_API_KEY is left out (src/stt/transcriberChoice.ts decides).
 */
export function sttEnvFor(env: Env, founder: boolean): Env {
  if (founder) return env;
  const voice = transcriberChoice({ founder, sttProvider: env.VOICE_STT_PROVIDER });
  const meetings = transcriberChoice({ founder, sttProvider: env.STT_PROVIDER });
  const { STT_API_KEY: _founderOnly, ...rest } = env;
  return { ...rest, VOICE_STT_PROVIDER: voice.kind === 'local' ? 'local' : 'none', STT_PROVIDER: meetings.kind === 'local' ? 'local' : 'none' };
}

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
  if (!(await meetingsReady(o.db))) log.warn({ code: 'google_scopes' }, 'meetings paused: Google sign-in needs meeting access. Run: npm run cli -- google-auth');
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

export interface RuntimeDeps {
  env: Env;
  log: Logger;
  /** The customer's tracker Db (data/tracker.db, or its PgTenantDb). Opened and closed by the caller. */
  db: Db;
  /** The master key (S4.2 gives each customer its own). */
  key: Buffer;
  /** config/allowed-groups.json, read by the caller. */
  configs: ClientConfig[];
  /**
   * The platform-wide ceiling over spend billed to the founder (S4.3, owner decision D3): only the founder's runtime joins
   * it. A customer runtime is on the customer's own Anthropic key, under its own daily limit only, so one busy customer
   * can never pause the founder or another customer.
   */
  globalSpend?: GlobalSpend;
  /**
   * The platform tables' Db (decision D1): the tracker itself on SQLite, wa_platform's pool on Postgres. Given to the founder's
   * runtime only: its dashboard hosts the platform screens (invites, customers) and the public sign-up (S5H).
   */
  platformDb?: Db;
  /**
   * Each customer's own Db (Postgres: customerDbsOf, on the tracker's pool). Customer sessions need it for their sign-in's audit
   * row; absent (SQLite) none is started.
   */
  customerDb?: (tenantId: string) => Db;
  /**
   * The Supervisor's parts for the platform screens (S4.5, S4.9): the onboarding probes, each customer's runtime and memory,
   * the active limit, each customer's AiKeys (its setup shell's), and the poke after a change. Only with PLATFORM_ENABLED.
   */
  platformHooks?: Pick<PlatformRouteDeps, 'probes' | 'health' | 'maxActive' | 'aiKeys' | 'poke'>;
  /** Told the name of each database this runtime closes (tests). */
  onClose?: (name: string) => void;
}

export interface CustomerRuntime {
  readonly tenantId: string;
  readonly app: App;
  /** The dashboard's only way into the agent. */
  readonly control: AgentControl;
  /** What startDashboard gets besides its own parts: the shared audit log and the agent's routes (dashboard on). */
  readonly agentRoutes: { audit: AuditLog; mount: (m: DashboardMount) => void } | undefined;
  /** Whether this runtime's dashboard has the platform routes and the sign-up (the founder's, with PLATFORM_ENABLED). */
  readonly platform: boolean;
  /** What the Getting started checklist reads (S4.9): from what this runtime holds in memory. */
  facts(): RuntimeFacts;
  /** Starts the app, the heartbeat and the uptime log. Synchronous: nothing is awaited after it before the stop handlers. */
  start(): void;
  /** The synchronous first step of a stop: the heartbeat and the groups file watcher stop at once. */
  beginStop(): void;
  /**
   * The rest, after the web server has stopped: a phone link still running is undone (at most 10 s), the app stops,
   * then the uptime log's stop row, then this runtime's own databases close (the tracker is the caller's). Rejects
   * with app.stop()'s error, after the closing.
   */
  stop(): Promise<void>;
}

/**
 * Builds one customer's runtime (S4.4). On a failure while building, the session databases it opened are closed and the
 * error is rethrown; the tracker Db is the caller's.
 */
export async function buildCustomerRuntime(
  t: { id: string; founder: boolean; /** A customer's: where its gateway reports a crash (the Supervisor). */ crashed?: (e: unknown) => void },
  d: RuntimeDeps,
): Promise<CustomerRuntime> {
  const { log, db, key, configs } = d;
  const env = sttEnvFor(d.env, t.founder);
  let sessionDb: Db | undefined;
  let senderDb: Db | undefined;
  /** Spare-number session files a dashboard link opened and handed to a new sender: closed after app.stop(). */
  const adoptedDbs: Db[] = [];
  const closeOwn = async () => {
    // Each close waits for its database's queue to empty; one that fails never stops the next (best effort).
    for (const [name, x] of [...adoptedDbs.map((a) => ['adopted', a] as const), ['session', sessionDb] as const, ['sender', senderDb] as const]) {
      if (!x) continue;
      await x.close().catch(() => undefined);
      d.onClose?.(name);
    }
  };

  /** Stops startup with a one-line message; main.ts's catch cleans up and exits with code 2. */
  function exitEarly(message: string): never {
    throw new StartupExit(message);
  }

  try {
    // The WhatsApp sessions (S2.6c2): data/session.db and data/sender-session.db, or wa_auth on the customer's Db.
    const sessions = sessionHomeOf(env, db);
    // On Postgres the founder's number is not read from a file at each check: FounderNumberWatch reads it at start and
    // again after every committed write to the founder's rows (a relink from the dashboard).
    const founderWatch = t.founder && sessions.engine === 'postgres'
      ? new FounderNumberWatch(sessions, key, (err) => log.error({ err }, "the founder's linked number could not be read"))
      : undefined;
    sessionDb = await openPhoneSession(sessions, 'founder', founderWatch ? { onChange: founderWatch.refresh } : {});
    await founderWatch?.start();

    // The founder's groups file is synced in (a group approved while the service was stopped gets its history queued); a
    // customer's groups are its own clients rows already (Phase B: no file).
    if (t.founder) await syncClients(db, configs, systemClock.now());
    const allow = new AllowList(configs.map((c) => c.groupId));

    // openPhoneSession has already restored a session left by a dashboard link that never finished (D3).
    const auth = await useEncryptedAuthState(sessionDb, key);
    // Setup mode (src/setupMode.ts, tested): with the dashboard off, a missing link or token stops the service as before,
    // in the same order (the link is checked before the token is read). With it on, the service starts and the dashboard
    // links what is missing; an unreadable token waits the same way.
    if (!env.DASHBOARD_ENABLED && !auth.hasSession) exitEarly(WHATSAPP_NOT_LINKED_EXIT);
    let googleToken: boolean;
    try {
      googleToken = (await new TokenStore(db, key).load()) !== undefined;
    } catch (e) {
      if (!(env.DASHBOARD_ENABLED && e instanceof TokenDecryptError)) throw e;
      googleToken = false;
    }
    const plan = planStartup({ dashboardEnabled: env.DASHBOARD_ENABLED, whatsappLinked: auth.hasSession, googleToken });
    if ('exit' in plan) exitEarly(plan.exit);
    if (plan.whatsapp === 'not_linked') log.warn('setup mode: WhatsApp is not linked; link the founder\'s phone in the dashboard');
    if (plan.google === 'not_connected') log.warn('setup mode: Google is not connected; connect it in the dashboard');
    // One Google client per account, swapped in place on a reconnect: Drive and meetings read theirs on every call.
    const google = await buildGoogle({ db, key, credentials: googleCredentials(env), meetingsEnabled: env.MEETINGS_ENABLED, log });
    // The platform (S5H, PLATFORM_ENABLED) is the founder's: its screens and the public sign-up, on the platform Db. Invites go from the founder's
    // Gmail once the main account has gmail.send: its scopes and address are async reads, so they are read now and after
    // each reconnect of the main account, and the mailer getter (run on every request) reads what was last read.
    const platformDb = t.founder && env.PLATFORM_ENABLED ? d.platformDb : undefined;
    let gmail: { scopes: readonly string[]; from: string | null } = { scopes: [], from: null };
    const readGmail = async () => {
      gmail = { scopes: await grantedScopes(db, MAIN_ACCOUNT), from: await accountEmail(db, MAIN_ACCOUNT) };
    };
    const refreshGmail = () => {
      if (platformDb) void readGmail().catch((err: unknown) => log.error({ err }, "the founder's Gmail permission could not be read"));
    };
    if (platformDb) await readGmail();
    const mailer = () => {
      if (!google.hub.client(MAIN_ACCOUNT)) return null;
      return founderMailer({ grantedScopes: gmail.scopes, from: gmail.from, transport: oauthGmailTransport(() => google.hub.client(MAIN_ACCOUNT)!) });
    };

    // Phase 2c: the morning report from the spare number. A missing, damaged or undecryptable spare-number session never
    // stops the service: the founder-number reader runs as usual, each day's report fails until the deadline and is then
    // skipped, and Health says to run link-sender (or link-sender --reset).
    // openMorningReport (tested) opens data/sender-session.db only, and logs only the recipient's last 4 digits.
    // founderNumber: the founder reader's own linked number. A spare-number link to it never sends, even when it is
    // not REPORT_RECIPIENT.
    let report: AppReportDeps | undefined;
    // The founder reader's number at each check, so a relink from the dashboard is followed (falls back to the number
    // linked at start when the file cannot be read: refusing that one too is the safe side).
    const founderNumber = () =>
      (!t.founder ? undefined : founderWatch ? founderWatch.current() : readFounderNumber(sessionDbPath(env.DATA_DIR), key)) ?? linkedNumber(auth);
    const senderFactory = baileysSenderSocketFactory(silentLogger());
    // With the dashboard: the briefing's settings are changed on its Automations screen (tracker.db; .env gives the
    // defaults), and LiveReport opens the spare number's sender only once it is on with a number (tested). Off: as before.
    let live: LiveReport | undefined;
    let settings: SettingsStore | undefined;
    /** A spare-phone link from the dashboard is running: the session file is being reset, so it is not read meanwhile. */
    let spareLinking = false;
    /** Whether the spare phone is linked: the open sender's state, else its saved session (the briefing may be off). */
    let spareCheck: (() => Promise<boolean>) | undefined;
    if (!t.founder) {
      // No report, so no spare phone and no briefing: the store holds the customer's own settings (its daily Claude
      // limit). The report defaults it falls back to are neutral, given to the store only, never in the customer's env.
      settings = await SettingsStore.open({ db, env: CUSTOMER_REPORT_DEFAULTS, clock: systemClock, log, customer: true });
    } else if (env.DASHBOARD_ENABLED) {
      const briefing: { live?: LiveReport } = {};
      spareCheck = spareLinked({ dataDir: env.DATA_DIR, sessions, key, briefing: { sender: () => briefing.live?.sender() }, linking: () => spareLinking });
      const store = await SettingsStore.open({ db, env, clock: systemClock, log, spareLinked: spareCheck, customer: !t.founder });
      settings = store;
      live = new LiveReport({
        db, clock: systemClock, log,
        settings: briefingSettings(store),
        open: senderOpener({ env, sessions, masterKey: key, log, factory: senderFactory, founderNumber }),
        healthLine: () => app.health.workbookLine(),
      });
      briefing.live = live;
    } else if (env.REPORT_ENABLED) {
      const started = await openMorningReport({
        env, sessions, masterKey: key, log, factory: baileysSenderSocketFactory(silentLogger()), founderNumber: linkedNumber(auth),
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
      build: () => new WhatsAppGateway({
        allow, factory: baileysSocketFactory(silentLogger(), sentText), auth: auth.state, saveCreds: auth.saveCreds,
        ...(!t.founder && t.crashed ? { tenantId: t.id, report: (_id: string, e: unknown) => t.crashed!(e) } : {}),
      }),
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
    // An audit row written outside any transaction (the publisher's hooks, phone links): it never rejects, a failure is
    // logged, so a hook that does not wait for it can never leave an unhandled rejection.
    const auditOutside = (a: AuditLog) => (e: AuditInput): Promise<void> =>
      a.record(e).catch((err: unknown) => log.error({ err }, 'audit row not written'));
    const historyDb = db;
    // Priority keywords and the sentiment switch: the dashboard changes them, every batch reads them (defaults without it).
    const prioritySettings = await PrioritySettings.open({ db, clock: systemClock });
    const app = await createApp({
      db,
      clock: systemClock,
      log,
      priority: () => prioritySettings.get(),
      gateway,
      allow,
      ai: new ClaudeClient({ apiKey, model: env.AI_MODEL, effort: env.AI_EFFORT, prices }),
      drive: google.drive,
      prices,
      // The founder: DAILY_SPEND_CAP_USD (.env only), under the platform ceiling. A customer: its own limit, on its own key.
      spendCapUsd: t.founder ? env.DAILY_SPEND_CAP_USD : (settings?.get().dailySpendCapUsd ?? CUSTOMER_DEFAULT_CAP_USD),
      ...(t.founder && d.globalSpend ? { platformSpend: { global: d.globalSpend, tenantId: t.id } } : {}),
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
      ...(auditLog ? { publishHooks: publisherAuditHooks(auditOutside(auditLog), systemClock) } : {}),
      // The Activity row when a newly approved group's earlier messages were read: a count and the client's name.
      ...(auditLog
        ? {
          onHistoryRead: ({ clientId, found }: { clientId: number; found: number }) => {
            void getClient(historyDb, clientId)
              .then((c) => auditLog.record(historyReadEntry(found, c.name)))
              .catch((err: unknown) => log.error({ err }, 'history read audit failed'));
          },
        }
        : {}),
    });

    // watchGroupsFile catches a throwing onChange (including reloadClients conflicts) and calls onError.
    let currentConfigs = configs;
    const stopWatching = !t.founder ? () => {} : watchGroupsFile(
      env.GROUPS_FILE,
      async (next) => {
        await app.reloadClients(next);
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
    // The founder's Gmail address is among them: it is read again once they are filled in.
    void fillAccountEmails({ db: emailDb, hub: google.hub, log }).catch(() => {}).then(refreshGmail);
    google.hub.onChange((label) => {
      void fillAccountEmails({ db: emailDb, hub: google.hub, log, labels: [label] })
        .catch(() => {})
        .then(() => {
          if (label === MAIN_ACCOUNT) refreshGmail();
        });
      if (env.DASHBOARD_ENABLED) app.health.setGoogleConnected(google.connected());
      // A reconnected main account uploads now, not after the failure backoff (up to 15 minutes).
      if (label === 'main') void app.publisher.publishNow().catch((err: unknown) => log.error({ err }, 'upload after the Google reconnect failed'));
    });
    // Open chat: a message the last run claimed but never asked WhatsApp for is failed; one it was asking about may
    // have gone and stays unknown. Neither is ever sent again. Settled here, before app.start(): nothing is awaited
    // between app.start() and the stop handlers, and the dashboard cannot claim a new message yet.
    if (env.DASHBOARD_ENABLED) {
      const settled = await settleInterrupted(db, systemClock.now().toISOString());
      if (settled.failed + settled.unknown > 0) log.warn(settled, 'dashboard messages interrupted by the last stop');
    }
    // The 30-day uptime strip's log, opened here (it reads its last row): nothing is awaited after app.start().
    const uptimeLog = env.DASHBOARD_ENABLED && live && settings && auditLog ? await UptimeLog.open(db, systemClock) : undefined;
    // Optional uptime heartbeat: visits HEARTBEAT_URL (never logged) every 5 minutes while the agent is up. The founder's
    // only: it watches this machine's service.
    const heartbeat = t.founder && env.HEARTBEAT_URL ? new Heartbeat({ url: env.HEARTBEAT_URL, isUp: () => app.health.isUp(), log }) : undefined;
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
    /** Starts the uptime strip's log: its start row, then a tick every 30 s (set when the dashboard is on). */
    let startUptime: (() => void) | undefined;
    let agentRoutes: CustomerRuntime['agentRoutes'];
    if (t.founder && env.DASHBOARD_ENABLED && live && settings && auditLog && uptimeLog) {
      const store = settings;
      const audit = auditLog;
      const trackerStore = db;
      // Phone links from the dashboard (D3), one at a time. The founder's relinks the gateway in place; the spare one
      // pauses the briefing while it resets the session file the sender may be using, then hands it the new sender.
      const spare = spareDriver({
        dataDir: env.DATA_DIR, sessions, key, factory: senderFactory, founderNumber, briefing: live,
        settingsNumber: () => store.get().reportRecipient,
        adoptDb: (a) => adoptedDbs.push(a),
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
        audit: (event, actor) => auditOutside(audit)({ actor, event, kind: 'connection', detail: '' }),
      });
      // The 30-day uptime strip: a row whenever up changes, and the daily retention of both logs.
      const log30 = uptimeLog;
      uptime = log30;
      let purgedDay = '';
      // Chained, not awaited: the timer callback stays synchronous, and nothing is awaited before the stop handlers.
      const keepUptime = () => {
        void log30
          .tick(app.health.isUp(), app.health.downReason())
          .then(() => {
            const today = istDate(systemClock.now());
            if (today === purgedDay) return;
            return Promise.all([log30.purgeOlderThan(UPTIME_KEEP_DAYS), audit.purgeOlderThan(AUDIT_KEEP_DAYS)]).then(() => {
              purgedDay = today; // only once both ran: a failed purge is tried again at the next tick
            });
          })
          .catch((err: unknown) => log.error({ err }, 'uptime log update failed'));
      };
      startUptime = () => {
        // The start row first, then the first tick (which then has nothing to add unless up changed meanwhile).
        void log30
          .start(app.health.isUp(), app.health.downReason())
          .catch((err: unknown) => log.error({ err }, 'uptime log could not start'))
          .then(keepUptime);
        uptimeTimer = setInterval(keepUptime, UPTIME_TICK_MS);
        uptimeTimer.unref();
      };
      const directory = new GroupDirectory({ gateway, clock: systemClock });
      const sitePublicUrl = env.DASHBOARD_PUBLIC_URL ?? `http://localhost:${env.DASHBOARD_PORT}`;
      const web = googleCredentials(env).web;
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
          priority: prioritySettings,
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
            web: googleCredentials(env).web, meetingsEnabled: env.MEETINGS_ENABLED, invitesGmail: env.INVITES_GMAIL, log, clock: systemClock,
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
          // The platform (S5H.2 2.2) and the public sign-up (S5H.6 4.1): the founder's dashboard only, on the platform Db.
          ...(platformDb ? {
            platform: { db: platformDb, clock: systemClock, log, publicUrl: sitePublicUrl, founderName: env.PLATFORM_FOUNDER_NAME, mailer, ...d.platformHooks },
            signup: {
              db: platformDb, clock: systemClock, log, publicUrl: sitePublicUrl, founderName: env.PLATFORM_FOUNDER_NAME,
              // The owner sign-in's web client; its redirect URIs must include <DASHBOARD_PUBLIC_URL>/signup/callback.
              google: web ? { clientId: web.clientId, exchange: googleCodeExchanger(web), verify: googleIdVerifier(web.clientId) } : null,
              // Customer sessions exist on Postgres only (S4.8): on SQLite none is started, and the new customer gets the
              // waiting page (the invite is still used and the customer is onboarding).
              startSession: customerSessionStarter({ customerDb: d.customerDb, sessions: m.sessions, secureFor: m.secureFor }),
              secure: m.secureFor,
              ...(d.platformHooks?.poke ? { poke: d.platformHooks.poke } : {}),
            },
          } : {}),
          ...(env.DASHBOARD_ASSISTANT
            ? { assistant: { ai: new ClaudeAssistantClient({ apiKey, model: env.AI_MODEL, effort: env.AI_EFFORT, prices }), paid: app.paidCalls, prices } }
            : {}),
        }),
      };
    }

    let begun = false;
    let stopped: Promise<void> | undefined;
    const beginStop = () => {
      if (begun) return;
      begun = true;
      void heartbeat?.stop();
      stopWatching();
    };
    return {
      tenantId: t.id,
      app,
      control,
      agentRoutes,
      platform: platformDb !== undefined && agentRoutes !== undefined,
      facts: () => ({
        whatsappLinked: gateway.status().state !== 'not_linked',
        spareLinked: false, // the spare phone is the founder's in Phase B
        driveConnected: google.connected(),
        groupsApproved: currentConfigs.length,
        reportTimeSet: settings?.get().source.reportTime === 'dashboard',
        aiKey: 'configured', // a runtime that runs has its Claude key: a customer without one stays in its setup shell
      }),
      start: () => {
        app.start();
        log.info({ groups: configs.length }, 'WA Agent started');
        heartbeat?.start();
        if (heartbeat) log.info('uptime heartbeat on');
        startUptime?.();
      },
      beginStop,
      stop: () => {
        beginStop();
        stopped ??= (async () => {
          try {
            // A phone link still running is undone (its driver restores what it changed), at most 10 s, before the app stops.
            await Promise.race([links?.stop(), new Promise((r) => setTimeout(r, 10_000).unref())]).catch((err: unknown) =>
              log.error({ err }, 'error while stopping a phone link'));
            await app.stop();
          } finally {
            // Databases are closed only after app.stop() has settled, so after the morning report's stop() has returned.
            // The uptime log keeps recording through the drain; the stopped time then counts as down.
            clearInterval(uptimeTimer);
            // The stop row is written before the databases close (best effort: a failure is not retried).
            await Promise.resolve(uptime?.stop()).catch(() => undefined);
            await closeOwn();
          }
        })();
        return stopped;
      },
    };
  } catch (err) {
    // Start-up failed: each session database this runtime opened is closed, best effort.
    await closeOwn();
    throw err;
  }
}

/**
 * The sign-up's startSession (S4.8): a new customer owner's dashboard session, on Postgres only. Without customerDb
 * (SQLite) it starts none and says false, and the sign-up sends the customer to the waiting page. Otherwise: the sign-in's
 * audit row first, in the customer's own Db, then the session on the platform Db (the two cannot share a transaction, so
 * a failed session write leaves an audit row for an attempt, the safe side); a new session id every time (a session this
 * browser had is ended first: no fixation), and the same cookie as the owner's (HttpOnly, SameSite, Secure over https).
 */
export function customerSessionStarter(o: {
  customerDb: ((tenantId: string) => Db) | undefined;
  sessions: Pick<SessionStore, 'create' | 'destroy'>;
  secureFor: (req: IncomingMessage) => boolean;
}): (ctx: RequestContext, s: { email: string; tenantId: string }) => Promise<boolean> {
  return async (ctx, s) => {
    if (!o.customerDb) return false;
    const label = browserLabel(typeof ctx.req.headers['user-agent'] === 'string' ? ctx.req.headers['user-agent'] : undefined);
    await new AuditLog(o.customerDb(s.tenantId), systemClock)
      .record({ actor: s.email, event: 'Signed in', kind: 'auth', detail: label, requestId: ctx.requestId });
    const earlier = parseCookies(typeof ctx.req.headers.cookie === 'string' ? ctx.req.headers.cookie : undefined)[SESSION_COOKIE];
    if (earlier !== undefined) await o.sessions.destroy(earlier);
    const created = await o.sessions.create(s.email, label, undefined, s.tenantId);
    ctx.res.setHeader('Set-Cookie', sessionCookie(created.id, { secure: o.secureFor(ctx.req) }));
    return true;
  };
}

/**
 * The founder's start-up half of main.ts (S4.4): buildCustomerRuntime for customer #1, plus main.ts's close-and-release
 * path when it fails: the tracker and platform Dbs close, the instance lock is let go (bounded: the OS frees it when the
 * process exits anyway), and the error is rethrown for main.ts to report. The lock is released exactly once.
 */
export async function startFounderRuntime(
  d: RuntimeDeps & { tenantId: string; lock: { release(): Promise<void> } },
): Promise<CustomerRuntime> {
  try {
    return await buildCustomerRuntime({ id: d.tenantId, founder: true }, d);
  } catch (err) {
    if (d.platformDb && d.platformDb !== d.db) {
      await d.platformDb.close().catch(() => undefined); // Postgres only: wa_platform's own pool
      d.onClose?.('platform');
    }
    await d.db.close().catch(() => undefined);
    d.onClose?.('tracker');
    try {
      await Promise.race([d.lock.release(), new Promise((r) => setTimeout(r, 2000).unref())]);
    } catch {
      // ignore
    }
    throw err;
  }
}
