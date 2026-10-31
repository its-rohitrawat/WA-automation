import { describe, expect, it } from 'vitest';
import { dbBootstrapCommand, dbMigrateCommand, type DbCommandDeps } from '../../src/cli/db.ts';
import { parseEnv } from '../../src/config/env.ts';
import type { AdminConnection } from '../../src/store/engine/pg.ts';
import { accessRefusedAfterMigrate, type CatalogRow } from '../../src/store/pg/accessRules.ts';
import { healthyCatalog, isAccessQuery } from '../store/pg/catalogFake.ts';

// The two CLI commands with scripted prompts and a fake connection: what they check before asking, and that no password
// reaches the output.

const P = { owner: 'owner-placeholder-1', app: 'app-placeholder-22', platform: 'platform-placeholder-3' };
const BACKUP = 'backup-placeholder-4444';
const SUPER = 'super-placeholder-55';

const envWith = (over: Record<string, string> = {}) =>
  parseEnv({
    DB_ENGINE: 'postgres',
    DATABASE_URL: `postgres://wa_app:${P.app}@127.0.0.1:5432/wa_agent`,
    DATABASE_PLATFORM_URL: `postgres://wa_platform:${P.platform}@127.0.0.1:5432/wa_agent`,
    DATABASE_OWNER_URL: `postgres://wa_owner:${P.owner}@127.0.0.1:5432/wa_agent`,
    ...over,
  });

/** `catalog`: what db-migrate's access check reads at its end (as db-migrate leaves a database, unless a test says otherwise). */
function deps(answers: string[], catalog: CatalogRow[] = healthyCatalog()) {
  const urls: string[] = [];
  const asked: string[] = [];
  const lines: string[] = [];
  const conn: AdminConnection = {
    async sql(text) {
      // A database made by db-bootstrap: its text order is C.
      if (text.includes('pg_database')) return { rows: [{ collate: 'C', ctype: 'C' }], rowCount: 1 };
      if (isAccessQuery(text)) return { rows: catalog as unknown as Record<string, unknown>[], rowCount: catalog.length };
      return { rows: text.startsWith('SELECT format(') ? [{ sql: 'SELECT 1' }] : [], rowCount: 0 };
    },
    async end() {},
  };
  const d: DbCommandDeps = {
    connect: async (url) => {
      urls.push(url);
      return conn;
    },
    prompt: async (q) => {
      asked.push(q);
      return answers.shift() ?? '';
    },
    out: (l) => lines.push(l),
    now: () => '2026-10-30T10:00:00.000Z',
  };
  return { d, urls, asked, lines };
}

const secrets = [P.owner, P.app, P.platform, BACKUP, SUPER];

describe('db-bootstrap', () => {
  it('asks for the superuser password and wa_backup twice, connects as the superuser on this machine, prints no secret', async () => {
    const t = deps([SUPER, BACKUP, BACKUP]);
    await dbBootstrapCommand(envWith(), { superuser: 'postgres' }, t.d);
    expect(t.asked).toHaveLength(3);
    expect(t.urls.map((u) => { const x = new URL(u); return [x.username, decodeURIComponent(x.password) === SUPER, x.hostname, x.pathname]; })).toEqual([
      ['postgres', true, '127.0.0.1', '/postgres'],
      ['postgres', true, '127.0.0.1', '/wa_agent'],
    ]);
    const shown = [...t.asked, ...t.lines].join('\n');
    for (const s of secrets) expect(shown, s).not.toContain(s);
    expect(t.lines.at(-1)).toBe('Next: npm run cli -- db-migrate');
  });

  it('a wrong .env setting is refused before any password is asked', async () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ DATABASE_URL: `postgres://wa_platform:${P.app}@127.0.0.1:5432/wa_agent` }, /DATABASE_URL must connect as wa_app/],
      [{ DATABASE_PLATFORM_URL: `postgres://wa_platform:${P.platform}@127.0.0.1:5432/other` }, /DATABASE_PLATFORM_URL must name the same database/],
      [{ DATABASE_URL: `postgres://wa_app:${P.owner}@127.0.0.1:5432/wa_agent` }, /each need their own password/],
    ];
    for (const [over, err] of cases) {
      const t = deps([SUPER, BACKUP, BACKUP]);
      await expect(dbBootstrapCommand(envWith(over), { superuser: 'postgres' }, t.d), String(err)).rejects.toThrow(err);
      expect(t.asked).toEqual([]);
      expect(t.urls).toEqual([]);
    }
    const t = deps([]);
    await expect(dbBootstrapCommand(envWith(), { superuser: 'wa_owner' }, t.d)).rejects.toThrow(/--superuser/);
    expect(t.asked).toEqual([]);
  });

  it('a short, mistyped or reused wa_backup password changes nothing', async () => {
    for (const [answers, err] of [
      [[SUPER, 'short-1'], /at least 16/],
      [[SUPER, BACKUP, `${BACKUP}x`], /differ/],
      [[SUPER, P.app, P.app], /wa_backup needs its own password/],
      [[SUPER, P.owner, P.owner], /wa_backup needs its own password/],
    ] as const) {
      const t = deps([...answers]);
      await expect(dbBootstrapCommand(envWith(), { superuser: 'postgres' }, t.d), String(err)).rejects.toThrow(err);
      expect(t.urls).toEqual([]);
    }
  });
});

describe('db-migrate', () => {
  it('connects with DATABASE_OWNER_URL, which must be wa_owner', async () => {
    const t = deps([]);
    await dbMigrateCommand(envWith(), t.d);
    expect(t.urls.map((u) => new URL(u).username)).toEqual(['wa_owner']);
    expect(t.lines.join('\n')).not.toContain(P.owner);
    // It ends checking the live access rules (security review S1, S2).
    expect(t.lines.at(-1)).toBe('Access rules checked: row security on every customer table, nothing of the platform open to wa_app');
    const bad = deps([]);
    await expect(dbMigrateCommand(envWith({ DATABASE_OWNER_URL: `postgres://wa_app:${P.owner}@127.0.0.1:5432/wa_agent` }), bad.d)).rejects.toThrow('DATABASE_OWNER_URL must connect as wa_owner');
    expect(bad.urls).toEqual([]);
  });

  it('ends refusing, naming what is wrong, when the access rules do not hold after its migrations (review S1)', async () => {
    const t = deps([], healthyCatalog().map((r) => (r.name === 'web_sessions' ? { ...r, app: true } : r)));
    await expect(dbMigrateCommand(envWith(), t.d)).rejects.toThrow(accessRefusedAfterMigrate(['wa_app can reach platform table web_sessions']));
    expect(t.lines).not.toContain('Access rules checked: row security on every customer table, nothing of the platform open to wa_app');
    expect(t.lines.join('\n')).not.toContain(P.owner);
  });
});
