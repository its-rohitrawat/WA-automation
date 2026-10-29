import { sanitizeInline } from '../brain/prompt.ts';
import { isDomain } from '../config/domains.ts';
import type { ClientConfig } from '../config/groups.ts';
import { getClientByGroupId } from '../store/clients.ts';
import { txSync, type Db } from '../store/db.ts';
import { getKv, setKv } from '../store/kv.ts';
import { insertFound, knownRecordings, type MeetingAttendee, type MeetingStatus, type NewMeeting } from '../store/meetings.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { fromIstDate, istDate } from '../util/time.ts';
import type { ConferenceRef, DriveVideoInfo, InviteInfo, MeetingsGoogleApi } from './googleApi.ts';
import { GoogleNoAccessError, GoogleTransientError } from './googleErrors.ts';
import { domainOf, inDomains, matchClient, type MatchableClient, type MatchResult } from './match.ts';

// Discovery (Task 4): finds new Meet recordings and records each once, matched to a client before anything is
// downloaded (M2). Nothing is downloaded or sent here. Logs carry ids, counts and codes only, never titles, names or emails.

/** What the watcher reads of a client's config; the tracker id comes from the clients table by group. */
export type ClientConfigLike = Pick<ClientConfig, 'groupId' | 'code' | 'name' | 'emailDomains' | 'meetingKeywords'>;

export interface WatcherSettings {
  /** TEAM_EMAIL_DOMAINS. */
  teamDomains: readonly string[];
  /** MEETING_MAX_MINUTES. */
  maxMinutes: number;
  /** MEETINGS_SINCE (YYYY-MM-DD, IST): conferences starting earlier are never picked up by discover (M3). */
  since: string;
}

export interface MeetingWatcherDeps {
  db: Db;
  api: MeetingsGoogleApi;
  clock: Clock;
  log: Logger;
  settings: WatcherSettings;
  clients: readonly ClientConfigLike[];
}

export interface DiscoverResult {
  /** Rows stored (in a dry run: rows that would be stored). */
  added: number;
  /** Recordings already known: in settled conferences, or listed again. */
  skipped: number;
  /** Conferences left for a later pass after a transient or no-access error. */
  errors: number;
}

/** A found recording without its title, attendees or names, for the CLI's count and cost estimate. */
export interface FoundMeeting {
  recording: string;
  startedAt: string;
  status: MeetingStatus;
  clientId: number | null;
  driveSeconds: number | null;
  /** The match before the file check: a no_access row still says whether it was a client's, unassigned or internal. */
  match: MatchResult['kind'];
}

export interface BackfillResult extends DiscoverResult {
  /** The new rows' ids; empty in a dry run. */
  ids: number[];
  /** Every recording stored, or that would be stored in a dry run. */
  found: FoundMeeting[];
}

const HOUR_MS = 3_600_000;
const LOOKBACK_MS = 72 * HOUR_MS;
/** A conference that ended this long ago with recordings already known is not asked about again. */
const SETTLED_MS = 24 * HOUR_MS;
const TITLE_MAX = 200;
const NAME_MAX = 100;

/** One line, no hidden characters, single spaces, at most `max` characters (code points). */
function cleanLine(s: string, max: number): string {
  return [...sanitizeInline(s).replace(/\s+/g, ' ').trim()].slice(0, max).join('').trim();
}

const VIDEO_EXTENSION = /\.(mp4|m4v|mov|webm|mkv)$/i;
const MEET_DATE_SUFFIX = /\s*\(\d{4}-\d{2}-\d{2} \d{2}:\d{2} GMT[^)]*\)\s*$/;
/** Meet's newer naming: `Title - 2026/10/23 10:00 GMT+05:30 - Recording`. */
const MEET_RECORDING_SUFFIX = /\s+-\s+\d{4}\/\d{2}\/\d{2} \d{2}:\d{2} GMT(?:[+\-−]\d{1,2}(?::?\d{2})?)?\s+-\s+Recording\s*$/i;

/**
 * Meet's recording name without the video extension and its trailing ` (YYYY-MM-DD HH:MM GMT…)` or
 * ` - YYYY/MM/DD HH:MM GMT±hh:mm - Recording`. Not cleaned.
 */
export function titleFromFileName(name: string): string {
  return name.trim().replace(VIDEO_EXTENSION, '').replace(MEET_DATE_SUFFIX, '').replace(MEET_RECORDING_SUFFIX, '').trim();
}

const EMAIL_MAX = 254;
const HIDDEN_OR_CONTROL = /[\p{Cc}\p{Cf}]/u;

