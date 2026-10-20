# Task 23 amendments (controller decisions; apply on top of the task text)

`ClaudeClient` now takes `prices` (see task-16-amendments.md, round 2). In `src/main.ts`, build it as:

```ts
const prices = pricesFromEnv(env);
...
ai: new ClaudeClient({ apiKey: requireKey(env, 'ANTHROPIC_API_KEY'), model: env.AI_MODEL, effort: env.AI_EFFORT, prices }),
...
prices,
```
