# WA Agent: office PC setup and pilot

Do the steps once, in order. Commands run in **Command Prompt**. "Admin" means: right-click Command Prompt and choose *Run as administrator*.

What WA Agent does: it quietly reads the WhatsApp client groups you allow, keeps a task tracker, and updates an Excel file in Google Drive. It also saves the images and documents shared in those groups, reads them for the tracker, and puts the files that clients send into Drive. It never sends a WhatsApp message.

## 1. Prepare the PC (admin)

```bat
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /hibernate off
manage-bde -status C:
```

- These lines stop the PC from sleeping. The last one checks disk encryption.
- `manage-bde` must show **Protection On**. If not, turn on BitLocker or Device encryption in Settings first.
- In the BIOS, set **Restore on AC power loss** to **Power On**. A small UPS (battery backup) is recommended.
- Settings > Windows Update > Active hours: set to office hours.

## 2. Create the service account (admin)

A service account is a separate Windows user that runs the agent in the background.

```bat
net user waagent * /add
powershell -Command "Set-LocalUser -Name waagent -PasswordNeverExpires $true"
runas /user:waagent /profile "cmd /c echo profile ready"
```

Choose a strong password and keep it in your password manager. The second line stops the password from expiring (an expired password would stop the service). The `runas` line creates the account's Windows profile, which the encryption (DPAPI, Windows' built-in key protection) needs.

> **WARNING: never reset the waagent password from another account.**
> Resetting it makes the agent's encryption key unreadable. WhatsApp and Google would then have to be set up again.
> To change the password, sign in as waagent with the old password and change it there. Then enter the new password on the Log On tab in `services.msc` (see step 6).

## 3. Install the software (admin)

1. Install **Node.js 24 LTS** from nodejs.org (the Windows installer). Check with `node --version`.
2. Install **Git for Windows**, then:

```bat
git clone https://github.com/its-rohitrawat/WA-automation.git C:\wa-agent
cd /d C:\wa-agent
npm ci
icacls C:\wa-agent /inheritance:r /grant:r "Administrators:(OI)(CI)F" "SYSTEM:(OI)(CI)F" "waagent:(OI)(CI)M"
```

