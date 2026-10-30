import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import qrcode from 'qrcode-terminal';
import { maskNumber, reportRecipient, reportSettings, requireKey, type Env } from '../config/env.ts';
import { loadGroupsFile, type ClientConfig } from '../config/groups.ts';
import { masterKeyPath, senderSessionDbPath, sessionDbPath, trackerDbPath } from '../config/paths.ts';
import { DpapiKeyProvider, type KeyProvider } from '../crypto/keyProvider.ts';
import { MediaRefSealer } from '../media/ref.ts';
import { readHealthSnapshot } from '../health/health.ts';
import { MAX_FORGET_ATTEMPTS } from '../meetings/sttForget.ts';
import {
  checkAccountLabel, MAIN_ACCOUNT, MEETING_SCOPES, meetingAccounts, removeMeetingAccount, requestedScopes, runLoopbackConsent, saveGrantedScopes,
  saveMeetingAccount, saveTokenIssuer, scopeName, TokenStore, type ConsentClient,
} from '../output/googleAuth.ts';
import { describeReport, isStaleSending, reasonText } from '../report/scheduler.ts';
import { latestBatches } from '../store/batches.ts';
import { listClients, syncClients } from '../store/clients.ts';
import { openDb, type Db } from '../store/db.ts';
import { setKv } from '../store/kv.ts';
import { mediaSttForgetsGivenUp } from '../store/media.ts';
import { sttForgetsGivenUp } from '../store/meetings.ts';
import { unprocessedCounts } from '../store/messages.ts';
import { recentReports, REPORT_REQUEST_KEY, reportFor, reportRequest, type ReportRow } from '../store/reports.ts';
import { acquireLock } from '../util/lock.ts';
import { moveDamagedSession } from '../wa/sessionFiles.ts';
import { silentLogger } from '../util/logger.ts';
import { istDate, istShortDate, istTime } from '../util/time.ts';
import { AllowList } from '../wa/allowlist.ts';
import {
  openSenderSession, openSessionDb, readFounderNumber, resetSession, SenderSessionDecryptError, SessionDecryptError, useEncryptedAuthState,
  useSenderAuthState, type EncryptedAuth,
} from '../wa/authState.ts';
import { baileysSocketFactory, TRACKER_DEVICE_NAME, WhatsAppGateway, type GatewayState, type SocketFactory } from '../wa/gateway.ts';
import { Ingestor } from '../wa/ingest.ts';
import { baileysSenderSocketFactory, linkedNumber, SENDER_DEVICE_NAME, linkSender, type OpenFailure, type SenderSocketFactory } from '../wa/senderGateway.ts';
import { formatStatus } from './status.ts';

export interface CliDeps {
  env: Env;
  keyProvider: KeyProvider;
  socketFactory: SocketFactory;
  /** Test seam passed to runLoopbackConsent. */
  createConsentClient?: (redirectUri: string) => ConsentClient;
  out: (line: string) => void;
  confirm: (question: string) => Promise<boolean>;
  /** How long link / list-groups wait for WhatsApp to connect. */
  linkTimeoutMs: number;
  /** Quiet time after the last allowed event before the post-open phase ends. */
  quietMs: { link: number; listGroups: number };
  /** Hard cap on the whole post-open phase. */
  maxIngestMs: { link: number; listGroups: number };
  /** Socket factory for the spare number (link-sender). Default: Baileys with a silent logger. */
  senderSocketFactory?: SenderSocketFactory;
  /** How long link-sender keeps the new link open before closing. Default 5 s. Test seam. */
  senderSettleMs?: number;
}

/** The operator abandoned a confirmation prompt (Ctrl+C or closed input). */
export class ConfirmCancelled extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'ConfirmCancelled';
  }
}

async function askYes(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const closed = new Promise<never>((_, reject) => rl.once('close', () => reject(new ConfirmCancelled())));
  try {
    return (await Promise.race([rl.question(`${question} `), closed])).trim().toLowerCase() === 'yes';
  } catch {
    throw new ConfirmCancelled();
  } finally {
    rl.close();
  }
}

