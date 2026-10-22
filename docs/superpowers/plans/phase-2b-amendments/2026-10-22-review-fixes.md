# Phase 2b STT bake-off: review fixes (amendment 1)

Four reviews of the build (batches A–D) were each "Approved after fixes". None found a way to spend money without `--yes`, to leak a key, or to show transcript text on the console. This amendment lists every fix the controller accepted, grouped by the fixer that implements it.

- Every fix gets a test unless it says otherwise.
- Ids such as **A1** refer to the review that found the problem.
- No paid call, no network, and no edits outside `C:\Users\Dell\Desktop\WA_agent-stt`.

Money rule, restated: a slot is **failed** only when the provider definitely refused or failed the work. Anything else, where the work may have run and been billed, is **unknown**. An unknown slot is counted as spent and re-sent only with `--retry-unknown`.

---

## Group 1: core (`src/stt/http.ts`, `segments.ts`, `audio.ts`, `providers/*`)

### G1.1 Gateway errors are "no answer" (A1, C-I4)

- **Change:** in `send()`, the first thing inside `if (!res.ok)`: statuses **502, 504, 520, 524** throw `SttNoAnswerError(\`http_${status}\`)` after cancelling the body.
- **Why:** these come from a proxy that stopped waiting, while the provider behind it may still finish and bill the work.
- **Unchanged:** 408 and 521–523 stay "failed". There the request never reached the work.
- **Test:** a 504 gives `SttNoAnswerError` with code `http_504`.

### G1.2 `longFetch` never crashes on an odd status (A3)

- **Change, in `toResponse`:**
  - throw `Object.assign(new Error('Unusable HTTP status'), { code: 'bad_status' })` for statuses outside 200–599;
  - pass a null body for 101, 103, 204, 205 and 304, or when the body is empty.
- **Change, in the `'end'` listener:** wrap `resolve(toResponse(...))` in try/catch → `reject(e)`.
- **Test:** a loopback route answers status 600 → `requestJson` rejects with `SttNoAnswerError` code `bad_status`.

### G1.3 Compressed answers are decoded (A4)

- **Change, on the request side:** `headers['accept-encoding'] ??= 'identity'` on every request.
- **Change, on the response side:**
  - decode `content-encoding` gzip or x-gzip (`gunzipSync`), br (`brotliDecompressSync`) or deflate (`inflateSync`);
  - when decoded, do not copy the `content-encoding` and `content-length` headers;
  - decoding errors go through the same try/catch as G1.2.
- **Test:** a loopback route answers gzip JSON with `content-encoding: gzip` → `requestJson` returns the object.

### G1.4 No pooled sockets (A8)

- **Change:** pass `agent: false` to `transport(...)` in `longFetch`.
- **Why:** a reused keep-alive socket that the server already closed gives ECONNRESET before the request reaches the provider. That is a false "unknown".
- **Test:** none; covered by the existing tests.

### G1.5 Stricter error codes (A6)

- **Change:** `errorCodes` keeps a value only when `isCode(v)`:

  ```ts
  /** A short machine code ("invalid_api_key"); key-shaped or long hex/numeric strings are dropped, so a key can never be echoed. */
  const isCode = (v: string): boolean => /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/.test(v) && !/^sk[-_]|[0-9]{5,}|[0-9a-f]{16,}/i.test(v);
  ```

- **Tests:**
  - `sk_` followed by 40 hex characters is dropped;
  - the three-code cap holds;
  - a code four levels deep is ignored, with the depth limit unchanged.

### G1.6 More `longFetch` tests (A7)

- **New loopback routes:**
  - `/half`: `writeHead(200, {'content-length':'100'}); write('x')`, with no end;
  - `/drop`: the same, then `setImmediate(() => res.socket?.destroy())`.
- **Assertions:**
  - `requestJson(longFetch, base+'/half', { method:'GET', signal: AbortSignal.timeout(100) })` rejects with `SttNoAnswerError` code `timeout`;
  - `/drop` rejects with code `ECONNRESET`.
