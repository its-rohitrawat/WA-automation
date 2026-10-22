import { parseArgs } from 'node:util';
import { AiInvalidOutputError, AiRefusalError, ClaudeClient, MAX_OUTPUT_TOKENS } from '../src/brain/claudeClient.ts';
import { buildUserContent, SYSTEM_PROMPT } from '../src/brain/prompt.ts';
import { validateOps } from '../src/brain/validator.ts';
import { loadEnv, requireKey } from '../src/config/env.ts';
import { estimateCostUsd, FALLBACK_PRICES, pricesFromEnv, type Prices } from '../src/spend/pricing.ts';
import { GOLDEN_CASES, scoreCase, validationStateFor } from '../tests/golden/cases.ts';

const { values } = parseArgs({ options: { yes: { type: 'boolean', default: false }, case: { type: 'string' } } });

let selected = GOLDEN_CASES;
if (values.case !== undefined) {
  const n = Number(values.case);
  if (!Number.isInteger(n) || n < 1 || n > GOLDEN_CASES.length) {
    console.log(`--case must be a number from 1 to ${GOLDEN_CASES.length}.`);
    process.exit(1);
  }
  selected = [GOLDEN_CASES[n - 1]!];
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
const runs = selected.map((c) => ({ c, user: buildUserContent(c.input) }));
const estimate = runs.reduce((sum, r) => sum + estimateCostUsd(SYSTEM_PROMPT.length + r.user.length, ceilingPrices, MAX_OUTPUT_TOKENS), 0);

console.log(
  `${runs.length} golden case(s) on ${env.AI_MODEL}; estimated cost up to $${estimate.toFixed(2)} (one attempt per case; SDK retries on network errors can add more).`,
);
if (!values.yes) {
  console.log('Nothing was sent. Re-run with --yes to call the API.');
  process.exit(0);
}

const ai = new ClaudeClient({ apiKey: requireKey(env, 'ANTHROPIC_API_KEY'), model: env.AI_MODEL, effort: env.AI_EFFORT, prices: envPrices });
let spent = 0;
let failures = 0;
for (const { c, user } of runs) {
  try {
    const result = await ai.reconcile(SYSTEM_PROMPT, user);
    spent += result.costUsd;
    // Grade what production would apply: only operations the validator accepts.
    const { accepted, rejected } = validateOps(result.output.ops, validationStateFor(c.input));
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
  } catch (e) {
    // Never print the message: it could echo model text.
    if (e instanceof AiRefusalError || e instanceof AiInvalidOutputError) spent += e.costUsd ?? 0;
    console.log(`FAIL  ${c.name} (${e instanceof Error ? e.name : 'unknown error'})`);
    failures++;
  }
}
console.log(`Actual cost: $${spent.toFixed(3)}`);
// exitCode, not process.exit(): exiting while the SDK's keep-alive sockets close can trip a libuv assertion on Windows.
process.exitCode = failures > 0 ? 1 : 0;
