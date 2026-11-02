import { describe, expect, it } from 'vitest';
import type { AdminConnection } from '../../../src/store/engine/pg.ts';
import { bootstrap, databaseGrants, migrate, roleOf, ROLES } from '../../../src/store/pg/admin.ts';
import { accessRefusedAfterMigrate, type CatalogRow } from '../../../src/store/pg/accessRules.ts';
import { COLLATION_REFUSED, COLLATION_SQL, isByteOrder } from '../../../src/store/pg/collation.ts';
import { healthyCatalog, isAccessQuery } from './catalogFake.ts';
import { PG_MIGRATIONS } from '../../../src/store/pg/migrations.ts';

// db-bootstrap and db-migrate with no server (S2.3, S2.4): a fake admin connection records what is sent. S2.7 runs them
// against a real Postgres.

const PASSWORDS = { wa_owner: 'owner-placeholder-1', wa_app: 'app-placeholder-22', wa_platform: 'platform-placeholder-3', wa_backup: 'backup-placeholder-444' };

interface Sent { db: string; text: string; values: readonly unknown[] }

function fakeServer(o: { roles?: string[]; databases?: string[]; versions?: number[]; failOn?: RegExp; collation?: string; catalog?: CatalogRow[] } = {}) {
  const sent: Sent[] = [];
  const ended: string[] = [];
  const versions = [...(o.versions ?? [])];
  const conn = (db: string): AdminConnection => ({
    async sql(text, values = []) {
      sent.push({ db, text, values });
      if (o.failOn?.test(text)) throw new Error('boom');
      // The access check's catalog: as db-migrate leaves it, unless a test says otherwise.
      if (isAccessQuery(text)) {
        const rows = o.catalog ?? healthyCatalog();
        return { rows: rows as unknown as Record<string, unknown>[], rowCount: rows.length };
      }
      if (text.includes('FROM pg_roles')) return { rows: (o.roles ?? []).includes(String(values[0])) ? [{ '?column?': 1 }] : [], rowCount: 0 };
      if (text.includes('FROM pg_database')) {
        // The database's collation (C unless a test says otherwise): the current one, or one named by bootstrap.
        const c = { collate: o.collation ?? 'C', ctype: o.collation ?? 'C' };
        if (text.includes('current_database()')) return { rows: [c], rowCount: 1 };
        return { rows: (o.databases ?? []).includes(String(values[0])) ? [c] : [], rowCount: 0 };
      }
      if (text.startsWith('SELECT format(')) {
        // As the server would: %I an identifier, %L a quoted literal.
        const built = text.slice("SELECT format('".length, text.indexOf("', $1")).replace('%I', String(values[0])).replace('%L', `'${String(values[1])}'`);
        return { rows: [{ sql: built }], rowCount: 1 };
      }
      if (text === 'SELECT version FROM pg_schema_version') return { rows: versions.map((version) => ({ version })), rowCount: versions.length };
      if (text.startsWith('INSERT INTO pg_schema_version')) versions.push(Number(values[0]));
      return { rows: [], rowCount: 0 };
    },
    async end() {
      ended.push(db);
    },
  });
  return { sent, ended, conn, versions };
}

const out = () => {
  const lines: string[] = [];
  return { lines, out: (l: string) => lines.push(l) };
};