export function defaultDeps(env: Env): CliDeps {
  return {
    env,
    keyProvider: new DpapiKeyProvider(masterKeyPath(env.DATA_DIR)),
    socketFactory: baileysSocketFactory(silentLogger()),
    out: (l) => console.log(l),
    confirm: askYes,
    linkTimeoutMs: 300_000,
    quietMs: { link: 60_000, listGroups: 15_000 },
    maxIngestMs: { link: 180_000, listGroups: 60_000 },
    senderSocketFactory: baileysSenderSocketFactory(silentLogger()),
  };
}

const countMessages = async (db: Db) => (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages'))!.n;

const ADVICE_LOGGED_OUT = 'WhatsApp refused this session (logged out). Follow docs/SETUP.md → "Status logged_out" before running link --reset.';
const ADVICE_FORBIDDEN = "WhatsApp refused this device (403). Check the founder's phone for a WhatsApp warning; do not reset the link.";
const ADVICE_REPLACED = 'Another WhatsApp Web or WA Agent session took over. Find and close it (another PC or browser). Do not reset the link.';
const ADVICE_TIMEOUT = 'No connection to WhatsApp within 5 minutes. Check the internet connection, then run link again (without --reset).';
const ADVICE_DROPPED = 'The WhatsApp connection dropped before finishing. Run the command again; the service will pick up later messages.';

function terminalAdvice(state: GatewayState): string | undefined {
  if (state === 'logged_out') return ADVICE_LOGGED_OUT;
  if (state === 'forbidden') return ADVICE_FORBIDDEN;
  if (state === 'replaced') return ADVICE_REPLACED;
  return undefined;
}

const POLL_MS = 2_000;

/**
 * Connects with the real allow-list and stores allowed messages. After the connection opens it waits until no allowed
 * event has arrived for quietMs, but never longer than maxIngestMs in total. Throws with advice when WhatsApp refuses
 * or the connection is lost.
 */
async function connectAndIngest(o: {
  deps: CliDeps;
  db: Db;
  auth: EncryptedAuth;
  configs: ClientConfig[];
  /** Seals the download details of shared files so the service can fetch them later. */
  mediaRefs: MediaRefSealer;
  quietMs: number;
  maxIngestMs: number;
  openMessage: string;
  /** Advice when the connection drops after it opened. */
  droppedMessage?: string;
  onQr?: (qr: string) => void;
  afterOpen?: (gateway: WhatsAppGateway) => Promise<void>;
}): Promise<void> {
  const { deps } = o;
  const gateway = new WhatsAppGateway({
    allow: new AllowList(o.configs.map((c) => c.groupId)),
    factory: deps.socketFactory,
    auth: o.auth.state,
    saveCreds: o.auth.saveCreds,
    onQr: o.onQr,
  });
  const ingestor = new Ingestor({ db: o.db, onNewMessages: () => {}, media: { sealer: o.mediaRefs } });
  let lastEvent = Date.now();
  gateway.onEvent(async (e) => {
    await ingestor.handle(e);
    lastEvent = Date.now();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(ADVICE_TIMEOUT)), deps.linkTimeoutMs);
      gateway.onStatus((s) => {
        const advice = terminalAdvice(s.state);
        if (advice) {
          clearTimeout(timeout);
          reject(new Error(advice));
        } else if (s.state === 'open') {
          clearTimeout(timeout);
          resolve();
        }
      });
      gateway.start();
    });
    deps.out(o.openMessage);
    await o.afterOpen?.(gateway);
    const openedAt = Date.now();
    lastEvent = openedAt;
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        const now = Date.now();
        if (now - lastEvent >= o.quietMs || now - openedAt >= o.maxIngestMs || terminalAdvice(gateway.status().state)) {
          clearInterval(t);
          resolve();
        }
      }, POLL_MS);
    });
    const failed = gateway.failedCount();
    if (failed > 0) deps.out(`${failed} messages could not be saved. They are lost from the tracker; check the log, and add anything important by hand.`);
    const state = gateway.status().state;
    if (state !== 'open') throw new Error(terminalAdvice(state) ?? o.droppedMessage ?? ADVICE_DROPPED);
  } finally {
    await gateway.stop();
  }
}