- **Multipart test:** have the server echo `received: Buffer.concat(chunks).length`, and assert that it equals `Number(echo.length)`.

### G1.7 Segment ends never move backwards (A5)

- **Change:** in `wordsToSegments`, `cur.end = Math.max(cur.end, w.end)`.
- **Tests:**
  - out-of-order words never give `end < start`;
  - words with a `null` speaker group together, as for voice notes.

### G1.8 No metadata leaves the PC (B1)

- **Change:** `toMp3` adds `-map_metadata -1 -map_chapters -1` right after `-vn`.
- **Why:** tags such as title, GPS location, device or contact name would otherwise be copied into the uploaded MP3.
- **Test:** assert both flags are in the arguments.

### G1.9 Equal-length parts (B7)

- **Change:** `split` uses `count = Math.ceil(input.seconds / partSeconds)` and `-segment_time (input.seconds / count).toFixed(3)`.
- **Why:** this avoids a tiny, pointless, paid last part. The part count still matches the plan's `ceil`.
- **Test:** update the existing split test: 430 s with a 300 s limit gives `-segment_time 215.000`.

### G1.10 Anchored duration (B8)

- **Change:** `parseDuration` uses `/^ {2}Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/m`.
- **Why:** a metadata tag containing "Duration: …" cannot be read as the length.
- **Test:** a tag line `    comment         : Duration: 00:00:09.00` is ignored, and the real `  Duration:` line is used.

### G1.11 Real `runFile` behaviour on Windows (B11)

- **Tests:**
  - `runFile('no-such-program-xyz', [], 5000)` resolves with code -1;
  - `runFile(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], 300)` resolves with code -1;
  - `runFile(process.execPath, ['-e', 'process.exit(3)'], 5000)` resolves with code 3.

### G1.12 Sarvam: a definite refusal while polling is not a miss (B2)

- **Change:** in `#waitForOutput`'s catch, rethrow `SttHttpError` when `status < 500 && status !== 408 && status !== 429`. Other errors still count as a miss.
- **Tests:**
  - 4 misses then `Completed` succeeds;
  - 5 misses give `status_unavailable`;
  - a 404 on status gives `SttHttpError`.

### G1.13 Sarvam: losing the download of a finished job is "no answer" (A2, C-I1)

- **Change:** in `transcribe`, wrap `#download`. An `SttHttpError` there becomes `SttNoAnswerError(\`download_http_${status}\`)`.
- **Why:** the job ran and is billed. The saved job id lets `--retry-unknown` download it again for free.
- **Test:** a 503 on `/download-files` gives `SttNoAnswerError` code `download_http_503`.

### G1.14 Sarvam: a completed job without a per-file state is fine (B4)

- **Change:**
  - `const fileFailed = detail?.state != null && detail.state !== 'Success';`
  - fail only on `job_state === 'Failed' || fileFailed || !name`.
- **Test:** a `Completed` job with no `state` field downloads normally.

### G1.15 Sarvam: `chunks` when `words` is empty (B6)

- **Change:** `const texts = t?.words?.length ? t.words : (t?.chunks ?? []);`
- **Test:** a result with `timestamps.chunks` gives segments.

### G1.16 A paid answer is never thrown away for a side field (B9)

- **Change:**
  - OpenAI: `UsageSchema` ends with `.nullish().catch(null)`.
  - ElevenLabs: `audio_duration_secs: z.number().nullish().catch(null)`.
- **Test:** an OpenAI answer with `usage: { seconds: 5 }` (no `type`) still parses, with `billedSeconds` null.

### G1.17 ElevenLabs transcripts are deleted from the account after the local save (B3, D-I7)

- **Change, in `src/stt/types.ts`:** add an optional method to `SttProvider`:

  ```ts
  /** Deletes the provider's own stored copy of this answer. Called only after the answer is saved locally. Free. */
  forget?(result: ProviderResult): Promise<void>;
  ```

