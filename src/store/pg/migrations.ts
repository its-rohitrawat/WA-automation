import { PLATFORM_PG_SQL } from '../../platform/pgSchema.ts';
import { FOUNDER_TENANT_ID } from '../../platform/store.ts';

// The Postgres schema (SaaS S2, plan 2026-10-29-saas-s1-s2.md sections 4.3, 4.4 and 4.9): P1 the customer tables as
// the merged result of the SQLite migrations, P2 row-level security on every one of them, P3 the platform tables (lane
// C's SQL, src/platform/pgSchema.ts) with web_sessions and the role grants. Pure strings: no Postgres is needed to
// read or test them (tests/store/pg/migrations.test.ts checks them against the SQLite schema). The SQLite migrations
// (src/store/migrations.ts) are never edited for this.
//
// Every customer table:
//  - starts with tenant_id, whose default is the transaction's customer (withTenant sets app.tenant_id), so no INSERT
//    names it; outside withTenant, current_setting('app.tenant_id') raises and the INSERT fails loudly;
//  - keys its unique values per customer: UNIQUE (tenant_id, …), PRIMARY KEY (tenant_id, …);
//  - points at a parent through (tenant_id, parent_id), so a row can never point at another customer's parent
//    (foreign-key checks bypass RLS); every table with an id has UNIQUE (tenant_id, id) for that.
// Types: ids bigint (identity, GENERATED ALWAYS: the copy tool keeps ids with OVERRIDING SYSTEM VALUE); 0/1 flags
// smallint with a CHECK, so `= 1` and `=== 1` stay as they are; counts integer (file sizes bigint); REAL double
// precision; BLOB bytea; times stay ISO 8601 text, so string order is time order.

export { FOUNDER_TENANT_ID };

/** The customer tables, in an order where every parent comes before its children. P2 is generated from this list. */
export const CUSTOMER_TABLES = [
  'clients', 'messages', 'message_edits', 'reactions', 'people', 'meetings', 'tasks', 'task_events', 'decisions',
  'batches', 'spend', 'kv', 'media', 'media_stt_forget', 'reports', 'stt_forget', 'audit_log', 'settings', 'uptime_log',
  'outbox', 'wa_auth',
] as const;
export type CustomerTable = (typeof CUSTOMER_TABLES)[number];

const TENANT = `tenant_id uuid NOT NULL DEFAULT current_setting('app.tenant_id')::uuid REFERENCES tenants (id)`;
const ID = 'id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY';
const flag = (name: string, dflt?: 0 | 1) => `${name} smallint NOT NULL${dflt === undefined ? '' : ` DEFAULT ${dflt}`} CHECK (${name} IN (0, 1))`;

