import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../../src/store/db.ts';

describe('openDb', () => {
  it('creates every table', () => {
    const db = openDb(':memory:');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining([
      'batches', 'clients', 'decisions', 'kv', 'media', 'message_edits', 'messages', 'people', 'reactions', 'reports', 'schema_version', 'spend', 'task_events',
      'tasks',
    ]));
  });

  it('creates the task and media indexes', () => {
    const db = openDb(':memory:');
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((i) => i.name);
    expect(idx).toEqual(expect.arrayContaining(['tasks_client_status', 'task_events_client_at', 'media_due', 'media_client']));
  });

  it('is at schema version 6 straight after openDb', () => {
    const db = openDb(':memory:');
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(6);
  });

  it('is safe to migrate twice', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect((db.prepare('SELECT COUNT(*) AS n FROM schema_version').get() as { n: number }).n).toBe(6);
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
