import { describe, expect, it, vi } from 'vitest';
import type { DestinationStream } from 'pino';
import { syncClients } from '../../src/store/clients.ts';
import { openDb } from '../../src/store/db.ts';
import { backfillStatus, getBackfill, listBackfills, saveBackfill } from '../../src/store/historyBackfill.ts';
import { manualClock } from '../../src/util/clock.ts';
import { createLogger } from '../../src/util/logger.ts';
import type { GatewayState, HistoryAnchor, HistoryAnswer } from '../../src/wa/gateway.ts';
import { ANSWER_TIMEOUT_MS, FAILURES_TO_FINISH, HistoryBackfill, HOLD_MAX_MS, MAX_REQUESTS, REQUEST_GAP_MS, TIMEOUT_GAP_MS, TIMEOUTS_TO_FINISH } from '../../src/wa/historyBackfill.ts';
import { Ingestor } from '../../src/wa/ingest.ts';
import type { NormalizedEvent } from '../../src/wa/normalize.ts';
import { MEHTA, SHARMA } from '../helpers/db.ts';

const APPROVED = '2026-10-28T06:00:00.000Z';
const at = (daysBefore: number, minutes = 0) => new Date(Date.parse(APPROVED) - daysBefore * 86_400_000 - minutes * 60_000);
const SECRET = 'payment details for the villa project';

const msg = (groupId: string, waId: string, ts: Date): Extract<NormalizedEvent, { kind: 'message' }> => ({
  kind: 'message', groupId, waId, senderJid: '919800000001@s.whatsapp.net', senderNumber: '919800000001', senderName: 'Client Person',
  fromMe: false, ts, text: SECRET, quotedWaId: null, mediaType: null,
});

/** A manual scheduler: run() fires every timer due by `now` (advance moves now on). */
function scheduler() {
  let now = 0;
  let timers: { at: number; fn: () => void; live: boolean }[] = [];
  return {
    schedule: (fn: () => void, ms: number) => {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return { cancel: () => void (t.live = false) };
    },
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at; // timers set while it runs count from its own time
        due.live = false;
        due.fn();
        await new Promise((r) => setImmediate(r));
      }
      now = end;
      timers = timers.filter((t) => t.live);
    },
  };
}

