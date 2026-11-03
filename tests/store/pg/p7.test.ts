import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openAdminConnection, openPgPool, PgTenantDb, type AdminConnection } from '../../../src/store/engine/pg.ts';
import { databaseGrants, migrate } from '../../../src/store/pg/admin.ts';
import { FOUNDER_TENANT_ID, PG_MIGRATIONS } from '../../../src/store/pg/migrations.ts';
import { onPg, testPg } from '../../helpers/pg.ts';

// db-migrate's paths to P7 (November release, lane C, change 7: reading phones 2 to 5) on a real Postgres, each in a
// database of its own made as db-bootstrap makes the real one: an empty database straight to P7, and a P5 database
// holding data, sessions included, through P6 to P7 in one run (the office Mac's path at go-live). Both end with the
// live access-rules check passing. Every value here is a placeholder.

const CHECKED = 'Access rules checked: row security on every customer table, nothing of the platform open to wa_app';
const NAME = /^wa_test_p7_[0-9a-f]{12}$/;

const on = (url: string, database: string) => {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.href;
};

/** A new, empty database with bootstrap's grants; its drop() ends any connection left over. */
async function emptyDatabase(): Promise<{ owner: () => Promise<AdminConnection>; appUrl: string; drop: () => Promise<void> }> {
  const t = testPg()!;
  const server = process.env.TEST_PG_SERVER_URL;
  if (!server) throw new Error('needs TEST_PG_SERVER_URL (set by npm run test:pg)');
  const name = `wa_test_p7_${randomBytes(6).toString('hex')}`;
  const s = await openAdminConnection(on(server, 'postgres'));
  try {
    await s.sql(`CREATE DATABASE ${name} OWNER wa_owner ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`);
  } finally {
    await s.end();
  }
  const inDb = await openAdminConnection(on(server, name));
  try {
    for (const sql of databaseGrants(name)) await inDb.sql(sql);
  } finally {
    await inDb.end();
  }
  return {
    owner: () => openAdminConnection(on(t.ownerUrl, name)),
    appUrl: on(t.appUrl, name),
    drop: async () => {
      if (!NAME.test(name)) throw new Error('not a P7 test database');
      const d = await openAdminConnection(on(server, 'postgres'));
      try {
        await d.sql(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await d.end();
      }
    },
  };
}

const now = () => new Date().toISOString();

/** wa_auth's check constraints that name the phone column: exactly P7's after it. */
async function phoneChecks(owner: AdminConnection): Promise<{ name: string; def: string }[]> {
  return (await owner.sql(
    "SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'wa_auth'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%phone%' ORDER BY conname",
  )).rows as { name: string; def: string }[];
}

/** As the agent (wa_app, the founder's rows): phones 2 to 5 can hold a session; phone6 and anything else cannot. */
async function sessionsAsTheAgent(appUrl: string): Promise<void> {
  const pool = openPgPool(appUrl, { max: 1 });
  const app = new PgTenantDb(pool, FOUNDER_TENANT_ID);
  try {
    for (const phone of ['phone2', 'phone3', 'phone4', 'phone5']) {
      await app.run("INSERT INTO wa_auth (phone, slot, k, v) VALUES (?, 'live', 'creds', ?)", [phone, Buffer.from('sealed placeholder')]);
    }
    for (const bad of ['phone6', 'phone1', 'Phone2']) {
      await expect(app.run("INSERT INTO wa_auth (phone, slot, k, v) VALUES (?, 'live', 'creds', ?)", [bad, Buffer.from('x')]), bad).rejects.toThrow(/wa_auth_phone_check/);
    }
  } finally {
    await app.close();
  }
}

describe.runIf(onPg)('db-migrate to P7 (reading phones 2 to 5) on a real Postgres', () => {
  it('an empty database: P1 to P7, one phone check (P7’s), the access check passes, and phones 2 to 5 hold sessions', async () => {
    const db = await emptyDatabase();
    try {
      const owner = await db.owner();
      try {
        const lines: string[] = [];
        expect(await migrate(owner, { now, out: (l) => lines.push(l) })).toEqual([1, 2, 3, 4, 5, 6, 7]);
        expect(lines).toEqual(['Applied P1', 'Applied P2', 'Applied P3', 'Applied P4', 'Applied P5', 'Applied P6', 'Applied P7', CHECKED]);
        const checks = await phoneChecks(owner);
        expect(checks.map((c) => c.name)).toEqual(['wa_auth_phone_check']);
        expect(checks[0]!.def).toMatch(/phone2.*phone3.*phone4.*phone5/);
      } finally {
        await owner.end();
      }
      await sessionsAsTheAgent(db.appUrl);
    } finally {
      await db.drop();
    }
  }, 60_000);

  it('a P5 database with data and sessions (the office Mac): P6 and P7 in one run, every row and session kept', async () => {
    const db = await emptyDatabase();
    try {
      const owner = await db.owner();
      let before: unknown[];
      try {
        await migrate(owner, { now, out: () => {}, migrations: PG_MIGRATIONS.slice(0, 5) });
        // Data shaped like the office Mac's: a client and its messages, and the founder's and spare's sessions (live and
        // a link's backup), all the founder's.
        await owner.sql('BEGIN');
        await owner.sql("SELECT set_config('app.tenant_id', $1, true)", [FOUNDER_TENANT_ID]);
        const client = (await owner.sql("INSERT INTO clients (code, name, group_id, phases) VALUES ('SHA', 'Sharma', '120363000000000001@g.us', '[]') RETURNING id")).rows[0]!.id;
        for (const n of [1, 2, 3]) {
          await owner.sql('INSERT INTO messages (wa_id, client_id, sender_jid, ts, text) VALUES ($1, $2, $3, $4, $5)', [`M${n}`, client, '919800000000@s.whatsapp.net', `2026-11-01T0${n}:00:00.000Z`, `message ${n}`]);
        }
        for (const [phone, slot, k] of [['founder', 'live', 'creds'], ['founder', 'live', 'canary'], ['founder', 'backup', 'creds'], ['spare', 'live', 'creds']]) {
          await owner.sql('INSERT INTO wa_auth (phone, slot, k, v) VALUES ($1, $2, $3, $4)', [phone, slot, k, Buffer.from(`${phone}-${slot}-${k}`)]);
        }
        before = (await owner.sql('SELECT phone, slot, k, v FROM wa_auth ORDER BY phone, slot, k')).rows;
        await owner.sql('COMMIT');
        expect(before).toHaveLength(4);

        const lines: string[] = [];
        expect(await migrate(owner, { now, out: (l) => lines.push(l) })).toEqual([6, 7]);
        expect(lines).toEqual(['Applied P6', 'Applied P7', CHECKED]);
        expect((await phoneChecks(owner)).map((c) => c.name)).toEqual(['wa_auth_phone_check']);
        // Run again: nothing to apply, and the check still passes.
        const again: string[] = [];
        expect(await migrate(owner, { now, out: (l) => again.push(l) })).toEqual([]);
        expect(again).toEqual(['Already at P7: nothing to apply', CHECKED]);
      } finally {
        await owner.end();
      }
      const pool = openPgPool(db.appUrl, { max: 1 });
      const app = new PgTenantDb(pool, FOUNDER_TENANT_ID);
      try {
        // As the agent: every row and session exactly as before; phone 1 (founder) needs no relink.
        expect(await app.all('SELECT wa_id, text FROM messages ORDER BY wa_id')).toEqual([1, 2, 3].map((n) => ({ wa_id: `M${n}`, text: `message ${n}` })));
        expect(await app.all('SELECT phone, slot, k, v FROM wa_auth ORDER BY phone, slot, k')).toEqual(before!);
      } finally {
        await app.close();
      }
      await sessionsAsTheAgent(db.appUrl);
    } finally {
      await db.drop();
    }
  }, 60_000);
});
