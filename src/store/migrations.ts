export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE clients (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  group_id TEXT NOT NULL UNIQUE,
  phases TEXT NOT NULL,
  current_phase TEXT,
  phase_locked INTEGER NOT NULL DEFAULT 0,
  status_text TEXT,
  status_updated_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  next_task_seq INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  wa_id TEXT NOT NULL,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  sender_jid TEXT NOT NULL,
  sender_number TEXT,
  sender_name TEXT,
  from_me INTEGER NOT NULL DEFAULT 0,
  ts TEXT NOT NULL,
  text TEXT,
  quoted_wa_id TEXT,
  media_type TEXT,
  edited_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  processed_at TEXT,
  UNIQUE (client_id, wa_id)
);
CREATE INDEX messages_unprocessed ON messages (client_id, processed_at, ts);
CREATE TABLE message_edits (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id),
  previous_text TEXT,
  edited_at TEXT NOT NULL
);
CREATE TABLE reactions (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  target_wa_id TEXT NOT NULL,
  reactor_jid TEXT NOT NULL,
  emoji TEXT NOT NULL,
  ts TEXT NOT NULL,
  UNIQUE (client_id, target_wa_id, reactor_jid)
);
CREATE TABLE people (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  jid TEXT NOT NULL,
  number TEXT,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'unknown' CHECK (role IN ('team', 'client', 'unknown')),
  role_set_by TEXT NOT NULL DEFAULT 'ai' CHECK (role_set_by IN ('ai', 'human', 'system')),
  UNIQUE (client_id, jid)
);
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  side TEXT NOT NULL CHECK (side IN ('us', 'client')),
  title TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('design', 'development', 'content', 'payment', 'approval', 'other')),
  priority TEXT NOT NULL CHECK (priority IN ('high', 'medium', 'low')),
  assigned_to TEXT,
  asked_by TEXT,
  raised_on TEXT NOT NULL,
  deadline TEXT,
  latest_progress TEXT,
  reminder_count INTEGER NOT NULL DEFAULT 0,
  last_reminder_on TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'maybe_done', 'done')),
  source_quote TEXT,
  source_date TEXT,
  source_wa_id TEXT,
  source_revoked INTEGER NOT NULL DEFAULT 0,
  closed_on TEXT,
  origin TEXT NOT NULL DEFAULT 'whatsapp',
  locked_fields TEXT NOT NULL DEFAULT '[]',
  status_locked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE task_events (
  id INTEGER PRIMARY KEY,
  task_id INTEGER REFERENCES tasks(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  actor TEXT NOT NULL CHECK (actor IN ('ai', 'human')),
  op TEXT NOT NULL,
  detail TEXT NOT NULL,
  reason TEXT,
  source_ids TEXT NOT NULL DEFAULT '[]',
  at TEXT NOT NULL
);
CREATE INDEX tasks_client_status ON tasks (client_id, status);
CREATE INDEX task_events_client_at ON task_events (client_id, at);
CREATE TABLE decisions (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  text TEXT NOT NULL,
  decided_on TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('whatsapp', 'meeting', 'human')),
  source_wa_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE batches (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'failed')),
  error_code TEXT,
  message_count INTEGER NOT NULL,
  accepted INTEGER,
  rejected INTEGER
);
CREATE TABLE spend (
  id INTEGER PRIMARY KEY,
  day TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ai', 'stt')),
  usd REAL NOT NULL,
  detail TEXT,
  at TEXT NOT NULL
);
CREATE INDEX spend_day ON spend (day);
CREATE TABLE kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    sql: "ALTER TABLE messages ADD COLUMN requeue_reason TEXT CHECK (requeue_reason IN ('edit', 'reaction'));",
  },
  {
    // version counts edits and significant reactions, so a run can tell that a message changed during its AI call.
    version: 3,
    sql: `
ALTER TABLE messages ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN touch_reason TEXT CHECK (touch_reason IN ('edit', 'reaction'));
`,
  },
  {
    // Phase 2a: one row per shared file. ref_enc holds the sealed download details only until the download ends.
    // forwarded: forwarded media is never sent to Claude for a paid description.
    version: 4,
    sql: `
CREATE TABLE media (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'document', 'sticker', 'voice', 'audio')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed', 'unavailable', 'metadata')),
  mime_type TEXT,
  file_name TEXT,
  file_size INTEGER,
  seconds INTEGER,
  forwarded INTEGER NOT NULL DEFAULT 0,
  page_count INTEGER,
  ref_enc BLOB,
  local_path TEXT,
  sha256 TEXT,
  text_kind TEXT CHECK (text_kind IN ('description', 'extract')),
  text TEXT,
  note TEXT,
  error_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  drive_file_id TEXT,
  drive_failed INTEGER NOT NULL DEFAULT 0,
  drive_attempts INTEGER NOT NULL DEFAULT 0,
  drive_next_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX media_due ON media (status, next_attempt_at);
CREATE INDEX media_client ON media (client_id);
`,
  },
  {
    // Amendment 12h: 1 while a message is queued again because its file was read after the message was processed.
    version: 5,
    sql: 'ALTER TABLE media ADD COLUMN requeued_for_text INTEGER NOT NULL DEFAULT 0;',
  },
  {
    // Phase 2c: one row per IST date for the morning report. The row is claimed ('sending') before anything is sent.
    version: 6,
    sql: `
CREATE TABLE reports (
  date TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'retry', 'unknown', 'skipped')),
  detail TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  forced INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
];
