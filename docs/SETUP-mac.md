# WA Agent: Mac setup

This is the Mac version of [SETUP.md](SETUP.md). Do the steps once, in order, in **Terminal**. Lines starting with `sudo` ask for your Mac admin password.

Only the setup and the service commands differ from Windows. Everything else in SETUP.md (pilot week, shared files, morning report, everyday commands, status lines) applies as written. When you read it, translate as shown in [Reading SETUP.md on a Mac](#reading-setupmd-on-a-mac) at the end.

## 1. Prepare the Mac

```sh
sudo pmset -a sleep 0 disksleep 0 powernap 0 autorestart 1
fdesetup status
```

- The first line stops the Mac from sleeping and turns it back on after a power cut.
- `fdesetup status` must say **FileVault is On**. If not, turn it on in System Settings > Privacy & Security > FileVault first. The agent's master key is protected by FileVault and by its file permissions.
- **After a power cut, someone must unlock the Mac.** With FileVault on, a restarted Mac waits at the unlock screen and the agent does not start until someone signs in once. A small UPS (battery backup) is recommended.
- System Settings > General > Software Update > Automatic updates: turn **off** "Install macOS updates", so the Mac never restarts into the unlock screen by itself. Install updates by hand during office hours.

## 2. Create the service account

A service account is a separate Mac user that runs the agent in the background.

```sh
sudo sysadminctl -addUser waagent -fullName "WA Agent" -password -
sudo dscl . create /Users/waagent IsHidden 1
```

The first line asks for a password for waagent: choose a strong one and keep it in your password manager. The second line hides the account from the login screen.

Unlike Windows, changing or resetting this password later does no harm.

## 3. Install the software

1. Install **Node.js 24 LTS** with the macOS installer (`.pkg`) from nodejs.org. Use the installer, not Homebrew: the service expects Node at `/usr/local/bin/node`. Check with `node --version`.
2. Install Git: `xcode-select --install` (skip if `git --version` already works).
3. Get the code, as waagent:

```sh
sudo mkdir -p /opt/wa-agent
sudo chown waagent:staff /opt/wa-agent
sudo -u waagent -H git clone https://github.com/its-rohitrawat/WA-automation.git /opt/wa-agent
sudo -u waagent -H sh -c 'cd /opt/wa-agent && npm ci && mkdir -m 700 data logs && touch logs/wa-agent.out.log logs/wa-agent.err.log'
sudo chmod 700 /opt/wa-agent
```

The last line matters: only waagent (and admins, through `sudo`) can now reach `.env`, the code, `data/` and the logs.

### The waagent window

From now on, "the waagent window" means a Terminal window where you ran:

```sh
sudo -u waagent -i
cd /opt/wa-agent
```

Run every `npm run cli -- ...` command and every file edit there. Type `exit` to leave it. The service commands (`sudo launchctl ...`) go in a normal Terminal window, not the waagent window.

## 4. Keys and settings (waagent window)

```sh
cp .env.example .env
chmod 600 .env
nano .env
```

Fill in the same settings as SETUP.md step 4 (`ANTHROPIC_API_KEY`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `DAILY_SPEND_CAP_USD`), and follow the same notes on spend limits and the Google OAuth client. In `nano`, save with Ctrl+O, Enter, and quit with Ctrl+X.

Create the empty allow-list:

```sh
printf '{ "clients": [] }\n' > config/allowed-groups.json
```

## 5. One-time sign-ins (waagent window)

```sh
npm run cli -- google-auth
npm run cli -- link
npm run cli -- list-groups
```

Exactly as SETUP.md step 5:

1. `google-auth` prints a link. Open it in a browser **on this Mac**, signed in as the mailbox account, and allow access.
2. `link` shows a QR code. Scan it from the founder's phone: WhatsApp > Settings > Linked devices > Link a device. Make the Terminal window big enough to show the whole QR code. The founder's phone then lists this link as "WA Agent - Tracker".
3. `list-groups` prints the group ids. Add the 1–2 pilot groups with `nano config/allowed-groups.json`, in the format shown in SETUP.md.

Once the owner dashboard is set up (section 10), choosing groups and fixing a connection start in the dashboard; these commands stay as the fallback.

## 6. Install and start the service (normal Terminal window)

```sh
sudo cp /opt/wa-agent/deploy/macos/com.wa-agent.plist /Library/LaunchDaemons/
sudo chown root:wheel /Library/LaunchDaemons/com.wa-agent.plist
sudo chmod 644 /Library/LaunchDaemons/com.wa-agent.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.wa-agent.plist
```

The service now starts at every boot, and restarts by itself if it crashes.

**Wait one minute**, then in the waagent window run `npm run cli -- status`. Expect `Health: ✅ Connected…` **and** the `WhatsApp:` line saying `open`.

If the code is not in `/opt/wa-agent`, or Node is not at `/usr/local/bin/node`, change those paths in the `.plist` before copying it.

### Service commands

| To | Run (normal Terminal window) |
|---|---|
| **Stop the service safely** (it stays off, even after a restart of the Mac) | `sudo launchctl disable system/com.wa-agent` then `sudo launchctl bootout system/com.wa-agent` |
| **Start the service again** | `sudo launchctl enable system/com.wa-agent` then `sudo launchctl bootstrap system /Library/LaunchDaemons/com.wa-agent.plist` |
| Restart (after `google-auth` or a change to `.env`) | `sudo launchctl kickstart -k system/com.wa-agent` |
| Is it running? | `sudo launchctl print system/com.wa-agent \| grep -E 'state\|last exit'` |

Stopping can take up to 2.5 minutes if the agent is finishing an AI call or reading a shared file. That is normal. Wait for it.

After starting again, wait one minute and run `npm run cli -- status` (waagent window).

### Log files

In `/opt/wa-agent/logs/` (read them in the waagent window, for example `tail -n 50 logs/wa-agent.err.log`):

- `wa-agent.out.log`: the normal log, and crashes while running.
- `wa-agent.err.log`: the reason the service refused to start (last line).

These logs are not trimmed automatically. Check their size once a month (`ls -lh logs`). If one grows past about 100 MB, stop the service safely, move the file to `backups/`, and start again.

## 7. Morning report (a short message with the tracker link)

Monday to Friday at 06:00 IST the founder gets one short WhatsApp message from a spare number: the open and overdue totals and a link to the tracker on Google Drive, which opens on its **Today** tab. No file is attached. `REPORT_DAYS` changes the days (`mon-sat` or `daily`; empty is Monday to Friday). The founder needs view access to `Tracker.xlsx`: share the **WA Agent** folder with the founder's Google account (Viewer), or the link asks for access. Set it up once:

1. Spare SIM in a spare phone with WhatsApp. From the founder's phone, send the spare number "hi".
2. **Stop the service safely** (see *Service commands*).
3. Waagent window: `npm run cli -- link-sender`, and scan the QR code from the **spare** phone. The spare phone then lists this link as "WA Agent - Morning report". If the founder's phone ever shows "WA Agent - Morning report", the wrong phone scanned it: remove that device and link again from the spare phone.
4. `nano .env` and set `REPORT_ENABLED=true` and `REPORT_RECIPIENT=` the founder's number: `91` then the 10-digit mobile, digits only.
5. **Start the service again**, wait one minute, then: `npm run cli -- report status`.
6. In Google Drive (mailbox account), share the **WA Agent** folder with the founder's Google account as Viewer.
7. Test once (it works on any day): `npm run cli -- report send-now`, type `yes`, check the founder's phone and open the link.

Details and every status message: "Morning report" in [SETUP.md](SETUP.md).

## 8. Voice notes: local speech-to-text

Voice notes can be turned into text by an open-source model that runs on this Mac, on its processor only. No audio leaves the Mac, there is no key and it costs nothing. It is **off** until you set `VOICE_STT_PROVIDER=local`.

**The service transcribes voice notes once `VOICE_STT_PROVIDER=local` is set and the service is restarted.** These steps build the engine, let you test it on real notes with a check command, then switch it on.

Two models are offered; you choose one with the check below:

- **Voxtral** (`voxtral`): the most accurate on Hindi in published tests, but it may be slower than the note itself (a 10-minute note can take 10–20 minutes).
- **Qwen3-ASR** (`qwen3-asr`): about 2–3 times faster than the note, less accurate on Hindi in published tests.

How well either handles Hinglish, and whether English words come out in English or Devanagari letters, is not published. Your check on real notes decides.

### Build the engine (about 15 minutes)

Normal Terminal window, once:

```sh
brew install cmake
sudo mkdir -p /opt/stt/models
sudo chown -R waagent:staff /opt/stt
```

Waagent window. Always this exact version (v0.4.1): the program is young and its options changed in earlier versions.

```sh
cd /opt/stt
git clone --branch v0.4.1 --depth 1 https://github.com/handy-computer/transcribe.cpp.git
cd transcribe.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
find "$PWD/build" -name transcribe-cli -type f
```

The last line prints the full path of the program. Note it for `STT_LOCAL_BIN`. The build uses the processor's fastest instructions by itself; nothing else needs to be set.

Optional, only if you also want to try Whisper (`whisper`). Waagent window, this exact version (v1.9.5):

```sh
cd /opt/stt
git clone --branch v1.9.5 --depth 1 https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp
cmake -B build -DGGML_METAL=OFF
cmake --build build -j --config Release
find "$PWD/build" -name whisper-cli -type f
```

### Download a model and check it

Download only from these addresses. Waagent window, for Voxtral (3 GB):

```sh
cd /opt/stt/models
curl -L --fail -o Voxtral-Mini-3B-2507-Q4_K_M.gguf https://huggingface.co/handy-computer/Voxtral-Mini-3B-2507-gguf/resolve/main/Voxtral-Mini-3B-2507-Q4_K_M.gguf
shasum -a 256 Voxtral-Mini-3B-2507-Q4_K_M.gguf
```

The long number `shasum` prints must be **exactly** the one in the table. If it is not, the file is damaged or not the real one: delete it (`rm` and the file name) and download it again. Never use a file whose number does not match.

| Engine | File | Address | Size | `shasum -a 256` |
|---|---|---|---|---|
| `voxtral` | `Voxtral-Mini-3B-2507-Q4_K_M.gguf` | `https://huggingface.co/handy-computer/Voxtral-Mini-3B-2507-gguf/resolve/main/Voxtral-Mini-3B-2507-Q4_K_M.gguf` | 2.98 GB | `3a6717aa8f8989108d260cbd237584289eec43cc987e10133c33643515936205` |
| `qwen3-asr` | `Qwen3-ASR-1.7B-Q8_0.gguf` | `https://huggingface.co/handy-computer/Qwen3-ASR-1.7B-gguf/resolve/main/Qwen3-ASR-1.7B-Q8_0.gguf` | 2.19 GB | `9a0d81792dfea2d5f278b8a63deb3ea6e02139ce42c2301f32ea19c4f77526b7` |
| `qwen3-asr` (smaller) | `Qwen3-ASR-1.7B-Q4_K_M.gguf` | `https://huggingface.co/handy-computer/Qwen3-ASR-1.7B-gguf/resolve/main/Qwen3-ASR-1.7B-Q4_K_M.gguf` | 1.32 GB | `b7afe3674f653fa84f712ed2440353c6e7cf7f93697fef76b05a26538b24844e` |
| `whisper` | `ggml-large-v3-turbo.bin` | `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin` | 1.62 GB | `1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69` |
| `whisper` (smaller) | `ggml-large-v3-turbo-q8_0.bin` | `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin` | 0.87 GB | `317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1` |

To compare Voxtral with Qwen3-ASR, download the Qwen3-ASR file too, the same way (`curl` with its address, then `shasum`). Whisper's own download script does not check these numbers, so always download with `curl` as above.

### Settings (waagent window)

In the app folder, open the settings with `nano .env` and set, with the paths `find` printed and the model you downloaded:

```sh
cd /opt/wa-agent
nano .env
```

```sh
VOICE_STT_PROVIDER=local
STT_LOCAL_ENGINE=voxtral
STT_LOCAL_BIN=/opt/stt/transcribe.cpp/build/bin/transcribe-cli
STT_LOCAL_MODEL=/opt/stt/models/Voxtral-Mini-3B-2507-Q4_K_M.gguf
```

- `STT_LOCAL_BIN` and `STT_LOCAL_MODEL` must be full paths starting with `/`. The `transcribe-cli` path above is an example: use the one `find` printed.
- For Qwen3-ASR: `STT_LOCAL_ENGINE=qwen3-asr` and the Qwen3-ASR model file. For Whisper: `STT_LOCAL_ENGINE=whisper`, the `whisper-cli` path and a Whisper model file.
- Leave the others empty unless needed: `STT_LOCAL_THREADS` (default 8, one per core), `STT_LOCAL_TIMEOUT_SECONDS` (default 1800: a note that takes longer is stopped and tried again, 3 tries in all), `STT_LOCAL_LANGUAGE` (default `hi`; `en` or `auto`; Qwen3-ASR always finds the language itself).
- `VOICE_STT_PROVIDER` must be `local` or `none` (or the same paid service as `STT_PROVIDER`). Meetings use `STT_PROVIDER` (see "Meetings on the same engine" below).

### Test it on real notes (waagent window)

The check takes any audio file: a WhatsApp voice note (`.opus` or `.ogg`), `.mp3`, `.m4a` and so on. It converts the file with ffmpeg to the 16 kHz mono WAV the engine takes, in a temporary folder of its own that it removes afterwards, as the service does. It uses `FFMPEG_PATH` from `.env` when set, otherwise the `ffmpeg` on the PATH. A 16 kHz mono WAV is used as it is.

Make a private folder for the test notes, outside the code folder:

```sh
mkdir -m 700 ~/stt-check
```

Copy 2–3 real Hinglish voice notes into it. From a normal Terminal window, for a note in your Downloads folder: `sudo cp ~/Downloads/note1.opus /Users/waagent/stt-check/` then `sudo chown waagent /Users/waagent/stt-check/note1.opus`. Then, waagent window, for each note:

```sh
cd /opt/wa-agent
npm run stt:local-check -- ~/stt-check/note1.opus
```

The check prints the engine, the audio length, the mean volume, the time it took, the realtime factor (under 1 means faster than the note itself) and the transcript, in this window only. Nothing is saved or sent.

- **Mean volume:** -50 dB or lower counts as silence. An empty transcript of a note that is not silent is shown as "the service would retry this note": the service never takes it as "no speech", it tries the note again (3 tries in all). A very quiet note (around -40 dB) can come back empty; if real notes do, tell us.
- If the check says ffmpeg was not found, install it from a normal Terminal window with `brew install ffmpeg`, or set `FFMPEG_PATH` to its full path in `.env`.

Run the same notes with `STT_LOCAL_ENGINE=voxtral` and then with `STT_LOCAL_ENGINE=qwen3-asr` (change `STT_LOCAL_MODEL` to the matching file each time). Compare:

- Are names, sites, dates and amounts right?
- Do English words come out in English letters?
- Is the time acceptable for your longest notes?

Keep the settings of the one you choose. When you are done, remove the test copies: `rm -r ~/stt-check`.

If the check says `Failed (...)`, it also says what to look at. `no_output` usually means a different program version: build exactly v0.4.1 as above.

### Meetings on the same engine

Meeting recordings can use the same engine too: set `STT_PROVIDER=local` in `.env` (with the same `STT_LOCAL_*` settings as above) and restart the service. There is no key and no speech cost, and no audio leaves the Mac. Meetings found while speech-to-text was not set up are picked up right after the restart. It is slow on this Mac's processor: a 3-hour meeting takes about 4 hours on Voxtral and under 3 on Qwen3-ASR, in ten-minute parts, one at a time. Voice notes and meeting parts share the engine, so a voice note that arrives during a meeting part waits for it. The local engine gives no speaker labels: the summary and the Doc's transcript show the text with times, each line labelled "Speaker", and names are not matched to voices.

### Then restart the service

Normal Terminal window: `sudo launchctl kickstart -k system/com.wa-agent`. Wait one minute. After the restart, new voice notes are transcribed. For older ones, run `npm run cli -- transcribe-voice` in the waagent window (a dry run that only counts them), then `npm run cli -- transcribe-voice --yes`, which queues them for the running service. Run `npm run cli -- status`: if its Health line says the local speech engine is not set up, or ffmpeg not found, see "Voice note status lines" in SETUP.md. If it says voice notes could not be transcribed on this computer, see the same place: `npm run cli -- transcribe-voice --failed` tries them again.

## 9. Uptime monitoring (optional, UptimeRobot)

UptimeRobot can tell you when the agent stops working. The agent visits a secret link every 5 minutes while it is working; when the visits stop, UptimeRobot sends you an alert by email, SMS or its app. The agent sends nothing else: no messages, names or numbers.

1. In UptimeRobot, add a new monitor of type **Heartbeat** (heartbeat monitors may need a paid plan; check UptimeRobot's pricing page). Set the interval to **5 minutes**, and choose who gets the alerts.
2. UptimeRobot shows the monitor's heartbeat link (it starts with `https://heartbeat.uptimerobot.com/`). Copy it. Treat it like a password: anyone who has it can make the monitor look green.
3. Waagent window: open `.env`, paste the link after `HEARTBEAT_URL=`, and save. Do not paste it anywhere else.
4. Normal Terminal window: `sudo launchctl kickstart -k system/com.wa-agent`. About a minute later the first visit arrives and the monitor turns green.

The visits stop, and you get an alert, when:

- the Mac is off, asleep or offline, or the service stopped or crashed;
- WhatsApp is unlinked, taken over, refused, or disconnected for over 30 minutes;
- the Google sign-in expired, or tracker updates have failed for over an hour.

Smaller warnings (a group waiting, the daily AI budget, low disk) do not stop the visits; they show on the status line as usual. After an alert, run `npm run cli -- status` in the waagent window: its Health line says what is wrong. To switch monitoring off, empty `HEARTBEAT_URL=` and restart the service.

## 10. Owner dashboard (optional)

The agent can show a private owner dashboard in the browser, at `http://localhost:8787/dashboard` on this Mac, and the website at `http://localhost:8787/`. It listens on this Mac only (`127.0.0.1:8787`): nothing on the office network can reach it. To open it from anywhere on the company domain, follow [GO-LIVE.md](GO-LIVE.md) after this section.

1. **Back up first.** The first start with the dashboard version adds new tables to the database. Do step 1 of [GO-LIVE.md](GO-LIVE.md) (stop the service, copy `data`, check the copy) before the update reaches the Mac. The service stays stopped until step 5.
2. **Get the new version, and from now on always run `npm ci` after pulling.** Do step 2 of [GO-LIVE.md](GO-LIVE.md): the Mac's update step must, every time, run `git pull --ff-only`, then `npm ci`, then the restart, as `waagent`; and after the merge you pull and run `npm ci` once by hand. The dashboard's files come as new parts; without `npm ci` it does not load.
3. **Google web sign-in client.** Google Cloud Console, the same project as today: **APIs & Services → Credentials → Create credentials → OAuth client ID**, type **Web application**, name `WA Agent dashboard`. Under **Authorized redirect URIs**, add the two on this Mac first:

   ```
   http://localhost:8787/dashboard/auth/callback
   http://localhost:8787/dashboard/connect/google/callback
   ```

   The two on the company domain come later (GO-LIVE.md, step 3). Copy the client ID and secret straight into `.env` in the next step, nowhere else.
4. **Settings.** Waagent window: open `.env` and set (your real values in place of the examples):

   ```
   DASHBOARD_ENABLED=true
   DASHBOARD_PORT=8787
   DASHBOARD_OWNER_EMAILS=owner@example.com
   DASHBOARD_GOOGLE_CLIENT_ID=your_web_client_id_here
   DASHBOARD_GOOGLE_CLIENT_SECRET=your_web_client_secret_here
   DASHBOARD_PUBLIC_URL=
   UPTIMEROBOT_READ_KEY=
   ```

   `DASHBOARD_OWNER_EMAILS`: the Google accounts that may sign in, separated by commas. `DASHBOARD_PUBLIC_URL` stays empty until the company domain is set up (GO-LIVE.md). `UPTIMEROBOT_READ_KEY` is optional: a read-only key, never the main one.
5. **Start the service again** (normal Terminal window; it was stopped in step 1): `sudo launchctl enable system/com.wa-agent` then `sudo launchctl bootstrap system /Library/LaunchDaemons/com.wa-agent.plist`. Later changes to `.env` need only a restart: `sudo launchctl kickstart -k system/com.wa-agent`.
6. **Open** `http://localhost:8787/dashboard` in Chrome on this Mac and sign in with an owner email. Safari may refuse the sign-in on a `http://localhost` address.
7. **Client groups:** from now on, choose them in **Clients → Manage groups**, as in SETUP.md, "Choosing client groups in the dashboard". Editing `config/allowed-groups.json` with `nano` stays the fallback.
8. **Connections:** when one is down, start with **Fix now** on the Overview, as in SETUP.md, "Fixing a connection in the dashboard". The commands (`npm run cli -- link`, `link-sender`, `google-auth`, in the waagent window) stay the fallback when the dashboard can't be reached.

To switch it off: set `DASHBOARD_ENABLED=false` in `.env` and restart. The agent carries on as before.

## Reading SETUP.md on a Mac

| SETUP.md (Windows) | On the Mac |
|---|---|
| `C:\wa-agent\...` | `/opt/wa-agent/...` (forward slashes) |
| admin window / waagent window | normal Terminal window with `sudo` / the waagent window (step 3) |
| `notepad <file>` | `nano <file>` |
| `copy a b` / `move a b` | `cp a b` / `mv a b` |
| `mkdir C:\wa-agent\backups\2026-10-21-1430` | `mkdir -p backups/2026-10-21-1430` |
| `net stop wa-agent`, "Stop the service safely" | the **Stop** line in *Service commands* above |
| `net start wa-agent`, "Start the service again" | the **Start** line in *Service commands* above |
| `net stop` + `net start` (restart) | `sudo launchctl kickstart -k system/com.wa-agent` |
| `deploy\winsw\wa-agent.out.log` / `.err.log` | `logs/wa-agent.out.log` / `logs/wa-agent.err.log` |
| `data\keys\master.key.dpapi` | `data/keys/master.key` |
| `services.msc`, WinSW, `icacls`, BitLocker, `powercfg` | not used; see steps 1–6 above |

The screen messages still say `net start wa-agent` in a few places; use the Mac commands above instead.

### MASTER_KEY_UNREADABLE on a Mac

The key file `data/keys/master.key` is damaged, or belongs to a different account (for example it was created by running a command as your own user instead of in the waagent window). First check the owner: `ls -l data/keys` in the waagent window must show `waagent`. If it shows another user, fix it with `sudo chown -R waagent:staff /opt/wa-agent/data` (normal window), then start the service again. Otherwise follow the MASTER_KEY_UNREADABLE steps in SETUP.md, moving `data/keys/master.key` instead of `master.key.dpapi`.

**Never run `npm run cli` with plain `sudo`, or as your own user.** Files it creates would belong to the wrong account and the service could not read them. Always use the waagent window.

## Moving from a Windows PC

The master key cannot be moved from Windows (DPAPI ties it to that PC), so the Mac starts with a fresh `data/` folder. You may copy `config/allowed-groups.json` (keep the same client codes). Ask the developer before copying `data/tracker.db`: parts of it are locked with the Windows key. Stop the Windows service safely first, and on the founder's phone remove the old Windows link (listed as "Windows" or "WA Agent - Tracker") before step 5. Never run the Windows PC and the Mac at the same time on the same WhatsApp number.