- **Change, in `ElevenLabsProvider`:** implement `forget`:
  - read `transcription_id` from `result.raw` with a zod parse; do nothing when it is missing;
  - then `requestOk(this.#http, \`${ENDPOINT.replace('/speech-to-text', '/speech-to-text/transcripts')}/${encodeURIComponent(id)}\`, { method: 'DELETE', headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(60_000) })`.
  - The URL is `https://api.elevenlabs.io/v1/speech-to-text/transcripts/{id}`.
- **Who calls it:** the runner does (Group 2, G2.9).
- **Tests:**
  - DELETE to the right URL with the key;
  - no call when there is no `transcription_id`.

---

## Group 2: bake-off logic (`src/stt/bakeoff/samples.ts`, `ledger.ts`, `plan.ts`, `runner.ts`, `env.ts`)

### G2.1 Stable sample ids (C-C1, D-I1)

- **Change:** the id depends only on the file's own name: `${kind}-${slug(parse(name).name)}-${hash}`, where `hash` is the first 8 hex characters of `sha256(name.normalize('NFC'))`. If two files map to one id (practically impossible), throw.
- **Why:** adding, removing or renaming other files can never move a ledger entry. Without this, the tool could skip a new file, pay twice for an old one, or attach transcripts to the wrong recording.
- **Test:** update the ids in `samples.test.ts`, and add a test that ids stay the same when a file is added.

### G2.2 `insideGitRepo` follows junctions and links (C minor)

- **Change:** also check `realpathSync.native()` of the nearest existing folder at or above `dir`. Refuse if either the plain path or the real path is inside a repository.
- **Test:** none needed beyond the existing ones. A junction test needs admin rights on some PCs, so skip it.

### G2.3 Settings from `.env` win over the shell, and the rate is sane (C minor, D-M5)

- **Change, in `loadBakeoffEnv(file)`:** read the file with `readFileSync` and `node:util`'s `parseEnv`, then `parseBakeoffEnv({ ...process.env, ...fromFile })`. Keep the ENOENT handling. Do not call `process.loadEnvFile`, so `.env` secrets never enter `process.env`, which ffmpeg inherits.
- **Change:** `INR_PER_USD: z.coerce.number().finite().min(40).max(200).default(88)`.
- **Tests:**
  - a value in the file beats the same variable in the source environment;
  - `INR_PER_USD=8800` is rejected, naming the variable only.
- **Note:** the script passes the worktree's `.env` path (see G3.3).

### G2.4 Durable, retried ledger writes (C-I5)

- **Change, in `writeJson`:**
  - write the temp file with `openSync`/`writeSync`/`fsyncSync`/`closeSync`;
  - retry `renameSync` up to 20 times, 100 ms apart, on EPERM, EACCES or EBUSY, using `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)`. This is what antivirus and indexer file locks need on Windows.
- **Change, in `readJson`:** a JSON parse error throws `LedgerError` naming the file's path. The path is local and safe to show.
- **Change:** export `class LedgerError extends Error` (with `readonly code: string`). Every ledger write failure is wrapped in it.

### G2.5 `reopen` keeps the evidence (C-I1)

- **Change:**
  - `reopen` throws if the outcome is not `failed`;
  - it moves the outcome aside as `.failed-<ms>-<n>.json`, choosing a unique `n`;
  - it then moves the attempt aside as `.failed-<ms>-<n>.attempt.json`.
- **Test:** after `reopen`, both aside files exist and the state is `new`.

### G2.6 Part cache checks the cut (C minor)

- **Change:** `savePart` stores `{ offset, seconds, result }`, and `part(sampleId, provider, n, expect: { offset, seconds })` returns the result only when both match within 0.01 s.
- **Mismatch:** throw a `LedgerError` with code `part_cache_mismatch`. The runner then marks the slot **unknown** with that code and sends nothing.
- **Test:** add one.

