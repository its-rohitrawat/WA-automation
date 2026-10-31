import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { AiInvalidOutputError, AiRefusalError, keepConnectTimeoutCode } from '../../src/brain/claudeClient.ts';
import {
  ClaudeMeetingClient, MEETING_MAX_TOKENS, MEETING_SDK_MAX_RETRIES, estimateMeetingTokens, meetingEstimateUsd, summarizeMeeting,
  type MeetingAi, type MeetingAiResult, type SummarizeInput,
} from '../../src/brain/meetingClient.ts';
import { MEETING_SYSTEM_PROMPT, buildMeetingPrompt } from '../../src/brain/meetingPrompt.ts';
import { MEETING_SUMMARY_JSON_SCHEMA } from '../../src/brain/meetingSchema.ts';
import { SpendCapReachedError } from '../../src/brain/paidCall.ts';
import { costUsd, estimateCostUsd, type Prices } from '../../src/spend/pricing.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { manualClock } from '../../src/util/clock.ts';
import { FAKE_USAGE } from '../helpers/ai.ts';
import { seededDb } from '../helpers/db.ts';

/** Records the options of every Anthropic client built in this file; the class behaves as the real one. */
const sdk = vi.hoisted(() => ({ options: [] as unknown[] }));
vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@anthropic-ai/sdk')>();
  class RecordingAnthropic extends mod.default {
    constructor(opts?: ConstructorParameters<typeof mod.default>[0]) {
      super(opts);
      sdk.options.push(opts);
    }
  }
  return { ...mod, default: RecordingAnthropic };
});

