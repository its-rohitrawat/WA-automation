import { describe, expect, it } from 'vitest';
import type { ClientConfig } from '../../src/config/groups.ts';
import { AllowList } from '../../src/wa/allowlist.ts';
import type { GatewayLike, GatewayState, GatewayStatus, HistoryAnswer } from '../../src/wa/gateway.ts';
import type { ChatDeleteSocket } from '../../src/wa/chatDelete.ts';
import type { GroupMember } from '../../src/wa/groupMembers.ts';
import type { GroupSendSocket } from '../../src/wa/groupSend.ts';
import type { NormalizedEvent } from '../../src/wa/normalize.ts';
import { PhoneSet } from '../../src/wa/phoneSet.ts';
import { manualClock } from '../../src/util/clock.ts';

// The PhoneSet (lane C, change 7): one gateway per reading phone, behind the one gateway the app has. Fake gateways
// here; each filters by its own allow-list, as WhatsAppGateway does.

const AT = '2026-11-02T10:00:00.000Z';
const G1 = '120363000000000001@g.us';
const G2 = '120363000000000002@g.us';
const G3 = '120363000000000003@g.us';

/** A phone's gateway, faked: its state, the events it hands over (only its allowed groups), its groups, its socket. */
class FakeGateway implements GatewayLike {
  readonly allow: AllowList;
  state: GatewayState = 'stopped';
  started = 0;
  stopped = 0;
  groups: { id: string; subject: string }[] = [];
  asked: string[] = [];
  #events: ((e: NormalizedEvent) => unknown)[] = [];
  #statuses: ((s: GatewayStatus) => void)[] = [];
  #history: ((a: HistoryAnswer) => void)[] = [];
  #pending: Promise<unknown> = Promise.resolve();
  dropped = 0;
  constructor(allow: AllowList) {
    this.allow = allow;
  }
  onEvent(fn: (e: NormalizedEvent) => unknown): void {
    this.#events.push(fn);
  }
  onStatus(fn: (s: GatewayStatus) => void): void {
    this.#statuses.push(fn);
  }
  onHistory(fn: (a: HistoryAnswer) => void): void {
    this.#history.push(fn);
  }
  status(): GatewayStatus {
    return { state: this.state, since: AT, lastErrorCode: this.state === 'closed' ? 428 : null, credsSaveFailures: 0 };
  }
  set(state: GatewayState): void {
    this.state = state;
    for (const fn of this.#statuses) fn(this.status());
  }
  start(): void {
    this.started++;
    this.set('open');
  }
  async stop(): Promise<void> {
    this.stopped++;
    this.set('stopped');
  }
  idle(): Promise<void> {
    return this.#pending.then(() => undefined);
  }
  /** A message from a group, as WhatsApp hands it over: dropped unless the group is on this phone's allow-list. */
  message(groupId: string, waId: string): Promise<unknown> {
    if (!this.allow.has(groupId)) {
      this.dropped++;
      return Promise.resolve();
    }
    const e = { kind: 'message', groupId, waId } as unknown as NormalizedEvent;
    this.#pending = this.#pending.then(async () => {
      for (const fn of this.#events) await fn(e);
    });
    return this.#pending;
  }
  answer(a: HistoryAnswer): void {
    for (const fn of this.#history) fn(a);
  }
  async listGroups() {
    if (this.state !== 'open') throw new Error('WhatsApp is not connected');
    return this.groups;
  }
  failedCount(): number {
    return 0;
  }
  droppedCount(): number {
    return this.dropped;
  }
  async groupMembers(groupId: string) {
    if (this.state !== 'open' || !this.allow.has(groupId)) return null;
    return [{ jid: `member-of-${groupId}` }] as unknown as GroupMember[];
  }
  chatDeleteSocket(groupId: string): ChatDeleteSocket | null {
    if (this.state !== 'open' || !this.allow.has(groupId)) return null;
    return { name: `delete socket of ${groupId}` } as unknown as ChatDeleteSocket;
  }
  async fetchHistory(groupId: string): Promise<boolean> {
    if (this.state !== 'open' || !this.allow.has(groupId)) return false;
    this.asked.push(groupId);
    return true;
  }
  groupSocket(groupId: string): GroupSendSocket | null {
    if (this.state !== 'open' || !this.allow.has(groupId)) return null;
    return { name: `socket of ${groupId}` } as unknown as GroupSendSocket;
  }
}

const cfg = (groupId: string, code: string, phone?: 1 | 2 | 3 | 4 | 5): ClientConfig => ({
  groupId, name: code, code, phases: ['One'], emailDomains: [], meetingKeywords: [], ...(phone === undefined ? {} : { phone }),
});

function setup() {
  const set = new PhoneSet({ clock: manualClock(AT) });
  const phones = new Map<number, FakeGateway>();
  const add = (id: 1 | 2 | 3 | 4 | 5, label = `Phone ${id}`) => {
    const allow = new AllowList([]);
    const g = new FakeGateway(allow);
    phones.set(id, g);
    set.add({ id, label, gateway: g, allow });
    return g;
  };
  const seen: string[] = [];
  set.onEvent(async (e) => {
    seen.push(`${(e as { waId: string }).waId}`);
  });
  return { set, phones, add, seen };
}

describe('PhoneSet', () => {
  it('splits the approved groups by phone (missing phone = 1); a group is read through its own phone only', async () => {
    const { set, add, seen } = setup();
    const one = add(1);
    const two = add(2);
    set.setConfigs([cfg(G1, 'AAA'), cfg(G2, 'BBB', 2), cfg(G3, 'CCC', 4)]); // G3's phone 4 is not in the set
    set.start();
    expect(one.allow.has(G1) && !one.allow.has(G2)).toBe(true);
    expect(two.allow.has(G2) && !two.allow.has(G1)).toBe(true);
    // Both phones are in G2: only phone 2 reads it, so it is stored once.
    await one.message(G2, 'm-from-1');
    await two.message(G2, 'm-from-2');
    await one.message(G1, 'm-g1');
    await one.message(G3, 'm-g3');
    expect(seen).toEqual(['m-from-2', 'm-g1']);
    expect(set.phoneOf(G2)).toBe(2);
    expect(set.phoneOf(G3)).toBe(4);
    expect(set.phoneOf('120363000000000009@g.us')).toBeUndefined();
  });

  it('events from two phones reach the app one at a time, in the order they came', async () => {
    const { set, add } = setup();
    const one = add(1);
    const two = add(2);
    set.setConfigs([cfg(G1, 'AAA'), cfg(G2, 'BBB', 2)]);
    set.start();
    const order: string[] = [];
    let running = 0;
    set.onEvent(async (e) => {
      running++;
      expect(running).toBe(1);
      await new Promise((r) => setTimeout(r, 5));
      order.push((e as { waId: string }).waId);
      running--;
    });
    await Promise.all([one.message(G1, 'a'), two.message(G2, 'b'), one.message(G1, 'c')]);
    await set.idle();
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('the socket, history and isOpenFor go to the group’s phone only, never another open phone', async () => {
    const { set, add } = setup();
    const one = add(1);
    const two = add(2);
    set.setConfigs([cfg(G1, 'AAA'), cfg(G2, 'BBB', 2)]);
    set.start();
    expect(set.groupSocket(G2)).toEqual({ name: `socket of ${G2}` });
    expect(await set.fetchHistory(G2, { waId: 'x', fromMe: false, ts: new Date(AT) }, 10)).toBe(true);
    expect(two.asked).toEqual([G2]);
    expect(one.asked).toEqual([]);
    two.set('closed');
    expect(set.isOpenFor(G2)).toBe(false);
    expect(set.isOpenFor(G1)).toBe(true);
    expect(set.groupSocket(G2)).toBeNull(); // phone 1 is open, but G2 is phone 2's
    expect(await set.fetchHistory(G2, { waId: 'x', fromMe: false, ts: new Date(AT) }, 10)).toBe(false);
    expect(set.groupSocket('120363000000000009@g.us')).toBeNull(); // approved nowhere
  });

  it('Open chat’s members and Delete chat’s socket go to the group’s own phone only (lane B’s methods, routed)', async () => {
    const { set, add } = setup();
    add(1);
    const two = add(2);
    set.setConfigs([cfg(G1, 'AAA'), cfg(G2, 'BBB', 2)]);
    set.start();
    expect(await set.groupMembers(G2)).toEqual([{ jid: `member-of-${G2}` }]);
    expect(set.chatDeleteSocket(G2)).toEqual({ name: `delete socket of ${G2}` });
    two.set('closed');
    expect(await set.groupMembers(G2)).toBeNull(); // phone 1 is open, but G2 is phone 2's
    expect(set.chatDeleteSocket(G2)).toBeNull();
    expect(set.chatDeleteSocket('120363000000000009@g.us')).toBeNull(); // approved nowhere
  });

  it('status: open only when every phone is; otherwise the worst, naming that phone; phones() gives each', () => {
    const { set, add } = setup();
    const one = add(1);
    const two = add(2, 'Front desk');
    set.start();
    const statuses: unknown[] = [];
    set.onStatus((s) => statuses.push(s));
    expect(set.status()).toMatchObject({ state: 'open' });
    two.set('closed');
    expect(set.status()).toMatchObject({ state: 'closed', lastErrorCode: 428, phone: { id: 2, label: 'Front desk' } });
    one.set('logged_out');
    expect(set.status()).toMatchObject({ state: 'logged_out', phone: { id: 1 } });
    expect(set.phones().map((p) => [p.id, p.label, p.status.state])).toEqual([[1, 'Phone 1', 'logged_out'], [2, 'Front desk', 'closed']]);
    expect(statuses.map((s) => (s as GatewayStatus).state)).toEqual(['closed', 'logged_out']);
  });

  it('with no phone at all it is not linked', () => {
    const set = new PhoneSet({ clock: manualClock(AT) });
    expect(set.status().state).toBe('not_linked');
    expect(set.isOpenFor(G1)).toBe(false);
  });

  it('a phone added but not linked yet does not make the set "not linked" while another reads; with none linked it does', () => {
    const { set, add } = setup();
    const one = add(1);
    const two = add(2, 'Front desk');
    set.start();
    two.set('not_linked');
    expect(set.status()).toMatchObject({ state: 'open', count: 2 });
    expect(set.status().phone).toBeUndefined();
    expect(set.phones().map((p) => [p.id, p.status.state])).toEqual([[1, 'open'], [2, 'not_linked']]);
    one.set('closed');
    expect(set.status()).toMatchObject({ state: 'closed', phone: { id: 1 }, count: 2 });
    one.set('not_linked');
    expect(set.status()).toMatchObject({ state: 'not_linked', phone: { id: 1 }, count: 2 });
  });

  it('listGroups unions the open phones’ groups, each with the phones that see it', async () => {
    const { set, add } = setup();
    const one = add(1);
    const two = add(2);
    const three = add(3);
    one.groups = [{ id: G1, subject: 'Alpha' }, { id: G2, subject: 'Beta' }];
    two.groups = [{ id: G2, subject: 'Beta' }];
    three.groups = [{ id: G3, subject: 'Gamma' }];
    set.start();
    three.set('closed');
    expect(await set.listGroups()).toEqual([
      { id: G1, subject: 'Alpha', phones: [1] },
      { id: G2, subject: 'Beta', phones: [1, 2] },
    ]);
    one.set('closed');
    two.set('closed');
    await expect(set.listGroups()).rejects.toThrow(/not connected/);
  });

  it('a phone added while running starts at once; one removed stops alone, and its groups are read by no one', async () => {
    const { set, add, seen } = setup();
    const one = add(1);
    set.setConfigs([cfg(G1, 'AAA'), cfg(G2, 'BBB', 2)]);
    set.start();
    const two = add(2);
    expect(two.started).toBe(1);
    expect(two.allow.has(G2)).toBe(true); // the configs given before it was added
    await set.remove(2);
    expect(two.stopped).toBe(1);
    expect(one.stopped).toBe(0);
    expect(set.phones().map((p) => p.id)).toEqual([1]);
    await two.message(G2, 'after-removal');
    expect(seen).toEqual([]);
    expect(set.isOpenFor(G2)).toBe(false);
    expect(() => add(1)).toThrow(/already/);
  });

  it('stop stops every phone; failed and dropped counts are summed', async () => {
    const { set, add } = setup();
    const one = add(1);
    const two = add(2);
    set.setConfigs([cfg(G1, 'AAA')]);
    set.start();
    await two.message(G1, 'not-on-phone-2');
    expect(set.droppedCount()).toBe(1);
    await set.stop();
    expect([one.stopped, two.stopped]).toEqual([1, 1]);
  });

  it('a history answer from any phone reaches onHistory', () => {
    const { set, add } = setup();
    add(1);
    const two = add(2);
    const answers: HistoryAnswer[] = [];
    set.onHistory((a) => answers.push(a));
    two.answer({ groups: [] } as unknown as HistoryAnswer);
    expect(answers).toHaveLength(1);
  });
});