### G2.7 Each send is recorded (C minor)

- **Change:** `Attempt` gains `sends: string[]`, the ISO time of each paid request. The runner appends to it before each fresh part request.
- **Test:** add one.

### G2.8 Resume is free only when it really is (C-I3)

- **Plan:** `PlanInput.hasJobId` becomes `canResume(sampleId, provider, parts)`. The script builds it from the ledger: every part n < parts has a job id or a cached answer. Otherwise the action is `send`, with the full estimate.
- **Runner backstop:** when `item.action === 'resume'` and a part has neither a job id nor a cached answer, return **unknown** with code `resume_part_without_job` and send nothing.
- **Tests:** add both.

### G2.9 Runner changes (C-I1, C-I2, C-I5, C-I6, C minor, B3)

1. **Fresh state before each slot.** Call `ledger.state(...)` before each slot. If it differs from `item.state`, skip the slot and log `skip     <label>: its state is now <x>; make a new plan`.
2. **Order:** `partsFor` → (if failed: `reopen`) → `begin`.
   - A `partsFor` failure on an **unknown** slot keeps it unknown: return the code, with `sentSeconds` 0.
   - On any other slot it is failed, as now.
3. `parts.length === 0` gives failed `audio_no_parts`.
4. **`onJobId`:** a `saveJobId` failure is caught. Log `warning  <label>: could not save the job id (<code>); still waiting` and keep waiting.
5. **`LedgerError` anywhere else stops the whole run.** Rethrow it out of `runPlan`; the script's fatal handler prints it.
   - The exception is `part_cache_mismatch`, which gives unknown (G2.6).
6. **`ACCOUNT_REFUSED`:** add 429 to it. That covers OpenAI's `insufficient_quota` and rate limits; nothing is retried anyway.
7. **`forget`:** after each fresh part is saved, if `provider.forget` exists and `deps.forgetRemote` is true, `await provider.forget(result)`.
   - A failure is logged as `warning  <label>: could not delete the provider's stored copy (<code>)` and is never fatal.
   - Add `forgetRemote: boolean` to `RunDeps`.
8. **`RunSummary`:** gains `unsent: number`, the slots left when the cap stopped the run.
9. **Tests (C test gaps):**
   - **Flags apart:** in `plan.test.ts`, check `retryFailed` and `retryUnknown` one at a time:
     - `retryFailed` only gives `['skip','send','skip']`;
     - `retryUnknown` only gives `['skip','skip','send']`.
   - **Write order:** a fake provider asserts, during the call, that `ledger.attempt` is not null and that part 0 is cached when part 1 is sent. Also assert that the final state is `done`.
   - **Unknown spend counts toward the cap:** an unknown 3600 s voice note on OpenAI (counted as $0.27), then a $0.20 estimate, with a $0.40 cap, gives 1 call and `stoppedAtCap`.
   - **Other runner cases:**
     - a 402 or 403 stops the provider;
     - `SttJobError` gives `job_<code>`;
     - a plain `Error` gives unknown;
     - a stale state gives a skip;
     - `forget` is called once per fresh part and a `forget` failure is only a warning;
     - a ledger write failure stops the run.

---

## Group 3: report, checks, command and runbook (`report.ts`, `checks.ts`, `scripts/stt-bakeoff.ts`, `docs/STT-BAKEOFF.md`)

### G3.1 Report (D-I4, D-M1, D-M2, D-M3)

- **Score sheet:** moves to its own file.
  - Export `buildScoreSheet()`, with rows for all `PROVIDER_IDS`.
  - The script writes `scores.md` **only if it does not exist** (`flag: 'wx'`).
  - In `report.md`, the section is replaced by: "Score in scores.md in this folder. It is never overwritten; report.md is rebuilt on every run."
- **`cell()`:** the first step becomes `.replace(/\s+/g, ' ')`, which also handles a lone `\r`.
- **Timeline:**
  - rows are limited to `Math.ceil(seconds / 60) + 5`;
  - segments with `start < 0` go in the first row, and later ones in the last row;
  - within a cell, turns are joined with a literal `<br>`, added by the code and never taken from the transcript.