export async function linkCommand(opts: { reset: boolean }, deps: CliDeps): Promise<void> {
  const { env, out } = deps;
  // The lock comes first: nothing is opened while the service may be running.
  const lock = await acquireLock(env.DATA_DIR);
  let db: Db | undefined;
  let sessionDb: Db | undefined;
  try {
    const key = deps.keyProvider.getKey();
    const configs = loadGroupsFile(env.GROUPS_FILE);
    db = openDb(trackerDbPath(env.DATA_DIR));
    sessionDb = openSessionDb(sessionDbPath(env.DATA_DIR));
    await syncClients(db, configs);
    if (opts.reset) {
      let hasSession: boolean;
      try {
        hasSession = (await useEncryptedAuthState(sessionDb, key)).hasSession;
      } catch (e) {
        if (!(e instanceof SessionDecryptError)) throw e;
        hasSession = true; // a stored session this key cannot read: exactly what a reset is for
      }
      if (!hasSession) {
        out('No saved WhatsApp link to reset.');
      } else {
        let yes: boolean;
        try {
          yes = await deps.confirm(
          `This removes the saved WhatsApp link. The founder will have to scan a new QR code. First remove the old "${TRACKER_DEVICE_NAME}" device on his phone (Settings → Linked devices). Your tasks and tracker data are not touched. Type yes to continue:`,
          );
        } catch (e) {
          if (!(e instanceof ConfirmCancelled)) throw e;
          out('Cancelled. Nothing was changed.');
          return;
        }
        if (!yes) {
          out('Nothing was changed.');
          return;
        }
        // Only the agent's own WhatsApp session rows (session.db) are deleted. tracker.db keeps its data.
        await resetSession(sessionDb);
        await setKv(db, 'session_reset_at', new Date().toISOString());
        out('Reset: the saved WhatsApp session was deleted. Your tasks, messages and tracker data were NOT touched.');
      }
    }
    const auth = await useEncryptedAuthState(sessionDb, key);
    if (auth.hasSession) {
      out('WhatsApp is already linked. Use --reset only after WhatsApp has unlinked this device.');
      return;
    }
    if (configs.length === 0) out('Note: the allow-list is empty, so nothing will be stored. Run list-groups next.');
    const before = await countMessages(db);
    await connectAndIngest({
      deps,
      db,
      auth,
      configs,
      mediaRefs: new MediaRefSealer(key),
      quietMs: deps.quietMs.link,
      maxIngestMs: deps.maxIngestMs.link,
      droppedMessage: 'WhatsApp is linked, but the connection dropped while saving recent messages. Start the service (net start wa-agent); it will catch up.',
      openMessage: 'WhatsApp linked. Saving recent messages from the allowed groups (about a minute). Leave this window open.',
      onQr: (qr) => {
        out('');
        out("Scan this QR code with WhatsApp on the founder's phone (Settings → Linked devices → Link a device):");
        qrcode.generate(qr, { small: true }, (art: string) => out(art));
      },
    });
    out(`Linked. ${(await countMessages(db)) - before} messages saved from the allowed groups.`);
    out('Next: npm run cli -- list-groups (if you still need group ids), then start the service: net start wa-agent');
  } finally {
    await sessionDb?.close();
    await db?.close();
    await lock.release();
  }
}

