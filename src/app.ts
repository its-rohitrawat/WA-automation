import type { AiClient } from './brain/claudeClient.ts';
import { GroupDebouncer } from './brain/debouncer.ts';
import type { MediaAi } from './brain/mediaClient.ts';
import { Reconciler, type ReconcileOutcome } from './brain/reconciler.ts';
import type { ClientConfig } from './config/groups.ts';
import { Health } from './health/health.ts';
import { createExtractor, type Extractor } from './media/extract.ts';
import type { MediaFetcher } from './media/fetch.ts';
import { MediaProcessor } from './media/processor.ts';
import { MEDIA_MAX_WAIT_MS } from './media/promptText.ts';
import { MediaQueue } from './media/queue.ts';
import type { MediaRefSealer } from './media/ref.ts';
import { DriveFileUploader } from './media/uploader.ts';
import { DrivePublisher, type DriveApi } from './output/drive.ts';
import { loadTrackerView } from './output/view.ts';
import { buildWorkbook } from './output/workbook.ts';
import type { Prices } from './spend/pricing.ts';
import { SpendGuard } from './spend/spendGuard.ts';
import { getClient, listClients, syncClients } from './store/clients.ts';
import type { Db } from './store/db.ts';
import { getKv, setKv } from './store/kv.ts';
import { mediaStats, resetUploadFailures } from './store/media.ts';
import { clientIdsWithUnprocessed } from './store/messages.ts';
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
  /** Files downloaded and read at once. Default 2. */
  concurrency?: number;
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
}

export interface App {
  start(): void;
  /**
   * Starts no new AI run, file read or file upload. Waits for AI calls and file reads in flight (up to drainMs) and
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
}

/** Wires gateway -> ingestor -> media queue / debouncer -> reconciler -> publisher. Never sends anything to WhatsApp. */
export function createApp(d: AppDeps): App {
  const startedAt = d.startedAt ?? d.clock.now();
  const spend = new SpendGuard({ db: d.db, clock: d.clock, capUsd: d.spendCapUsd });
  const health = new Health({ db: d.db, clock: d.clock, spend, dataDir: d.dataDir, freeBytes: d.freeBytes });
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
    db: d.db, ai: d.ai, spend, prices: d.prices, clock: d.clock, log: d.log, startedAt, onChanged: () => publisher.schedule(),
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
  const uploader = m
    ? new DriveFileUploader({ db: d.db, api: d.drive, dataDir: d.dataDir, clock: d.clock, log: d.log, onUploaded: () => publisher.schedule() })
    : undefined;
  const mediaQueue = m
    ? new MediaQueue({
        db: d.db,
        clock: d.clock,
        log: d.log,
        concurrency: m.concurrency ?? 2,
        processor: new MediaProcessor({
          db: d.db,
          dataDir: d.dataDir,
          clock: d.clock,
          log: d.log,
          sealer: m.sealer,
          fetcher: m.fetcher,
          extract: m.extract ?? createExtractor({ ai: m.ai, spend, prices: d.prices }),
          startedAt,
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
      health.setIngestFailures(d.gateway.failedCount());
      refreshMedia();
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
    start() {
      if (poll) return; // already started: a second interval would outlive stop()
      if (uploader) {
        try {
          resetUploadFailures(d.db); // a restart gives uploads that gave up a fresh set of attempts
        } catch (err) {
          d.log.error({ err }, 'upload reset failed');
        }
      }
      d.gateway.start();
      tick();
      poll = setInterval(tick, d.pollMs ?? 30_000);
      publisher.schedule();
    },
    async stop() {
      clearInterval(poll);
      poll = undefined;
      debouncer.stop();
      mediaQueue?.stop();
      // No new upload pass or file during the drain: a file still uploading when the database closes would reach Drive
      // with no saved id and be uploaded again after the restart. The pass in flight stops before its next file.
      void uploader?.stop(0);
      // A result we already paid for is applied, not thrown away and paid for again after a restart.
      const drainMs = d.drainMs ?? 120_000;
      await Promise.all([debouncer.drain(drainMs), mediaQueue?.drain(drainMs)]);
      // A call still running was probably billed: book it at its estimate. After a clean drain nothing is pending.
      try {
        const count = spend.settlePending('shutdown before the paid call finished (estimated)');
        if (count > 0) d.log.warn({ count }, 'AI calls still running at shutdown; booked at their estimate');
      } catch (err) {
        d.log.error({ err }, 'booking unfinished AI calls failed');
      }
      // The upload in flight, then one more if results were applied during the drain; and the file upload still in
      // flight, so its Drive id is saved before the database closes. Bounded to 10 s, in parallel.
      await Promise.all([publisher.flush(10_000), uploader?.stop(10_000)]);
      // A socket that never closes must not eat the rest of WinSW's 150 s (120 + 10 + 5 plus margin).
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
