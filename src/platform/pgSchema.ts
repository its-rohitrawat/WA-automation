// The platform tables on Postgres (migration P3, plan 2026-10-29-saas-s3-s6.md task A3): the same shape as
// src/platform/schema.ts creates on SQLite, plus each customer's wrapped data key (tenant_keys). They are owned by
// wa_owner and are not customer tables, so they have no RLS. wa_app has no grant on any of them; the wa_platform role
// (owner decision D1, 30 Oct) gets rows-only grants, which lane A adds at the end of P3 (task A4), together with moving
// web_sessions here.
//
// S2's P1 creates tenants with S2_TENANT_COLUMNS and seeds customer #1; P3 brings it to the S5 shape.

export const PLATFORM_TABLES = ['tenants', 'users', 'memberships', 'invites', 'platform_audit', 'tenant_keys', 'web_sessions'] as const;

/** The tenants columns S2's P1 already has. */
export const S2_TENANT_COLUMNS = ['id', 'name', 'status', 'created_at'] as const;

export const PLATFORM_PG_SQL = `
ALTER TABLE tenants
  ADD COLUMN kind text NOT NULL DEFAULT 'customer' CHECK (kind IN ('founder', 'customer')),
  ADD COLUMN updated_at text,
  ADD COLUMN signed_up_at text,
  ADD COLUMN last_activity_at text,
  ADD CONSTRAINT tenants_name_len CHECK (length(name) BETWEEN 1 AND 80);
UPDATE tenants SET kind = 'founder', updated_at = created_at WHERE id = '00000000-0000-4000-8000-000000000001';
UPDATE tenants SET updated_at = created_at WHERE updated_at IS NULL;
ALTER TABLE tenants ALTER COLUMN updated_at SET NOT NULL;
CREATE UNIQUE INDEX tenants_one_founder ON tenants (kind) WHERE kind = 'founder';

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  name text CHECK (name IS NULL OR length(name) BETWEEN 1 AND 100),
  created_at text NOT NULL,
  last_sign_in_at text
);
CREATE TABLE memberships (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  user_id uuid NOT NULL REFERENCES users (id),
  role text NOT NULL CHECK (role IN ('owner', 'member')),
  created_at text NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX memberships_user ON memberships (user_id);
CREATE TABLE invites (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  email text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  token_hash text NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  status text NOT NULL CHECK (status IN ('open', 'accepted', 'cancelled')),
  send_state text NOT NULL DEFAULT 'none' CHECK (send_state IN ('none', 'sending', 'sent', 'failed', 'unknown')),
  send_code text CHECK (send_code IS NULL OR length(send_code) BETWEEN 1 AND 60),
  created_by text NOT NULL,
  created_at text NOT NULL,
  expires_at text NOT NULL,
  sent_at text,
  used_at text,
  used_by uuid REFERENCES users (id),
  cancelled_at text
);
CREATE INDEX invites_tenant ON invites (tenant_id, created_at);
CREATE INDEX invites_email ON invites (email, status);
CREATE TABLE platform_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at text NOT NULL,
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 254),
  event text NOT NULL CHECK (length(event) BETWEEN 1 AND 60),
  tenant_id uuid,
  detail text NOT NULL DEFAULT '' CHECK (length(detail) <= 300),
  request_id text
);
CREATE INDEX platform_audit_at ON platform_audit (at);
CREATE INDEX platform_audit_actor ON platform_audit (actor, event, at);
CREATE TABLE tenant_keys (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id),
  wrapped bytea NOT NULL,
  created_at text NOT NULL
);
`;
