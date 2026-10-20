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
];