export const P1_SQL = `
CREATE TABLE tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('invited', 'onboarding', 'active', 'paused', 'removed')),
  created_at text NOT NULL
);
INSERT INTO tenants (id, name, status, created_at)
  VALUES ('${FOUNDER_TENANT_ID}', 'Founder', 'active', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));

CREATE TABLE clients (
  ${TENANT},
  ${ID},
  code text NOT NULL,
  name text NOT NULL,
  group_id text NOT NULL,
  phases text NOT NULL,
  current_phase text,
  ${flag('phase_locked', 0)},
  status_text text,
  status_updated_at text,
  ${flag('active', 1)},
  next_task_seq integer NOT NULL DEFAULT 1,
  sentiment text CHECK (sentiment IS NULL OR sentiment IN ('positive', 'neutral', 'negative', 'frustrated')),
  sentiment_at text,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, group_id)
);

CREATE TABLE messages (
  ${TENANT},
  ${ID},
  wa_id text NOT NULL,
  client_id bigint NOT NULL,
  sender_jid text NOT NULL,
  sender_number text,
  sender_name text,
  ${flag('from_me', 0)},
  ts text NOT NULL,
  text text,
  quoted_wa_id text,
  media_type text,
  edited_at text,
  ${flag('revoked', 0)},
  processed_at text,
  requeue_reason text CHECK (requeue_reason IN ('edit', 'reaction')),
  version integer NOT NULL DEFAULT 0,
  touch_reason text CHECK (touch_reason IN ('edit', 'reaction')),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, client_id, wa_id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id)
);
CREATE INDEX messages_unprocessed ON messages (tenant_id, client_id, processed_at, ts);

CREATE TABLE message_edits (
  ${TENANT},
  ${ID},
  message_id bigint NOT NULL,
  previous_text text,
  edited_at text NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, message_id) REFERENCES messages (tenant_id, id)
);

CREATE TABLE reactions (
  ${TENANT},
  ${ID},
  client_id bigint NOT NULL,
  target_wa_id text NOT NULL,
  reactor_jid text NOT NULL,
  emoji text NOT NULL,
  ts text NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, client_id, target_wa_id, reactor_jid),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id)
);

CREATE TABLE people (
  ${TENANT},
  ${ID},
  client_id bigint NOT NULL,
  jid text NOT NULL,
  number text,
  name text,
  role text NOT NULL DEFAULT 'unknown' CHECK (role IN ('team', 'client', 'unknown')),
  role_set_by text NOT NULL DEFAULT 'ai' CHECK (role_set_by IN ('ai', 'human', 'system')),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, client_id, jid),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id)
);

CREATE TABLE meetings (
  ${TENANT},
  ${ID},
  recording text NOT NULL,
  conference text NOT NULL,
  drive_file_id text NOT NULL,
  meeting_code text,
  title text NOT NULL DEFAULT '',
  started_at text NOT NULL,
  ended_at text,
  attendees text NOT NULL DEFAULT '[]',
  participants text NOT NULL DEFAULT '[]',
  client_id bigint,
  match_kind text CHECK (match_kind IN ('title', 'domain', 'human')),
  status text NOT NULL CHECK (status IN ('unassigned', 'internal', 'queued', 'done', 'skipped', 'too_long', 'no_access', 'failed')),
  stage text NOT NULL DEFAULT 'found' CHECK (stage IN ('found', 'audio', 'transcribed', 'summarised', 'doc', 'tracked')),
  drive_seconds double precision,
  audio_path text,
  audio_seconds double precision,
  stt_parts text NOT NULL DEFAULT '[]',
  transcript text,
  summary text,
  doc_file_id text,
  note text,
  error_code text,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CHECK (status <> 'internal' OR (title = '' AND attendees = '[]' AND participants = '[]')),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, recording),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id)
);
CREATE INDEX meetings_client ON meetings (tenant_id, client_id, status, started_at);
CREATE INDEX meetings_conference ON meetings (tenant_id, conference);
CREATE INDEX meetings_due ON meetings (tenant_id, status, next_attempt_at);

CREATE TABLE tasks (
  ${TENANT},
  ${ID},
  code text NOT NULL,
  client_id bigint NOT NULL,
  side text NOT NULL CHECK (side IN ('us', 'client')),
  title text NOT NULL,
  category text NOT NULL CHECK (category IN ('design', 'development', 'content', 'payment', 'approval', 'other')),
  priority text NOT NULL CHECK (priority IN ('high', 'medium', 'low')),
  assigned_to text,
  asked_by text,
  raised_on text NOT NULL,
  deadline text,
  latest_progress text,
  reminder_count integer NOT NULL DEFAULT 0,
  last_reminder_on text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'maybe_done', 'done')),
  source_quote text,
  source_date text,
  source_wa_id text,
  ${flag('source_revoked', 0)},
  closed_on text,
  origin text NOT NULL DEFAULT 'whatsapp',
  locked_fields text NOT NULL DEFAULT '[]',
  status_locked_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  meeting_id bigint,
  priority_level text CHECK (priority_level IS NULL OR priority_level IN ('critical', 'major', 'medium', 'low')),
  priority_source text CHECK (priority_source IS NULL OR priority_source IN ('keyword', 'ai', 'human')),
  priority_keyword text CHECK (priority_keyword IS NULL OR length(priority_keyword) BETWEEN 1 AND 200),
  sentiment text CHECK (sentiment IS NULL OR sentiment IN ('positive', 'neutral', 'negative', 'frustrated')),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id),
  FOREIGN KEY (tenant_id, meeting_id) REFERENCES meetings (tenant_id, id)
);
CREATE INDEX tasks_client_status ON tasks (tenant_id, client_id, status);
CREATE INDEX tasks_meeting ON tasks (tenant_id, meeting_id);

CREATE TABLE task_events (
  ${TENANT},
  ${ID},
  task_id bigint,
  client_id bigint NOT NULL,
  actor text NOT NULL CHECK (actor IN ('ai', 'human')),
  op text NOT NULL,
  detail text NOT NULL,
  reason text,
  source_ids text NOT NULL DEFAULT '[]',
  at text NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks (tenant_id, id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id)
);
CREATE INDEX task_events_client_at ON task_events (tenant_id, client_id, at);
CREATE INDEX task_events_task ON task_events (tenant_id, task_id, at, id);

CREATE TABLE decisions (
  ${TENANT},
  ${ID},
  client_id bigint NOT NULL,
  text text NOT NULL,
  decided_on text NOT NULL,
  source text NOT NULL CHECK (source IN ('whatsapp', 'meeting', 'human')),
  source_wa_id text,
  created_at text NOT NULL,
  meeting_id bigint,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id),
  FOREIGN KEY (tenant_id, meeting_id) REFERENCES meetings (tenant_id, id)
);
CREATE INDEX decisions_meeting ON decisions (tenant_id, meeting_id);

CREATE TABLE batches (
  ${TENANT},
  ${ID},
  client_id bigint NOT NULL,
  started_at text NOT NULL,
  finished_at text,
  status text NOT NULL CHECK (status IN ('running', 'ok', 'failed')),
  error_code text,
  message_count integer NOT NULL,
  accepted integer,
  rejected integer,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id)
);

CREATE TABLE spend (
  ${TENANT},
  ${ID},
  day text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ai', 'stt')),
  usd double precision NOT NULL,
  detail text,
  at text NOT NULL,
  UNIQUE (tenant_id, id)
);
CREATE INDEX spend_day ON spend (tenant_id, day);

CREATE TABLE kv (
  ${TENANT},
  k text NOT NULL,
  v text NOT NULL,
  PRIMARY KEY (tenant_id, k)
);

CREATE TABLE media (
  ${TENANT},
  ${ID},
  message_id bigint NOT NULL,
  client_id bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('image', 'video', 'document', 'sticker', 'voice', 'audio')),
  status text NOT NULL CHECK (status IN ('pending', 'done', 'failed', 'unavailable', 'metadata')),
  mime_type text,
  file_name text,
  file_size bigint,
  seconds integer,
  ${flag('forwarded', 0)},
  page_count integer,
  ref_enc bytea,
  local_path text,
  sha256 text,
  text_kind text CHECK (text_kind IN ('description', 'extract')),
  text text,
  note text,
  error_code text,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at text,
  drive_file_id text,
  ${flag('drive_failed', 0)},
  drive_attempts integer NOT NULL DEFAULT 0,
  drive_next_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  ${flag('requeued_for_text', 0)},
  ${flag('backlog', 0)},
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, message_id),
  FOREIGN KEY (tenant_id, message_id) REFERENCES messages (tenant_id, id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id)
);
CREATE INDEX media_client ON media (tenant_id, client_id);
CREATE INDEX media_due ON media (tenant_id, status, next_attempt_at);

CREATE TABLE media_stt_forget (
  ${TENANT},
  ${ID},
  media_id bigint NOT NULL,
  provider text NOT NULL CHECK (provider IN ('sarvam', 'elevenlabs', 'openai')),
  ref text NOT NULL CHECK (length(ref) BETWEEN 1 AND 200),
  created_at text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_try_at text,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, provider, ref),
  FOREIGN KEY (tenant_id, media_id) REFERENCES media (tenant_id, id)
);

CREATE TABLE reports (
  ${TENANT},
  date text NOT NULL,
  status text NOT NULL CHECK (status IN ('sending', 'sent', 'retry', 'unknown', 'skipped')),
  detail text,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at text,
  ${flag('forced', 0)},
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (tenant_id, date)
);

CREATE TABLE stt_forget (
  ${TENANT},
  ${ID},
  meeting_id bigint NOT NULL,
  provider text NOT NULL CHECK (provider IN ('sarvam', 'elevenlabs', 'openai')),
  ref text NOT NULL CHECK (length(ref) BETWEEN 1 AND 200),
  created_at text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_try_at text,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, provider, ref),
  FOREIGN KEY (tenant_id, meeting_id) REFERENCES meetings (tenant_id, id)
);

CREATE TABLE audit_log (
  ${TENANT},
  ${ID},
  at text NOT NULL,
  actor text NOT NULL,
  event text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('auth', 'config', 'connection', 'task', 'meeting', 'ops')),
  detail text NOT NULL,
  request_id text,
  UNIQUE (tenant_id, id)
);
CREATE INDEX audit_log_at ON audit_log (tenant_id, at);

CREATE TABLE settings (
  ${TENANT},
  k text NOT NULL,
  v text NOT NULL,
  updated_at text NOT NULL,
  updated_by text NOT NULL,
  PRIMARY KEY (tenant_id, k)
);

CREATE TABLE uptime_log (
  ${TENANT},
  ${ID},
  at text NOT NULL,
  ${flag('up')},
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 100),
  UNIQUE (tenant_id, id)
);
CREATE INDEX uptime_log_at ON uptime_log (tenant_id, at);

CREATE TABLE outbox (
  ${TENANT},
  ${ID},
  uuid text NOT NULL CHECK (length(uuid) = 36),
  client_id bigint NOT NULL,
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 4096),
  reply_to bigint,
  state text NOT NULL CHECK (state IN ('claimed', 'sending', 'sent', 'failed', 'unknown')),
  wa_id text,
  error_code text CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 60),
  actor text NOT NULL,
  created_at text NOT NULL,
  attempted_at text,
  finished_at text,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, uuid),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id),
  FOREIGN KEY (tenant_id, reply_to) REFERENCES messages (tenant_id, id)
);
CREATE INDEX outbox_client ON outbox (tenant_id, client_id, created_at);
CREATE INDEX outbox_created ON outbox (tenant_id, created_at);

-- The WhatsApp sessions (data/session.db and data/sender-session.db on SQLite), still sealed by the app. slot (A2):
-- 'backup' holds the copy a dashboard link takes before it resets the session (auth_backup on SQLite).
CREATE TABLE wa_auth (
  ${TENANT},
  phone text NOT NULL CHECK (phone IN ('founder', 'spare')),
  slot text NOT NULL DEFAULT 'live' CHECK (slot IN ('live', 'backup')),
  k text NOT NULL,
  v bytea NOT NULL,
  PRIMARY KEY (tenant_id, phone, slot, k)
);
`;

