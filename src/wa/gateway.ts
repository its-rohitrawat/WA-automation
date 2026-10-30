import { EventEmitter } from 'node:events';
import makeWASocket, { DisconnectReason, makeCacheableSignalKeyStore, proto } from 'baileys';
import type { AuthenticationState, BaileysEventMap, GroupMetadata } from 'baileys';
import { systemClock, type Clock } from '../util/clock.ts';
import type { AllowList } from './allowlist.ts';
import { backoffMs } from './backoff.ts';
import { asGroupSendSocket, type GroupSendSocket } from './groupSend.ts';
import { normalizeMessage, normalizeReaction, normalizeUpdate, type NormalizedEvent } from './normalize.ts';

/**
 * The subset of a Baileys socket the gateway uses. Deliberately has no send-type methods. fetchMessageHistory is the
 * one request it makes: it asks the founder's own phone (Baileys addresses it to the account's own number, as a peer
 * request) for earlier messages of one chat. Nothing reaches any chat or any other person.
 */
export interface SocketLike {
  ev: { on<T extends keyof BaileysEventMap>(event: T, listener: (arg: BaileysEventMap[T]) => void): void };
  groupFetchAllParticipating(): Promise<{ [jid: string]: GroupMetadata }>;
  fetchMessageHistory(count: number, oldestMsgKey: { remoteJid: string; fromMe: boolean; id: string }, oldestMsgTimestamp: number): Promise<string>;
  end(error: Error | undefined): Promise<void> | void;
}

/** WhatsApp's limit per history request. */
export const HISTORY_PAGE_MAX = 50;

/** The stored message a history request pages back from. */
export interface HistoryAnchor {
  waId: string;
  fromMe: boolean;
  ts: Date;
}

/** One on-demand history answer: the allowed groups' events in it, per group (none when WhatsApp sent nothing). */
export interface HistoryAnswer {
  groups: { groupId: string; events: NormalizedEvent[] }[];
}

export type SocketFactory = (
  auth: AuthenticationState,
  cachedGroupMetadata: (jid: string) => Promise<GroupMetadata | undefined>,
) => SocketLike;

export type BaileysLogger = NonNullable<Parameters<typeof makeWASocket>[0]['logger']>;

/**
 * The logger passed in must be silent (or censor everything): Baileys logs JIDs and push names.
 * enableRecentMessageCache is off so Baileys keeps no cross-chat plaintext cache and has nothing to resend on retry receipts.
 */
/** How the founder's phone lists this link under Linked devices. Fixed when the QR code is scanned. */
export const TRACKER_DEVICE_NAME = 'WA Agent - Tracker';

/**
 * Baileys' getMessage: what to send again when a member's phone asks for a message it could not read (a retry receipt).
 * Only a message this agent sent from the dashboard (Open chat, src/wa/groupSend.ts), found by its id in that group
 * (sentText reads the outbox), and only as its text. Anything else: undefined, as before.
 */
export function retryMessage(sentText?: SentText): (key: { id?: string | null; remoteJid?: string | null }) => Promise<{ conversation: string } | undefined> {
  return async (key) => {
    const text = sentText && key.id && key.remoteJid ? await sentText(key.id, key.remoteJid) : undefined;
    return text === undefined ? undefined : { conversation: text };
  };
}

/** The outbox lookup for retryMessage: the text the agent sent as this message, if any. May read the database (a promise). */
export type SentText = (waId: string, groupId: string) => string | undefined | Promise<string | undefined>;

/** sentText: the outbox lookup for retryMessage (left out: getMessage answers nothing). */
export function baileysSocketFactory(logger: BaileysLogger, sentText?: SentText): SocketFactory {
  return (auth, cachedGroupMetadata) =>
    makeWASocket({
      auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(auth.keys, logger) },
      logger,
      browser: [TRACKER_DEVICE_NAME, 'Desktop', '1.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      enableRecentMessageCache: false,
      getMessage: retryMessage(sentText),
      cachedGroupMetadata,
    });
}

/**
 * 'not_linked' and 'linking' come only from SwitchableGateway: no founder link yet (setup mode), or a relink from the
 * dashboard in progress. WhatsAppGateway itself never reports them.
 */
