import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../../src/store/db.ts';
import { MIGRATIONS, type Migration } from '../../src/store/migrations.ts';

describe('openDb', () => {
  it('creates every table', () => {
    const db = openDb(':memory:');
    const tables = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining([
      'batches', 'clients', 'decisions', 'kv', 'media', 'media_stt_forget', 'meetings', 'message_edits', 'messages', 'people', 'reactions', 'reports', 'schema_version', 'spend',
      'stt_forget', 'task_events', 'tasks', 'web_sessions', 'audit_log', 'settings', 'uptime_log',
    ]));
  });

  it('creates the task and media indexes', () => {
    const db = openDb(':memory:');
    const idx = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((i) => i.name);
    expect(idx).toEqual(expect.arrayContaining(['tasks_client_status', 'task_events_client_at', 'media_due', 'media_client', 'meetings_due', 'meetings_conference']));
  });

  it('is at schema version 12 straight after openDb', () => {
    const db = openDb(':memory:');
    expect((db.raw.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(12);
  });

  it('is safe to migrate twice', () => {
    const db = openDb(':memory:');
    migrate(db.raw);
    expect((db.raw.prepare('SELECT COUNT(*) AS n FROM schema_version').get() as { n: number }).n).toBe(12);
  });

  it('overwrites deleted content, so wiped download details do not stay in free pages', () => {
    const db = openDb(':memory:');
    expect(db.raw.pragma('secure_delete', { simple: true })).toBe(1);
  });

  it('enforces foreign keys', () => {
    const db = openDb(':memory:');
    expect(() =>
      db.raw.prepare("INSERT INTO messages (wa_id, client_id, sender_jid, ts) VALUES ('m1', 999, 'x', '2026-10-10T00:00:00Z')").run(),
    ).toThrowError(/FOREIGN KEY/);
  });
});

describe('migrate: a skipped migration', () => {
  // A database made before main's v6 (the reports table) reached this branch is recorded at 1 to 5 and 7 onwards.
  const withoutV6 = MIGRATIONS.filter((m) => m.version !== 6);
  const FAKE_V13: Migration = { version: 13, sql: 'CREATE TABLE fake_later (id INTEGER PRIMARY KEY);' };
  const versions = (db: Database.Database) =>
    (db.prepare('SELECT version FROM schema_version ORDER BY version').all() as { version: number }[]).map((r) => r.version);

  it('throws, naming only the version numbers, and applies nothing when the code knows a version the database skipped', () => {
    const db = new Database(':memory:');
    migrate(db, withoutV6);
    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12]);
    expect(() => migrate(db)).toThrow('database is at v12 but v6 was never applied; restore a backup or contact the developer');
    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'reports'").get()).toBeUndefined();
  });

  it('names every skipped version', () => {
    const db = new Database(':memory:');
    migrate(db);
    db.prepare('DELETE FROM schema_version WHERE version IN (2, 6)').run();
    expect(() => migrate(db)).toThrow('database is at v12 but v2, v6 were never applied');
  });

  it('applies every version in order on a fresh database, a later one after them, and a database with every version recorded migrates as before', () => {
    const db = new Database(':memory:');
    migrate(db);
    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    migrate(db);
    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    migrate(db, [...MIGRATIONS, FAKE_V13]);
    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'fake_later'").get()).toEqual({ name: 'fake_later' });
  });

  it('upgrades an older database without complaint, and the branch’s own migrations never throw', () => {
    const db = new Database(':memory:');
    migrate(db, MIGRATIONS.filter((m) => m.version <= 4));
    expect(versions(db)).toEqual([1, 2, 3, 4]);
    migrate(db);
    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(() => migrate(db)).not.toThrow();
    expect(() => openDb(':memory:')).not.toThrow();
  });
});

