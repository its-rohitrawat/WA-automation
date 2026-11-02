import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteDb } from './sqlite.ts';

// The WhatsApp session files (data/session.db, data/sender-session.db) on SQLite: how they are opened, read without a
// write, and checked for damage. Behind the engine so better-sqlite3 stays in src/store/engine (S1.15); what the rows
// mean (the codec, the canary, the creds) stays in src/wa/authState.ts.

/** Marks a backup as present even when the session it copied was empty. Row names are hex hashes, so it cannot collide. */
export const BACKUP_MARKER = '#link-in-progress';
export const HAS_BACKUP = 'SELECT 1 FROM auth_backup WHERE k = ?';
/** The backed-up rows replace auth, and the backup is dropped (the one `?` is the marker). */
export const RESTORE = ['DELETE FROM auth', 'INSERT INTO auth (k, v) SELECT k, v FROM auth_backup WHERE k <> ?', 'DELETE FROM auth_backup'];

/**
 * Opens a session file with its own pragmas (WAL; rotated-out keys wiped from free pages) and its two tables. A link
 * that never finished left a backup: the session from before it comes back, on the file's own handle before the Db is
 * handed out, so opening stays synchronous.
 */
export function openSessionFile(file: string): SqliteDb {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const raw = new Database(file);
  try {
    raw.pragma('journal_mode = WAL');
    raw.pragma('secure_delete = ON');
    raw.exec('CREATE TABLE IF NOT EXISTS auth (k TEXT PRIMARY KEY, v BLOB NOT NULL)');
    // A copy of the rows while a dashboard link runs (src/wa/linkSession.ts); empty otherwise.
    raw.exec('CREATE TABLE IF NOT EXISTS auth_backup (k TEXT PRIMARY KEY, v BLOB NOT NULL)');
    raw.transaction(() => {
      if (!raw.prepare(HAS_BACKUP).get(BACKUP_MARKER)) return;
      for (const sql of RESTORE) raw.prepare(sql).run(...(sql.includes('?') ? [BACKUP_MARKER] : []));
    })();
  } catch (err) {
    raw.close();
    throw err;
  }
  return SqliteDb.wrap(raw);
}

/**
 * One row of a session file's auth table, read without writing anything beside the file: the file's bytes are opened as
 * an in-memory copy (a read-only SQLite connection would leave new -wal and -shm files next to it). Only when a -wal
 * file with data is already there (the service did not stop cleanly) is the file opened read-only, so the newest rows
 * are seen. Undefined when there is no file, no auth table or no such row. Throws when the file cannot be read.
 */
export function readSessionRow(file: string, k: string): Buffer | undefined {
  if (!existsSync(file)) return undefined;
  let db: Database.Database | undefined;
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
    return (db.prepare('SELECT v FROM auth WHERE k = ?').get(k) as { v: Buffer } | undefined)?.v;
  } finally {
    try {
      db?.close();
    } catch {
      // best effort
    }
  }
}

/** The SQLite error code of an error SQLite raised (such as SQLITE_BUSY), or undefined for any other error. */
export function sqliteErrorCode(err: unknown): string | undefined {
  return err instanceof Database.SqliteError ? err.code : undefined;
}

/** SQLite codes that mean the file itself is damaged or not a database. Every other SQLite error may pass. */
export function isDamageCode(code: string): boolean {
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
export function probeDamage(file: string): string | undefined {
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
  let probe: Database.Database | undefined;
  try {
    probe = new Database(file, { readonly: true, fileMustExist: true });
    probe.prepare('SELECT 1 FROM sqlite_master').get();
    return undefined;
  } catch (err) {
    const code = sqliteErrorCode(err);
    return code !== undefined && isDamageCode(code) ? code : undefined;
  } finally {
    try {
      probe?.close();
    } catch {
      // best effort
    }
  }
}