- **Wording:**
  - the summary column "Files" becomes "Recordings";
  - `generatedAt` is local time, as `YYYY-MM-DD HH:MM` plus the UTC offset, passed in from the script;
  - with no outcomes and no unknown slots, the report says "No results yet." under Summary.
- **Tests:** update or add for each of these.

### G3.2 Checks wording (D-I7)

- **Change:** the consent line becomes "Every meeting recording has its participants' consent to be sent to Sarvam, ElevenLabs and OpenAI, and you may share these voice notes with all three."
- **Change:** the Sarvam line becomes "Sarvam: you opted out of training as the privacy policy describes and have Sarvam's confirmation, and the workspace data retention is set to 0 days (by the workspace Owner)."

### G3.3 Command (D-I1b, D-I2, D-I3, D-I5, D-M5, D-M6, C-I6)

1. **`.env` path:** read the worktree's file, `fileURLToPath(new URL('../.env', import.meta.url))`.
   - Settings errors print `.env: <names-only message> (see docs/STT-BAKEOFF.md)` and exit 1.
2. **`parseArgs`:** errors print "Unknown or misspelt option (options start with two dashes, for example --yes)." followed by the usage, and exit 1. Never echo the argument.
3. **Fatal handler:** also prints "Finished results are kept. Run the same command again to continue, or add --report-only to rebuild report.md."
4. **`--only`:** any id that no recording has is refused, with "use an id from the dry-run list".
5. **Unreadable recordings:**
   - Measuring collects every recording ffmpeg cannot read and stops with their paths: "damaged, still downloading, or not audio … Nothing was sent."
   - A `toMp3` failure stops with the path and code.
6. **Source fingerprint (D-I1b):**
   - Before preparing a sample, compare `prepared/<id>.mp3.source.json` with `{ size, mtimeMs }` of the original.
   - When the MP3 exists but the fingerprint is missing or different, stop: "The recording <path> changed after it was prepared or sent. Rename the new file (it then gets a new id), or move <out>\prepared and <out>\results\<id> aside. Nothing was sent."
   - Write the fingerprint after `toMp3`.
7. **Lock:**
   - Before preparing, take `run.lock` in the output folder with `openSync(..., 'wx')`, creating the folder first.
   - If it already exists, stop: "Another run is using <out>. If none is running, delete run.lock there."
   - Remove it on exit with `rmSync(force)`. It is only the tool's own lock file.
8. **The report covers every recording found, with results**, not only the `--only` ones. Seconds come from this run's measurement, or else from the saved outcome. That way `--only` never shrinks `report.md`.
9. **`canResume`** is built as G2.8 describes.
10. **New flag `--keep-remote`:** do not delete ElevenLabs' stored transcripts. By default they are deleted after the local save.
11. **Final summary** adds `, N not sent (cap)` when `unsent > 0`.
12. **Dry-run total:** shows 3 decimals below $1. In `plan.ts`, use `toFixed(total < 1 ? 3 : 2)`; that change is in Group 2.

### G3.4 Runbook (D-I6, D-I7, D-I8, D-M4)

- **Prices table:**
  - **Sarvam:** "₹30, or ₹36 with speaker labels. The ₹100 sign-up credit covers about 2½ hours of meetings; the full test needs about ₹115–180, so add credit before the full run."
  - **ElevenLabs:** "$0.22. The free plan includes 4.5 hours, less than three 90-minute meetings plus voice notes."
  - **OpenAI:** keep the line as it is.
  - The cap is **per run**.