describe('bootstrap', () => {
  it('creates the four roles, the database owned by wa_owner, then its grants; passwords go only as bind values', async () => {
    const s = fakeServer();
    const o = out();
    await bootstrap({ connect: async (db) => s.conn(db), passwords: PASSWORDS, dbName: 'wa_agent', out: o.out });

    const ours = s.sent.filter((x) => !x.text.startsWith('CREATE ROLE') && !x.text.startsWith('ALTER ROLE'));
    for (const p of Object.values(PASSWORDS)) {
      expect(ours.every((x) => !x.text.includes(p)), p).toBe(true); // never pasted into SQL by the agent
      expect(o.lines.join('\n')).not.toContain(p);
    }
    const roleSql = s.sent.filter((x) => x.text.startsWith('CREATE ROLE')).map((x) => x.text);
    expect(roleSql).toHaveLength(4);
    expect(roleSql.find((t) => t.startsWith('CREATE ROLE wa_app '))).toContain('NOBYPASSRLS');
    expect(roleSql.find((t) => t.startsWith('CREATE ROLE wa_platform '))).toContain('NOBYPASSRLS');
    expect(roleSql.find((t) => t.startsWith('CREATE ROLE wa_owner '))).toContain('NOBYPASSRLS');
    expect(roleSql.find((t) => t.startsWith('CREATE ROLE wa_backup '))).toMatch(/ BYPASSRLS /);
    for (const t of roleSql) expect(t).toMatch(/NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION/);

    expect(s.sent.filter((x) => x.db === 'postgres').map((x) => x.text)).toContain(`CREATE DATABASE "wa_agent" OWNER wa_owner ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`);
    expect(s.sent.filter((x) => x.db === 'wa_agent').map((x) => x.text)).toEqual(databaseGrants('wa_agent'));
    expect(s.ended).toEqual(['postgres', 'wa_agent']);
    expect(o.lines).toEqual([
      'Created role wa_owner', 'Created role wa_app', 'Created role wa_platform', 'Created role wa_backup',
      'Created database wa_agent, owned by wa_owner',
      'Granted wa_agent: wa_app and wa_platform reach rows only, wa_backup reads only, PUBLIC nothing',
    ]);
  });

  it('run again: the roles are updated (password and attributes), the database is kept', async () => {
    const s = fakeServer({ roles: Object.keys(ROLES), databases: ['wa_agent'] });
    const o = out();
    await bootstrap({ connect: async (db) => s.conn(db), passwords: PASSWORDS, dbName: 'wa_agent', out: o.out });
    expect(s.sent.filter((x) => x.text.startsWith('ALTER ROLE'))).toHaveLength(4);
    expect(s.sent.some((x) => x.text.startsWith('CREATE '))).toBe(false);
    expect(o.lines).toContain('Database wa_agent is already there: kept');
  });

  it('refuses a database already there in another collation, before any role is touched (byte order, as SQLite)', async () => {
    const s = fakeServer({ databases: ['wa_agent'], collation: 'en_US.utf8' });
    const o = out();
    await expect(bootstrap({ connect: async (db) => s.conn(db), passwords: PASSWORDS, dbName: 'wa_agent', out: o.out })).rejects.toThrow(COLLATION_REFUSED);
    expect(s.sent.some((x) => /ROLE|CREATE|GRANT/.test(x.text))).toBe(false);
    expect(o.lines).toEqual([]);
  });

  it('the grants: no PUBLIC access, default privileges give wa_app rows and wa_backup SELECT only', () => {
    const g = databaseGrants('wa_agent');
    expect(g).toContain('REVOKE CONNECT, TEMPORARY ON DATABASE "wa_agent" FROM PUBLIC');
    expect(g).toContain('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    expect(g).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE wa_owner IN SCHEMA public GRANT SELECT ON TABLES TO wa_backup');
    expect(g).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE wa_owner IN SCHEMA public GRANT SELECT ON SEQUENCES TO wa_backup');
    expect(g.filter((t) => /wa_backup/.test(t) && /\b(INSERT|UPDATE|DELETE|CREATE|USAGE, SELECT ON SEQ)/.test(t))).toEqual([]);
    expect(g.filter((t) => /wa_platform/.test(t) && /DEFAULT PRIVILEGES/.test(t))).toEqual([]); // P3 grants it the platform tables only
    expect(() => databaseGrants('wa-agent"; DROP')).toThrow(/lower-case/);
  });

  it('a missing password stops before any role is touched', async () => {
    const s = fakeServer();
    await expect(bootstrap({ connect: async (db) => s.conn(db), passwords: { ...PASSWORDS, wa_owner: '' }, dbName: 'wa_agent', out: () => {} })).rejects.toThrow('no password for wa_owner');
    // Only the read of an existing database's collation went out: no role, no database.
    expect(s.sent.map((x) => x.text)).toEqual([expect.stringMatching(/^SELECT datcollate .* FROM pg_database WHERE datname = \$1$/)]);
    expect(s.ended).toEqual(['postgres']);
  });
});

