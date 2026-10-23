import { sanitizeInline } from '../brain/prompt.ts';
import type { ClientConfig } from '../config/groups.ts';
import { getClientByGroupId } from '../store/clients.ts';
import { tx, type Db } from '../store/db.ts';
import { insertFound, knownRecordings, type MeetingAttendee, type MeetingStatus, type NewMeeting } from '../store/meetings.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { fromIstDate } from '../util/time.ts';
import type { ConferenceRef, DriveVideoInfo, InviteInfo, MeetingsGoogleApi } from './googleApi.ts';
import { GoogleNoAccessError, GoogleTransientError } from './googleErrors.ts';
import { domainOf, inDomains, matchClient, type MatchableClient } from './match.ts';

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
   * A client emailDomains entry equal to or under a team domain would claim our own people's meetings, so it is ignored
   * for matching, with a warning naming the client code only (never the domain).
   */
  #withoutTeamDomains(clients: readonly ClientConfigLike[]): ClientConfigLike[] {
    return clients.map((c) => {
      const kept = c.emailDomains.filter((d) => !inDomains(d, this.#settings.teamDomains));
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
    let skipped = 0;
    let errors = 0;
    for (const c of conferences) {
      signal.throwIfAborted();
      const known = knownRecordings(this.#db, c.name);
      // A conference with no row (no recording yet, or none at all) is listed again every pass while it is inside the
      // 72-hour window: accepted, as it costs one listRecordings call per pass.
      if (known.size > 0 && c.endTime !== null && Date.parse(c.endTime) < nowMs - SETTLED_MS) {
        skipped += known.size;
        continue;
      }
      try {
        const r = await this.#conference(c, known, clients, createdAt, signal);
        pending.push(...r.rows);
        skipped += r.skipped;
      } catch (e) {
        if (signal.aborted || !isConferenceError(e)) throw e; // GoogleAccessError included: the caller sets the health state
        errors++;
        this.#log.warn({ conference: c.name, code: e.code }, 'meeting conference skipped');
      }
    }

    const found = pending.map((m) => ({
      recording: m.recording,
      startedAt: new Date(Date.parse(m.startedAt)).toISOString(),
      status: m.status,
      clientId: m.clientId,
      driveSeconds: m.driveSeconds,
    }));
    if (dryRun) return { added: pending.length, skipped, errors, ids: [], found };
    const ids: number[] = [];
    const stored: FoundMeeting[] = [];
    tx(this.#db, () => {
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
  ): Promise<{ rows: NewMeeting[]; skipped: number }> {
    const recordings = await this.#api.listRecordings(c.name, signal);
    const rows: NewMeeting[] = [];
    let skipped = 0;
    const fresh = recordings.filter((r) => {
      if (r.state !== 'FILE_GENERATED' || r.driveFileId === null) return false;
      if (known.has(r.name)) skipped++;
      return !known.has(r.name);
    });
    if (fresh.length === 0) return { rows, skipped };

    const code = await this.#api.meetingCode(c.space, signal);
    const invite: InviteInfo | null = code === null ? null : await this.#api.findInvite(code, c.startTime, signal);
    const names = await this.#api.listSignedInNames(c.name, signal);
    const teamDomains = this.#settings.teamDomains;
    const attendees: MeetingAttendee[] = [];
    for (const a of invite?.attendees ?? []) {
      const domain = domainOf(a.email);
      if (domain === null) continue;
      const name = a.name === null ? '' : cleanLine(a.name, NAME_MAX);
      attendees.push({ email: a.email.trim().toLowerCase(), name: name === '' ? null : name, team: inDomains(domain, teamDomains) });
    }
    const participants = [...new Set(names.map((n) => cleanLine(n, NAME_MAX)).filter((n) => n !== ''))];
    const inviteTitle = invite === null ? '' : cleanLine(invite.title, TITLE_MAX);

    for (const r of fresh) {
      const fileId = r.driveFileId!;
      let video: DriveVideoInfo | null = null;
      let noAccess: string | null = null;
      try {
        video = await this.#api.videoInfo(fileId, signal);
      } catch (e) {
        if (signal.aborted || !(e instanceof GoogleNoAccessError)) throw e;
        // This file only: stored as no_access, so it is visible and not asked about again; the other recordings go on.
        noAccess = e.code;
        this.#log.warn({ recording: r.name, code: e.code }, 'meeting recording not readable');
      }
      const fileTitle = video === null ? '' : cleanLine(titleFromFileName(video.name), TITLE_MAX);
      const title = inviteTitle !== '' ? inviteTitle : fileTitle;
      const match = matchClient(
        { title, attendees: (invite?.attendees ?? []).map((a) => ({ email: a.email, self: a.self })), hasInvite: invite !== null },
        clients,
        teamDomains,
      );
      const base = {
        recording: r.name,
        conference: c.name,
        driveFileId: fileId,
        meetingCode: code,
        startedAt: r.startTime ?? c.startTime,
        createdAt,
      };
      if (match.kind === 'internal') {
        // M7: ids, start time and status only.
        rows.push({
          ...base, title: '', endedAt: null, attendees: [], participants: [], clientId: null, matchKind: null,
          status: noAccess === null ? 'internal' : 'no_access', driveSeconds: null, errorCode: noAccess,
        });
        continue;
      }
      const durationMs = video?.durationMs ?? null;
      const driveSeconds = durationMs === null ? null : durationMs / 1000;
      const tooLong = durationMs !== null && durationMs > this.#settings.maxMinutes * 60_000;
      const client = match.kind === 'client' ? { clientId: match.clientId, matchKind: match.by } : { clientId: null, matchKind: null };
      const status: MeetingStatus = noAccess !== null ? 'no_access' : tooLong ? 'too_long' : match.kind === 'client' ? 'queued' : 'unassigned';
      rows.push({ ...base, ...client, title, endedAt: r.endTime ?? c.endTime, attendees, participants, status, driveSeconds, errorCode: noAccess });
    }
    return { rows, skipped };
  }
}