The last line matters. Folders directly under `C:\` let every Windows user on this PC read and change files. This line removes that, so only administrators, the system and waagent can reach `.env`, the code, `data\` and `backups\`. (`backups\` is created in the recovery steps and inherits this.)

**If `npm ci` fails** with an error that mentions `node-gyp` or Visual Studio, run `npm ci --ignore-scripts` instead (still in `C:\wa-agent`), then the `icacls` line. Nothing needs to be built on this PC: the database library (better-sqlite3 13.0.3) comes with a ready-made Windows version.

## 4. Keys and settings (admin window or waagent window)

After step 3, only an admin window or the waagent window can write under `C:\wa-agent`. Use one of them for every file edit in this runbook.

```bat
copy .env.example .env
notepad .env
```

`.env` is the settings file. Fill in these names (values stay on this PC only):

```env
ANTHROPIC_API_KEY=your_api_key_here
GOOGLE_OAUTH_CLIENT_ID=your_client_id_here
GOOGLE_OAUTH_CLIENT_SECRET=your_client_secret_here
DAILY_SPEND_CAP_USD=15
```

Leave the other lines as they are.

Reading shared files needs no extra settings: it uses the same Anthropic key and Google sign-in.

- **ANTHROPIC_API_KEY**: console.anthropic.com > API keys > Create key, named `wa-agent-office-pc`.
- **Spend limits.** `DAILY_SPEND_CAP_USD` covers the tracker's AI calls and the reading of shared images and scans. It is a *soft* cap. In rare cases (a request already running, or a backup model) the agent can go over it by a few dollars. So also set a **monthly spend limit in the Anthropic console**. That limit is the hard stop.
- **Google OAuth client** (signed in as the **mailbox** Google account):
  1. console.cloud.google.com > New project `WA Agent`.
  2. APIs & Services > Library > enable **Google Drive API**.
  3. OAuth consent screen > User type **Internal** > app name `WA Agent`. "Internal" exists only for Google Workspace accounts. **If it is greyed out, stop and ask.** A non-Internal app in Testing mode makes Google sign-ins expire every 7 days.
  4. Credentials > Create credentials > OAuth client ID > **Desktop app**. Copy the client ID and secret into `.env` right away: Google shows the secret only once. Do not leave a downloaded JSON file on the PC.
- Never share `.env` or commit it (it is already git-ignored).
- Create the allow-list file with Notepad, in an admin window or the waagent window (Explorer can save it as `.json.txt` by mistake):

```bat
notepad C:\wa-agent\config\allowed-groups.json
```

Type exactly this (an empty list, for now), and save:

```json
{ "clients": [] }
```

Do not copy `config\allowed-groups.example.json`. It is a reference only, and its placeholder group is rejected on purpose.

## 5. One-time sign-ins (as waagent)

Open a window running as the service account, so the encryption keys belong to it:

```bat
runas /user:waagent /profile "cmd /k cd /d C:\wa-agent"
```

In that new window:

```bat
npm run cli -- google-auth
npm run cli -- link
npm run cli -- list-groups
```

1. `google-auth` prints a link. Open it in a browser **on this PC**, signed in as the mailbox account, and allow access. (After you allow, Google sends the answer back to this same PC at 127.0.0.1, so a browser on another computer will not work.)
2. `link` shows a QR code. On the founder's phone: WhatsApp > Settings > Linked devices > Link a device. With an empty allow-list nothing is stored.
3. `list-groups` prints every group's id and name on screen only. In an admin window or the waagent window, open `notepad C:\wa-agent\config\allowed-groups.json` and add the 1-2 pilot groups, like this:

```json
{
  "clients": [
    { "groupId": "120363000000000001@g.us", "name": "Client name", "code": "ABC" }
  ]
}
```

Replace the `groupId` with the id from `list-groups` (the one shown above is a fake example; if you paste it unchanged the agent refuses it on purpose). Replace the name. The `code` is 3 or 4 capital letters. **Pick it carefully: it is permanent**, and task numbers are built from it (for example `ABC-012`). Each group id and each code can appear only once.

4. **Check the file was accepted.** Once the service is running (step 6), run `npm run cli -- status` and check the new client appears under **Clients**. If it does not, the change was rejected. Look in `wa-agent.out.log` for `allowed-groups.json change rejected`. Fix it now: the same file will stop the service at its next restart.

`link` and `list-groups` need the service to be stopped (the first time it is not installed yet, so that is fine). If the service is running they say: "Another WA Agent process is using this data folder. Stop it first (net stop wa-agent)."

**Optional, to load recent history for the pilot groups:** WhatsApp sends recent history only when a device is first linked. To get it:

1. Stop the service if it is running (see "Stop the service safely" below). Do the next commands in an admin window or the waagent window.
2. Copy the saved session to a backup folder (do not delete it):

```bat
mkdir C:\wa-agent\backups\2026-10-21-1430
copy C:\wa-agent\data\session.db* C:\wa-agent\backups\2026-10-21-1430\
```

   Use today's date and time in the folder name, so a second backup never overwrites the first.
3. On the founder's phone open Settings > Linked devices and remove the old "WA Agent" device.
4. Run `npm run cli -- link --reset`. It asks you to type `yes`. It deletes only the saved WhatsApp link, not your tracker data.
5. Scan the new QR code.

6. If the service is installed, **start the service again** (see *Start the service again* below). If you skip this the tracker silently stops.

This is optional. Without it the tracker starts from today. If you do it, the first service start sends that history to the AI. This costs a little and counts toward the daily spend cap. It also downloads the images and documents in that history (old ones may no longer be available on WhatsApp) and has them read: each image is described at about 1–4 US cents, and scanned PDFs are read too (see "Cost of reading files" below).

## 6. Install and start the service (admin)

1. In your normal browser, download **WinSW-x64.exe** version 2.12.0 from github.com/winsw/winsw/releases/tag/v2.12.0 to your Downloads folder. (A normal browser cannot save into the locked-down `C:\wa-agent`.)
2. In the admin window, copy it into place and install it:

```bat
copy "%USERPROFILE%\Downloads\WinSW-x64.exe" C:\wa-agent\deploy\winsw\wa-agent.exe
cd /d C:\wa-agent\deploy\winsw
wa-agent.exe install
```

3. Open `services.msc` > **WA Agent** > Log On > This account: `.\waagent` with its password. (This keeps the password out of command history and grants "Log on as a service".)
4. Lock down the data folder, then start:

```bat
icacls C:\wa-agent\data /inheritance:r /grant:r "waagent:(OI)(CI)F" "Administrators:(OI)(CI)F" "SYSTEM:(OI)(CI)F"
net start wa-agent
```

5. **Wait one minute**, then run (from the waagent window) `npm run cli -- status`. You should see `Health: ✅ Connected…` **and** the `WhatsApp:` line saying `open` (for example `WhatsApp:    open since …`). The ✅ can show while WhatsApp is still connecting, so check both. If it says `no report yet` or `has not reported since`, go to *If the service will not start* below.
6. **After `google-auth` or any change to `.env`, restart the service** so it picks the change up:

```bat
net stop wa-agent
net start wa-agent
```

   Stopping can take up to 2.5 minutes if the agent is finishing an AI call or reading a shared file. That is normal. Wait for it.

7. In Google Drive (mailbox account), share the **WA Agent** folder with team members only, never clients. Share the **folder**, not the `Tracker.xlsx` file. If the file is ever re-created, people who have the folder still reach it.

**Log files.** WinSW writes two logs in `C:\wa-agent\deploy\winsw\` (next to `wa-agent.xml`). Read them in an admin window or the waagent window:

- `wa-agent.out.log`: the normal log, and crashes while running.
- `wa-agent.err.log`: the reason the service refused to start.

### Google Drive: do not use the Bin

Do not move the "WA Agent" folder or `Tracker.xlsx` to the Bin (trash). Drive keeps accepting updates to a binned file, so the tracker would look frozen with no error.

- If it happens: restore both from the Bin.
- If the folder or file was deleted for good: the agent creates a new one on its next update. The old shared link stops working, so share the new folder again.

## 7. Pilot week

**Before the pilot starts: run the golden check again.** It sends a fixed set of sample conversations to the AI and checks its answers. It must be run again because the AI's instructions changed for shared files.

- It costs money on the Anthropic account (it does not count toward `DAILY_SPEND_CAP_USD`), so it needs the owner's approval first.
- It needs `ANTHROPIC_API_KEY` in `.env`. Run it in the waagent window or an admin window, in `C:\wa-agent`:

```bat
npm run golden
npm run golden -- --yes
```

1. The first command sends nothing. It shows how many cases there are and the most they could cost.
2. With the owner's approval, the second command runs them. It prints `PASS` or `FAIL` for each case, then the actual cost.
3. Send the output to the developer before the pilot starts.

During the pilot:

- Keep only 1-2 groups in the allow-list.
- Every day:
  - Run `npm run cli -- status`. Expect `✅` and no group with a failed batch.
  - Open `Tracker.xlsx` in Drive. Check the Overview's "Built ... IST" time is recent.
  - Check spend in the Anthropic console.
  - Compare the tracker with what the team knows. Write every mistake in a simple list: date, client, what was wrong. Send the list to the developer.
  - Open **Files received** on each pilot client's tab and check a few descriptions against the real files.
- Fix mistakes with the commands below. If the same kind of mistake repeats, report it to the developer.
- **Check that the founder never looks "online" because of the agent.** From another phone, look at the founder's WhatsApp contact while his own phone is locked. He must not show "online". If he does, stop the service and report it. The cause would be a presence update sent by the WhatsApp library (Baileys, when its credentials change); the fix is a small patch to it. This check means nothing if the founder has hidden his online status in WhatsApp privacy settings.
- A **clean week** means: no wrongly closed tasks and no missed client requests. After a clean week, add the remaining groups to `config\allowed-groups.json`. The service picks up the change within seconds; no restart needed. Run `status` and check each new client appears.

## Shared files (images and documents)

The agent saves the images and documents shared in the allowed groups and reads them, so a screenshot, a payment receipt or a PDF counts in the tracker like a message. It downloads each file once, straight from WhatsApp's servers, and never asks a phone to send a file again.

### Where the files are on this PC

In `C:\wa-agent\data\media\<CODE>\<year-month>\`, for example `C:\wa-agent\data\media\ABC\2026-10\3EB0C4F2A1-17.jpg`.

- The name is the WhatsApp message id, a dash, and the agent's own number for the file (here `17`). The number keeps every name unique. A file is never named after the name the sender gave it.
- The month is the month the message was sent, in India time.
- The agent never deletes or replaces anything in this folder.
- Do not rename, move, edit or delete files in `data\media`. The tracker records where each file is.
- To look at a file, copy it to your desktop first.
- `data\media` inherits the locked-down permissions of `data` (step 6), so there is nothing to set.

### What is read, and how

| File | What happens | Cost |
|---|---|---|
| Image or screenshot (also a JPEG, PNG, WebP or GIF photo sent "as document") | Claude writes a short English description that includes the visible text. The copy sent to Claude is shrunk, and its location data (EXIF/GPS) is removed. The saved original is unchanged. | About 1–4 US cents each |
| PDF with text | The text is read on this PC (first 200 pages). | Free |
| Scanned PDF (no text inside) | Claude reads it if it has 20 pages or fewer and is 20 MB or smaller. Longer scans are listed with their page count only. | Up to about 60 US cents for 20 pages (an estimate from the limits, not from real bills; usually less) |
| Word file (.docx) | The text is read on this PC. | Free |
| Other files (Excel, old .doc, ZIP, HEIC photos sent as a document, ...) | Saved. Only the name, type and size are used. | Free |
| Voice notes and audio files | Saved on this PC for a later update. Not transcribed, listed or uploaded yet. The AI only learns that one was sent. | Free |
| Videos | Not downloaded. The AI and Files received get the length only. | Free |
| Stickers | Not saved. | Free |
| View-once photos and videos | Never saved, listed or uploaded. | Free |

- Files larger than 50 MB are not downloaded.
- WhatsApp keeps files for a limited time. A file the agent could not fetch in time shows as "could not be downloaded from WhatsApp".
- **Forwarded files are not described.** A photo or a scanned PDF that the sender forwarded from another chat is saved, uploaded and listed, but never sent to Claude. Files received shows `(forwarded image)` or `(forwarded scanned PDF)` instead of a description. A forwarded PDF with text, or a forwarded Word file, is still read on this PC, for free.
- **Very large photos.** A very large photo sent as a document (for example a full-size photo from a 48- or 50-megapixel camera) is too big to read safely on this PC. It is saved, uploaded and listed, but not described: Files received shows `Image, could not be read`.
- Text inside files is treated like chat text: the AI is told never to follow instructions written in a file.
- Hidden characters are removed from everything the AI reads, because they can hide text. One side effect: the England, Scotland and Wales flag emoji reach the AI as a plain black flag (🏴).

### How the tracker waits for files

- The tracker reads a message together with its file. While a file is still being read, the tracker waits for it, but for 30 minutes at most, counted from when the file arrived (or from the service start, if that is later).
- After 30 minutes it goes ahead without the file. When the file is read later, the tracker looks at that message once more, now with the file, and updates the tracker from what the file adds.
- Voice notes and audio files never hold the tracker up.
- **Known limit.** If a client sends a list or brief as a photo or scan during a Claude outage or a spend-limit hold, and it is read late, new work that appears only in that file is not added as a new task. (This happens when the tracker had already made a task from that message before the file was read.) Check the tracker afterwards and add any missing work by hand. There is no `task add` command yet, so note it on the related task with `task edit <code> --latest-progress "..."`, or tell the team.

### Drive and the Files received list

- Files from people marked **Client** in the People section are uploaded to Drive, into `WA Agent > Clients > <client name> > Files`, usually within a minute or two.
  - Only images and documents are uploaded.
  - Videos are listed but not uploaded (they are not downloaded).
  - Voice notes and audio files are not listed or uploaded yet.
  - Files from the team, and from the founder's own phone, stay on this PC only.
- Each client tab lists these files under **Files received**: date, sent by, file name, description and a Drive link (`Open`). The tab shows the newest 500 files. Older ones drop off the tab but stay in Drive.
- The agent writes the description from what it read; the AI does not choose which files to list. So every client file is listed, a meme too.
- A photo without a name gets one like `image-2026-10-19-1405-17.jpg` (the date, the time and the file's number).
- If someone's role is wrong, fix it with `person set`. Their earlier files then follow the new role: once someone is a Client, their files are uploaded and listed.
- **Deleted for everyone.** A file whose message the sender deleted for everyone stays listed as `(deleted by sender)`, with no description and no Drive link. A copy already in Drive is kept. A file deleted before it reached Drive is not uploaded.
- The agent never deletes anything in Drive.
- Do not move the Files folders to the Bin. If one is deleted for good, the agent creates it again on the next upload.
- Rarely, a file shows twice in a Files folder: Drive took it, but its answer was lost on the way, so the agent uploaded it again. Nothing is lost. Leave both: the `Open` link points to one of them.

Besides a description or the start of the text, the description column can say:

| Description | Meaning |
|---|---|
| `Image, being read` | Not read yet. |
| `Image, could not be read` | Reading failed, or the photo is too large to read. The file is saved. |
| `PDF, could not be downloaded from WhatsApp` | WhatsApp no longer had the file, or refused it. |
| `PDF, 62.0 MB, too large to download (over the 50 MB limit)` | Not downloaded. |
| `PDF, 34 pages, scanned, too long to read` | A scan over 20 pages or 20 MB. Saved and uploaded, but not read. |
| `(forwarded image)`, `(forwarded scanned PDF)` | Forwarded: not sent to Claude. |
| `Image (not read: too costly for the daily limit)` | See "A very low cap" below. |
| `Video, 0:42 (not downloaded)` | Videos are listed only. |
| `(deleted by sender)` | Deleted for everyone. |

### Uploads to Drive

- One file upload may take up to 10 minutes (600 seconds), so a 50 MB file on a slow line can finish.
- A failed upload is tried again after 2, 4, 8, ... minutes, at most 6 hours apart. After 8 failed tries (about 4 hours) the agent stops trying that file until the next service start, and the status line says so. A file missing from `data\media` is given up at once.
- After a Google sign-in failure, or when the agent cannot write to its database, all uploads pause for 15 minutes, then resume by themselves. These pauses do not use up a file's tries.
- A restart gives every upload that gave up a fresh set of 8 tries, and ends a pause.

### Cost of reading files

- Reading images and scans counts toward `DAILY_SPEND_CAP_USD`, like the tracker's own AI calls.
- **Images:** about 1–4 US cents each.
- **Scanned PDFs:** while Claude reads one, it holds about $4 of today's budget. When the read ends, only its real cost is booked and the rest is freed. With the default cap of $15, a scan waits for the budget once less than about $4 is left today.
- **History from `cli link`:** the images and scans in loaded history are read too, at the same cost, after the next service start.
- **One Claude call per try.** The agent never repeats a Claude call by itself within a try, so a lost connection is paid for at most once per try. An image whose read fails is tried 3 times over about 6 minutes, then shows "could not be read". A scanned PDF whose read fails is not tried again, because a second try could be paid again.
- **Claude unavailable.** When Claude is overloaded, down, or refuses the API key, nothing is paid. The files wait and are tried again after 5, 15, 30 and 60 minutes, then every hour, for up to 24 hours (from when the file arrived, or from the service start if that is later). Only then are they given up ("could not be read").
- **Budget waits.** A file whose read does not fit in what is left of today's budget waits, and is tried again every 10 minutes. If no room opens up today, it is read after midnight India time. The tracker does not wait for it longer than the usual 30 minutes.
- **A very low cap.** If `DAILY_SPEND_CAP_USD` is below about $0.10, images are never described. Below about $4.16, scanned PDFs are never read. Such files show "not read: too costly for the daily limit", and they are not read later, even after you raise the cap.
- **A short wait for the tracker.** A tracker update can be held back while a scanned PDF is being read, because the scan's hold leaves no room for it in today's budget. It tries again after 10 minutes by itself. The status line does not change, nothing is lost, and nothing needs doing. In `status`, that client's line may show `last batch failed (spend_busy)`: this is the same short wait, not an AI error.
- **Restarting during a scan.** If the service is stopped while a scanned PDF is being read, that unfinished read is booked at its full hold (about $4) for today, and the scan is read again after the start.

### Disk space

- Expect roughly 1–3 GB per busy group per year.
- `status` shows free space, and the status line warns below 10 GB.
- Ask the developer before freeing space by moving old month folders elsewhere: the tracker records where each file is.

## Everyday commands (run in the waagent window)

| Command | What it does |
|---|---|
| `npm run cli -- status` | Connection, queued messages, failures, spend, disk, shared files |
| `npm run cli -- task close ABC-012` | Mark a task done |
| `npm run cli -- task reopen ABC-012` | Reopen a task |
| `npm run cli -- task unlock ABC-012` | Hand the task back to the AI after a manual fix |
| `npm run cli -- task edit ABC-012 --deadline 2026-10-25` | Change a field (`none` clears it) |
| `npm run cli -- person set 919800000002 team` | Fix someone's role |
| `npm run cli -- phase set ABC Development` | Set a client's phase |
| `npm run cli -- phase unlock ABC` | Hand the phase back to the AI |
| `npm run cli -- rebuild` | Republish the workbook now |
| `npm run cli -- reprocess ABC --since 2026-10-15` | Re-run the AI over recent messages |

Notes:

- **`status`** also prints a `Files:` line, for example:

  ```text
  Files:       2 waiting to be read · 1 could not be read (24 h) · 0 not uploaded to Drive
  ```

  - *waiting to be read*: files not read yet (still downloading, waiting for Claude, or waiting for the daily budget).
  - *could not be read (24 h)*: files given up in the last 24 hours. Files received shows them as "could not be read". Files that could not be downloaded from WhatsApp are not counted here.
  - *not uploaded to Drive*: uploads that gave up (see "Status "files could not be uploaded to Drive"" below).
  - The counts leave out clients removed from the allow-list. Their files wait, untouched, until the client is added back.
- **`task edit`** options: `--title`, `--side` (us or client), `--category` (design, development, content, payment, approval, other), `--priority` (high, medium, low), `--assigned-to`, `--asked-by`, `--deadline` (YYYY-MM-DD or `none`), `--latest-progress`. Fields you fix by hand stay fixed until you run `task unlock`.
- **`person set <number> <team|client>`**: use the full number with country code and no `+` or spaces (for example `919812345678`). A WhatsApp id (it contains `@`) also works. People who show no number in the People section cannot be fixed with `person set` yet. Add `--client ABC` to change the role in one client group only.
- **`task unlock`** and **`phase unlock`** let the AI change that task or phase again.
- **`rebuild`** shows up in Drive within about a minute (a 30-second check, then a 60-second upload wait).
- **`reprocess <client> --since <date> [--until <date>]`** sends old messages to the AI again. This **costs money** and counts toward the daily cap, so keep the date range short. Above 200 messages it only shows the count and the most it could cost; add `--yes` to run it. It will not re-create tasks you closed, and it will not count decisions or reminders twice from the same message.
- **Limit of `reprocess`:** it cannot add a missed second task from a message that already produced a task (or that already counted as a reminder or an update on a task). If the AI missed a second piece of work in an old message, add a note to an existing task with `task edit <code> --latest-progress "..."`, or tell the team. There is no "task add" command yet.

## What the status line means

In `npm run cli -- status` it appears as the `Health:` line. It is also the first line on the Overview tab. The Google sign-in and Tracker update lines are never shown in the workbook, because the workbook cannot upload while those are failing; look at `status` instead. If several things are wrong at once, the line shows the most serious one.

| What you see | What it means | What to do |
|---|---|---|
| Connected, last update (time) | All good. | Nothing. |
| Connected, waiting for new messages | All good, no messages processed yet since the start. | Nothing. |
| WhatsApp unlinked since (time). Follow docs/SETUP.md → "Status logged_out" | The founder removed the linked device, or WhatsApp logged it out. | Follow "Status logged_out" below: stop the service safely and back up the session before linking again. |
| Another copy of WA Agent took over the WhatsApp session | Another copy of the agent, or WhatsApp Web on another computer, took the linked-device slot. | Follow "Status replaced" below. Do **not** reset the link. |
| WhatsApp refused this number (403) | WhatsApp blocked this device. | Look at the founder's phone for a WhatsApp warning. Do not reset the link. |
| Disconnected since (time) | No WhatsApp connection for over 30 minutes. | Check the PC's internet. The agent keeps trying to reconnect. If it stays down, restart the service. |
| Google sign-in expired | Drive no longer lets the agent in. File uploads to Drive pause too. | Run `npm run cli -- google-auth`, then restart the service. |
| The WhatsApp session could not be saved | The agent cannot write its session to disk. | Check free disk space and the permissions on `C:\wa-agent\data`. |
| (number) incoming messages could not be saved | Some WhatsApp messages from the client groups could not be stored, so they are **lost from the tracker**. The count is since the service last started (a restart clears the warning); `status` also shows `Messages not saved: (number)`. | Read `wa-agent.out.log` (look for `ingest failed`). Check those groups on the founder's phone and add anything important by hand (`task edit`, or tell the team). Then check free disk space and the permissions on `C:\wa-agent\data`. |
| Tracker update failing since (time) | The Excel file has not reached Drive for over an hour. | Check the PC's internet. If it stays, read `wa-agent.out.log`. |
| Daily spend cap reached. Paused until midnight IST | The AI budget for today is used up. Messages and shared files are saved and processed later. | Wait for midnight India time. Raise `DAILY_SPEND_CAP_USD` in `.env` and restart the service only if the higher spend is intended. |
| (number) groups waiting (AI error) | The AI call failed for some groups. Nothing is lost. | Wait: failed batches retry every hour. If it persists, read `wa-agent.out.log` and run `status`. |
| (number) shared files waiting over 30 minutes to be read. See docs/SETUP.md. | Images or documents are still not read 30 minutes after they arrived. The tracker went ahead without them. Nothing is lost. | See "Status "shared files waiting over 30 minutes to be read"" below. |
| (number) files could not be uploaded to Drive. See docs/SETUP.md. | Files from clients failed to upload many times, and the agent stopped trying. They are safe on this PC. | See "Status "files could not be uploaded to Drive"" below. |
| (number) shared files waiting for today's AI budget (read after midnight IST) | Images or scans that need Claude do not fit in what is left of today's budget (a scan needs about $4 of room). The cap is not reached, and the tracker keeps working. | Nothing: they are tried every 10 minutes and read once there is room, at the latest after midnight India time. See "Spend cap and shared files" below. |
| Low disk: (number) GB free | Under 10 GB left. | Free up disk space. |

### Status "shared files waiting over 30 minutes to be read"

The line reads, for example, `⚠️ 3 shared files waiting over 30 minutes to be read. See docs/SETUP.md.` (or `1 shared file` for one).

- **Meaning:** some images or documents from the client groups are still not read 30 minutes after they arrived (or after the service started). The tracker did not wait for them. It went ahead with the messages, and it looks at those messages again once their files are read. Nothing is lost.
- **Usual causes:** Claude is overloaded or down, or refuses the API key; the PC's internet is down; or many files arrived at once (for example right after loading history).
- **What to check:**
  1. The PC's internet.
  2. `wa-agent.out.log` (in an admin window or the waagent window): look at the recent lines with `shared file`. `Claude unavailable: shared file waits` means Claude is busy or down, or refused the key. Check that the key still exists in console.anthropic.com > API keys.
  3. `npm run cli -- status`: the `Files:` line shows how many are still waiting.
- **When it clears:** by itself, once the files are read. While Claude is unavailable, the files are tried again for up to 24 hours, at no cost. After that they are given up, `status` counts them under "could not be read", and the warning clears.
- A restart starts the 30 minutes again, so it hides the warning for 30 minutes but fixes nothing.
- If Claude itself is down, the line usually shows `groups waiting (AI error)` instead, because that one ranks higher.
- For a file that was given up, Files received says "could not be read". Copy the original from `data\media` to your desktop, look at it, and add what matters by hand.

### Status "files could not be uploaded to Drive"

The line reads, for example, `⚠️ 2 files could not be uploaded to Drive. See docs/SETUP.md.` (or `1 file` for one).

- **Meaning:** some files that clients sent failed to upload to Drive 8 times (over about 4 hours), or the saved file is missing from `data\media`, and the agent stopped trying. The files are safe on this PC. Files received lists them without a Drive link.
- **What to check:**
  1. The PC's internet.
  2. The Google sign-in: run `npm run cli -- status`. If it shows `Google sign-in expired` or a `Drive:` line saying `failing since`, run `npm run cli -- google-auth`.
  3. `wa-agent.out.log`: look for lines with `file upload`.
  4. That the **WA Agent** folder and the client's **Files** folder are not in the Drive Bin.
  5. That nobody moved or deleted files in `C:\wa-agent\data\media`.
- **When it clears:** restart the service after the fix (`net stop wa-agent`, then `net start wa-agent`). A restart gives these files a fresh set of 8 tries, so the warning clears at once. It comes back only if they fail again.
- The warning also stops counting a file whose sender is no longer marked Client, or whose message was deleted for everyone: such a file is not uploaded.

### Spend cap and shared files

- When today's spend reaches `DAILY_SPEND_CAP_USD`, the line says `Daily spend cap reached. Paused until midnight IST`. This covers shared files too: the files that need Claude wait, and are read after midnight India time.
- A file can wait for the budget before the cap is reached, because a scanned PDF needs about $4 of room. The line then says `(number) shared files waiting for today's AI budget (read after midnight IST)`. It ranks below the other file and group warnings, so it never hides a more urgent problem.
- Either way, the tracker does not wait more than 30 minutes for a file, and it keeps reading messages as long as there is budget for them.

