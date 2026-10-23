import { createInterface } from 'node:readline/promises';
import qrcode from 'qrcode-terminal';
import { requireKey, type Env } from '../config/env.ts';
import { loadGroupsFile, type ClientConfig } from '../config/groups.ts';
import { masterKeyPath, sessionDbPath, trackerDbPath } from '../config/paths.ts';
import { DpapiKeyProvider, type KeyProvider } from '../crypto/keyProvider.ts';
import { MediaRefSealer } from '../media/ref.ts';
import { readHealthSnapshot } from '../health/health.ts';
import { requestedScopes, runLoopbackConsent, saveGrantedScopes, scopeName, TokenStore, type ConsentClient } from '../output/googleAuth.ts';
import { latestBatches } from '../store/batches.ts';
import { listClients, syncClients } from '../store/clients.ts';
import { openDb, type Db } from '../store/db.ts';
import { setKv } from '../store/kv.ts';
import { unprocessedCounts } from '../store/messages.ts';
import { acquireLock } from '../util/lock.ts';
import { silentLogger } from '../util/logger.ts';
import { AllowList } from '../wa/allowlist.ts';
import { openSessionDb, resetSession, SessionDecryptError, useEncryptedAuthState, type EncryptedAuth } from '../wa/authState.ts';
import { baileysSocketFactory, WhatsAppGateway, type GatewayState, type SocketFactory } from '../wa/gateway.ts';
import { Ingestor } from '../wa/ingest.ts';
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
  };
}

const countMessages = (db: Db) => (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;

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
  gateway.onEvent((e) => {
    ingestor.handle(e);
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
    syncClients(db, configs);
    if (opts.reset) {
      let hasSession: boolean;
      try {
        hasSession = useEncryptedAuthState(sessionDb, key).hasSession;
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
          'This removes the saved WhatsApp link. The founder will have to scan a new QR code. First remove the old "WA Agent" device on his phone (Settings → Linked devices). Your tasks and tracker data are not touched. Type yes to continue:',
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
        resetSession(sessionDb);
        setKv(db, 'session_reset_at', new Date().toISOString());
        out('Reset: the saved WhatsApp session was deleted. Your tasks, messages and tracker data were NOT touched.');
      }
    }
    const auth = useEncryptedAuthState(sessionDb, key);
    if (auth.hasSession) {
      out('WhatsApp is already linked. Use --reset only after WhatsApp has unlinked this device.');
      return;
    }
    if (configs.length === 0) out('Note: the allow-list is empty, so nothing will be stored. Run list-groups next.');
    const before = countMessages(db);
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
    out(`Linked. ${countMessages(db) - before} messages saved from the allowed groups.`);
    out('Next: npm run cli -- list-groups (if you still need group ids), then start the service: net start wa-agent');
  } finally {
    sessionDb?.close();
    db?.close();
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
    syncClients(db, configs);
    const auth = useEncryptedAuthState(sessionDb, key);
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
    sessionDb?.close();
    db?.close();
    await lock.release();
  }
}

export function statusCommand(deps: CliDeps): void {
  const db = openDb(trackerDbPath(deps.env.DATA_DIR));
  try {
    deps.out(
      formatStatus({
        snapshot: readHealthSnapshot(db),
        clients: listClients(db, false),
        batches: latestBatches(db),
        unprocessed: unprocessedCounts(db),
        now: new Date(),
      }),
    );
  } finally {
    db.close();
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
    const tokens = new TokenStore(db, key);
    // Both or neither: the scope record must describe the token beside it.
    db.transaction(() => {
      tokens.save(refreshToken);
      saveGrantedScopes(db, scope);
    })();
    out(`${env.MEETINGS_ENABLED ? 'Google Drive, Meet and Calendar' : 'Google Drive'} connected. If the WA Agent service is running, restart it so it uses the new sign-in: net stop wa-agent, then net start wa-agent`);
  } finally {
    db.close();
  }
}
