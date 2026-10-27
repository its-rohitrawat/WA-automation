import { statfsSync } from 'node:fs';
import type { ReconcileOutcome } from '../brain/reconciler.ts';
import type { MeetingsHealth } from '../meetings/healthTypes.ts';
import type { HealthLine } from '../output/view.ts';
import { MASKED_NUMBER, type ReportHealth } from '../report/types.ts';
import type { SpendGuard, SpendKind } from '../spend/spendGuard.ts';
import type { Db } from '../store/db.ts';
import { getKv, setKv } from '../store/kv.ts';
import type { MediaStats } from '../store/media.ts';
import type { Clock } from '../util/clock.ts';
import { istDate, istShortDate, istTime } from '../util/time.ts';
import type { GatewayStatus } from '../wa/gateway.ts';

const LOW_DISK_GB = 10;
const DISCONNECT_GRACE_MS = 30 * 60_000;
const PUBLISH_FAIL_MS = 60 * 60_000;
const SPEND_CAP_LINE = '⚠️ Daily spend cap reached. Paused until midnight IST';
const STT_REFUSED_LINE = '⚠️ Voice notes are not being transcribed: the speech-to-text key was refused.';
/**
 * Voice notes that failed on this computer in the last 24 hours (mediaStats.voiceFailed); docs/SETUP.md lists the line.
 * "On this computer", not "by the local engine" (Phase 2b final polish): an ffmpeg failure counts too, with any provider.
 */
export const voiceFailedLine = (n: number) => `⚠️ ${n} voice note${n === 1 ? '' : 's'} could not be transcribed on this computer. See docs/SETUP.md, Voice notes`;

/**
 * Why voice notes are not transcribed at all, found when the service starts (Phase 2b Task 10, src/voiceDeps.ts):
 * VOICE_STT_PROVIDER is local but STT_LOCAL_BIN (local_not_set_up_bin) or STT_LOCAL_MODEL (local_not_set_up_model) is
 * not a file, or ffmpeg was not found. The notes are kept; the service runs on. The line names the setting, never its path.
 */
export type VoiceProblem = 'local_not_set_up_bin' | 'local_not_set_up_model' | 'no_ffmpeg';
/** The Health line for each problem; docs/SETUP.md ("Voice note status lines") lists each one, without the ⚠️. */
export const VOICE_PROBLEM_LINES: Readonly<Record<VoiceProblem, string>> = {
  local_not_set_up_bin: '⚠️ Voice notes are not being transcribed: the local speech engine is not set up (STT_LOCAL_BIN)',
  local_not_set_up_model: '⚠️ Voice notes are not being transcribed: the local speech engine is not set up (STT_LOCAL_MODEL)',
  no_ffmpeg: '⚠️ Voice notes are not being transcribed: ffmpeg not found',
};

export type MediaHealth = MediaStats;
/**
 * The shared-file counts as a snapshot stores them: snapshots written before Phase 2b have no sttRefused, and those
 * written before the Phase 2b final review no voiceFailed.
 */
export type MediaSnapshot = Omit<MediaStats, 'sttRefused' | 'voiceFailed'> & { sttRefused?: number; voiceFailed?: number };
export type { MeetingsHealth } from '../meetings/healthTypes.ts';

export interface HealthSnapshot {
  at: string;
  line: HealthLine;
  whatsapp: GatewayStatus;
  downSince: string | null;
  failed: { clientId: number; errorCode: string }[];
  lastSuccessAt: string | null;
  lastPublishedAt: string | null;
  spentToday: number;
  capUsd: number;
  freeGb: number | null;
  publishFailingSince: string | null;
  /** Incoming WhatsApp events that could not be saved since the service started (lost from the tracker). */
  ingestFailures: number;
  /**
   * Shared files: waiting, waiting too long, waiting for the daily budget, failed in the last 24 h, Drive uploads that
   * gave up, voice notes waiting for a refused speech-to-text key, voice notes that failed on this computer in the last
   * 24 hours. Missing in older snapshots; sttRefused missing in snapshots written before Phase 2b, voiceFailed in those
   * written before its final review.
   */
  media?: MediaSnapshot;
  /** Meeting counts and pauses; missing while meetings are switched off, and in older snapshots. */
  meetings?: MeetingsHealth;
  /** spentToday split by kind: AI calls and speech-to-text. Missing in older snapshots. */
  spendByKind?: Record<SpendKind, number>;
  /** The morning report's line (Phase 2c). Missing when the report is off, and in older snapshots. */
  report?: ReportHealth;
  /** Why voice notes are not transcribed (Phase 2b Task 10). Missing when they are (or are off), and in older snapshots. */
  voiceProblem?: VoiceProblem;
}

