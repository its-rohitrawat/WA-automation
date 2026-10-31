import { createHmac, hkdfSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { BufferJSON, initAuthCreds, proto } from 'baileys';
import type { AuthenticationCreds, AuthenticationState, SignalDataSet, SignalDataTypeMap } from 'baileys';
import { decrypt, encrypt } from '../crypto/envelope.ts';
import { deriveSubkey } from '../crypto/keyProvider.ts';
import { senderSessionDbPath, sessionDbPath } from '../config/paths.ts';
import type { Db, Sql } from '../store/db.ts';
import type { Params, RunResult } from '../store/engine/types.ts';
import {
  BACKUP_MARKER, HAS_BACKUP, isDamageCode, openSessionFile, probeDamage, readSessionRow, RESTORE, sqliteErrorCode,
} from '../store/engine/sessionFile.ts';

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

/**
 * The session file, behind the same Db interface as the tracker, with its own pragmas and tables; a link that never
 * finished has its backup restored before the Db is handed out (src/store/engine/sessionFile.ts).
 */
export function openSessionDb(file: string): Db {
  return openSessionFile(file);
}

// Where the sessions live (SaaS S2.6c2, decision A2). SQLite: one file per phone, data/session.db (the founder's) and
// data/sender-session.db (the spare's), each with an auth and an auth_backup table. Postgres: the customer's wa_auth
// table, one phone's rows per PgSessionDb, slot 'live' for auth and 'backup' for auth_backup. Same rows, same codec.

export type Phone = 'founder' | 'spare';
export type SessionHome = { engine: 'sqlite'; dataDir: string } | { engine: 'postgres'; db: Db };

/** The sessions' home for this engine: the data folder's files, or wa_auth on the customer's Db (the tracker's). */
export function sessionHomeOf(env: { DB_ENGINE?: string; DATA_DIR: string }, tracker: Db): SessionHome {
  return env.DB_ENGINE === 'postgres' ? { engine: 'postgres', db: tracker } : { engine: 'sqlite', dataDir: env.DATA_DIR };
}

/**
 * One phone's session on Postgres: its wa_auth rows on the customer's Db. Closing it leaves that Db open (the tracker
 * owns the pool). onChange runs after each committed write (main.ts keeps the founder's number current with it).
 */
export class PgSessionDb implements Db {
  readonly engine = 'postgres' as const;
  readonly #base: Db;
  readonly phone: Phone;
  readonly #onChange: (() => void) | undefined;
  constructor(base: Db, phone: Phone, o: { onChange?: () => void } = {}) {
    if (phone !== 'founder' && phone !== 'spare') throw new Error('a session belongs to the founder or the spare phone');
    this.#base = base;
    this.phone = phone;
    this.#onChange = o.onChange;
  }
  get<T>(sql: string, params?: Params): Promise<T | undefined> {
    return this.#base.get<T>(sql, params);
  }
  all<T>(sql: string, params?: Params): Promise<T[]> {
    return this.#base.all<T>(sql, params);
  }
  async run(sql: string, params?: Params): Promise<RunResult> {
    const r = await this.#base.run(sql, params);
    this.#onChange?.();
    return r;
  }
  exec(): Promise<void> {
    return Promise.reject(new Error('a session takes no multi-statement SQL'));
  }
  async tx<T>(fn: (q: Sql) => Promise<T>): Promise<T> {
    const r = await this.#base.tx(fn);
    this.#onChange?.();
    return r;
  }
  async close(): Promise<void> {}
}

/** The session statements for a session Db: the file's two tables, or one phone's wa_auth rows (a fixed literal). */
function authSql(db: Db) {
  if (!(db instanceof PgSessionDb)) {
    return {
      get: 'SELECT v FROM auth WHERE k = ?',
      count: 'SELECT COUNT(*) AS n FROM auth',
      put: 'INSERT INTO auth (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v',
      remove: 'DELETE FROM auth WHERE k = ?',
      clear: 'DELETE FROM auth',
      clearBackup: 'DELETE FROM auth_backup',
      copyToBackup: 'INSERT INTO auth_backup (k, v) SELECT k, v FROM auth',
      putBackup: 'INSERT INTO auth_backup (k, v) VALUES (?, ?)',
      hasBackup: HAS_BACKUP,
      restore: RESTORE,
    };
  }
  const p = `'${db.phone}'`;
  const live = `wa_auth WHERE phone = ${p} AND slot = 'live'`;
  const backup = `wa_auth WHERE phone = ${p} AND slot = 'backup'`;
  return {
    get: `SELECT v FROM ${live} AND k = ?`,
    count: `SELECT COUNT(*) AS n FROM ${live}`,
    put: `INSERT INTO wa_auth (phone, slot, k, v) VALUES (${p}, 'live', ?, ?) ON CONFLICT (phone, slot, k) DO UPDATE SET v = excluded.v`,
    remove: `DELETE FROM ${live} AND k = ?`,
    clear: `DELETE FROM ${live}`,
    clearBackup: `DELETE FROM ${backup}`,
    copyToBackup: `INSERT INTO wa_auth (phone, slot, k, v) SELECT phone, 'backup', k, v FROM ${live}`,
    putBackup: `INSERT INTO wa_auth (phone, slot, k, v) VALUES (${p}, 'backup', ?, ?)`,
    hasBackup: `SELECT 1 FROM ${backup} AND k = ?`,
    restore: [`DELETE FROM ${live}`, `INSERT INTO wa_auth (phone, slot, k, v) SELECT phone, 'live', k, v FROM ${backup} AND k <> ?`, `DELETE FROM ${backup}`],
  };
}

/**
 * A phone's session. SQLite: its file, whose open restores an unfinished link's backup. Postgres: its wa_auth rows,
 * with the same restore before it is handed out.
 */
export async function openPhoneSession(home: SessionHome, phone: Phone, o: { onChange?: () => void } = {}): Promise<Db> {
  if (home.engine === 'sqlite') return openSessionDb(phone === 'founder' ? sessionDbPath(home.dataDir) : senderSessionDbPath(home.dataDir));
  const db = new PgSessionDb(home.db, phone, o);
  await restoreBackup(db);
  return db;
}

/** Whether a phone has a saved session at all, without creating one: its file, or any of its wa_auth rows. */
export async function sessionStored(home: SessionHome, phone: Phone): Promise<boolean> {
  if (home.engine === 'sqlite') return existsSync(phone === 'founder' ? sessionDbPath(home.dataDir) : senderSessionDbPath(home.dataDir));
  return (await home.db.get('SELECT 1 FROM wa_auth WHERE phone = ? LIMIT 1', [phone])) !== undefined;
}

// The session backup. A dashboard link copies the session rows into auth_backup (same file) in the transaction that
// resets them, so the copy survives a crash or a power cut during the link. It is dropped once the new link is committed,
// or once the old rows are back. openSessionDb restores a backup it finds (a link that never finished) before anything
// reads the session. Only the holder of the data-folder lock opens a session file (the service, or a CLI command with the
// service stopped), so this never runs beside a link in progress. On Postgres the same, in the phone's 'backup' slot.

/** Whether the session has any live rows (auth, or the phone's 'live' wa_auth rows), without writing any. */
export async function hasSessionRows(db: Db): Promise<boolean> {
  return Number((await db.get<{ n: number | string }>(authSql(db).count))!.n) > 0; // Postgres counts as a string
}

/** In one transaction: copies every row to auth_backup, then empties auth (the reset for a new link). */
export async function backupAndReset(db: Db): Promise<void> {
  const s = authSql(db);
  await db.tx(async (q) => {
    await q.run(s.clearBackup);
    await q.run(s.copyToBackup);
    await q.run(s.putBackup, [BACKUP_MARKER, Buffer.alloc(0)]);
    await q.run(s.clear);
  });
}

/** In one transaction: the backed-up rows replace auth, and the backup is dropped. False when there was no backup. */
export async function restoreBackup(db: Db): Promise<boolean> {
  const s = authSql(db);
  return db.tx(async (q) => {
    if (!(await q.get(s.hasBackup, [BACKUP_MARKER]))) return false;
    for (const sql of s.restore) await q.run(sql, sql.includes('?') ? [BACKUP_MARKER] : []);
    return true;
  });
}

/** The new link is kept: the backup is no longer needed. */
export async function dropBackup(db: Db): Promise<void> {
  await db.run(authSql(db).clearBackup);
}

/** A link that never finished left its backup: the session rows from before it come back. True when it restored them. */
export async function recoverInterruptedLink(db: Db): Promise<boolean> {
  return await restoreBackup(db);
}

/**
 * Discards the stored session (the agent's own key material) so a new QR scan can start fresh. A backup left by a
 * dashboard link that never finished goes too: otherwise the next start would restore it over this new link.
 */
export async function resetSession(db: Db): Promise<void> {
  const s = authSql(db);
  await db.tx(async (q) => {
    await q.run(s.clear);
    await q.run(s.clearBackup);
  });
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
export async function useEncryptedAuthState(db: Db, key: Buffer): Promise<EncryptedAuth> {
  const { valueKey, rowId, open } = sessionCodec(key);
  const s = authSql(db);
  const blob = async (id: string): Promise<Buffer | undefined> => (await db.get<{ v: Buffer }>(s.get, [id]))?.v;
  const read = async (name: string): Promise<unknown> => {
    const id = rowId(name);
    const v = await blob(id);
    if (!v) return null;
    return open(id, v);
  };
  // Like read, but only decrypt/parse failures become SessionDecryptError; SQLite errors pass through.
  const readChecked = async (name: string): Promise<unknown> => {
    const id = rowId(name);
    const v = await blob(id);
    if (!v) return null;
    try {
      return open(id, v);
    } catch (cause) {
      throw new SessionDecryptError({ cause });
    }
  };
  const write = async (q: Sql, name: string, value: unknown): Promise<void> => {
    const id = rowId(name);
    const sealed = encrypt(valueKey, Buffer.from(JSON.stringify(value, BufferJSON.replacer), 'utf8'), Buffer.from(id));
    await q.run(s.put, [id, sealed]);
  };
  const remove = async (q: Sql, name: string): Promise<void> => {
    await q.run(s.remove, [rowId(name)]);
  };

  // Row names are keyed hashes, so a wrong master key finds no rows rather than failing to decrypt.
  // A canary row tells "empty database" apart from "database written with another key".
  const hasRows = (await db.get<{ n: number }>(s.count))!.n > 0;
  if ((await readChecked('canary')) === null) {
    if (hasRows) throw new SessionDecryptError();
    await write(db, 'canary', 'ok');
  }
  const loaded = (await readChecked('creds')) as AuthenticationCreds | null;
  const creds = loaded ?? initAuthCreds();

  return {
    hasSession: Boolean(creds.me?.id),
    saveCreds: async () => {
      await db.tx(async (q) => {
        await write(q, 'canary', 'ok');
        await write(q, 'creds', creds);
      });
    },
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const out: { [id: string]: SignalDataTypeMap[T] } = {};
          for (const id of ids) {
            let value = await read(`${type}:${id}`);
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
            if (value !== null) out[id] = value as SignalDataTypeMap[T];
          }
          return out;
        },
        set: async (data: SignalDataSet) => {
          await db.tx(async (q) => {
            for (const category of Object.keys(data) as (keyof SignalDataSet)[]) {
              for (const [id, value] of Object.entries(data[category] ?? {})) {
                const name = `${category}:${id}`;
                // A null value means the protocol rotated this key out.
                if (value) await write(q, name, value);
                else await remove(q, name);
              }
            }
          });
        },
      },
    },
  };
}