const prices: Prices = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 };
const usage = { input_tokens: 9000, output_tokens: 1200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, iterations: null };
const billed = costUsd({ inputTokens: 9000, outputTokens: 1200, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, prices);

const wire = (o: Record<string, unknown> = {}) => ({
  whatHappened: 'The client approved the logo.',
  discussion: [{ topic: 'Logo', summary: 'Version 3 is liked.' }],
  decisions: [{ text: 'Logo version 3 is final.', segmentIds: ['s2'] }],
  actionItems: [{ side: 'client', task: 'Send the logo files.', owner: '', deadline: '2026-10-21', segmentIds: ['s2'] }],
  openQuestions: [],
  conclusion: 'Logo files next.',
  speakers: [{ label: 'A', name: 'Asha Verma' }],
  ...o,
});
const reply = (content: unknown[], extra: Record<string, unknown> = {}) => ({ stop_reason: 'end_turn', stop_details: null, content, usage, model: 'claude-opus-5-5', ...extra });
const jsonReply = (value: unknown, extra: Record<string, unknown> = {}) => reply([{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(value) }], extra);

function fakeAnthropic(impl: (params: unknown) => Promise<unknown>) {
  const create = vi.fn(impl);
  return { client: { beta: { messages: { create } } } as unknown as Anthropic, create };
}
const make = (client: Anthropic, effort?: 'low' | 'medium' | 'high') =>
  new ClaudeMeetingClient({ apiKey: 'test-only', model: 'claude-opus-5-5', prices, client, ...(effort ? { effort } : {}) });

describe('ClaudeMeetingClient', () => {
  it('asks for the summary schema with a cached system prompt, the fallback and medium effort', async () => {
    const { client, create } = fakeAnthropic(async () => jsonReply(wire()));
    const r = await make(client).summarize('SYS', 'USER');
    expect(r.output).toEqual(wire());
    expect(r.costUsd).toBeCloseTo(billed, 9);
    expect(r.fallbackUsed).toBe(false);
    expect(r.model).toBe('claude-opus-5-5');
    expect(r.usage).toEqual({ inputTokens: 9000, outputTokens: 1200, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });
    // One argument only: no request options, so no AbortSignal; the call is never aborted.
    expect(create.mock.calls[0]).toHaveLength(1);
    const params = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(params).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 16_000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'USER' }],
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: MEETING_SUMMARY_JSON_SCHEMA } },
    });
    expect(MEETING_MAX_TOKENS).toBe(16_000);
  });

  it('uses the effort it was given', async () => {
    const { client, create } = fakeAnthropic(async () => jsonReply(wire()));
    await make(client, 'high').summarize('SYS', 'USER');
    expect((create.mock.calls[0]![0] as { output_config: { effort: string } }).output_config.effort).toBe('high');
  });

  it('builds its own client with a single attempt, a 600 s timeout and the connect-timeout fetch', () => {
    expect(MEETING_SDK_MAX_RETRIES).toBe(0);
    sdk.options.length = 0;
    new ClaudeMeetingClient({ apiKey: 'test-only', model: 'claude-opus-5-5', prices });
    expect(sdk.options).toEqual([{ apiKey: 'test-only', maxRetries: 0, timeout: 600_000, fetch: keepConnectTimeoutCode }]);
  });

  it('raises AiRefusalError with the category and the cost', async () => {
    const { client } = fakeAnthropic(async () => jsonReply(wire(), { stop_reason: 'refusal', stop_details: { category: 'cyber' } }));
    const err = await make(client).summarize('SYS', 'USER').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiRefusalError);
    expect((err as AiRefusalError).category).toBe('cyber');
    expect((err as AiRefusalError).costUsd).toBeCloseTo(billed, 9);
  });

  it('raises AiInvalidOutputError with the cost when the output was cut off at max_tokens', async () => {
    const { client } = fakeAnthropic(async () => reply([{ type: 'text', text: '{"whatHappened": "The cli' }], { stop_reason: 'max_tokens' }));
    const err = await make(client).summarize('SYS', 'USER').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiInvalidOutputError);
    expect((err as AiInvalidOutputError).costUsd).toBeCloseTo(billed, 9);
  });

  it('raises AiInvalidOutputError with the cost for output that is not a JSON object', async () => {
    for (const content of [[{ type: 'text', text: 'not json' }], [{ type: 'text', text: '[1, 2]' }], [{ type: 'text', text: 'null' }], []]) {
      const { client } = fakeAnthropic(async () => reply(content));
      const err = await make(client).summarize('SYS', 'USER').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AiInvalidOutputError);
      expect((err as AiInvalidOutputError).costUsd).toBeCloseTo(billed, 9);
    }
  });
});

/** Answers from a queue (an Error in the queue is thrown); a plain answer costs 10 cents. */
class FakeMeetingAi implements MeetingAi {
  readonly calls: { system: string; user: string }[] = [];
  readonly #queue: (Partial<MeetingAiResult> | Error)[];

  constructor(queue: (Partial<MeetingAiResult> | Error)[]) {
    this.#queue = [...queue];
  }

  async summarize(system: string, user: string): Promise<MeetingAiResult> {
    this.calls.push({ system, user });
    const next = this.#queue.shift() ?? {};
    if (next instanceof Error) throw next;
    return { output: wire(), usage: FAKE_USAGE, costUsd: 0.1, fallbackUsed: false, model: 'fake', ...next };
  }
}

const input: SummarizeInput = {
  meetingId: 7,
  clientName: 'Sharma Interiors',
  clientCode: 'SHA',
  startedAt: '2026-10-19T08:35:00Z',
  seconds: 600,
  people: [{ name: 'Asha Verma', team: true }],
  segments: [
    { start: 0, end: 3, speaker: 'A', text: 'Logo dekh liya?' },
    { start: 4, end: 9, speaker: 'B', text: 'Haan, version 3 final hai. Files kal bhej denge.' },
  ],
};
const prompt = buildMeetingPrompt(input);
/** Devanagari at 1 token per character, other text at 0.5; estimateCostUsd counts 2 characters per token. */
const tokensOf = (t: string): number => {
  const d = [...t].filter((c) => c >= 'ऀ' && c <= 'ॿ').length;
  return d + Math.ceil((t.length - d) / 2);
};
const estimateFor = (p: { system: string; user: string }) => estimateCostUsd(2 * (tokensOf(p.system) + tokensOf(p.user)), prices, 16_000);
const estimate = estimateFor(prompt);