## If the service will not start

When the agent refuses to start it exits, and WinSW tries again every minute or so. So `net stop` alone may not hold it down. Use the two procedures below around every fix.

A config error (for example a mistake in `allowed-groups.json` or `.env`) exits with code 1. A refusal (for example WhatsApp not linked, Google not connected, or another copy running) exits with code 2. Either way WinSW restarts the service, and `wa-agent.err.log` shows one line saying why.

**Stop the service safely**

1. `services.msc` > **WA Agent** > Properties > Startup type: **Disabled** > Apply > **Stop**.

**Start the service again**

1. `services.msc` > **WA Agent** > Properties > Startup type: **Automatic (Delayed Start)** > Apply > **Start**.
2. Wait one minute, then run `npm run cli -- status` and expect `Health: ✅ Connected…` and the `WhatsApp:` line saying `open`.

To find the problem, open (in an admin window or the waagent window) `C:\wa-agent\deploy\winsw\wa-agent.err.log` and read the last line. (`status` cannot show it, because the service stops before it writes a report.) Config errors there start with `Error: `, for example `Error: allowed-groups.json is not valid JSON`. Then find the problem in this table or the sections below.

| Last line of `wa-agent.err.log` | What it means | What to do |
|---|---|---|
| `allowed-groups.json is not valid JSON` or `allowed-groups.json is invalid: ...` | The allow-list file has a typing mistake (a missing comma or quote, a bad group id, or a code that is not 3-4 capital letters). | Stop safely. In an admin window or the waagent window, open `notepad C:\wa-agent\config\allowed-groups.json`, fix the problem it names, start again. |
| `allowed-groups.json still contains the example group...` | The example group id was left in. | Replace it with a real id from `list-groups`, or set the file to `{ "clients": [] }`. Stop safely first, start again after. |
| `Client codes are permanent because task IDs use them. Keep code X for ...` | A client's code was changed in the file. | Stop safely. Put the old code back (the message names it). Start again. |
| `Code X is already used by ... Pick a different code.` | Two clients share one code. | Stop safely. Give one of them a different code. Start again. |
| `Allow-list file missing...` | `config\allowed-groups.json` does not exist. | Create it as in step 4 (`{ "clients": [] }`), then run `npm run cli -- list-groups` and add your client groups (step 5). |
| `X is not configured` (X is a name such as ANTHROPIC_API_KEY) | A required setting is empty or missing in `.env`. | Stop safely. In an admin window or the waagent window, open `notepad C:\wa-agent\.env`, fill in that setting, start again. |
| `Invalid configuration in: ...` | The named settings in `.env` have bad values (for example text where a number is needed). | Stop safely. Fix those settings in `.env` (compare with `.env.example`), start again. |
| `WhatsApp is not linked. Stop the service and run: npm run cli -- link` | No saved WhatsApp link. | Stop safely, run `npm run cli -- link` in the waagent window, scan the QR code, start again. |
| `Google Drive is not connected. Run: npm run cli -- google-auth` | No saved Google sign-in. | Run `npm run cli -- google-auth`, then start again. |
| `Another WA Agent process is using this data folder...` | Another copy is running (or the service was started twice). | Find and stop the other copy. Do not delete anything. |
| `MASTER_KEY_UNREADABLE: ...` | See below. | See below. |
| `MASTER_KEY_CREATE_FAILED: The master key could not be created.` | The agent could not write its key file. | Check that the waagent account can write to `C:\wa-agent\data\keys` (step 3 and step 6 permissions) and that the disk is not full. Then start again. |
| `The WhatsApp session could not be decrypted with the current master key...` | See below. | See below. |
| `Stored Google sign-in cannot be read` | See below. | See below. |
| `services.msc` shows a log-on failure (error 1069) | The waagent password stored in the service is out of date or wrong. | `services.msc` > **WA Agent** > Log On tab > re-enter waagent's current password > Apply > start the service. |

