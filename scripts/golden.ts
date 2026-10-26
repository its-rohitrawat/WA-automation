import { parseArgs } from 'node:util';
import { AiInvalidOutputError, AiRefusalError, ClaudeClient, MAX_OUTPUT_TOKENS, type AiCallResult } from '../src/brain/claudeClient.ts';
import { ClaudeMeetingClient, meetingEstimateUsd } from '../src/brain/meetingClient.ts';
import type { MeetingPrompt } from '../src/brain/meetingPrompt.ts';
import { validateSummary } from '../src/brain/meetingSchema.ts';
import { MEETING_TRACKER_PROMPT } from '../src/brain/meetingTracker.ts';
import { buildUserContent, SYSTEM_PROMPT } from '../src/brain/prompt.ts';
import { validateOps, type ValidationState } from '../src/brain/validator.ts';
import { loadEnv, requireKey } from '../src/config/env.ts';
import { estimateCostUsd, FALLBACK_PRICES, pricesFromEnv, type Prices } from '../src/spend/pricing.ts';
import { GOLDEN_CASES, scoreCase, validationStateFor, type GoldenCase } from '../tests/golden/cases.ts';
import {
  MEETING_SUMMARY_CASES,
  MEETING_TRACKER_CASES,
  meetingValidationStateFor,
  scoreSummaryCase,
  summaryPromptFor,
  unlistedSpeakerLabels,
  type MeetingSummaryCase,
  type MeetingTrackerCase,
} from '../tests/golden/meetingCases.ts';

const { values } = parseArgs({
  options: { yes: { type: 'boolean', default: false }, case: { type: 'string' }, meetings: { type: 'boolean', default: false } },
});

/** The cases --case picks from: the chat cases, or with --meetings the meeting cases (summaries, then tracker). */
function pick<T>(all: T[]): T[] {
  if (values.case === undefined) return all;
  const n = Number(values.case);
  if (!Number.isInteger(n) || n < 1 || n > all.length) {
    console.log(`--case must be a number from 1 to ${all.length}${values.meetings ? ' with --meetings' : ''}.`);
    process.exit(1);
  }
  return [all[n - 1]!];
}

const env = loadEnv();
const envPrices = pricesFromEnv(env);
// A true ceiling per attempt: the dearer of the configured and the fallback model's price, field by field.
const ceilingPrices: Prices = {
  inputPerMTok: Math.max(envPrices.inputPerMTok, FALLBACK_PRICES.inputPerMTok),
  outputPerMTok: Math.max(envPrices.outputPerMTok, FALLBACK_PRICES.outputPerMTok),
  cacheWritePerMTok: Math.max(envPrices.cacheWritePerMTok, FALLBACK_PRICES.cacheWritePerMTok),
  cacheReadPerMTok: Math.max(envPrices.cacheReadPerMTok, FALLBACK_PRICES.cacheReadPerMTok),
};

let spent = 0;
let failures = 0;

/** Grades what production would apply: only operations the validator accepts. */
function reportOps(c: GoldenCase, result: AiCallResult, state: ValidationState): void {
  spent += result.costUsd;
  const { accepted, rejected } = validateOps(result.output.ops, state);
  const score = scoreCase(c, accepted);
  console.log(`${score.pass ? 'PASS' : 'FAIL'}  ${c.name}${result.fallbackUsed ? ' (fallback model used)' : ''}`);
  for (const m of score.missing) console.log(`      missing:   ${m}`);
  for (const f of score.forbidden) console.log(`      forbidden: ${f}`);
  for (const r of rejected) console.log(`      rejected: ${r.op.op}${r.op.taskCode ? ` ${r.op.taskCode}` : ''} (${r.reason})`);
  // A forbidden op the validator happened to drop still shows the model was fooled.
  const raw = scoreCase(c, result.output.ops);
  for (const f of raw.forbidden.filter((x) => !score.forbidden.includes(x))) console.log(`      warning:   the model proposed ${f}; the validator dropped it`);
  if (result.invalidOps > 0) console.log(`      invalid ops: ${result.invalidOps}`);
  if (!score.pass) failures++;
}

function reportError(name: string, e: unknown): void {
  // Never print the message: it could echo model text.
  if (e instanceof AiRefusalError || e instanceof AiInvalidOutputError) spent += e.costUsd ?? 0;
  console.log(`FAIL  ${name} (${e instanceof Error ? e.name : 'unknown error'})`);
  failures++;
}