- **Privacy steps:**
  - "Done all four" becomes three things the tool asks you to confirm, plus OpenAI needing nothing.
  - **ElevenLabs:** drop "(top right)". Add: "This stops training only. ElevenLabs also stores the audio and transcripts on your account (only Enterprise accounts can turn storage off). The tool deletes each transcript from your ElevenLabs account right after saving it here, unless you add --keep-remote. Check your ElevenLabs history after the test, and tell participants about this when asking for consent."
  - **Sarvam:** "Opt out the way the privacy policy describes (https://sarvam.ai/privacy-policy) and **wait for Sarvam's confirmation before the first upload**; keep the reply." Keep the retention step.
  - **Consent:** use the G3.2 wording.
- **`.env` creation:** the exact PowerShell steps (`Copy-Item .env.example .env`, `notepad .env`), then "type each key straight after its `=`, no spaces or quotes, Ctrl+S", plus the `.env.txt` trap.
- **Troubleshooting:** add a bullet for `http_429 insufficient_quota` (OpenAI credit) and one for `Stopped: …` (results are kept; run again or use `--report-only`). Also: "an `unknown` slot … check the dashboard".
- **Reading:**
  - Ctrl+Shift+V opens the Markdown preview;
  - scores go in `scores.md`, which is never overwritten;
  - do not paste transcripts into an AI assistant;
  - keep `C:\stt-samples` out of OneDrive or Google Drive synced folders.
- **Afterwards:**
  - remove the three keys from `.env`;
  - check that the ElevenLabs history is empty;
  - delete `C:\stt-samples\bakeoff-out` and the recordings once the decision is made.

---

## Not adopted

- **B5:** save the Sarvam job id before `start`. On resume that would need an upload-and-start path for `Accepted` jobs. Instead, the rare lost answer to `start` stays "unknown", with the dashboard check.
- **B10:** detect OpenAI answers cut short by the 2,000-token output limit. This is noted in the report's timeline note instead: "OpenAI meetings are sent in parts of up to 5 minutes; words at a cut can be lost."
- **C minor:** a `resumed` marker for processing time. It is rare and only cosmetic.
- **Test-folder clean-up** in the new tests: the existing suite does not do it either.

---

## Amendment 2: final-review fixes (2026-10-22)

The final review of the whole branch found two important problems (F1, F2) and eight minor ones (M1–M8). All are fixed, one commit each, with tests for every code change. As before: no paid call, no network, no edits outside `C:\Users\Dell\Desktop\WA_agent-stt`.

### F1 A Sarvam job that is gone after it started is "lost", not "failed"

- **Was:** a status check answering a 4xx (not 408/429) was recorded as failed, so `--retry-failed` would quietly pay again for a job that may be billed. A download refused for good (404, 403) stayed "unknown" with its job id, so every `--retry-unknown` resumed, met the same refusal and stayed unknown forever.
- **Now:**
  - `http.ts`: `SttJobLostError extends SttNoAnswerError`: the job may be billed but can no longer be waited on or downloaded.
  - `sarvam.ts`: a 4xx other than 408/429 on the status check gives `SttJobLostError('status_http_<n>')`; on the download (the download-files POST or the storage GET) it gives `SttJobLostError('download_http_<n>')`. 5xx, 408 and 429 on the download stay plain `SttNoAnswerError('download_http_<n>')`, which a saved job id resumes. A 3xx on a status check now counts as a missed check (only 400–499 are "for good"). `Failed` jobs and `no_output_file` stay `SttJobError`.
  - Ledger: `Attempt.lostJobIds?: Record<string,string>`, and `dropJobId(sampleId, provider, n)` moves `jobIds[n]` there, kept as evidence. A second lost job of the same part is kept as `"<n>-2"`, and so on.
  - Runner: tracks the part being sent; on `SttJobLostError` it drops that part's job id and returns unknown with the error's code. The next plan with `--retry-unknown` then shows "send again (an earlier attempt may already be billed)" with the full estimate.
- **Runbook:** explains `status_http_*` and `download_http_*` in plain words. The `http_401` line now says the refused request did no work, and that a refusal while Sarvam is already working shows as `unknown ... status_http_...`.

