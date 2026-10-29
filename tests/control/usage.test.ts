import { describe, expect, it } from 'vitest';
import { usageSummary } from '../../src/control/usage.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { finishBatch, startBatch } from '../../src/store/batches.ts';
import type { Db } from '../../src/store/db.ts';
import { manualClock } from '../../src/util/clock.ts';
import { seededDb } from '../helpers/db.ts';

// 2026-10-19 08:00 UTC is 13:30 IST on the 19th.
const NOW = '2026-10-19T08:00:00.000Z';

function spend(db: Db, day: string, kind: 'ai' | 'stt', usd: number, detail: string) {
  db.raw.prepare('INSERT INTO spend (day, kind, usd, detail, at) VALUES (?, ?, ?, ?, ?)').run(day, kind, usd, detail, NOW);
}

function setup(cap = 15, now = NOW) {
  const db = seededDb();
  const clock = manualClock(now);
  const guard = new SpendGuard({ db, clock, capUsd: cap });
  return { db, clock, guard, summary: (o: { voiceLocal?: boolean } = {}) => usageSummary(db, guard, clock.now(), { voiceLocal: o.voiceLocal ?? false }) };
}

describe('usageSummary', () => {
  it('gives today with the cap, what is left and the pause state', () => {
    const t = setup(15);
    spend(t.db, '2026-10-19', 'ai', 2.5, 'batch 1');
    spend(t.db, '2026-10-19', 'stt', 0.75, 'meeting 3 part 0');
    expect(t.summary().today).toEqual({ spent: 3.25, byKind: { ai: 2.5, stt: 0.75 }, capUsd: 15, remaining: 11.75, paused: false });
  });

  it('never shows a negative remainder, and reports the pause at the cap', () => {
    const t = setup(5);
    spend(t.db, '2026-10-19', 'ai', 6.2, 'batch 1');
    expect(t.summary().today).toMatchObject({ spent: 6.2, remaining: 0, paused: true });
  });

  it('gives 14 IST days ending today, zero-filled, oldest first', () => {
    const t = setup();
    spend(t.db, '2026-10-19', 'ai', 1, 'batch 1');
    spend(t.db, '2026-10-19', 'stt', 0.5, 'media 2');
    spend(t.db, '2026-10-10', 'ai', 2, 'batch 2');
    spend(t.db, '2026-10-06', 'ai', 9, 'batch 3'); // 13 days back: the first day
    spend(t.db, '2026-10-05', 'ai', 99, 'batch 4'); // 14 days back: left out
    spend(t.db, '2026-10-20', 'ai', 99, 'batch 5'); // tomorrow: left out
    const days = t.summary().days;
    expect(days).toHaveLength(14);
    expect(days[0]).toEqual({ day: '2026-10-06', usd: 9 });
    expect(days.at(-1)).toEqual({ day: '2026-10-19', usd: 1.5 });
    expect(days.find((d) => d.day === '2026-10-10')).toEqual({ day: '2026-10-10', usd: 2 });
    expect(days.filter((d) => d.usd === 0)).toHaveLength(11);
  });

  it('dates days in IST: just after midnight IST is already the next day', () => {
    const t = setup(15, '2026-10-19T18:45:00.000Z'); // 00:15 IST on the 20th
    spend(t.db, '2026-10-20', 'ai', 1, 'batch 1');
    spend(t.db, '2026-10-19', 'ai', 4, 'batch 2');
    const s = t.summary();
    expect(s.today.spent).toBe(1);
    expect(s.days.at(-1)).toEqual({ day: '2026-10-20', usd: 1 });
    expect(s.days.at(-2)).toEqual({ day: '2026-10-19', usd: 4 });
  });

  it('splits today by what the money was for, in plain words, with local voice notes at $0', () => {
    const t = setup();
    spend(t.db, '2026-10-19', 'ai', 1, 'batch 1');
    spend(t.db, '2026-10-19', 'ai', 0.5, 'batch 2 (fallback)');
    spend(t.db, '2026-10-19', 'ai', 2, 'meeting 4');
    spend(t.db, '2026-10-19', 'ai', 0.25, 'media 7');
    spend(t.db, '2026-10-19', 'stt', 0.75, 'meeting 4 part 0');
    spend(t.db, '2026-10-19', 'ai', 0.1, 'shutdown before the paid call finished (estimated)');
    spend(t.db, '2026-10-18', 'ai', 50, 'batch 9'); // yesterday
    expect(t.summary({ voiceLocal: true }).byUse).toEqual([
      { use: 'messages', label: 'Messages to tasks', usd: 1.5 },
      { use: 'meetings', label: 'Meeting summaries', usd: 2 },
      { use: 'files', label: 'Reading shared files', usd: 0.25 },
      { use: 'speech', label: 'Speech to text', usd: 0.75 },
      { use: 'voice', label: 'Voice notes (on this computer)', usd: 0 },
      { use: 'other', label: 'Other', usd: 0.1 },
    ]);
    expect(t.summary().byUse.map((u) => u.use)).toEqual(['messages', 'meetings', 'files', 'speech', 'other']);
  });

  it("counts today's finished batches and the messages they read, by the IST day", () => {
    const t = setup();
    const batch = (at: string, n: number, status: 'ok' | 'failed' = 'ok') => finishBatch(t.db, startBatch(t.db, 1, n, at), { status, errorCode: null, accepted: 0, rejected: 0, at });
    batch('2026-10-19T07:00:00.000Z', 10);
    batch('2026-10-18T18:31:00.000Z', 5); // 00:01 IST on the 19th
    batch('2026-10-18T18:29:00.000Z', 99); // 23:59 IST on the 18th
    batch('2026-10-19T07:30:00.000Z', 7, 'failed'); // not read
    startBatch(t.db, 1, 4, '2026-10-19T07:45:00.000Z'); // still running
    expect(t.summary().batches).toEqual({ today: 2, messagesRead: 15 });
  });

  it('rounds to a hundredth of a cent', () => {
    const t = setup();
    spend(t.db, '2026-10-19', 'ai', 0.1, 'batch 1');
    spend(t.db, '2026-10-19', 'ai', 0.2, 'batch 2');
    expect(t.summary().today.spent).toBe(0.3);
    expect(t.summary().days.at(-1)!.usd).toBe(0.3);
  });
});

describe('usageSummary review fixes', () => {
  it('leaves out a batch finished just after the next IST midnight, and lists no other line without such spend', () => {
    const t = setup();
    finishBatch(t.db, startBatch(t.db, 1, 8, '2026-10-19T18:30:00.000Z'), { status: 'ok', errorCode: null, accepted: 0, rejected: 0, at: '2026-10-19T18:30:00.000Z' });
    spend(t.db, '2026-10-19', 'ai', 1, 'batch 1');
    const s = t.summary();
    expect(s.batches).toEqual({ today: 0, messagesRead: 0 });
    expect(s.byUse.map((u) => u.use)).toEqual(['messages', 'meetings', 'files', 'speech']);
  });
});

describe('usageSummary: the dashboard assistant', () => {
  it('lists the assistant\'s answers as their own use, only once something was booked', () => {
    const t = setup();
    expect(t.summary().byUse.map((u) => u.use)).not.toContain('assistant');
    spend(t.db, '2026-10-19', 'ai', 0.04, 'assistant call');
    spend(t.db, '2026-10-19', 'ai', 0.02, 'assistant call');
    expect(t.summary().byUse.find((u) => u.use === 'assistant')).toEqual({ use: 'assistant', label: 'Dashboard assistant', usd: 0.06 });
  });
});