/** P2: row-level security, enabled and forced, one policy per customer table; the platform tables are revoked. */
export function rlsSql(tables: readonly string[] = CUSTOMER_TABLES): string {
  const per = tables.map((t) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${t}_tenant ON ${t}
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);`);
  return `\n${per.join('\n')}\nREVOKE ALL ON tenants, pg_schema_version FROM wa_app;\n`;
}

export const P2_SQL = rlsSql();

/**
 * The dashboard sessions, a platform table (A4): a session must be found before its customer is known. tenant_id is
 * the customer it acts for; while only the founder signs in to the dashboard (S2), it defaults to the founder (plan
 * 4.9; customer sessions are Postgres-only, S4.8).
 */
export const WEB_SESSIONS_PG_SQL = `
CREATE TABLE web_sessions (
  id_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL DEFAULT '${FOUNDER_TENANT_ID}' REFERENCES tenants (id),
  email text NOT NULL,
  csrf_hash text NOT NULL,
  created_at text NOT NULL,
  expires_at text NOT NULL,
  last_seen_at text NOT NULL,
  agent_label text
);
`;

/**
 * The end of P3 (A4, D1). The default privileges (S2.3) grant wa_app every new table and sequence, the platform ones
 * too: they are taken back here, and S2.9 checks has_table_privilege and has_sequence_privilege rather than trusting
 * this. wa_platform gets rows only on the platform tables; wa_backup (the nightly dump) SELECT on everything.
 */
export const P3_GRANTS_SQL = `
REVOKE ALL ON tenants, users, memberships, invites, platform_audit, tenant_keys, web_sessions FROM wa_app;
REVOKE ALL ON SEQUENCE platform_audit_id_seq FROM wa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, users, memberships, invites, platform_audit, tenant_keys, web_sessions TO wa_platform;
GRANT USAGE, SELECT ON SEQUENCE platform_audit_id_seq TO wa_platform;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO wa_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO wa_backup;
`;

export const P3_SQL = `${PLATFORM_PG_SQL}${WEB_SESSIONS_PG_SQL}${P3_GRANTS_SQL}`;

/** In order; recorded in pg_schema_version by the runner (S2.4). Never edited once applied: a change is a new entry. */
export const PG_MIGRATIONS: readonly { version: number; sql: string }[] = [
  { version: 1, sql: P1_SQL },
  { version: 2, sql: P2_SQL },
  { version: 3, sql: P3_SQL },
];
