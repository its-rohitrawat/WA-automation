# STT bake-off: runbook

A one-off test that sends the same recordings to three speech-to-text services (Sarvam, ElevenLabs and OpenAI). It writes a side-by-side report that you score by hand. The winner becomes the agent's transcriber for voice notes and meetings (spec §7.4).

## What it costs

About **$3** for 10 voice notes and 3 one-hour meetings, and about $5 at most. The tool prints its estimate before sending anything. It stops before passing `--max-usd` (default $8), and it never sends the same file to the same service twice unless you ask. The cap is **per run**: each new run can spend up to it again.

| Service | Model | List price per audio hour |
|---|---|---|
| Sarvam | saaras:v4, codemix | ₹30, or ₹36 with speaker labels. The ₹100 sign-up credit covers about 2½ hours of meetings; the full test needs about ₹115–180, so add credit before the full run. |
| ElevenLabs | Scribe v2 | $0.22. The free plan includes 4.5 hours, less than three 90-minute meetings plus voice notes. |
| OpenAI | gpt-transcribe (voice notes), gpt-4o-transcribe-diarize (meetings) | $0.27 / $0.36. Needs prepaid credit |

Note: OpenAI's model with speaker labels shuts down on 26 February 2027. OpenAI can therefore only be a long-term choice for voice notes.

## Must do before the first upload

These steps protect client data. The tool refuses to send anything until you add `--confirm-privacy`, which means the three things below are true. OpenAI needs nothing: it does not train on API audio, and its "Your data" page lists no retention for the transcription endpoint.

1. **ElevenLabs:** turn off model training.
   - Click your profile icon and go to **Terms and privacy** > **Data use**.
   - Switch **"Improve the models for everyone"** OFF, then click **"Update your choice"**.
   - The switch only covers audio sent after the change, so do it before any upload.
   - This stops training only. ElevenLabs also stores the audio and transcripts on your account (only Enterprise accounts can turn storage off). The tool deletes each transcript from your ElevenLabs account right after saving it here, unless you add `--keep-remote`. Check your ElevenLabs history after the test, and tell participants about this when asking for consent.
2. **Sarvam:** opt out of training and set retention to 0 days.
   - Sarvam's privacy policy says it trains on uploaded content **unless you opt out**. Opt out the way the privacy policy describes (https://sarvam.ai/privacy-policy) and **wait for Sarvam's confirmation before the first upload**; keep the reply.
   - As the workspace Owner, set data retention to **No retention (0 days)**: https://docs.sarvam.ai/api/platform/data-retention. Until an Owner sets it, Sarvam keeps data indefinitely.
3. **Consent:** every meeting recording has its participants' consent to be sent to Sarvam, ElevenLabs and OpenAI, and you may share these voice notes with all three.

## One-time setup

1. **Recordings.** Put them in a folder **outside** any project folder, and not in a folder that OneDrive or Google Drive syncs:
   - `C:\stt-samples\voice-notes\`: 5–10 WhatsApp voice notes in Hinglish, 5 seconds to 3 minutes each (.ogg or .opus as exported).
   - `C:\stt-samples\meetings\`: 2–3 Google Meet recordings, 30–90 minutes each, with 2–6 speakers (.mp4 as downloaded is fine).

   The tool refuses any folder inside a git repository. Wait until every download has finished before running it.

   Do not rename or move recordings between runs: a renamed file counts as a new recording and is sent and paid again.
2. **Keys.** Open PowerShell and run:

   ```powershell
   Set-Location C:\Users\Dell\Desktop\WA_agent-stt
   Copy-Item .env.example .env
   notepad .env
   ```

   Run the `Copy-Item` line only once: a second time, it would replace your `.env`, keys and all.

   Near the end of the file are `SARVAM_API_KEY=`, `ELEVENLABS_API_KEY=` and `OPENAI_API_KEY=`. Type each key straight after its `=`, no spaces or quotes, then press Ctrl+S. Never paste a key into a chat.
   - `SARVAM_API_KEY`: from the Sarvam dashboard.
   - `ELEVENLABS_API_KEY`: from ElevenLabs > Developers > API keys.
   - `OPENAI_API_KEY`: from the OpenAI platform > API keys (add prepaid credit first).

   Watch for the `.env.txt` trap: the file must be called `.env`, not `.env.txt`. `Get-ChildItem -Force .env*` should list `.env` and `.env.example` only. If you see `.env.txt`, rename it with `Rename-Item .env.txt .env`.
3. **ffmpeg.** Already on this PC, so nothing needs installing. In the same `.env`, set:
   `FFMPEG_PATH=C:\Users\Dell\AppData\Local\Programs\Python\Python312\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe`
4. Optional: `INR_PER_USD` (default 88) sets the rupee rate used for Sarvam's costs.

## Running it

Open PowerShell:

```powershell
Set-Location C:\Users\Dell\Desktop\WA_agent-stt

