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
  end(error: Error | undefined): void;
}

export type SocketFactory = (
  auth: AuthenticationState,
  cachedGroupMetadata: (jid: string) => Promise<GroupMetadata | undefined>,
) => SocketLike;

export type BaileysLogger = NonNullable<Parameters<typeof makeWASocket>[0]['logger']>;

export function baileysSocketFactory(logger: BaileysLogger): SocketFactory {
  return (auth, cachedGroupMetadata) =>
    makeWASocket({
      auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(auth.keys, logger) },
      logger,
      browser: Browsers.windows('Desktop'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined,
      cachedGroupMetadata,
    });
}

export type GatewayState = 'stopped' | 'connecting' | 'open' | 'closed' | 'logged_out' | 'replaced';

export interface GatewayStatus {
  state: GatewayState;
  since: string;
  lastErrorCode: number | null;
}

export type Scheduler = (fn: () => void, ms: number) => { cancel(): void };

const defaultScheduler: Scheduler = (fn, ms) => {
  const t = setTimeout(fn, ms);
  return { cancel: () => clearTimeout(t) };
};

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
  readonly #groupCache = new Map<string, GroupMetadata>();
  readonly #clock: Clock;
  readonly #schedule: Scheduler;
  #sock: SocketLike | undefined;
  #attempt = 0;
  #reconnect: { cancel(): void } | undefined;
  #status: GatewayStatus;
  #dropped = 0;

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
    return { ...this.#status };
  }

  droppedCount(): number {
    return this.#dropped;
  }

  start(): void {
    this.#connect();
  }

  stop(): void {
    this.#reconnect?.cancel();
    this.#reconnect = undefined;
    const sock = this.#sock;
    this.#sock = undefined;
    sock?.end(undefined);
    this.#setStatus('stopped', null);
  }

  /** Group names and ids for `cli list-groups`. Reads no messages. */
  async listGroups(): Promise<{ id: string; subject: string }[]> {
    if (!this.#sock || this.#status.state !== 'open') throw new Error('WhatsApp is not connected');
    const groups = await this.#sock.groupFetchAllParticipating();
    return Object.values(groups)
      .map((g) => ({ id: g.id, subject: g.subject }))
      .sort((a, b) => a.subject.localeCompare(b.subject));
  }

  #connect(): void {
    this.#setStatus('connecting', null);
    const sock = this.#opts.factory(this.#opts.auth, async (jid) => this.#groupCache.get(jid));
    this.#sock = sock;
    sock.ev.on('creds.update', () => {
      void this.#opts.saveCreds();
    });
    sock.ev.on('connection.update', (u) => this.#onConnection(sock, u));
    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const m of messages) {
        if (!this.#allowed(m.key.remoteJid)) continue;
        this.#emit(normalizeMessage(m));
      }
    });
    sock.ev.on('messaging-history.set', ({ messages }) => {
      for (const m of messages) {
        if (!this.#allowed(m.key.remoteJid)) continue;
        this.#emit(normalizeMessage(m));
      }
    });
    sock.ev.on('messages.update', (updates) => {
      for (const u of updates) {
        if (!this.#allowed(u.key.remoteJid)) continue;
        this.#emit(normalizeUpdate(u));
      }
    });
    sock.ev.on('messages.reaction', (reactions) => {
      for (const r of reactions) {
        if (!this.#allowed(r.key.remoteJid)) continue;
        this.#emit(normalizeReaction(r));
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

  #emit(e: NormalizedEvent | null): void {
    if (e) this.#emitter.emit('event', e);
  }

  #onConnection(sock: SocketLike, u: BaileysEventMap['connection.update']): void {
    if (sock !== this.#sock) return; // event from an old socket
    if (u.qr) this.#opts.onQr?.(u.qr);
    if (u.connection === 'open') {
      this.#attempt = 0;
      this.#setStatus('open', null);
      return;
    }
    if (u.connection !== 'close') return;
    const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode ?? null;
    this.#sock = undefined;
    if (code === DisconnectReason.loggedOut) {
      this.#setStatus('logged_out', code);
      return;
    }
    if (code === DisconnectReason.connectionReplaced) {
      this.#setStatus('replaced', code);
      return;
    }
    this.#setStatus('closed', code);
    const delay = code === DisconnectReason.restartRequired ? 0 : backoffMs(this.#attempt++);
    this.#reconnect = this.#schedule(() => {
      this.#reconnect = undefined;
      this.#connect();
    }, delay);
  }

  #setStatus(state: GatewayState, code: number | null): void {
    this.#status = { state, since: this.#clock.now().toISOString(), lastErrorCode: code };
    this.#emitter.emit('status', this.status());
  }
}