### MASTER_KEY_UNREADABLE

- **Meaning:** the agent cannot read its master key (the key that protects the WhatsApp session and the Google sign-in). Usually an admin reset the waagent account or its password, or the key file was copied from another PC.
- **What to do:**
  1. **Stop the service safely** (see above).
  2. Read the last line of `wa-agent.err.log` to confirm the code.
  3. (Admin window or waagent window.) Only after checking with the person responsible, **move** (do not delete) the key and the session to a dated backup folder. Use today's date and time. Move all three `session.db` files together:

```bat
mkdir C:\wa-agent\backups\2026-10-21-1430
move C:\wa-agent\data\keys\master.key.dpapi C:\wa-agent\backups\2026-10-21-1430\
move C:\wa-agent\data\session.db* C:\wa-agent\backups\2026-10-21-1430\
```

  4. On the founder's phone, remove the old "WA Agent" device first (Settings > Linked devices). After the move, `link --reset` will say "No saved WhatsApp link to reset" and skip its question, so it will not remind you.
  5. In the waagent window, link WhatsApp again: `npm run cli -- link` If it says a link is already saved, stop: step 3 did not move the session. Re-check it before going on.
  6. Sign in to Google again: `npm run cli -- google-auth`.
  7. **Start the service again** (see above).
- **Result:** the tracker database is kept. Only the WhatsApp link and the Google sign-in are recreated.

