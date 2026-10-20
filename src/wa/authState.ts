import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { BufferJSON, initAuthCreds, proto } from 'baileys';
import type { AuthenticationCreds, AuthenticationState, SignalDataSet, SignalDataTypeMap } from 'baileys';
import { decrypt, encrypt } from '../crypto/envelope.ts';
import type { Db } from '../store/db.ts';

export function openSessionDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS auth (k TEXT PRIMARY KEY, v BLOB NOT NULL)');
  return db;
}

export interface EncryptedAuth {
  state: AuthenticationState;
  saveCreds(): Promise<void>;
  hasSession: boolean;
}

export function useEncryptedAuthState(db: Db, key: Buffer): EncryptedAuth {
  const getStmt = db.prepare('SELECT v FROM auth WHERE k = ?');
  const putStmt = db.prepare('INSERT INTO auth (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v');
  const delStmt = db.prepare('DELETE FROM auth WHERE k = ?');

  const read = (k: string): unknown => {
    const row = getStmt.get(k) as { v: Buffer } | undefined;
    if (!row) return null;
    return JSON.parse(decrypt(key, row.v).toString('utf8'), BufferJSON.reviver);
  };
  const write = (k: string, value: unknown): void => {
    putStmt.run(k, encrypt(key, Buffer.from(JSON.stringify(value, BufferJSON.replacer), 'utf8')));
  };

  const creds = (read('creds') as AuthenticationCreds | null) ?? initAuthCreds();

  return {
    hasSession: Boolean(creds.me?.id),
    saveCreds: async () => write('creds', creds),
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const out: { [id: string]: SignalDataTypeMap[T] } = {};
          for (const id of ids) {
            let value = read(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
            if (value !== null) out[id] = value as SignalDataTypeMap[T];
          }
          return out;
        },
        set: async (data: SignalDataSet) => {
          db.transaction(() => {
            for (const category of Object.keys(data) as (keyof SignalDataSet)[]) {
              for (const [id, value] of Object.entries(data[category] ?? {})) {
                const k = `${category}-${id}`;
                // A null value means the protocol rotated this key out.
                if (value) write(k, value);
                else delStmt.run(k);
              }
            }
          })();
        },
      },
    },
  };
}