export async function listGroupsCommand(deps: CliDeps): Promise<void> {
  const { env, out } = deps;
  const lock = await acquireLock(env.DATA_DIR);
  let db: Db | undefined;
  let sessionDb: Db | undefined;
  try {
    const key = deps.keyProvider.getKey();
    const configs = loadGroupsFile(env.GROUPS_FILE);
    db = openDb(trackerDbPath(env.DATA_DIR));
    sessionDb = openSessionDb(sessionDbPath(env.DATA_DIR));
    await syncClients(db, configs);
    const auth = await useEncryptedAuthState(sessionDb, key);
    if (!auth.hasSession) {
      out('WhatsApp is not linked yet. Run: npm run cli -- link');
      return;
    }
    const allowed = new Set(configs.map((c) => c.groupId));
    await connectAndIngest({
      deps,
      db,
      auth,
      configs,
      mediaRefs: new MediaRefSealer(key),
      quietMs: deps.quietMs.listGroups,
      maxIngestMs: deps.maxIngestMs.listGroups,
      openMessage: 'Connected. Reading your groups…',
      afterOpen: async (gateway) => {
        out('Groups on this number (this list is shown only on this screen; messages from allowed groups are still saved):\n');
        for (const g of await gateway.listGroups()) out(`${g.id}  ${g.subject}${allowed.has(g.id) ? '   [allowed]' : ''}`);
        out('\nCopy the ids you want into config/allowed-groups.json. Finishing up...');
      },
    });
  } finally {
    await sessionDb?.close();
    await db?.close();
    await lock.release();
  }
}

export async function statusCommand(deps: CliDeps): Promise<void> {
  const db = openDb(trackerDbPath(deps.env.DATA_DIR));
  try {
    deps.out(
      formatStatus({
        snapshot: await readHealthSnapshot(db),
        clients: await listClients(db, false),
        batches: await latestBatches(db),
        unprocessed: await unprocessedCounts(db),
        now: new Date(),
        sttCopiesLeft: await sttForgetsGivenUp(db, { maxAttempts: MAX_FORGET_ATTEMPTS, provider: deps.env.STT_PROVIDER }),
        // Voice-note copies are deleted through the voice transcriber, so VOICE_STT_PROVIDER decides (Task 10), not STT_PROVIDER.
        voiceCopiesLeft: await mediaSttForgetsGivenUp(db, { maxAttempts: MAX_FORGET_ATTEMPTS, provider: deps.env.VOICE_STT_PROVIDER }),
      }),
    );
  } finally {
    await db.close();
  }
}

export async function googleAuthCommand(deps: CliDeps): Promise<void> {
  const { env, out } = deps;
  const key = deps.keyProvider.getKey();
  const db = openDb(trackerDbPath(env.DATA_DIR));
  try {
    const clientId = requireKey(env, 'GOOGLE_OAUTH_CLIENT_ID');
    const clientSecret = requireKey(env, 'GOOGLE_OAUTH_CLIENT_SECRET');
    const scopes = requestedScopes(env);
    out('Google will ask you to allow:');
    for (const s of scopes) out(`  - ${scopeName(s)}`);
    out('Keep every box ticked.\n');
    const { refreshToken, scope } = await runLoopbackConsent({
      clientId,
      clientSecret,
      scopes,
      createClient: deps.createConsentClient,
      showUrl: (url) => {
        out('Open this link in a browser where the mailbox Google account is signed in:\n');
        out(url);
      },
    });
    // Both or neither: the scope record must describe the token beside it.
    await db.tx(async (q) => {
      await new TokenStore(q, key).save(refreshToken);
      await saveGrantedScopes(q, scope);
      // Issued by the desktop client: a 'web' left from an earlier dashboard reconnect would pair it with the wrong client.
      await saveTokenIssuer(q, MAIN_ACCOUNT, 'desktop');
    });
    out(`${env.MEETINGS_ENABLED ? 'Google Drive, Meet and Calendar' : 'Google Drive'} connected. If the WA Agent service is running, restart it so it uses the new sign-in: net stop wa-agent, then net start wa-agent`);
  } finally {
    await db.close();
  }
}

const SENDER_ADVICE: Record<OpenFailure, string> = {
  not_linked: 'The QR code was not scanned. Run link-sender again.',
  connect_timeout: 'No connection to WhatsApp, or the QR code was not scanned within 5 minutes. Check the internet connection, then run link-sender again.',
  logged_out: `WhatsApp refused the link. On the spare phone remove any old "${SENDER_DEVICE_NAME}" device (Linked devices), then run: npm run cli -- link-sender --reset`,
  forbidden: 'WhatsApp refused the spare number (403). Check the spare phone for a WhatsApp warning.',
  replaced: 'Another session took over the spare number. Close it, then run link-sender again.',
  restart_required: 'WhatsApp kept asking for a restart. Run link-sender again.',
  closed: 'The WhatsApp connection dropped before linking finished. Run link-sender again.',
};

