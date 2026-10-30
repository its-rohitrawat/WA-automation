import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FOUNDER_TENANT_ID as ENV_FOUNDER, parseEnv } from '../../src/config/env.ts';
import { FOUNDER_TENANT_ID } from '../../src/platform/store.ts';
import { PgPlatformDb, PgTenantDb, type PgClient, type PgPool } from '../../src/store/engine/pg.ts';
import { SqliteDb } from '../../src/store/engine/sqlite.ts';
import { openPlatformStore, openStore } from '../../src/store/open.ts';
import { PG_LATEST } from '../../src/store/pg/migrations.ts';

// The engine switch (S2.6) with no server: Postgres is a fake pool answering wa_schema_version().
const LOCAL = 'postgres://wa_app:placeholder@127.0.0.1:5432/wa_agent';
const PLATFORM = 'postgres://wa_platform:placeholder@127.0.0.1:5432/wa_agent';

function fakePool(version: number | null): PgPool & { ended: boolean; sql: string[] } {
  const pool = {
    ended: false,
    sql: [] as string[],
    async connect(): Promise<PgClient> {
      return {
        query: async (text: string) => {
          pool.sql.push(text);
          return { rows: /wa_schema_version/.test(text) ? [{ v: version }] : [], rowCount: 0 };
        },
        release: () => {},
      };
    },
    async end() {
      pool.ended = true;
    },
  };
  return pool;
}

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('openStore: DB_ENGINE', () => {
  it('sqlite (the default) opens data/tracker.db as before', async () => {
    dir = mkdtempSync(join(tmpdir(), 'wa-open-'));
    const db = await openStore(parseEnv({ DATA_DIR: dir }));
    try {
      expect(db).toBeInstanceOf(SqliteDb);
      expect(db.engine).toBe('sqlite');
      expect(openPlatformStore(parseEnv({ DATA_DIR: dir }), db)).toBe(db); // the platform tables live in tracker.db
    } finally {
      await db.close();
    }
  });

  it('postgres: customer #1 by default, once the schema is at the version this code needs', async () => {
    const pool = fakePool(PG_LATEST);
    const env = parseEnv({ DB_ENGINE: 'postgres', DATABASE_URL: LOCAL, DATABASE_PLATFORM_URL: PLATFORM });
    const db = await openStore(env, { pool });
    expect(db).toBeInstanceOf(PgTenantDb);
    expect((db as PgTenantDb).tenantId).toBe(FOUNDER_TENANT_ID);
    expect(pool.sql).toContain('SELECT wa_schema_version() AS v');
    expect(pool.ended).toBe(false);
    expect(openPlatformStore(env, db, { pool: fakePool(PG_LATEST) })).toBeInstanceOf(PgPlatformDb);
  });

  it('only an explicit postgres leaves SQLite', async () => {
    dir = mkdtempSync(join(tmpdir(), 'wa-open-'));
    const db = await openStore({ DATA_DIR: dir } as Parameters<typeof openStore>[0]);
    try {
      expect(db).toBeInstanceOf(SqliteDb);
    } finally {
      await db.close();
    }
  });

  it('postgres at another schema version is refused, naming db-migrate, and its pool is closed', async () => {
    for (const v of [null, PG_LATEST - 1, PG_LATEST + 1]) {
      const pool = fakePool(v);
      const env = parseEnv({ DB_ENGINE: 'postgres', DATABASE_URL: LOCAL, DATABASE_PLATFORM_URL: PLATFORM });
      await expect(openStore(env, { pool }), String(v)).rejects.toThrow(/db-migrate/);
      expect(pool.ended, String(v)).toBe(true);
    }
  });
});

describe('the database settings', () => {
  it('DB_ENGINE defaults to sqlite; postgres needs both agent URLs; TENANT_ID defaults to customer #1', () => {
    expect(parseEnv({}).DB_ENGINE).toBe('sqlite');
    expect(parseEnv({}).TENANT_ID).toBe(FOUNDER_TENANT_ID);
    expect(ENV_FOUNDER).toBe(FOUNDER_TENANT_ID);
    expect(() => parseEnv({ DB_ENGINE: 'postgres' })).toThrow(/DATABASE_URL is required when DB_ENGINE is postgres/);
    expect(() => parseEnv({ DB_ENGINE: 'postgres', DATABASE_URL: LOCAL })).toThrow(/DATABASE_PLATFORM_URL is required/);
    expect(() => parseEnv({ TENANT_ID: 'founder' })).toThrow(/TENANT_ID/);
    expect(() => parseEnv({ DB_ENGINE: 'mysql' })).toThrow(/DB_ENGINE/);
  });

  it('a URL must stay on this machine, and its password is never echoed', () => {
    for (const name of ['DATABASE_URL', 'DATABASE_PLATFORM_URL', 'DATABASE_OWNER_URL']) {
      let message = '';
      try {
        parseEnv({ [name]: 'postgres://wa_app:s3cret-Value@db.example.com:5432/wa_agent' });
      } catch (e) {
        message = String(e);
      }
      expect(message, name).toMatch(new RegExp(`${name} must be a postgres:// URL to 127\\.0\\.0\\.1 or localhost`));
      expect(message, name).not.toContain('s3cret');
      expect(message, name).not.toContain('example.com');
    }
    expect(() => parseEnv({ DATABASE_URL: 'mysql://u:p@127.0.0.1/x' })).toThrow(/DATABASE_URL must be a postgres/);
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      expect(parseEnv({ DATABASE_URL: `postgresql://wa_app:placeholder@${host}:5432/wa_agent` }).DATABASE_URL, host).toBeDefined();
    }
  });
});
