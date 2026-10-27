import { lstatSync, readdirSync, rmSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import type { AiClient } from './brain/claudeClient.ts';
import { GroupDebouncer } from './brain/debouncer.ts';
import type { MediaAi } from './brain/mediaClient.ts';
import type { MeetingAi } from './brain/meetingClient.ts';
import { Reconciler, type ReconcileOutcome } from './brain/reconciler.ts';
import type { ClientConfig } from './config/groups.ts';
import { Health, type VoiceProblem } from './health/health.ts';
import { defaultFreeBytes } from './health/health.ts';
import { createExtractor, type Extractor } from './media/extract.ts';
import type { MediaFetcher } from './media/fetch.ts';
import { MediaProcessor } from './media/processor.ts';
import { MEDIA_MAX_WAIT_MS } from './media/promptText.ts';
import { MediaQueue } from './media/queue.ts';
import type { MediaRefSealer } from './media/ref.ts';
import { DriveFileUploader } from './media/uploader.ts';
import { forgetVoiceCopies } from './media/voiceForget.ts';
import type { MeetingsGoogleApi } from './meetings/googleApi.ts';
import type { MeetingsHealth } from './meetings/healthTypes.ts';
import { MeetingService, type MeetingSettings } from './meetings/service.ts';
import { errorCode } from './meetings/sttParts.ts';
import type { MeetingTranscriber } from './meetings/transcribe.ts';
import type { ClientConfigLike } from './meetings/watcher.ts';
import { DrivePublisher, type DriveApi } from './output/drive.ts';
import { hasMeetingScopes } from './output/googleAuth.ts';
import { loadTrackerView } from './output/view.ts';
import { buildWorkbook } from './output/workbook.ts';
import { ReportScheduler } from './report/scheduler.ts';
import type { ReportSender, ReportSettings } from './report/types.ts';
import type { Prices } from './spend/pricing.ts';
import { SpendGuard } from './spend/spendGuard.ts';
import { getClient, listClients, syncClients } from './store/clients.ts';
import type { Db } from './store/db.ts';
import { getKv, setKv } from './store/kv.ts';
import { mediaStats, resetUploadFailures } from './store/media.ts';
import { clientIdsWithUnprocessed } from './store/messages.ts';
import type { Ffmpeg } from './stt/audio.ts';
import type { VoiceTranscriber } from './stt/voice.ts';
import type { Clock } from './util/clock.ts';
import type { Logger } from './util/logger.ts';
import type { AllowList } from './wa/allowlist.ts';
import type { WhatsAppGateway } from './wa/gateway.ts';
import { Ingestor } from './wa/ingest.ts';

export interface AppMediaDeps {
  sealer: MediaRefSealer;
  fetcher: MediaFetcher;
  ai: MediaAi;
  /** Test seam: replaces the standard extractor (Claude vision, PDF and DOCX readers). */
  extract?: Extractor;
  /**
   * Files downloaded and read at once. Default 3 (Phase 2b Task 10): a slow voice note must not hold every slot while
   * pictures wait. With the local engine, at most one of them is a voice note or audio file (the queue's voice lane).
   */
  concurrency?: number;
  /**
   * The voice transcriber VOICE_STT_PROVIDER names (Phase 2b, src/voiceDeps.ts). Null or absent: voice notes are kept,
   * not transcribed, as in 2a.
   */
  voice?: VoiceTranscriber | null;
  /** STT_MAX_SECONDS: the longest voice note or audio file transcribed. Default: the extractor's (600). */
  maxVoiceSeconds?: number;
  /** Why voice notes are not transcribed, found at start; shown in the health line. */
  voiceProblem?: VoiceProblem | null;
}

/** Phase 3 meetings. Built only when MEETINGS_ENABLED is true; without the meeting scopes nothing calls Google's meeting APIs. */
export interface AppMeetingsDeps {
  api: MeetingsGoogleApi;
  ai: MeetingAi;
  /** null: STT_PROVIDER none; meetings are found and matched but wait (stt_none). */
  transcriber: MeetingTranscriber | null;
  /** null: ffmpeg not found; meetings are paused (no_ffmpeg). */
  ffmpeg: Ffmpeg | null;
  settings: MeetingSettings;
  /** The configs at start; reloadClients passes later ones on. */
  clients: readonly ClientConfigLike[];
}

/** The Phase 2c morning report. Only the spare-number sender can send; the founder-number gateway still cannot. */
export interface AppReportDeps {
  sender: ReportSender;
  settings: ReportSettings;
}

export interface AppDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  gateway: WhatsAppGateway;
  allow: AllowList;
  ai: AiClient;
  drive: DriveApi;
  prices: Prices;
  spendCapUsd: number;
  quietMs: number;
  maxWaitMs: number;
  maxConcurrent: number;
  dataDir: string;
  /** How often the tick picks up CLI requests and persists health. Default 30 s. */
  pollMs?: number;
  publishIntervalMs?: number;
  freeBytes?: (dir: string) => number | null;
  /** How long stop() waits for AI calls and file reads in flight. Default 120 s (WinSW stoptimeout is 150 s). */
  drainMs?: number;
  /**
   * When the service started. The reconciler's 30-minute wait for a file, the "waiting over 30 minutes" count in Health
   * and the processor's 24 hours of waits for Claude all count from the file's arrival or from this time, whichever is
   * later (amendments 10f, 12a, 15a, 15f). Default: the clock's time when the app is made.
   */
  startedAt?: Date;
  /** The Phase 2a media pipeline. Without it, shared files are recorded as not downloaded. */
  media?: AppMediaDeps;
  /** Phase 3 meetings. Without it, no meeting call of any kind is made. */
  meetings?: AppMeetingsDeps;
  /** Also gets the meetings' health on every tick (null when meetings are off); the health line gets it either way. */
  onMeetingsHealth?: (m: MeetingsHealth | null) => void;
  /** The Phase 2c morning report. Without it, no report is sent and Health has no report line. */
  report?: AppReportDeps;
}

