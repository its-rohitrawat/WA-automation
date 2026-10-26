import type { MeetingAi } from '../brain/meetingClient.ts';
import type { MeetingForTracker, MeetingTrackOutcome } from '../brain/reconciler.ts';
import type { DriveApi } from '../output/drive.ts';
import type { Prices } from '../spend/pricing.ts';
import type { SpendGuard } from '../spend/spendGuard.ts';
import type { Db } from '../store/db.ts';
import { meetingStats } from '../store/meetings.ts';
import type { Ffmpeg } from '../stt/audio.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import type { MeetingsGoogleApi } from './googleApi.ts';
import { GoogleAccessError } from './googleErrors.ts';
import type { MeetingsHealth } from './healthTypes.ts';
import { MeetingProcessor, type MeetingProcessResult } from './processor.ts';
import { MeetingQueue } from './queue.ts';
import type { MeetingTranscriber } from './transcribe.ts';
import { meetingsSince, MeetingWatcher, type ClientConfigLike } from './watcher.ts';

/** The meeting settings from the environment (M8). */
export interface MeetingSettings {
  /** TEAM_EMAIL_DOMAINS. */
  teamDomains: readonly string[];
  /** MEETING_POLL_MINUTES: how often discovery asks Google for new recordings. */
  pollMinutes: number;
  /** MEETING_MAX_MINUTES. */
  maxMinutes: number;
  /** MEETINGS_SINCE; unset: the day meetings were first switched on (kv meetings_since). */
  since?: string;
  /** INR_PER_USD. */
  inrPerUsd: number;
}

export interface MeetingServiceDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  dataDir: string;
  spend: SpendGuard;
  prices: Prices;
  drive: DriveApi;
  api: MeetingsGoogleApi;
  ai: MeetingAi;
  transcriber: MeetingTranscriber | null;
  ffmpeg: Ffmpeg | null;
  settings: MeetingSettings;
  clients: readonly ClientConfigLike[];
  freeBytes: (dir: string) => number | null;
  track: (clientId: number, meeting: MeetingForTracker) => Promise<MeetingTrackOutcome>;
  /** Read on every tick: false while the stored Google sign-in lacks the meeting scopes (no Google meeting call at all). */
  hasMeetingScopes: () => boolean;
  /** New rows were found, or a meeting finished or failed: the workbook should be rebuilt. */
  onChanged: () => void;
}

/**
 * Meetings inside the app (Task 10): discovery at most every MEETING_POLL_MINUTES (never two passes at once), the queue
 * kicked on every tick, the paused state for Health. Without the meeting scopes nothing calls Google's meeting APIs.
 */
export class MeetingService {
  readonly #d: MeetingServiceDeps;
  readonly #watcher: MeetingWatcher;
  readonly #queue: MeetingQueue;
  readonly #abort = new AbortController();
  #discovering: Promise<void> | undefined;
  #lastDiscoverMs: number | undefined;
  /** The sign-in or a meeting scope was refused by Google; cleared when a Google meeting call works again. */
  #googleAuthLost = false;
  #stopped = false;

  constructor(d: MeetingServiceDeps) {
    this.#d = d;
    const since = meetingsSince(d.db, d.settings.since, d.clock.now());
    this.#watcher = new MeetingWatcher({
      db: d.db, api: d.api, clock: d.clock, log: d.log, clients: d.clients,
      settings: { teamDomains: d.settings.teamDomains, maxMinutes: d.settings.maxMinutes, since },
    });
    const processor = new MeetingProcessor({
      db: d.db, spend: d.spend, prices: d.prices, clock: d.clock, log: d.log, dataDir: d.dataDir, api: d.api, drive: d.drive, ai: d.ai,
      transcriber: d.transcriber, ffmpeg: d.ffmpeg, maxMinutes: d.settings.maxMinutes, inrPerUsd: d.settings.inrPerUsd,
      teamDomains: d.settings.teamDomains, freeBytes: d.freeBytes, track: d.track, hasMeetingScopes: d.hasMeetingScopes,
      onGoogleAccess: (ok) => {
        this.#googleAuthLost = !ok;
      },
    });
    this.#queue = new MeetingQueue({
      db: d.db, clock: d.clock, log: d.log, spend: d.spend, dataDir: d.dataDir, transcriber: d.transcriber, inrPerUsd: d.settings.inrPerUsd,
      processor,
      onSettled: (r: MeetingProcessResult) => {
        if (r.outcome === 'done' || r.outcome === 'failed') d.onChanged();
      },
    });
  }

  start(): void {
    this.#queue.start();
  }

  /** From the app's tick: discovery when due, then the queue. Never throws. */
  tick(): void {
    if (this.#stopped) return;
    try {
      this.#maybeDiscover();
    } catch (err) {
      this.#d.log.error({ err }, 'meeting discovery could not start');
    }
    this.#queue.kick();
  }

  #maybeDiscover(): void {
    if (this.#discovering || !this.#d.hasMeetingScopes()) return;
    const now = this.#d.clock.now().getTime();
    if (this.#lastDiscoverMs !== undefined && now - this.#lastDiscoverMs < this.#d.settings.pollMinutes * 60_000) return;
    this.#lastDiscoverMs = now;
    this.#discovering = this.#watcher
      .discover(this.#abort.signal)
      .then((r) => {
        this.#googleAuthLost = false;
        if (r.added > 0) {
          this.#d.onChanged();
          this.#queue.kick();
        }
      })
      .catch((err: unknown) => {
        if (this.#abort.signal.aborted) return;
        if (err instanceof GoogleAccessError) {
          this.#googleAuthLost = true;
          this.#d.log.warn({ code: err.code }, 'meeting discovery paused: Google sign-in or a meeting permission is missing');
          return;
        }
        this.#d.log.error({ err }, 'meeting discovery failed');
      })
      .finally(() => {
        this.#discovering = undefined;
      });
  }

  /** The configs after a reload reach the watcher; the next pass matches against them. */
  setClients(clients: readonly ClientConfigLike[]): void {
    this.#watcher.setClients(clients);
  }

  /** What Health shows about meetings now. */
  health(): MeetingsHealth {
    const paused: MeetingsHealth['paused'] = !this.#d.hasMeetingScopes()
      ? 'google_scopes'
      : this.#googleAuthLost
        ? 'google_auth'
        : this.#d.ffmpeg === null
          ? 'no_ffmpeg'
          : null;
    return {
      stats: meetingStats(this.#d.db, this.#d.clock.now().toISOString()),
      paused,
      sttProvider: this.#d.transcriber?.provider ?? 'none',
    };
  }

  /** No new discovery pass or meeting; a pass in flight and a download or ffmpeg run are aborted. */
  stop(): void {
    this.#stopped = true;
    this.#abort.abort();
    this.#queue.stop();
  }

  /** Waits for the running meeting (its tracker step included), the queue's start-up and a discovery pass, up to ms. */
  async drain(timeoutMs: number): Promise<void> {
    // The queue's drain is bounded by timeoutMs; a discovery pass ends soon after stop() aborted it.
    await Promise.all([this.#queue.drain(timeoutMs), this.#discovering]);
  }
}