describe('migrate', () => {
  const now = () => '2026-10-30T10:00:00.000Z';

  it('refuses a database in another collation, applying nothing (byte order, as SQLite compares text)', async () => {
    const s = fakeServer({ collation: 'en_US.utf8' });
    const o = out();
    await expect(migrate(s.conn('wa_agent'), { now, out: o.out })).rejects.toThrow(COLLATION_REFUSED);
    expect(s.sent.some((x) => /CREATE|INSERT|BEGIN/.test(x.text))).toBe(false);
    expect(o.lines).toEqual([]);
    expect([isByteOrder({ collate: 'C', ctype: 'C' }), isByteOrder({ collate: 'POSIX', ctype: 'POSIX' })]).toEqual([true, true]);
    expect([isByteOrder({ collate: 'C', ctype: 'en_US.utf8' }), isByteOrder({ collate: 'en_US.UTF-8', ctype: 'C' }), isByteOrder(undefined)]).toEqual([false, false, false]);
  });

  it('a new database: every migration, each in its own transaction with its version row', async () => {
    const s = fakeServer();
    const o = out();
    expect(await migrate(s.conn('wa_agent'), { now, out: o.out })).toEqual(PG_MIGRATIONS.map((m) => m.version));
    const texts = s.sent.map((x) => x.text);
    expect(texts[0]).toBe(COLLATION_SQL); // the database's text order is checked before anything else
    expect(texts[1]).toMatch(/^CREATE TABLE IF NOT EXISTS pg_schema_version/);
    for (const m of PG_MIGRATIONS) {
      const at = texts.indexOf(m.sql);
      expect(texts.slice(at - 1, at + 3)).toEqual(['BEGIN', m.sql, 'INSERT INTO pg_schema_version (version, applied_at) VALUES ($1, $2)', 'COMMIT']);
    }
    expect(o.lines).toEqual([...PG_MIGRATIONS.map((m) => `Applied P${m.version}`), 'Access rules checked: row security on every customer table, nothing of the platform open to wa_app']);
    expect(isAccessQuery(texts.at(-1)!)).toBe(true); // the live catalog is checked last
  });

  it('up to date: nothing; part way: only the newer ones', async () => {
    const done = fakeServer({ versions: PG_MIGRATIONS.map((m) => m.version) });
    const o = out();
    expect(await migrate(done.conn('wa_agent'), { now, out: o.out })).toEqual([]);
    expect(done.sent.some((x) => x.text === 'BEGIN')).toBe(false);
    expect(o.lines).toEqual([`Already at P${PG_MIGRATIONS.at(-1)!.version}: nothing to apply`, 'Access rules checked: row security on every customer table, nothing of the platform open to wa_app']);

    const part = fakeServer({ versions: [1] });
    expect(await migrate(part.conn('wa_agent'), { now, out: () => {} })).toEqual(PG_MIGRATIONS.slice(1).map((m) => m.version));
    expect(part.sent.some((x) => x.text === PG_MIGRATIONS[0]!.sql)).toBe(false);
  });

  it('ends refusing, naming what is wrong, when the live catalog breaks an access rule (security review S1)', async () => {
    const catalog = healthyCatalog().map((r) => (r.name === 'spend' ? { ...r, forced: false } : r.name === 'invites' ? { ...r, app: true } : r));
    const s = fakeServer({ versions: PG_MIGRATIONS.map((m) => m.version), catalog });
    const o = out();
    const problems = ['table spend has row security not forced', 'wa_app can reach platform table invites'];
    await expect(migrate(s.conn('wa_agent'), { now, out: o.out })).rejects.toThrow(accessRefusedAfterMigrate(problems));
    expect(o.lines).not.toContain('Access rules checked: row security on every customer table, nothing of the platform open to wa_app');
  });

  it("a test's own migration list is not checked against the access rules (it is not this code's schema)", async () => {
    const s = fakeServer({ catalog: [] });
    expect(await migrate(s.conn('wa_agent'), { now, out: () => {}, migrations: [{ version: 1, sql: 'CREATE TABLE a ()' }] })).toEqual([1]);
    expect(s.sent.some((x) => isAccessQuery(x.text))).toBe(false);
  });

  it('a gap below the recorded version is refused, applying nothing', async () => {
    const s = fakeServer({ versions: [1, 3] });
    await expect(migrate(s.conn('wa_agent'), { now, out: () => {} })).rejects.toThrow('the database is at P3 but P2 was never applied');
    expect(s.sent.some((x) => x.text === 'BEGIN')).toBe(false);
  });

  it('a failing migration rolls back and stops: its version is not recorded, the next one never runs', async () => {
    const migrations = [{ version: 1, sql: 'CREATE TABLE a ()' }, { version: 2, sql: 'BROKEN' }, { version: 3, sql: 'CREATE TABLE c ()' }];
    const s = fakeServer({ failOn: /^BROKEN$/ });
    await expect(migrate(s.conn('wa_agent'), { now, out: () => {}, migrations })).rejects.toThrow('boom');
    const texts = s.sent.map((x) => x.text);
    expect(texts.slice(-2)).toEqual(['BROKEN', 'ROLLBACK']);
    expect(texts).not.toContain('CREATE TABLE c ()');
    expect(s.versions).toEqual([1]);
  });
});

describe('roleOf', () => {
  it('reads the password of the role a URL must use; messages name the setting, never the value', () => {
    expect(roleOf('DATABASE_URL', 'postgres://wa_app:p%40ss-placeholder@127.0.0.1:5432/wa_agent', 'wa_app')).toBe('p@ss-placeholder');
    expect(() => roleOf('DATABASE_URL', undefined, 'wa_app')).toThrow('DATABASE_URL is not configured');
    expect(() => roleOf('DATABASE_URL', 'postgres://wa_app@127.0.0.1/wa_agent', 'wa_app')).toThrow('DATABASE_URL has no password');
    let message = '';
    try {
      roleOf('DATABASE_URL', 'postgres://postgres:s3cret-placeholder@127.0.0.1/wa_agent', 'wa_app');
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain('DATABASE_URL must connect as wa_app');
    expect(message).not.toContain('s3cret');
  });
});
