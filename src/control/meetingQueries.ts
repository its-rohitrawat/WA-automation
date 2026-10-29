import type { Db } from '../store/db.ts';
import { FOUND_INTERNAL_NOTE, getMeeting, MEETING_STATUSES, type MeetingStage, type MeetingStatus } from '../store/meetings.ts';
import { ControlError } from './errors.ts';
import { tasksForMeeting, type DashboardTaskRow } from './taskQueries.ts';

// The dashboard's Meetings screen (D4 Task 3). Titles and summaries are untrusted meeting text: they go back as JSON
// strings for the browser to show as text. Internal meetings keep no title (the table's own CHECK), so none is shown.
// No attendee email or transcript leaves here.

export const MEETING_VIEWS = ['all', 'ready', 'progress', 'attention'] as const;
export type MeetingView = (typeof MEETING_VIEWS)[number];

/** The statuses each view lists; all lists every status. */
const VIEW_STATUSES: Record<Exclude<MeetingView, 'all'>, readonly MeetingStatus[]> = {
  ready: ['done'],
  progress: ['queued'],
  attention: ['unassigned', 'too_long', 'no_access', 'failed'],
};

const LIMIT_DEFAULT = 100;
const LIMIT_MAX = 500;

export interface MeetingListParams {
  view: MeetingView;
  limit: number;
  offset: number;
}

export interface DashboardMeetingRow {
  id: number;
  /** '' for an internal meeting. */
  title: string;
  when: string;
  /** The audio's length once known, else Drive's, in whole minutes; null when neither is known. */
  minutes: number | null;
  /** The label of the Google account that found it ('main', 'company2'), when the running service knows it. */
  account: string | null;
  client: { code: string; name: string } | null;
  status: MeetingStatus;
  stageLabel: string;
  /** Tasks made from this meeting. */
  actionItems: number;
  docUrl: string | null;
}

export interface MeetingSummaryView {
  whatHappened: string;
  discussion: { topic: string; summary: string }[];
  decisions: string[];
  openQuestions: string[];
  conclusion: string;
}

export interface DashboardMeetingDetail extends DashboardMeetingRow {
  summary: MeetingSummaryView | null;
  /** The tasks made from this meeting, by code. */
  actionItemTasks: Pick<DashboardTaskRow, 'code' | 'title' | 'owner' | 'deadline' | 'status'>[];
}

/** Which Google account found a meeting, from its conference id; the service's multi-account router answers it. */
export type AccountOf = (conference: string) => string | null;

function whole(field: string, raw: string | null, min: number): number | undefined {
  if (raw === null || raw === '') return undefined;
  if (!/^\d{1,9}$/.test(raw) || Number(raw) < min) throw new ControlError(400, `${field} must be a whole number of at least ${min}`, field);
  return Number(raw);
}

/** Reads and checks the Meetings screen's URL parameters. Throws ControlError (400) naming the bad field. */
export function parseMeetingList(p: URLSearchParams): MeetingListParams {
  const raw = p.get('view') ?? '';
  if (raw !== '' && !(MEETING_VIEWS as readonly string[]).includes(raw)) {
    throw new ControlError(400, `view must be one of: ${MEETING_VIEWS.join(', ')}`, 'view');
  }
  return {
    view: (raw || 'all') as MeetingView,
    limit: Math.min(whole('limit', p.get('limit'), 1) ?? LIMIT_DEFAULT, LIMIT_MAX),
    offset: whole('offset', p.get('offset'), 0) ?? 0,
  };
}

/** A Drive id: letters, digits, _ and -, 10 to 200 of them. Anything else never becomes a link. */
const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;

/** The summary Doc's link, or null when the stored id is not a Drive id. */
export function meetingDocUrl(id: string | null): string | null {
  return id !== null && DRIVE_ID.test(id) ? `https://docs.google.com/document/d/${id}/edit` : null;
}

const STATUS_LABELS: Record<Exclude<MeetingStatus, 'queued'>, string> = {
  done: 'Ready', unassigned: 'Needs a client', internal: 'Internal, not processed', skipped: 'Skipped', too_long: 'Too long to process',
  no_access: 'No access to the recording', failed: 'Could not be processed',
};

/** What a queued meeting is doing next: the step after its last finished stage. */
const STAGE_LABELS: Record<MeetingStage, string> = {
  found: 'Downloading the recording', audio: 'Transcribing', transcribed: 'Writing the summary', summarised: 'Writing the summary doc',
  doc: 'Updating the tracker', tracked: 'Updating the tracker',
};