# 1. Dry run: lists every recording with its id, each service, model and the estimate. Sends nothing.
node scripts/stt-bakeoff.ts

# 2. Try one short voice note first. Use an id from the dry-run list; it looks like voice-<name>-<8 letters and digits>.
node scripts/stt-bakeoff.ts --only <id> --yes --confirm-privacy

# 3. Everything else. Finished results are never sent again.
node scripts/stt-bakeoff.ts --yes --confirm-privacy
```

**Always use the same output folder** (the default `C:\stt-samples\bakeoff-out`, or the same `--out` every time). It holds the record of what was sent and paid for; a new folder means everything is sent and paid again.

Other options: `--providers sarvam,openai`, `--max-usd 5`, `--keep-remote` (keep ElevenLabs' copy of each transcript), `--report-only` (rebuild the report from saved results), and `--help`.

Sarvam and ElevenLabs can take several minutes for a long meeting. The screen shows one line per recording and service, with the processing time and cost, never the words. Ctrl+C stops a run; finished results are kept, and a recording that was being sent shows as `unknown` next time (see below).

## If something goes wrong

The tool never shows a key or the words of a recording in these messages.

- **`failed ... http_401`** (or `http_402`, `http_403`): the service refused the key or the account (a wrong key, or no credit), so it did no work on that request. That service is skipped for the rest of the run. Fix `.env` or add credit, then run again with `--retry-failed`. If Sarvam refuses while it is already working on a recording, that shows as `unknown ... status_http_...` instead (see below).
- **`failed ... http_429 insufficient_quota`**: OpenAI has no credit left. Add prepaid credit on the OpenAI platform, then run again with `--retry-failed`.
- **`unknown ... no answer (<code>)`**: the recording was sent, but no answer came back. The service may still have done the work and charged for it, so the tool does not send it again by itself. The code says why:
  - `timeout`, `http_504` and similar: the connection gave up.
  - `status_unavailable` or `job_wait_timeout`: Sarvam stopped answering while the job ran, or refused the key while you waited (fix `.env` first if the key changed). The tool keeps the job, so it can be fetched again later.
  - `download_http_` followed by a number from 500 up, or `download_http_401`, `download_http_403`, `download_http_408` or `download_http_429`: Sarvam finished, but its answer could not be fetched this time (a busy service, a key problem, or an expired download link). The tool keeps the job, so it can be fetched again later.
  - `status_http_...`, or `download_http_` followed by another number from 400 to 499 (for example `status_http_404` or `download_http_404`): Sarvam no longer has the job, so its answer can never be fetched. It may still have charged for it: check the Sarvam dashboard. `--retry-unknown` then sends the recording again, which may charge again.
  - Check that service's dashboard first (usage or history). Then run the dry run with `--retry-unknown` (no `--yes`) and read each line before sending.
  - Only a line that says "wait for the saved job (no new charge)" or "reuse saved answers (no new charge)" is free: Sarvam then waits for the job it already has, or the tool uses answers it already saved. A line that says "send again (an earlier attempt may already be billed)" sends the recording again and may charge again.
  - With `part_cache_mismatch`, nothing was sent: the long recording was cut differently from last time. Move that recording's part files (`results\<id>\<service>.part-*.json` in the output folder) aside, then run the dry run again: those parts are then sent again, which may charge again. With `--retry-failed` the same code can show as `failed ... part_cache_mismatch`; then too nothing was sent, and the earlier failure is kept as it was.
  - With `resume_part_without_job` or a code starting `audio_`, nothing was sent this time either. Run again; if it repeats, ask the agent's builder.
- **`failed ... audio_...`** (for example `audio_split_failed`): the tool could not cut that recording's converted audio into parts. Nothing was sent for it. Run again with `--retry-failed`; if it repeats, ask the agent's builder.
- **`stopped ... cap`**: the next file would pass `--max-usd`. The summary shows how many were not sent. Raise the cap only if you mean to.
- **`skip ... its state is now ...; make a new plan`**: that recording's record changed after the run planned it, for example because another run finished it or files were moved by hand. Nothing was sent for it. Run the dry run again to see the new plan.
- **`warning ... could not save the job id`**: Sarvam accepted the recording, but the tool could not write the job's id to disk (for example, the disk is full). It keeps waiting, so usually nothing is lost. If no answer arrives in the end, that job cannot be waited on later: the next dry run shows "send again (an earlier attempt may already be billed)", and sending it may charge again. Free up disk space before the next run.
- **`warning ... could not delete the provider's stored copy`**: the transcript is saved here, but ElevenLabs still has its copy. Delete it in your ElevenLabs history.
- **`Stopped: ...`**: the tool hit a problem it could not work around, such as a full disk. Finished results are kept. Run the same command again, or add `--report-only` to rebuild the report. If the message names a damaged file in `results\`, do not delete it; ask the agent's builder.
- **`These recordings could not be read`**: a listed file is damaged, still downloading, or not audio. Move it out of the folder or replace it. Nothing was sent.
- **`The recording ... changed after it was prepared or sent`**: the file is not the one used before. Rename the new file (it then gets a new id), or move the two folders the message names aside. Nothing was sent. The dry run and `--report-only` stop too, so the report never shows the old recording's words for the new one.
- **`Another run is using ...`**: a run is going in another window. If none is, the last one ended abruptly (for example the PC restarted): delete `run.lock` in the output folder.
- **`.env: ...`** or **`Unknown or misspelt option`**: fix the setting it names in `.env`, or check the option's spelling. Options start with two dashes, for example `--yes`.

## Reading and scoring

Open `C:\stt-samples\bakeoff-out\report.md` in VS Code and press Ctrl+Shift+V for the Markdown preview.
- **Summary:** the cost per audio hour and the speed of each service.
- **Voice notes:** the three transcripts of each voice note, side by side.
- **Meetings:** a minute-by-minute timeline per service. Full transcripts are in `transcripts\`.
- **Scores:** write them in `scores.md` in the same folder, 1–5 for Hinglish accuracy (names, numbers, dates, amounts and task words) and for speaker separation in meetings. The tool never overwrites `scores.md`; `report.md` is rebuilt on every run.

Compare the costs with each service's dashboard. The report uses list prices.

The transcripts are client conversations. Do not paste them into an AI assistant, and keep `C:\stt-samples` out of OneDrive or Google Drive synced folders.

The output folder also holds `results\` (the tool's record of what was sent and paid for; do not edit it) and `prepared\` (the converted audio).

## Afterwards

- Tell the agent's builder which service won and why. Phase 2b then sets `STT_PROVIDER`.
- Remove the three keys from `.env` (`notepad .env`, delete the text after each `=`, Ctrl+S), and revoke the API keys of the services you did not choose.
- Check that your ElevenLabs history is empty.
- `C:\stt-samples\bakeoff-out` holds client conversations. Delete it, and the recordings, once the decision is made. Never copy it into a project folder.