export type GatewayState = 'stopped' | 'connecting' | 'open' | 'closed' | 'logged_out' | 'replaced' | 'forbidden' | 'not_linked' | 'linking';

export interface GatewayStatus {
  state: GatewayState;
  since: string;
  lastErrorCode: number | null;
  credsSaveFailures: number;
}

/**
 * An event handler. A promise it returns is awaited before the next event is handed over, so events are handled one
 * after another, in the order they came (SaaS S1.10: the ingest awaits the database). A throw or a rejection counts the
 * event as failed (failedCount).
 */
export type EventHandler = (e: NormalizedEvent) => unknown;

/** What the app and the dashboard use of a founder gateway: WhatsAppGateway, or the SwitchableGateway holding one. */
export interface GatewayLike {
  onEvent(fn: EventHandler): void;
  /** Resolves once the events handed over so far are handled (shutdown waits for it before the database closes). */
  idle?(): Promise<void>;
  onStatus(fn: (s: GatewayStatus) => void): void;
  status(): GatewayStatus;
  start(): void;
  stop(): Promise<void>;
  listGroups(): Promise<{ id: string; subject: string }[]>;
  failedCount(): number;
  droppedCount(): number;
  /** Answers to fetchHistory, never delivered through onEvent (src/wa/historyBackfill.ts decides what to keep). */
  onHistory?(fn: (a: HistoryAnswer) => void): void;
  /**
   * Asks the founder's phone for up to `count` messages of an allowed group older than `anchor`. Only while open; false
   * when it was not asked (not open, not allowed, stopped, or the request failed).
   */
  fetchHistory?(groupId: string, anchor: HistoryAnchor, count: number): Promise<boolean>;
  /**
   * The socket for src/wa/groupSend.ts, for an allowed group while open; null otherwise. Used only by the dashboard's
   * Open chat, after the owner confirmed the message.
   */
  groupSocket?(groupId: string): GroupSendSocket | null;
}

export type Scheduler = (fn: () => void, ms: number) => { cancel(): void };

const defaultScheduler: Scheduler = (fn, ms) => {
  const t = setTimeout(fn, ms);
  return { cancel: () => clearTimeout(t) };
};

/** A connection must stay open this long before the backoff attempt counter resets. */
const STABLE_OPEN_MS = 60_000;

export interface GatewayOptions {
  allow: AllowList;
  factory: SocketFactory;
  auth: AuthenticationState;
  saveCreds: () => Promise<void>;
  clock?: Clock;
  scheduler?: Scheduler;
  onQr?: (qr: string) => void;
}

export class WhatsAppGateway implements GatewayLike {
  readonly #opts: GatewayOptions;
  readonly #emitter = new EventEmitter();
  /** Baileys only reads cachedGroupMetadata on the send path, which this passive client never uses. Kept for completeness. */
  readonly #groupCache = new Map<string, GroupMetadata>();
  readonly #clock: Clock;
  readonly #schedule: Scheduler;
  #sock: SocketLike | undefined;
  #attempt = 0;
  #restarts = 0;
  #reconnect: { cancel(): void } | undefined;
  #stable: { cancel(): void } | undefined;
  #status: Omit<GatewayStatus, 'credsSaveFailures'>;
  #dropped = 0;
  #failed = 0;
  readonly #eventFns: EventHandler[] = [];
  /** Events waiting for the handler of an earlier one to finish. */
  readonly #pending: NormalizedEvent[] = [];
  #handing = false;
  #handed: Promise<void> = Promise.resolve();
  #credsSaveFailures = 0;
  #stopped = false;

  constructor(opts: GatewayOptions) {
    this.#opts = opts;
    this.#clock = opts.clock ?? systemClock;
    this.#schedule = opts.scheduler ?? defaultScheduler;
    this.#status = { state: 'stopped', since: this.#clock.now().toISOString(), lastErrorCode: null };
  }

  onEvent(fn: EventHandler): void {
    this.#eventFns.push(fn);
  }

  idle(): Promise<void> {
    return this.#handed;
  }

