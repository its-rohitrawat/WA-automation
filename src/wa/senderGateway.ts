import makeWASocket, { DisconnectReason, makeCacheableSignalKeyStore } from 'baileys';
import type { AnyMessageContent, AuthenticationState, BaileysEventMap, WAMessage } from 'baileys';
import { INDIAN_MOBILE, maskNumber } from '../config/env.ts';
import type { ReportSender, SenderState, SenderStatus, SendResult } from '../report/types.ts';
import { systemClock, type Clock } from '../util/clock.ts';
import type { EncryptedAuth } from './authState.ts';
import type { BaileysLogger } from './gateway.ts';

/** The subset of a Baileys socket the sender uses. Its send method is called in exactly one place: SenderGateway's #send. */
export interface SenderSocketLike {
  ev: { on<T extends keyof BaileysEventMap>(event: T, listener: (arg: BaileysEventMap[T]) => void): void };
  sendMessage(jid: string, content: AnyMessageContent): Promise<WAMessage | undefined>;
  end(error: Error | undefined): Promise<void> | void;
}

export type SenderSocketFactory = (auth: AuthenticationState) => SenderSocketLike;

/**
 * The logger passed in must be silent: Baileys logs JIDs. markOnlineOnConnect false makes Baileys announce "unavailable",
 * never "online". No history sync. enableRecentMessageCache keeps only this socket's own outgoing report in memory, so
 * Baileys can answer a retry request from the founder's phone while the socket is still open.
 */
/** How the spare phone lists this link under Linked devices. Fixed when the QR code is scanned. */
export const SENDER_DEVICE_NAME = 'WA Agent - Morning report';

export function baileysSenderSocketFactory(logger: BaileysLogger): SenderSocketFactory {
  return (auth) =>
    makeWASocket({
      auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(auth.keys, logger) },
      logger,
      browser: [SENDER_DEVICE_NAME, 'Desktop', '1.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
      enableRecentMessageCache: true,
      getMessage: async () => undefined,
    });
}

/** "919812345678" becomes "919812345678@s.whatsapp.net". Anything but 91 and a 10-digit Indian mobile is refused. */
export function recipientJid(digits: string): string {
  if (!INDIAN_MOBILE.test(digits)) throw new Error('REPORT_RECIPIENT must be 91 and the 10-digit Indian mobile, digits only');
  return `${digits}@s.whatsapp.net`;
}

/**
 * The phone number a saved link belongs to: the digits of creds.me.id before the device part (":5") or "@".
 * Undefined while nothing is linked.
 */
export function linkedNumber(auth: EncryptedAuth): string | undefined {
  const id = auth.state.creds.me?.id;
  return id ? id.split(/[:@]/)[0] : undefined;
}

export class RecipientRefusedError extends Error {
  constructor() {
    super('The morning report may go only to REPORT_RECIPIENT');
    this.name = 'RecipientRefusedError';
  }
}

/** Throws unless jid is exactly the configured recipient's JID. */
export function checkRecipient(jid: string, allowedJid: string): void {
  if (jid !== allowedJid) throw new RecipientRefusedError();
}

export type OpenFailure = 'not_linked' | 'connect_timeout' | 'logged_out' | 'forbidden' | 'replaced' | 'restart_required' | 'closed';

type Opened = { sock: SenderSocketLike } | { code: OpenFailure; statusCode: number | null };

function closeCode(statusCode: number | null): OpenFailure {
  if (statusCode === DisconnectReason.loggedOut) return 'logged_out';
  if (statusCode === DisconnectReason.forbidden) return 'forbidden';
  if (statusCode === DisconnectReason.connectionReplaced) return 'replaced';
  if (statusCode === DisconnectReason.restartRequired) return 'restart_required';
  return 'closed';
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** How long closing a socket may take. On a dead network ws waits up to 30 s for the close handshake. */
export const END_TIMEOUT_MS = 3_000;

/** Closes the socket, giving up after END_TIMEOUT_MS so a stop stays within the service's shutdown budget. */
async function endQuietly(sock: SenderSocketLike): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve(sock.end(undefined)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, END_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // closing an already-dead socket is fine
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Opens one socket and waits until it is open. Without onQr, a QR code means the session is not linked, so it gives up at
 * once. Listens only to creds.update and connection.update: it never reads chats.
 */
function openSocket(
  factory: SenderSocketFactory,
  auth: EncryptedAuth,
  timeoutMs: number,
  onQr?: (qr: string) => void,
  onSocket?: (sock: SenderSocketLike) => void,
): Promise<Opened> {
  const sock = factory(auth.state);
  onSocket?.(sock);
  sock.ev.on('creds.update', () => {
    // A failed save must not become an unhandled rejection, which would stop the service.
    void auth.saveCreds().catch(() => {});
  });
  return new Promise<Opened>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (r: Opened) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if ('code' in r) void endQuietly(sock);
      resolve(r);
    };
    // The timer starts after the listener is added: a listener that throws rejects this promise and leaves no timer.
    sock.ev.on('connection.update', (u) => {
      if (u.qr) {
        if (onQr) onQr(u.qr);
        else finish({ code: 'not_linked', statusCode: null });
      }
      if (u.connection === 'open') finish({ sock });
      else if (u.connection === 'close') {
        const statusCode = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode ?? null;
        finish({ code: closeCode(statusCode), statusCode });
      }
    });
    if (!settled) timer = setTimeout(() => finish({ code: 'connect_timeout', statusCode: null }), timeoutMs);
  });
}

