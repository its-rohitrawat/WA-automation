import { AiInvalidOutputError, AiRefusalError } from '../brain/claudeClient.ts';
import { summarizeMeeting, type MeetingAi } from '../brain/meetingClient.ts';
import type { MeetingPerson } from '../brain/meetingPrompt.ts';
import { SpendCapReachedError } from '../brain/paidCall.ts';
import type { MeetingForTracker, MeetingTrackOutcome } from '../brain/reconciler.ts';
import { DriveAuthError, type DriveApi } from '../output/drive.ts';
import { DriveRootMissingError } from '../output/folders.ts';
import type { Prices } from '../spend/pricing.ts';
import type { SpendGuard } from '../spend/spendGuard.ts';
import { getClient } from '../store/clients.ts';
import type { Db } from '../store/db.ts';
import {
  advanceStage, claimMeeting, deferMeeting, failMeeting, finishMeeting, getMeeting, getMeetingState, refreshMeetingFacts, type MeetingRow,
  type MeetingState,
} from '../store/meetings.ts';
import type { Ffmpeg } from '../stt/audio.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { fromIstDate, istDate } from '../util/time.ts';
import { MeetingDeferral, MeetingFailure, prepareAudio } from './audio.ts';
import { uploadMeetingDoc } from './docUpload.ts';
import type { MeetingsGoogleApi } from './googleApi.ts';
import { GoogleAccessError, GoogleNoAccessError, GoogleTransientError } from './googleErrors.ts';
import { errorCode } from './sttParts.ts';
import { bookStuckParts, transcribeMeeting, type MeetingTranscriber } from './transcribe.ts';
import { cleanNames, fileNameTitle, inviteFacts } from './watcher.ts';

/*
 * The meeting processor (Task 10): takes one queued meeting through its stages, each stored before the next starts:
 *   found -> audio (prepareAudio) -> transcribed (transcribeMeeting) -> summarised (summarizeMeeting) -> doc
 *   (uploadMeetingDoc) -> tracked/done (Reconciler.runMeeting, under the client's run flag).
 * Every stage is claimed first (claimMeeting counts an attempt; a finished stage resets the count to 0), so:
 * - a deferral (MeetingDeferral and the waits below) puts the count back to what it was before the claim;
 * - a transient error keeps the claim's attempt and retries after 1, 5 and 30 minutes; the 4th failed attempt of a stage
 *   is final (failed);
 * - a stage whose runs never ended MAX_ATTEMPTS times (the process stopped each time) fails as crashed;
 * - every path to a final status books speech parts left in flight first (bookStuckParts), then failMeeting.
 * A stop (the signal) aborts only the download, ffmpeg and the free local speech engine (STT_PROVIDER=local): paid
 * speech and Claude calls never take the signal. A stage cut off by the stop is left queued and due at once, with its
 * attempt given back: a stop is not the meeting's fault, and an aborted download, ffmpeg or local engine run costs
 * nothing (the local part runs again). A run the stop could not abort (a speech or Claude call) finishes and is
 * stored, or is booked by SpendGuard.settlePending, and the claim's attempt stays counted, as for a crash.
 * Logs carry the meeting id, client id, stage, codes and counts only: never titles, names, emails or what was said.
 */

/** Waits after the 1st, 2nd and 3rd failed attempt of a stage; the 4th failure is final. */
export const MEETING_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;
/** Attempts of one stage: the first try and the three retries. */
export const MEETING_MAX_ATTEMPTS = MEETING_RETRY_DELAYS_MS.length + 1;
/**
 * A claimed stage is not due again for this long. Within the service the queue never starts a meeting twice; this bounds
 * how soon a stage cut off by a crash runs again after the restart.
 */
export const MEETING_CLAIM_MS = 15 * 60_000;
/** stt_unavailable (the speech key refused) waits hourly; after this long in one service run the meeting fails. */
export const STT_UNAVAILABLE_MAX_MS = 24 * 3_600_000;

const MINUTE = 60_000;
/**
 * The wait of each deferral code (plan, behaviour notes). Codes the plan does not list: disk_full as low_disk; disk_busy
 * (a file held by a virus scanner) 15 minutes; drive_root (the publisher has not made the WA Agent folder yet) 5
 * minutes. spend_cap waits for the next IST midnight instead (deferralWaitMs). An unknown code waits an hour.
 */
