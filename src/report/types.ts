/** When the morning report goes out. Times are IST, "HH:MM". */
export interface ReportSettings {
  enabled: boolean;
  /** Earliest send time, default "06:00". */
  time: string;
  /** From this time on, a day not yet sent is skipped. Default "12:00". */
  deadline: string;
}

/**
 * sent: both messages left, with their WhatsApp ids.
 * failed: a definite failure before anything was sent (not linked, no connection, session refused). Safe to retry.
 * unknown: the send started and did not finish cleanly. It may have reached the founder, so it is never retried automatically.
 */
export type SendResult =
  | { status: 'sent'; messageIds: string[] }
  | { status: 'failed'; code: string }
  | { status: 'unknown'; code: string };

/** unreadable: data/sender-session.db is damaged or was written with another master key (fixed by link-sender --reset). */
export type SenderState = 'idle' | 'not_linked' | 'unreadable' | 'connecting' | 'open' | 'logged_out' | 'forbidden' | 'replaced';

export interface SenderStatus {
  state: SenderState;
  since: string;
  lastErrorCode: number | null;
}

/**
 * What the scheduler needs from a sender. The recipient is fixed when the sender is made and cannot be passed in.
 * SenderGateway (Baileys, spare number) implements it today; the official WhatsApp Business API could replace it later.
 */
export interface ReportSender {
  sendReport(text: string, xlsx: Buffer, fileName: string): Promise<SendResult>;
  status(): SenderStatus;
  stop(): Promise<void>;
}

/** The morning report's line in Health and `cli status`. warning is set only when the owner has to act. */
export interface ReportHealth {
  text: string;
  warning: string | null;
}