function setup(o: { configs?: typeof SHARMA[]; state?: GatewayState; paused?: boolean } = {}) {
  const db = openDb(':memory:');
  const clock = manualClock(APPROVED);
  syncClients(db, o.configs ?? [SHARMA], clock.now());
  const lines: string[] = [];
  const log = createLogger('info', { write: (s: string) => void lines.push(s) } as unknown as DestinationStream);
  const listeners: ((a: HistoryAnswer) => void)[] = [];
  const asked: { groupId: string; anchor: HistoryAnchor; count: number }[] = [];
  const g = {
    state: o.state ?? ('open' as GatewayState),
    status: () => ({ state: g.state, since: APPROVED, lastErrorCode: null, credsSaveFailures: 0 }),
    onHistory: (fn: (a: HistoryAnswer) => void) => void listeners.push(fn),
    fetchHistory: vi.fn(async (groupId: string, anchor: HistoryAnchor, count: number) => {
      asked.push({ groupId, anchor, count });
      return true;
    }),
  };
  const ingestor = new Ingestor({ db, onNewMessages: () => {}, clock });
  const spend = { paused: o.paused ?? false };
  const finished: { clientId: number; found: number; stopped: boolean }[] = [];
  const s = scheduler();
  const make = () => new HistoryBackfill({
    db, clock, log, gateway: g, ingest: (e) => ingestor.handle(e), spendPaused: () => spend.paused,
    onFinished: (f) => finished.push(f), scheduler: s.schedule,
  });
  const bf = make();
  const answer = async (a: HistoryAnswer) => {
    for (const fn of listeners) fn(a);
    await new Promise((r) => setImmediate(r));
  };
  const live = (groupId: string, waId: string, ts: Date) => ingestor.handle(msg(groupId, waId, ts));
  const count = (clientId = 1) => (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE client_id = ?').get(clientId) as { n: number }).n;
  const step = async () => {
    bf.tick();
    await new Promise((r) => setImmediate(r));
  };
  return { db, clock, g, asked, bf, make, answer, live, count, step, finished, spend, s, lines, ingestor };
}

describe('history backfill: queued on approve', () => {
  it('a newly approved group is queued for the 7 days before its approval; one already approved is not queued again', () => {
    const { db, clock } = setup();
    expect(getBackfill(db, SHARMA.groupId)).toMatchObject({ clientId: 1, state: 'waiting', since: at(7).toISOString(), until: APPROVED, requests: 0 });
    clock.set('2026-10-29T06:00:00.000Z');
    expect(syncClients(db, [SHARMA, MEHTA], clock.now())).toEqual([MEHTA.groupId]);
    expect(getBackfill(db, SHARMA.groupId)?.until).toBe(APPROVED);
    expect(getBackfill(db, MEHTA.groupId)?.until).toBe('2026-10-29T06:00:00.000Z');
  });

  it('approving a removed group again queues it again', () => {
    const { db, clock } = setup();
    saveBackfill(db, { ...getBackfill(db, SHARMA.groupId)!, state: 'done', finishedAt: APPROVED });
    syncClients(db, [], clock.now());
    clock.set('2026-10-30T06:00:00.000Z');
    expect(syncClients(db, [SHARMA], clock.now())).toEqual([SHARMA.groupId]);
    expect(getBackfill(db, SHARMA.groupId)).toMatchObject({ state: 'waiting', until: '2026-10-30T06:00:00.000Z', requests: 0 });
  });
});

describe('history backfill: the anchor', () => {
  it('waits for the first message when the group has none, then pages back from it', async () => {
    const { db, bf, asked, live, step } = setup();
    bf.start();
    await step();
    expect(asked).toEqual([]);
    expect(backfillStatus(db, 1, at(0))).toEqual({ state: 'waiting', found: 0 });
    live(SHARMA.groupId, 'FIRST', at(-0.01));
    await step();
    expect(asked).toEqual([{ groupId: SHARMA.groupId, anchor: { waId: 'FIRST', fromMe: false, ts: at(-0.01) }, count: 50 }]);
    expect(getBackfill(db, SHARMA.groupId)).toMatchObject({ state: 'fetching', requests: 1 });
    expect(backfillStatus(db, 1, at(0))).toEqual({ state: 'reading', found: 0 });
  });

  it('uses the oldest stored message of the group', async () => {
    const { bf, asked, live, step } = setup();
    live(SHARMA.groupId, 'NEW', at(0, -5));
    live(SHARMA.groupId, 'OLD', at(1));
    bf.start();
    await step();
    expect(asked[0]!.anchor).toEqual({ waId: 'OLD', fromMe: false, ts: at(1) });
  });
});

describe('history backfill: paging', () => {
  it('pages back from the new oldest message, keeps the 7 days, drops older ones and then ends', async () => {
    const { db, bf, asked, live, answer, count, s, finished, step } = setup();
    live(SHARMA.groupId, 'A', at(0, 10));
    bf.start();
    await step();
    await answer({ groups: [{ groupId: SHARMA.groupId, events: [msg(SHARMA.groupId, 'B', at(3)), msg(SHARMA.groupId, 'C', at(2))] }] });
    expect(count()).toBe(3);
    await s.advance(REQUEST_GAP_MS);
    expect(asked[1]!.anchor.waId).toBe('B');
    // Older than 7 days: dropped, and the backfill ends.
    await answer({ groups: [{ groupId: SHARMA.groupId, events: [msg(SHARMA.groupId, 'D', at(6)), msg(SHARMA.groupId, 'OLDER', at(8))] }] });
    expect(count()).toBe(4);
    expect(db.prepare("SELECT 1 FROM messages WHERE wa_id = 'OLDER'").get()).toBeUndefined();
    expect(getBackfill(db, SHARMA.groupId)?.state).toBe('done');
    expect(finished).toEqual([{ clientId: 1, found: 4, stopped: false }]);
    expect(backfillStatus(db, 1, at(0))).toEqual({ state: 'done', found: 4 });
    await s.advance(REQUEST_GAP_MS * 3);
    expect(asked).toHaveLength(2);
  });

  it('ends after two answers in a row bring nothing older: duplicates only, then an empty one', async () => {
    const { db, bf, asked, live, answer, count, s, step } = setup();
    live(SHARMA.groupId, 'A', at(1));
    bf.start();
    await step();
    await answer({ groups: [{ groupId: SHARMA.groupId, events: [msg(SHARMA.groupId, 'A', at(1))] }] }); // a duplicate
    expect(count()).toBe(1);
    expect(getBackfill(db, SHARMA.groupId)?.empties).toBe(1);
    await s.advance(REQUEST_GAP_MS);
    expect(asked).toHaveLength(2);
    await answer({ groups: [] });
    await s.advance(REQUEST_GAP_MS);
    expect(getBackfill(db, SHARMA.groupId)?.state).toBe('done');
    expect(asked).toHaveLength(2);
  });

  it(`a phone that does not answer is asked again after a longer wait, and given up on after ${TIMEOUTS_TO_FINISH} tries`, async () => {
    const { db, bf, asked, live, s, step } = setup();
    live(SHARMA.groupId, 'A', at(1));
    bf.start();
    await step();
    await s.advance(ANSWER_TIMEOUT_MS);
    expect(getBackfill(db, SHARMA.groupId)).toMatchObject({ state: 'fetching', timeouts: 1, empties: 0 });
    await s.advance(REQUEST_GAP_MS);
    expect(asked).toHaveLength(1); // not after the short gap
    await s.advance(TIMEOUT_GAP_MS);
    expect(asked).toHaveLength(2);
    for (let i = 0; i < TIMEOUTS_TO_FINISH; i++) await s.advance(ANSWER_TIMEOUT_MS + TIMEOUT_GAP_MS);
    expect(getBackfill(db, SHARMA.groupId)?.state).toBe('done');
    expect(asked).toHaveLength(TIMEOUTS_TO_FINISH);
  });

  it('a late answer, after its timeout, goes on after the short gap', async () => {
    const { bf, asked, live, answer, s, step } = setup();
    live(SHARMA.groupId, 'A', at(0, 10));
    bf.start();
    await step();
    await s.advance(ANSWER_TIMEOUT_MS);
    await answer({ groups: [{ groupId: SHARMA.groupId, events: [msg(SHARMA.groupId, 'B', at(2))] }] });
    await s.advance(REQUEST_GAP_MS);
    expect(asked).toHaveLength(2);
    expect(asked[1]!.anchor.waId).toBe('B');
  });

  it(`a request that cannot be sent waits longer each time and is given up after ${FAILURES_TO_FINISH} failures`, async () => {
    const { db, bf, g, asked, live, s, step } = setup();
    g.fetchHistory.mockImplementation(async (groupId: string, anchor: HistoryAnchor, count: number) => {
      asked.push({ groupId, anchor, count });
      return false;
    });
    live(SHARMA.groupId, 'A', at(1));
    bf.start();
    await step();
    expect(getBackfill(db, SHARMA.groupId)).toMatchObject({ failures: 1, requests: 0 });
    await s.advance(REQUEST_GAP_MS * 2);
    expect(asked).toHaveLength(2);
    await s.advance(REQUEST_GAP_MS * 2);
    expect(asked).toHaveLength(2); // the wait doubled
    for (let i = 0; i < 10; i++) await s.advance(REQUEST_GAP_MS * 2 ** 9);
    expect(getBackfill(db, SHARMA.groupId)?.state).toBe('done');
    expect(asked).toHaveLength(FAILURES_TO_FINISH);
  });

  it('an empty answer counts as nothing older', async () => {
    const { db, bf, live, answer, step } = setup();
    live(SHARMA.groupId, 'A', at(1));
    bf.start();
    await step();
    await answer({ groups: [] });
    expect(getBackfill(db, SHARMA.groupId)?.empties).toBe(1);
  });

  it(`asks at most ${MAX_REQUESTS} times for a group`, async () => {
    const { db, bf, asked, live, answer, s, step } = setup();
    live(SHARMA.groupId, 'A', at(0, 10));
    bf.start();
    await step();
    for (let i = 1; i <= MAX_REQUESTS + 2; i++) {
      await answer({ groups: [{ groupId: SHARMA.groupId, events: [msg(SHARMA.groupId, `M${i}`, at(0, 10 + i))] }] });
      await s.advance(REQUEST_GAP_MS);
    }
    expect(asked).toHaveLength(MAX_REQUESTS);
    expect(getBackfill(db, SHARMA.groupId)).toMatchObject({ state: 'done', requests: MAX_REQUESTS });
  });
});

describe('history backfill: the privacy rules', () => {
  it('never asks for an unapproved group, and stops when a group is removed', async () => {
    const { db, clock, bf, asked, live, answer, count, step, finished } = setup();
    live(SHARMA.groupId, 'A', at(1));
    syncClients(db, [], clock.now()); // removed before anything was asked
    bf.start();
    await step();
    expect(asked).toEqual([]);
    expect(getBackfill(db, SHARMA.groupId)?.state).toBe('stopped');
    expect(finished).toEqual([{ clientId: 1, found: 0, stopped: true }]);
    // A late answer for it is not stored.
    await answer({ groups: [{ groupId: SHARMA.groupId, events: [msg(SHARMA.groupId, 'B', at(2))] }] });
    expect(count()).toBe(1);
  });

  it('stores nothing from an answer for a group with no backfill under way', async () => {
    const { db, clock, bf, answer, step } = setup({ configs: [SHARMA] });
    syncClients(db, [SHARMA, MEHTA], clock.now());
    saveBackfill(db, { ...getBackfill(db, MEHTA.groupId)!, state: 'done', finishedAt: APPROVED });
    bf.start();
    await step();
    await answer({ groups: [{ groupId: MEHTA.groupId, events: [msg(MEHTA.groupId, 'X', at(1))] }] });
    expect(db.prepare("SELECT 1 FROM messages WHERE wa_id = 'X'").get()).toBeUndefined();
  });

  it('asks nothing while WhatsApp is not open, nor at the spend cap; carries on after', async () => {
    const { bf, g, asked, live, spend, step } = setup({ state: 'closed', paused: true });
    live(SHARMA.groupId, 'A', at(1));
    bf.start();
    await step();
    g.state = 'open';
    await step();
    expect(asked).toEqual([]); // still at the cap
    spend.paused = false;
    await step();
    expect(asked).toHaveLength(1);
  });

  it('logs no message text, name or number', async () => {
    const { bf, live, answer, s, step, lines } = setup();
    live(SHARMA.groupId, 'A', at(1));
    bf.start();
    await step();
    await answer({ groups: [{ groupId: SHARMA.groupId, events: [msg(SHARMA.groupId, 'B', at(8))] }] });
    await s.advance(REQUEST_GAP_MS);
    const out = lines.join('');
    expect(out).toContain('history backfill finished');
    for (const bad of [SECRET, 'Client Person', '919800000001', SHARMA.groupId, SHARMA.name]) expect(out).not.toContain(bad);
  });
});

describe('history backfill: restart and the hold', () => {
  it('a restart carries on where it stopped', async () => {
    const { db, bf, make, asked, live, step } = setup();
    live(SHARMA.groupId, 'A', at(1));
    bf.start();
    await step();
    bf.stop();
    const again = make();
    again.start();
    again.tick();
    await new Promise((r) => setImmediate(r));
    expect(asked).toHaveLength(2);
    expect(getBackfill(db, SHARMA.groupId)?.requests).toBe(2);
    expect(listBackfills(db)).toHaveLength(1);
  });

  it('holds the client while fetching and WhatsApp is open, never longer than the cap', async () => {
    const { clock, bf, g, live, step } = setup();
    expect(bf.held(1)).toBe(false);
    live(SHARMA.groupId, 'A', at(1));
    bf.start();
    await step();
    expect(bf.held(1)).toBe(true);
    expect(bf.held(2)).toBe(false);
    g.state = 'closed';
    expect(bf.held(1)).toBe(false);
    g.state = 'open';
    clock.set(new Date(Date.parse(APPROVED) + HOLD_MAX_MS).toISOString());
    expect(bf.held(1)).toBe(false);
    bf.stop();
    expect(bf.held(1)).toBe(false);
  });
});
