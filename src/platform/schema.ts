import type { Sql } from '../store/engine/types.ts';

// The platform tables (SaaS design section 4.2): customers (tenants), their users, who belongs where (memberships),
// invites, and the platform's own audit log. Not per customer, so not in store/migrations.ts: until S2 they are created
// here, idempotently, by ensurePlatformSchema; in S2 they become the Postgres platform schema, reached by wa_app only
// through SECURITY DEFINER functions (see docs/superpowers/plans/2026-10-29-saas-invites-hookups.md).
//
// Ids are uuids as text. Emails are stored lower-cased (checked). Only an invite token's SHA-256 is stored, never the
// token. Times are ISO strings (UTC).

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY CHECK (length(id) = 36),
    kind TEXT NOT NULL DEFAULT 'customer' CHECK (kind IN ('founder', 'customer')),
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    status TEXT NOT NULL CHECK (status IN ('invited', 'onboarding', 'active', 'paused')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    signed_up_at TEXT,
    last_activity_at TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS tenants_one_founder ON tenants (kind) WHERE kind = 'founder'`,
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY CHECK (length(id) = 36),
    email TEXT NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
    name TEXT CHECK (name IS NULL OR length(name) BETWEEN 1 AND 100),
    created_at TEXT NOT NULL,
    last_sign_in_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS memberships (
    tenant_id TEXT NOT NULL REFERENCES tenants (id),
    user_id TEXT NOT NULL REFERENCES users (id),
    role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS memberships_user ON memberships (user_id)`,
  `CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY CHECK (length(id) = 36),
    tenant_id TEXT NOT NULL REFERENCES tenants (id),
    email TEXT NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
    token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
    status TEXT NOT NULL CHECK (status IN ('open', 'accepted', 'cancelled')),
    send_state TEXT NOT NULL DEFAULT 'none' CHECK (send_state IN ('none', 'sending', 'sent', 'failed', 'unknown')),
    send_code TEXT CHECK (send_code IS NULL OR length(send_code) BETWEEN 1 AND 60),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    sent_at TEXT,
    used_at TEXT,
    used_by TEXT REFERENCES users (id),
    cancelled_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS invites_tenant ON invites (tenant_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS invites_email ON invites (email, status)`,
  `CREATE TABLE IF NOT EXISTS platform_audit (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 254),
    event TEXT NOT NULL CHECK (length(event) BETWEEN 1 AND 60),
    tenant_id TEXT,
    detail TEXT NOT NULL DEFAULT '' CHECK (length(detail) <= 300),
    request_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS platform_audit_at ON platform_audit (at)`,
  `CREATE INDEX IF NOT EXISTS platform_audit_actor ON platform_audit (actor, event, at)`,
  // Each customer's data key, wrapped by the master key (S4.1, src/platform/tenantKeys.ts). None for the founder.
  `CREATE TABLE IF NOT EXISTS tenant_keys (
    tenant_id TEXT PRIMARY KEY REFERENCES tenants (id),
    wrapped BLOB NOT NULL,
    created_at TEXT NOT NULL
  )`,
];

/** Creates the platform tables when they are missing. Safe to run at every start; changes nothing that exists. */
export async function ensurePlatformSchema(db: Sql): Promise<void> {
  await db.tx(async (q) => {
    for (const s of STATEMENTS) await q.exec(s);
  });
}
