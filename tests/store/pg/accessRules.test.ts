import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEnv } from '../../../src/config/env.ts';
import { openAdminConnection, openPgPool, PgTenantDb, type AdminConnection } from '../../../src/store/engine/pg.ts';
import { openStore } from '../../../src/store/open.ts';
import { migrate } from '../../../src/store/pg/admin.ts';
import { ACCESS_SQL, accessProblems, accessRefused, accessRefusedAfterMigrate, type CatalogRow } from '../../../src/store/pg/accessRules.ts';
import { CUSTOMER_TABLES, FOUNDER_TENANT_ID } from '../../../src/store/pg/migrations.ts';
import { freshPg, type FreshPg } from '../../helpers/freshPg.ts';
import { onPg } from '../../helpers/pg.ts';
import { healthyCatalog } from './catalogFake.ts';

// The access rules on the live catalog (security review S1, S2): openStore refuses a database that breaks one, and
// db-migrate ends refusing on one. The words come first, with no server; then a database of its own on the test server,
// made as db-bootstrap and db-migrate make the real one, broken one way at a time as wa_owner.

describe('accessProblems', () => {
  it('finds nothing wrong in a catalog as db-migrate leaves it', () => {
    expect(accessProblems(healthyCatalog())).toEqual([]);
  });

  it('names each broken rule in plain words', () => {
    const rows = healthyCatalog()
      .filter((r) => r.name !== 'kv')
      .map((r): CatalogRow => {
        if (r.name === 'spend') return { ...r, forced: false };
        if (r.name === 'tasks') return { ...r, rls: false, forced: false };
        if (r.name === 'media') return { ...r, owner: 'postgres' };
        if (r.name === 'outbox') return { ...r, policies: 2 }; // a second policy, which would widen the first
        if (r.name === 'reports') return { ...r, tenant_policies: 0 };
        if (r.name === 'invites') return { ...r, app: true };
        if (r.name === 'messages_id_seq') return { ...r, app: true };
        return r;
      })
      .concat([{ name: 'notes', kind: 'r', rls: false, forced: false, owner: 'wa_owner', app: true, policies: 0, tenant_policies: 0 }])
      .concat([{ name: 'locked', kind: 'r', rls: true, forced: true, owner: 'wa_owner', app: true, policies: 0, tenant_policies: 0 }])
      .concat([{ name: 'closed', kind: 'r', rls: false, forced: false, owner: 'wa_owner', app: false, policies: 0, tenant_policies: 0 }]);
    expect(accessProblems(rows)).toEqual([
      'table tasks has row security off',
      'table spend has row security not forced',
      'table kv is missing',
      'table media is owned by postgres, not wa_owner',
      'table reports does not have exactly its one customer policy',
      'table outbox does not have exactly its one customer policy',
      'wa_app can reach platform table invites',
      'wa_app can read sequence messages_id_seq',
      'table notes has no row security and wa_app can reach it',
    ]);
  });

  it('the refusals: one sentence each, with the problems and what to do', () => {
    expect(accessRefused(['a', 'b'])).toBe(
      "This database's access rules are not as db-migrate sets them: a; b. The agent did not start, and nothing was changed: contact the developer.",
    );
    expect(accessRefusedAfterMigrate(['a'])).toBe(
      "db-migrate applied its migrations, but this database's access rules are not as it sets them: a. Do not start the agent: contact the developer.",
    );
  });
});