export interface App {
  /**
   * Starts the service. With the media pipeline it first removes leftover voice-<digits> conversion folders in
   * DATA_DIR/tmp/voice (before any file starts), then deletes the voice-note copies due at the speech provider, and
   * again every hour.
   */
  start(): void;
  /**
   * Starts no new AI run, file read or file upload, and stops a local speech engine run in flight (free: the voice note
   * is tried again after the restart). Waits for AI calls and file reads in flight (up to drainMs) and
   * books any paid call still running at its estimate. Then flushes the publisher (the upload in flight plus one more
   * if anything changed) and waits for the file upload in flight, up to 10 s each in parallel. Leaves no timers.
   */
  stop(): Promise<void>;
  /** Applies a new allow-list. Throws, leaving the old allow-list in place, if the config conflicts with the DB. */
  reloadClients(configs: ClientConfig[]): void;
  health: Health;
  publisher: DrivePublisher;
  debouncer: GroupDebouncer;
  /** Undefined without media dependencies. */
  mediaQueue: MediaQueue | undefined;
  /** Undefined without meeting dependencies. */
  meetings: MeetingService | undefined;
  /** Undefined without report dependencies. */
  report: ReportScheduler | undefined;
}

/**
 * Wires gateway -> ingestor -> media queue / debouncer -> reconciler -> publisher. The founder-number gateway never sends
 * anything. The only sender is the optional morning report's, on the spare number, to REPORT_RECIPIENT only.
 */
