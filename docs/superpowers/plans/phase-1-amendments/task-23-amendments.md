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

## From the Task 22 review
- **Reload errors keep their reason.** When the allowed-groups watcher rejects a change, log the reason under a key the logger does not redact, e.g. `log.error({ problem: err instanceof Error ? err.message : String(err) }, 'allowed-groups.json change rejected; keeping the previous allow-list')`. Don't use `{ err: err.message }`: the `err` serializer turns a string into `{ type: 'Error' }`, so the reason is lost. These messages contain config values (codes, group ids, client names), never chat text.
- **App interface.** `createApp(d: AppDeps)`.
  - Fields: `db, clock, log, gateway, allow, ai, drive, prices, spendCapUsd, quietMs, maxWaitMs, maxConcurrent, dataDir`.
  - Optional fields: `pollMs, publishIntervalMs, freeBytes, drainMs`.
  - It returns `{ start, stop(): Promise<void>, reloadClients, health, publisher, debouncer }`.
  - Close the DB only after `app.stop()` resolves.
