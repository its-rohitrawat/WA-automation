# Meetings on the local speech engine

> **For agentic workers:** use superpowers:subagent-driven-development or superpowers:executing-plans, task by task, tests first. Branch `feat/meetings-local-stt` in `C:\Users\Dell\Desktop\WA_agent-meet-local` (from main 9a0ae1a). Read `src/meetings/transcribe.ts`, `src/meetings/sttParts.ts`, `src/stt/local.ts`, `src/stt/voice.ts`, `src/stt/types.ts`, `src/stt/prices.ts` and `src/config/env.ts` first.

**Goal:** meetings use the same free local engine as voice notes (transcribe.cpp with Voxtral or Qwen3-ASR, already built on the Mac Pro). Set `STT_PROVIDER=local` and meetings are transcribed on the Mac, with no key and no spend. Meetings stuck in "waiting for speech-to-text" are then processed.

**Owner decisions (28 Oct 2026):**
- Build it now.
- No speaker labels: the local engine gives plain text, and summaries work from that. No diarizer.

**Ground rules:**
- Paid providers keep working exactly as today. `STT_PROVIDER=none` keeps today's safe wait (stt_none deferral).
- Nothing leaves the Mac with `local`. No key, and `STT_API_KEY` is not required for `local`.
- No spend is booked for local parts. The spend cap and the meeting state machine still behave correctly (local parts never count towards the cap and never need booking or recovery).
- Logs carry the meeting id, part number, provider, seconds and duration only, never transcript text or file paths.
- Erasable TypeScript, `.ts` imports, tests first, full `npm test` plus `npm run typecheck` before each commit.

---

## Task 1: Settings: `STT_PROVIDER=local`

- `src/config/env.ts`: add `local` to `STT_PROVIDER`. `local` needs no `STT_API_KEY`. When `STT_PROVIDER` or `VOICE_STT_PROVIDER` is `local`, the existing `STT_LOCAL_BIN` and `STT_LOCAL_MODEL` checks apply, with the same messages, naming the setting and never the value.
- `VOICE_STT_PROVIDER`'s rule ("local, none or the same as STT_PROVIDER") still holds; `local` with `local` is fine.
- `.env.example`: say that `STT_PROVIDER=local` sends meetings through the local engine too.
- **Tests:** `local` accepted without a key; bin and model required for meetings-local; the paid and none cases are unchanged; error text never echoes values.

## Task 2: The local meeting transcriber

- **New `LocalMeetingTranscriber`** implementing `MeetingTranscriber` (src/meetings/transcribe.ts), in a new file such as `src/meetings/localTranscriber.ts`. It reuses the voice-note engine code in `src/stt/local.ts` (args, run, kill grace, output parsing) instead of copying it.
  - `provider` is `'local'`; extend `ProviderId` and `prices.ts` so `local` costs 0 (`modelFor` gives the engine name, for example `local:voxtral`).
  - `maxPartSeconds`: 600, ten-minute parts, so a 3-hour meeting becomes 18 parts.
  - `partCeilingUsd` and `partCostUsd` return 0. `forgetRef` is null.
  - `transcribePart`: the part WAV (16 kHz mono, made by the existing part planning and ffmpeg) goes to the local engine with the engine, model, threads and language settings. The result is segments with no speaker label, so `speaker` is null or the shape segments use when unknown.
- **Time per part:** each part gets its own timeout, `STT_LOCAL_TIMEOUT_SECONDS` (default 1800, max 7200), not one for the whole meeting. A part that times out is retried like today's local voice-note timeout (3 tries), then the meeting fails as today.
- **Booking and recovery:** local parts are never set up for booking. `withSttHold`, Sarvam job booking, `bookStuckParts` and `recoverInflightParts` must treat a local part as needing nothing. A part left in flight by a crash or shutdown is simply transcribed again.
- **Spend:** no spend rows for local parts. The spend cap doesn't defer local meetings (spend_cap and spend_busy deferrals don't apply to `local`).
- **Shutdown:** the engine process is stopped on abort, as for voice notes, and the part is re-run on the next start.
- **Tests (fake engine, no real binary):**
  - a 25-minute meeting gives 3 parts, all transcribed and merged in order;
  - no spend rows are written;
  - each part has its own timeout;
  - a timed-out part is retried, then fails the meeting after the tries are used up;
  - a crash mid-part re-runs only that part;
  - the cap doesn't block local;
  - logs hold no transcript text or paths;
  - paid providers' existing tests all still pass.

## Task 3: Wiring, summaries without speakers, health, docs

- **Wiring:** where the meeting transcriber is built (`main.ts` meetingDeps and/or the transcribe module's factory), `STT_PROVIDER=local` builds the `LocalMeetingTranscriber`. Meetings waiting with stt_none are picked up on the next tick after a restart with `local`.
- **Summaries:** check the summary prompt and the transcript formatting handle segments with no speaker. No "undefined" or "null" speaker text reaches Claude or the Doc; plain lines with timestamps are fine. Test it.
- **Health and dashboard:** the meetings `sttProvider` shows `local`. The status line and the dashboard's meetings and connections text say "local speech engine" where they named the provider. If the engine is not set up (missing bin or model), meetings show the same "local speech engine is not set up" problem voice notes show.
- **Docs:**
  - `docs/SETUP-mac.md` section 8: one paragraph saying meetings can use the same engine with `STT_PROVIDER=local`. Add a note on speed (a 3-hour meeting takes about 4 hours on Voxtral and under 3 on Qwen3-ASR on the Mac Pro's CPU) and on the absence of speaker labels.
  - `docs/SETUP.md`: the meetings section mentions `local`.
  - Lock the new setting name in `tests/docs/setup.test.ts`.
- **Tests:** the factory picks local; stt_none meetings are processed after switching to local; the summary input has no null speakers; the health label.