/**
 * A plain address, lower-cased, or null. Kept only when it is one line with no spaces, hidden or control characters, at
 * most 254 characters, with exactly one '@', a non-empty local part and a valid domain.
 */
export function cleanEmail(raw: string): string | null {
  const e = raw.toLowerCase();
  if (e.length === 0 || e.length > EMAIL_MAX || /\s/u.test(e) || HIDDEN_OR_CONTROL.test(e)) return null;
  const parts = e.split('@');
  if (parts.length !== 2) return null;
  const [local, domain] = parts as [string, string];
  return local !== '' && isDomain(domain) ? e : null;
}

/**
 * An invite's facts, cleaned as they are stored: addresses that are not plain addresses dropped (for matching and for
 * storing alike), names and the title as one clean line. `invited` is what matching reads; `attendees` what is stored.
 * No invite: no attendees and the title ''.
 */
export function inviteFacts(
  invite: InviteInfo | null,
  teamDomains: readonly string[],
): { invited: { email: string; name: string | null; self: boolean }[]; attendees: MeetingAttendee[]; title: string } {
  const invited: { email: string; name: string | null; self: boolean }[] = [];
  for (const a of invite?.attendees ?? []) {
    const email = cleanEmail(a.email);
    if (email !== null) invited.push({ email, name: a.name, self: a.self });
  }
  const attendees: MeetingAttendee[] = invited.map((a) => {
    const name = a.name === null ? '' : cleanLine(a.name, NAME_MAX);
    return { email: a.email, name: name === '' ? null : name, team: inDomains(domainOf(a.email) ?? '', teamDomains) };
  });
  return { invited, attendees, title: invite === null ? '' : cleanLine(invite.title, TITLE_MAX) };
}

/** Signed-in display names as stored: each a clean line, empty ones dropped, each once. */
export function cleanNames(names: readonly string[]): string[] {
  return [...new Set(names.map((n) => cleanLine(n, NAME_MAX)).filter((n) => n !== ''))];
}

/** A recording's title from its Drive file name, cleaned as stored. */
export function fileNameTitle(name: string): string {
  return cleanLine(titleFromFileName(name), TITLE_MAX);
}

/** kv key of the day meetings were first switched on (M3), so a restart does not move it. */
const SINCE_KEY = 'meetings_since';

/**
 * MEETINGS_SINCE when it is set; otherwise the day (IST) meetings were first seen switched on, stored in kv
 * 'meetings_since' the first time this runs, so a restart does not move it (M3).
 */
export function meetingsSince(db: Db, configured: string | undefined, now: Date): string {
  if (configured !== undefined) return configured;
  const stored = getKv(db, SINCE_KEY);
  if (stored) return stored;
  const today = istDate(now);
  setKv(db, SINCE_KEY, today);
  return today;
}

/** Everything known about one recording when its row is built. Title, names and attendees are already cleaned. */
export interface RowFacts {
  recording: string;
  conference: string;
  driveFileId: string;
  meetingCode: string | null;
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
  title: string;
  attendees: MeetingAttendee[];
  participants: string[];
  match: MatchResult;
  /** Drive's length; null when Drive gives none (left to ffmpeg) or the file could not be read. */
  durationMs: number | null;
  /** Set when videoInfo refused the file (GoogleNoAccessError's code). */
  noAccessCode: string | null;
  maxMinutes: number;
}

/**
 * The row for one recording. Status, in order:
 * 1. internal match: ids, start time and status only (M7); no_access (noted as found internal) when the file could not be
 *    read, else internal;
 * 2. the file could not be read: no_access, with the client match kept;
 * 3. longer than maxMinutes by Drive's length: too_long, with the client match kept;
 * 4. queued for a client match, else unassigned.
 */
export function buildRow(f: RowFacts): NewMeeting {
  const base = {
    recording: f.recording,
    conference: f.conference,
    driveFileId: f.driveFileId,
    meetingCode: f.meetingCode,
    startedAt: f.startedAt,
    createdAt: f.createdAt,
    errorCode: f.noAccessCode,
  };
  if (f.match.kind === 'internal') {
    return {
      ...base, title: '', endedAt: null, attendees: [], participants: [], clientId: null, matchKind: null,
      status: f.noAccessCode === null ? 'internal' : 'no_access', driveSeconds: null,
      // A no_access row keeps that it was internal, so `meeting list` labels it so.
      ...(f.noAccessCode === null ? {} : { foundInternal: true }),
    };
  }
  const client = f.match.kind === 'client' ? { clientId: f.match.clientId, matchKind: f.match.by } : { clientId: null, matchKind: null };
  const tooLong = f.durationMs !== null && f.durationMs > f.maxMinutes * 60_000;
  const status: MeetingStatus =
    f.noAccessCode !== null ? 'no_access' : tooLong ? 'too_long' : f.match.kind === 'client' ? 'queued' : 'unassigned';
  return {
    ...base, ...client, title: f.title, endedAt: f.endedAt, attendees: f.attendees, participants: f.participants, status,
    driveSeconds: f.durationMs === null ? null : f.durationMs / 1000,
  };
}

