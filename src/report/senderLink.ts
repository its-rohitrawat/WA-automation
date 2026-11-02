import { senderSessionDbPath } from '../config/paths.ts';
import type { Db } from '../store/db.ts';
import { systemClock, type Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { openPhoneSession, openSenderSession, useSenderAuthState, type EncryptedAuth, type SessionHome } from '../wa/authState.ts';
import { TRACKER_DEVICE_NAME } from '../wa/gateway.ts';
import { backupAndReset, dropBackup, guardAuth, restoreBackup, type LinkDriver, type LinkOutcome } from '../wa/linkSession.ts';
import { linkedNumber, linkSender, SENDER_DEVICE_NAME, type SenderSocketFactory } from '../wa/senderGateway.ts';
import { moveDamagedSession } from '../wa/sessionFiles.ts';
import type { ReportSender, SenderStatus, SendResult } from './types.ts';

// Links the spare phone from the dashboard (D3), in-process, with the same steps and refusals as `cli link-sender
// --reset`: the spare number's session rows are reset (a damaged file is moved aside, never deleted), the phone scans
// the QR code, and a scan from the founder's own number is refused. Unlike the CLI, the previous spare session is backed
// up in the same file (backupAndReset) and comes back when the link is cancelled, times out, fails or is refused, so a
// working spare phone is never lost. Only data/sender-session.db is touched; the founder's session is only read, to
// compare numbers. While the link runs, the morning report's sender is replaced by one that refuses ('linking'), so a
// send due meanwhile never writes into the session being linked; it is retried as for any failed send.

/** What the dashboard shows for each way a spare-phone link can end without a link. */
export const SPARE_LINK_MESSAGES: Record<string, string> = {
  founder_number:
    `That QR code was scanned with the founder's phone. On the founder's phone, under Linked devices, remove "${SENDER_DEVICE_NAME}" (the device linked just now). Keep "${TRACKER_DEVICE_NAME}": the tracker uses it. Then link again and scan with the SPARE phone.`,
  session_unavailable:
    "The spare phone's session file could not be opened on the Mac (a lock, permissions or a disk problem). Nothing was changed. Try again, or restart the agent.",
  not_linked: 'The QR code was not scanned. Try again.',
  connect_timeout: 'No connection to WhatsApp, or the QR code was not scanned in time. Check the internet connection, then try again.',
  logged_out: `WhatsApp refused the link. On the spare phone remove any old "${SENDER_DEVICE_NAME}" device (Linked devices), then try again.`,
  forbidden: 'WhatsApp refused the spare number (403). Check the spare phone for a WhatsApp warning.',
  replaced: 'Another session took over the spare number. Close it, then try again.',
  restart_required: 'WhatsApp kept asking for a restart. Try again.',
  closed: 'The WhatsApp connection dropped before linking finished. Try again.',
  error: 'Something went wrong while linking. Nothing was changed. Try again.',
};

/** Stands in for the morning report's sender while the spare phone is being linked. It sends nothing. */
export class LinkingSender implements ReportSender {
  readonly #masked: string;
  readonly #since: string;
  constructor(maskedRecipient: string, since: string) {
    this.#masked = maskedRecipient;
    this.#since = since;
  }
  async sendReport(): Promise<SendResult> {
    return { status: 'failed', code: 'linking' };
  }
  status(): SenderStatus {
    return { state: 'connecting', since: this.#since, lastErrorCode: null };
  }
  async stop(): Promise<void> {}
  maskedRecipient(): string {
    return this.#masked;
  }
}

/** What the driver uses of ReportScheduler. */
export interface SenderScheduler {
  replaceSender(sender: ReportSender): void;
  whenIdle(): Promise<void>;
  /** The masked recipient, shown by the stand-in while linking. */
  maskedRecipient(): string;
}

export interface SpareLinkDeps {
  dataDir: string;
  /** Where the sessions live (sessionHomeOf); the data folder's files when not given. */
  sessions?: SessionHome;
  /** The master key; the spare session's own key is derived from it (useSenderAuthState). */
  key: Buffer;
  factory: SenderSocketFactory;
  /** The number the founder's session is linked to, read at link time (readFounderNumber). */
  founderNumber: () => string | undefined;
  /** REPORT_RECIPIENT (digits) when set: a spare link to it is refused too, as SenderGateway refuses it. */
  recipient: () => string | undefined;
  /** When the morning report runs: its open spare-session database. Otherwise the driver opens the file itself. */
  reportDb?: () => Db | undefined;
  /** When the morning report runs: its scheduler. It gets a stand-in while linking, then the sender on the kept session. */
  scheduler?: () => SenderScheduler | undefined;
  /** Builds the scheduler's sender on a session (SenderGateway with the report's recipient). Required with scheduler. */
  makeSender?: (auth: EncryptedAuth) => ReportSender;
  /** A database this driver opened and handed to a new sender; the caller closes it at shutdown. */
  adoptDb?: (db: Db) => void;
  log: Logger;
  clock?: Clock;
  /** How long one socket may take to open. Default 5 minutes (the link session's own timeout ends it sooner). */
  connectTimeoutMs?: number;
  /** linkSender's settle time. Default 5 s. */
  settleMs?: number;
}

export function spareLinkDriver(d: SpareLinkDeps): LinkDriver {
  const clock = d.clock ?? systemClock;

  return {
    async run(hooks, signal): Promise<LinkOutcome> {
      const file = senderSessionDbPath(d.dataDir);
      const home: SessionHome = d.sessions ?? { engine: 'sqlite', dataDir: d.dataDir };
      const scheduler = d.makeSender ? d.scheduler?.() : undefined;
      let db = d.reportDb?.();
      let own = false;
      // When the link shares the report's open session, the report's sender steps aside first: no send may run on this
      // session while it is reset and linked. Without a shared session the report's sender has none to write to.
      const steppedAside = scheduler !== undefined && db !== undefined;
      if (steppedAside) {
        await scheduler!.whenIdle();
        scheduler!.replaceSender(new LinkingSender(scheduler!.maskedRecipient(), clock.now().toISOString()));
      }
      /** Gives the scheduler a sender on whatever session the database now holds (the kept or the restored one). */
      const handBack = async (target: Db) => {
        if (!scheduler) return;
        try {
          scheduler.replaceSender(d.makeSender!(await useSenderAuthState(target, d.key)));
          if (own) d.adoptDb?.(target); // the sender keeps using it
          own = false;
        } catch (err) {
          d.log.error({ err }, 'spare phone link: the report sender could not be rebuilt; it is rebuilt at the next start');
        }
      };
      if (!db) {
        const opened = await openSenderSession(home, d.key);
        if (opened.ok) {
          db = opened.db;
        } else if (opened.transient) {
          // Not known to be damaged: moving it aside would be wrong (as in the CLI).
          d.log.warn({ code: opened.code }, 'spare phone link: the session file could not be opened');
          return { ok: false, code: 'session_unavailable' }; // the stand-in stays: the session cannot be read anyway
        } else {
          if (opened.code !== 'decrypt_failed') {
            // Only a file can be damaged: on Postgres the one failure reported is another master key.
            moveDamagedSession(file, clock.now()); // renamed aside, not deleted
            d.log.warn({ code: opened.code }, 'spare phone link: the damaged session file was moved aside');
          }
          db = await openPhoneSession(home, 'spare');
        }
        own = true;
      }
      const close = async () => {
        if (!own) return;
        try {
          await db.close();
        } catch {
          // best effort
        }
      };
      let backedUp = false;
      // Writes from the link's sockets stop once the link is undone, so a late one never lands on the restored rows.
      let frozen = false;
      const undo = async () => {
        frozen = true;
        await restoreBackup(db);
        if (steppedAside) await handBack(db); // the report goes on with the restored session
        await close();
      };
      try {
        // The spare number's rows only, backed up in the same file first (a crash mid-link restores them at the next start).
        await backupAndReset(db);
        backedUp = true;
        const auth = guardAuth(await useSenderAuthState(db, d.key), () => frozen || signal.aborted);
        const r = await linkSender({
          factory: d.factory, auth, onQr: hooks.qr, onScanned: hooks.opening, signal,
          timeoutMs: d.connectTimeoutMs ?? 5 * 60_000, ...(d.settleMs !== undefined ? { settleMs: d.settleMs } : {}),
        });
        if (signal.aborted || !r.ok) {
          await undo();
          return { ok: false, code: signal.aborted || r.ok ? 'aborted' : r.code };
        }
        // The founder's number must never send: neither REPORT_RECIPIENT nor the number the founder reader is linked to.
        const linked = linkedNumber(auth);
        const recipient = d.recipient();
        if (linked !== undefined && (linked === d.founderNumber() || (recipient !== undefined && linked === recipient))) {
          await undo(); // this link is never kept
          return { ok: false, code: 'founder_number' };
        }
        frozen = true; // the link socket is closed; nothing more may write through it
        await dropBackup(db); // committed: the new link is kept
      } catch (err) {
        d.log.error({ err }, 'spare phone link failed; restoring the previous spare session');
        try {
          if (backedUp) await undo();
          else {
            if (steppedAside) await handBack(db);
            await close();
          }
        } catch (restoreErr) {
          d.log.error({ err: restoreErr }, 'the previous spare session could not be restored now; it is restored at the next start');
          await close();
        }
        return { ok: false, code: 'error' };
      }
      // After the commit nothing may undo or fail the link: these steps only log.
      if (scheduler) await handBack(db);
      await close(); // unless handed to the new sender: saved, and the report opens it at its next start
      return { ok: true, device: SENDER_DEVICE_NAME };
    },
  };
}
