import type { ClientConfig } from '../config/groups.ts';
import type { Clock } from '../util/clock.ts';
import type { AllowList } from './allowlist.ts';
import type { PhoneId } from './authState.ts';
import type { ChatDeleteSocket } from './chatDelete.ts';
import type { EventHandler, GatewayLike, GatewayState, GatewayStatus, HistoryAnchor, HistoryAnswer } from './gateway.ts';
import type { GroupMember } from './groupMembers.ts';
import type { GroupSendSocket } from './groupSend.ts';
import { NotConnectedError } from './switchableGateway.ts';

// A workspace's reading phones behind the one gateway the app has (lane C, change 7; the design's "How a runtime holds
// N gateways"). Each phone has its own gateway and its own allow-list: the groups approved on that phone, so a group is
// read through one phone only, once, even when several phones are in it. The app, the ingest and the brain see one
// gateway, as before: events come one at a time in the order they came; a group's socket and history requests go to its
// own phone; the status is open only when every phone is.

/** One reading phone in the set: its number and name, its gateway (a SwitchableGateway in the runtime), its allow-list. */
export interface PhoneSlot {
  id: PhoneId;
  label: string;
  gateway: GatewayLike;
  /** The allow-list its gateway filters with: setConfigs keeps it to the groups approved on this phone. */
  allow: AllowList;
}

/**
 * The set's status: the worst phone's, with that phone named (undefined when every phone is open, or there is none), and
 * how many phones the set has (health names the phone only when there are several).
 */
export type PhoneSetStatus = GatewayStatus & { phone?: { id: PhoneId; label: string }; count?: number };

export interface PhoneView {
  id: PhoneId;
  label: string;
  status: GatewayStatus;
}

/** Worst first: what the combined status shows when phones differ. */
const SEVERITY: readonly GatewayState[] = ['forbidden', 'replaced', 'logged_out', 'not_linked', 'closed', 'connecting', 'linking', 'stopped', 'open'];

/** A group's phone in its approved entry; missing (every group before phones were numbered) is phone 1. */
export const phoneOfConfig = (c: ClientConfig): PhoneId => ((c as ClientConfig & { phone?: PhoneId }).phone ?? 1);

interface Member extends PhoneSlot {
  /** False once removed: its late events and statuses are ignored. */
  live: boolean;
}

export class PhoneSet implements GatewayLike {
  readonly #clock: Clock;
  readonly #members = new Map<PhoneId, Member>();
  readonly #eventFns: EventHandler[] = [];
  readonly #statusFns: ((s: PhoneSetStatus) => void)[] = [];
  readonly #historyFns: ((a: HistoryAnswer) => void)[] = [];
  /** Every phone's events go through this one chain, so the app gets them one at a time, as from one gateway. */
  #serial: Promise<unknown> = Promise.resolve();
  #configs: readonly ClientConfig[] = [];
  /** groupId → its phone, from the approved groups. */
  #phoneOf = new Map<string, PhoneId>();
  #running = false;
  #last: PhoneSetStatus;
  /** Removed phones' counts, so the totals do not go down when a phone goes. */
  #retiredFailed = 0;
  #retiredDropped = 0;

  constructor(o: { clock: Clock }) {
    this.#clock = o.clock;
    this.#last = this.#combine();
  }

