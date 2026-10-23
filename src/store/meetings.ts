import { z } from 'zod';
import type { MeetingSummary } from '../brain/meetingSchema.ts';
import type { Segment } from '../stt/types.ts';
import { tx, type Db } from './db.ts';

export const MEETING_STATUSES = ['unassigned', 'internal', 'queued', 'done', 'skipped', 'too_long', 'no_access', 'failed'] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];
/** The last stage finished, in order. A meeting only ever moves forward. */
export const MEETING_STAGES = ['found', 'audio', 'transcribed', 'summarised', 'doc', 'tracked'] as const;
export type MeetingStage = (typeof MEETING_STAGES)[number];
export type MatchKind = 'title' | 'domain' | 'human';

export interface MeetingAttendee {
  email: string;
  name: string | null;
  /** One of our own people, not the client's. */
  team: boolean;
}

/** One speech part's durable bookkeeping (see src/meetings/transcribe.ts). */
export interface SttPartRow {
  index: number;
  offset: number;
  seconds: number;
  state: 'todo' | 'inflight' | 'done' | 'unknown';
  jobId: string | null;
  booked: 'none' | 'ceiling' | 'actual';
  segments: Segment[] | null;
  billedSeconds: number | null;
}

export interface NewMeeting {
  /** conferenceRecords/x/recordings/y: one row per recording. */
  recording: string;
  conference: string;
  driveFileId: string;
  meetingCode: string | null;
  /** Cleaned; '' for internal meetings. */
  title: string;
  startedAt: string;
  endedAt: string | null;
  /** [] for internal meetings. */
  attendees: MeetingAttendee[];
  /** Signed-in display names only; [] for internal meetings. */
  participants: string[];
  clientId: number | null;
  matchKind: MatchKind | null;
  status: MeetingStatus;
  /** Drive's own length, when given. */
  driveSeconds: number | null;
  createdAt: string;
}

