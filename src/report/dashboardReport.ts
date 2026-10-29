import { existsSync } from 'node:fs';
import { senderSessionDbPath } from '../config/paths.ts';
import type { SettingsStore } from '../config/settingsStore.ts';
import type { Db } from '../store/db.ts';
import type { Logger } from '../util/logger.ts';
import { senderSessionLinkedSync } from '../wa/authState.ts';
import type { LinkDriver } from '../wa/linkSession.ts';
import { SenderGateway, type SenderSocketFactory } from '../wa/senderGateway.ts';
import type { LiveReport, LiveReportSettings } from './liveReport.ts';
import { spareLinkDriver } from './senderLink.ts';

// The morning briefing's spare phone, as the dashboard sees it (main.ts wires these; the spare session is opened only
// here and in openMorningReport). Nothing here logs or returns a number.

/** The spare-number sender states that mean its phone is linked (it has a session the briefing can send with). */
const LINKED: ReadonlySet<string> = new Set(['idle', 'connecting', 'open']);

/**
 * Whether the spare phone is linked, for the switch on the Automations screen: the open briefing's sender when there is
 * one, else the saved session (opened and closed again; a missing file is never made). False while a link runs.
 */
export function spareLinked(o: { dataDir: string; key: Buffer; briefing: Pick<LiveReport, 'sender'>; linking: () => boolean }): () => boolean {
  return () => {
    if (o.linking()) return false;
    const open = o.briefing.sender();
    if (open) return LINKED.has(open.status().state);
    const file = senderSessionDbPath(o.dataDir);
    if (!existsSync(file)) return false;
    // Synchronous until the settings view that reads it is async (S1.5).
    return senderSessionLinkedSync(file, o.key);
  };
}

/**
 * The spare phone's link driver for the dashboard. The briefing is paused for the whole link (no tick opens, closes or
 * sends while the session file is reset), and a kept link hands the open briefing a sender for the same number.
 */
export function spareDriver(o: {
  dataDir: string;
  key: Buffer;
  factory: SenderSocketFactory;
  founderNumber: () => string | undefined;
  briefing: Pick<LiveReport, 'pause' | 'reportDb' | 'scheduler' | 'recipient'>;
  /** The briefing's number in the settings (digits): a spare link to it is refused too. */
  settingsNumber: () => string | undefined;
  /** A session file the link opened and handed to a new sender; the caller closes it at shutdown. */
  adoptDb: (db: Db) => void;
  /** Told when a link starts and ends (spareLinked answers false meanwhile). */
  linking: (on: boolean) => void;
  log: Logger;
}): LinkDriver {
  const { briefing } = o;
  const inner = spareLinkDriver({
    dataDir: o.dataDir, key: o.key, factory: o.factory, founderNumber: o.founderNumber,
    recipient: o.settingsNumber,
    reportDb: () => briefing.reportDb(),
    scheduler: () => briefing.scheduler(),
    makeSender: (auth) => {
      const to = briefing.recipient();
      if (to === undefined) throw new Error('the morning report has no number open');
      return new SenderGateway({ recipient: to, founderNumber: o.founderNumber, factory: o.factory, auth });
    },
    adoptDb: o.adoptDb,
    log: o.log,
  });
  return {
    async run(hooks, signal) {
      o.linking(true);
      const release = await briefing.pause();
      try {
        // Cancelled, timed out or stopped while a send finished: the session file is left as it was.
        if (signal.aborted) return { ok: false, code: typeof signal.reason === 'string' ? signal.reason : 'cancelled' };
        return await inner.run(hooks, signal);
      } finally {
        release();
        o.linking(false);
      }
    },
  };
}

/** What LiveReport reads on every tick: the briefing's settings and its number, from the dashboard's store. */
export function briefingSettings(store: Pick<SettingsStore, 'get' | 'reportSettings'>): () => LiveReportSettings {
  return () => ({ report: store.reportSettings(), recipient: store.get().reportRecipient });
}