### "The WhatsApp session could not be decrypted with the current master key" (SessionDecryptError)

- **Meaning:** the saved WhatsApp session was locked with a different master key.
- **What to do:** this does **not** mean moving the master key (that would also break the saved Google sign-in).
  1. **Stop the service safely** (see above).
  2. Back up the old session (copy, do not delete), in an admin window or the waagent window:

```bat
mkdir C:\wa-agent\backups\2026-10-21-1430
copy C:\wa-agent\data\session.db* C:\wa-agent\backups\2026-10-21-1430\
```

  3. On the founder's phone, remove the old "WA Agent" device (Settings > Linked devices).
  4. In the waagent window: `npm run cli -- link --reset` (type `yes`), then scan the new QR code.
  5. **Start the service again** (see above).

### "Stored Google sign-in cannot be read" (TokenDecryptError)

- **Meaning:** the saved Google sign-in was locked with a different master key.
- **What to do:** **stop the service safely**, run `npm run cli -- google-auth` again, then **start the service again**. Nothing else is lost.

### Status "replaced"

- **Meaning:** another copy of the agent, or WhatsApp Web on another computer, took over the linked-device slot.
- **What to do:** find and stop the other copy, **then restart the service**. It does not reconnect by itself. **Do not reset the session**: that does not help and forces a new QR scan.

### Status "logged_out"

- **Meaning:** the founder removed the linked device from his phone.
- **What to do:**
  1. **Stop the service safely** (see above).
  2. Copy the old session to a backup folder, as in the SessionDecryptError steps.
  3. On the founder's phone, remove the old "WA Agent" device if it is still listed.
  4. In the waagent window: `npm run cli -- link --reset` (type `yes`), then scan the QR code.
  5. **Start the service again** (see above).
