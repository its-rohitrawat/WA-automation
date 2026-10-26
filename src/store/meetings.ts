import { z } from 'zod';
import { MeetingSummarySchema, type MeetingSummary } from '../brain/meetingSchema.ts';
import type { ProviderId, Segment } from '../stt/types.ts';
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
  /** The provider the part is planned for, and sent to: a stuck part is booked at this provider's price. */
  provider: ProviderId;
  /** The part's MP3 under data/meetings/tmp/ ("12-parts/part-000.mp3", forward slashes); null: the whole kept MP3. */
  file: string | null;
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
  /** Why it was stored as no_access (for example http_404); missing means none. */
  errorCode?: string | null;
  /**
   * A no_access meeting matched as internal (it then has no title, attendees or names): stored as the note
   * FOUND_INTERNAL_NOTE, so `meeting list` labels it internal. Missing means false.
   */
  foundInternal?: boolean;
  createdAt: string;
}

/** The note of a no_access meeting that was matched as internal (see NewMeeting.foundInternal). */
export const FOUND_INTERNAL_NOTE = 'found_internal';

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

const SegmentSchema = z.strictObject({ start: z.number(), end: z.number(), speaker: z.string().nullable(), text: z.string() });
const AttendeesSchema = z.array(z.strictObject({ email: z.string(), name: z.string().nullable(), team: z.boolean() }));
const ParticipantsSchema = z.array(z.string());
/** <id>-parts/part-NNN.mp3 or <id>-parts-<n>/part-NNN.mp3: nothing else is ever read as a part's file. */
export const PART_FILE = /^[1-9]\d{0,14}-parts(?:-[1-9]\d{0,3})?\/part-\d{3}\.mp3$/;
const SttPartsSchema = z.array(
  z.strictObject({
    index: z.number().int(),
    provider: z.enum(['sarvam', 'elevenlabs', 'openai']),
    file: z.string().regex(PART_FILE).nullable(),
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
    summary: parseNullable(r.id, 'summary', MeetingSummarySchema, r.summary),
    docFileId: r.doc_file_id,
    note: r.note,
    errorCode: r.error_code,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Every time this module takes or stores is an ISO string in the canonical form `new Date(x).toISOString()` gives
 * (YYYY-MM-DDTHH:MM:SS.sssZ), because SQLite compares them as text. insertFound normalises the meeting's own start and
 * end, which come from Google with offsets or other precisions; every other time must already be canonical, or the call
 * throws before writing anything.
 */
function canonical(what: string, name: string, x: string): string {
  const ms = Date.parse(x);
  if (Number.isNaN(ms) || new Date(ms).toISOString() !== x) throw new Error(`${what}: ${name} is not a canonical ISO time`);
  return x;
}

function normalised(what: string, name: string, x: string): string {
  const ms = Date.parse(x);
  if (Number.isNaN(ms)) throw new Error(`${what}: ${name} is not a time`);
  return new Date(ms).toISOString();
}

/**
 * A processor write found the meeting not queued (or not at the stage it needs). Only the processor moves a queued
 * meeting, so this is a bug: processor writes throw, while claims and a person's commands return false.
 */
function notQueued(what: string, id: number, extra = ''): never {
  throw new Error(`${what}: meeting ${id} is not queued${extra}`);
}

/**
 * Records a recording found in Meet. Returns the new row's id, or null when the recording is already known (nothing
 * changes). startedAt and endedAt are stored in canonical form; an unreadable time throws.
 */
export function insertFound(db: Db, m: NewMeeting): number | null {
  const r = db
    .prepare(`INSERT INTO meetings (recording, conference, drive_file_id, meeting_code, title, started_at, ended_at, attendees, participants, client_id,
        match_kind, status, drive_seconds, error_code, note, created_at, updated_at)
      VALUES (@recording, @conference, @driveFileId, @meetingCode, @title, @startedAt, @endedAt, @attendees, @participants, @clientId,
        @matchKind, @status, @driveSeconds, @errorCode, @note, @createdAt, @createdAt)
      ON CONFLICT (recording) DO NOTHING`)
    .run({
      recording: m.recording, conference: m.conference, driveFileId: m.driveFileId, meetingCode: m.meetingCode, title: m.title,
      clientId: m.clientId, matchKind: m.matchKind, status: m.status, driveSeconds: m.driveSeconds,
      errorCode: m.errorCode ?? null,
      note: m.foundInternal === true ? FOUND_INTERNAL_NOTE : null,
      startedAt: normalised('insertFound', 'startedAt', m.startedAt),
      endedAt: m.endedAt === null ? null : normalised('insertFound', 'endedAt', m.endedAt),
      createdAt: canonical('insertFound', 'createdAt', m.createdAt),
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

/** What the processor loop needs to decide on a meeting. Reads no JSON, so it never fails on a bad stored value. */
export interface MeetingState {
  id: number;
  status: MeetingStatus;
  stage: MeetingStage;
  attempts: number;
  errorCode: string | null;
  nextAttemptAt: string | null;
  clientId: number | null;
  /** When the row last changed: with nextAttemptAt, the length of the last deferral (the growing waits read it back). */
  updatedAt: string;
}

export function getMeetingState(db: Db, id: number): MeetingState | undefined {
  return db
    .prepare(`SELECT id, status, stage, attempts, error_code AS errorCode, next_attempt_at AS nextAttemptAt, client_id AS clientId, updated_at AS updatedAt
      FROM meetings WHERE id = ?`)
    .get(id) as MeetingState | undefined;
}

/** Queued meetings whose next attempt is due, oldest meeting first. */
export function dueMeetingIds(db: Db, nowIso: string, limit: number): number[] {
  return (
    db
      .prepare(`SELECT id FROM meetings WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY started_at, id LIMIT ?`)
      .all(canonical('dueMeetingIds', 'nowIso', nowIso), limit) as { id: number }[]
  ).map((r) => r.id);
}

/**
 * Claims a queued meeting that is due (at `at`) before a stage runs, as claimMedia does. In one committed write:
 * - the attempt is counted, so a stage that never ends (the process stops, again and again) runs up the count the
 *   processor fails it at;
 * - the next attempt moves to nextAttemptAt, so a second claim fails and a run that never ends leaves the meeting waiting
 *   until then;
 * - the error code is cleared, so meetingStats never counts a claimed meeting as deferred. The processor reads the
 *   meeting (getMeetingState) before it claims, so its growing waits still see the last code; only a crash right after a
 *   claim loses it.
 * A deferral that should not count passes the pre-claim count back to deferMeeting as `attempts`.
 * Returns false when the meeting is not queued or not due.
 */
export function claimMeeting(db: Db, id: number, c: { nextAttemptAt: string; at: string }): boolean {
  const params = { id, nextAttemptAt: canonical('claimMeeting', 'nextAttemptAt', c.nextAttemptAt), at: canonical('claimMeeting', 'at', c.at) };
  return (
    db.prepare(`UPDATE meetings SET attempts = attempts + 1, next_attempt_at = @nextAttemptAt, error_code = NULL, updated_at = @at
      WHERE id = @id AND status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= @at)`).run(params).changes === 1
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
 * A stage of a queued meeting is finished: stores its results and moves the stage forward (stages may be skipped).
 * Fields not given keep their stored values; no field can be cleared this way (to null, or back to '' or []). The retry
 * state (error code, attempts, next attempt) is cleared. Throws, writing nothing, when the meeting is missing or not
 * queued, or the move is to the same or an earlier stage.
 */
export function advanceStage(db: Db, id: number, stage: MeetingStage, fields: Partial<StageFields>, at: string): void {
  const f = fields;
  const params = {
    id,
    stage,
    at: canonical('advanceStage', 'at', at),
    audioPath: f.audioPath ?? null,
    audioSeconds: f.audioSeconds ?? null,
    transcript: f.transcript === undefined ? null : toJson('advanceStage', 'transcript', TranscriptSchema, f.transcript),
    summary: f.summary === undefined ? null : toJson('advanceStage', 'summary', MeetingSummarySchema, f.summary),
    docFileId: f.docFileId ?? null,
    note: f.note ?? null,
    title: f.title ?? null,
    attendees: f.attendees === undefined ? null : toJson('advanceStage', 'attendees', AttendeesSchema, f.attendees),
    participants: f.participants === undefined ? null : toJson('advanceStage', 'participants', ParticipantsSchema, f.participants),
  };
  tx(db, () => {
    const cur = db.prepare('SELECT status, stage FROM meetings WHERE id = ?').get(id) as { status: MeetingStatus; stage: MeetingStage } | undefined;
    if (cur === undefined) throw new Error(`advanceStage: no meeting ${id}`);
    if (cur.status !== 'queued') notQueued('advanceStage', id);
    if (MEETING_STAGES.indexOf(stage) <= MEETING_STAGES.indexOf(cur.stage)) {
      throw new Error(`advanceStage: meeting ${id} cannot move from ${cur.stage} to ${stage}`);
    }
    db.prepare(`UPDATE meetings SET stage = @stage, audio_path = COALESCE(@audioPath, audio_path), audio_seconds = COALESCE(@audioSeconds, audio_seconds),
        transcript = COALESCE(@transcript, transcript), summary = COALESCE(@summary, summary), doc_file_id = COALESCE(@docFileId, doc_file_id),
        note = COALESCE(@note, note), title = COALESCE(@title, title), attendees = COALESCE(@attendees, attendees),
        participants = COALESCE(@participants, participants), error_code = NULL, attempts = 0, next_attempt_at = NULL, updated_at = @at
      WHERE id = @id`).run(params);
  });
}

/**
 * A queued meeting at stage found gets its invite title, attendees and signed-in names read again (an assigned meeting
 * that was stored without them, such as one first taken for internal, M7). A title of '' and empty lists keep the
 * stored values. The retry state is left as it is. Throws, writing nothing, when the meeting is missing, not queued or
 * past stage found.
 */
export function refreshMeetingFacts(
  db: Db,
  id: number,
  f: { title: string; attendees: MeetingAttendee[]; participants: string[] },
  at: string,
): void {
  const params = {
    id,
    at: canonical('refreshMeetingFacts', 'at', at),
    title: f.title === '' ? null : f.title,
    attendees: f.attendees.length === 0 ? null : toJson('refreshMeetingFacts', 'attendees', AttendeesSchema, f.attendees),
    participants: f.participants.length === 0 ? null : toJson('refreshMeetingFacts', 'participants', ParticipantsSchema, f.participants),
  };
  const n = db
    .prepare(`UPDATE meetings SET title = COALESCE(@title, title), attendees = COALESCE(@attendees, attendees),
        participants = COALESCE(@participants, participants), updated_at = @at WHERE id = @id AND status = 'queued' AND stage = 'found'`)
    .run(params).changes;
  if (n === 0) notQueued('refreshMeetingFacts', id, ' at stage found');
}

/**
 * Meetings of any status whose speech parts may include one left inflight, for the speech recovery at processor start.
 * A text match, so it reads no JSON; the caller checks the parts.
 */
export function meetingIdsWithInflightParts(db: Db): number[] {
  return (db.prepare(`SELECT id FROM meetings WHERE instr(stt_parts, '"inflight"') > 0 ORDER BY id`).all() as { id: number }[]).map((r) => r.id);
}

/**
 * Stores speech-part bookkeeping whatever the meeting's status. Only for booking parts left inflight (bookStuckParts),
 * which must happen even after the meeting has failed. Throws when the meeting is missing.
 */
export function writeStuckSttParts(db: Db, id: number, parts: SttPartRow[], at: string): void {
  const json = toJson('writeStuckSttParts', 'stt_parts', SttPartsSchema, parts);
  const n = db.prepare('UPDATE meetings SET stt_parts = ?, updated_at = ? WHERE id = ?').run(json, canonical('writeStuckSttParts', 'at', at), id).changes;
  if (n === 0) throw new Error(`writeStuckSttParts: no meeting ${id}`);
}

/** A provider copy of a speech answer still to delete (M7). ref is the provider's id for the copy, never content. */
export interface SttForgetRow {
  id: number;
  meetingId: number;
  provider: ProviderId;
  ref: string;
  attempts: number;
}

/** Notes a provider copy to delete. A copy already noted is kept as it is. */
export function addSttForget(db: Db, f: { meetingId: number; provider: ProviderId; ref: string; at: string }): void {
  db.prepare('INSERT OR IGNORE INTO stt_forget (meeting_id, provider, ref, created_at) VALUES (?, ?, ?, ?)')
    .run(f.meetingId, f.provider, f.ref, canonical('addSttForget', 'at', f.at));
}

/** Copies due for a try at nowIso with fewer than maxAttempts tries, oldest first; optionally one meeting's only. */
export function pendingSttForgets(db: Db, o: { nowIso: string; maxAttempts: number; meetingId?: number }): SttForgetRow[] {
  return db
    .prepare(`SELECT id, meeting_id AS meetingId, provider, ref, attempts FROM stt_forget
      WHERE attempts < ? AND (next_try_at IS NULL OR next_try_at <= ?) AND (? IS NULL OR meeting_id = ?) ORDER BY id`)
    .all(o.maxAttempts, canonical('pendingSttForgets', 'nowIso', o.nowIso), o.meetingId ?? null, o.meetingId ?? null) as SttForgetRow[];
}

/**
 * Counts one try and sets when the next may start, before the provider is asked: a try cut off by a crash still counts,
 * and a restart does not try again before nextTryAt.
 */
export function countSttForgetAttempt(db: Db, id: number, nextTryAt: string): void {
  db.prepare('UPDATE stt_forget SET attempts = attempts + 1, next_try_at = ? WHERE id = ?').run(canonical('countSttForgetAttempt', 'nextTryAt', nextTryAt), id);
}

/** The provider has deleted its copy. */
export function deleteSttForget(db: Db, id: number): void {
  db.prepare('DELETE FROM stt_forget WHERE id = ?').run(id);
}

/**
 * Provider copies the agent has given up deleting for now: the last try is used (maxAttempts), or the copy's provider
 * is not the one set up now (`provider`; 'none' when speech-to-text is off), so forgetPending skips it. A count only,
 * for `cli status`.
 */
export function sttForgetsGivenUp(db: Db, o: { maxAttempts: number; provider: ProviderId | 'none' }): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM stt_forget WHERE attempts >= ? OR provider <> ?').get(o.maxAttempts, o.provider) as { n: number }
  ).n;
}

/** Stores a queued meeting's speech-part bookkeeping as it is now (written before and after every part's call). Throws when not queued. */
export function setSttParts(db: Db, id: number, parts: SttPartRow[], at: string): void {
  const json = toJson('setSttParts', 'stt_parts', SttPartsSchema, parts);
  const n = db.prepare("UPDATE meetings SET stt_parts = ?, updated_at = ? WHERE id = ? AND status = 'queued'").run(json, canonical('setSttParts', 'at', at), id).changes;
  if (n === 0) notQueued('setSttParts', id);
}

/**
 * A queued meeting tries again later. countAttempt counts one more attempt; `attempts`, when given instead, is stored as
 * it is: a deferral that doesn't count (spend cap, busy, settings) passes the count from before its claim. With neither,
 * the count is left as the claim made it. Throws when the meeting is not queued.
 */
export function deferMeeting(
  db: Db,
  id: number,
  d: { errorCode: string; nextAttemptAt: string; at: string } & ({ countAttempt?: boolean; attempts?: never } | { attempts: number; countAttempt?: never }),
): void {
  const n = db
    .prepare(`UPDATE meetings SET error_code = @errorCode, next_attempt_at = @nextAttemptAt, attempts = COALESCE(@attempts, attempts + @inc), updated_at = @at
      WHERE id = @id AND status = 'queued'`)
    .run({
      id,
      errorCode: d.errorCode,
      nextAttemptAt: canonical('deferMeeting', 'nextAttemptAt', d.nextAttemptAt),
      inc: d.countAttempt ? 1 : 0,
      attempts: d.attempts ?? null,
      at: canonical('deferMeeting', 'at', d.at),
    }).changes;
  if (n === 0) notQueued('deferMeeting', id);
}

/**
 * A final failure of a queued meeting. The stage is kept, so `meeting retry` starts again after the last finished stage.
 * audioPath and audioSeconds, when given, are stored in the same write (a measured too_long keeps its audio); not given,
 * the stored values stay. Throws when not queued.
 */
export function failMeeting(
  db: Db,
  id: number,
  f: { status: 'failed' | 'no_access' | 'too_long'; errorCode: string; at: string; audioPath?: string; audioSeconds?: number },
): void {
  const n = db
    .prepare(`UPDATE meetings SET status = @status, error_code = @errorCode, next_attempt_at = NULL, audio_path = COALESCE(@audioPath, audio_path),
        audio_seconds = COALESCE(@audioSeconds, audio_seconds), updated_at = @at WHERE id = @id AND status = 'queued'`)
    .run({
      id, status: f.status, errorCode: f.errorCode, audioPath: f.audioPath ?? null, audioSeconds: f.audioSeconds ?? null,
      at: canonical('failMeeting', 'at', f.at),
    }).changes;
  if (n === 0) notQueued('failMeeting', id);
}

/**
 * A queued meeting at stage doc or later is in the tracker: done, stage tracked. A note, when given, replaces the stored
 * one. Throws when the meeting is not queued or not yet at stage doc.
 */
export function finishMeeting(db: Db, id: number, f: { note?: string; at: string }): void {
  const n = db
    .prepare(`UPDATE meetings SET status = 'done', stage = 'tracked', note = COALESCE(@note, note), error_code = NULL, next_attempt_at = NULL,
      updated_at = @at WHERE id = @id AND status = 'queued' AND stage IN ('doc', 'tracked')`)
    .run({ id, note: f.note ?? null, at: canonical('finishMeeting', 'at', f.at) }).changes;
  if (n === 0) notQueued('finishMeeting', id, ' at stage doc or later');
}

/**
 * A person assigns an unassigned or internal meeting to a client; it is queued with fresh attempts. A no_access meeting
 * without a client (found as unassigned or internal) can be assigned too: the download is tried again for that client.
 * Returns false for any other meeting.
 */
export function assignMeeting(db: Db, id: number, clientId: number, at: string): boolean {
  return (
    db.prepare(`UPDATE meetings SET status = 'queued', client_id = @clientId, match_kind = 'human', error_code = NULL, attempts = 0, next_attempt_at = NULL,
        note = CASE WHEN note = '${FOUND_INTERNAL_NOTE}' THEN NULL ELSE note END, updated_at = @at
      WHERE id = @id AND (status IN ('unassigned', 'internal') OR (status = 'no_access' AND client_id IS NULL))`)
      .run({ id, clientId, at: canonical('assignMeeting', 'at', at) }).changes === 1
  );
}

/** A person decides an unassigned meeting is not processed. Returns false for any other status. */
export function skipMeeting(db: Db, id: number, at: string): boolean {
  return db.prepare("UPDATE meetings SET status = 'skipped', updated_at = ? WHERE id = ? AND status = 'unassigned'").run(canonical('skipMeeting', 'at', at), id)
    .changes === 1;
}

/**
 * `meeting retry`: a failed or no-access meeting with a client is queued again at its last finished stage, with fresh
 * attempts. One without a client (found as unassigned or internal) cannot be processed: it goes back to unassigned, for
 * `meeting assign`. Returns the new status, or null for any other meeting.
 */
export function retryMeeting(db: Db, id: number, at: string): 'queued' | 'unassigned' | null {
  const r = db
    .prepare(`UPDATE meetings SET status = CASE WHEN client_id IS NULL THEN 'unassigned' ELSE 'queued' END, attempts = 0, next_attempt_at = NULL,
        error_code = NULL, note = CASE WHEN client_id IS NULL AND note = '${FOUND_INTERNAL_NOTE}' THEN NULL ELSE note END, updated_at = ?
      WHERE id = ? AND status IN ('failed', 'no_access') RETURNING status`)
    .get(canonical('retryMeeting', 'at', at), id) as { status: 'queued' | 'unassigned' } | undefined;
  return r?.status ?? null;
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

/**
 * The done meetings a client tab lists: a meeting whose stored summary is not JSON, or has no actionItems list, is left
 * out. Shared by listClientMeetings and lastMeetingByClient, so "Last meeting" never names a meeting the tab hides.
 */
const LISTED_DONE = `status = 'done'
        AND CASE WHEN summary IS NULL THEN 1 WHEN json_valid(summary) THEN json_type(summary, '$.actionItems') = 'array' ELSE 0 END`;

export interface ClientMeeting {
  id: number;
  startedAt: string;
  title: string;
  seconds: number | null;
  docFileId: string | null;
  actionItemCount: number;
}

/**
 * A client's done meetings, newest first. A meeting whose stored summary is not JSON, or has no actionItems list, is
 * left out, in SQL, so the limit counts only listed meetings. The summary itself is not read here.
 */
export function listClientMeetings(db: Db, clientId: number, limit: number): ClientMeeting[] {
  return db
    .prepare(`SELECT id, started_at AS startedAt, title, COALESCE(audio_seconds, drive_seconds) AS seconds, doc_file_id AS docFileId,
        CASE WHEN summary IS NULL THEN 0 ELSE json_array_length(summary, '$.actionItems') END AS actionItemCount
      FROM meetings
      WHERE client_id = ? AND ${LISTED_DONE}
      ORDER BY started_at DESC, id DESC LIMIT ?`)
    .all(clientId, limit) as ClientMeeting[];
}

/** Each client's latest done meeting that its tab lists: client id → its start. */
export function lastMeetingByClient(db: Db): Map<number, string> {
  const rows = db
    .prepare(`SELECT client_id AS clientId, MAX(started_at) AS startedAt FROM meetings WHERE client_id IS NOT NULL AND ${LISTED_DONE}
      GROUP BY client_id`)
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
  /**
   * Queued meetings still waiting out a deferral at nowIso, by error code: an error code and a next attempt still ahead.
   * A claimed meeting has no error code (claimMeeting clears it), so it is never counted.
   */
  deferred: Record<string, number>;
}

/** Counts for Health and `cli status`. */
export function meetingStats(db: Db, nowIso: string): MeetingStats {
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
    .all(canonical('meetingStats', 'nowIso', nowIso)) as { code: string; n: number }[];
  return { ...counts, deferred: Object.fromEntries(deferred.map((d) => [d.code, d.n])) };
}

/** One line of `meeting list`. Reads no JSON, so a bad stored value never hides the list. */
export interface MeetingListRow {
  id: number;
  startedAt: string;
  clientId: number | null;
  status: MeetingStatus;
  /** '' for internal meetings. Shown on the operator's console only. */
  title: string;
  errorCode: string | null;
  /** A no_access meeting matched as internal (FOUND_INTERNAL_NOTE). */
  foundInternal: boolean;
}

/** Meetings with one of these statuses, newest first. */
export function listMeetingsByStatus(db: Db, statuses: readonly MeetingStatus[]): MeetingListRow[] {
  if (statuses.length === 0) return [];
  const rows = db
    .prepare(`SELECT id, started_at AS startedAt, client_id AS clientId, status, title, error_code AS errorCode,
        COALESCE(note = '${FOUND_INTERNAL_NOTE}', 0) AS foundInternal FROM meetings
      WHERE status IN (${statuses.map(() => '?').join(', ')}) ORDER BY started_at DESC, id DESC`)
    .all(...statuses) as (Omit<MeetingListRow, 'foundInternal'> & { foundInternal: number })[];
  return rows.map((r) => ({ ...r, foundInternal: r.foundInternal === 1 }));
}
