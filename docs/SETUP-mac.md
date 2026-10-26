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
2. `link` shows a QR code. Scan it from the founder's phone: WhatsApp > Settings > Linked devices > Link a device. Make the Terminal window big enough to show the whole QR code.
3. `list-groups` prints the group ids. Add the 1–2 pilot groups with `nano config/allowed-groups.json`, in the format shown in SETUP.md.

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

## 7. Morning report (the Excel sheet every morning)

Every day at 06:00 IST the founder gets one WhatsApp message from a spare number, with the tracker attached as `Tracker-YYYY-MM-DD.xlsx`. Set it up once:

1. Spare SIM in a spare phone with WhatsApp. From the founder's phone, send the spare number "hi".
2. **Stop the service safely** (see *Service commands*).
3. Waagent window: `npm run cli -- link-sender`, and scan the QR code from the **spare** phone.
4. `nano .env` and set `REPORT_ENABLED=true` and `REPORT_RECIPIENT=` the founder's number: `91` then the 10-digit mobile, digits only.
5. **Start the service again**, wait one minute, then: `npm run cli -- report status`.
6. Test once: `npm run cli -- report send-now`, type `yes`, and check the founder's phone.

Details and every status message: "Morning report" in [SETUP.md](SETUP.md).

## 8. Voice notes: local speech-to-text

Voice notes can be turned into text by an open-source model that runs on this Mac, on its processor only. No audio leaves the Mac, there is no key and it costs nothing. It is **off** until you set `VOICE_STT_PROVIDER=local`.

**In this version the service does not use it yet.** These steps build the engine and let you test it on real notes with a check command. Wiring it into the service comes in a later update; until then, voice notes are not transcribed.

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
cmake --build build
find "$PWD/build" -name transcribe-cli -type f
```

The last line prints the full path of the program. Note it for `STT_LOCAL_BIN`. The build uses the processor's fastest instructions by itself; nothing else needs to be set.

Optional, only if you also want to try Whisper (`whisper`). Waagent window:

```sh
cd /opt/stt
git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git
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

`nano .env` and set, with the paths `find` printed and the model you downloaded:

```sh
VOICE_STT_PROVIDER=local
STT_LOCAL_ENGINE=voxtral
STT_LOCAL_BIN=/opt/stt/transcribe.cpp/build/bin/transcribe-cli
STT_LOCAL_MODEL=/opt/stt/models/Voxtral-Mini-3B-2507-Q4_K_M.gguf
```

- `STT_LOCAL_BIN` and `STT_LOCAL_MODEL` must be full paths starting with `/`. The `transcribe-cli` path above is an example: use the one `find` printed.
- For Qwen3-ASR: `STT_LOCAL_ENGINE=qwen3-asr` and the Qwen3-ASR model file. For Whisper: `STT_LOCAL_ENGINE=whisper`, the `whisper-cli` path and a Whisper model file.
- Leave the others empty unless needed: `STT_LOCAL_THREADS` (default 8, one per core), `STT_LOCAL_TIMEOUT_SECONDS` (default 1800: a note that takes longer is given up), `STT_LOCAL_LANGUAGE` (default `hi`; `en` or `auto`; Qwen3-ASR always finds the language itself).
- `VOICE_STT_PROVIDER` must be `local` or `none` (or the same paid service as `STT_PROVIDER`). Meetings keep using `STT_PROVIDER`, unchanged.

### Test it on real notes (waagent window)

The engine takes a 16 kHz mono WAV file. Make a private folder for the test notes, outside the code folder:

```sh
mkdir -m 700 ~/stt-check
```

Copy 2–3 real Hinglish voice notes (`.opus` or `.ogg` files) into it. From a normal Terminal window, for a note in your Downloads folder: `sudo cp ~/Downloads/note1.opus /Users/waagent/stt-check/` then `sudo chown waagent /Users/waagent/stt-check/note1.opus`. Then, waagent window, for each note:

```sh
ffmpeg -i ~/stt-check/note1.opus -ar 16000 -ac 1 -c:a pcm_s16le ~/stt-check/note1.wav
npm run stt:local-check -- ~/stt-check/note1.wav
```

The check prints the engine, the audio length, the time it took, the realtime factor (under 1 means faster than the note itself) and the transcript, in this window only. Nothing is saved or sent.

Run the same notes with `STT_LOCAL_ENGINE=voxtral` and then with `STT_LOCAL_ENGINE=qwen3-asr` (change `STT_LOCAL_MODEL` to the matching file each time). Compare:

- Are names, sites, dates and amounts right?
- Do English words come out in English letters?
- Is the time acceptable for your longest notes?

Keep the settings of the one you choose. When you are done, remove the test copies: `rm -r ~/stt-check`.

If the check says `Failed (...)`, it also says what to look at. `no_output` usually means a different program version: build exactly v0.4.1 as above.

### Then restart the service

Normal Terminal window: `sudo launchctl kickstart -k system/com.wa-agent`. Wait one minute, then run `npm run cli -- status` in the waagent window. As said above, the service starts transcribing voice notes only after the later update.

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

The master key cannot be moved from Windows (DPAPI ties it to that PC), so the Mac starts with a fresh `data/` folder. You may copy `config/allowed-groups.json` (keep the same client codes). Ask the developer before copying `data/tracker.db`: parts of it are locked with the Windows key. Stop the Windows service safely first, and on the founder's phone remove the old "WA Agent" device before step 5. Never run the Windows PC and the Mac at the same time on the same WhatsApp number.