export interface MeetingRow {
  id: number;
  recording: string;
  conference: string;
  driveFileId: string;
  meetingCode: string | null;
  title: string;
  startedAt: string;
  endedAt: string | null;
  attendees: MeetingAttendee[];
  participants: string[];
  clientId: number | null;
  matchKind: MatchKind | null;
  status: MeetingStatus;
  stage: MeetingStage;
  driveSeconds: number | null;
  /** Relative to DATA_DIR. */
  audioPath: string | null;
  audioSeconds: number | null;
  sttParts: SttPartRow[];
  transcript: Segment[] | null;
  summary: MeetingSummary | null;
  docFileId: string | null;
  /** For example no_speech, client_inactive, transcript_cut. */
  note: string | null;
  errorCode: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RawMeeting {
  id: number;
  recording: string;
  conference: string;
  drive_file_id: string;
  meeting_code: string | null;
  title: string;
  started_at: string;
  ended_at: string | null;
  attendees: string;
  participants: string;
  client_id: number | null;
  match_kind: MatchKind | null;
  status: MeetingStatus;
  stage: MeetingStage;
  drive_seconds: number | null;
  audio_path: string | null;
  audio_seconds: number | null;
  stt_parts: string;
  transcript: string | null;
  summary: string | null;
  doc_file_id: string | null;
  note: string | null;
  error_code: string | null;
  attempts: number;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

const SegmentSchema = z.object({ start: z.number(), end: z.number(), speaker: z.string().nullable(), text: z.string() });
const AttendeesSchema = z.array(z.object({ email: z.string(), name: z.string().nullable(), team: z.boolean() }));
const ParticipantsSchema = z.array(z.string());
const SttPartsSchema = z.array(
  z.object({
    index: z.number().int(),
    offset: z.number(),
    seconds: z.number(),
    state: z.enum(['todo', 'inflight', 'done', 'unknown']),
    jobId: z.string().nullable(),
    booked: z.enum(['none', 'ceiling', 'actual']),
    segments: z.array(SegmentSchema).nullable(),
    billedSeconds: z.number().nullable(),
  }),
);
const TranscriptSchema = z.array(SegmentSchema);
const SummarySchema: z.ZodType<MeetingSummary> = z.object({
  whatHappened: z.string(),
  discussion: z.array(z.object({ topic: z.string(), summary: z.string() })),
  decisions: z.array(z.object({ text: z.string(), segmentIds: z.array(z.string()) })),
  actionItems: z.array(
    z.object({
      side: z.enum(['us', 'client']),
      task: z.string(),
      owner: z.string().nullable(),
      deadline: z.string().nullable(),
      segmentIds: z.array(z.string()),
    }),
  ),
  openQuestions: z.array(z.string()),
  conclusion: z.string(),
  speakers: z.array(z.object({ label: z.string(), name: z.string().nullable() })),
});

/**
 * A stored JSON value that cannot be read. The message names the meeting and the column, never the content (it may hold
 * names, emails or what was said).
 */
export class MeetingRowError extends Error {
  readonly meetingId: number;
  readonly column: string;
  constructor(meetingId: number, column: string) {
    super(`meeting ${meetingId}: the ${column} column holds a value that cannot be read`);
    this.name = 'MeetingRowError';
    this.meetingId = meetingId;
    this.column = column;
  }
}

function parseColumn<T>(id: number, column: string, schema: z.ZodType<T>, text: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new MeetingRowError(id, column); // the parser's message quotes the content: never passed on
  }
  const r = schema.safeParse(value);
  if (!r.success) throw new MeetingRowError(id, column);
  return r.data;
}

const parseNullable = <T>(id: number, column: string, schema: z.ZodType<T>, text: string | null): T | null =>
  text === null ? null : parseColumn(id, column, schema, text);

/** JSON for a column, checked against the schema it is read back with, so a row written here can always be read. */
function toJson<T>(what: string, column: string, schema: z.ZodType<T>, value: T): string {
  const r = schema.safeParse(value);
  if (!r.success) throw new Error(`${what}: the ${column} value does not have the stored shape`);
  return JSON.stringify(r.data);
}

const COLUMNS = `id, recording, conference, drive_file_id, meeting_code, title, started_at, ended_at, attendees, participants, client_id, match_kind,
  status, stage, drive_seconds, audio_path, audio_seconds, stt_parts, transcript, summary, doc_file_id, note, error_code, attempts, next_attempt_at,
  created_at, updated_at`;

function toRow(r: RawMeeting): MeetingRow {
  return {
    id: r.id,
    recording: r.recording,
    conference: r.conference,
    driveFileId: r.drive_file_id,
    meetingCode: r.meeting_code,
    title: r.title,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    attendees: parseColumn(r.id, 'attendees', AttendeesSchema, r.attendees),
    participants: parseColumn(r.id, 'participants', ParticipantsSchema, r.participants),
    clientId: r.client_id,
    matchKind: r.match_kind,
    status: r.status,
    stage: r.stage,
    driveSeconds: r.drive_seconds,
    audioPath: r.audio_path,
    audioSeconds: r.audio_seconds,
    sttParts: parseColumn(r.id, 'stt_parts', SttPartsSchema, r.stt_parts),
    transcript: parseNullable(r.id, 'transcript', TranscriptSchema, r.transcript),
    summary: parseNullable(r.id, 'summary', SummarySchema, r.summary),
    docFileId: r.doc_file_id,
    note: r.note,
    errorCode: r.error_code,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Records a recording found in Meet. Returns the new row's id, or null when the recording is already known (nothing changes). */
export function insertFound(db: Db, m: NewMeeting): number | null {
  const r = db
    .prepare(`INSERT INTO meetings (recording, conference, drive_file_id, meeting_code, title, started_at, ended_at, attendees, participants, client_id,
        match_kind, status, drive_seconds, created_at, updated_at)
      VALUES (@recording, @conference, @driveFileId, @meetingCode, @title, @startedAt, @endedAt, @attendees, @participants, @clientId,
        @matchKind, @status, @driveSeconds, @createdAt, @createdAt)
      ON CONFLICT (recording) DO NOTHING`)
    .run({
      ...m,
      attendees: toJson('insertFound', 'attendees', AttendeesSchema, m.attendees),
      participants: toJson('insertFound', 'participants', ParticipantsSchema, m.participants),
    });
  return r.changes === 0 ? null : Number(r.lastInsertRowid);
}

export function knownRecordings(db: Db, conference: string): Set<string> {
  const rows = db.prepare('SELECT recording FROM meetings WHERE conference = ?').all(conference) as { recording: string }[];
  return new Set(rows.map((r) => r.recording));
}

/** Throws a MeetingRowError when one of the row's JSON columns cannot be read. */
export function getMeeting(db: Db, id: number): MeetingRow | undefined {
  const r = db.prepare(`SELECT ${COLUMNS} FROM meetings WHERE id = ?`).get(id) as RawMeeting | undefined;
  return r ? toRow(r) : undefined;
}

/** Queued meetings whose next attempt is due, oldest meeting first. */
export function dueMeetingIds(db: Db, nowIso: string, limit: number): number[] {
  return (
    db
      .prepare(`SELECT id FROM meetings WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY started_at, id LIMIT ?`)
      .all(nowIso, limit) as { id: number }[]
  ).map((r) => r.id);
}

/**
 * Claims a queued meeting that is due (at `at`) before a stage runs: in one committed write the next attempt moves to
 * nextAttemptAt, so a run that never ends (the process stopped) leaves the meeting waiting until then, and a second
 * claim fails. No attempt is counted here: deferrals don't count (see deferMeeting). The error code is kept.
 * Returns false when the meeting is not queued or not due.
 */
export function claimMeeting(db: Db, id: number, c: { nextAttemptAt: string; at: string }): boolean {
  return (
    db.prepare(`UPDATE meetings SET next_attempt_at = @nextAttemptAt, updated_at = @at
      WHERE id = @id AND status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= @at)`).run({ id, ...c }).changes === 1
  );
}

export interface StageFields {
  audioPath: string;
  audioSeconds: number;
  transcript: Segment[];
  summary: MeetingSummary;
  docFileId: string;
  note: string;
  title: string;
  attendees: MeetingAttendee[];
  participants: string[];
}

/**
 * A stage is finished: stores its results and moves the stage forward. Fields not given keep their stored values. The
 * retry state (error code, attempts, next attempt) is cleared. A move to the same or an earlier stage throws.
 */
export function advanceStage(db: Db, id: number, stage: MeetingStage, fields: Partial<StageFields>, at: string): void {
  const f = fields;
  const params = {
    id,
    stage,
    at,
    audioPath: f.audioPath ?? null,
    audioSeconds: f.audioSeconds ?? null,
    transcript: f.transcript === undefined ? null : toJson('advanceStage', 'transcript', TranscriptSchema, f.transcript),
    summary: f.summary === undefined ? null : toJson('advanceStage', 'summary', SummarySchema, f.summary),
    docFileId: f.docFileId ?? null,
    note: f.note ?? null,
    title: f.title ?? null,
    attendees: f.attendees === undefined ? null : toJson('advanceStage', 'attendees', AttendeesSchema, f.attendees),
    participants: f.participants === undefined ? null : toJson('advanceStage', 'participants', ParticipantsSchema, f.participants),
  };
  tx(db, () => {
    const cur = (db.prepare('SELECT stage FROM meetings WHERE id = ?').get(id) as { stage: MeetingStage } | undefined)?.stage;
    if (cur === undefined) throw new Error(`advanceStage: no meeting ${id}`);
    if (MEETING_STAGES.indexOf(stage) <= MEETING_STAGES.indexOf(cur)) throw new Error(`advanceStage: meeting ${id} cannot move from ${cur} to ${stage}`);
    db.prepare(`UPDATE meetings SET stage = @stage, audio_path = COALESCE(@audioPath, audio_path), audio_seconds = COALESCE(@audioSeconds, audio_seconds),
        transcript = COALESCE(@transcript, transcript), summary = COALESCE(@summary, summary), doc_file_id = COALESCE(@docFileId, doc_file_id),
        note = COALESCE(@note, note), title = COALESCE(@title, title), attendees = COALESCE(@attendees, attendees),
        participants = COALESCE(@participants, participants), error_code = NULL, attempts = 0, next_attempt_at = NULL, updated_at = @at
      WHERE id = @id`).run(params);
  });
}

/** Stores the speech parts' bookkeeping as it is now (written before and after every part's call). */
export function setSttParts(db: Db, id: number, parts: SttPartRow[], at: string): void {
  db.prepare('UPDATE meetings SET stt_parts = ?, updated_at = ? WHERE id = ?').run(toJson('setSttParts', 'stt_parts', SttPartsSchema, parts), at, id);
}

/** Try again later. countAttempt is true only for a retried error; deferrals (spend cap, busy, settings) don't count. */
export function deferMeeting(db: Db, id: number, d: { errorCode: string; nextAttemptAt: string; at: string; countAttempt?: boolean }): void {
  db.prepare(`UPDATE meetings SET error_code = @errorCode, next_attempt_at = @nextAttemptAt, attempts = attempts + @inc, updated_at = @at WHERE id = @id`).run({
    id,
    errorCode: d.errorCode,
    nextAttemptAt: d.nextAttemptAt,
    inc: d.countAttempt ? 1 : 0,
    at: d.at,
  });
}

/** A final failure. The stage is kept, so `meeting retry` starts again after the last finished stage. */
export function failMeeting(db: Db, id: number, f: { status: 'failed' | 'no_access' | 'too_long'; errorCode: string; at: string }): void {
  db.prepare('UPDATE meetings SET status = @status, error_code = @errorCode, next_attempt_at = NULL, updated_at = @at WHERE id = @id').run({ id, ...f });
}

/** The meeting is in the tracker: done. A note, when given, replaces the stored one. */
export function finishMeeting(db: Db, id: number, f: { note?: string; at: string }): void {
  db.prepare(`UPDATE meetings SET status = 'done', stage = 'tracked', note = COALESCE(@note, note), error_code = NULL, next_attempt_at = NULL,
    updated_at = @at WHERE id = @id`).run({ id, note: f.note ?? null, at: f.at });
}

/** A person assigns an unassigned or internal meeting to a client; it is queued. Returns false for any other status. */
export function assignMeeting(db: Db, id: number, clientId: number, at: string): boolean {
  return (
    db.prepare(`UPDATE meetings SET status = 'queued', client_id = @clientId, match_kind = 'human', error_code = NULL, next_attempt_at = NULL, updated_at = @at
      WHERE id = @id AND status IN ('unassigned', 'internal')`).run({ id, clientId, at }).changes === 1
  );
}

/** A person decides an unassigned meeting is not processed. Returns false for any other status. */
export function skipMeeting(db: Db, id: number, at: string): boolean {
  return db.prepare("UPDATE meetings SET status = 'skipped', updated_at = ? WHERE id = ? AND status = 'unassigned'").run(at, id).changes === 1;
}

/** `meeting retry`: a failed or no-access meeting is queued again at its last finished stage, with fresh attempts. */
export function retryMeeting(db: Db, id: number, at: string): boolean {
  return (
    db.prepare(`UPDATE meetings SET status = 'queued', attempts = 0, next_attempt_at = NULL, error_code = NULL, updated_at = ?
      WHERE id = ? AND status IN ('failed', 'no_access')`).run(at, id).changes === 1
  );
}

/** Deliberately without title, attendees or names: the workbook shows unassigned meetings to everyone who opens it. */
export interface UnassignedMeeting {
  id: number;
  startedAt: string;
  /** The audio's length once known, else Drive's. */
  seconds: number | null;
}

/** Unassigned meetings, newest first. Internal meetings are never listed. */
export function listUnassigned(db: Db, limit: number): UnassignedMeeting[] {
  return db
    .prepare(`SELECT id, started_at AS startedAt, COALESCE(audio_seconds, drive_seconds) AS seconds FROM meetings WHERE status = 'unassigned'
      ORDER BY started_at DESC, id DESC LIMIT ?`)
    .all(limit) as UnassignedMeeting[];
}

export interface ClientMeeting {
  id: number;
  startedAt: string;
  title: string;
  seconds: number | null;
  docFileId: string | null;
  actionItemCount: number;
}

/** A client's done meetings, newest first. A meeting whose stored summary cannot be read is left out. */
export function listClientMeetings(db: Db, clientId: number, limit: number): ClientMeeting[] {
  const rows = db
    .prepare(`SELECT id, started_at AS startedAt, title, COALESCE(audio_seconds, drive_seconds) AS seconds, doc_file_id AS docFileId, summary
      FROM meetings WHERE client_id = ? AND status = 'done' ORDER BY started_at DESC, id DESC LIMIT ?`)
    .all(clientId, limit) as (Omit<ClientMeeting, 'actionItemCount'> & { summary: string | null })[];
  const out: ClientMeeting[] = [];
  for (const { summary, ...r } of rows) {
    let actionItemCount: number;
    try {
      actionItemCount = parseNullable(r.id, 'summary', SummarySchema, summary)?.actionItems.length ?? 0;
    } catch (e) {
      if (e instanceof MeetingRowError) continue;
      throw e;
    }
    out.push({ ...r, actionItemCount });
  }
  return out;
}

/** Each client's latest done meeting: client id → its start. */
export function lastMeetingByClient(db: Db): Map<number, string> {
  const rows = db
    .prepare(`SELECT client_id AS clientId, MAX(started_at) AS startedAt FROM meetings WHERE status = 'done' AND client_id IS NOT NULL GROUP BY client_id`)
    .all() as { clientId: number; startedAt: string }[];
  return new Map(rows.map((r) => [r.clientId, r.startedAt]));
}

export interface MeetingStats {
  done: number;
  /** Queued: matched to a client and waiting to be processed. */
  waiting: number;
  unassigned: number;
  failed: number;
  noAccess: number;
  tooLong: number;
  internal: number;
  /** Queued meetings still waiting out a deferral at `now`, by error code. */
  deferred: Record<string, number>;
}

/** Counts for Health and `cli status`. */
export function meetingStats(db: Db, now: Date): MeetingStats {
  const counts = db
    .prepare(`SELECT
        COALESCE(SUM(status = 'done'), 0) AS done,
        COALESCE(SUM(status = 'queued'), 0) AS waiting,
        COALESCE(SUM(status = 'unassigned'), 0) AS unassigned,
        COALESCE(SUM(status = 'failed'), 0) AS failed,
        COALESCE(SUM(status = 'no_access'), 0) AS noAccess,
        COALESCE(SUM(status = 'too_long'), 0) AS tooLong,
        COALESCE(SUM(status = 'internal'), 0) AS internal
      FROM meetings`)
    .get() as Omit<MeetingStats, 'deferred'>;
  const deferred = db
    .prepare(`SELECT error_code AS code, COUNT(*) AS n FROM meetings
      WHERE status = 'queued' AND error_code IS NOT NULL AND next_attempt_at > ? GROUP BY error_code ORDER BY error_code`)
    .all(now.toISOString()) as { code: string; n: number }[];
  return { ...counts, deferred: Object.fromEntries(deferred.map((d) => [d.code, d.n])) };
}
