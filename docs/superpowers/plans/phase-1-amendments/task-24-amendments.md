# Task 24 amendments (controller decisions; apply on top of the task text)

## From the Task 21 review
- `HealthSnapshot` has an extra field, `publishFailingSince: string | null`. Add `publishFailingSince: null` to the test fixture.
- `formatStatus` prints a row `Drive: failing since <IST date time>` when `publishFailingSince` is set. Higher-priority lines can hide the health line's own message, so the row is useful.
- **Stale report:** if the snapshot's `at` is strictly more than 2 minutes old (`>`, not `>=`), `formatStatus` puts this line first: `⚠️ The service has not reported since <IST date time>. Is it running?` The service persists health every 30 seconds while running. After a stop, the last snapshot can still say "✅ Connected".
- `readHealthSnapshot` returns `undefined` for a missing, malformed or wrong-shape value; print the existing "no report yet" text in that case.
- Tests:
  - the fixture with `publishFailingSince` set prints the Drive row;
  - an `at` 3 minutes old prints the stale line first;
  - an `at` 1 minute old does not.

## Interfaces that changed since the task text was written
- `TokenStore` takes `(db, masterKey)` and derives its own key; `load()` can throw `TokenDecryptError`.
- `runLoopbackConsent({ clientId, clientSecret, scopes: DRIVE_SCOPES, showUrl })` resolves the refresh token. It uses PKCE, binds 127.0.0.1, ignores stray requests and checks the granted scope.
- `acquireLock(dataDir)` is async and resolves `{ release(): Promise<void> }`; `resetSession(db)` lives in src/wa/authState.ts.
