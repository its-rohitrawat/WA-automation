import { randomUUID } from 'node:crypto';
import type { Sql } from '../store/engine/types.ts';

// The platform tables' queries (schema.ts), in the async Db style: every call takes a Sql, so it runs on the database or
// inside a caller's transaction. Parameterised only. In S2 these become the SECURITY DEFINER functions' bodies.

export type TenantStatus = 'invited' | 'onboarding' | 'active' | 'paused';

export interface TenantRow {
  id: string;
  kind: 'founder' | 'customer';
  name: string;
  status: TenantStatus;
  createdAt: string;
  updatedAt: string;
  signedUpAt: string | null;
  lastActivityAt: string | null;
}

interface RawTenant {
  id: string;
  kind: 'founder' | 'customer';
  name: string;
  status: TenantStatus;
  created_at: string;
  updated_at: string;
  signed_up_at: string | null;
  last_activity_at: string | null;
}

const toTenant = (r: RawTenant): TenantRow => ({
  id: r.id, kind: r.kind, name: r.name, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at, signedUpAt: r.signed_up_at,
  lastActivityAt: r.last_activity_at,
});

export async function createTenant(q: Sql, o: { name: string; kind?: 'founder' | 'customer'; status: TenantStatus; at: string }): Promise<TenantRow> {
  const id = randomUUID();
  await q.run('INSERT INTO tenants (id, kind, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [id, o.kind ?? 'customer', o.name, o.status, o.at, o.at]);
  return (await getTenant(q, id))!;
}

export async function getTenant(q: Sql, id: string): Promise<TenantRow | undefined> {
  const r = await q.get<RawTenant>('SELECT * FROM tenants WHERE id = ?', [id]);
  return r ? toTenant(r) : undefined;
}

export async function listTenants(q: Sql): Promise<TenantRow[]> {
  return (await q.all<RawTenant>("SELECT * FROM tenants ORDER BY kind = 'founder' DESC, created_at, id")).map(toTenant);
}

/** Moves a tenant from one status to another; false when it was not in `from` (someone else changed it). */
export async function setTenantStatus(q: Sql, id: string, from: readonly TenantStatus[], to: TenantStatus, at: string): Promise<boolean> {
  const marks = from.map(() => '?').join(', ');
  const r = await q.run(`UPDATE tenants SET status = ?, updated_at = ? WHERE id = ? AND status IN (${marks})`, [to, at, id, ...from]);
  return r.changes === 1;
}

/** The founder's own business: customer #1, all of today's data. Made once, then found again. */
export async function ensureFounderTenant(q: Sql, o: { name: string; at: string }): Promise<TenantRow> {
  const r = await q.get<RawTenant>("SELECT * FROM tenants WHERE kind = 'founder'");
  if (r) return toTenant(r);
  return createTenant(q, { name: o.name, kind: 'founder', status: 'active', at: o.at });
}

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
}

/** The user with this (lower-cased) email, made when missing; the name and sign-in time are kept current. */
export async function upsertUser(q: Sql, o: { email: string; name: string | null; at: string }): Promise<UserRow> {
  const found = await q.get<UserRow>('SELECT id, email, name FROM users WHERE email = ?', [o.email]);
  if (found) {
    await q.run('UPDATE users SET name = COALESCE(?, name), last_sign_in_at = ? WHERE id = ?', [o.name, o.at, found.id]);
    return { ...found, name: o.name ?? found.name };
  }
  const id = randomUUID();
  await q.run('INSERT INTO users (id, email, name, created_at, last_sign_in_at) VALUES (?, ?, ?, ?, ?)', [id, o.email, o.name, o.at, o.at]);
  return { id, email: o.email, name: o.name };
}

export async function addMembership(q: Sql, o: { tenantId: string; userId: string; role: 'owner' | 'member'; at: string }): Promise<void> {
  await q.run('INSERT INTO memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (tenant_id, user_id) DO NOTHING', [
    o.tenantId, o.userId, o.role, o.at,
  ]);
}

/** The tenants a verified email belongs to, with the role there (design 4.2: "find the memberships for a verified email"). */
export async function membershipsFor(q: Sql, email: string): Promise<{ tenantId: string; role: 'owner' | 'member'; status: TenantStatus }[]> {
  return q.all('SELECT m.tenant_id AS tenantId, m.role, t.status FROM memberships m JOIN users u ON u.id = m.user_id JOIN tenants t ON t.id = m.tenant_id WHERE u.email = ? ORDER BY m.created_at', [email]);
}

/** One platform audit line. `detail` is plain words: never a token, a full email of someone refused, or customer content. */
export async function platformAudit(q: Sql, e: { at: string; actor: string; event: string; tenantId?: string | null; detail?: string; requestId?: string | null }): Promise<void> {
  await q.run('INSERT INTO platform_audit (at, actor, event, tenant_id, detail, request_id) VALUES (?, ?, ?, ?, ?, ?)', [
    e.at, e.actor.slice(0, 254), e.event, e.tenantId ?? null, (e.detail ?? '').slice(0, 300), e.requestId ?? null,
  ]);
}

/** How many of these events this actor caused after `since` (the daily invite limit: the last 24 hours). */
export async function auditCount(q: Sql, o: { actor: string; events: readonly string[]; since: string }): Promise<number> {
  const marks = o.events.map(() => '?').join(', ');
  const r = await q.get<{ n: number }>(`SELECT COUNT(*) AS n FROM platform_audit WHERE actor = ? AND event IN (${marks}) AND at > ?`, [o.actor, ...o.events, o.since]);
  return r?.n ?? 0;
}