/**
 * The spare number's session: the same encrypted store, keyed by its own HKDF subkey of the master key, in its own file
 * (data/sender-session.db). The founder's session key cannot open it, and this key cannot open the founder's session.
 */
export async function useSenderAuthState(db: Db, masterKey: Buffer): Promise<EncryptedAuth> {
  try {
    return await useEncryptedAuthState(db, deriveSubkey(masterKey, SENDER_SESSION_INFO));
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
  try {
    const { rowId, open } = sessionCodec(key);
    const id = rowId('creds');
    const v = readSessionRow(file, id);
    if (!v) return undefined;
    const me = (open(id, v) as AuthenticationCreds | null)?.me?.id;
    return me ? me.split(/[:@]/)[0] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * readFounderNumber for either engine. On Postgres it reads the founder's creds row (slot 'live') and, like the file
 * read, writes nothing and gives undefined for no link or a row this key cannot open.
 */
export async function founderNumberIn(home: SessionHome, key: Buffer): Promise<string | undefined> {
  if (home.engine === 'sqlite') return readFounderNumber(sessionDbPath(home.dataDir), key);
  try {
    const { rowId, open } = sessionCodec(key);
    const id = rowId('creds');
    const v = (await home.db.get<{ v: Buffer }>(authSql(new PgSessionDb(home.db, 'founder')).get, [id]))?.v;
    if (!v) return undefined;
    const me = (open(id, v) as AuthenticationCreds | null)?.me?.id;
    return me ? me.split(/[:@]/)[0] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The founder's linked number on Postgres, for checks that cannot wait for a read (SenderGateway's, before each send):
 * read at start(), and again after each refresh() (main.ts calls it after every committed write to the founder's rows).
 * One read at a time; a refresh during a read reads once more after it. A failed or empty read keeps the last number,
 * so a number once seen is still refused (the safe side).
 */
export class FounderNumberWatch {
  readonly #home: SessionHome;
  readonly #key: Buffer;
  readonly #onError: (err: unknown) => void;
  #seen: string | undefined;
  #reading: Promise<void> | undefined;
  #again = false;
  constructor(home: SessionHome, key: Buffer, onError: (err: unknown) => void) {
    this.#home = home;
    this.#key = key;
    this.#onError = onError;
  }
  async start(): Promise<void> {
    this.#seen = await founderNumberIn(this.#home, this.#key);
  }
  current(): string | undefined {
    return this.#seen;
  }
  readonly refresh = (): void => {
    if (this.#reading) {
      this.#again = true;
      return;
    }
    this.#reading = founderNumberIn(this.#home, this.#key)
      .then((n) => {
        this.#seen = n ?? this.#seen;
      })
      .catch(this.#onError)
      .finally(() => {
        this.#reading = undefined;
        if (this.#again) {
          this.#again = false;
          this.refresh();
        }
      });
  };
  /** Tests: resolves once no read is running. */
  async settled(): Promise<void> {
    while (this.#reading) await this.#reading;
  }
}

/**
 * code is a reason code safe to log: 'decrypt_failed', or the SQLite error code (such as SQLITE_NOTADB). transient is
 * set when the file could not be opened but is not known to be damaged (a lock, permissions, a disk error): moving it
 * aside with link-sender --reset would be the wrong fix.
 */
export type SenderSession = { ok: true; db: Db; auth: EncryptedAuth } | { ok: false; code: string; transient?: true };

/**
 * Opens the spare number's session at service start. A file that is damaged, not a database, or written with another
 * master key is reported, not thrown, and left as it is: a bad spare-number session never stops the service (only
 * link-sender --reset replaces it). Any other SQLite error (a lock, a read-only file, a disk error) is reported as
 * transient. Any other error is thrown.
 */
export async function openSenderSession(where: string | SessionHome, masterKey: Buffer): Promise<SenderSession> {
  if (typeof where !== 'string' && where.engine === 'postgres') {
    // No file to be damaged: only another master key is reported; a server error is thrown (it is not the session's).
    const db = await openPhoneSession(where, 'spare');
    try {
      return { ok: true, db, auth: await useSenderAuthState(db, masterKey) };
    } catch (err) {
      if (err instanceof SenderSessionDecryptError) return { ok: false, code: 'decrypt_failed' };
      throw err;
    }
  }
  const file = typeof where === 'string' ? where : senderSessionDbPath(where.dataDir);
  const damage = probeDamage(file);
  if (damage) return { ok: false, code: damage };
  let db: Db | undefined;
  try {
    db = openSessionDb(file);
    return { ok: true, db, auth: await useSenderAuthState(db, masterKey) };
  } catch (err) {
    try {
      await db?.close();
    } catch {
      // best effort
    }
    if (err instanceof SenderSessionDecryptError) return { ok: false, code: 'decrypt_failed' };
    const code = sqliteErrorCode(err);
    if (code !== undefined) return isDamageCode(code) ? { ok: false, code } : { ok: false, code, transient: true };
    throw err;
  }
}