/**
 * Free bytes for this process on the volume of dir; null when it cannot be read. Meeting audio (src/meetings/audio.ts)
 * must treat a null as 0, so an unreadable disk defers the meeting low_disk.
 */
export function defaultFreeBytes(dir: string): number | null {
  try {
    const s = statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

const stamp = (d: Date) => `${istShortDate(d)} ${istTime(d)}`;

export class Health {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #spend: SpendGuard;
  readonly #dataDir: string;
  readonly #freeBytes: (dir: string) => number | null;
  #wa: GatewayStatus;
  #downSince: Date | null;
  #failed = new Map<number, string>();
  #paused = new Map<number, string>(); // clientId -> IST day
  #publishFailedSince: Date | null = null;
  #publishAuthFailed = false;
  #lastSuccess: Date | null = null;
  #lastPublished: Date | null = null;
  #ingestFailures = 0;
  #media: MediaHealth = { pending: 0, stale: 0, spendCap: 0, failedRecent: 0, uploadFailed: 0, sttRefused: 0, voiceFailed: 0 };
  #meetings: MeetingsHealth | null = null;
  #report: ReportHealth | null = null;
  #voiceProblem: VoiceProblem | null = null;

  constructor(o: { db: Db; clock: Clock; spend: SpendGuard; dataDir?: string; freeBytes?: (dir: string) => number | null }) {
    this.#db = o.db;
    this.#clock = o.clock;
    this.#spend = o.spend;
    this.#dataDir = o.dataDir ?? '.';
    this.#freeBytes = o.freeBytes ?? defaultFreeBytes;
    const now = this.#clock.now();
    this.#wa = { state: 'stopped', since: now.toISOString(), lastErrorCode: null, credsSaveFailures: 0 };
    this.#downSince = now; // not connected yet
  }

  setWhatsApp(s: GatewayStatus): void {
    this.#wa = s;
    if (s.state === 'open') this.#downSince = null;
    else this.#downSince ??= new Date(s.since);
    this.persist();
  }

  recordOutcome(clientId: number, o: ReconcileOutcome): void {
    // Waiting for shared files to be read says nothing about the AI: a failed or paused group stays as it was. Nor does a
    // run kept out only by holds of paid calls in flight (busy): the cap is not reached, so it must not show the
    // spend-cap line, and it clears nothing (Task 15 review round 3).
    if (o.status === 'waiting' || o.status === 'busy') return;
    if (o.status === 'paused') this.#paused.set(clientId, istDate(this.#clock.now()));
    else {
      this.#paused.delete(clientId);
      if (o.status === 'failed') this.#failed.set(clientId, o.errorCode);
      else this.#failed.delete(clientId);
    }
    if (o.status === 'ok') this.#lastSuccess = this.#clock.now();
    this.persist();
  }

  /** Stores the count of incoming messages that could not be saved; the next persist() records it. */
  setIngestFailures(n: number): void {
    this.#ingestFailures = n;
  }

  /** Stores the shared-file counts; the next persist() records them. */
  setMedia(m: MediaHealth): void {
    this.#media = m;
  }

  /** Stores the meeting counts and pauses (a copy); null: meetings are switched off (no lines). The next persist() records them. */
  setMeetings(m: MeetingsHealth | null): void {
    this.#meetings = m === null ? null : { ...m, stats: { ...m.stats, deferred: { ...m.stats.deferred } } };
  }

  /** Stores the morning report's line; the next persist() records it. Null when the report is off. */
  setReport(r: ReportHealth | null): void {
    this.#report = r;
  }

  /** Stores why voice notes are not transcribed (null: nothing wrong, or voice notes are off); the next persist() records it. */
  setVoiceProblem(p: VoiceProblem | null): void {
    this.#voiceProblem = p;
  }

  forget(clientId: number): void {
    this.#failed.delete(clientId);
    this.#paused.delete(clientId);
  }

  markPublishFailed(f: { step: 'build' | 'drive'; auth: boolean }): void {
    this.#publishFailedSince ??= this.#clock.now();
    this.#publishAuthFailed = f.auth;
    this.persist();
  }

  markPublished(): void {
    this.#lastPublished = this.#clock.now();
    this.#publishFailedSince = null;
    this.#publishAuthFailed = false;
    this.persist();
  }

  #hasPaused(now: Date): boolean {
    const today = istDate(now);
    for (const day of this.#paused.values()) if (day === today) return true;
    return false;
  }

  #freeGb(): number | null {
    const bytes = this.#freeBytes(this.#dataDir);
    return bytes === null ? null : bytes / 1e9;
  }

  line(): HealthLine {
    return this.#compute(true);
  }

  /** Same as line() but without publish failures: used inside the uploaded workbook. */
  workbookLine(): HealthLine {
    return this.#compute(false);
  }

  #compute(withPublish: boolean): HealthLine {
    const now = this.#clock.now();
    const since = stamp(new Date(this.#wa.since));
    if (this.#wa.state === 'logged_out') return { ok: false, text: `❌ WhatsApp unlinked since ${since}. Follow docs/SETUP.md → "Status logged_out".` };
    if (this.#wa.state === 'replaced') return { ok: false, text: `❌ Another copy of WA Agent took over the WhatsApp session at ${since}. Stop the other copy, then restart the service.` };
    if (this.#wa.state === 'forbidden') return { ok: false, text: `❌ WhatsApp refused this number (403) since ${since}. Check the founder's phone.` };
    if (this.#downSince && now.getTime() - this.#downSince.getTime() > DISCONNECT_GRACE_MS) {
      return { ok: false, text: `❌ Disconnected since ${stamp(this.#downSince)}` };
    }
    const pubFail = withPublish ? this.#publishFailedSince : null;
    if (pubFail && this.#publishAuthFailed) return { ok: false, text: '❌ Google sign-in expired. Run: npm run cli -- google-auth, then restart the service' };
    if (this.#wa.credsSaveFailures > 0) return { ok: false, text: '⚠️ The WhatsApp session could not be saved. Check disk space and the data folder permissions.' };
    if (pubFail && now.getTime() - pubFail.getTime() > PUBLISH_FAIL_MS) {
      return { ok: false, text: `⚠️ Tracker update failing since ${stamp(pubFail)}` };
    }
    // Shared files deferred by the daily cap are covered by this line only when the cap is really reached; until then
    // they get their own line below (amendment 15b, review round 1).
    if (this.#spend.isPaused() || this.#hasPaused(now)) return { ok: false, text: SPEND_CAP_LINE };
    if (this.#failed.size > 0) {
      const n = this.#failed.size;
      return { ok: false, text: `⚠️ ${n} group${n === 1 ? '' : 's'} waiting (AI error)` };
    }
    if (this.#ingestFailures > 0) {
      const n = this.#ingestFailures;
      return { ok: false, text: `⚠️ ${n} incoming message${n === 1 ? '' : 's'} could not be saved. See docs/SETUP.md.` };
    }
    if (this.#media.stale > 0) {
      const n = this.#media.stale;
      return { ok: false, text: `⚠️ ${n} shared file${n === 1 ? '' : 's'} waiting over 30 minutes to be read. See docs/SETUP.md.` };
    }
    if (this.#media.uploadFailed > 0) {
      const n = this.#media.uploadFailed;
      return { ok: false, text: `⚠️ ${n} file${n === 1 ? '' : 's'} could not be uploaded to Drive. See docs/SETUP.md.` };
    }
    // Voice notes wait for a speech-to-text key that was refused: the owner must fix STT_API_KEY. Above the budget line
    // (Phase 2b final polish, as in Task 9), because those notes give up after 24 hours: the owner must see it in time.
    // They are not counted as waiting too long (mediaStats.stale), so the long-wait line above never hides this one.
    if (this.#media.sttRefused > 0) return { ok: false, text: STT_REFUSED_LINE };
    // A paid read holds its ceiling (about $4 for a scan) while it runs, so a file can wait for the budget long before
    // the cap is reached. Nothing is paused and nothing needs the owner, so this comes after the warnings above.
    if (this.#media.spendCap > 0) {
      const n = this.#media.spendCap;
      return { ok: false, text: `⚠️ ${n} shared file${n === 1 ? '' : 's'} waiting for today's AI budget (read after midnight IST)` };
    }
    // After the file lines and before low disk: the morning report's warning first, then the meeting lines.
    // The morning report warns only when the owner must act: an unknown outcome, or a spare number that is unlinked.
    if (this.#report?.warning) return { ok: false, text: this.#report.warning };
    const meeting = this.#meetingLine();
    if (meeting !== null) return { ok: false, text: meeting };
    const free = this.#freeGb();
    if (free !== null && free < LOW_DISK_GB) return { ok: false, text: `⚠️ Low disk: ${free.toFixed(1)} GB free` };
    // The other voice lines come last (Phase 2b final review), so they never hide the morning report's warning, a meeting
    // line or low disk. The tracker keeps working without the notes (it waits 30 minutes for one at most), and the notes
    // are kept, to be transcribed once the cause is fixed. The key-refused line is not among them (final polish): it sits
    // above the budget line, since notes waiting on a refused key give up after 24 hours. Among these, the most basic
    // cause first:
    // - not transcribed at all: the local engine's files or ffmpeg were missing at start (set up, then restart);
    // - notes that could not be transcribed on this computer (`cli transcribe-voice --failed`, local engine only).
    if (this.#voiceProblem !== null) return { ok: false, text: VOICE_PROBLEM_LINES[this.#voiceProblem] };
    if (this.#media.voiceFailed > 0) return { ok: false, text: voiceFailedLine(this.#media.voiceFailed) };
    return { ok: true, text: this.#lastSuccess ? `✅ Connected · last update ${stamp(this.#lastSuccess)}` : '✅ Connected · waiting for new messages' };
  }

  /** The meeting warning, if any, in this order (after the file lines, before low disk). Null while meetings are off. */
  #meetingLine(): string | null {
    const m = this.#meetings;
    if (m === null) return null;
    if (m.paused === 'google_scopes' || m.paused === 'google_auth') {
      return '⚠️ Meetings paused: Google sign-in needs meeting access. Run: npm run cli -- google-auth';
    }
    if (m.paused === 'no_ffmpeg') return '⚠️ Meetings paused: ffmpeg not found';
    if (m.stats.failed > 0) {
      const n = m.stats.failed;
      return `⚠️ ${n} meeting${n === 1 ? '' : 's'} could not be processed`;
    }
    if (m.sttProvider === 'none' && m.stats.waiting > 0) return '⚠️ Meetings waiting: speech-to-text is not set up';
    if ((m.stats.deferred.stt_unavailable ?? 0) > 0) return '⚠️ Meetings waiting: the speech-to-text key was refused';
    return null;
  }

  snapshot(): HealthSnapshot {
    return {
      at: this.#clock.now().toISOString(),
      line: this.line(),
      whatsapp: this.#wa,
      downSince: this.#downSince?.toISOString() ?? null,
      failed: [...this.#failed].map(([clientId, errorCode]) => ({ clientId, errorCode })),
      lastSuccessAt: this.#lastSuccess?.toISOString() ?? null,
      lastPublishedAt: this.#lastPublished?.toISOString() ?? null,
      spentToday: this.#spend.spentToday(),
      capUsd: this.#spend.capUsd,
      freeGb: this.#freeGb(),
      publishFailingSince: this.#publishFailedSince?.toISOString() ?? null,
      ingestFailures: this.#ingestFailures,
      media: { ...this.#media },
      ...(this.#meetings === null ? {} : { meetings: { ...this.#meetings, stats: { ...this.#meetings.stats, deferred: { ...this.#meetings.stats.deferred } } } }),
      spendByKind: this.#spend.spentTodayByKind(),
      ...(this.#report ? { report: { ...this.#report } } : {}),
      ...(this.#voiceProblem === null ? {} : { voiceProblem: this.#voiceProblem }),
    };
  }

  persist(): void {
    setKv(this.#db, 'health', JSON.stringify(this.snapshot()));
  }
}

const MEDIA_COUNTS = ['pending', 'stale', 'spendCap', 'failedRecent', 'uploadFailed'] as const;

/** sttRefused and voiceFailed are checked separately: snapshots written before Phase 2b (or its final review) lack them. */
const OPTIONAL_MEDIA_COUNTS = ['sttRefused', 'voiceFailed'] as const;
const isMediaSnapshot = (m: unknown): m is MediaSnapshot => {
  const x = m as Record<string, unknown> | null;
  return (
    typeof x === 'object' && x !== null && MEDIA_COUNTS.every((k) => typeof x[k] === 'number') &&
    OPTIONAL_MEDIA_COUNTS.every((k) => x[k] === undefined || typeof x[k] === 'number')
  );
};

const MEETING_COUNTS = ['done', 'waiting', 'unassigned', 'failed', 'noAccess', 'tooLong', 'internal'] as const;
const MEETING_PAUSES = new Set<unknown>([null, 'google_scopes', 'google_auth', 'no_ffmpeg']);
const STT_PROVIDERS = new Set<unknown>(['sarvam', 'elevenlabs', 'openai', 'none']);

/** The counts' shape; the pause and provider values are checked separately (isKnownMeetingsState). */
const isMeetingsHealth = (m: unknown): m is MeetingsHealth => {
  const x = m as Record<string, unknown> | null;
  if (typeof x !== 'object' || x === null) return false;
  const s = x.stats as Record<string, unknown> | null;
  if (typeof s !== 'object' || s === null || !MEETING_COUNTS.every((k) => typeof s[k] === 'number')) return false;
  const d = s.deferred as Record<string, unknown> | null;
  return typeof d === 'object' && d !== null && !Array.isArray(d) && Object.values(d).every((n) => typeof n === 'number');
};

const isKnownMeetingsState = (m: MeetingsHealth): boolean => MEETING_PAUSES.has(m.paused) && STT_PROVIDERS.has(m.sttProvider);

const isSpendByKind = (v: unknown): v is Record<SpendKind, number> => {
  const x = v as Record<string, unknown> | null;
  return typeof x === 'object' && x !== null && typeof x.ai === 'number' && typeof x.stt === 'number';
};

const isReportHealth = (r: unknown): r is ReportHealth => {
  const x = r as Record<string, unknown> | null;
  return (
    typeof x === 'object' && x !== null && typeof x.text === 'string' && (x.warning === null || typeof x.warning === 'string') &&
    // Missing in snapshots of an older service; otherwise only a last-4-digits mask, never a full number.
    (x.recipientMasked === undefined || (typeof x.recipientMasked === 'string' && MASKED_NUMBER.test(x.recipientMasked)))
  );
};

const isVoiceProblem = (p: unknown): p is VoiceProblem => typeof p === 'string' && Object.hasOwn(VOICE_PROBLEM_LINES, p);

export function readHealthSnapshot(db: Db): HealthSnapshot | undefined {
  const v = getKv(db, 'health');
  if (!v) return undefined;
  try {
    const o = JSON.parse(v) as Partial<HealthSnapshot> | null;
    if (!o || typeof o !== 'object' || typeof o.at !== 'string') return undefined;
    if (!o.line || typeof o.line.text !== 'string' || typeof o.line.ok !== 'boolean') return undefined;
    if (Number.isNaN(Date.parse(o.at))) return undefined;
    if (!o.whatsapp || typeof o.whatsapp.state !== 'string') return undefined;
    if (typeof o.whatsapp.since !== 'string' || Number.isNaN(Date.parse(o.whatsapp.since))) return undefined;
    if (o.freeGb !== null && typeof o.freeGb !== 'number') return undefined;
    if (typeof o.spentToday !== 'number' || typeof o.capUsd !== 'number' || !Array.isArray(o.failed)) return undefined;
    // Snapshots written before ingestFailures existed still parse.
    if (o.ingestFailures !== undefined && typeof o.ingestFailures !== 'number') return undefined;
    // Snapshots written before media counts existed still parse.
    if (o.media !== undefined && !isMediaSnapshot(o.media)) return undefined;
    // Snapshots written before meetings, or with meetings off, have no meetings; older ones no spend split.
    if (o.meetings !== undefined && !isMeetingsHealth(o.meetings)) return undefined;
    if (o.spendByKind !== undefined && !isSpendByKind(o.spendByKind)) return undefined;
    // Snapshots written before the morning report existed, or with it off, have no report line.
    if (o.report !== undefined && !isReportHealth(o.report)) return undefined;
    // A pause reason or provider this version does not know (a newer writer) drops only the meetings, not the snapshot.
    // So does a voice problem it does not know (including the earlier 'local_not_set_up', written before the problem
    // named its setting): only that field is dropped. Snapshots before Task 10 have none.
    const { meetings, voiceProblem, ...rest } = o;
    const keep = meetings !== undefined && isKnownMeetingsState(meetings) ? { meetings } : {};
    const voice = isVoiceProblem(voiceProblem) ? { voiceProblem } : {};
    return { ...rest, ...keep, ...voice, ingestFailures: o.ingestFailures ?? 0 } as HealthSnapshot;
  } catch {
    return undefined;
  }
}