export const DEFERRAL_WAITS_MS: Readonly<Record<string, number>> = {
  spend_busy: 10 * MINUTE,
  client_busy: MINUTE,
  stt_none: 60 * MINUTE,
  stt_unavailable: 60 * MINUTE,
  google_auth: 15 * MINUTE,
  google_scopes: 15 * MINUTE,
  no_ffmpeg: 60 * MINUTE,
  low_disk: 60 * MINUTE,
  disk_full: 60 * MINUTE,
  disk_busy: 15 * MINUTE,
  drive_root: 5 * MINUTE,
};

/** When a meeting deferred with `code` at `at` is due again. */
export function deferralDueAt(code: string, at: Date): Date {
  if (code === 'spend_cap') {
    const tomorrow = new Date(fromIstDate(istDate(at)).getTime() + 36 * 3_600_000); // any time on the next IST day
    return fromIstDate(istDate(tomorrow));
  }
  return new Date(at.getTime() + (DEFERRAL_WAITS_MS[code] ?? 60 * MINUTE));
}

export interface MeetingProcessorDeps {
  db: Db;
  spend: SpendGuard;
  prices: Prices;
  clock: Clock;
  log: Logger;
  dataDir: string;
  api: MeetingsGoogleApi;
  drive: DriveApi;
  ai: MeetingAi;
  /** null: STT_PROVIDER none, meetings wait at stage found (stt_none). */
  transcriber: MeetingTranscriber | null;
  /** null: ffmpeg not found, meetings wait at stages found and audio (no_ffmpeg). */
  ffmpeg: Ffmpeg | null;
  /** MEETING_MAX_MINUTES. */
  maxMinutes: number;
  /** INR_PER_USD, for booking speech parts left in flight. */
  inrPerUsd: number;
  /** TEAM_EMAIL_DOMAINS, for the team flag of attendees read again. */
  teamDomains: readonly string[];
  /** Free bytes on a folder's volume; null (unknown) counts as 0, so the meeting waits low_disk. */
  freeBytes: (dir: string) => number | null;
  /** The tracker step: Reconciler.runMeeting, which holds the client's run flag (runExclusive). */
  track: (clientId: number, meeting: MeetingForTracker) => Promise<MeetingTrackOutcome>;
  /** False while the stored Google sign-in lacks the meeting scopes: no Google meeting call is made (google_scopes). */
  hasMeetingScopes: () => boolean;
  /** Google meeting calls work again (true), or the sign-in or a scope was refused (false). */
  onGoogleAccess?: (ok: boolean) => void;
}

export type MeetingProcessOutcome = 'done' | 'deferred' | 'failed' | 'stopped' | 'skipped';

export interface MeetingProcessResult {
  outcome: MeetingProcessOutcome;
  clientId: number | null;
}

/** A meeting row that does not hold what its stage needs (a bug, or a row changed by hand). Retried, then failed with its code. */
export class MeetingRowStateError extends Error {
  readonly code: 'missing_row' | 'no_client' | 'no_summary';
  constructor(code: 'missing_row' | 'no_client' | 'no_summary', meetingId: number) {
    super(`meeting processor: meeting ${meetingId} (${code})`);
    this.name = 'MeetingRowStateError';
    this.code = code;
  }
}

/** The error code stored for a failed step: a plain Error (no code of its own) is 'unknown', never 'Error'. */
function stepCode(e: unknown): string {
  const code = errorCode(e);
  return code === 'Error' ? 'unknown' : code;
}

/** What a stage run ended in: the next stage may start, the meeting is done, or a final status is already stored. */
type StageResult = 'next' | 'done' | 'final';

export class MeetingProcessor {
  readonly #d: MeetingProcessorDeps;
  /** When a meeting's current run of stt_unavailable deferrals began, in this service run (ms). */
  readonly #sttRefusedSince = new Map<number, number>();
  /** Meetings whose invite and names were read again in this service run: at most once each. */
  readonly #refreshed = new Set<number>();

  constructor(d: MeetingProcessorDeps) {
    this.#d = d;
  }