const SENDER_DAMAGED = "The spare number's session file (data/sender-session.db) is damaged. Run: npm run cli -- link-sender --reset";

/** Asks for the typed yes. Returns false, after saying nothing was changed, on no or Ctrl+C. */
async function confirmChange(deps: CliDeps, question: string): Promise<boolean> {
  try {
    if (await deps.confirm(question)) return true;
    deps.out('Nothing was changed.');
  } catch (e) {
    if (!(e instanceof ConfirmCancelled)) throw e;
    deps.out('Cancelled. Nothing was changed.');
  }
  return false;
}

/**
 * Links the spare number that sends the morning report. Only data/sender-session.db is written (with --reset, a damaged
 * file is renamed aside, never deleted). The founder's session is only read, read-only, to refuse a link from the
 * founder's own number; the tracker is not opened. It sends nothing.
 */
export async function linkSenderCommand(opts: { reset: boolean }, deps: CliDeps): Promise<void> {
  const { env, out } = deps;
  // The lock comes first: with the service stopped, only one process ever uses the spare number's session.
  const lock = await acquireLock(env.DATA_DIR);
  let senderDb: Db | undefined;
  try {
    const key = deps.keyProvider.getKey();
    const file = senderSessionDbPath(env.DATA_DIR);
    const opened = await openSenderSession(file, key);
    let auth: EncryptedAuth | undefined;
    if (opened.ok) {
      senderDb = opened.db;
      auth = opened.auth;
    } else if (opened.transient) {
      // A lock, permissions or a disk error: the file is not known to be damaged, so moving it aside would be wrong.
      throw new Error(
        `The spare number's session file (data/sender-session.db) could not be opened (${opened.code}). Make sure the service is stopped and no other program has the file open, and check the disk space and the data folder's permissions. Do not use --reset for this.`,
      );
    } else if (!opts.reset) {
      throw opened.code === 'decrypt_failed' ? new SenderSessionDecryptError() : new Error(SENDER_DAMAGED);
    }
    if (opts.reset) {
      if (auth && !auth.hasSession) {
        out('No saved spare-number link to reset.');
      } else if (!opened.ok && opened.code !== 'decrypt_failed') {
        const yes = await confirmChange(
          deps,
          "The spare number's saved session file (data/sender-session.db) is damaged. It will be moved aside (renamed to sender-session.db.damaged-<date-time>), not deleted. The founder's WhatsApp link and all tracker data are not touched. You will scan a new QR code from the spare phone. Type yes to continue:",
        );
        if (!yes) return;
        const movedTo = moveDamagedSession(file, new Date());
        out(`Moved aside: the damaged data/sender-session.db is now ${movedTo} (not deleted). The founder's link and the tracker were NOT touched.`);
        senderDb = openSessionDb(file);
        auth = await useSenderAuthState(senderDb, key);
      } else {
        // A linked session, or one written with another master key: exactly what a reset is for.
        const yes = await confirmChange(
          deps,
          "This removes the saved link of the spare number (data/sender-session.db) only. The founder's WhatsApp link and all tracker data are not touched. You will scan a new QR code from the spare phone. Type yes to continue:",
        );
        if (!yes) return;
        senderDb ??= openSessionDb(file);
        await resetSession(senderDb); // the spare number's session rows only
        out("Reset: the saved spare-number session was deleted. The founder's link and the tracker were NOT touched.");
        auth = await useSenderAuthState(senderDb, key);
      }
    }
    if (!auth) throw new Error(SENDER_DAMAGED); // unreachable: every path without a session returned or threw above
    if (auth.hasSession) {
      out('The spare number is already linked. Use --reset only to link a different number, or after WhatsApp logged it out.');
      return;
    }
    const result = await linkSender({
      factory: deps.senderSocketFactory ?? baileysSenderSocketFactory(silentLogger()),
      auth,
      timeoutMs: deps.linkTimeoutMs,
      settleMs: deps.senderSettleMs,
      onQr: (qr) => {
        out('');
        out("Scan this QR code with WhatsApp on the SPARE phone, not the founder's (WhatsApp > Linked devices > Link a device):");
        qrcode.generate(qr, { small: true }, (art: string) => out(art));
      },
    });
    if (!result.ok) throw new Error(SENDER_ADVICE[result.code]);
    // The founder's number must never send: neither REPORT_RECIPIENT (which may not be set yet) nor the number the
    // founder reader is linked to (session.db, only read here). SenderGateway checks both again at service start and at
    // send time.
    const linked = linkedNumber(auth);
    const founder = readFounderNumber(sessionDbPath(env.DATA_DIR), key);
    if (linked !== undefined && ((env.REPORT_RECIPIENT && linked === env.REPORT_RECIPIENT) || linked === founder)) {
      await resetSession(senderDb!); // the spare number's session rows only: this link is never used
      throw new Error(
        `That QR code was scanned with the founder's phone. On the founder's phone remove the device named "${SENDER_DEVICE_NAME}" (keep "${TRACKER_DEVICE_NAME}", which the tracker uses), then run link-sender again and scan with the SPARE phone.`,
      );
    }
    out('Spare number linked. Next: set REPORT_RECIPIENT and REPORT_ENABLED=true in .env, then start the service (net start wa-agent).');
  } finally {
    await senderDb?.close();
    await lock.release();
  }
}

