import { EventEmitter } from 'node:events';
import makeWASocket, { Browsers, DisconnectReason, makeCacheableSignalKeyStore } from 'baileys';
import type { AuthenticationState, BaileysEventMap, GroupMetadata } from 'baileys';
import { systemClock, type Clock } from '../util/clock.ts';
import type { AllowList } from './allowlist.ts';
import { backoffMs } from './backoff.ts';
import { normalizeMessage, normalizeReaction, normalizeUpdate, type NormalizedEvent } from './normalize.ts';

/** The subset of a Baileys socket the gateway uses. Deliberately has no send-type methods. */
export interface SocketLike {
  ev: { on<T extends keyof BaileysEventMap>(event: T, listener: (arg: BaileysEventMap[T]) => void): void };
  groupFetchAllParticipating(): Promise<{ [jid: string]: GroupMetadata }>;
  end(error: Error | undefined): Promise<void> | void;
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
export function baileysSocketFactory(logger: BaileysLogger): SocketFactory {
  return (auth, cachedGroupMetadata) =>
    makeWASocket({
      auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(auth.keys, logger) },
      logger,
      browser: Browsers.windows('Desktop'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      enableRecentMessageCache: false,
      getMessage: async () => undefined,
      cachedGroupMetadata,
    });
}

export type GatewayState = 'stopped' | 'connecting' | 'open' | 'closed' | 'logged_out' | 'replaced' | 'forbidden';

export interface GatewayStatus {
  state: GatewayState;
  since: string;
  lastErrorCode: number | null;
  credsSaveFailures: number;
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

export class WhatsAppGateway {
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
  #credsSaveFailures = 0;
  #stopped = false;

  constructor(opts: GatewayOptions) {
    this.#opts = opts;
    this.#clock = opts.clock ?? systemClock;
    this.#schedule = opts.scheduler ?? defaultScheduler;
    this.#status = { state: 'stopped', since: this.#clock.now().toISOString(), lastErrorCode: null };
  }

  onEvent(fn: (e: NormalizedEvent) => void): void {
    this.#emitter.on('event', fn);
  }

  onStatus(fn: (s: GatewayStatus) => void): void {
    this.#emitter.on('status', fn);
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
      void this.#opts.saveCreds().catch(() => {
        this.#credsSaveFailures++;
        this.#emitStatus();
      });
    });
    sock.ev.on('connection.update', (u) => this.#onConnection(sock, u));
    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const m of messages) {
        if (!this.#allowed(m.key.remoteJid)) continue;
        this.#deliver(() => normalizeMessage(m));
      }
    });
    sock.ev.on('messaging-history.set', ({ messages }) => {
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

  #allowed(jid: string | null | undefined): boolean {
    if (this.#opts.allow.has(jid)) return true;
    this.#dropped++;
    return false;
  }

  /** Normalise and emit one already-allowed item. A failure never escapes into Baileys. */
  #deliver(build: () => NormalizedEvent | null): void {
    if (this.#stopped) return;
    try {
      const e = build();
      if (e) this.#emitter.emit('event', e);
    } catch {
      this.#failed++;
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
