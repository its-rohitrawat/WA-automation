import type { Db } from './db.ts';

export type Role = 'team' | 'client' | 'unknown';
export type RoleSetBy = 'ai' | 'human' | 'system';

export interface PersonRow {
  id: number;
  clientId: number;
  jid: string;
  number: string | null;
  name: string | null;
  role: Role;
  roleSetBy: RoleSetBy;
}

interface RawPerson {
  id: number;
  client_id: number;
  jid: string;
  number: string | null;
  name: string | null;
  role: Role;
  role_set_by: RoleSetBy;
}

const toRow = (r: RawPerson): PersonRow => ({
  id: r.id,
  clientId: r.client_id,
  jid: r.jid,
  number: r.number,
  name: r.name,
  role: r.role,
  roleSetBy: r.role_set_by,
});

/** The founder (fromMe) is always team and cannot be changed by the AI ('system'). */
export function upsertPerson(db: Db, p: { clientId: number; jid: string; number: string | null; name: string | null; fromMe: boolean }): void {
  db.prepare(`INSERT INTO people (client_id, jid, number, name, role, role_set_by) VALUES (@clientId, @jid, @number, @name, @role, @setBy)
    ON CONFLICT (client_id, jid) DO UPDATE SET
      number = COALESCE(excluded.number, people.number),
      name = COALESCE(excluded.name, people.name),
      role = CASE WHEN excluded.role_set_by = 'system' THEN 'team' ELSE people.role END,
      role_set_by = CASE WHEN excluded.role_set_by = 'system' THEN 'system' ELSE people.role_set_by END`).run({
    clientId: p.clientId,
    jid: p.jid,
    number: p.number,
    name: p.name,
    role: p.fromMe ? 'team' : 'unknown',
    setBy: p.fromMe ? 'system' : 'ai',
  });
}

export function listPeople(db: Db, clientId: number): PersonRow[] {
  return (db.prepare('SELECT * FROM people WHERE client_id = ? ORDER BY id').all(clientId) as RawPerson[]).map(toRow);
}

export function setRole(db: Db, clientId: number, jid: string, role: Role, by: RoleSetBy): void {
  db.prepare('UPDATE people SET role = ?, role_set_by = ? WHERE client_id = ? AND jid = ?').run(role, by, clientId, jid);
}

export function findPeopleByNumber(db: Db, number: string): PersonRow[] {
  return (db.prepare('SELECT * FROM people WHERE number = ? ORDER BY client_id').all(number) as RawPerson[]).map(toRow);
}
