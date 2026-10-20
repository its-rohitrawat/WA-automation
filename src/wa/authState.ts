import { createHmac, hkdfSync } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { BufferJSON, initAuthCreds, proto } from 'baileys';
import type { AuthenticationCreds, AuthenticationState, SignalDataSet, SignalDataTypeMap } from 'baileys';
import { decrypt, encrypt } from '../crypto/envelope.ts';
import type { Db } from '../store/db.ts';

export class SessionDecryptError extends Error {
  constructor() {
    super(
      'The WhatsApp session could not be decrypted with the current master key. Running "link --reset" discards it and needs a new QR scan.',
    );
    this.name = 'SessionDecryptError';
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

export interface EncryptedAuth {
  state: AuthenticationState;
  saveCreds(): Promise<void>;
  /** Snapshot taken when the state is loaded. */
  hasSession: boolean;
}

export function useEncryptedAuthState(db: Db, key: Buffer): EncryptedAuth {
  const getStmt = db.prepare('SELECT v FROM auth WHERE k = ?');
  const putStmt = db.prepare('INSERT INTO auth (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v');
  const getCount = db.prepare('SELECT COUNT(*) AS n FROM auth');
  const delStmt = db.prepare('DELETE FROM auth WHERE k = ?');

  const derive = (info: string): Buffer => Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), info, 32));
  const rowKey = derive('wa-session-row');
  const valueKey = derive('wa-session-value');
  const rowId = (name: string): string => createHmac('sha256', rowKey).update(name).digest('hex');

  const read = (name: string): unknown => {
    const id = rowId(name);
    const row = getStmt.get(id) as { v: Buffer } | undefined;
    if (!row) return null;
    return JSON.parse(decrypt(valueKey, row.v, Buffer.from(id)).toString('utf8'), BufferJSON.reviver);
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
  let loaded: AuthenticationCreds | null;
  try {
    const hasRows = (getCount.get() as { n: number }).n > 0;
    if (read('canary') === null) {
      if (hasRows) throw new SessionDecryptError();
      write('canary', 'ok');
    }
    loaded = read('creds') as AuthenticationCreds | null;
  } catch {
    throw new SessionDecryptError();
  }
  const creds = loaded ?? initAuthCreds();

  return {
    hasSession: Boolean(creds.me?.id),
    saveCreds: async () => write('creds', creds),
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
