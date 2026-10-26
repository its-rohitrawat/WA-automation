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
 * the service: it is logged, the sender reports 'unreadable', and Health tells the owner what to run. The log shows only
 * the last 4 digits of REPORT_RECIPIENT.
 */
export function openMorningReport(o: { env: Env; masterKey: Buffer; log: Logger; factory: SenderSocketFactory }): MorningReportStart {
  const recipient = reportRecipient(o.env);
  const opened = openSenderSession(senderSessionDbPath(o.env.DATA_DIR), o.masterKey);
  if (!opened.ok) o.log.error({ reason: 'session_unreadable', code: opened.code }, 'morning report: the spare number session cannot be read');
  const auth = opened.ok ? opened.auth : undefined;
  let sender: SenderGateway;
  try {
    sender = new SenderGateway({ recipient, factory: o.factory, auth });
  } catch (err) {
    if (opened.ok) opened.db.close(); // the caller never receives the handle
    throw err;
  }
  // recipientLast4, not recipient: the logger censors any field named recipient.
  o.log.info({ recipientLast4: maskNumber(recipient), linked: auth?.hasSession ?? false }, 'morning report enabled');
  return { report: { sender, settings: reportSettings(o.env) }, senderDb: opened.ok ? opened.db : undefined };
}
