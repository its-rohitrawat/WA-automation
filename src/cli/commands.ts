import { join } from 'node:path';
import qrcode from 'qrcode-terminal';
import { loadEnv, requireKey, type Env } from '../config/env.ts';
import { loadGroupsFile, type ClientConfig } from '../config/groups.ts';
import { DpapiKeyProvider } from '../crypto/keyProvider.ts';
import { readHealthSnapshot } from '../health/health.ts';
import { DRIVE_SCOPES, runLoopbackConsent, TokenStore } from '../output/googleAuth.ts';
import { latestBatches } from '../store/batches.ts';
import { listClients, syncClients } from '../store/clients.ts';
import { openDb, type Db } from '../store/db.ts';
import { unprocessedCounts } from '../store/messages.ts';
import { acquireLock } from '../util/lock.ts';
import { silentLogger } from '../util/logger.ts';
import { AllowList } from '../wa/allowlist.ts';
import { openSessionDb, resetSession, useEncryptedAuthState, type EncryptedAuth } from '../wa/authState.ts';
import { baileysSocketFactory, WhatsAppGateway } from '../wa/gateway.ts';
import { Ingestor } from '../wa/ingest.ts';
import { formatStatus } from './status.ts';

const keyFile = (env: Env) => join(env.DATA_DIR, 'keys', 'master.key.dpapi');
const trackerDb = (env: Env) => join(env.DATA_DIR, 'tracker.db');
const countMessages = (db: Db) => (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;

function printQr(qr: string): void {
  console.clear();
  console.log("On the founder's phone: WhatsApp > Settings > Linked devices > Link a device, then scan this code:\n");
  qrcode.generate(qr, { small: true });
}

/** Connects with the real allow-list, stores allowed messages, and stops once no new events arrive for settleMs. */
async function connectAndIngest(o: {
  db: Db;
  auth: EncryptedAuth;
  configs: ClientConfig[];
  settleMs: number;
  onQr?: (qr: string) => void;
  afterOpen?: (gateway: WhatsAppGateway) => Promise<void>;
}): Promise<void> {
  const gateway = new WhatsAppGateway({
    allow: new AllowList(o.configs.map((c) => c.groupId)),
    factory: baileysSocketFactory(silentLogger()),
    auth: o.auth.state,
    saveCreds: o.auth.saveCreds,
    onQr: o.onQr,
  });
  const ingestor = new Ingestor({ db: o.db, onNewMessages: () => {} });
  let lastEvent = Date.now();
  gateway.onEvent((e) => {
    ingestor.handle(e);
    lastEvent = Date.now();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for WhatsApp to connect')), 5 * 60_000);
      gateway.onStatus((s) => {
        if (s.state === 'logged_out' || s.state === 'forbidden') {
          clearTimeout(timeout);
          reject(new Error('WhatsApp refused this session. Run: npm run cli -- link --reset'));
        }
        if (s.state === 'replaced') {
          clearTimeout(timeout);
          reject(new Error('Another copy of WA Agent is using this WhatsApp session. Stop it first (net stop wa-agent).'));
        }
        if (s.state === 'open') {
          clearTimeout(timeout);
          resolve();
        }
      });
      gateway.start();
    });
    await o.afterOpen?.(gateway);
    lastEvent = Date.now();
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (Date.now() - lastEvent >= o.settleMs) {
          clearInterval(t);
          resolve();
        }
      }, 2_000);
    });
  } finally {
    await gateway.stop();
  }
}

export async function linkCommand(opts: { reset: boolean }): Promise<void> {
  const env = loadEnv();
  // The lock comes first: nothing is opened while the service may be running.
  const lock = await acquireLock(env.DATA_DIR);
  let db: Db | undefined;
  let sessionDb: Db | undefined;
  try {
    const key = new DpapiKeyProvider(keyFile(env)).getKey();
    const configs = loadGroupsFile(env.GROUPS_FILE);
    db = openDb(trackerDb(env));
    sessionDb = openSessionDb(join(env.DATA_DIR, 'session.db'));
    syncClients(db, configs);
    if (opts.reset) {
      // Only the agent's own WhatsApp session rows (session.db) are deleted. tracker.db is never touched.
      resetSession(sessionDb);
      console.log('Reset: the saved WhatsApp session was deleted. Your tasks, messages and tracker data were NOT touched.');
    }
    const auth = useEncryptedAuthState(sessionDb, key);
    if (auth.hasSession) {
      console.log('WhatsApp is already linked. Use --reset only after WhatsApp has unlinked this device.');
      return;
    }
    if (configs.length === 0) console.log('Note: the allow-list is empty, so nothing will be stored. Run list-groups next.');
    const before = countMessages(db);
    await connectAndIngest({ db, auth, configs, settleMs: 60_000, onQr: printQr });
    console.log(`Linked. ${countMessages(db) - before} messages saved from the allowed groups.`);
    console.log('Next: npm run cli -- list-groups (if you still need group ids), then start the service: net start wa-agent');
  } finally {
    sessionDb?.close();
    db?.close();
    await lock.release();
  }
}

export async function listGroupsCommand(): Promise<void> {
  const env = loadEnv();
  const lock = await acquireLock(env.DATA_DIR);
  let db: Db | undefined;
  let sessionDb: Db | undefined;
  try {
    const key = new DpapiKeyProvider(keyFile(env)).getKey();
    const configs = loadGroupsFile(env.GROUPS_FILE);
    db = openDb(trackerDb(env));
    sessionDb = openSessionDb(join(env.DATA_DIR, 'session.db'));
    syncClients(db, configs);
    const auth = useEncryptedAuthState(sessionDb, key);
    if (!auth.hasSession) {
      console.log('WhatsApp is not linked yet. Run: npm run cli -- link');
      return;
    }
    const allowed = new Set(configs.map((c) => c.groupId));
    await connectAndIngest({
      db,
      auth,
      configs,
      settleMs: 15_000,
      afterOpen: async (gateway) => {
        console.log('Groups on this number (shown here only, nothing is saved):\n');
        for (const g of await gateway.listGroups()) console.log(`${g.id}  ${g.subject}${allowed.has(g.id) ? '   [allowed]' : ''}`);
        console.log('\nCopy the ids you want into config/allowed-groups.json. Finishing up...');
      },
    });
  } finally {
    sessionDb?.close();
    db?.close();
    await lock.release();
  }
}

export function statusCommand(): void {
  const env = loadEnv();
  const db = openDb(trackerDb(env));
  try {
    console.log(
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

export async function googleAuthCommand(): Promise<void> {
  const env = loadEnv();
  const key = new DpapiKeyProvider(keyFile(env)).getKey();
  const db = openDb(trackerDb(env));
  try {
    const refreshToken = await runLoopbackConsent({
      clientId: requireKey(env, 'GOOGLE_OAUTH_CLIENT_ID'),
      clientSecret: requireKey(env, 'GOOGLE_OAUTH_CLIENT_SECRET'),
      scopes: DRIVE_SCOPES,
      showUrl: (url) => {
        console.log('Open this link in a browser where the mailbox Google account is signed in:\n');
        console.log(url);
      },
    });
    new TokenStore(db, key).save(refreshToken);
    console.log('Google Drive connected.');
  } finally {
    db.close();
  }
}