export type LinkResult = { ok: true } | { ok: false; code: OpenFailure };

/**
 * Links the spare number by QR code (`cli link-sender`). After the scan WhatsApp asks for one restart, so up to 3 sockets
 * are opened in turn. Sends nothing.
 */
export async function linkSender(o: {
  factory: SenderSocketFactory;
  auth: EncryptedAuth;
  onQr: (qr: string) => void;
  timeoutMs: number;
  /** How long the linked socket stays open so Baileys can finish its first key uploads. Default 5 s. */
  settleMs?: number;
}): Promise<LinkResult> {
  for (let i = 0; i < 3; i++) {
    const r = await openSocket(o.factory, o.auth, o.timeoutMs, o.onQr);
    if ('sock' in r) {
      await delay(o.settleMs ?? 5_000);
      await o.auth.saveCreds();
      await endQuietly(r.sock);
      return { ok: true };
    }
    if (r.code !== 'restart_required') return { ok: false, code: r.code };
  }
  return { ok: false, code: 'closed' };
}

class SendTimeoutError extends Error {
  constructor() {
    super('WhatsApp did not confirm the send in time');
    this.name = 'SendTimeoutError';
  }
}

const FAILURE_STATE: Partial<Record<OpenFailure, SenderState>> = {
  not_linked: 'not_linked',
  logged_out: 'logged_out',
  forbidden: 'forbidden',
  replaced: 'replaced',
};

export interface SenderGatewayOptions {
  /** REPORT_RECIPIENT: the founder's number, digits only. The only chat this sender ever writes to. */
  recipient: string;
  /**
   * The number the founder-number reader is linked to (digits of its creds.me.id), which may differ from recipient. Like
   * recipient, it never sends: a spare-number link to it is refused ('self_send').
   */
  founderNumber?: string;
  factory: SenderSocketFactory;
  /** The spare number's session. Undefined when the stored session could not be opened or read. */
  auth: EncryptedAuth | undefined;
  /**
   * Why auth is undefined. 'unreadable' (the default): the file is damaged or was written with another key, and only
   * link-sender --reset fixes it. 'unavailable': the file could not be opened (disk, permissions or a lock), and a
   * restart may fix it.
   */
  authProblem?: 'unreadable' | 'unavailable';
  clock?: Clock;
  /** How long to wait for the connection to open. Default 60 s. */
  connectTimeoutMs?: number;
  /** How long the message may take. Default 120 s. */
  sendTimeoutMs?: number;
  /** How long the socket stays open after the message left, for WhatsApp's acks and retry requests. Default 15 s. */
  lingerMs?: number;
}

/**
 * The second Baileys session, on the spare number. Connects only while a report is being sent, then disconnects.
 * It has one send method, and the recipient is fixed at construction.
 */
export class SenderGateway implements ReportSender {
  readonly #jid: string;
  readonly #opts: SenderGatewayOptions;
  readonly #clock: Clock;
  #status: SenderStatus;
  #sock: SenderSocketLike | undefined;
  #busy = false;
  #stopped = false;
  /** Set while a sent report lingers; stop() calls it to end the linger early. */
  #endLinger: (() => void) | undefined;

  constructor(opts: SenderGatewayOptions) {
    this.#jid = recipientJid(opts.recipient);
    this.#opts = opts;
    this.#clock = opts.clock ?? systemClock;
    const state: SenderState = !opts.auth
      ? (opts.authProblem ?? 'unreadable')
      : !opts.auth.hasSession
        ? 'not_linked'
        : this.#linkedToFounder(opts.auth)
          ? 'self_send'
          : 'idle';
    this.#status = { state, since: this.#clock.now().toISOString(), lastErrorCode: null };
  }

