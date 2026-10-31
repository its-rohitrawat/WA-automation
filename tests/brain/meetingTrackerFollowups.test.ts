import { describe, expect, it, vi } from 'vitest';
import { MAX_OUTPUT_TOKENS } from '../../src/brain/claudeClient.ts';
import type { MeetingSummary } from '../../src/brain/meetingSchema.ts';
import { MEETING_TRACKER_PROMPT, meetingItemLines, meetingItems } from '../../src/brain/meetingTracker.ts';
import { SYSTEM_PROMPT } from '../../src/brain/prompt.ts';
import { Reconciler, type MeetingForTracker } from '../../src/brain/reconciler.ts';
import type { Prices } from '../../src/spend/pricing.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import type { Db } from '../../src/store/db.ts';
import { advanceStage, insertFound } from '../../src/store/meetings.ts';
import type { Segment } from '../../src/stt/types.ts';
import { manualClock } from '../../src/util/clock.ts';
import { silentLogger } from '../../src/util/logger.ts';
import { FakeAi } from '../helpers/ai.ts';
import { NOW, seeded } from '../helpers/db.ts';

const P: Prices = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 };
const STARTED = '2026-10-19T06:00:00.000Z';
const SEGMENTS: Segment[] = [{ start: 0, end: 4, speaker: 'A', text: 'Logo files aap kal tak bhej dijiye' }];

function summary(): MeetingSummary {
  return {
    whatHappened: 'We met.',
    discussion: [],
    decisions: [{ text: 'Blue theme chosen', segmentIds: ['s1'] }],
    actionItems: [{ side: 'client', task: 'Send the logo files', owner: 'Mr. Sharma', deadline: '2026-10-20', segmentIds: ['s1'] }],
    openQuestions: [],
    conclusion: '',
    speakers: [],
  };
}

async function meetingAt(db: Db, clientId: number): Promise<MeetingForTracker> {
  const s = summary();
  const id = (await insertFound(db, {
    recording: `conferenceRecords/c/recordings/${STARTED}`, conference: 'conferenceRecords/c', driveFileId: 'file1', meetingCode: null,
    title: 'Sharma weekly', startedAt: STARTED, endedAt: null, attendees: [], participants: [], clientId, matchKind: 'title', status: 'queued',
    driveSeconds: 600, createdAt: NOW,
  }))!;
  await advanceStage(db, id, 'doc', { summary: s, transcript: SEGMENTS, docFileId: 'doc1' }, NOW);
  return { id, startedAt: STARTED, title: 'Sharma weekly', summary: s, segments: SEGMENTS };
}

describe('MEETING_TRACKER_PROMPT meeting rules', () => {
  const rules = MEETING_TRACKER_PROMPT.slice(SYSTEM_PROMPT.length);

  it('shows an example item line exactly as meetingItemLines writes it', () => {
    const [, example] = meetingItemLines(meetingItems(12, summary(), SEGMENTS, '2026-10-19T11:30:00+05:30'), STARTED);
    expect(example).toBe('[mtg12-a1] 2026-10-19 11:30 · Meeting: Action item, owed by the client, owner Mr. Sharma, deadline 2026-10-20: Send the logo files');
    expect(rules).toContain(`\n  ${example}\n`);
  });

  it('maps decision items to add_decision and states the approval bar for a meeting', () => {
    expect(rules).toContain('A decision item maps to add_decision, never to add_task');
    expect(rules).toContain('the approval must be said in the meeting by the person who asked for the work, or by the founder');
  });
});

describe('meetingItemLines title', () => {
  it('keeps up to 120 characters of the title, cleaned like a name', () => {
    const [head] = meetingItemLines([], STARTED, `Weekly: ${'t'.repeat(200)}`);
    expect(head).toBe(`Meeting started 2026-10-19 11:30, title "Weekly- ${'t'.repeat(112)}"`);
  });
});

describe('Reconciler.runMeeting spend logs', () => {
  async function setup(capUsd: number) {
    const { db, ids } = await seeded();
    const clock = manualClock('2026-10-20T08:00:00Z');
    const spend = new SpendGuard({ db, clock, capUsd });
    const log = silentLogger();
    const info = vi.spyOn(log, 'info');
    const r = new Reconciler({ db, ai: new FakeAi([]), spend, prices: P, clock, log, onChanged: vi.fn() });
    return { db, spend, info, r, sharma: ids.sharma };
  }

  it('a meeting kept out by the cap logs its meeting id, not a WhatsApp run pause', async () => {
    const { db, info, r, sharma } = await setup(0.001);
    const m = await meetingAt(db, sharma);
    await expect(r.runMeeting(sharma, m)).rejects.toMatchObject({ code: 'spend_cap' });
    expect(info).toHaveBeenCalledWith({ clientId: sharma, meetingId: m.id }, 'spend cap: meeting deferred');
    expect(info).not.toHaveBeenCalledWith(expect.anything(), 'spend cap: run paused');
  });

  it('a meeting kept out by holds logs its meeting id, not a WhatsApp run deferral', async () => {
    const { db, spend, info, r, sharma } = await setup(15);
    expect(spend.reserve(15 - (MAX_OUTPUT_TOKENS * P.outputPerMTok) / 1_000_000 / 2)).not.toBeNull();
    const m = await meetingAt(db, sharma);
    await expect(r.runMeeting(sharma, m)).rejects.toMatchObject({ code: 'spend_busy' });
    expect(info).toHaveBeenCalledWith({ clientId: sharma, meetingId: m.id }, 'other paid calls in flight: meeting deferred');
    expect(info).not.toHaveBeenCalledWith(expect.anything(), 'other paid calls in flight: run deferred');
  });
});