/** Today's morning report and the last 7 days. Reads the tracker database only. */
export async function reportStatusCommand(deps: CliDeps): Promise<void> {
  const { env, out } = deps;
  const settings = reportSettings(env);
  const now = new Date();
  const today = istDate(now);
  const db = openDb(trackerDbPath(env.DATA_DIR));
  try {
    const snap = await readHealthSnapshot(db);
    const fresh = snap !== undefined && now.getTime() - Date.parse(snap.at) <= SERVICE_FRESH_MS;
    if (settings.enabled) {
      // A running service sends to the number it was started with; .env may name another one since.
      const envMasked = maskNumber(reportRecipient(env));
      const serviceMasked = fresh ? snap.report?.recipientMasked : undefined;
      out(`Morning report: on, ${settings.time} to ${settings.deadline} IST, to the number ending ${serviceMasked ?? envMasked}`);
      if (serviceMasked && serviceMasked !== envMasked) {
        out(
          `⚠️ REPORT_RECIPIENT in .env now ends ${envMasked}, but the running service still sends to the number ending ${serviceMasked}. Restart the service (net stop wa-agent, then net start wa-agent) to use it.`,
        );
      }
    } else {
      out('Morning report: off (set REPORT_ENABLED=true and REPORT_RECIPIENT in .env, then restart the service)');
    }
    const row = await reportFor(db, today);
    if (settings.enabled || row) out(`Today (${today}): ${describeReport(row, now, settings, 'idle').text}`);
    const past = (await recentReports(db, 8)).filter((r) => r.date !== today).slice(0, 7);
    if (past.length > 0) {
      out('Last days:');
      for (const r of past) out(`  ${r.date}  ${r.status.padEnd(8)}${r.status === 'sent' ? `at ${istTime(new Date(r.updatedAt))} IST` : reasonText(r.detail)}`);
    }
    // An old snapshot's warning may no longer hold (the owner may have fixed it since the service stopped).
    if (settings.enabled && snap && !fresh) {
      const at = new Date(snap.at);
      out(`⚠️ The service has not reported since ${istShortDate(at)} ${istTime(at)}. Is it running?`);
    } else if (snap?.report?.warning) {
      out(snap.report.warning);
    }
  } finally {
    await db.close();
  }
}

/** A health snapshot younger than this means the service is running (cli status uses the same 2 minutes). */
const SERVICE_FRESH_MS = 2 * 60_000;

/**
 * Why send-now must not ask for a send while today's row is in this state, or undefined when it may. A 'sending' row
 * older than 10 minutes is not a send in progress: its outcome could not be recorded, status reads it as unknown, and
 * it is treated like an unknown row (the service marks it unknown before it takes the request).
 */