  /**
   * Runs the meeting's next stages until it is done, waits, fails or the signal stops it. Never runs a meeting that is
   * not queued or not due (skipped). Throws only when the database fails.
   */
  async process(id: number, signal: AbortSignal): Promise<MeetingProcessResult> {
    const { db } = this.#d;
    let clientId: number | null = null;
    for (;;) {
      if (signal.aborted) return { outcome: 'stopped', clientId };
      const before = getMeetingState(db, id);
      if (before === undefined || before.status !== 'queued') return { outcome: 'skipped', clientId: before?.clientId ?? clientId };
      clientId = before.clientId;
      const at = this.#now();
      if (before.attempts >= MEETING_MAX_ATTEMPTS) {
        // Each of these runs was cut off without an answer (the process stopped): a stage that cannot finish.
        this.#fail(before, 'failed', 'crashed', at);
        return { outcome: 'failed', clientId };
      }
      if (!claimMeeting(db, id, { nextAttemptAt: new Date(Date.parse(at) + MEETING_CLAIM_MS).toISOString(), at })) return { outcome: 'skipped', clientId };
      let r: StageResult;
      try {
        r = await this.#stage(before, signal);
      } catch (e) {
        return { outcome: this.#settle(before, e, signal), clientId };
      }
      this.#sttRefusedSince.delete(id); // a finished stage ends a run of stt_unavailable waits
      if (r === 'done') return { outcome: 'done', clientId };
      if (r === 'final') return { outcome: 'failed', clientId };
    }
  }

  #now(): string {
    return this.#d.clock.now().toISOString();
  }

  #stage(s: MeetingState, signal: AbortSignal): Promise<StageResult> {
    switch (s.stage) {
      case 'found':
        return this.#audio(s.id, signal);
      case 'audio':
        return this.#transcribe(s.id, signal);
      case 'transcribed':
        return this.#summarise(s.id);
      case 'summarised':
        return this.#doc(s.id);
      case 'doc':
        return this.#track(s.id);
      case 'tracked':
        // finishMeeting sets stage tracked and status done together; a queued row at tracked only needs finishing.
        finishMeeting(this.#d.db, s.id, { at: this.#now() });
        return Promise.resolve('done');
    }
  }

  #meeting(id: number): MeetingRow & { clientId: number } {
    const m = getMeeting(this.#d.db, id);
    if (m === undefined) throw new MeetingRowStateError('missing_row', id);
    if (m.clientId === null) throw new MeetingRowStateError('no_client', id);
    return m as MeetingRow & { clientId: number };
  }