  /** Adds a phone (the runtime built its gateway on that phone's session). Started at once if the set is running. */
  add(slot: PhoneSlot): void {
    if (this.#members.has(slot.id)) throw new Error(`phone ${slot.id} is already in the set`);
    const m: Member = { ...slot, live: true };
    this.#members.set(slot.id, m);
    m.allow.replace(this.#groupsOf(m.id));
    m.gateway.onEvent((e) => (m.live ? this.#forward(e) : undefined));
    m.gateway.onStatus(() => {
      if (m.live) this.#statusChanged();
    });
    m.gateway.onHistory?.((a) => {
      if (m.live) for (const fn of this.#historyFns) fn(a);
    });
    if (this.#running) m.gateway.start();
    this.#statusChanged();
  }

  /** Stops one phone and takes it out (an unlink): its groups are then read by no phone until moved or relinked. */
  async remove(id: PhoneId): Promise<void> {
    const m = this.#members.get(id);
    if (!m) return;
    this.#members.delete(id);
    try {
      await m.gateway.stop();
      await m.gateway.idle?.(); // what it had already taken goes through
    } finally {
      this.#retiredFailed += m.gateway.failedCount();
      this.#retiredDropped += m.gateway.droppedCount();
      m.live = false;
      this.#statusChanged();
    }
  }

  /** A phone's new name (the phone list renamed it): its status and phones() show it from now on. */
  rename(id: PhoneId, label: string): void {
    const m = this.#members.get(id);
    if (!m) return;
    m.label = label;
    this.#statusChanged();
  }

  /** The approved groups changed (or at start): each phone's allow-list becomes the groups approved on it. */
  setConfigs(configs: readonly ClientConfig[]): void {
    this.#configs = configs;
    this.#phoneOf = new Map(configs.map((c) => [c.groupId, phoneOfConfig(c)]));
    for (const m of this.#members.values()) m.allow.replace(this.#groupsOf(m.id));
  }

  /** The phone a group is approved on; undefined when it is not approved. */
  phoneOf(groupId: string): PhoneId | undefined {
    return this.#phoneOf.get(groupId);
  }

  /** Whether the group's own phone is in the set and open (Open chat, the history backfill). */
  isOpenFor(groupId: string): boolean {
    const id = this.#phoneOf.get(groupId);
    const m = id === undefined ? undefined : this.#members.get(id);
    return m !== undefined && m.gateway.status().state === 'open';
  }

  phones(): PhoneView[] {
    return [...this.#members.values()].sort((a, b) => a.id - b.id).map((m) => ({ id: m.id, label: m.label, status: m.gateway.status() }));
  }

  // --- GatewayLike ---

  onEvent(fn: EventHandler): void {
    this.#eventFns.push(fn);
  }

  onStatus(fn: (s: GatewayStatus) => void): void {
    this.#statusFns.push(fn);
  }

  onHistory(fn: (a: HistoryAnswer) => void): void {
    this.#historyFns.push(fn);
  }

  status(): PhoneSetStatus {
    return this.#last;
  }

  start(): void {
    this.#running = true;
    for (const m of this.#members.values()) m.gateway.start();
    this.#statusChanged();
  }

  async stop(): Promise<void> {
    this.#running = false;
    await Promise.all([...this.#members.values()].map((m) => m.gateway.stop()));
  }

  /** Every phone's events taken so far, and the chain they go through to the app. */
  async idle(): Promise<void> {
    await Promise.all([...this.#members.values()].map((m) => m.gateway.idle?.()));
    await this.#serial;
  }

  /** The open phones' groups, each with the phones that see it. None open: not connected, as one gateway says. */
  async listGroups(): Promise<{ id: string; subject: string; phones: PhoneId[] }[]> {
    const open = [...this.#members.values()].filter((m) => m.gateway.status().state === 'open').sort((a, b) => a.id - b.id);
    if (open.length === 0) throw new NotConnectedError();
    const lists = await Promise.allSettled(open.map((m) => m.gateway.listGroups()));
    const byId = new Map<string, { id: string; subject: string; phones: PhoneId[] }>();
    lists.forEach((r, i) => {
      if (r.status !== 'fulfilled') return;
      for (const g of r.value) {
        const seen = byId.get(g.id);
        if (seen) seen.phones.push(open[i]!.id);
        else byId.set(g.id, { id: g.id, subject: g.subject, phones: [open[i]!.id] });
      }
    });
    if (byId.size === 0 && lists.every((r) => r.status === 'rejected')) throw (lists[0] as PromiseRejectedResult).reason;
    return [...byId.values()].sort((a, b) => (a.subject ?? '').localeCompare(b.subject ?? ''));
  }

  failedCount(): number {
    return this.#retiredFailed + [...this.#members.values()].reduce((n, m) => n + m.gateway.failedCount(), 0);
  }

  droppedCount(): number {
    return this.#retiredDropped + [...this.#members.values()].reduce((n, m) => n + m.gateway.droppedCount(), 0);
  }

  /** Asks the group's own phone; false when that phone is not in the set or cannot ask. */
  async fetchHistory(groupId: string, anchor: HistoryAnchor, count: number): Promise<boolean> {
    const m = this.#memberFor(groupId);
    return m?.gateway.fetchHistory ? m.gateway.fetchHistory(groupId, anchor, count) : false;
  }

  /** The group's own phone's socket; null when that phone is not in the set or not open (never another phone's). */
  groupSocket(groupId: string): GroupSendSocket | null {
    return this.#memberFor(groupId)?.gateway.groupSocket?.(groupId) ?? null;
  }

  /** The group's members, read through its own phone; null when that phone is not in the set or cannot ask. */
  async groupMembers(groupId: string): Promise<GroupMember[] | null> {
    const m = this.#memberFor(groupId);
    return m?.gateway.groupMembers ? m.gateway.groupMembers(groupId) : null;
  }

  /** Delete chat's socket: the group's own phone's only, null otherwise (never another phone's). */
  chatDeleteSocket(groupId: string): ChatDeleteSocket | null {
    return this.#memberFor(groupId)?.gateway.chatDeleteSocket?.(groupId) ?? null;
  }

  #memberFor(groupId: string): Member | undefined {
    const id = this.#phoneOf.get(groupId);
    return id === undefined ? undefined : this.#members.get(id);
  }

  #groupsOf(id: PhoneId): string[] {
    return this.#configs.filter((c) => phoneOfConfig(c) === id).map((c) => c.groupId);
  }

  /** One event through the one chain; its promise is the phone's to await, and rejects when a handler throws. */
  #forward(e: Parameters<EventHandler>[0]): Promise<void> {
    const run = this.#serial.then(async () => {
      for (const fn of this.#eventFns) await fn(e);
    });
    this.#serial = run.catch(() => undefined);
    return run;
  }

  #combine(): PhoneSetStatus {
    const members = [...this.#members.values()].sort((a, b) => a.id - b.id);
    const count = members.length;
    if (count === 0) return { state: 'not_linked', since: this.#clock.now().toISOString(), lastErrorCode: null, credsSaveFailures: 0, count };
    // A phone waiting for its first link (added, not linked yet) is not a failure while another phone is linked: it does
    // not make the whole set "not linked" (setup mode) when phone 1 reads. Only when no phone is linked does it count.
    const linked = members.filter((m) => m.gateway.status().state !== 'not_linked');
    const pool = linked.length > 0 ? linked : members;
    let worst = pool[0]!;
    for (const m of pool) if (SEVERITY.indexOf(m.gateway.status().state) < SEVERITY.indexOf(worst.gateway.status().state)) worst = m;
    const s = worst.gateway.status();
    const credsSaveFailures = members.reduce((n, m) => n + m.gateway.status().credsSaveFailures, 0);
    if (s.state === 'open') {
      const since = pool.map((m) => m.gateway.status().since).sort().at(-1)!; // open since the last phone opened
      return { state: 'open', since, lastErrorCode: null, credsSaveFailures, count };
    }
    return { ...s, credsSaveFailures, phone: { id: worst.id, label: worst.label }, count };
  }

  /** Recomputes the combined status, and tells the listeners only when it changed. */
  #statusChanged(): void {
    const next = this.#combine();
    const key = (s: PhoneSetStatus) => `${s.state}|${s.phone?.id ?? ''}|${s.lastErrorCode ?? ''}|${s.credsSaveFailures}`;
    const changed = key(next) !== key(this.#last);
    this.#last = changed ? next : this.#last;
    if (changed) for (const fn of this.#statusFns) fn(next);
  }
}