describe.runIf(onPg)('the access rules on a real Postgres', () => {
  let pg: FreshPg;
  let owner: AdminConnection;
  const env = () => parseEnv({ DB_ENGINE: 'postgres', DATABASE_URL: pg.urls.appUrl, DATABASE_PLATFORM_URL: pg.urls.platformUrl });
  /** openStore as the agent opens it; closed again when it opens. */
  const opens = async (): Promise<void> => {
    const db = await openStore(env());
    await db.close();
  };

  beforeAll(async () => {
    pg = await freshPg(); // bootstrap's grants, then db-migrate's own code: which runs the check at its end
    owner = await openAdminConnection(pg.urls.ownerUrl);
  }, 120_000);
  afterAll(async () => {
    await owner?.end();
    await pg?.drop();
  });

  it('a database made by db-bootstrap and db-migrate passes, as wa_app reads it and as wa_owner reads it', async () => {
    await opens();
    expect(accessProblems((await owner.sql(ACCESS_SQL)).rows as unknown as CatalogRow[])).toEqual([]);
    const lines: string[] = [];
    expect(await migrate(owner, { now: () => new Date().toISOString(), out: (l) => lines.push(l) })).toEqual([]);
    expect(lines).toEqual(['Already at P5: nothing to apply', 'Access rules checked: row security on every customer table, nothing of the platform open to wa_app']);
  });

  it.each([
    ['row security no longer forced', 'ALTER TABLE spend NO FORCE ROW LEVEL SECURITY', 'ALTER TABLE spend FORCE ROW LEVEL SECURITY', 'table spend has row security not forced'],
    ['row security off', 'ALTER TABLE messages DISABLE ROW LEVEL SECURITY', 'ALTER TABLE messages ENABLE ROW LEVEL SECURITY', 'table messages has row security off'],
    ['a grant on a platform table', 'GRANT SELECT ON invites TO wa_app', 'REVOKE ALL ON invites FROM wa_app', 'wa_app can reach platform table invites'],
    ['a new table without row security (the default privileges give it to wa_app)', 'CREATE TABLE notes (id bigint)', 'DROP TABLE notes', 'table notes has no row security and wa_app can reach it'],
    ['a second policy that opens a customer table', 'CREATE POLICY kv_open ON kv USING (true)', 'DROP POLICY kv_open ON kv', 'table kv does not have exactly its one customer policy'],
    ['SELECT on a sequence again', 'GRANT SELECT ON SEQUENCE spend_id_seq TO wa_app', 'REVOKE SELECT ON SEQUENCE spend_id_seq FROM wa_app', 'wa_app can read sequence spend_id_seq'],
  ])('refuses %s: openStore names it, db-migrate ends naming it; put back, it opens', async (_, breakSql, fixSql, problem) => {
    await owner.sql(breakSql);
    try {
      await expect(opens()).rejects.toThrow(accessRefused([problem]));
      await expect(migrate(owner, { now: () => new Date().toISOString(), out: () => {} })).rejects.toThrow(accessRefusedAfterMigrate([problem]));
    } finally {
      await owner.sql(fixSql);
    }
    await opens();
  });

  it('P5: wa_app inserts with an identity id, but cannot read a sequence or run a function wa_owner makes later', async () => {
    const pool = openPgPool(pg.urls.appUrl, { max: 1 });
    const db = new PgTenantDb(pool, FOUNDER_TENANT_ID);
    try {
      await db.run("INSERT INTO spend (day, kind, usd, detail, at) VALUES ('2026-10-31', 'ai', 0.01, 'access test', '2026-10-31T10:00:00.000Z')");
      expect(await db.get<{ n: number }>("SELECT COUNT(*)::int AS n FROM spend WHERE detail = 'access test'")).toEqual({ n: 1 });
      await expect(db.get('SELECT last_value FROM spend_id_seq')).rejects.toThrow(/permission denied/);
      await owner.sql("CREATE FUNCTION later_fn() RETURNS integer LANGUAGE sql AS 'SELECT 1'");
      try {
        await expect(db.get('SELECT later_fn() AS v')).rejects.toThrow(/permission denied/);
      } finally {
        await owner.sql('DROP FUNCTION later_fn()');
      }
    } finally {
      await db.run("DELETE FROM spend WHERE detail = 'access test'").catch(() => undefined);
      await db.close();
    }
  });

  it('a pooled connection carries no customer after its transaction: it reads nothing, and fails rather than reading all', async () => {
    const pool = openPgPool(pg.urls.appUrl, { max: 1 });
    const db = new PgTenantDb(pool, FOUNDER_TENANT_ID, { ownsPool: false });
    try {
      expect(await db.get<{ t: string }>("SELECT current_setting('app.tenant_id', true) AS t")).toEqual({ t: FOUNDER_TENANT_ID });
      // The same (only) connection, outside withTenant: the setting ended with the transaction.
      const c = await pool.connect();
      try {
        const r = await c.query("SELECT coalesce(current_setting('app.tenant_id', true), '') AS t");
        expect(r.rows[0]).toEqual({ t: '' });
        await expect(c.query(`SELECT COUNT(*) FROM ${CUSTOMER_TABLES[0]}`)).rejects.toThrow(/uuid/);
      } finally {
        c.release();
      }
    } finally {
      await pool.end();
    }
  });
});
