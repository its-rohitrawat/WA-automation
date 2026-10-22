import type { AiClient } from './brain/claudeClient.ts';
import { GroupDebouncer } from './brain/debouncer.ts';
import { Reconciler, type ReconcileOutcome } from './brain/reconciler.ts';
import type { ClientConfig } from './config/groups.ts';
import { Health } from './health/health.ts';
import { DrivePublisher, type DriveApi } from './output/drive.ts';
import { loadTrackerView } from './output/view.ts';
import { buildWorkbook } from './output/workbook.ts';
import type { Prices } from './spend/pricing.ts';
import { SpendGuard } from './spend/spendGuard.ts';
import { getClient, listClients, syncClients } from './store/clients.ts';
import type { Db } from './store/db.ts';
import { getKv, setKv } from './store/kv.ts';
import { clientIdsWithUnprocessed } from './store/messages.ts';
import type { Clock } from './util/clock.ts';
import type { Logger } from './util/logger.ts';
import type { AllowList } from './wa/allowlist.ts';
import type { WhatsAppGateway } from './wa/gateway.ts';
import { Ingestor } from './wa/ingest.ts';

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
  /** How long stop() waits for AI calls in flight. Default 120 s (WinSW stoptimeout is 150 s). */
  drainMs?: number;
}

export interface App {
  start(): void;
  /**
   * Waits for AI calls in flight (up to drainMs) and books any still running at their estimate, then flushes the
   * publisher: the upload in flight plus one more if anything changed (up to 10 s). Leaves no timers.
   */
  stop(): Promise<void>;
  /** Applies a new allow-list. Throws, leaving the old allow-list in place, if the config conflicts with the DB. */
  reloadClients(configs: ClientConfig[]): void;
  health: Health;
  publisher: DrivePublisher;
  debouncer: GroupDebouncer;
}

/** Wires gateway -> ingestor -> debouncer -> reconciler -> publisher. Never sends anything to WhatsApp. */
export function createApp(d: AppDeps): App {
  const spend = new SpendGuard({ db: d.db, clock: d.clock, capUsd: d.spendCapUsd });
  const health = new Health({ db: d.db, clock: d.clock, spend, dataDir: d.dataDir, freeBytes: d.freeBytes });
  const publisher = new DrivePublisher({
    db: d.db,
    api: d.drive,
    log: d.log,
    minIntervalMs: d.publishIntervalMs,
    // workbookLine() leaves out publish failures: if this upload succeeds, they are already over.
    build: () => buildWorkbook(loadTrackerView(d.db, d.clock.now(), health.workbookLine())),
    onPublished: () => health.markPublished(),
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
    // A run that is waiting for shared files changed nothing, so it publishes nothing.
    if (outcome.status === 'failed' || outcome.status === 'paused') publisher.schedule();
  };

  const reconciler = new Reconciler({ db: d.db, ai: d.ai, spend, prices: d.prices, clock: d.clock, log: d.log, onChanged: () => publisher.schedule() });
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
  // Fires for new messages, edits and non-empty reactions.
  const ingestor = new Ingestor({ db: d.db, onNewMessages: (clientId) => debouncer.notify(clientId) });

  d.gateway.onEvent((e) => {
    try {
      ingestor.handle(e);
    } catch (err) {
      d.log.error({ err }, 'ingest failed'); // never the event: it holds chat text
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
      for (const clientId of clientIdsWithUnprocessed(d.db)) debouncer.ensure(clientId);
      health.setIngestFailures(d.gateway.failedCount());
      health.persist();
    } catch (err) {
      d.log.error({ err }, 'tick failed');
    }
  };

  return {
    health,
    publisher,
    debouncer,
    start() {
      if (poll) return; // already started: a second interval would outlive stop()
      d.gateway.start();
      tick();
      poll = setInterval(tick, d.pollMs ?? 30_000);
      publisher.schedule();
    },
    async stop() {
      clearInterval(poll);
      poll = undefined;
      debouncer.stop();
      // A result we already paid for is applied, not thrown away and paid for again after a restart.
      await debouncer.drain(d.drainMs ?? 120_000);
      // A call still running was probably billed: book it at its estimate. After a clean drain nothing is pending.
      try {
        const count = spend.settlePending('shutdown before the AI call finished (estimated)');
        if (count > 0) d.log.warn({ count }, 'AI calls still running at shutdown; booked at their estimate');
      } catch (err) {
        d.log.error({ err }, 'booking unfinished AI calls failed');
      }
      // The upload in flight, then one more if results were applied during the drain. Bounded to 10 s.
      await publisher.flush(10_000);
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
      safely(() => health.persist());
      publisher.schedule();
    },
  };
}