if (!values.meetings) {
  const runs = pick(GOLDEN_CASES).map((c) => ({ c, user: buildUserContent(c.input) }));
  const estimate = runs.reduce((sum, r) => sum + estimateCostUsd(SYSTEM_PROMPT.length + r.user.length, ceilingPrices, MAX_OUTPUT_TOKENS), 0);

  console.log(
    `${runs.length} golden case(s) on ${env.AI_MODEL}; estimated cost up to $${estimate.toFixed(2)} (one attempt per case; SDK retries on network errors can add more).`,
  );
  if (!values.yes) {
    console.log('Nothing was sent. Re-run with --yes to call the API.');
    process.exit(0);
  }

  const ai = new ClaudeClient({ apiKey: requireKey(env, 'ANTHROPIC_API_KEY'), model: env.AI_MODEL, effort: env.AI_EFFORT, prices: envPrices });
  for (const { c, user } of runs) {
    try {
      reportOps(c, await ai.reconcile(SYSTEM_PROMPT, user), validationStateFor(c.input));
    } catch (e) {
      reportError(c.name, e);
    }
  }
} else {
  type MeetingRun =
    | { kind: 'summary'; c: MeetingSummaryCase; prompt: MeetingPrompt; estimate: number }
    | { kind: 'tracker'; c: MeetingTrackerCase; user: string; estimate: number };
  const all: MeetingRun[] = [
    ...MEETING_SUMMARY_CASES.map((c): MeetingRun => {
      const prompt = summaryPromptFor(c);
      return { kind: 'summary', c, prompt, estimate: meetingEstimateUsd(prompt.system, prompt.user, ceilingPrices) };
    }),
    ...MEETING_TRACKER_CASES.map((c): MeetingRun => {
      const user = buildUserContent(c.input);
      return { kind: 'tracker', c, user, estimate: estimateCostUsd(MEETING_TRACKER_PROMPT.length + user.length, ceilingPrices, MAX_OUTPUT_TOKENS) };
    }),
  ];
  const runs = pick(all);
  const estimate = runs.reduce((sum, r) => sum + r.estimate, 0);

  console.log(`${runs.length} meeting golden case(s) on ${env.AI_MODEL}:`);
  for (const r of runs) console.log(`  ${all.indexOf(r) + 1}. ${r.kind === 'summary' ? 'summary' : 'tracker'}: ${r.c.name}: up to $${r.estimate.toFixed(2)}`);
  console.log(
    `Estimated cost up to $${estimate.toFixed(2)} in total (one attempt per case; SDK retries on network errors can add more to the tracker cases).`,
  );
  if (!values.yes) {
    console.log('Nothing was sent. Re-run with --meetings --yes to call the API.');
    process.exit(0);
  }

  const apiKey = requireKey(env, 'ANTHROPIC_API_KEY');
  const tracker = new ClaudeClient({ apiKey, model: env.AI_MODEL, effort: env.AI_EFFORT, prices: envPrices });
  // Effort as the plan sets it for summaries (Task 7): the client's default, medium.
  const summarizer = new ClaudeMeetingClient({ apiKey, model: env.AI_MODEL, prices: envPrices });
  for (const r of runs) {
    try {
      if (r.kind === 'tracker') {
        reportOps(r.c, await tracker.reconcile(MEETING_TRACKER_PROMPT, r.user), meetingValidationStateFor(r.c));
        continue;
      }
      const result = await summarizer.summarize(r.prompt.system, r.prompt.user);
      spent += result.costUsd;
      // Grade what production would store: the summary after validateSummary.
      const { summary, dropped } = validateSummary(result.output, r.prompt.segmentIds, r.prompt.names, r.prompt.labels);
      const score = scoreSummaryCase(r.c, summary);
      const empty = summary.whatHappened === '';
      const pass = score.pass && !empty;
      console.log(`${pass ? 'PASS' : 'FAIL'}  ${r.c.name}${result.fallbackUsed ? ' (fallback model used)' : ''}`);
      for (const m of score.missing) console.log(`      missing:   ${m}`);
      for (const f of score.forbidden) console.log(`      forbidden: ${f}`);
      if (empty) console.log('      empty summary after validation (production would try once more)');
      if (dropped > 0) console.log(`      dropped by validation: ${dropped}`);
      // Labels only, and only labels the case itself has: whatever else the model wrote is model text.
      const unlisted = unlistedSpeakerLabels(result.output, r.prompt.names);
      for (const label of unlisted.filter((l) => r.prompt.labels.includes(l))) {
        console.log(`      warning:   the model named ${label} with a name not on the list; validation dropped it`);
      }
      if (!pass) failures++;
    } catch (e) {
      reportError(r.c.name, e);
    }
  }
}
console.log(`Actual cost: $${spent.toFixed(3)}`);
// exitCode, not process.exit(): exiting while the SDK's keep-alive sockets close can trip a libuv assertion on Windows.
process.exitCode = failures > 0 ? 1 : 0;
