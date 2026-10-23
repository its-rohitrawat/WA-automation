import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../../src/store/db.ts';
import { MIGRATIONS, type Migration } from '../../src/store/migrations.ts';

describe('openDb', () => {
  it('creates every table', () => {
    const db = openDb(':memory:');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining([
      'batches', 'clients', 'decisions', 'kv', 'media', 'meetings', 'message_edits', 'messages', 'people', 'reactions', 'schema_version', 'spend', 'stt_forget',
      'task_events', 'tasks',
    ]));
  });

  it('creates the task and media indexes', () => {
    const db = openDb(':memory:');
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((i) => i.name);
    expect(idx).toEqual(expect.arrayContaining(['tasks_client_status', 'task_events_client_at', 'media_due', 'media_client', 'meetings_due', 'meetings_conference']));
  });

  it('is at schema version 7 straight after openDb', () => {
    const db = openDb(':memory:');
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(7);
  });

  it('is safe to migrate twice', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect((db.prepare('SELECT COUNT(*) AS n FROM schema_version').get() as { n: number }).n).toBe(6); // 1 to 5 and 7: version 6 is Phase 2c's reports table, arriving from main
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
    migrate(db); // this branch: 1 to 5 and 7
    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 7]);
    expect(() => migrate(db, withV6)).toThrow('database is at v7 but v6 was never applied; restore a backup or contact the developer');
    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 7]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'fake_reports'").get()).toBeUndefined();
  });

  it('names every skipped version', () => {
    const db = new Database(':memory:');
    migrate(db, withV6);
    db.prepare('DELETE FROM schema_version WHERE version IN (2, 6)').run();
    expect(() => migrate(db, withV6)).toThrow('database is at v7 but v2, v6 were never applied');
  });

  it('applies the fake v6 in order on a fresh database, and a database with every version recorded migrates as before', () => {
    const db = new Database(':memory:');
    migrate(db, withV6);
    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    migrate(db, withV6);
    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('upgrades an older database without complaint, and the branch’s own migrations never throw', () => {
    const db = new Database(':memory:');
    migrate(db, MIGRATIONS.filter((m) => m.version <= 4));
    expect(versions(db)).toEqual([1, 2, 3, 4]);
    migrate(db);
    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 7]);
    expect(() => migrate(db)).not.toThrow();
    expect(() => openDb(':memory:')).not.toThrow();
  });
});