function sendNowRefusal(row: ReportRow | undefined, now: Date): string | undefined {
  if (row?.status === 'sent') return `Today's report was already sent at ${istTime(new Date(row.updatedAt))} IST. Nothing was sent.`;
  if (row?.status === 'sending' && !isStaleSending(row, now)) return "Today's report is being sent right now. Check with: npm run cli -- report status";
  return undefined;
}

/**
 * Asks the running service to send today's report now. It refuses if today was already sent or is being sent, if the
 * service is not running, if the running service has the report off, and if the running service sends to another
 * number than REPORT_RECIPIENT in .env now names (compared by last 4 digits). It sends nothing itself: only the service
 * uses the spare number's session. The request records the row the owner confirmed and the time of the yes, and the
 * service honours it only while today's row is still exactly that, for 5 minutes.
 */
export async function reportSendNowCommand(deps: CliDeps): Promise<void> {
  const { env, out } = deps;
  if (!env.REPORT_ENABLED) {
    out('The morning report is off. Set REPORT_ENABLED=true and REPORT_RECIPIENT in .env, then restart the service.');
    return;
  }
  const now = new Date();
  const today = istDate(now);
  const db = openDb(trackerDbPath(env.DATA_DIR));
  try {
    const row = await reportFor(db, today);
    const refusal = sendNowRefusal(row, now);
    if (refusal) {
      out(refusal);
      return;
    }
    const snap = await readHealthSnapshot(db);
    if (!snap || now.getTime() - Date.parse(snap.at) > SERVICE_FRESH_MS) {
      out('The service is not running, so nothing can be sent. Start it first (net start wa-agent), then run this again.');
      return;
    }
    // The service writes a report line only when it was started with the report on. Without one, nothing would pick the
    // request up now, and a later restart with the report on would send it at once, outside the window.
    if (!snap.report) {
      out(
        'The running service has the morning report off (it was started before REPORT_ENABLED=true was set). Restart it (net stop wa-agent, then net start wa-agent), wait a minute, then run this again.',
      );
      return;
    }
    // The running service sends to the number it was started with. If .env names another one now, the owner would
    // confirm one number and the report would go to the other.
    const restart = 'Nothing was sent. Restart the service (net stop wa-agent, then net start wa-agent), wait a minute, then run this again.';
    const envMasked = maskNumber(reportRecipient(env));
    const serviceMasked = snap.report.recipientMasked;
    if (!serviceMasked) {
      out(`The running service does not say which number it sends to (it was started before an update). ${restart}`);
      return;
    }
    if (serviceMasked !== envMasked) {
      out(`The running service sends to the number ending ${serviceMasked}, but REPORT_RECIPIENT in .env now ends ${envMasked}. ${restart}`);
      return;
    }
    const caution =
      row?.status === 'unknown' || isStaleSending(row, now)
        ? "The last try ended without a clear answer, so today's report may already be on the founder's phone. Check the founder's WhatsApp first. "
        : '';
    let yes: boolean;
    try {
      yes = await deps.confirm(`${caution}This sends today's morning report to the number ending ${serviceMasked} now. Type yes to continue:`);
    } catch (e) {
      if (!(e instanceof ConfirmCancelled)) throw e;
      out('Cancelled. Nothing was sent.');
      return;
    }
    if (!yes) {
      out('Nothing was sent.');
      return;
    }
    // The service may have changed today's row while the owner was answering. Read it again and write the request in
    // the same transaction, so the request always names the row it was checked against.
    const answer = await db.tx(async (q): Promise<string | undefined> => {
      const at = new Date();
      if (istDate(at) !== today) return 'The date changed while you were answering. Nothing was sent. Run this again.';
      const current = await reportFor(q, today);
      const late = sendNowRefusal(current, at);
      if (late) return late;
      if (current?.status !== row?.status || current?.updatedAt !== row?.updatedAt) {
        const nowText = describeReport(current, at, reportSettings(env), 'idle').text;
        return `Today's report changed while you were answering (now: ${nowText}). Nothing was sent. Check with: npm run cli -- report status, then run this again if it is still needed.`;
      }
      // Stamped with the time of the yes: the service drops a request older than 5 minutes.
      await setKv(q, REPORT_REQUEST_KEY, reportRequest(today, current, at));
      return undefined;
    });
    out(answer ?? 'Requested. The service sends it within about a minute. Check with: npm run cli -- report status');
  } finally {
    await db.close();
  }
}