### F2 No runbook advice that re-pays everything

- Removed "or run with a fresh output folder (`--out`)" from the `part_cache_mismatch` advice. Added "Always use the same output folder; a new folder means everything is sent and paid again", also in the `--out` usage line.

### M1 Free resume wording

- The runbook and the `--retry-unknown` usage line now say a retry is free only where the dry run says "no new charge"; otherwise the recording is sent and paid again.

### M2 Renaming

- The runbook's recordings step: "Do not rename or move recordings between runs: a renamed file counts as a new recording and is sent and paid again."

### M3 Fingerprint for every recording

- `guards.ts`: `checkRecordings(recordings, preparedDir)` returns the changed ones and every recording's print as read now.
- The script checks **every recording found**, in every mode (dry run, `--report-only`, real run), before any report or plan. A recording replaced under the same name stops with the existing "changed" message, so no report shows old transcripts. The prints read then are the ones saved after preparing.

### M4 ElevenLabs `forget` after the outcome is saved

- The runner collects the fresh answers, writes the outcome, and only then calls `forget` for each, outside the `try`, so nothing after the outcome can turn it into a failure. Warnings only, as before.
- Also kept: when a slot ends failed or unknown, fresh answers saved before that are still forgotten, once the slot's record is settled. Before this change that happened right after each save.

### M5 Crash-safe ordering

- **Retry of a failed slot:** `ledger.reopen(fresh)` moves the old attempt aside, writes the fresh attempt, then moves the outcome aside. At every crash point the slot reads failed (the outcome is still there) or unknown, never "new". Tested by making each rename fail in turn, in the ledger and in the runner.
- **New failure over an old one** (audio could not be cut): `ledger.replaceFailed(outcome)` moves the attempt aside, writes a copy of the old outcome aside, then replaces the outcome in one rename. It reads failed throughout.
- **Part check first:** saved parts are checked against the cut (`part_cache_mismatch`) before `reopen`/`begin`. A mismatch on a failed slot leaves it failed, with every file unchanged and nothing sent; the run logs `failed ... part_cache_mismatch`. The runner's failed result now carries the error code instead of a written outcome.

### M6 Plan part count from the prepared MP3

- **Chosen:** when `prepared/<id>.mp3` exists, the script measures it, and `buildPlan` takes `preparedSeconds` for the part count. The original's length stays for the listing and the estimate.
- **Why this option:** the runner cuts exactly that file with the same `ceil(length / max)`, so the counts agree. Checked on a 600 s tone: its MP3 is 600.08 s, the plan now says 3 OpenAI parts (2 before), and the real split gives 3. The alternative (treating part indices beyond the plan as sends) cannot work alone: the plan never sees a part it does not know exists, so the slot would stay "resume", be refused by the runner's backstop, and be stuck.
- **Still true:** on a first run, before any MP3 exists, the listing counts from the original and may show one part fewer than is sent. Cost is by length, so the estimate is unaffected, and nothing can be resumed before a first send. The runner's `resume_part_without_job` backstop still guards any mismatch.

### M7 Lock token

- `takeRunLock` writes the note and `run <randomUUID>` into `run.lock` and returns `{ path, token }`. `releaseRunLock` removes the file only while it still holds that token. The exit handler uses it.

### M8 Cosmetics

- **Listing:** "Files whose audio would be uploaded" lists only `send` items. `Ledger.canResume` became `Ledger.resumeFrom`: `'jobs'`, `'answers'` or null. A resume says "wait for the saved job (no new charge)" when a saved job id is waited on, and "reuse saved answers (no new charge)" when every part already has an answer.
- **Unused fields:** `ModelPrice.source` is dropped; the price page URLs are now in the comment. `ProviderResult.model` stays: all three providers and about 20 test fakes set it, and saved part files hold it, so removing it is not trivial.
- **Runbook:** new entries for `failed ... audio_...`, `skip ... its state is now ...` and `warning ... could not save the job id`.