  status(): SenderStatus {
    return { ...this.#status };
  }

  maskedRecipient(): string {
    return maskNumber(this.#opts.recipient);
  }

  /** Sends one text message, the report with the tracker link, and nothing else: no document. */
  async sendReport(text: string): Promise<SendResult> {
    const auth = this.#opts.auth;
    if (this.#stopped) return { status: 'failed', code: 'stopped' };
    if (this.#busy) return { status: 'failed', code: 'busy' };
    // The stored session could not be opened or read. The state stays as it is: only link-sender --reset fixes an
    // unreadable one, and only a restart reopens an unavailable one.
    if (!auth) return { status: 'failed', code: this.#opts.authProblem === 'unavailable' ? 'session_unavailable' : 'session_unreadable' };
    if (!auth.hasSession) {
      this.#setState('not_linked', null);
      return { status: 'failed', code: 'not_linked' };
    }
    // The link-sender QR code was scanned with the founder's phone (the recipient's, or the one the reader is linked to):
    // sending would come from the founder's own number.
    if (this.#linkedToFounder(auth)) {
      this.#setState('self_send', null);
      return { status: 'failed', code: 'self_send' };
    }
    this.#busy = true;
    this.#setState('connecting', null);
    try {
      let opened: Opened;
      try {
        opened = await openSocket(this.#opts.factory, auth, this.#opts.connectTimeoutMs ?? 60_000, undefined, (s) => {
          this.#sock = s;
        });
      } catch {
        // Thrown while making the socket or before it opened (the factory, or adding a listener): no message can have
        // left, so this is a definite failure the scheduler retries. The finally below closes a socket that was made.
        return { status: 'failed', code: 'connect_error' };
      }
      if ('code' in opened) {
        this.#setState(FAILURE_STATE[opened.code] ?? 'idle', opened.statusCode);
        return { status: 'failed', code: opened.code };
      }
      if (this.#stopped) return { status: 'failed', code: 'stopped' }; // nothing has been sent yet
      this.#setState('open', null);
      // From here on a failure may hide a message that reached the founder: the outcome is unknown, never retried.
      try {
        // linkPreview: null stops Baileys fetching a preview of the tracker link (or of any URL in the text).
        const ids = [await this.#send(opened.sock, this.#jid, { text, linkPreview: null })];
        // stop() ends the linger early: the id is back, so the result is still 'sent'.
        await this.#linger(this.#opts.lingerMs ?? 15_000);
        return { status: 'sent', messageIds: ids };
      } catch (err) {
        return { status: 'unknown', code: err instanceof SendTimeoutError ? 'timeout' : 'send_error' };
      }
    } finally {
      const sock = this.#sock;
      this.#sock = undefined;
      if (sock) await endQuietly(sock);
      this.#busy = false;
      if (this.#status.state === 'connecting' || this.#status.state === 'open') this.#setState('idle', null);
    }
  }

  /**
   * Ends a connection in progress. A send cut off before the message id came back is unknown; one in its linger is
   * still sent, and returns at once. Later sends are refused.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#endLinger?.();
    const sock = this.#sock;
    this.#sock = undefined;
    if (sock) await endQuietly(sock);
  }

  /** The only call to a Baileys send method in the codebase (tests/wa/sendScan.test.ts). */
  async #send(sock: SenderSocketLike, jid: string, content: AnyMessageContent): Promise<string> {
    checkRecipient(jid, this.#jid);
    let timer: NodeJS.Timeout | undefined;
    try {
      const msg = await Promise.race([
        sock.sendMessage(jid, content),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SendTimeoutError()), this.#opts.sendTimeoutMs ?? 120_000);
        }),
      ]);
      const id = msg?.key.id;
      if (!id) throw new Error('WhatsApp returned no message id');
      return id;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Waits ms, or until stop() ends the wait. Leaves no timer either way. */
  #linger(ms: number): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const end = () => {
        clearTimeout(timer);
        this.#endLinger = undefined;
        resolve();
      };
      const timer = setTimeout(end, ms);
      this.#endLinger = end;
    });
  }

  /** True when the saved link is the recipient's number or the founder reader's number. The founder's number never sends. */
  #linkedToFounder(auth: EncryptedAuth): boolean {
    const linked = linkedNumber(auth);
    return linked !== undefined && (linked === this.#opts.recipient || linked === this.#opts.founderNumber);
  }

  #setState(state: SenderState, code: number | null): void {
    this.#status = { state, since: this.#clock.now().toISOString(), lastErrorCode: code };
  }
}
