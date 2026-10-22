# Task 15 amendments, round 2 (controller decisions from the review of cbba124)

Apply on top of task-15.md (src/spend/pricing.ts, src/spend/spendGuard.ts, tests/spend/spend.test.ts). Keep everything else.

## 1. `record()` never throws on a bad amount and never lowers the total
If `!Number.isFinite(usd) || usd < 0`, record `this.#cap` instead. The detail becomes `` `${detail} (invalid amount, recorded as the cap)` ``. This pauses spending for the rest of the IST day instead of failing open. Add a doc comment on `detail`: `IDs and counts only, never message text.`

## 2. Reservations for calls in flight
Up to three clients reconcile at once. Each one checks the cap and then awaits a paid call that can take minutes. Without reservations they could all pass the check against the same total.

```ts
readonly #pending = new Map<number, number>();
#nextId = 1;

/** Holds an estimate while a paid call is in flight. Returns a reservation id, or null if it would pass the cap. */
reserve(estimateUsd: number): number | null
/** Records the actual cost and frees the reservation (the reservation is freed even if recording throws). */
settle(id: number, kind: 'ai' | 'stt', usd: number, detail: string): void
/** Frees a reservation without recording anything (the call was never billed). */
release(id: number): void
```

- `canSpend(estimateUsd)` returns true only if all of these hold:
  - not `isPaused()`;
  - `estimateUsd` is finite and >= 0;
  - `spentToday() + pendingTotal + estimateUsd <= cap`.
- `reserve` uses `canSpend`.
- `settle` and `release` with an unknown id are no-ops. `settle` with an unknown id still records the amount, so a cost is never lost.
- `isPaused()` is unchanged: recorded spend >= cap.

## 3. Estimates are a ceiling, not an average
In `pricing.ts`:

- `estimateCostUsd(promptChars, p, expectedOutputTokens = 16_000)` assumes **2** characters per token. Update the doc comment: `Ceiling estimate: 2 characters per token covers Hinglish and Devanagari, and the output allowance equals the Claude client's max_tokens (thinking counts as output).`
- Add a fallback price constant:

```ts
/** Server-side fallback from Opus 5.5 lands on Opus 5 or Opus 4.8, both priced like this (Anthropic pricing page, checked 2026-10-20). */
export const FALLBACK_PRICES: Prices = { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5 };
```

## Tests to add
- **Exactly at the cap:** cap 1, record 0.6. Then:
  - `canSpend(0.4)` is true; `canSpend(0.41)` is false.
  - After recording 0.4 more, `isPaused()` is true and `canSpend(0)` is false.
- **Day boundary:** a record at 18:29:59Z (23:59:59 IST) counts for that IST day. At 18:30:00Z, `spentToday()` is 0.
- **Bad amounts:**
  - `record('ai', NaN, 'batch 1')` does not throw, and afterwards `isPaused()` is true.
  - The same holds for `Infinity`.
  - `record('ai', -5, ...)` does not lower the total and pauses the day.
- **Bad estimates:** `canSpend(NaN)`, `canSpend(-1)` and `reserve(NaN)` return false or null.
- **Reservations:** cap 1.
  - `reserve(0.6)` returns an id; a second `reserve(0.6)` returns null.
  - After `release(id)`, `reserve(0.6)` succeeds again.
  - `settle(id, 'ai', 0.25, 'batch 1')` records 0.25 and frees the 0.6 hold, so `spentToday()` is 0.25 and `reserve(0.75)` succeeds.
- **Estimate formula:** `estimateCostUsd(3000, prices)` equals `(1500 * input + 16000 * output) / 1e6`.

Commit message: `fix: spend guard reserves in-flight calls and pauses on bad amounts`
