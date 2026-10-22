# STT bake-off: runbook

A one-off test that sends the same recordings to three speech-to-text services (Sarvam, ElevenLabs and OpenAI). It writes a side-by-side report that you score by hand. The winner becomes the agent's transcriber for voice notes and meetings (spec §7.4).

## What it costs

About **$3** for 10 voice notes and 3 one-hour meetings, and about $5 at most. The tool prints its estimate before sending anything. It stops before passing `--max-usd` (default $8), and it never sends the same file to the same service twice unless you ask.

| Service | Model | List price per audio hour |
|---|---|---|
| Sarvam | saaras:v4, codemix | ₹30, or ₹36 with speaker labels. ₹100 free credit on sign-up |
| ElevenLabs | Scribe v2 | $0.22. The free plan includes 4.5 hours |
| OpenAI | gpt-transcribe (voice notes), gpt-4o-transcribe-diarize (meetings) | $0.27 / $0.36. Needs prepaid credit |

Note: OpenAI's model with speaker labels shuts down on 26 February 2027. OpenAI can therefore only be a long-term choice for voice notes.

## Must do before the first upload

These steps protect client data. The tool refuses to send anything until you add `--confirm-privacy`, which means you have done all four.

1. **ElevenLabs:** turn off model training.
   - Click your profile icon (top right) and go to **Terms and privacy** > **Data use**.
   - Switch **"Improve the models for everyone"** OFF, then click **"Update your choice"**.
   - The switch only covers audio sent after the change, so do it before any upload.
2. **Sarvam:** opt out of training and set retention to 0 days.
   - Sarvam's privacy policy says it trains on uploaded content **unless you opt out**. Opt out in your account settings, or by email as the policy describes: https://sarvam.ai/privacy-policy
   - As the workspace Owner, set data retention to **No retention (0 days)**: https://docs.sarvam.ai/api/platform/data-retention. Until an Owner sets it, Sarvam keeps data indefinitely.
3. **OpenAI:** nothing to switch. OpenAI does not train on API audio, and its "Your data" page lists no retention for the transcription endpoint.
4. **Consent:** every meeting recording has its participants' consent, and you are allowed to share the voice notes with these three services.

## One-time setup

1. **Recordings.** Put them in a folder **outside** any project folder:
   - `C:\stt-samples\voice-notes\`: 5–10 WhatsApp voice notes in Hinglish, 5 seconds to 3 minutes each (.ogg or .opus as exported).
   - `C:\stt-samples\meetings\`: 2–3 Google Meet recordings, 30–90 minutes each, with 2–6 speakers (.mp4 as downloaded is fine).

   The tool refuses any folder inside a git repository.
2. **Keys.** Copy `.env.example` to `.env` in `C:\Users\Dell\Desktop\WA_agent-stt`. Open `.env` in Notepad and type in the three keys yourself. Never paste a key into a chat.
   - `SARVAM_API_KEY`: from the Sarvam dashboard.
   - `ELEVENLABS_API_KEY`: from ElevenLabs > Developers > API keys.
   - `OPENAI_API_KEY`: from the OpenAI platform > API keys (add prepaid credit first).
3. **ffmpeg.** Already on this PC, so nothing needs installing. In the same `.env`, set:
   `FFMPEG_PATH=C:\Users\Dell\AppData\Local\Programs\Python\Python312\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe`
4. Optional: `INR_PER_USD` (default 88) sets the rupee rate used for Sarvam's costs.

## Running it

Open PowerShell:

```powershell
Set-Location C:\Users\Dell\Desktop\WA_agent-stt

# 1. Dry run: lists every file, service, model and the estimate. Sends nothing.
node scripts/stt-bakeoff.ts

# 2. Try one short voice note first (use an id from the dry-run list).
node scripts/stt-bakeoff.ts --only voice-<name> --yes --confirm-privacy

# 3. Everything else. Finished results are never sent again.
node scripts/stt-bakeoff.ts --yes --confirm-privacy
```

Other options: `--providers sarvam,openai`, `--max-usd 5`, `--report-only` (rebuild the report from saved results), and `--help`.

Sarvam and ElevenLabs can take several minutes for a long meeting. The screen shows one line per file and service, with the processing time and cost, never the words.

## If something goes wrong

- **`failed ... http_401`**: the key is wrong or has no credit. That service is skipped for the rest of the run. Fix `.env`, then run again with `--retry-failed`.
- **`unknown ... no answer`**: the request was sent, but no answer came back (timeout or network). The service may still have charged for it.
  - Check that service's dashboard first, then run with `--retry-unknown`.
  - Sarvam then waits for the job it already has, with no new charge. ElevenLabs and OpenAI send the file again and may charge again.
- **`stopped ... cap`**: the next file would pass `--max-usd`. Raise the cap only if you mean to.

## Reading and scoring

Open `C:\stt-samples\bakeoff-out\report.md`, for example in VS Code, using the Markdown preview.
- **Summary:** the cost per audio hour and the speed of each service.
- **Score sheet:** fill it in yourself, scoring 1–5 for Hinglish accuracy (names, numbers, dates, amounts and task words) and for speaker separation in meetings.
- **Voice notes:** the three transcripts of each voice note, side by side.
- **Meetings:** a minute-by-minute timeline per service. Full transcripts are in `transcripts\`.

Compare the costs with each service's dashboard. The report uses list prices.

## Afterwards

- Tell the agent's builder which service won and why. Phase 2b then sets `STT_PROVIDER`.
- `C:\stt-samples\bakeoff-out` holds client conversations. Delete it, and the recordings, once the decision is made. Never copy it into a project folder.
- Revoke the API keys of the services you did not choose.