  /** found -> audio. Checks the settings first, so nothing is downloaded that could not be used. */
  async #audio(id: number, signal: AbortSignal): Promise<StageResult> {
    const d = this.#d;
    if (!d.hasMeetingScopes()) throw new MeetingDeferral('google_scopes');
    if (d.ffmpeg === null) throw new MeetingDeferral('no_ffmpeg');
    if (d.transcriber === null) throw new MeetingDeferral('stt_none');
    let m = this.#meeting(id);
    if (m.matchKind === 'human' && m.attendees.length === 0 && !this.#refreshed.has(id)) {
      this.#refreshed.add(id);
      await this.#refreshFacts(m, signal);
      m = this.#meeting(id);
    }
    const r = await prepareAudio(
      m,
      {
        db: d.db, api: d.api, ffmpeg: d.ffmpeg, dataDir: d.dataDir, clock: d.clock, log: d.log, maxMinutes: d.maxMinutes,
        freeBytes: async (dir) => d.freeBytes(dir) ?? 0,
      },
      signal,
    );
    d.onGoogleAccess?.(true);
    return r.outcome === 'too_long' ? 'final' : 'next';
  }

  /**
   * An assigned meeting stored without attendees (taken for internal, or unassigned without an invite) gets its invite
   * title, attendees and signed-in names read again, so the summary can name speakers and the Doc list attendees. Once
   * per service run. These facts are a nicety: when Google will not give them (a no-access or transient error), the
   * meeting goes on with what is stored. A stop and a sign-in or scope refusal (GoogleAccessError) are thrown.
   */
  async #refreshFacts(m: MeetingRow, signal: AbortSignal): Promise<void> {
    const d = this.#d;
    let facts: ReturnType<typeof inviteFacts>;
    let participants: string[];
    let title: string;
    try {
      const invite = m.meetingCode === null ? null : await d.api.findInvite(m.meetingCode, m.startedAt, signal);
      facts = inviteFacts(invite, d.teamDomains);
      participants = cleanNames(await d.api.listSignedInNames(m.conference, signal));
      title = facts.title;
      if (title === '' && m.title === '') title = fileNameTitle((await d.api.videoInfo(m.driveFileId, signal)).name);
    } catch (e) {
      if (signal.aborted || !(e instanceof GoogleNoAccessError || e instanceof GoogleTransientError)) throw e;
      d.log.warn({ meetingId: m.id, code: e.code }, 'meeting attendees could not be read again; going on with the stored ones');
      return;
    }
    refreshMeetingFacts(d.db, m.id, { title, attendees: facts.attendees, participants }, this.#now());
    d.log.info({ meetingId: m.id, attendeeCount: facts.attendees.length, participantCount: participants.length }, 'meeting attendees read again');
  }

  /** audio -> transcribed. The signal stops it before a new part starts, while splitting, and during a local engine part. */
  async #transcribe(id: number, signal: AbortSignal): Promise<StageResult> {
    const d = this.#d;
    if (d.ffmpeg === null) throw new MeetingDeferral('no_ffmpeg');
    await transcribeMeeting(id, { db: d.db, spend: d.spend, transcriber: d.transcriber, ffmpeg: d.ffmpeg, dataDir: d.dataDir, clock: d.clock, log: d.log }, signal);
    return 'next';
  }

  /** The names a speaker may be given: attendees with a name, then signed-in participants. */
  #people(m: MeetingRow): MeetingPerson[] {
    return [
      ...m.attendees.flatMap((a) => (a.name === null ? [] : [{ name: a.name, team: a.team }])),
      ...m.participants.map((name) => ({ name, team: false })),
    ];
  }

  /** transcribed -> summarised. Never aborted. */
  async #summarise(id: number): Promise<StageResult> {
    const d = this.#d;
    const m = this.#meeting(id);
    const client = getClient(d.db, m.clientId);
    const r = await summarizeMeeting(
      { ai: d.ai, spend: d.spend, prices: d.prices },
      {
        meetingId: id, clientName: client.name, clientCode: client.code, startedAt: m.startedAt, seconds: m.audioSeconds ?? 0,
        segments: m.transcript ?? [], people: this.#people(m),
      },
    );
    advanceStage(d.db, id, 'summarised', r.cut ? { summary: r.summary, note: 'transcript_cut' } : { summary: r.summary }, this.#now());
    d.log.info({ meetingId: id, skipped: r.skipped, cut: r.cut, dropped: r.dropped, costUsd: r.costUsd }, 'meeting summarised');
    return 'next';
  }

  /** summarised -> doc. The Doc id is stored at once, so a retry never makes a second Doc. */
  async #doc(id: number): Promise<StageResult> {
    const d = this.#d;
    const m = this.#meeting(id);
    if (m.summary === null) throw new MeetingRowStateError('no_summary', id);
    const client = getClient(d.db, m.clientId);
    const docFileId = await uploadMeetingDoc(
      { db: d.db, api: d.drive },
      {
        clientId: m.clientId, clientName: client.name, title: m.title, startedAt: m.startedAt, seconds: m.audioSeconds ?? 0,
        attendees: this.#people(m), summary: m.summary, segments: m.transcript ?? [], transcriptCut: m.note === 'transcript_cut',
      },
    );
    advanceStage(d.db, id, 'doc', { docFileId }, this.#now());
    d.log.info({ meetingId: id }, 'meeting Doc created');
    return 'next';
  }

  /** doc -> tracked/done, in the tracker's own transaction (finishMeeting). */
  async #track(id: number): Promise<StageResult> {
    const d = this.#d;
    const m = this.#meeting(id);
    if (m.summary === null) throw new MeetingRowStateError('no_summary', id);
    const r = await d.track(m.clientId, { id, startedAt: m.startedAt, title: m.title, summary: m.summary, segments: m.transcript ?? [] });
    d.log.info({ meetingId: id, clientId: m.clientId, accepted: r.accepted, rejected: r.rejected, note: r.note ?? null }, 'meeting done');
    return 'done';
  }

  /**
   * Ends a stage that threw. `before` is the meeting as it was before the claim: a deferral stores its attempts back.
   * A meeting no longer queued (finished or changed meanwhile) is left as it is.
   */
  #settle(before: MeetingState, e: unknown, signal: AbortSignal): MeetingProcessOutcome {
    const { db, log } = this.#d;
    const id = before.id;
    const at = this.#now();
    const ids = { meetingId: id, clientId: before.clientId, stage: before.stage };
    const now = getMeetingState(db, id);
    if (now === undefined || now.status !== 'queued') {
      log.warn({ ...ids, code: stepCode(e), status: now?.status ?? null }, 'meeting step ended, but the meeting is no longer queued; left as it is');
      return 'skipped';
    }
    if (signal.aborted && (e === signal.reason || (e as { name?: unknown } | null)?.name === 'AbortError')) {
      deferMeeting(db, id, { errorCode: 'stopped', nextAttemptAt: at, attempts: before.attempts, at });
      log.info(ids, 'meeting step stopped by shutdown; it runs again at the next start');
      return 'stopped';
    }
    const deferral = this.#deferralCode(e);
    if (deferral !== null) {
      if (deferral === 'google_auth') this.#d.onGoogleAccess?.(false);
      if (deferral === 'stt_unavailable') {
        const since = this.#sttRefusedSince.get(id) ?? Date.parse(at);
        this.#sttRefusedSince.set(id, since);
        if (Date.parse(at) - since >= STT_UNAVAILABLE_MAX_MS) {
          this.#sttRefusedSince.delete(id);
          this.#fail(before, 'failed', 'stt_unavailable', at);
          return 'failed';
        }
      }
      const due = deferralDueAt(deferral, new Date(at)).toISOString();
      deferMeeting(db, id, { errorCode: deferral, nextAttemptAt: due, attempts: before.attempts, at });
      log.info({ ...ids, code: deferral, nextAttemptAt: due }, 'meeting waits');
      return 'deferred';
    }
    if (e instanceof MeetingFailure) {
      this.#fail(before, e.status, e.code, at);
      return 'failed';
    }
    if (e instanceof GoogleNoAccessError) {
      this.#fail(before, 'no_access', e.code, at);
      return 'failed';
    }
    if (e instanceof AiRefusalError) {
      // A refusal is booked already; trying again would pay again for the same answer.
      this.#fail(before, 'failed', 'ai_refusal', at);
      return 'failed';
    }
    if (e instanceof AiInvalidOutputError) {
      // summarizeMeeting and the tracker step each tried once more already, and both calls were booked.
      this.#fail(before, 'failed', 'ai_invalid_output', at);
      return 'failed';
    }
    const code = stepCode(e);
    const attempts = before.attempts + 1; // the attempt the claim counted
    if (attempts >= MEETING_MAX_ATTEMPTS) {
      this.#fail(before, 'failed', code, at);
      return 'failed';
    }
    const delay = MEETING_RETRY_DELAYS_MS[attempts - 1]!;
    const due = new Date(Date.parse(at) + delay).toISOString();
    deferMeeting(db, id, { errorCode: code, nextAttemptAt: due, at });
    log.warn({ ...ids, code, attempts, nextAttemptAt: due }, 'meeting step failed; it will be retried');
    return 'deferred';
  }

  /** The deferral code of an error that waits without counting an attempt, or null. */
  #deferralCode(e: unknown): string | null {
    if (e instanceof MeetingDeferral) return e.code;
    if (e instanceof SpendCapReachedError) return e.busy ? 'spend_busy' : 'spend_cap';
    if (e instanceof GoogleAccessError || e instanceof DriveAuthError) return 'google_auth';
    if (e instanceof DriveRootMissingError) return 'drive_root';
    return null;
  }

  /** A final status: speech parts left in flight are booked first, so a part that may have been billed is never lost. */
  #fail(before: MeetingState, status: 'failed' | 'no_access' | 'too_long', code: string, at: string): void {
    const { db, spend, inrPerUsd, clock, log } = this.#d;
    bookStuckParts(db, spend, before.id, { inrPerUsd, clock, log });
    failMeeting(db, before.id, { status, errorCode: code, at });
    this.#sttRefusedSince.delete(before.id);
    log.warn({ meetingId: before.id, clientId: before.clientId, stage: before.stage, status, code }, 'meeting could not be processed');
  }
}
