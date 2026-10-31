import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/store/db.ts';
import { manualClock } from '../../src/util/clock.ts';
import { AuditLog } from '../../src/web/audit.ts';
import { auditedWrite } from '../../src/web/routes/auth.ts';
import { SessionStore } from '../../src/web/sessions.ts';
import { onSqlite, seededDb } from '../helpers/db.ts';
import { openTestPlatformDb } from '../helpers/pg.ts';

// Sign-in and sign-out's audit row and session (plan A4, decision D1). On Postgres the audit row is on the customer Db and
// the session on the platform Db: the audit row goes first. On SQLite two in-memory stores stand in for the two pools;
// on Postgres they are the customer's own Db and the shared platform Db, so this file's sessions have an email of its own.

const clock = manualClock('2026-10-30T10:00:00.000Z');
const EMAIL = onSqlite ? 'owner@example.com' : `owner-${randomUUID().slice(0, 8)}@example.com`;
const signedIn = { actor: EMAIL, event: 'Signed in', kind: 'auth' as const, detail: 'Edge on Windows' };
const count = async (db: Db, table: string) => (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;

describe('auditedWrite', () => {
  // SQLite only: one Db for both is SQLite's layout; on Postgres the session is always on the platform Db.
  it.runIf(onSqlite)('one Db (SQLite): the audit row and the session in one transaction; either failing leaves neither', async () => {
    const db = await seededDb();
    const audited = auditedWrite(db, db);
    const order: string[] = [];
    const s = await audited(
      async (q) => {
        order.push('audit');
        await new AuditLog(db, clock).record(signedIn, q);
      },
      async (q) => {
        order.push('session');
        return new SessionStore(db, clock).create(EMAIL, 'Edge on Windows', q);
      },
    );
    expect(order).toEqual(['audit', 'session']);
    expect(await new SessionStore(db, clock).get(s.id)).toBeDefined();

    const before = [await count(db, 'audit_log'), await count(db, 'web_sessions')];
    await expect(audited((q) => new AuditLog(db, clock).record(signedIn, q), async () => { throw new Error('session down'); })).rejects.toThrow('session down');
    expect([await count(db, 'audit_log'), await count(db, 'web_sessions')]).toEqual(before);
    await db.close();
  });

  it('two Dbs (Postgres): the audit row is committed first; a failed session write keeps it, a failed audit write runs no session', async () => {
    const customer = await seededDb();
    const platform = onSqlite ? await seededDb() : openTestPlatformDb();
    if (!onSqlite) await platform.run('DELETE FROM web_sessions WHERE email = ?', [EMAIL]); // an earlier run's, on the shared Db
    const sessionsOf = async () => (await platform.get<{ n: number }>('SELECT COUNT(*) AS n FROM web_sessions WHERE email = ?', [EMAIL]))!.n;
    const audited = auditedWrite(customer, platform);
    const sessions = new SessionStore(platform, clock);
    const audit = new AuditLog(customer, clock);

    const order: string[] = [];
    const s = await audited(
      async (q) => {
        order.push('audit');
        await audit.record(signedIn, q);
      },
      async (q) => {
        order.push(`session, audit rows already committed: ${await count(customer, 'audit_log')}`);
        return sessions.create(EMAIL, 'Edge on Windows', q);
      },
    );
    expect(order).toEqual(['audit', 'session, audit rows already committed: 1']);
    expect(await sessions.get(s.id)).toBeDefined();
    if (onSqlite) {
      expect(await count(customer, 'web_sessions')).toBe(0); // the session went to the platform Db only
      expect(await count(platform, 'audit_log')).toBe(0); // and the audit row to the customer Db only
    } else {
      // On Postgres neither role can even read the other's table.
      await expect(count(customer, 'web_sessions')).rejects.toThrow(/permission denied/);
      await expect(count(platform, 'audit_log')).rejects.toThrow(/permission denied/);
    }

    await expect(audited((q) => audit.record(signedIn, q), async () => { throw new Error('session down'); })).rejects.toThrow('session down');
    expect(await count(customer, 'audit_log')).toBe(2); // the safe side: an audit row for a sign-in that did not happen

    let ran = false;
    await expect(audited(async () => { throw new Error('audit down'); }, async () => { ran = true; })).rejects.toThrow('audit down');
    expect(ran).toBe(false);
    expect(await sessionsOf()).toBe(1);
    await customer.close();
    await platform.close();
  });
});
