import { parseArgs } from 'node:util';
import { ClaudeClient, MAX_OUTPUT_TOKENS } from '../src/brain/claudeClient.ts';
import { buildUserContent, SYSTEM_PROMPT } from '../src/brain/prompt.ts';
import { loadEnv, requireKey } from '../src/config/env.ts';
import { estimateCostUsd, pricesFromEnv } from '../src/spend/pricing.ts';
import { GOLDEN_CASES, scoreCase } from '../tests/golden/cases.ts';

const { values } = parseArgs({ options: { yes: { type: 'boolean', default: false } } });
const env = loadEnv();
const prices = pricesFromEnv(env);
const runs = GOLDEN_CASES.map((c) => ({ c, user: buildUserContent(c.input) }));
const estimate = runs.reduce((sum, r) => sum + estimateCostUsd(SYSTEM_PROMPT.length + r.user.length, prices, MAX_OUTPUT_TOKENS), 0);

console.log(`${runs.length} golden cases on ${env.AI_MODEL}; estimated cost up to $${estimate.toFixed(2)}.`);
if (!values.yes) {
  console.log('Nothing was sent. Re-run with --yes to call the API.');
  process.exit(0);
}

const ai = new ClaudeClient({ apiKey: requireKey(env, 'ANTHROPIC_API_KEY'), model: env.AI_MODEL, effort: env.AI_EFFORT, prices });
let spent = 0;
let failures = 0;
for (const { c, user } of runs) {
  const result = await ai.reconcile(SYSTEM_PROMPT, user);
  spent += result.costUsd;
  const score = scoreCase(c, result.output.ops);
  console.log(`${score.pass ? 'PASS' : 'FAIL'}  ${c.name}${result.fallbackUsed ? ' (fallback model used)' : ''}`);
  for (const m of score.missing) console.log(`      missing:   ${m}`);
  for (const f of score.forbidden) console.log(`      forbidden: ${f}`);
  if (result.invalidOps > 0) console.log(`      invalid ops: ${result.invalidOps}`);
  if (!score.pass) failures++;
}
console.log(`Actual cost: $${spent.toFixed(3)}`);
process.exit(failures > 0 ? 1 : 0);
