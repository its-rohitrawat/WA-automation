import { createHmac, hkdfSync } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { BufferJSON, initAuthCreds, proto } from 'baileys';
import type { AuthenticationCreds, AuthenticationState, SignalDataSet, SignalDataTypeMap } from 'baileys';
import { decrypt, encrypt } from '../crypto/envelope.ts';
import { deriveSubkey } from '../crypto/keyProvider.ts';
import type { Db } from '../store/db.ts';

export class SessionDecryptError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      'The WhatsApp session could not be decrypted with the current master key. Running "link --reset" discards it and needs a new QR scan.',
      options,
    );
    this.name = 'SessionDecryptError';
  }
}

/** HKDF label of the spare number's session key (spec §3, "Sender isolation"). */
export const SENDER_SESSION_INFO = 'whatsapp-sender-session';

export class SenderSessionDecryptError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      `The spare number's WhatsApp session could not be decrypted with the current master key. Running "link-sender --reset" discards it and needs a new QR scan from the spare phone.`,
      options,
    );
    this.name = 'SenderSessionDecryptError';
  }
}

export function openSessionDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    db.pragma('journal_mode = WAL');
    // Wipe rotated-out keys from free pages.
    db.pragma('secure_delete = ON');
    db.exec('CREATE TABLE IF NOT EXISTS auth (k TEXT PRIMARY KEY, v BLOB NOT NULL)');
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/** Discards the stored session (the agent's own key material) so a new QR scan can start fresh. */
export function resetSession(db: Db): void {
  db.transaction(() => {
    db.prepare('DELETE FROM auth').run();
  })();
}

export interface EncryptedAuth {
  state: AuthenticationState;
  saveCreds(): Promise<void>;
  /** Snapshot taken when the state is loaded. */
  hasSession: boolean;
}

/** Writes the canary row when the table is empty. */
export function useEncryptedAuthState(db: Db, key: Buffer): EncryptedAuth {
  const getStmt = db.prepare('SELECT v FROM auth WHERE k = ?');
  const putStmt = db.prepare('INSERT INTO auth (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v');
  const getCount = db.prepare('SELECT COUNT(*) AS n FROM auth');
  const delStmt = db.prepare('DELETE FROM auth WHERE k = ?');

  const derive = (info: string): Buffer => Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), info, 32));
  const rowKey = derive('wa-session-row');
  const valueKey = derive('wa-session-value');
  const rowId = (name: string): string => createHmac('sha256', rowKey).update(name).digest('hex');

  const open = (id: string, blob: Buffer): unknown =>
    JSON.parse(decrypt(valueKey, blob, Buffer.from(id)).toString('utf8'), BufferJSON.reviver);
  const read = (name: string): unknown => {
    const id = rowId(name);
    const row = getStmt.get(id) as { v: Buffer } | undefined;
    if (!row) return null;
    return open(id, row.v);
  };
  // Like read, but only decrypt/parse failures become SessionDecryptError; SQLite errors pass through.
  const readChecked = (name: string): unknown => {
    const id = rowId(name);
    const row = getStmt.get(id) as { v: Buffer } | undefined;
    if (!row) return null;
    try {
      return open(id, row.v);
    } catch (cause) {
      throw new SessionDecryptError({ cause });
    }
  };
  const write = (name: string, value: unknown): void => {
    const id = rowId(name);
    putStmt.run(id, encrypt(valueKey, Buffer.from(JSON.stringify(value, BufferJSON.replacer), 'utf8'), Buffer.from(id)));
  };
  const remove = (name: string): void => {
    delStmt.run(rowId(name));
  };

  // Row names are keyed hashes, so a wrong master key finds no rows rather than failing to decrypt.
  // A canary row tells "empty database" apart from "database written with another key".
  const hasRows = (getCount.get() as { n: number }).n > 0;
  if (readChecked('canary') === null) {
    if (hasRows) throw new SessionDecryptError();
    write('canary', 'ok');
  }
  const loaded = readChecked('creds') as AuthenticationCreds | null;
  const creds = loaded ?? initAuthCreds();

  return {
    hasSession: Boolean(creds.me?.id),
    saveCreds: async () => {
      db.transaction(() => {
        write('canary', 'ok');
        write('creds', creds);
      })();
    },
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const out: { [id: string]: SignalDataTypeMap[T] } = {};
          for (const id of ids) {
            let value = read(`${type}:${id}`);
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
            if (value !== null) out[id] = value as SignalDataTypeMap[T];
          }
          return out;
        },
        set: async (data: SignalDataSet) => {
          db.transaction(() => {
            for (const category of Object.keys(data) as (keyof SignalDataSet)[]) {
              for (const [id, value] of Object.entries(data[category] ?? {})) {
                const name = `${category}:${id}`;
                // A null value means the protocol rotated this key out.
                if (value) write(name, value);
                else remove(name);
              }
            }
          })();
        },
      },
    },
  };
}

/**
 * The spare number's session: the same encrypted store, keyed by its own HKDF subkey of the master key, in its own file
 * (data/sender-session.db). The founder's session key cannot open it, and this key cannot open the founder's session.
 */
export function useSenderAuthState(db: Db, masterKey: Buffer): EncryptedAuth {
  try {
    return useEncryptedAuthState(db, deriveSubkey(masterKey, SENDER_SESSION_INFO));
  } catch (cause) {
    if (cause instanceof SessionDecryptError) throw new SenderSessionDecryptError({ cause });
    throw cause;
  }
}

/** code is a reason code safe to log: 'decrypt_failed', or the SQLite error code (such as SQLITE_NOTADB). */
export type SenderSession = { ok: true; db: Db; auth: EncryptedAuth } | { ok: false; code: string };

/**
 * Opens the spare number's session at service start. A file that is damaged, not a database, or written with another
 * master key is reported, not thrown, and left as it is: a bad spare-number session never stops the service (only
 * link-sender --reset replaces it). Any other error is thrown.
 */
export function openSenderSession(file: string, masterKey: Buffer): SenderSession {
  let db: Db | undefined;
  try {
    db = openSessionDb(file);
    return { ok: true, db, auth: useSenderAuthState(db, masterKey) };
  } catch (err) {
    try {
      db?.close();
    } catch {
      // best effort
    }
    if (err instanceof SenderSessionDecryptError) return { ok: false, code: 'decrypt_failed' };
    if (err instanceof Database.SqliteError) return { ok: false, code: err.code };
    throw err;
  }
}
