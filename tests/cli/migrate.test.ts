import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportToSqliteCommand, migrateToPostgresCommand, type MigrateCommandDeps } from '../../src/cli/migrate.ts';
import { parseEnv } from '../../src/config/env.ts';
import { FakeTarget } from '../migrate/fakeTarget.ts';
import { fixture, type Fixture } from '../migrate/fixture.ts';

// The copy tool's commands (S3.6): their argument rules and exit codes, with lane C's SQLite stand-in for Postgres.
// Every password here is a placeholder.

const OWNER_URL = 'postgres://wa_owner:owner-placeholder@127.0.0.1:5432/wa_agent';
let f: Fixture;
let target: FakeTarget;
let closed: number;
let lines: string[];

beforeEach(async () => {
  f = await fixture({ sender: true });
  target = await FakeTarget.open();
  closed = 0;
  lines = [];
});
afterEach(async () => {
  await target.close();
});

const env = (over: Record<string, string> = {}) => parseEnv({ DATA_DIR: f.data, DATABASE_OWNER_URL: OWNER_URL, ...over });
/** The stand-in behind the command, its close() counted (the real close comes in afterEach). */
const deps = (): MigrateCommandDeps & { urls: string[] } => {
  const urls: string[] = [];
  return {
    urls,
    target: (url) => {
      urls.push(url);
      return new Proxy(target, { get: (t, k) => (k === 'close' ? async () => void closed++ : Reflect.get(t, k, t)) });
    },
    out: (text) => lines.push(text),
  };
};

describe('migrate-to-postgres', () => {
  it('no flags: a dry run, exit 0 when every table matched, the report printed, the owner URL used and the target closed', async () => {
    const d = deps();
    expect(await migrateToPostgresCommand(env(), {}, d)).toBe(0);
    expect(d.urls).toEqual([OWNER_URL]);
    expect(closed).toBe(1);
    expect(lines.join('\n')).not.toContain('owner-placeholder');
    expect(lines.join('\n').length).toBeGreaterThan(0);
  });

  it('--apply without --backup-dir is refused with the copy’s own message, and the target still closes', async () => {
    await expect(migrateToPostgresCommand(env(), { apply: true }, deps())).rejects.toThrow(/backup/i);
    expect(closed).toBe(1);
  });

  it('DATABASE_OWNER_URL missing, or not wa_owner’s, is refused before any connection, without the URL', async () => {
    let d = deps();
    await expect(migrateToPostgresCommand(parseEnv({ DATA_DIR: f.data }), {}, d)).rejects.toThrow('DATABASE_OWNER_URL is not configured');
    expect(d.urls).toEqual([]);
    d = deps();
    let message = '';
    try {
      await migrateToPostgresCommand(env({ DATABASE_OWNER_URL: 'postgres://wa_app:secret-placeholder@127.0.0.1:5432/wa_agent' }), {}, d);
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain('DATABASE_OWNER_URL must connect as wa_owner');
    expect(message).not.toContain('secret-placeholder');
    expect(d.urls).toEqual([]);
  });

  it('a table that does not match gives exit code 1', async () => {
    target.beforeVerify = async (q) => {
      await q.run("UPDATE clients SET name = 'changed' WHERE id = (SELECT min(id) FROM clients)");
    };
    expect(await migrateToPostgresCommand(env(), {}, deps())).toBe(1);
  });
});

describe('export-to-sqlite', () => {
  it('needs the owner’s URL like the copy, and closes its source', async () => {
    const d = deps();
    await expect(exportToSqliteCommand(parseEnv({ DATA_DIR: f.data }), { out: `${f.dir}/out` }, d)).rejects.toThrow('DATABASE_OWNER_URL is not configured');
    expect(d.urls).toEqual([]);
    expect(closed).toBe(0);
  });
});
