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
  // Version 6 is Phase 2c's reports table: it reaches this branch from main, and goes before this one.
  {
    // Phase 3: one row per Google Meet recording. JSON columns: attendees [{email, name, team}], participants [name],
    // stt_parts SttPart[], transcript Segment[], summary MeetingSummary. Internal meetings keep no title, attendees or names
    // (the CHECK makes sure of it).
    // A claim counts an attempt and moves next_attempt_at ahead, as media's does. stt_forget: the provider copies of
    // speech answers still to delete.
    version: 7,
    sql: `
CREATE TABLE meetings (
  id INTEGER PRIMARY KEY,
  recording TEXT NOT NULL UNIQUE,
  conference TEXT NOT NULL,
  drive_file_id TEXT NOT NULL,
  meeting_code TEXT,
  title TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  attendees TEXT NOT NULL DEFAULT '[]',
  participants TEXT NOT NULL DEFAULT '[]',
  client_id INTEGER REFERENCES clients(id),
  match_kind TEXT CHECK (match_kind IN ('title', 'domain', 'human')),
  status TEXT NOT NULL CHECK (status IN ('unassigned', 'internal', 'queued', 'done', 'skipped', 'too_long', 'no_access', 'failed')),
  stage TEXT NOT NULL DEFAULT 'found' CHECK (stage IN ('found', 'audio', 'transcribed', 'summarised', 'doc', 'tracked')),
  drive_seconds REAL,
  audio_path TEXT, audio_seconds REAL,
  stt_parts TEXT NOT NULL DEFAULT '[]',
  transcript TEXT,
  summary TEXT,
  doc_file_id TEXT,
  note TEXT,
  error_code TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK (status <> 'internal' OR (title = '' AND attendees = '[]' AND participants = '[]'))
);
CREATE INDEX meetings_due ON meetings(status, next_attempt_at);
CREATE INDEX meetings_conference ON meetings(conference);
CREATE INDEX meetings_client ON meetings(client_id, status, started_at);
ALTER TABLE tasks ADD COLUMN meeting_id INTEGER REFERENCES meetings(id);
ALTER TABLE decisions ADD COLUMN meeting_id INTEGER REFERENCES meetings(id);
CREATE INDEX tasks_meeting ON tasks(meeting_id);
CREATE INDEX decisions_meeting ON decisions(meeting_id);
-- Provider copies of speech answers still to delete (M7): the provider's own id for the copy only, never what was said.
-- A row is removed only once the provider has deleted its copy; attempts caps the retries, next_try_at spaces them.
CREATE TABLE stt_forget (
  id INTEGER PRIMARY KEY,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id),
  provider TEXT NOT NULL CHECK (provider IN ('sarvam', 'elevenlabs', 'openai')),
  ref TEXT NOT NULL CHECK (length(ref) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_try_at TEXT,
  UNIQUE (provider, ref)
);
`,
  },
  {
    // Phase 2b: voice notes. backlog: 1 for a 2a voice note queued by `cli transcribe-voice`; its transcript is stored for
    // the record and never queues its message again (V6). media_stt_forget: the speech provider's stored copies of voice
    // transcripts still to delete (N1), as stt_forget does for meetings: the provider's id only, never what was said.
    version: 8,
    sql: `
ALTER TABLE media ADD COLUMN backlog INTEGER NOT NULL DEFAULT 0;
CREATE TABLE media_stt_forget (
  id INTEGER PRIMARY KEY,
  media_id INTEGER NOT NULL REFERENCES media(id),
  provider TEXT NOT NULL CHECK (provider IN ('sarvam', 'elevenlabs', 'openai')),
  ref TEXT NOT NULL CHECK (length(ref) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_try_at TEXT,
  UNIQUE (provider, ref)
);
`,
  },
  {
    // Owner dashboard (D1). web_sessions keeps only SHA-256 hashes of the session id and CSRF token, never the raw values.
    // audit_log: who did what, for the dashboard's Audit screen; never tokens, cookies, QR codes or message text.
    // settings: values the owner changes from the dashboard (JSON in v). uptime_log: up/down transitions, for the vitals
    // strip when UptimeRobot's read-only API is not set. Additive only: no existing table or row is touched.
    version: 9,
    sql: `
CREATE TABLE web_sessions (
  id_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  csrf_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  agent_label TEXT
);
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  event TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('auth', 'config', 'connection', 'task', 'meeting', 'ops')),
  detail TEXT NOT NULL,
  request_id TEXT
);
CREATE INDEX audit_log_at ON audit_log(at);
CREATE TABLE settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE TABLE uptime_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  up INTEGER NOT NULL
);
CREATE INDEX uptime_log_at ON uptime_log(at);
`,
  },
  {
    // Owner dashboard (D4/D5). task_events_task: a task's history is read by task (the Tasks screen's detail).
    // uptime_log.reason: why the agent went down, when it knows (a fixed code such as stopped or whatsapp_logged_out,
    // never free text); rows written before this stay without one. Additive only.
    version: 10,
    sql: `
CREATE INDEX task_events_task ON task_events(task_id, at, id);
ALTER TABLE uptime_log ADD COLUMN reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 100);
`,
  },
];
