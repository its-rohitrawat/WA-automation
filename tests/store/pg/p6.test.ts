import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openAdminConnection, openPgPool, PgTenantDb, type AdminConnection } from '../../../src/store/engine/pg.ts';
import { addQuestion, chatMessages, createChat } from '../../../src/store/assistantChats.ts';
import { databaseGrants, migrate } from '../../../src/store/pg/admin.ts';
import { FOUNDER_TENANT_ID, PG_MIGRATIONS } from '../../../src/store/pg/migrations.ts';
import { onPg, testPg } from '../../helpers/pg.ts';

// db-migrate's two paths to P6 (November release, lane A) on a real Postgres, each in a database of its own made as
// db-bootstrap makes the real one: an empty database straight to P6, and a P5 database holding data (the office Mac's
// path) to P6 only. Both end with the live access-rules check passing.

const CHECKED = 'Access rules checked: row security on every customer table, nothing of the platform open to wa_app';
const NAME = /^wa_test_p6_[0-9a-f]{12}$/;

const on = (url: string, database: string) => {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.href;
};

/** A new, empty database with bootstrap's grants; its drop() ends any connection left over. */
async function emptyDatabase(): Promise<{ name: string; owner: () => Promise<AdminConnection>; appUrl: string; drop: () => Promise<void> }> {
  const t = testPg()!;
  const server = process.env.TEST_PG_SERVER_URL;
  if (!server) throw new Error('needs TEST_PG_SERVER_URL (set by npm run test:pg)');
  const name = `wa_test_p6_${randomBytes(6).toString('hex')}`;
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
    name,
    owner: () => openAdminConnection(on(t.ownerUrl, name)),
    appUrl: on(t.appUrl, name),
    drop: async () => {
      if (!NAME.test(name)) throw new Error('not a P6 test database');
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

describe.runIf(onPg)('db-migrate to P6 (the assistant chats) on a real Postgres', () => {
  it('an empty database: P1 to P6, then the access check passes', async () => {
    const db = await emptyDatabase();
    try {
      const owner = await db.owner();
      try {
        const lines: string[] = [];
        expect(await migrate(owner, { now, out: (l) => lines.push(l) })).toEqual([1, 2, 3, 4, 5, 6]);
        expect(lines).toEqual(['Applied P1', 'Applied P2', 'Applied P3', 'Applied P4', 'Applied P5', 'Applied P6', CHECKED]);
      } finally {
        await owner.end();
      }
    } finally {
      await db.drop();
    }
  }, 60_000);

  it('a P5 database with data (the office Mac): P6 only, every row kept, and the chats work as the customer', async () => {
    const db = await emptyDatabase();
    try {
      const owner = await db.owner();
      try {
        await migrate(owner, { now, out: () => {}, migrations: PG_MIGRATIONS.slice(0, 5) });
        // Data shaped like the office Mac's: a client, its messages and its tasks, all the founder's.
        await owner.sql('BEGIN');
        await owner.sql("SELECT set_config('app.tenant_id', $1, true)", [FOUNDER_TENANT_ID]);
        const client = (await owner.sql("INSERT INTO clients (code, name, group_id, phases) VALUES ('SHA', 'Sharma', '120363000000000001@g.us', '[]') RETURNING id")).rows[0]!.id;
        for (const n of [1, 2, 3]) {
          await owner.sql('INSERT INTO messages (wa_id, client_id, sender_jid, ts, text) VALUES ($1, $2, $3, $4, $5)', [`M${n}`, client, '919800000000@s.whatsapp.net', `2026-11-01T0${n}:00:00.000Z`, `message ${n}`]);
          await owner.sql(
            "INSERT INTO tasks (code, client_id, side, title, category, priority, raised_on, created_at, updated_at) VALUES ($1, $2, 'us', $3, 'design', 'medium', '2026-11-01', $4, $4)",
            [`SHA-00${n}`, client, `task ${n}`, '2026-11-01T08:00:00.000Z'],
          );
        }
        await owner.sql('COMMIT');

        const lines: string[] = [];
        expect(await migrate(owner, { now, out: (l) => lines.push(l) })).toEqual([6]);
        expect(lines).toEqual(['Applied P6', CHECKED]);
      } finally {
        await owner.end();
      }
      const pool = openPgPool(db.appUrl, { max: 1 });
      const app = new PgTenantDb(pool, FOUNDER_TENANT_ID);
      try {
        expect(await app.get('SELECT code FROM clients')).toEqual({ code: 'SHA' });
        expect(await app.all('SELECT wa_id, text FROM messages ORDER BY wa_id')).toEqual([1, 2, 3].map((n) => ({ wa_id: `M${n}`, text: `message ${n}` })));
        expect(await app.all('SELECT code, title FROM tasks ORDER BY code')).toEqual([1, 2, 3].map((n) => ({ code: `SHA-00${n}`, title: `task ${n}` })));
        const chat = await createChat(app, { createdBy: 'owner@example.com', title: 'After the migration', at: now() });
        await addQuestion(app, chat.id, 'Still here?', now());
        expect((await chatMessages(app, chat.id)).map((m) => m.body)).toEqual(['Still here?']);
      } finally {
        await app.close();
      }
    } finally {
      await db.drop();
    }
  }, 60_000);
});