function stageLabel(
  r: { status: MeetingStatus; stage: MeetingStage; errorCode: string | null; nextAttemptAt: string | null; foundInternal: number },
  now: Date,
): string {
  // A no-access meeting matched as internal keeps no title; the CLI calls it internal too (meeting list).
  if (r.status === 'no_access' && r.foundInternal === 1) return 'Internal, no access to the recording';
  if (r.status !== 'queued') return STATUS_LABELS[r.status];
  // A deferral still ahead (the daily budget, low disk, a speech-to-text outage): it waits, whatever its stage.
  if (r.errorCode !== null && r.nextAttemptAt !== null && Date.parse(r.nextAttemptAt) > now.getTime()) return 'Waiting to try again';
  return STAGE_LABELS[r.stage];
}

const SELECT_SQL = `SELECT m.id, m.title, m.started_at AS startedAt, COALESCE(m.audio_seconds, m.drive_seconds) AS seconds, m.conference,
    c.code AS clientCode, c.name AS clientName, m.status, m.stage, m.error_code AS errorCode, m.next_attempt_at AS nextAttemptAt,
    m.doc_file_id AS docFileId, (SELECT COUNT(*) FROM tasks t WHERE t.meeting_id = m.id) AS actionItems,
    COALESCE(m.note = '${FOUND_INTERNAL_NOTE}', 0) AS foundInternal
  FROM meetings m LEFT JOIN clients c ON c.id = m.client_id`;

interface RawRow {
  id: number;
  title: string;
  startedAt: string;
  seconds: number | null;
  conference: string;
  clientCode: string | null;
  clientName: string | null;
  status: MeetingStatus;
  stage: MeetingStage;
  errorCode: string | null;
  nextAttemptAt: string | null;
  docFileId: string | null;
  foundInternal: number;
  actionItems: number;
}

function toRow(r: RawRow, now: Date, accountOf: AccountOf | undefined): DashboardMeetingRow {
  return {
    id: r.id,
    title: r.status === 'internal' ? '' : r.title,
    when: r.startedAt,
    minutes: r.seconds === null || !Number.isFinite(r.seconds) ? null : Math.round(r.seconds / 60),
    account: accountOf?.(r.conference) ?? null,
    client: r.clientCode === null || r.clientName === null ? null : { code: r.clientCode, name: r.clientName },
    status: r.status,
    stageLabel: stageLabel(r, now),
    actionItems: r.actionItems,
    docUrl: meetingDocUrl(r.docFileId),
  };
}

/** One page of a view, newest first, with the view's total before paging. */
export function listDashboardMeetings(db: Db, p: MeetingListParams, now: Date, accountOf?: AccountOf): { total: number; rows: DashboardMeetingRow[] } {
  const statuses = p.view === 'all' ? MEETING_STATUSES : VIEW_STATUSES[p.view];
  const where = `WHERE m.status IN (${statuses.map(() => '?').join(', ')})`;
  const total = (db.raw.prepare(`SELECT COUNT(*) AS n FROM meetings m ${where}`).get(...statuses) as { n: number }).n;
  const rows = db.raw.prepare(`${SELECT_SQL} ${where} ORDER BY m.started_at DESC, m.id DESC LIMIT ? OFFSET ?`).all(...statuses, p.limit, p.offset) as RawRow[];
  return { total, rows: rows.map((r) => toRow(r, now, accountOf)) };
}

/** The meeting's summary in the screen's shape; null when none is stored or the stored one cannot be read. */
function summaryOf(db: Db, id: number): MeetingSummaryView | null {
  let s;
  try {
    s = getMeeting(db, id)?.summary;
  } catch {
    return null; // a stored value that fails its schema (MeetingRowError): the rest of the detail still shows
  }
  if (!s) return null;
  return {
    whatHappened: s.whatHappened,
    discussion: s.discussion.map((d) => ({ topic: d.topic, summary: d.summary })),
    decisions: s.decisions.map((d) => d.text),
    openQuestions: [...s.openQuestions],
    conclusion: s.conclusion,
  };
}

/** A meeting id from the URL: a positive whole number, else undefined. */
export function parseMeetingId(raw: string): number | undefined {
  const s = raw.trim();
  return /^[1-9]\d{0,14}$/.test(s) ? Number(s) : undefined;
}

/** One meeting with its summary and the tasks made from it; undefined when there is no such meeting. */
export function meetingDetail(db: Db, rawId: string, now: Date, accountOf?: AccountOf): DashboardMeetingDetail | undefined {
  const id = parseMeetingId(rawId);
  if (id === undefined) return undefined;
  const r = db.raw.prepare(`${SELECT_SQL} WHERE m.id = ?`).get(id) as RawRow | undefined;
  if (!r) return undefined;
  return { ...toRow(r, now, accountOf), summary: summaryOf(db, id), actionItemTasks: tasksForMeeting(db, id, now) };
}