const isConferenceError = (e: unknown): e is GoogleTransientError | GoogleNoAccessError =>
  e instanceof GoogleTransientError || e instanceof GoogleNoAccessError;

export class MeetingWatcher {
  #db: Db;
  #api: MeetingsGoogleApi;
  #clock: Clock;
  #log: Logger;
  #settings: WatcherSettings;
  #clients: readonly ClientConfigLike[];

  constructor(d: MeetingWatcherDeps) {
    this.#db = d.db;
    this.#api = d.api;
    this.#clock = d.clock;
    this.#log = d.log;
    this.#settings = d.settings;
    this.#clients = this.#withoutTeamDomains(d.clients);
  }

  /** The configs after a reload; the next pass matches against them. */
  setClients(clients: readonly ClientConfigLike[]): void {
    this.#clients = this.#withoutTeamDomains(clients);
  }

  /**
   * A client emailDomains entry that overlaps a team domain (equal, under it, or above it) would claim our own people's
   * meetings, so it is ignored for matching, with a warning naming the client code only (never the domain).
   */
  #withoutTeamDomains(clients: readonly ClientConfigLike[]): ClientConfigLike[] {
    const team = this.#settings.teamDomains;
    return clients.map((c) => {
      const kept = c.emailDomains.filter((d) => !inDomains(d, team) && !team.some((t) => inDomains(t, [d])));
      if (kept.length === c.emailDomains.length) return c;
      this.#log.warn({ client: c.code, ignored: c.emailDomains.length - kept.length }, 'client email domain is a team domain; ignored for matching');
      return { ...c, emailDomains: kept };
    });
  }

  /**
   * One pass over [max(since, now − 72 h), now). A transient error, or a no-access error outside videoInfo, skips that
   * conference (logged by id and code); a recording whose file cannot be read is stored as no_access. A GoogleAccessError
   * or a stop is rethrown at once, and nothing of the pass is stored.
   */
  async discover(signal: AbortSignal): Promise<DiscoverResult> {
    const now = this.#clock.now().getTime();
    const from = Math.max(fromIstDate(this.#settings.since).getTime(), now - LOOKBACK_MS);
    if (!(from < now)) return { added: 0, skipped: 0, errors: 0 };
    const r = await this.#pass(new Date(from).toISOString(), new Date(now).toISOString(), signal, false);
    if (r.added > 0 || r.errors > 0) this.#log.info({ added: r.added, skipped: r.skipped, errors: r.errors }, 'meetings discovered');
    return { added: r.added, skipped: r.skipped, errors: r.errors };
  }

  /** The same steps over an explicit range (no since or 72-hour limit). dryRun stores nothing. */
  async backfill(fromIso: string, toIso: string, signal: AbortSignal, opts: { dryRun?: boolean } = {}): Promise<BackfillResult> {
    const r = await this.#pass(fromIso, toIso, signal, opts.dryRun === true);
    this.#log.info({ added: r.added, skipped: r.skipped, errors: r.errors, dryRun: opts.dryRun === true }, 'meetings backfill');
    return r;
  }

  async #pass(fromIso: string, toIso: string, signal: AbortSignal, dryRun: boolean): Promise<BackfillResult> {
    const nowMs = this.#clock.now().getTime();
    const createdAt = new Date(nowMs).toISOString();
    const clients = this.#activeClients();
    const conferences = await this.#api.listConferences(fromIso, toIso, signal);
    const pending: NewMeeting[] = [];
    const matches: MatchResult['kind'][] = [];
    let skipped = 0;
    let errors = 0;
    for (const c of conferences) {
      signal.throwIfAborted();
      const known = knownRecordings(this.#db, c.name);
      // A conference with no row (no recording yet, or none at all) is listed again every pass while it is inside the
      // 72-hour window: accepted, as it costs one listRecordings call per pass. A conference with a row is settled 24 h
      // after it ended, so a second recording whose file appears later than that is not found: accepted (rare).
      if (known.size > 0 && c.endTime !== null && Date.parse(c.endTime) < nowMs - SETTLED_MS) {
        skipped += known.size;
        continue;
      }
      try {
        const r = await this.#conference(c, known, clients, createdAt, signal);
        pending.push(...r.rows);
        matches.push(...r.matches);
        skipped += r.skipped;
      } catch (e) {
        if (signal.aborted || !isConferenceError(e)) throw e; // GoogleAccessError included: the caller sets the health state
        errors++;
        this.#log.warn({ conference: c.name, code: e.code }, 'meeting conference skipped');
      }
    }

    const found = pending.map((m, i) => ({
      recording: m.recording,
      startedAt: new Date(Date.parse(m.startedAt)).toISOString(),
      status: m.status,
      clientId: m.clientId,
      driveSeconds: m.driveSeconds,
      match: matches[i]!,
    }));
    if (dryRun) return { added: pending.length, skipped, errors, ids: [], found };
    const ids: number[] = [];
    const stored: FoundMeeting[] = [];
    txSync(this.#db, () => {
      for (const [i, m] of pending.entries()) {
        const id = insertFound(this.#db, m);
        if (id === null) skipped++;
        else {
          ids.push(id);
          stored.push(found[i]!);
        }
      }
    });
    return { added: ids.length, skipped, errors, ids, found: stored };
  }

  /** Active clients with their tracker ids. A config whose row is missing or inactive never matches. */
  #activeClients(): MatchableClient[] {
    const out: MatchableClient[] = [];
    for (const c of this.#clients) {
      const row = getClientByGroupId(this.#db, c.groupId);
      if (row?.active) out.push({ clientId: row.id, name: c.name, emailDomains: c.emailDomains, meetingKeywords: c.meetingKeywords });
    }
    return out;
  }

  async #conference(
    c: ConferenceRef,
    known: Set<string>,
    clients: MatchableClient[],
    createdAt: string,
    signal: AbortSignal,
  ): Promise<{ rows: NewMeeting[]; matches: MatchResult['kind'][]; skipped: number }> {
    const recordings = await this.#api.listRecordings(c.name, signal);
    const rows: NewMeeting[] = [];
    const matches: MatchResult['kind'][] = [];
    let skipped = 0;
    const fresh = recordings.filter((r) => {
      if (r.state !== 'FILE_GENERATED' || r.driveFileId === null) return false;
      if (known.has(r.name)) skipped++;
      return !known.has(r.name);
    });
    if (fresh.length === 0) return { rows, matches, skipped };

    const code = await this.#api.meetingCode(c.space, signal);
    const invite: InviteInfo | null = code === null ? null : await this.#api.findInvite(code, c.startTime, signal);
    const teamDomains = this.#settings.teamDomains;
    const { invited, attendees, title: inviteTitle } = inviteFacts(invite, teamDomains);
    // Signed-in names are read only for a meeting that is not internal, once per conference.
    let participants: string[] | undefined;

    for (const r of fresh) {
      const fileId = r.driveFileId!;
      let video: DriveVideoInfo | null = null;
      let noAccessCode: string | null = null;
      try {
        video = await this.#api.videoInfo(fileId, signal);
      } catch (e) {
        if (signal.aborted || !(e instanceof GoogleNoAccessError)) throw e;
        // This file only: stored as no_access, so it is visible and not asked about again; the other recordings go on.
        noAccessCode = e.code;
        this.#log.warn({ recording: r.name, code: e.code }, 'meeting recording not readable');
      }
      const fileTitle = video === null ? '' : fileNameTitle(video.name);
      const title = inviteTitle !== '' ? inviteTitle : fileTitle;
      const match = matchClient({ title, attendees: invited, hasInvite: invite !== null }, clients, teamDomains);
      if (match.kind !== 'internal' && participants === undefined) {
        participants = cleanNames(await this.#api.listSignedInNames(c.name, signal));
      }
      matches.push(match.kind);
      rows.push(
        buildRow({
          recording: r.name,
          conference: c.name,
          driveFileId: fileId,
          meetingCode: code,
          startedAt: r.startTime ?? c.startTime,
          endedAt: r.endTime ?? c.endTime,
          createdAt,
          title,
          attendees,
          participants: participants ?? [],
          match,
          durationMs: video?.durationMs ?? null,
          noAccessCode,
          maxMinutes: this.#settings.maxMinutes,
        }),
      );
    }
    return { rows, matches, skipped };
  }
}