export function createApp(d: AppDeps): App {
  const startedAt = d.startedAt ?? d.clock.now();
  const spend = new SpendGuard({ db: d.db, clock: d.clock, capUsd: d.spendCapUsd });
  const health = new Health({ db: d.db, clock: d.clock, spend, dataDir: d.dataDir, freeBytes: d.freeBytes });
  const reportScheduler = d.report
    ? new ReportScheduler({
        db: d.db, clock: d.clock, log: d.log, sender: d.report.sender, settings: d.report.settings, healthLine: () => health.workbookLine(),
      })
    : undefined;
  /** The health line in the workbook being built, and in the last one that reached Drive (the tick compares it). */
  let buildingLine: string | undefined;
  let publishedLine: string | undefined;
  const publisher = new DrivePublisher({
    db: d.db,
    api: d.drive,
    log: d.log,
    minIntervalMs: d.publishIntervalMs,
    // workbookLine() leaves out publish failures: if this upload succeeds, they are already over.
    build: () => {
      const line = health.workbookLine();
      buildingLine = line.text;
      return buildWorkbook(loadTrackerView(d.db, d.clock.now(), line));
    },
    onPublished: () => {
      publishedLine = buildingLine; // one publish runs at a time, so this is the line of the upload that just succeeded
      // The first publish creates the Drive root the file uploads need. A publish also follows every role change
      // (the reconciler's, and the CLI's through its rebuild request), which can make a sender's files due.
      void uploader?.run();
      health.markPublished();
    },
    onFailure: (f) => health.markPublishFailed(f),
  });

  /** Health writes its snapshot to the DB. A busy DB must not turn a finished run into a crash, or break a callback. */
  const safely = (fn: () => void, fields: Record<string, unknown> = {}) => {
    try {
      fn();
    } catch (err) {
      d.log.error({ ...fields, err }, 'health update failed');
    }
  };
  /**
   * Gives Health the current shared-file counts. Called before a publish that a file change or a client change asked
   * for, so the workbook's health line does not show counts from the last tick (final review).
   */
  const refreshMedia = () => health.setMedia(mediaStats(d.db, d.clock.now(), startedAt, MEDIA_MAX_WAIT_MS));
  /** False once reloadClients removed the client. If the lookup itself fails, assume active and record as usual. */
  const stillActive = (clientId: number): boolean => {
    try {
      return getClient(d.db, clientId).active;
    } catch (err) {
      d.log.error({ clientId, err }, 'client lookup failed');
      return true;
    }
  };
  const record = (clientId: number, outcome: ReconcileOutcome) => {
    // Removed while its run was in flight: reloadClients already forgot it, so its warning must not come back.
    if (!stillActive(clientId)) return;
    safely(() => health.recordOutcome(clientId, outcome), { clientId });
    // The publisher is throttled, so this is cheap, and the workbook stops showing ✅ while groups fail.
    // A run that is waiting for shared files, or kept out by other paid calls in flight (busy), changed nothing, so it
    // publishes nothing.
    if (outcome.status === 'failed' || outcome.status === 'paused') publisher.schedule();
  };

  const reconciler = new Reconciler({
    db: d.db, ai: d.ai, spend, prices: d.prices, clock: d.clock, log: d.log, startedAt,
    // Phase 2b final review: voice notes hold up their messages (30 minutes at most) only while a transcriber is set up.
    // With VOICE_STT_PROVIDER none, or the local engine not set up, no transcript is coming: they never wait, as in 2a.
    voiceTranscriptionOn: (d.media?.voice ?? null) !== null,
    // A meeting's tracker step finishes the meeting here: the rebuild gets the meeting counts of now.
    onChanged: () => {
      safely(refreshMeetings);
      publisher.schedule();
    },
    // A meeting's tracker step holds the client's run flag, so it never interleaves with a WhatsApp run (Task 9).
    exclusive: (clientId, fn) => debouncer.runExclusive(clientId, fn),
  });
  const debouncer = new GroupDebouncer({
    quietMs: d.quietMs,
    maxWaitMs: d.maxWaitMs,
    maxConcurrent: d.maxConcurrent,
    run: async (clientId) => {
      const outcome = await reconciler.run(clientId);
      record(clientId, outcome);
      return outcome;
    },
    onError: (clientId, err) => {
      // The logger's err serializer keeps type, code and stack frames, and drops the message.
      d.log.error({ clientId, err }, 'reconcile crashed');
      record(clientId, { status: 'failed', errorCode: 'crash' });
    },
  });

  const m = d.media;
  /** The voice transcriber, if any (Phase 2b). Only with the media pipeline. */
  const voice = m?.voice ?? null;
  safely(() => health.setVoiceProblem(m?.voiceProblem ?? null));
  /**
   * Aborted by stop(): ends a local engine run in flight (LocalEngineError('aborted')), which is free, so the processor
   * gives the attempt back and the note is tried again after the restart. A paid call is never aborted.
   */
  const stopping = new AbortController();
  /**
   * Copy deletions in flight (the sweep's, and afterFinish's), each a promise that never rejects: stop() waits for them,
   * up to 5 s, so none is cut off by the database closing (Task 10 review round 1, fix 6).
   */
  const forgetsInFlight = new Set<Promise<void>>();
  const trackForget = (p: Promise<void>): Promise<void> => {
    forgetsInFlight.add(p);
    void p.finally(() => forgetsInFlight.delete(p));
    return p;
  };
  /** Rows already warned about as provider_unavailable while this service runs: once each, not every hour (fix 4). */
  const warnedUnavailable = new Set<number>();
  const uploader = m
    ? new DriveFileUploader({ db: d.db, api: d.drive, dataDir: d.dataDir, clock: d.clock, log: d.log, onUploaded: () => publisher.schedule() })
    : undefined;
  const mediaQueue = m
    ? new MediaQueue({
        db: d.db,
        clock: d.clock,
        log: d.log,
        concurrency: m.concurrency ?? 3,
        // The local engine runs one note at a time: notes waiting for it must not hold the slots images need.
        voiceLane: voice?.costsNothing ? 1 : undefined,
        processor: new MediaProcessor({
          db: d.db,
          dataDir: d.dataDir,
          clock: d.clock,
          log: d.log,
          sealer: m.sealer,
          fetcher: m.fetcher,
          extract: m.extract ?? createExtractor({ ai: m.ai, spend, prices: d.prices, voice, maxVoiceSeconds: m.maxVoiceSeconds, signal: stopping.signal }),
          startedAt,
          // For deleting provider copies promptly; the extractor holds its own.
          voice,
          // Explicit: none keeps 2a's 3 runs; local 3, paid 2. (The processor's own default, with no transcriber, is
          // the paid 2.)
          voicePaid: voice ? !voice.costsNothing : false,
          // A paid transcript's provider copy, noted by finishMedia, is deleted now (N1). Never thrown: a failure is
          // logged with a code, and the row waits for the hourly sweep. stop() waits for it (up to 5 s).
          afterFinish: (mediaId, x) => {
            if (!x.forget) return;
            return trackForget(
              Promise.resolve()
                .then(() => forgetVoiceCopies(d.db, voice, d.log, { mediaId, clock: d.clock, warned: warnedUnavailable }))
                .then(
                  () => undefined,
                  (err: unknown) => {
                    d.log.warn({ mediaId, code: errorCode(err) }, 'voice note speech copy not deleted yet: left for the sweep');
                  },
                ),
            );
          },
        }),
        // §6.1: a run that waited for this file can go ahead. The Files received list may change, and a client
        // member's file can go to Drive now.
        onSettled: (clientId) => {
          debouncer.notify(clientId);
          safely(refreshMedia); // a "waiting" warning about this file must not reach the workbook it settles
          publisher.schedule();
          void uploader?.run();
        },
      })
    : undefined;

  const mt = d.meetings;
  const meetings = mt
    ? new MeetingService({
        db: d.db, clock: d.clock, log: d.log, dataDir: d.dataDir, spend, prices: d.prices, drive: d.drive, api: mt.api, ai: mt.ai,
        transcriber: mt.transcriber, ffmpeg: mt.ffmpeg, settings: mt.settings, clients: mt.clients, freeBytes: d.freeBytes ?? defaultFreeBytes,
        // The tracker step holds the client's run flag through the reconciler's exclusive (debouncer.runExclusive).
        track: (clientId, meeting) => reconciler.runMeeting(clientId, meeting),
        hasMeetingScopes: () => hasMeetingScopes(d.db),
        // A finished or failed meeting, or new rows: the workbook is rebuilt, with the meeting counts of now (not the
        // last tick's), as refreshMedia does for files.
        onChanged: () => {
          safely(refreshMeetings);
          publisher.schedule();
        },
      })
    : undefined;
  /** Gives the meetings' health to the health line and to the optional callback (null when meetings are off). */
  const refreshMeetings = () => {
    const m = meetings ? meetings.health() : null;
    health.setMeetings(m);
    d.onMeetingsHealth?.(m);
  };

  // Fires for new messages, edits and non-empty reactions. A shared file is queued for download as soon as it is stored.
  const ingestor = new Ingestor({
    db: d.db,
    clock: d.clock,
    onNewMessages: (clientId) => debouncer.notify(clientId),
    // kick() never throws: a throw here would count a message that is already stored as lost.
    media: m ? { sealer: m.sealer, onQueued: () => mediaQueue?.kick() } : undefined,
  });

  d.gateway.onEvent((e) => {
    try {
      ingestor.handle(e);
    } catch (err) {
      d.log.error({ err }, 'ingest failed'); // never the event: it holds chat text and media keys
      throw err; // the gateway counts it in failedCount()
    }
    // A deleted source message changes the workbook ("source message deleted by sender") without any AI run.
    if (e.kind === 'revoke' && d.allow.has(e.groupId)) publisher.schedule();
  });
  d.gateway.onStatus((s) => {
    safely(() => health.setWhatsApp(s));
    publisher.schedule();
  });

  /**
   * Deletes the voice-note copies due at the speech provider, for every file (N1): at start and every hour. Skipped while
   * the previous sweep still runs. Never throws, sync or async: a failure is logged with a code only. A copy whose
   * provider is not set up now is warned about once per row while the service runs, not every hour. stop() waits for a
   * sweep in flight (up to 5 s).
   */
  let forgetTimer: ReturnType<typeof setInterval> | undefined;
  let sweeping = false;
  const sweepVoiceCopies = () => {
    if (sweeping) return;
    sweeping = true;
    let run: Promise<unknown>;
    try {
      run = forgetVoiceCopies(d.db, voice, d.log, { clock: d.clock, warned: warnedUnavailable });
    } catch (err) {
      run = Promise.reject(err);
    }
    void trackForget(
      run
        .then(
          () => undefined,
          (err: unknown) => {
            d.log.warn({ code: errorCode(err) }, 'voice copy sweep failed');
          },
        )
        .finally(() => {
          sweeping = false;
        }),
    );
  };
  /**
   * Waits for the copy deletions in flight, up to `ms`. One still running then is left: it may fail on the closed
   * database, which leaves its row for the next start (logged with a code only).
   */
  const waitForForgets = async (ms: number): Promise<void> => {
    if (forgetsInFlight.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    try {
      await Promise.race([
        Promise.all([...forgetsInFlight]),
        new Promise<void>((r) => {
          timer = setTimeout(() => {
            timedOut = true;
            r();
          }, ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) d.log.warn({ code: 'forget_in_flight' }, 'voice copy deletion still running at shutdown: left for the next start');
  };
  /**
   * Removes the conversion folders a voice note left in DATA_DIR/tmp/voice (Task 5 review round 1): a note that failed,
   * was revoked or was too long, or one whose conversion a stop cut off, never comes back to remove its own. Only
   * folders directly inside it named voice-<digits>; a link or junction is never followed or removed, and nothing else
   * is touched. DATA_DIR/tmp and DATA_DIR/tmp/voice must each be a plain folder: if either is a link, a junction or
   * not a folder, nothing is listed or removed (voice_tmp_not_plain_folder; review round 1, fix 5). Best effort: a
   * failure is logged with a code only, never a path. Run in start() before the queue starts any file.
   */
  const sweepVoiceFolders = () => {
    const tmp = join(d.dataDir, 'tmp');
    const dir = join(tmp, 'voice');
    for (const path of [tmp, dir]) {
      let plain: boolean;
      try {
        const st = lstatSync(path); // a junction shows as a link here, as a symlink does
        plain = st.isDirectory() && !st.isSymbolicLink();
      } catch (err) {
        if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') d.log.warn({ code: errorCode(err) }, 'leftover voice folders not removed');
        return;
      }
      if (!plain) {
        d.log.warn({ code: 'voice_tmp_not_plain_folder' }, 'leftover voice folders not removed: the voice work folder is a link or not a folder');
        return;
      }
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') d.log.warn({ code: errorCode(err) }, 'leftover voice folders not removed');
      return;
    }
    for (const e of entries) {
      if (!/^voice-\d+$/.test(e.name) || !e.isDirectory()) continue;
      const path = join(dir, e.name);
      try {
        if (!lstatSync(path).isDirectory()) continue; // a link or junction: never followed
        rmSync(path, { recursive: true, force: true });
      } catch (err) {
        d.log.warn({ code: errorCode(err) }, 'leftover voice folders not removed');
      }
    }
  };

  let poll: ReturnType<typeof setInterval> | undefined;
  const tick = () => {
    // An uncaught throw inside setInterval would exit the service.
    try {
      if (getKv(d.db, 'rebuild_requested')) {
        setKv(d.db, 'rebuild_requested', '');
        publisher.schedule();
      }
      // Also re-runs a client waiting for a file that never settles (deferred for Claude or the budget) once its wait
      // is over, and a message queued again because its file was read late (amendment 15g).
      for (const clientId of clientIdsWithUnprocessed(d.db)) debouncer.ensure(clientId);
      mediaQueue?.kick(); // retries that are due, and files saved by cli link
      void uploader?.run(); // retries that are due
      meetings?.tick(); // discovery when due (MEETING_POLL_MINUTES), then the next due meeting
      safely(refreshMeetings);
      health.setIngestFailures(d.gateway.failedCount());
      refreshMedia();
      if (reportScheduler) {
        // tick() never throws. A send runs on in the background; the claim is already written when it returns.
        void reportScheduler.tick(d.clock.now());
        health.setReport(reportScheduler.health(d.clock.now()));
      }
      // A line that changes with no other change (a file waiting too long, an upload that gave up, a message that could
      // not be saved) would otherwise reach the workbook only with an unrelated publish, possibly hours later.
      if (health.workbookLine().text !== publishedLine) publisher.schedule();
      health.persist();
    } catch (err) {
      d.log.error({ err }, 'tick failed');
    }
  };

  return {
    health,
    publisher,
    debouncer,
    mediaQueue,
    meetings,
    report: reportScheduler,
    start() {
      if (poll) return; // already started: a second interval would outlive stop()
      if (reportScheduler) {
        try {
          reportScheduler.recover(d.clock.now()); // a send cut off by a crash becomes unknown, never sent again by itself
        } catch (err) {
          d.log.error({ err }, 'morning report recovery failed');
        }
      }
      if (uploader) {
        try {
          resetUploadFailures(d.db); // a restart gives uploads that gave up a fresh set of attempts
        } catch (err) {
          d.log.error({ err }, 'upload reset failed');
        }
      }
      if (m) {
        // Before the first tick, so no voice note being converted now can lose its folder.
        sweepVoiceFolders();
        sweepVoiceCopies();
        forgetTimer = setInterval(sweepVoiceCopies, 60 * 60_000);
      }
      d.gateway.start();
      meetings?.start(); // books speech parts left in flight and cleans work files before any meeting runs
      tick();
      poll = setInterval(tick, d.pollMs ?? 30_000);
      publisher.schedule();
    },
    async stop() {
      clearInterval(poll);
      poll = undefined;
      clearInterval(forgetTimer);
      forgetTimer = undefined;
      debouncer.stop();
      mediaQueue?.stop();
      // Before the drain: a local engine run in flight ends now, instead of holding the drain for up to 30 minutes.
      // Its conversion (prepare) is not stopped; a folder it leaves is removed at the next start.
      stopping.abort();
      // No new meeting or discovery pass; a download or ffmpeg run is aborted. Speech and Claude calls run on.
      meetings?.stop();
      // No new upload pass or file during the drain: a file still uploading when the database closes would reach Drive
      // with no saved id and be uploaded again after the restart. The pass in flight stops before its next file.
      void uploader?.stop(0);
      // A result we already paid for is applied, not thrown away and paid for again after a restart.
      const drainMs = d.drainMs ?? 120_000;
      await Promise.all([debouncer.drain(drainMs), mediaQueue?.drain(drainMs), meetings?.drain(drainMs)]);
      // A call still running was probably billed: book it at its estimate. After a clean drain nothing is pending.
      try {
        const count = spend.settlePending('shutdown before the paid call finished (estimated)');
        if (count > 0) d.log.warn({ count }, 'AI calls still running at shutdown; booked at their estimate');
      } catch (err) {
        d.log.error({ err }, 'booking unfinished AI calls failed');
      }
      // The upload in flight, then one more if results were applied during the drain; and the file upload still in
      // flight, so its Drive id is saved before the database closes. Bounded to 10 s, in parallel.
      // A morning report still sending gets the same 10 s, then up to 3 s to close its socket, then up to 2 s to record
      // its outcome (a report in its linger is still 'sent'); one cut off is marked unknown at the next start. main.ts
      // closes the databases only after stop() resolves, so after the scheduler's stop() has returned
      // (tests/appReport.test.ts). A voice-copy deletion in flight (the sweep's, or one a finished note started during
      // the drain) gets up to 5 s alongside, so the database is not closed under it.
      await Promise.all([publisher.flush(10_000), uploader?.stop(10_000), reportScheduler?.stop(10_000), waitForForgets(5_000)]);
      // A socket that never closes must not eat the rest of WinSW's 150 s: 120 s drain + 15 s (the morning report's
      // 10 + 3 + 2; the uploads take at most 10; the copy deletions at most 5) + 5 s here = 140 s, plus margin.
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          d.gateway.stop(),
          new Promise<void>((r) => {
            timer = setTimeout(r, 5_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    reloadClients(configs) {
      const wasActive = listClients(d.db).map((c) => c.id);
      syncClients(d.db, configs); // throws on a code conflict, before anything else changes
      d.allow.replace(configs.map((c) => c.groupId));
      meetings?.setClients(configs);
      const active = new Set(listClients(d.db).map((c) => c.id));
      for (const id of wasActive) {
        if (active.has(id)) continue;
        debouncer.cancel(id);
        health.forget(id);
      }
      safely(refreshMedia); // a removed client's files leave the counts before the publish
      safely(() => health.persist());
      publisher.schedule();
    },
  };
}