const RESTART = 'If the WA Agent service is running, restart it so it uses the change: net stop wa-agent, then net start wa-agent';

/**
 * `google-auth --account <label>`: signs in one more Google account that records Meet meetings. It gets the three
 * read-only meeting permissions only, never Drive file access: summaries still go to the main account's Drive.
 * With --remove: forgets that account here, after a 'yes'.
 */
export async function googleAccountCommand(opts: { account: string; remove: boolean }, deps: CliDeps): Promise<void> {
  const { env, out } = deps;
  const label = checkAccountLabel(opts.account.trim());
  if (!opts.remove && !env.MEETINGS_ENABLED) {
    throw new Error('Extra Google accounts are for meetings. Set MEETINGS_ENABLED=true in .env first.');
  }
  const key = deps.keyProvider.getKey();
  const db = openDb(trackerDbPath(env.DATA_DIR));
  try {
    if (opts.remove) {
      if (!(await meetingAccounts(db)).includes(label)) {
        out(`No Google account named ${label} is connected. Connected: ${(await meetingAccounts(db)).join(', ') || 'none besides the main one'}.`);
        return;
      }
      if (!(await deps.confirm(`Forget Google account ${label} here? Its meetings are no longer found. Type yes to continue: `))) {
        out('Nothing was changed.');
        return;
      }
      await removeMeetingAccount(db, label);
      out(`Google account ${label} forgotten here. To end its access at Google too, remove WA Agent at myaccount.google.com/permissions while signed in as that account.`);
      out(RESTART);
      return;
    }
    out(`Google will ask the account you sign in with (${label}) to allow:`);
    for (const s of MEETING_SCOPES) out(`  - ${scopeName(s)}`);
    out('Keep every box ticked.\n');
    const { refreshToken, scope } = await runLoopbackConsent({
      clientId: requireKey(env, 'GOOGLE_OAUTH_CLIENT_ID'),
      clientSecret: requireKey(env, 'GOOGLE_OAUTH_CLIENT_SECRET'),
      scopes: MEETING_SCOPES,
      requireDrive: false,
      createClient: deps.createConsentClient,
      showUrl: (url) => {
        out(`Open this link in a browser, and choose the Google account that records the meetings for ${label}:\n`);
        out(url);
      },
    });
    await saveMeetingAccount(db, key, label, refreshToken, scope);
    out(`Google account ${label} connected for meetings (read only). Connected accounts: main, ${(await meetingAccounts(db)).join(', ')}.`);
    out(RESTART);
  } finally {
    await db.close();
  }
}

export interface ReportCommandHandlers {
  linkSender: (opts: { reset: boolean }, deps: CliDeps) => Promise<void>;
  reportStatus: (deps: CliDeps) => void;
  reportSendNow: (deps: CliDeps) => Promise<void>;
}

const REPORT_HANDLERS: ReportCommandHandlers = {
  linkSender: linkSenderCommand,
  reportStatus: reportStatusCommand,
  reportSendNow: reportSendNowCommand,
};

/** Adds link-sender, report status and report send-now to the CLI. deps is called only when a command runs. */
export function addReportCommands(program: Command, deps: () => CliDeps, h: ReportCommandHandlers = REPORT_HANDLERS): void {
  program
    .command('link-sender')
    .description('Link the spare number that sends the morning report (stop the service first)')
    .option('--reset', 'discard the saved spare-number session only, or move a damaged one aside (the founder link and tracker data are kept); asks first')
    .action(async (opts: { reset?: boolean }) => h.linkSender({ reset: opts.reset === true }, deps()));

  const report = program.command('report').description('Morning report');
  report.command('status').description("Today's morning report and the last 7 days").action(() => h.reportStatus(deps()));
  report
    .command('send-now')
    .description("Ask the running service to send today's report now (asks first; refuses if already sent)")
    .action(async () => h.reportSendNow(deps()));
}