  onStatus(fn: (s: GatewayStatus) => void): void {
    this.#emitter.on('status', fn);
  }

  onHistory(fn: (a: HistoryAnswer) => void): void {
    this.#emitter.on('history', fn);
  }

  async fetchHistory(groupId: string, anchor: HistoryAnchor, count: number): Promise<boolean> {
    const sock = this.#sock;
    // The allow-list again here: an unapproved group is never asked for.
    if (this.#stopped || !sock || this.#status.state !== 'open' || !this.#opts.allow.has(groupId)) return false;
    try {
      // The protocol field is oldestMsgTimestampMs: milliseconds.
      await sock.fetchMessageHistory(Math.max(1, Math.min(HISTORY_PAGE_MAX, count)), { remoteJid: groupId, fromMe: anchor.fromMe, id: anchor.waId }, anchor.ts.getTime());
      return true;
    } catch {
      return false; // never the error: it can carry the request
    }
  }

  groupSocket(groupId: string): GroupSendSocket | null {
    const sock = this.#sock;
    // The allow-list again here: a group that is not approved never gets a socket.
    if (this.#stopped || !sock || this.#status.state !== 'open' || !this.#opts.allow.has(groupId)) return null;
    return asGroupSendSocket(sock);
  }

  status(): GatewayStatus {
    return { ...this.#status, credsSaveFailures: this.#credsSaveFailures };
  }

  droppedCount(): number {
    return this.#dropped;
  }

  /** Events whose normalisation or listener threw. Counts only, never content. */
  failedCount(): number {
    return this.#failed;
  }

  start(): void {
    this.#stopped = false;
    if (this.#sock || this.#reconnect) return;
    this.#attempt = 0;
    this.#restarts = 0;
    this.#connect();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#reconnect?.cancel();
    this.#reconnect = undefined;
    this.#stable?.cancel();
    this.#stable = undefined;
    const sock = this.#sock;
    this.#sock = undefined;
    this.#setStatus('stopped', null);
    try {
      await sock?.end(undefined);
    } catch {
      // closing an already-dead socket is fine
    }
  }

  /** Group names and ids for `cli list-groups`. Reads no messages. */
  async listGroups(): Promise<{ id: string; subject: string }[]> {
    if (!this.#sock || this.#status.state !== 'open') throw new Error('WhatsApp is not connected');
    const groups = await this.#sock.groupFetchAllParticipating();
    return Object.values(groups)
      .map((g) => ({ id: g.id, subject: g.subject }))
      .sort((a, b) => (a.subject ?? '').localeCompare(b.subject ?? ''));
  }

  #connect(): void {
    if (this.#stopped) return;
    this.#setStatus('connecting', this.#status.lastErrorCode);
    if (this.#stopped || this.#sock) return; // stopped, or a re-entrant start() already connected
    const sock = this.#opts.factory(this.#opts.auth, async (jid) => this.#groupCache.get(jid));
    this.#sock = sock;
    sock.ev.on('creds.update', () => {
      void this.#opts.saveCreds().then(
        () => {
          if (this.#credsSaveFailures === 0) return;
          this.#credsSaveFailures = 0;
          this.#emitStatus();
        },
        () => {
          this.#credsSaveFailures++;
          this.#emitStatus();
        },
      );
    });
    sock.ev.on('connection.update', (u) => this.#onConnection(sock, u));
    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const m of messages) {
        if (!this.#allowed(m.key.remoteJid)) continue;
        this.#deliver(() => normalizeMessage(m));
      }
    });
    sock.ev.on('messaging-history.set', ({ messages, syncType }) => {
      if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) return this.#onDemand(messages);
      for (const m of messages) {
        if (!this.#allowed(m.key.remoteJid)) continue;
        this.#deliver(() => normalizeMessage(m));
      }
    });
    sock.ev.on('messages.update', (updates) => {
      for (const u of updates) {
        if (!this.#allowed(u.key.remoteJid)) continue;
        this.#deliver(() => normalizeUpdate(u));
      }
    });
    sock.ev.on('messages.reaction', (reactions) => {
      for (const r of reactions) {
        if (!this.#allowed(r.key.remoteJid)) continue;
        this.#deliver(() => normalizeReaction(r));
      }
    });
    sock.ev.on('groups.upsert', (groups) => {
      for (const g of groups) if (this.#opts.allow.has(g.id)) this.#groupCache.set(g.id, g);
    });
  }

  /** An answer to fetchHistory: the allowed groups' events, grouped, on the history channel only. */
  #onDemand(messages: BaileysEventMap['messaging-history.set']['messages']): void {
    if (this.#stopped) return;
    const groups = new Map<string, NormalizedEvent[]>();
    for (const m of messages) {
      if (!this.#allowed(m.key.remoteJid)) continue;
      let e: NormalizedEvent | null;
      try {
        e = normalizeMessage(m);
      } catch {
        this.#failed++;
        continue;
      }
      if (!e) continue;
      const list = groups.get(e.groupId) ?? [];
      list.push(e);
      groups.set(e.groupId, list);
    }
    try {
      this.#emitter.emit('history', { groups: [...groups].map(([groupId, events]) => ({ groupId, events })) } satisfies HistoryAnswer);
    } catch {
      this.#failed++;
    }
  }

  #allowed(jid: string | null | undefined): boolean {
    if (this.#opts.allow.has(jid)) return true;
    this.#dropped++;
    return false;
  }

  /** Normalise and hand over one already-allowed item. A failure never escapes into Baileys. */
  #deliver(build: () => NormalizedEvent | null): void {
    if (this.#stopped) return;
    let e: NormalizedEvent | null;
    try {
      e = build();
    } catch {
      this.#failed++;
      return;
    }
    if (!e) return;
    this.#pending.push(e);
    if (!this.#handing) this.#handed = this.#handOver();
  }

  /**
   * Hands the waiting events to the handlers, one after another. With synchronous handlers it all runs before
   * #deliver returns; a handler's promise makes the rest wait for it, and events that come meanwhile queue behind.
   */
  async #handOver(): Promise<void> {
    this.#handing = true;
    try {
      for (let e = this.#pending.shift(); e !== undefined; e = this.#pending.shift()) {
        try {
          for (const fn of this.#eventFns) {
            const r = fn(e);
            if (r instanceof Promise) await r;
          }
        } catch {
          this.#failed++;
        }
      }
    } finally {
      this.#handing = false;
    }
  }

  #onConnection(sock: SocketLike, u: BaileysEventMap['connection.update']): void {
    if (this.#stopped || sock !== this.#sock) return; // stopped, or event from an old socket
    if (u.qr) this.#opts.onQr?.(u.qr);
    if (u.connection === 'open') {
      this.#setStatus('open', null);
      if (this.#stopped) return;
      this.#stable?.cancel();
      this.#stable = this.#schedule(() => {
        this.#stable = undefined;
        this.#attempt = 0;
        this.#restarts = 0;
      }, STABLE_OPEN_MS);
      return;
    }
    if (u.connection !== 'close') return;
    const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode ?? null;
    this.#sock = undefined;
    this.#stable?.cancel();
    this.#stable = undefined;
    const terminal: Partial<Record<number, GatewayState>> = {
      [DisconnectReason.loggedOut]: 'logged_out',
      [DisconnectReason.connectionReplaced]: 'replaced',
      [DisconnectReason.forbidden]: 'forbidden',
    };
    const end = code === null ? undefined : terminal[code];
    if (end) {
      this.#setStatus(end, code);
      return;
    }
    this.#setStatus('closed', code);
    if (this.#stopped || this.#sock) return; // stopped, or a listener already started a new connection
    const delay = code === DisconnectReason.restartRequired && this.#restarts++ === 0 ? 0 : backoffMs(this.#attempt++);
    this.#reconnect = this.#schedule(() => {
      this.#reconnect = undefined;
      this.#connect();
    }, delay);
  }

  #setStatus(state: GatewayState, code: number | null): void {
    this.#status = { state, since: this.#clock.now().toISOString(), lastErrorCode: code };
    this.#emitStatus();
  }

  #emitStatus(): void {
    try {
      this.#emitter.emit('status', this.status());
    } catch {
      // a faulty status listener must not break the connection
    }
  }
}
