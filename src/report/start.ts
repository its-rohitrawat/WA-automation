import { maskNumber, reportRecipient, reportSettings, type Env } from '../config/env.ts';
import { senderSessionDbPath } from '../config/paths.ts';
import type { Db } from '../store/db.ts';
import type { Logger } from '../util/logger.ts';
import { openSenderSession } from '../wa/authState.ts';
import { SenderGateway, type SenderSocketFactory } from '../wa/senderGateway.ts';
import type { ReportSender, ReportSettings } from './types.ts';

export interface MorningReportStart {
  /** What createApp takes as `report`. */
  report: { sender: ReportSender; settings: ReportSettings };
  /** The open spare-number session; main.ts closes it after app.stop(). Undefined when the session could not be read. */
  senderDb: Db | undefined;
}

/**
 * At service start, with REPORT_ENABLED: opens the spare number's session (data/sender-session.db with its own key, never
 * the founder's session.db) and makes its sender. Connects nothing yet. A damaged or undecryptable session never stops
 * the service: it is logged, the sender reports 'unreadable', and Health tells the owner what to run. A file that could
 * not be opened (a lock, permissions, a disk error) is 'unavailable' instead, and Health says to restart the service.
 * The log shows only the last 4 digits of REPORT_RECIPIENT, and never founderNumber.
 * founderNumber: the number the founder-number reader is linked to (main.ts reads it from session.db). A spare-number
 * link to it, or to REPORT_RECIPIENT, never sends ('self_send').
 */
export function openMorningReport(o: {
  env: Env;
  masterKey: Buffer;
  log: Logger;
  factory: SenderSocketFactory;
  founderNumber?: string | (() => string | undefined);
}): MorningReportStart {
  const recipient = reportRecipient(o.env);
  const opened = openSenderSession(senderSessionDbPath(o.env.DATA_DIR), o.masterKey);
  let authProblem: 'unreadable' | 'unavailable' | undefined;
  if (!opened.ok) {
    authProblem = opened.transient ? 'unavailable' : 'unreadable';
    if (opened.transient) o.log.error({ reason: 'session_unavailable', code: opened.code }, 'morning report: the spare number session file could not be opened');
    else o.log.error({ reason: 'session_unreadable', code: opened.code }, 'morning report: the spare number session cannot be read');
  }
  const auth = opened.ok ? opened.auth : undefined;
  let sender: SenderGateway;
  try {
    sender = new SenderGateway({ recipient, founderNumber: o.founderNumber, factory: o.factory, auth, authProblem });
  } catch (err) {
    if (opened.ok) opened.db.raw.close(); // the caller never receives the handle
    throw err;
  }
  // recipientLast4, not recipient: the logger censors any field named recipient.
  o.log.info({ recipientLast4: maskNumber(recipient), linked: auth?.hasSession ?? false }, 'morning report enabled');
  return { report: { sender, settings: reportSettings(o.env) }, senderDb: opened.ok ? opened.db : undefined };
}

/**
 * For the dashboard's live settings (LiveReport, D5 Task 1): opens the spare number's session and sender for a number
 * the owner set, which may differ from REPORT_RECIPIENT, and may come while REPORT_ENABLED was false at service start.
 * Each call is openMorningReport with that number; close() closes the session file it opened, so the next number can
 * open it again; db is that open file, which a spare-phone link from the dashboard shares. The same safeguards hold: the spare number's own key, and no send to the founder's own link.
 */
export function senderOpener(o: {
  env: Env;
  masterKey: Buffer;
  log: Logger;
  factory: SenderSocketFactory;
  founderNumber?: string | (() => string | undefined);
}): (recipient: string) => { sender: ReportSender; close: () => void; db: Db | undefined } {
  return (recipient) => {
    const r = openMorningReport({ ...o, env: { ...o.env, REPORT_ENABLED: true, REPORT_RECIPIENT: recipient } });
    return { sender: r.report.sender, close: () => r.senderDb?.raw.close(), db: r.senderDb };
  };
}