async function setup(capUsd = 5) {
  const db = await seededDb();
  const spend = new SpendGuard({ db, clock: manualClock('2026-10-19T08:00:00Z'), capUsd });
  // A booking made without a transaction handle is written behind the call: wait for it (on Postgres's pool a read can
  // otherwise run first). Bookings run concurrently on that pool, so their ids need not follow the calls: the rows come
  // in a fixed order of their own, not by id.
  const rows = async () => {
    await spend.flushed();
    return db.all<{ kind: string; usd: number; detail: string }>('SELECT kind, usd, detail FROM spend ORDER BY kind, detail, usd');
  };
  return { spend, rows };
}
const invalid = (cost: number | null) => new AiInvalidOutputError('Model output was not valid JSON', FAKE_USAGE, cost);

describe('summarizeMeeting', () => {
  it('sends the meeting prompt, books the cost as ai and returns the validated summary', async () => {
    const { spend, rows } = await setup();
    const ai = new FakeMeetingAi([{
      costUsd: 0.12,
      output: wire({
        decisions: [{ text: 'Kept', segmentIds: ['s2'] }, { text: 'Made up', segmentIds: ['s9'] }],
        speakers: [{ label: 'A', name: 'Asha Verma' }, { label: 'B', name: 'Boss' }],
      }),
    }]);
    const r = await summarizeMeeting({ ai, spend, prices }, input);
    expect(ai.calls).toEqual([{ system: MEETING_SYSTEM_PROMPT, user: prompt.user }]);
    expect(r.summary.decisions).toEqual([{ text: 'Kept', segmentIds: ['s2'] }]);
    expect(r.summary.speakers).toEqual([{ label: 'A', name: 'Asha Verma' }, { label: 'B', name: null }]);
    expect(r.dropped).toBe(1);
    expect(r.cut).toBe(false);
    expect(r.costUsd).toBeCloseTo(0.12, 9);
    expect(r.skipped).toBeNull();
    expect(r.model).toBe('fake');
    expect(r.fallbackUsed).toBe(false);
    expect(r.usage).toEqual(FAKE_USAGE);
    expect(await rows()).toEqual([{ kind: 'ai', usd: 0.12, detail: 'meeting 7' }]);
  });

  it('reports the model and a fallback of the call that gave the summary', async () => {
    const { spend, rows } = await setup();
    const usage = { inputTokens: 5, outputTokens: 6, cacheCreationInputTokens: 0, cacheReadInputTokens: 7 };
    const ai = new FakeMeetingAi([invalid(0.01), { costUsd: 0.1, fallbackUsed: true, model: 'claude-opus-5', usage }]);
    const r = await summarizeMeeting({ ai, spend, prices }, input);
    expect(r).toMatchObject({ model: 'claude-opus-5', fallbackUsed: true, usage, skipped: null });
    expect(r.costUsd).toBeCloseTo(0.11, 9);
    expect((await rows()).map((x) => x.detail)).toEqual(['meeting 7 (failed)', 'meeting 7 (fallback)']);
  });

  // A blank summary would become an empty Doc and a meeting marked done with nothing in it.
  it('treats a summary that is empty after validation as invalid output and tries once more', async () => {
    const { spend, rows } = await setup();
    const ai = new FakeMeetingAi([{ costUsd: 0.05, output: wire({ whatHappened: '   ' }) }, { costUsd: 0.1 }]);
    const r = await summarizeMeeting({ ai, spend, prices }, input);
    expect(ai.calls).toHaveLength(2);
    expect(r.summary.whatHappened).toBe('The client approved the logo.');
    expect(r.costUsd).toBeCloseTo(0.15, 9);
    expect(await rows()).toEqual([{ kind: 'ai', usd: 0.1, detail: 'meeting 7' }, { kind: 'ai', usd: 0.05, detail: 'meeting 7 (failed)' }]);
  });

  it('never returns a blank summary: two empty answers fail', async () => {
    const { spend, rows } = await setup();
    const ai = new FakeMeetingAi([{ costUsd: 0.05, output: wire({ whatHappened: '' }) }, { costUsd: 0.06, output: {} }, { costUsd: 0.1 }]);
    await expect(summarizeMeeting({ ai, spend, prices }, input)).rejects.toBeInstanceOf(AiInvalidOutputError);
    expect(ai.calls).toHaveLength(2);
    expect(await rows()).toEqual([{ kind: 'ai', usd: 0.05, detail: 'meeting 7 (failed)' }, { kind: 'ai', usd: 0.06, detail: 'meeting 7 (failed)' }]);
  });

  it('calls nothing when no transcript line can be sent', async () => {
    for (const segments of [[], [{ start: 0, end: 9, speaker: 'A', text: 'x'.repeat(400_000) }]]) {
      const { spend, rows } = await setup();
      const ai = new FakeMeetingAi([]);
      const r = await summarizeMeeting({ ai, spend, prices }, { ...input, segments });
      expect(ai.calls).toHaveLength(0);
      expect(await rows()).toEqual([]);
      expect(r).toEqual({
        summary: { whatHappened: '', discussion: [], decisions: [], actionItems: [], openQuestions: [], conclusion: '', speakers: [] },
        skipped: 'no_lines',
        cut: segments.length > 0,
        dropped: 0,
        costUsd: 0,
        model: null,
        fallbackUsed: false,
        usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      });
    }
  });

  it('estimates Devanagari at about one token per character', async () => {
    expect(estimateMeetingTokens('नमस्ते ab')).toBe(6 + 2);
    expect(estimateMeetingTokens('abcd')).toBe(2);
    const hindi: SummarizeInput = { ...input, segments: [{ start: 0, end: 3, speaker: 'A', text: 'लोगो फाइनल है, कल फाइलें भेज देंगे। '.repeat(3_000) }] };
    const p = buildMeetingPrompt(hindi);
    const devanagariEstimate = estimateFor(p);
    expect(meetingEstimateUsd(p.system, p.user, prices)).toBeCloseTo(devanagariEstimate, 12);
    // Counting every character as half a token would reserve much less than the call can cost.
    expect(devanagariEstimate).toBeGreaterThan(estimateCostUsd(p.system.length + p.user.length, prices, 16_000) * 1.1);
    const tight = await setup(devanagariEstimate * 0.999);
    await expect(summarizeMeeting({ ai: new FakeMeetingAi([]), spend: tight.spend, prices }, hindi)).rejects.toBeInstanceOf(SpendCapReachedError);
    const fits = await setup(devanagariEstimate);
    await expect(summarizeMeeting({ ai: new FakeMeetingAi([{ costUsd: 0 }]), spend: fits.spend, prices }, hindi)).resolves.toMatchObject({ skipped: null });
  });

  it('reserves the estimate for the prompt and a 16,000-token answer, and calls nothing past the cap', async () => {
    const fits = await setup(estimate);
    await summarizeMeeting({ ai: new FakeMeetingAi([{ costUsd: 0 }]), spend: fits.spend, prices }, input);

    const { spend, rows } = await setup(estimate * 0.999);
    const ai = new FakeMeetingAi([]);
    await expect(summarizeMeeting({ ai, spend, prices }, input)).rejects.toBeInstanceOf(SpendCapReachedError);
    expect(ai.calls).toHaveLength(0);
    expect(await rows()).toEqual([]);
  });

  it('tries once more after an invalid output, booking both calls', async () => {
    const { spend, rows } = await setup();
    const ai = new FakeMeetingAi([invalid(null), { costUsd: 0.1 }]);
    const r = await summarizeMeeting({ ai, spend, prices }, input);
    expect(ai.calls).toHaveLength(2);
    expect(r.costUsd).toBeCloseTo(estimate + 0.1, 9);
    expect(await rows()).toEqual([
      { kind: 'ai', usd: 0.1, detail: 'meeting 7' },
      { kind: 'ai', usd: estimate, detail: 'meeting 7 (failed)' },
    ]);
  });

  it('fails after a second invalid output', async () => {
    const { spend, rows } = await setup();
    const second = invalid(0.04);
    const ai = new FakeMeetingAi([invalid(0.03), second, { costUsd: 0.1 }]);
    await expect(summarizeMeeting({ ai, spend, prices }, input)).rejects.toBe(second);
    expect(ai.calls).toHaveLength(2);
    expect(await rows()).toEqual([
      { kind: 'ai', usd: 0.03, detail: 'meeting 7 (failed)' },
      { kind: 'ai', usd: 0.04, detail: 'meeting 7 (failed)' },
    ]);
  });

  it('stops with SpendCapReachedError when the retry no longer fits under the cap', async () => {
    const { spend, rows } = await setup(estimate * 1.5);
    const ai = new FakeMeetingAi([invalid(null), { costUsd: 0.1 }]);
    await expect(summarizeMeeting({ ai, spend, prices }, input)).rejects.toBeInstanceOf(SpendCapReachedError);
    expect(ai.calls).toHaveLength(1);
    expect(await rows()).toEqual([{ kind: 'ai', usd: estimate, detail: 'meeting 7 (failed)' }]);
  });

  it('books a refusal at its cost and does not try again', async () => {
    const { spend, rows } = await setup();
    const ai = new FakeMeetingAi([new AiRefusalError('cyber', FAKE_USAGE, 0.02), { costUsd: 0.1 }]);
    await expect(summarizeMeeting({ ai, spend, prices }, input)).rejects.toBeInstanceOf(AiRefusalError);
    expect(ai.calls).toHaveLength(1);
    expect(await rows()).toEqual([{ kind: 'ai', usd: 0.02, detail: 'meeting 7 (failed)' }]);
  });

  // The client makes one SDK attempt, so a lost connection is booked at one estimate, not three.
  it('books a lost connection once at the estimate and does not try again', async () => {
    const { spend, rows } = await setup();
    const ai = new FakeMeetingAi([new Anthropic.APIConnectionTimeoutError(), { costUsd: 0.1 }]);
    await expect(summarizeMeeting({ ai, spend, prices }, input)).rejects.toBeInstanceOf(Anthropic.APIConnectionTimeoutError);
    expect(ai.calls).toHaveLength(1);
    expect(await rows()).toEqual([{ kind: 'ai', usd: estimate, detail: 'meeting 7 (connection lost, estimated)' }]);
  });

  it('reports a cut transcript and accepts only the segment ids that were sent', async () => {
    const { spend } = await setup(10);
    const long: SummarizeInput = {
      ...input,
      segments: [
        { start: 0, end: 3, speaker: 'A', text: 'x'.repeat(300_000) },
        { start: 4, end: 9, speaker: 'B', text: 'y'.repeat(300_000) },
      ],
    };
    const ai = new FakeMeetingAi([{ output: wire({ decisions: [{ text: 'Cut off', segmentIds: ['s2'] }, { text: 'Sent', segmentIds: ['s1'] }], speakers: [{ label: 'B', name: 'Asha Verma' }] }) }]);
    const r = await summarizeMeeting({ ai, spend, prices }, long);
    expect(r.cut).toBe(true);
    expect(r.summary.decisions).toEqual([{ text: 'Sent', segmentIds: ['s1'] }]);
    // The action item cites s2 only, and B never spoke in what was sent.
    expect(r.summary.actionItems).toEqual([]);
    expect(r.summary.speakers).toEqual([]);
    expect(r.dropped).toBe(3);
  });
});