describe('migration v8 (Phase 2b: voice notes)', () => {
  const versions = (db: Database.Database) =>
    (db.prepare('SELECT version FROM schema_version ORDER BY version').all() as { version: number }[]).map((r) => r.version);
  /** Up to v8 only, so these keep testing v8 itself once later versions exist. */
  const upToV8 = MIGRATIONS.filter((m) => m.version <= 8);
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
    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    migrate(db, upToV8);
    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(db.prepare(`SELECT "notnull" AS required, dflt_value AS dflt FROM pragma_table_info('media') WHERE name = 'backlog'`).get())
      .toEqual({ required: 1, dflt: '0' });
    expect(db.prepare('SELECT kind, status, local_path AS localPath, backlog FROM media').all())
      .toEqual([{ kind: 'voice', status: 'done', localPath: 'media/SHA/2026-10/m1-1.ogg', backlog: 0 }]);
  });

  it('creates media_stt_forget with its checks: known providers only, a ref of 1 to 200 characters, one row per copy', () => {
    const db = atV7();
    migrate(db, upToV8);
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
    migrate(db, upToV8);
    forget(db, 'elevenlabs', 'tr_1');
    db.prepare('UPDATE media SET backlog = 1').run();
    const schema = db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
    migrate(db, upToV8);
    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
    expect(db.prepare('SELECT backlog FROM media').get()).toEqual({ backlog: 1 });
    expect((db.prepare('SELECT COUNT(*) AS n FROM media_stt_forget').get() as { n: number }).n).toBe(1);
  });
});

