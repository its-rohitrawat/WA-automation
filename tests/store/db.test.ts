import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../../src/store/db.ts';
import { MIGRATIONS, type Migration } from '../../src/store/migrations.ts';

describe('openDb', () => {
  it('creates every table', () => {
    const db = openDb(':memory:');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining([
      'batches', 'clients', 'decisions', 'kv', 'media', 'media_stt_forget', 'meetings', 'message_edits', 'messages', 'people', 'reactions', 'schema_version',
      'spend', 'stt_forget', 'task_events', 'tasks',
    ]));
  });

  it('creates the task and media indexes', () => {
    const db = openDb(':memory:');
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((i) => i.name);
    expect(idx).toEqual(expect.arrayContaining(['tasks_client_status', 'task_events_client_at', 'media_due', 'media_client', 'meetings_due', 'meetings_conference']));
  });

  it('is at schema version 8 straight after openDb', () => {
    const db = openDb(':memory:');
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(8);
  });

  it('is safe to migrate twice', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect((db.prepare('SELECT COUNT(*) AS n FROM schema_version').get() as { n: number }).n).toBe(7); // 1 to 5, 7 and 8: version 6 is Phase 2c's reports table, arriving from main
  });

  it('overwrites deleted content, so wiped download details do not stay in free pages', () => {
    const db = openDb(':memory:');
    expect(db.pragma('secure_delete', { simple: true })).toBe(1);
  });

  it('enforces foreign keys', () => {
    const db = openDb(':memory:');
    expect(() =>
      db.prepare("INSERT INTO messages (wa_id, client_id, sender_jid, ts) VALUES ('m1', 999, 'x', '2026-10-10T00:00:00Z')").run(),
    ).toThrowError(/FOREIGN KEY/);
  });
});

describe('migrate: a skipped migration', () => {
  const FAKE_V6: Migration = { version: 6, sql: 'CREATE TABLE fake_reports (id INTEGER PRIMARY KEY);' };
  const withV6 = [...MIGRATIONS.filter((m) => m.version < 6), FAKE_V6, ...MIGRATIONS.filter((m) => m.version > 6)];
  const versions = (db: Database.Database) =>
    (db.prepare('SELECT version FROM schema_version ORDER BY version').all() as { version: number }[]).map((r) => r.version);

  it('throws, naming only the version numbers, and applies nothing when the code knows a version the database skipped', () => {
    const db = new Database(':memory:');
    migrate(db); // this branch: 1 to 5, 7 and 8
    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 7, 8]);
    expect(() => migrate(db, withV6)).toThrow('database is at v8 but v6 was never applied; restore a backup or contact the developer');
    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 7, 8]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'fake_reports'").get()).toBeUndefined();
  });

  it('names every skipped version', () => {
    const db = new Database(':memory:');
    migrate(db, withV6);
    db.prepare('DELETE FROM schema_version WHERE version IN (2, 6)').run();
    expect(() => migrate(db, withV6)).toThrow('database is at v8 but v2, v6 were never applied');
  });

  it('applies the fake v6 in order on a fresh database, and a database with every version recorded migrates as before', () => {
    const db = new Database(':memory:');
    migrate(db, withV6);
    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    migrate(db, withV6);
    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('upgrades an older database without complaint, and the branch’s own migrations never throw', () => {
    const db = new Database(':memory:');
    migrate(db, MIGRATIONS.filter((m) => m.version <= 4));
    expect(versions(db)).toEqual([1, 2, 3, 4]);
    migrate(db);
    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 7, 8]);
    expect(() => migrate(db)).not.toThrow();
    expect(() => openDb(':memory:')).not.toThrow();
  });
});

describe('migration v8 (Phase 2b: voice notes)', () => {
  const versions = (db: Database.Database) =>
    (db.prepare('SELECT version FROM schema_version ORDER BY version').all() as { version: number }[]).map((r) => r.version);
  /** A database at v7 (this branch's migrations before 2b) with one finished voice note. */
  function atV7() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, MIGRATIONS.filter((m) => m.version <= 7));
    db.prepare("INSERT INTO clients (code, name, group_id, phases) VALUES ('SHA', 'Sharma', '1@g.us', '[]')").run();
    db.prepare("INSERT INTO messages (wa_id, client_id, sender_jid, ts) VALUES ('m1', 1, 'x', '2026-10-10T00:00:00Z')").run();
    db.prepare(`INSERT INTO media (message_id, client_id, kind, status, local_path, created_at, updated_at)
      VALUES (1, 1, 'voice', 'done', 'media/SHA/2026-10/m1-1.ogg', '2026-10-10T00:00:00Z', '2026-10-10T00:01:00Z')`).run();
    return db;
  }
  const forget = (db: Database.Database, provider: string, ref: string) =>
    db.prepare("INSERT INTO media_stt_forget (media_id, provider, ref, created_at) VALUES (1, ?, ?, '2026-10-10T00:02:00Z')").run(provider, ref);

  it('migrates a v7 database to v8: media gains backlog, 0 for the files already there', () => {
    const db = atV7();
    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 7]);
    migrate(db);
    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 7, 8]);
    expect(db.prepare(`SELECT "notnull" AS required, dflt_value AS dflt FROM pragma_table_info('media') WHERE name = 'backlog'`).get())
      .toEqual({ required: 1, dflt: '0' });
    expect(db.prepare('SELECT kind, status, local_path AS localPath, backlog FROM media').all())
      .toEqual([{ kind: 'voice', status: 'done', localPath: 'media/SHA/2026-10/m1-1.ogg', backlog: 0 }]);
  });

  it('creates media_stt_forget with its checks: known providers only, a ref of 1 to 200 characters, one row per copy', () => {
    const db = atV7();
    migrate(db);
    forget(db, 'elevenlabs', 'tr_1');
    expect(db.prepare('SELECT media_id AS mediaId, provider, ref, attempts, next_try_at AS nextTryAt FROM media_stt_forget').all())
      .toEqual([{ mediaId: 1, provider: 'elevenlabs', ref: 'tr_1', attempts: 0, nextTryAt: null }]);
    expect(() => forget(db, 'whisper', 'tr_2')).toThrow(/CHECK/);
    expect(() => forget(db, 'elevenlabs', '')).toThrow(/CHECK/);
    expect(() => forget(db, 'elevenlabs', 'x'.repeat(201))).toThrow(/CHECK/);
    forget(db, 'elevenlabs', 'x'.repeat(200));
    expect(() => forget(db, 'elevenlabs', 'tr_1')).toThrow(/UNIQUE/);
    forget(db, 'sarvam', 'tr_1'); // the same id from another provider is another copy
    expect(() => db.prepare("INSERT INTO media_stt_forget (media_id, provider, ref, created_at) VALUES (99, 'openai', 'r', 'x')").run()).toThrow(/FOREIGN KEY/);
    expect((db.prepare('SELECT COUNT(*) AS n FROM media_stt_forget').get() as { n: number }).n).toBe(3);
  });

  it('leaves a database already at v8 untouched', () => {
    const db = atV7();
    migrate(db);
    forget(db, 'elevenlabs', 'tr_1');
    db.prepare('UPDATE media SET backlog = 1').run();
    const schema = db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
    migrate(db);
    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 7, 8]);
    expect(db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
    expect(db.prepare('SELECT backlog FROM media').get()).toEqual({ backlog: 1 });
    expect((db.prepare('SELECT COUNT(*) AS n FROM media_stt_forget').get() as { n: number }).n).toBe(1);
  });
});
