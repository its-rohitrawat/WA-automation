import { createHmac, hkdfSync } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
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

/** How a session's rows are named and sealed: keyed-hash row names, and values encrypted with the row name bound in. */
function sessionCodec(key: Buffer) {
  const derive = (info: string): Buffer => Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), info, 32));
  const rowKey = derive('wa-session-row');
  const valueKey = derive('wa-session-value');
  return {
    valueKey,
    rowId: (name: string): string => createHmac('sha256', rowKey).update(name).digest('hex'),
    open: (id: string, blob: Buffer): unknown => JSON.parse(decrypt(valueKey, blob, Buffer.from(id)).toString('utf8'), BufferJSON.reviver),
  };
}

/** Writes the canary row when the table is empty. */
export function useEncryptedAuthState(db: Db, key: Buffer): EncryptedAuth {
  const getStmt = db.prepare('SELECT v FROM auth WHERE k = ?');
  const putStmt = db.prepare('INSERT INTO auth (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v');
  const getCount = db.prepare('SELECT COUNT(*) AS n FROM auth');
  const delStmt = db.prepare('DELETE FROM auth WHERE k = ?');

  const { valueKey, rowId, open } = sessionCodec(key);
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

/**
 * The phone number the founder's saved link (data/session.db, sealed with the master key itself) belongs to: the digits
 * of creds.me.id before the device part (":7") or "@". It only reads, and writes nothing beside the file: the file's
 * bytes are opened as an in-memory copy (a read-only SQLite connection would leave new -wal and -shm files next to it).
 * Only when a -wal file with data is already there (the service did not stop cleanly) is the file opened read-only, so
 * the newest rows are seen. No table is created and no canary written. Undefined when there is no file, no link, or the
 * session cannot be read (another master key, a damaged file, a lock): link-sender then cannot compare, and the service
 * compares again at every start, where it reads the founder's session anyway.
 */
export function readFounderNumber(file: string, key: Buffer): string | undefined {
  if (!existsSync(file)) return undefined;
  let db: Db | undefined;
  try {
    const wal = `${file}-wal`;
    if (existsSync(wal) && statSync(wal).size > 0) {
      db = new Database(file, { readonly: true, fileMustExist: true });
    } else {
      const bytes = readFileSync(file);
      // Bytes 18 and 19 mark a WAL-mode file. SQLite opens an in-memory copy only with the legacy (rollback) marks; the
      // copy is changed, never the file.
      if (bytes.length >= 20 && bytes[18] === 2 && bytes[19] === 2) bytes[18] = bytes[19] = 1;
      db = new Database(bytes, { readonly: true });
    }
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth'").get()) return undefined;
    const { rowId, open } = sessionCodec(key);
    const id = rowId('creds');
    const row = db.prepare('SELECT v FROM auth WHERE k = ?').get(id) as { v: Buffer } | undefined;
    if (!row) return undefined;
    const me = (open(id, row.v) as AuthenticationCreds | null)?.me?.id;
    return me ? me.split(/[:@]/)[0] : undefined;
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // best effort
    }
  }
}

/**
 * code is a reason code safe to log: 'decrypt_failed', or the SQLite error code (such as SQLITE_NOTADB). transient is
 * set when the file could not be opened but is not known to be damaged (a lock, permissions, a disk error): moving it
 * aside with link-sender --reset would be the wrong fix.
 */
export type SenderSession = { ok: true; db: Db; auth: EncryptedAuth } | { ok: false; code: string; transient?: true };

/** SQLite codes that mean the file itself is damaged or not a database. Every other SQLite error may pass. */
function isDamage(code: string): boolean {
  return code === 'SQLITE_NOTADB' || code.startsWith('SQLITE_CORRUPT');
}

/** The first 16 bytes of every SQLite database file. */
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

/**
 * Checks an existing file for damage before any read-write open. A read-write open of a damaged file (journal_mode =
 * WAL) makes SQLite delete the -wal and -shm files next to it when it is closed, so link-sender --reset could not move
 * them aside with the file. A file that does not start with the SQLite header is not a database (SQLite itself answers
 * SQLITE_NOTADB): that is told from its first bytes, with no SQLite connection at all. Damage further in is found with a
 * read-only connection, which never deletes the -wal file (it may rebuild the -shm file, SQLite's index of the -wal,
 * which holds no data of its own). Returns the SQLite damage code, or undefined. Any other error is left to the normal
 * open: a read-only open of a healthy WAL file can fail for harmless reasons (such as a missing -shm file).
 */
function probeDamage(file: string): string | undefined {
  if (file === ':memory:') return undefined;
  try {
    if (!statSync(file).isFile()) return undefined;
    const head = Buffer.alloc(SQLITE_HEADER.length);
    const fd = openSync(file, 'r');
    let n: number;
    try {
      n = readSync(fd, head, 0, head.length, 0);
    } finally {
      closeSync(fd);
    }
    // An empty file is a new, empty database. Any other file, however short, must start with the header.
    if (n > 0 && !(n === head.length && head.equals(SQLITE_HEADER))) return 'SQLITE_NOTADB';
  } catch {
    return undefined; // missing, a folder, no permission: the normal open reports it
  }
  let probe: Db | undefined;
  try {
    probe = new Database(file, { readonly: true, fileMustExist: true });
    probe.prepare('SELECT 1 FROM sqlite_master').get();
    return undefined;
  } catch (err) {
    return err instanceof Database.SqliteError && isDamage(err.code) ? err.code : undefined;
  } finally {
    try {
      probe?.close();
    } catch {
      // best effort
    }
  }
}

/**
 * Opens the spare number's session at service start. A file that is damaged, not a database, or written with another
 * master key is reported, not thrown, and left as it is: a bad spare-number session never stops the service (only
 * link-sender --reset replaces it). Any other SQLite error (a lock, a read-only file, a disk error) is reported as
 * transient. Any other error is thrown.
 */
export function openSenderSession(file: string, masterKey: Buffer): SenderSession {
  const damage = probeDamage(file);
  if (damage) return { ok: false, code: damage };
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
    if (err instanceof Database.SqliteError) return isDamage(err.code) ? { ok: false, code: err.code } : { ok: false, code: err.code, transient: true };
    throw err;
  }
}