describe('migration v9 (owner dashboard)', () => {
  const versions = (db: Database.Database) =>
    (db.prepare('SELECT version FROM schema_version ORDER BY version').all() as { version: number }[]).map((r) => r.version);
  const columns = (db: Database.Database, table: string) =>
    db.prepare(`SELECT name, type, "notnull" AS required, pk FROM pragma_table_info('${table}') ORDER BY cid`).all();
  /** Up to v9 only, so these keep testing v9 itself once later versions exist. */
  const upToV9 = MIGRATIONS.filter((m) => m.version <= 9);
  function freshV9() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, upToV9);
    return db;
  }
  const NEW_TABLES = ['audit_log', 'settings', 'uptime_log', 'web_sessions'];
  /** Every table v1 to v8 made, with all its rows, so a later step can show they did not change. */
  const oldContents = (db: Database.Database) => {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
      .map((t) => t.name).filter((n) => !NEW_TABLES.includes(n) && n !== 'schema_version');
    return Object.fromEntries(names.map((n) => [n, db.prepare(`SELECT * FROM "${n}" ORDER BY rowid`).all()]));
  };
  const oldSchema = (db: Database.Database) =>
    (db.prepare("SELECT type, name, tbl_name AS tbl, sql FROM sqlite_master ORDER BY name").all() as { tbl: string }[])
      .filter((r) => !NEW_TABLES.includes(r.tbl));

  /** A database at v8 with rows in the tables the agent fills, as a running Mac would have. */
  function atV8() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, MIGRATIONS.filter((m) => m.version <= 8));
    db.prepare("INSERT INTO clients (code, name, group_id, phases) VALUES ('SHA', 'Sharma', '1@g.us', '[]')").run();
    db.prepare("INSERT INTO messages (wa_id, client_id, sender_jid, ts) VALUES ('m1', 1, 'x', '2026-10-10T00:00:00Z')").run();
    db.prepare(`INSERT INTO media (message_id, client_id, kind, status, local_path, created_at, updated_at, backlog)
      VALUES (1, 1, 'voice', 'done', 'media/SHA/2026-10/m1-1.ogg', '2026-10-10T00:00:00Z', '2026-10-10T00:01:00Z', 1)`).run();
    db.prepare(`INSERT INTO tasks (code, client_id, side, title, category, priority, raised_on, created_at, updated_at)
      VALUES ('SHA-001', 1, 'us', 'Send logo', 'design', 'high', '2026-10-10', '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z')`).run();
    db.prepare(`INSERT INTO reports (date, status, attempts, created_at, updated_at)
      VALUES ('2026-10-10', 'sent', 1, '2026-10-10T00:30:00Z', '2026-10-10T00:31:00Z')`).run();
    db.prepare("INSERT INTO kv (k, v) VALUES ('health', '{}')").run();
    db.prepare("INSERT INTO media_stt_forget (media_id, provider, ref, created_at) VALUES (1, 'elevenlabs', 'tr_1', '2026-10-10T00:02:00Z')").run();
    return db;
  }

  it('reaches schema_version 9 on a fresh database, with the four new tables', () => {
    const db = freshV9();
    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(NEW_TABLES));
    for (const t of NEW_TABLES) expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, t).toBe(0);
  });

  it('migrates a v8 database with data to v9, leaving every v1 to v8 table, index and row untouched', () => {
    const db = atV8();
    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const rows = oldContents(db);
    const schema = oldSchema(db);
    expect(Object.values(rows).flat().length).toBeGreaterThanOrEqual(7);
    migrate(db, upToV9);
    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(oldContents(db)).toEqual(rows);
    expect(oldSchema(db)).toEqual(schema);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('is additive only: it creates, and never drops, alters, deletes, updates or inserts', () => {
    const v9 = MIGRATIONS.find((m) => m.version === 9)!;
    expect(MIGRATIONS.map((m) => m.version).slice(0, 9)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(v9.sql).not.toMatch(/\b(DROP|ALTER|DELETE|UPDATE|INSERT)\b/i);
  });

  it('web_sessions keeps a hashed id and a hashed CSRF token, never the raw values', () => {
    const db = freshV9();
    expect(columns(db, 'web_sessions')).toEqual([
      { name: 'id_hash', type: 'TEXT', required: 0, pk: 1 },
      { name: 'email', type: 'TEXT', required: 1, pk: 0 },
      { name: 'csrf_hash', type: 'TEXT', required: 1, pk: 0 },
      { name: 'created_at', type: 'TEXT', required: 1, pk: 0 },
      { name: 'expires_at', type: 'TEXT', required: 1, pk: 0 },
      { name: 'last_seen_at', type: 'TEXT', required: 1, pk: 0 },
      { name: 'agent_label', type: 'TEXT', required: 0, pk: 0 },
    ]);
    const add = (id: string) => db.prepare(`INSERT INTO web_sessions (id_hash, email, csrf_hash, created_at, expires_at, last_seen_at)
      VALUES (?, 'owner@example.com', 'c', '2026-10-27T00:00:00Z', '2026-11-03T00:00:00Z', '2026-10-27T00:00:00Z')`).run(id);
    add('h1');
    expect(() => add('h1')).toThrow(/UNIQUE|PRIMARY KEY/);
    expect(() => db.prepare("INSERT INTO web_sessions (id_hash, csrf_hash, created_at, expires_at, last_seen_at) VALUES ('h2', 'c', 'a', 'b', 'c')").run())
      .toThrow(/NOT NULL/);
  });

  it('audit_log accepts only the known kinds, and is indexed by time', () => {
    const db = freshV9();
    expect(columns(db, 'audit_log')).toEqual([
      { name: 'id', type: 'INTEGER', required: 0, pk: 1 },
      { name: 'at', type: 'TEXT', required: 1, pk: 0 },
      { name: 'actor', type: 'TEXT', required: 1, pk: 0 },
      { name: 'event', type: 'TEXT', required: 1, pk: 0 },
      { name: 'kind', type: 'TEXT', required: 1, pk: 0 },
      { name: 'detail', type: 'TEXT', required: 1, pk: 0 },
      { name: 'request_id', type: 'TEXT', required: 0, pk: 0 },
    ]);
    const add = (kind: string) =>
      db.prepare("INSERT INTO audit_log (at, actor, event, kind, detail) VALUES ('2026-10-27T00:00:00Z', 'agent', 'signed_in', ?, '')").run(kind);
    for (const kind of ['auth', 'config', 'connection', 'task', 'meeting', 'ops']) add(kind);
    for (const bad of ['secret', 'AUTH', '']) expect(() => add(bad), bad).toThrow(/CHECK/);
    expect((db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n).toBe(6);
    expect(db.prepare("SELECT name FROM pragma_index_list('audit_log')").all()).toEqual(expect.arrayContaining([{ name: 'audit_log_at' }]));
    expect(db.prepare("SELECT name FROM pragma_index_info('audit_log_at')").all()).toEqual([{ name: 'at' }]);
  });

  it('settings holds one value per key with who changed it and when', () => {
    const db = freshV9();
    expect(columns(db, 'settings')).toEqual([
      { name: 'k', type: 'TEXT', required: 0, pk: 1 },
      { name: 'v', type: 'TEXT', required: 1, pk: 0 },
      { name: 'updated_at', type: 'TEXT', required: 1, pk: 0 },
      { name: 'updated_by', type: 'TEXT', required: 1, pk: 0 },
    ]);
    const add = () => db.prepare("INSERT INTO settings (k, v, updated_at, updated_by) VALUES ('report_time', '\"06:00\"', '2026-10-27T00:00:00Z', 'owner@example.com')").run();
    add();
    expect(add).toThrow(/UNIQUE|PRIMARY KEY/);
  });

  it('uptime_log records up/down transitions and is indexed by time', () => {
    const db = freshV9();
    expect(columns(db, 'uptime_log')).toEqual([
      { name: 'id', type: 'INTEGER', required: 0, pk: 1 },
      { name: 'at', type: 'TEXT', required: 1, pk: 0 },
      { name: 'up', type: 'INTEGER', required: 1, pk: 0 },
    ]);
    db.prepare("INSERT INTO uptime_log (at, up) VALUES ('2026-10-27T00:00:00Z', 1)").run();
    expect(db.prepare("SELECT name FROM pragma_index_info('uptime_log_at')").all()).toEqual([{ name: 'at' }]);
  });

  it('leaves a database already at v9 untouched', () => {
    const db = atV8();
    migrate(db, upToV9);
    db.prepare("INSERT INTO uptime_log (at, up) VALUES ('2026-10-27T00:00:00Z', 0)").run();
    const schema = db.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all();
    migrate(db, upToV9);
    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(db.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all()).toEqual(schema);
    expect(db.prepare('SELECT at, up FROM uptime_log').all()).toEqual([{ at: '2026-10-27T00:00:00Z', up: 0 }]);
  });
});

describe('migration v10 (dashboard: task history index, outage reasons)', () => {
  const versions = (db: Database.Database) =>
    (db.prepare('SELECT version FROM schema_version ORDER BY version').all() as { version: number }[]).map((r) => r.version);
  const columns = (db: Database.Database, table: string) =>
    db.prepare(`SELECT name, type, "notnull" AS required FROM pragma_table_info('${table}') ORDER BY cid`).all();

  function atV9WithData() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, MIGRATIONS.filter((m) => m.version <= 9));
    db.prepare(`INSERT INTO clients (code, name, group_id, phases) VALUES ('SHA', 'Sharma', '120363000000000001@g.us', '[]')`).run();
    db.prepare(`INSERT INTO tasks (code, client_id, side, title, category, priority, raised_on, created_at, updated_at)
      VALUES ('SHA-001', 1, 'us', 'Logo', 'design', 'high', '2026-10-10', '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z')`).run();
    db.prepare(`INSERT INTO task_events (task_id, client_id, actor, op, detail, at) VALUES (1, 1, 'ai', 'add_task', '{}', '2026-10-10T00:00:00Z')`).run();
    db.prepare("INSERT INTO uptime_log (at, up) VALUES ('2026-10-27T00:00:00Z', 0)").run();
    return db;
  }

  it('reaches v10 on a fresh database, with the task history index and the reason column', () => {
    const db = openDb(':memory:');
    expect(versions(db.raw)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(db.raw.prepare("SELECT name FROM pragma_index_info('task_events_task') ORDER BY seqno").all()).toEqual([{ name: 'task_id' }, { name: 'at' }, { name: 'id' }]);
    expect(columns(db.raw, 'uptime_log')).toEqual([
      { name: 'id', type: 'INTEGER', required: 0 },
      { name: 'at', type: 'TEXT', required: 1 },
      { name: 'up', type: 'INTEGER', required: 1 },
      { name: 'reason', type: 'TEXT', required: 0 },
    ]);
  });

  it('upgrades a v9 database with data, keeping every row; old uptime rows have no reason', () => {
    const db = atV9WithData();
    const before = {
      tasks: db.prepare('SELECT * FROM tasks').all(), events: db.prepare('SELECT * FROM task_events').all(), clients: db.prepare('SELECT * FROM clients').all(),
    };
    // Up to v10 only, so this keeps testing v10 itself (v11 adds task and client columns).
    migrate(db, MIGRATIONS.filter((m) => m.version <= 10));
    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect({
      tasks: db.prepare('SELECT * FROM tasks').all(), events: db.prepare('SELECT * FROM task_events').all(), clients: db.prepare('SELECT * FROM clients').all(),
    }).toEqual(before);
    expect(db.prepare('SELECT at, up, reason FROM uptime_log').all()).toEqual([{ at: '2026-10-27T00:00:00Z', up: 0, reason: null }]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('takes a reason of 1 to 100 characters, or none', () => {
    const db = openDb(':memory:');
    const put = db.raw.prepare("INSERT INTO uptime_log (at, up, reason) VALUES ('2026-10-27T00:00:00Z', 0, ?)");
    put.run('stopped');
    put.run(null);
    expect(() => put.run('')).toThrowError(/CHECK/);
    expect(() => put.run('x'.repeat(101))).toThrowError(/CHECK/);
  });

  it('is additive only: it adds a column and an index, and never drops, deletes, updates or inserts', () => {
    const v10 = MIGRATIONS.find((m) => m.version === 10)!;
    expect(v10.sql).not.toMatch(/\b(DROP|DELETE|UPDATE|INSERT|RENAME)\b/i);
    expect(v10.sql.match(/\bALTER\b/gi) ?? []).toHaveLength(1);
    expect(v10.sql).toMatch(/ALTER TABLE uptime_log ADD COLUMN reason/);
  });

  it('leaves a database already at v10 untouched', () => {
    const db = atV9WithData();
    migrate(db);
    const schema = db.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all();
    migrate(db);
    expect(db.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all()).toEqual(schema);
  });
});

describe('migration v11 (priority levels and sentiment)', () => {
  const versions = (db: Database.Database) =>
    (db.prepare('SELECT version FROM schema_version ORDER BY version').all() as { version: number }[]).map((r) => r.version);

  function atV10WithTasks() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, MIGRATIONS.filter((m) => m.version <= 10));
    db.prepare(`INSERT INTO clients (code, name, group_id, phases) VALUES ('SHA', 'Sharma', '120363000000000001@g.us', '[]')`).run();
    for (const [code, priority] of [['SHA-001', 'high'], ['SHA-002', 'low']]) {
      db.prepare(`INSERT INTO tasks (code, client_id, side, title, category, priority, raised_on, created_at, updated_at)
        VALUES (?, 1, 'us', 'Logo', 'design', ?, '2026-10-10', '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z')`).run(code, priority);
    }
    return db;
  }

  it('upgrades a v10 database: every task and client is kept, with no level and no mood until one is set', () => {
    const db = atV10WithTasks();
    const before = db.prepare('SELECT * FROM tasks').all() as Record<string, unknown>[];
    migrate(db);
    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const after = db.prepare('SELECT * FROM tasks').all() as Record<string, unknown>[];
    expect(after).toEqual(before.map((t) => ({ ...t, priority_level: null, priority_source: null, priority_keyword: null, sentiment: null })));
    expect(db.prepare('SELECT sentiment, sentiment_at AS at FROM clients').all()).toEqual([{ sentiment: null, at: null }]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('takes only the four levels, three sources and four moods, and a keyword of 1 to 200 characters', () => {
    const db = atV10WithTasks();
    migrate(db);
    const set = (col: string, v: unknown) => () => db.prepare(`UPDATE tasks SET ${col} = ? WHERE id = 1`).run(v);
    for (const v of ['critical', 'major', 'medium', 'low', null]) expect(set('priority_level', v)).not.toThrow();
    for (const v of ['keyword', 'ai', 'human', null]) expect(set('priority_source', v)).not.toThrow();
    for (const v of ['positive', 'neutral', 'negative', 'frustrated', null]) expect(set('sentiment', v)).not.toThrow();
    expect(set('priority_level', 'high')).toThrowError(/CHECK/);
    expect(set('priority_source', 'owner')).toThrowError(/CHECK/);
    expect(set('sentiment', 'angry')).toThrowError(/CHECK/);
    expect(set('priority_keyword', '')).toThrowError(/CHECK/);
    expect(set('priority_keyword', 'x'.repeat(201))).toThrowError(/CHECK/);
    expect(() => db.prepare("UPDATE clients SET sentiment = 'sad'").run()).toThrowError(/CHECK/);
  });

  it('is additive only: it adds columns, and never drops, deletes, updates or inserts', () => {
    const v11 = MIGRATIONS.find((m) => m.version === 11)!;
    expect(v11.sql).not.toMatch(/\b(DROP|DELETE|UPDATE|INSERT|RENAME)\b/i);
    expect((v11.sql.match(/\bALTER TABLE (tasks|clients) ADD COLUMN\b/g) ?? []).length).toBe(v11.sql.match(/\bALTER\b/g)!.length);
  });
});

describe('migration v12 (Open chat: the outbox)', () => {
  const put = (db: Database.Database, o: Record<string, unknown> = {}) =>
    db.prepare(`INSERT INTO outbox (uuid, client_id, text, state, actor, created_at) VALUES (@uuid, @client, @text, @state, 'owner@example.com', '2026-10-29T08:00:00Z')`)
      .run({ uuid: '00000000-0000-4000-8000-000000000001', client: 1, text: 'Hello', state: 'claimed', ...o });

  it('is additive only: one new table and its indexes', () => {
    const v12 = MIGRATIONS.find((m) => m.version === 12)!;
    expect(v12.sql).not.toMatch(/\b(DROP|DELETE|UPDATE|INSERT|RENAME|ALTER)\b/i);
    expect(v12.sql.match(/\bCREATE TABLE\b/g) ?? []).toHaveLength(1);
  });

  it('upgrades a v11 database with data, keeping every row', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, MIGRATIONS.filter((m) => m.version <= 11));
    db.prepare(`INSERT INTO clients (code, name, group_id, phases) VALUES ('SHA', 'Sharma', '120363000000000001@g.us', '[]')`).run();
    const before = db.prepare('SELECT * FROM clients').all();
    migrate(db);
    expect(db.prepare('SELECT * FROM clients').all()).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM outbox').get()).toEqual({ n: 0 });
  });

  it('one row per uuid, a known state, 1 to 4096 characters, an existing client', () => {
    const db = openDb(':memory:');
    db.raw.prepare(`INSERT INTO clients (code, name, group_id, phases) VALUES ('SHA', 'Sharma', '120363000000000001@g.us', '[]')`).run();
    put(db.raw);
    expect(() => put(db.raw)).toThrowError(/UNIQUE/);
    expect(() => put(db.raw, { uuid: 'short' })).toThrowError(/CHECK/);
    expect(() => put(db.raw, { uuid: '00000000-0000-4000-8000-000000000002', state: 'retrying' })).toThrowError(/CHECK/);
    expect(() => put(db.raw, { uuid: '00000000-0000-4000-8000-000000000003', text: '' })).toThrowError(/CHECK/);
    expect(() => put(db.raw, { uuid: '00000000-0000-4000-8000-000000000004', text: 'x'.repeat(4097) })).toThrowError(/CHECK/);
    expect(() => put(db.raw, { uuid: '00000000-0000-4000-8000-000000000005', client: 99 })).toThrowError(/FOREIGN KEY/);
  });
});

describe('applied migrations never change', () => {
  it('v1 to v10 stay byte for byte as written (a change goes in a new version after them, never an edit)', () => {
    const text = MIGRATIONS.filter((m) => m.version <= 10).map((m) => `${m.version}\n${m.sql}`).join('\n---\n');
    expect(createHash('sha256').update(text).digest('hex')).toBe('b8f67ddeff8d2f33bda23181a83a4c7b6609c60b9efd8312f0c0ededacf8fb51');
  });
});
