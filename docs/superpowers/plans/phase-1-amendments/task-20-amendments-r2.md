# Task 20 amendments, round 2 (controller decisions from the review of 5325bea)

Apply on top of task-20.md and task-20-amendments.md (src/output/googleAuth.ts, src/output/drive.ts, tests/helpers/fakeDrive.ts, tests/output/*). Keep everything else.

## 1. Log the error object, not its name
The project logger's `err` serializer (src/util/logger.ts) keeps an Error's type, `code` and stack frames and drops the message. Passing a string loses everything. Log `{ step, err: e, failures }`, where `e` is the original Error. For a build failure that is the original error from `build()`, not the PublishError wrapper. Both amendment tests also assert that `entry.err.type` is the original error's name (for example `'Error'` or `'DriveNotFoundError'`) and that the message still does not appear.

## 2. Token store: derived key, AAD, clear error
- In the `TokenStore` constructor, derive the key: `this.#key = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'google-refresh-token', 32))`. Then encrypt and decrypt with AAD `Buffer.from('google_refresh_token')`.
- New exported `class TokenDecryptError extends Error` with message `Stored Google sign-in cannot be read with this PC's key. Run: npm run cli -- google-auth` and `{ cause }`. `load()` throws it when decryption fails. It never includes the stored value.
- No caller changes.

## 3. PKCE on the sign-in
In `runLoopbackConsent`:
- `const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync()`;
- add `code_challenge_method: 'S256'` (use the library's enum if it has one) and `code_challenge: codeChallenge` to `generateAuthUrl`;
- exchange with `client.getToken({ code, codeVerifier })`.

## 4. Sign-in robustness
- **State first:** `parseCallback` checks `state` first.
  - A request with **no** `state` parameter (a stray local request, `/`, `/favicon.ico`) gets a 404 and does **not** end the sign-in. Only a request carrying a state counts as the redirect.
  - A wrong state → 400 and reject.
  - With the right state, check `error`, then `code`.
- **Browser text:** after receiving a valid code, the page says `Sign-in received. Return to the terminal.` Don't claim success before the exchange.
- **Server errors:** `server.on('error', reject)`. If `showUrl` throws, close the server and reject.
- **Granted scope:** after `getToken`, if `tokens.scope` does not include `https://www.googleapis.com/auth/drive.file`, throw `Error('Drive access was not granted. Run google-auth again and keep the Google Drive box ticked.')` and do not return a token.

## 5. Drive requests time out
`drive({ version: 'v3', auth: client, timeout: 120_000 })`.

## 6. Publisher fixes
- **publishNow:** `publishNow()` while a run is in flight sets `#pending` and returns, instead of starting a second run. It resolves when the in-flight run, and the pending follow-up if any, are done, or simply when the current run ends; either is fine, but document which.
- **stop():** becomes `async stop(timeoutMs = 30_000): Promise<void>`. It blocks new runs, clears timers, then waits for an in-flight run to finish, or for `timeoutMs`. That way a file created at shutdown has its id saved before the DB closes. Leave no timer behind.
- **Root folder deleted:** when `createFile` into the stored root fails with `DriveNotFoundError`, re-create the folder, store the new id and retry the create once, all in the same run.
- **onPublished:** call `onPublished` in its own try/catch. A throw there is logged (`log.error({ err: e }, 'onPublished failed')`) and never counts as a publish failure or triggers a re-upload.
- **Failure hook:** new option `onFailure?: (f: { step: 'build' | 'drive'; auth: boolean }) => void`. It is called after each failed run and wrapped in try/catch.
  - `auth` is true when the Drive error is an auth problem: a gaxios error with `code` 401, or with `response?.data?.error === 'invalid_grant'`, or an error whose name or message says invalid_grant. Read the gaxios error shape in node_modules.
  - Map such errors to a new exported `DriveAuthError` (name `'DriveAuthError'`, fixed message `Google sign-in has expired or was revoked. Run: npm run cli -- google-auth`, with `cause`) before logging, so the log shows the type.

## Tests to add
- TokenStore:
  - round-trips;
  - a different master key → `TokenDecryptError`;
  - a tampered stored value → `TokenDecryptError`;
  - in both cases the message does not contain the token;
  - the stored kv value does not decrypt with the raw master key (proves the derived key is used).
- `parseCallback`:
  - no state → a "not the redirect" result (or however you model the 404) that does not end the sign-in;
  - wrong state → throws;
  - right state with `error=access_denied` → throws a cleaned message.
- `runLoopbackConsent`, local parts only. Inject a fake OAuth client with `generateAuthUrl`, `generateCodeVerifierAsync` and `getToken`; add a constructor option such as `client?` if needed.
  - The URL contains `code_challenge`, `code_challenge_method=S256`, `access_type=offline`, `prompt=consent` and scope exactly drive.file.
  - A request to `/` does not end the flow.
  - A wrong state gives 400 and a rejection.
  - A second request after the redirect is refused or gets 404.
  - The timeout closes the server.
  - Missing drive.file in the granted scope rejects.
  - getToken is called with the codeVerifier.
- Publisher:
  - Backoff grows 60 s → 120 s → … and caps at 15 min (fake timers).
  - `schedule()` during a run gives exactly one follow-up run.
  - `publishNow()` during a run does not create a second folder or file.
  - `await stop()` waits for an in-flight create and the file id is stored. `stop()` with a hung run resolves at its timeout. 0 timers left afterwards.
  - Root folder deleted → recovered in one run (one new folder, one new file, no failure logged).
  - `onPublished` throwing → logged, no re-upload.
  - A 401 from updateFile → `onFailure({ step: 'drive', auth: true })` and the log's `err.type` is `'DriveAuthError'`.

Commit message: `fix: token key derivation, PKCE, Drive timeouts and publisher shutdown`
