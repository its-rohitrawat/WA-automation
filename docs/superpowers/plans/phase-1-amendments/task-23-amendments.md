# Task 23 amendments (controller decisions; apply on top of the task text)

`ClaudeClient` now takes `prices` (see task-16-amendments.md, round 2). In `src/main.ts`, build it as:

```ts
const prices = pricesFromEnv(env);
...
ai: new ClaudeClient({ apiKey: requireKey(env, 'ANTHROPIC_API_KEY'), model: env.AI_MODEL, effort: env.AI_EFFORT, prices }),
...
prices,
```

## From the Task 20 review
- Wrap `new TokenStore(db, key).load()` in try/catch.
  - On `TokenDecryptError`, call `exitEarly(e.message)`; that message says to run google-auth.
  - Treat `SessionDecryptError`, when opening the WhatsApp session, the same way, with `exitEarly(e.message)`.
  - Rethrow anything else.
  - Never print the stored value.
- `app.stop()` already awaits the debouncer drain and `publisher.stop()`. Keep `db.close()` after it resolves.
