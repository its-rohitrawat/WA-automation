# WA Agent: office PC setup and pilot

**On a Mac?** Start with [SETUP-mac.md](SETUP-mac.md) instead; it points back here for everything after setup.

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
2. `link` shows a QR code. On the founder's phone: WhatsApp > Settings > Linked devices > Link a device. The phone then lists this link as "WA Agent - Tracker". With an empty allow-list nothing is stored.
3. `list-groups` prints every group's id and name on screen only. (With the owner dashboard on, you can choose the groups there instead: see "Choosing client groups in the dashboard" under "Owner dashboard".) In an admin window or the waagent window, open `notepad C:\wa-agent\config\allowed-groups.json` and add the 1-2 pilot groups, like this:

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
3. On the founder's phone open Settings > Linked devices and remove the old "WA Agent - Tracker" device (a link made before this name was added shows as "Windows").
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
| Voice notes and audio files | Saved on this PC. When voice notes are switched on, each one is turned into text (transcribed), and the AI reads the text like a message. While they are off, the AI only learns that one was sent. Never listed or uploaded. See "Voice notes" below. | Free with the local engine (recommended) |
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
- Voice notes and audio files are waited for in the same way while voice notes are switched on: up to 30 minutes for the text, then a second look at the message when the text arrives. While voice notes are off, they never hold the tracker up.
- **Known limit.** If a client sends a list or brief as a photo, a scan or a voice note during a Claude outage, a spend-limit hold or a slow transcription, and it is read late, new work that appears only in that file is not added as a new task. (This happens when the tracker had already made a task from that message before the file was read.) Check the tracker afterwards and add any missing work by hand. There is no `task add` command yet, so note it on the related task with `task edit <code> --latest-progress "..."`, or tell the team.

### Drive and the Files received list

- Files from people marked **Client** in the People section are uploaded to Drive, into `WA Agent > Clients > <client name> > Files`, usually within a minute or two.
  - Only images and documents are uploaded.
  - Videos are listed but not uploaded (they are not downloaded).
  - Voice notes and audio files are not listed or uploaded. They stay on this PC only, even when they are transcribed.
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

## Morning report

Monday to Friday at 06:00 IST, the founder gets one short WhatsApp message from a **spare number** the business owns, with the totals of the active clients and a link to the tracker on Google Drive, for example:

`Good morning. 5 open tasks, 2 overdue. Today's tracker: https://drive.google.com/file/d/…/view`

With no active clients it reads `Good morning. No open tasks. Today's tracker: …`; with active clients and nothing open it reads `Good morning. 0 open tasks, 0 overdue. Today's tracker: …`. No file is attached: the link opens `Tracker.xlsx` on its **Today** tab (the first tab), which lists, per active client, how many tasks are open and overdue and the 3 most urgent open tasks (tagged `us` or `client`). It makes no AI call, so it costs nothing.

- No report goes out on Saturday or Sunday. `REPORT_DAYS` changes the days (see step 4 below). `report send-now` still works on any day.
- The founder needs view access to `Tracker.xlsx` on Drive, or the link asks for access (step 6 below).
- The link exists only once the tracker has reached Google Drive. Until then the report is not sent, and the status says why (see "Checking it" below).
- The founder's own number is unchanged: the agent still only reads it and never sends from it.
- The spare number sends only to `REPORT_RECIPIENT`. It reads no chats, sends no read receipts, and is online only for the minute it takes to send.
- If the PC is off or offline at 06:00, the report goes as soon as possible, but only until 12:00 IST. After that the day is skipped.
- It is never sent twice on one day.

### Setup (about 15 minutes)

1. Put the spare SIM in a spare phone and install WhatsApp on it.
2. From the founder's phone, send the spare number one message ("hi"), so it is a known chat.
3. Stop the service safely (see "Stop the service safely" under "If the service will not start" below). Then, in the waagent window:

   ```bat
   npm run cli -- link-sender
   ```

   Scan the QR code from the **spare** phone (WhatsApp > Linked devices > Link a device), not from the founder's phone. The spare phone then lists this link as "WA Agent - Morning report".
4. In `.env`, set:

   ```env
   REPORT_ENABLED=true
   REPORT_RECIPIENT=your_founder_number_here
   ```

   `REPORT_RECIPIENT` is the founder's Indian mobile: `91` then the 10-digit mobile number (12 digits in all), digits only, for example `919812345678`, with no `+` or spaces. The service refuses to start with any other form. Leave `REPORT_TIME`, `REPORT_DEADLINE` and `REPORT_DAYS` empty for 06:00 and 12:00 IST, Monday to Friday. Set `REPORT_DAYS=mon-sat` to add Saturday, or `REPORT_DAYS=daily` for every day.
5. **Start the service again** (see "Start the service again" under "If the service will not start" below), wait one minute, and check `npm run cli -- report status`.
6. Give the founder view access to `Tracker.xlsx`, or the link asks for access when he opens it. In Google Drive (mailbox account), share the **WA Agent** folder with the founder's Google account (the one signed in on his phone), as Viewer. Sharing the folder, not the file, keeps it working if the file is ever re-created (see step 7 of "6. Install and start the service").
7. Send one test report: `npm run cli -- report send-now`, then type `yes`. It works only while the service is running, on any day, weekends too, and it refuses if today's report was already sent. Check the founder's phone, and open the link once.
   If you change `REPORT_RECIPIENT` later, restart the service: until then `report status` warns that the running service still sends to the old number, and `report send-now` refuses.
8. Open WhatsApp on the spare phone at least every 14 days, so the linked device stays valid.

The spare number's session is in `C:\wa-agent\data\sender-session.db`. It is encrypted with its own key, derived from the same master key. Back it up with the rest of `data`.

### Checking it

`npm run cli -- report status` shows today's state and the last 7 days, for example:

```text
Morning report: on, 06:00 to 12:00 IST, to the number ending …5678
Today (2026-10-23): Morning report: sent at 06:00 IST
Last days:
  2026-10-22  sent    at 06:00 IST
  2026-10-21  skipped could not connect to WhatsApp
```

`npm run cli -- status` shows the same line as `Report:`.

What the line can say (HH:MM is a time in IST):

| What you see | What it means | What to do |
|---|---|---|
| Morning report: due at 06:00 IST | A report day, before 06:00. | Nothing. |
| Morning report: due now | Between 06:00 and 12:00, not sent yet. It goes on the next check (every 30 seconds). | Nothing. |
| Morning report: sent at HH:MM IST | Today's message left. | Nothing. |
| Morning report: sending now | The send is running. | Nothing. |
| Morning report: no report today (weekend) | Saturday or Sunday, and `REPORT_DAYS` leaves the day out. No scheduled report is sent or skipped (a `report send-now` that fails is still retried until 12:00). | Nothing. `report send-now` still sends one if you want it. |
| Morning report: not sent yet (the tracker is not on Google Drive yet (run google-auth and let it upload once)), next try HH:MM IST | The tracker has never reached Google Drive, so there is no link to send. Nothing was sent. | If Google was never signed in, run `npm run cli -- google-auth` (see "5. One-time sign-ins"), then restart the service. If Google is already signed in, check the `Health:` line in `npm run cli -- status` for `Tracker update failing` or `Google sign-in expired` and follow that row in "What the status line means". Once `Tracker.xlsx` is in the **WA Agent** folder on Drive, the report goes on the next try. |
| Morning report skipped today (the tracker is not on Google Drive yet (run google-auth and let it upload once)) | 12:00 came and there was still no link, so the day was skipped. Nothing was sent. | Same as above; tomorrow's report goes once the tracker is on Drive. |
| Morning report: not sent yet (reason), next try HH:MM IST | Another definite failure, nothing was sent. It tries again after 2, 5 and 10 minutes, until 12:00. A failure before 06:00 (from `report send-now`) waits until 06:00 for its next try. | Usually nothing. If it says the spare number, see the status headings below. |
| Morning report: not sent yet (reason); no more tries today, it will be skipped at 12:00 IST | A definite failure too close to 12:00 for another try (the next try would fall after 12:00). Nothing was sent. | Nothing; the day is skipped at 12:00. Tomorrow's report is not affected. |
| Morning report skipped today (reason) | Not sent by 12:00 (for example the PC was off). | Check the reason. Tomorrow's report is not affected. |
| Morning report: unknown, check WhatsApp | See the next heading. | See the next heading. |
| Morning report: off | `REPORT_ENABLED` is not `true`. | See "Turning it off" below. |

### Status "Morning report: unknown, check WhatsApp"

The send started but did not finish cleanly (a timeout, the service stopped mid-send, or the result could not be saved and the send has said nothing for over 10 minutes). The report may or may not have reached the founder, so the agent does **not** try again by itself.

1. Look at the founder's WhatsApp, in the chat with the spare number.
2. If today's report is not there, run `npm run cli -- report send-now` and type `yes`.
3. If it is there, do nothing. The warning clears the next day.

### Status "Morning report: the spare number is not linked" (or logged out, refused, taken over, or its session cannot be read or opened)

- **Not linked:** stop the service safely, run `npm run cli -- link-sender` in the waagent window, scan from the spare phone, then start the service again (both steps are under "If the service will not start" below).
- **Logged out** (the device was removed on the spare phone, or the phone was not opened for weeks):
  1. **Stop the service safely** (see "If the service will not start" below).
  2. Copy (do not delete) the spare number's old session to a dated backup folder (use today's date and time):

     ```bat
     mkdir C:\wa-agent\backups\2026-10-21-1430
     copy C:\wa-agent\data\sender-session.db* C:\wa-agent\backups\2026-10-21-1430\
     ```

  3. On the spare phone, remove any old "WA Agent - Morning report" device.
  4. In the waagent window, run `npm run cli -- link-sender --reset` (type `yes`), and scan from the spare phone.
  5. **Start the service again**. The founder's link and the tracker are not touched.
- **"the spare number's saved session cannot be read"**: the file `sender-session.db` was written with a different master key, or it is damaged.
  1. **Stop the service safely** (see "If the service will not start" below).
  2. Copy (do not delete) the spare number's session to a dated backup folder (use today's date and time). If the right master key comes back later, this copy can be read again:

     ```bat
     mkdir C:\wa-agent\backups\2026-10-21-1430
     copy C:\wa-agent\data\sender-session.db* C:\wa-agent\backups\2026-10-21-1430\
     ```

  3. In the waagent window, run `npm run cli -- link-sender --reset`. It asks you to type `yes`, both when the file was written with a different master key and when it is damaged. Type it, then scan from the spare phone. A damaged file is renamed to `sender-session.db.damaged-<date-time>` (with its `-wal` and `-shm` files), not deleted. Only the `sender-session.db` files are touched: the founder's `session.db` files stay where they are.
  4. If it stops without asking for `yes`, nothing is wrong with the session file. Do not move any files in any of these cases:
     - `Another WA Agent process is using this data folder...`: the service is still running. Go back to step 1.
     - A `MASTER_KEY_...` error: run it in the waagent window, not an admin window. If it still appears there, see "MASTER_KEY_UNREADABLE" below.
     - Any other error: write down the message and ask the developer.
  5. **Start the service again** (see "If the service will not start" below). The founder's link and the tracker are not touched.

  The `sender-session.db.damaged-…` files in `C:\wa-agent\data` can be deleted (or moved to the backup folder) once the new link works and `report status` is clean.
- **"the sender is linked to the founder's own number"** (the `link-sender` QR code was scanned with the founder's phone: the number in `REPORT_RECIPIENT`, or the number the tracker reads; the agent never sends from either):
  1. **Stop the service safely** (see "If the service will not start" below).
  2. Remove the "WA Agent - Morning report" device from the founder's phone (Settings > Linked devices). Keep "WA Agent - Tracker", which the tracker uses.
  3. In the waagent window, run `npm run cli -- link-sender --reset` (type `yes`), and scan from the **spare** phone.
  4. **Start the service again**. The founder's tracker link and the tracker data are not touched.
- **Refused (403) or banned:** check the spare phone for a WhatsApp warning. A 403 can be a temporary restriction. To move to a new spare number:
  1. **Stop the service safely** (see "If the service will not start" below).
  2. Copy (do not delete) the spare number's session to a dated backup folder (use today's date and time):

     ```bat
     mkdir C:\wa-agent\backups\2026-10-21-1430
     copy C:\wa-agent\data\sender-session.db* C:\wa-agent\backups\2026-10-21-1430\
     ```

  3. Repeat the setup from step 1 with the new SIM, but run `npm run cli -- link-sender --reset` (type `yes`) instead of `link-sender`, and scan from the new spare phone.
- **"the spare number's session file could not be opened"** (a lock, a permissions problem or a disk error when the service started; the file is not known to be damaged): restart the service. Do **not** run `link-sender --reset` for this. If it keeps happening, check that the disk has free space and that no other program has `C:\wa-agent\data\sender-session.db` open, then ask the developer.
- **Replaced:** ("another session took over the spare number") restart the service. If it keeps happening, make sure no other copy of the agent (another PC, or a copy of the data folder) uses the spare number, and that no WhatsApp Web session of the spare number is open elsewhere.

The tracker keeps working in every case; only the morning report is skipped.

### Turning it off

Set `REPORT_ENABLED=false` (or leave it empty) in `.env`, then restart the service.

## Owner dashboard

The owner dashboard and the website run on the office Mac only. Set them up with [SETUP-mac.md](SETUP-mac.md), section 10 "Owner dashboard", then [GO-LIVE.md](GO-LIVE.md) for the company domain. From that update on, the update step must run `npm ci` after pulling.

With the dashboard on, the service also starts when WhatsApp or Google is not linked yet (**setup mode**): the Overview then shows what to link, and you link it from the dashboard. With the dashboard off, a missing link still stops the service, as before.

### Choosing client groups in the dashboard

With the dashboard on, this replaces editing `allowed-groups.json` by hand (step 5).

1. Open **Clients → Manage groups**. It lists every WhatsApp group the founder's phone is in. Search by name.
2. To start tracking a group, press **Approve** (on a computer you can also drag it to the right; on a phone, switch it on). A panel opens:
   - **Client name**: filled in from the group name; change it if needed.
   - **Code**: 3–4 capital letters, suggested for you. Every task number starts with it (for example `SHA-001`). **Pick it carefully: it can't be changed once the client has tasks.** A group that was a client before keeps its old code.
   - **More: meeting matching** (optional): the same meeting keywords and email domains as in "Meeting summaries" below.
3. Changes wait in a bar at the bottom ("1 change not saved"). Press **Save**: "Saved. The agent picks up the new groups within 2 seconds." No restart is needed. If a change is refused (for example a code already in use), the panel of that group opens and says why.
4. To stop tracking a group, press **Remove** and **Save**. Nothing is deleted: its tasks are kept, and approving it again later brings it back with the same code.

Every saved change is recorded in **Audit logs**. The dashboard writes the same `config/allowed-groups.json` file, so `npm run cli -- status` shows the new clients as before.

**Earlier messages of an approved group.** When a group is approved (new, or approved again; in the dashboard or by hand), the agent also reads its earlier messages, **up to 7 days back, as far as WhatsApp provides**: WhatsApp may not hand over every old message, so some can be missing. It works like this:

- It asks the founder's phone for them, starting from a message of that group the agent already has. If it has none yet, it waits for the first new message in the group, and the client card and its panel say so ("Waiting for the first new message to read earlier ones").
- It reads only while the founder's WhatsApp is connected. Removing the group stops it. After a restart it carries on where it stopped.
- The earlier messages go through the tracker like new ones, by their real times; a message read twice is kept once. While they are being read (a few minutes at most), the group's new messages wait, so old and new are read together, in order. The AI work on them is within the daily spend cap: if the cap is reached, the reading pauses and carries on the next day.
- While it reads, the client card in **Clients** and its panel say "Reading the last 7 days · <n> found". Afterwards the panel's **Earlier messages** row says "Last 7 days read · <n> found". **Activity** gets one line per group when it is done, "<n> earlier messages read", with the count and no message text.

When WhatsApp is not connected, the page shows the last list it had ("WhatsApp isn't connected") and you can still approve from it.

**Fallback, when the dashboard can't be reached:** edit `allowed-groups.json` by hand as in step 5 (`list-groups`, then the file). Do not edit the file by hand while someone saves in the dashboard.

### Fixing a connection in the dashboard

With the dashboard on, start here when a connection is down. The **Overview** shows a banner naming the part that needs you; **Fix now** opens it on **Connections**, which has one card per connection:

| Card | Button | What happens |
|---|---|---|
| Founder WhatsApp | **Reconnect** | A QR code appears. On the founder's phone: WhatsApp > Settings > Linked devices > Link a device, and scan it. The tracker carries on with the new link; the service does not need to be stopped. |
| Spare WhatsApp (morning report) | **Link phone** | The same, scanned from the **spare** phone. Never scan it with the founder's phone: the agent refuses to send from the founder's own number. |
| Google | **Reconnect**, or **Add Google account** | Google's sign-in opens. Sign in with that account and allow access; you come back to Connections. |
| Tracker on Drive | **Upload tracker now** | Uploads the tracker at once. The card also says which file it writes and which Google account that file belongs to. |
| Claude | **Test connection** | Checks the AI key works. It costs nothing. |
| Monitoring | **Send test beat** | Sends one heartbeat to UptimeRobot. |

A link stops by itself after 5 minutes without a scan, and **Cancel** puts back the link that was there before. Every reconnect is recorded in **Audit logs**. Once the company address is set up ([GO-LIVE.md](GO-LIVE.md)), do Google's **Reconnect** from the dashboard at that address, not from `localhost`.

**Which Google account is which.** Each Google card shows the account's email address and what it is used for (the tracker on Drive, meetings), with its label in small text below. An account connected before this version (with `npm run cli -- google-auth`) shows its email once the agent has looked it up; if the card says the email is not known yet, press **Reconnect** on it and sign in with the same account. The email is shown on the dashboard only; logs and **Audit logs** keep it masked.

**Fallback, when the dashboard can't be reached:** the commands in this guide still work: `npm run cli -- link` (founder), `npm run cli -- link-sender` (spare phone) and `npm run cli -- google-auth` (Google), each as described in its section. `link` and `link-sender` need the service stopped first; after `google-auth`, restart the service.

### Keeping the tracker up to date

The tracker updates by itself after the agent reads new messages. To update it at once, press the Sync tracker button at the top of **Clients** (or in a client's panel); it does the same as **Upload tracker now** on Connections. Next to the button is the time of the last update. Pressed too many times in a minute, it asks you to wait a moment.

The agent always writes one tracker file, `Tracker.xlsx` in the `WA Agent` folder on Drive. The **Tracker** screen and the Drive card on **Connections** show which file it is, its folder, the Google account it belongs to, when it was last uploaded, and a link to open it in Drive.

**If a new tracker file appears.** The agent makes a new `Tracker.xlsx` only when it can no longer reach the old one. That almost always means the Google login changed: another Google account, or another Google Cloud project, was connected. The **Tracker** screen then says once that a new tracker file was started, and **Audit logs** has a line for it. Either:

- **Go back to the old file:** on **Connections**, press **Reconnect** on the Google card and sign in with the account that owns the old file (Drive shows a file's owner in its details). Then check on the **Tracker** screen which file it writes.
- **Keep the new file:** do nothing. The agent goes on with it, and the old file stays in Drive as it was.

### The AI assistant

The **Ask** button at the bottom right of every dashboard screen opens the assistant: a panel at the side on a laptop, the whole screen on a phone. Type a question, or pick one of the suggestions.

- **It answers** questions about clients, tasks, messages, meetings, AI spend and the agent's health, from the same data the screens show. It can summarise today, say what needs your attention, explain a number, find a message, summarise a meeting, and draft a reply as text for you to copy. **It never sends a WhatsApp message.**
- **It opens screens.** "Show Acme's overdue tasks" opens Tasks with those filters.
- **It drafts changes, and you decide.** It can change a task's status, assignee, deadline or priority, add a task, or change a morning briefing setting. Each change shows as a card with **Confirm** and **Cancel**. Nothing changes until you press **Confirm**. A card waits 10 minutes, and runs once. The change goes through the same checks as the screens, and **Audit logs** shows it with "via assistant". The founder's number is changed only on **Automations**.
- **Cost.** Each answer is a Claude call, shown under it ("≈ $0.03"). It counts toward the daily AI cap (`DAILY_SPEND_CAP_USD`), and **AI usage** lists it as "Dashboard assistant". A typical question costs a few US cents. At the cap, the assistant pauses until the next day. It uses the same model and effort as the agent (`AI_MODEL`, `AI_EFFORT`). You can ask up to 30 questions an hour.
- **Privacy.** It never sees phone numbers or WhatsApp ids. What clients write is treated as data, never as instructions: a message cannot make it change anything. The chat stays in the agent's memory only, and is gone when you press **New chat**, sign out, or leave it for two hours. Questions and answers are never written to the logs.
- **To switch it off,** set `DASHBOARD_ASSISTANT=false` in `.env` and restart the service.

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
| `npm run cli -- report status` | Today's morning report and the last 7 days |
| `npm run cli -- report send-now` | Send today's morning report now (asks first; refuses if already sent) |
| `npm run cli -- link-sender` | Link the spare number for the morning report (stop the service first) |
| `npm run cli -- transcribe-voice` | Count the voice notes saved earlier without a transcript; add `--yes` to transcribe them (see "Voice notes") |
| `npm run cli -- transcribe-voice --failed` | Count the voice notes that could not be transcribed on this computer (`VOICE_STT_PROVIDER=local` only); add `--yes` to try them again (see "Voice notes") |

Notes:

- **`status`** also prints a `Files:` line, for example:

  ```text
  Files:       2 waiting to be read · 1 could not be read (24 h) · 0 not uploaded to Drive
  ```

  - *waiting to be read*: files not read yet (still downloading, waiting for Claude, or waiting for the daily budget).
  - *could not be read (24 h)*: files given up in the last 24 hours. Files received shows them as "could not be read". Files that could not be downloaded from WhatsApp are not counted here.
  - *not uploaded to Drive*: uploads that gave up (see "Status "files could not be uploaded to Drive"" below).
  - Voice notes count as files here too. With a paid speech-to-text service the line can end with `· including N voice notes waiting (speech key refused)` (see "Voice notes" below).
  - The counts leave out clients removed from the allow-list. Their files wait, untouched, until the client is added back.
- **`task edit`** options: `--title`, `--side` (us or client), `--category` (design, development, content, payment, approval, other), `--priority` (high, medium, low), `--assigned-to`, `--asked-by`, `--deadline` (YYYY-MM-DD or `none`), `--latest-progress`. Fields you fix by hand stay fixed until you run `task unlock`.
- **`person set <number> <team|client>`**: use the full number with country code and no `+` or spaces (for example `919812345678`). A WhatsApp id (it contains `@`) also works. People who show no number in the People section cannot be fixed with `person set` yet. Add `--client ABC` to change the role in one client group only.
- **`task unlock`** and **`phase unlock`** let the AI change that task or phase again.
- **`rebuild`** shows up in Drive within about a minute (a 30-second check, then a 60-second upload wait).
- **`reprocess <client> --since <date> [--until <date>]`** sends old messages to the AI again. This **costs money** and counts toward the daily cap, so keep the date range short. Above 200 messages it only shows the count and the most it could cost; add `--yes` to run it. It will not re-create tasks you closed, and it will not count decisions or reminders twice from the same message.
- **Limit of `reprocess`:** it cannot add a missed second task from a message that already produced a task (or that already counted as a reminder or an update on a task). If the AI missed a second piece of work in an old message, add a note to an existing task with `task edit <code> --latest-progress "..."`, or tell the team. There is no "task add" command yet.

## What the status line means

With the owner dashboard on, fix a connection from the dashboard first (see "Fixing a connection in the dashboard" under "Owner dashboard"). The commands below are the fallback.

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
| Voice notes are not being transcribed: the speech-to-text key was refused. | Paid service only. The provider refused `STT_API_KEY`. The notes are saved and tried again, but only for 24 hours. The tracker keeps working. | Fix the key soon. See "Voice notes" below, under "Voice note status lines". |
| (number) shared files waiting for today's AI budget (read after midnight IST) | Images or scans that need Claude do not fit in what is left of today's budget (a scan needs about $4 of room). The cap is not reached, and the tracker keeps working. | Nothing: they are tried every 10 minutes and read once there is room, at the latest after midnight India time. See "Spend cap and shared files" below. |
| Morning report: unknown, check WhatsApp | The morning report's send started but did not finish cleanly. It may have reached the founder. The agent does not resend it by itself. | See "Morning report" above, under its own status heading. |
| Morning report: the spare number is not linked | The spare number cannot send the morning report. The tracker is not affected. | See "Morning report" above, under "the spare number is not linked". |
| Morning report: the spare number's saved session cannot be read | The spare number's saved session (`sender-session.db`) was written with a different master key, or is damaged. The tracker is not affected. | See "Morning report" above, under "the spare number is not linked". |
| Morning report: the spare number's session file could not be opened (disk, permissions or a lock) | The service could not open `sender-session.db` when it started (a lock, permissions or a disk error). The file is not known to be damaged. The tracker is not affected. | Restart the service. Do not run `link-sender --reset` for this. See "Morning report" above. |
| Morning report: the sender is linked to the founder's own number | The `link-sender` QR code was scanned with the founder's phone, so the saved sender link is the founder's own number. The agent refuses to send from it. The tracker is not affected. | See "Morning report" above, under "the spare number is not linked". |
| Morning report: the spare number was logged out | The linked device was removed on the spare phone, or the phone was not opened for weeks. The tracker is not affected. | See "Morning report" above, under "the spare number is not linked". |
| Morning report: WhatsApp refused the spare number (403) | WhatsApp blocked the spare number's device. The tracker is not affected. | Check the spare phone. See "Morning report" above. |
| Morning report: another session took over the spare number | Another copy of the agent, or another WhatsApp Web session, took the spare number's linked device. The tracker is not affected. | Restart the service. See "Morning report" above. |
| Low disk: (number) GB free | Under 10 GB left. | Free up disk space. |
| Voice notes are not being transcribed: (reason) | The local speech engine is not set up, or ffmpeg was not found. Voice notes are saved. The tracker keeps working. | See "Voice notes" below, under "Voice note status lines". |
| (number) voice notes could not be transcribed on this computer. See docs/SETUP.md, Voice notes | In the last 24 hours, some voice notes could not be transcribed on this computer: the local engine failed on them 3 times, ffmpeg could not convert them, or the service was stopped in the middle of them again and again for 24 hours. They are saved. The tracker went ahead without them. | See "Voice notes" below, under "Voice note status lines". |

The key-refused line comes before the budget line, because notes waiting on a refused key are given up after 24 hours. The other voice note lines come last, so they never hide the morning report, a meeting line or low disk.

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

## Voice notes

The agent can turn the voice notes and audio files shared in the allowed groups into text (transcribe them). The tracker then reads what was said like a typed message: a client asking for a change by Friday, a team member saying "bhej diya", a client saying the payment was sent.

- It is **off** until you switch it on (`VOICE_STT_PROVIDER=none`, the default). While it is off, voice notes are saved on this computer as before, and the AI only learns that one was sent. They can be transcribed later (see "Voice notes saved earlier" below).
- **Recommended: the free local engine.** An open-source model (Voxtral) runs on the office Mac, on its own processor. No audio leaves the computer, there is no key, and it costs nothing. Set it up with `docs/SETUP-mac.md`, section 8 "Voice notes: local speech-to-text", then set `VOICE_STT_PROVIDER=local` and restart the service.
- A paid speech-to-text service can be used instead, but only the one meetings use (see "Privacy" and "Cost" below).
- Meetings are not affected. They keep their own setting, `STT_PROVIDER`.
- Voice notes are never listed in Files received or uploaded to Drive, even when transcribed.

### ffmpeg is required

Every voice note and audio file is first converted on this computer with ffmpeg, and its real length is measured. **Without ffmpeg, nothing is transcribed:** the notes are saved, show as "not transcribed", and the status line says so.

- On the Mac: `brew install ffmpeg` in a normal Terminal window.
- On Windows: see "Meeting summaries", step 2 "Install ffmpeg".
- Set `FFMPEG_PATH` to ffmpeg's full path, or leave it empty to use the `ffmpeg` on the PATH.
- The service looks for ffmpeg only when it starts. After installing it, restart the service, then run `transcribe-voice` (below) for the notes that came in meanwhile.

### Settings

In `.env` (values stay on this computer only; `.env.example` explains each one):

| Setting | What it is |
|---|---|
| `VOICE_STT_PROVIDER` | `local` (recommended), `none` (off, the default), or a paid service: `sarvam`, `elevenlabs` or `openai`. A paid one must be the same as `STT_PROVIDER`, because both use the one key `STT_API_KEY`; the service refuses to start otherwise. `local` needs no key. |
| `STT_LOCAL_ENGINE` | `voxtral` (the default, chosen after a test), `qwen3-asr` or `whisper`. |
| `STT_LOCAL_BIN` | Full path to the engine program (SETUP-mac, section 8). Required for `local`. |
| `STT_LOCAL_MODEL` | Full path to the model file (SETUP-mac, section 8). Required for `local`. |
| `STT_LOCAL_THREADS` | Processor cores the engine uses. Default 8, allowed 1–64. |
| `STT_LOCAL_TIMEOUT_SECONDS` | A note that takes longer is stopped and tried again (3 tries in all). Default 1800 (30 minutes), allowed 60–7200. |
| `STT_LOCAL_LANGUAGE` | `hi` (the default), `en` or `auto`. Qwen3-ASR always finds the language itself. |
| `STT_MAX_SECONDS` | The longest note that is transcribed, in seconds. Default 600 (10 minutes), allowed 30–900. |
| `FFMPEG_PATH` | Full path to ffmpeg (above). |

If `STT_LOCAL_BIN` or `STT_LOCAL_MODEL` is set but the file is not there when the service starts, voice notes stay off, the status line says so, and WhatsApp tracking keeps running.

### What the tracker sees

Each voice note reaches the AI as a block on its message, for example `{voice note, 0:42, transcript: ...}`. The length is the one WhatsApp shows. Instead of a transcript, the block can say:

| Block says | Meaning |
|---|---|
| `being transcribed` | Not done yet. The tracker waits for it up to 30 minutes, then goes on without it and looks at the message again when the text arrives. No task is made from a note it cannot read yet. While voice notes are off (or the engine is not set up), the tracker does not wait for them at all. |
| `no speech` | The note is silent. |
| `too long to transcribe` | Longer than `STT_MAX_SECONDS`. |
| `could not be transcribed` | Every try failed. |
| `not transcribed` | Voice notes were off, ffmpeg or the engine was missing, or the note was saved earlier. `transcribe-voice` can do it later. |
| `(forwarded), not transcribed` | A forwarded note. Never transcribed. |
| `not transcribed: too costly for the daily limit` | Paid service only: see "Cost" below. |

### Limits

- **Too long.** A note longer than `STT_MAX_SECONDS` (10 minutes by default) is not transcribed, and it never holds the tracker up. The length is measured on this computer after the conversion, not taken from WhatsApp, because the sender's phone sets that one. Audio files (a song, a recorded call) follow the same rule: only short ones are transcribed.
- **Forwarded voice notes are not transcribed**, just as forwarded pictures are not described.
- **Speed.** Voxtral on the Mac can be slower than the note itself: a 10-minute note can take 10–20 minutes. It does one note at a time; pictures and documents are not held up. The tracker waits at most 30 minutes for a note (see above).
- **Mishearing.** Names, numbers and amounts can come out wrong. The AI is told to prefer the typed chat when the two disagree. Check tasks closed from voice notes; `task reopen` undoes a wrong close.
- **Empty text from a note with sound.** The local engine sometimes returns nothing for a quiet note. That is never taken as "no speech": the note is tried again, after 1 minute and then 5 minutes (3 tries in all). If every try comes back empty, it shows as "could not be transcribed", `status` counts it under "could not be read (24 h)", and the status line says how many voice notes could not be transcribed on this computer. `transcribe-voice --failed` tries them again (see "Voice notes the local engine could not transcribe" below). Only a note quieter than -50 dB counts as silent. If real notes often come back empty, tell the developer.
- **Stopping the service** while a note is being transcribed: the note is simply tried again after the start (free with the local engine). This does not use up one of its tries; but a note still not done 24 hours after it arrived is given up.
- **Where the text is kept.** Transcripts are stored in the tracker database, like the text of shared files, and the audio stays in `data\media`. The logs hold ids, counts and error codes only, never what was said.

### Privacy

- **With the local engine** no audio leaves the computer, and there is nothing to set at a provider. Tell clients, in the agreement or at onboarding, that voice notes sent to the project group are transcribed on the office computer for the project tracker.
- **Only if a paid service is chosen**, before the first real voice note:
  1. **Tell clients** that their voice notes are sent to a speech-to-text service to be transcribed.
  2. **Set the account's privacy settings**, as for meetings:
     - **Sarvam:** opt out of training, and set data retention to 0 days.
     - **ElevenLabs:** switch off "Improve the models for everyone". ElevenLabs keeps a copy of every transcript in the account, so the agent deletes each copy right after it stores the transcript, and tries again later if that fails (see "Voice copies" below).
     - **OpenAI:** nothing to switch.

### Cost

- **Local engine: $0.** Nothing counts toward `DAILY_SPEND_CAP_USD`.
- **Paid service** (only if chosen): about $0.004–0.006 per minute of voice note at list prices, so 100 notes a day of 45 seconds each cost about $0.30–0.45 a day. It counts toward `DAILY_SPEND_CAP_USD`, and `status` shows it as "speech" in the spend line, for example `(AI $1.20, speech $0.35)`.
  - While a note is being transcribed, its full price (for its measured length plus 5 seconds) is held from today's budget; then the real cost is booked.
  - A paid note gets at most 2 tries in all. When the outcome of a try is unknown, it is booked at its full price.
  - If the cap is so low that one note could cost more than the whole cap, the note is not transcribed ("too costly for the daily limit"), and it is not transcribed later either.

### Voice notes saved earlier

Voice notes saved before voice notes were switched on, while they were off, or while ffmpeg or the engine was missing, are not transcribed by themselves. To transcribe them, for the record, in the waagent window:

```bat
npm run cli -- transcribe-voice
```

- This only shows how many there are, about how many minutes, and the cost (`Cost: $0 (local engine on this computer).` with the local engine). It changes nothing.
- Add `--client ABC` for one client only.
- After changing `VOICE_STT_PROVIDER` or the `STT_LOCAL_*` settings, restart the service before running this command.
- `npm run cli -- transcribe-voice --yes` queues them. The **running** service then transcribes them. A new voice note goes before any of them that are still waiting; but the local engine does one note at a time and does not stop a note it has started, so a new note can wait behind one of these for up to `STT_LOCAL_TIMEOUT_SECONDS` (30 minutes by default).
- With the local engine, the command first checks that `STT_LOCAL_BIN` and `STT_LOCAL_MODEL` are files. If one is not, it says so, naming the setting, and changes nothing: fix it in `.env` (SETUP-mac, section 8), restart the service, then run the command again.
- If voice notes were switched off while some of these were still waiting, those come back in the count. Run the command again once voice notes are on.
- These transcripts are for the record only. They do not change the tracker or make tasks, because those messages were handled long ago. To have the AI look at old messages again, use `reprocess` (it costs money; see "Everyday commands").
- `N need ffmpeg, skipped` means ffmpeg was not found. Install it, restart the service, then run the command again.
- With a paid service it costs money, counts toward the daily cap, and shows two figures: about how much from the file sizes, and the most it could cost.
- A note that turns out to be too long is not transcribed ("too long to transcribe").

### Voice notes the local engine could not transcribe

A voice note shows as "could not be transcribed" when:

- the local engine failed on it 3 tries in a row (empty text from a note with sound, too slow, or the engine stopping with an error);
- ffmpeg could not convert it. This is not tried again, because it would fail the same way;
- the service was stopped in the middle of it again and again. Each stop does not use up a try, and the note is tried again after the start; but once it has waited 24 hours (from when it arrived, or from the service start if that is later), it is given up.

For a day the status line says `(number) voice notes could not be transcribed on this computer`. Once the cause is fixed (for example a better model, a longer `STT_LOCAL_TIMEOUT_SECONDS`, or a working ffmpeg; restart the service after changing `.env`), try them again, in the waagent window:

```bat
npm run cli -- transcribe-voice --failed
```

- This only shows how many there are, about how many minutes, and `Cost: $0 (local engine on this computer).` It changes nothing.
- After changing `VOICE_STT_PROVIDER` or the `STT_LOCAL_*` settings, restart the service before running this command.
- `npm run cli -- transcribe-voice --failed --yes` queues them again, starting fresh: the local engine again gets 3 tries for each. The **running** service transcribes them. Add `--client ABC` for one client only.
- It works only with `VOICE_STT_PROVIDER=local`. With a paid provider, these notes stay failed: the command says so and changes nothing. Notes that failed at a paid service are never queued again, because those tries may have been paid.
- A message the tracker already handled without its note is not looked at again: the transcript is kept for the record, as for "Voice notes saved earlier".

### Voice note status lines

On the Health line (see "What the status line means"):

| What you see | What it means | What to do |
|---|---|---|
| Voice notes are not being transcribed: the speech-to-text key was refused. | Paid service only. The provider refused `STT_API_KEY`. Nothing is paid. The notes wait and are tried again after 5, 15, 30 and 60 minutes, then every hour, for up to 24 hours; after that they show as "could not be transcribed". The tracker does not wait for them more than 30 minutes. | Check the key in the provider's console. Put a working key in `.env`, then restart the service. |
| Voice notes are not being transcribed: the local speech engine is not set up (STT_LOCAL_BIN) | The engine program is not at the path `STT_LOCAL_BIN` names in `.env`. Voice notes are saved but not transcribed. WhatsApp tracking keeps running. | Fix `STT_LOCAL_BIN` in `.env` (SETUP-mac, section 8), restart the service, then run `transcribe-voice` for the notes that came in meanwhile. |
| Voice notes are not being transcribed: the local speech engine is not set up (STT_LOCAL_MODEL) | The model file is not at the path `STT_LOCAL_MODEL` names in `.env`. Voice notes are saved but not transcribed. WhatsApp tracking keeps running. | Fix `STT_LOCAL_MODEL` in `.env` (SETUP-mac, section 8), restart the service, then run `transcribe-voice` for the notes that came in meanwhile. |
| Voice notes are not being transcribed: ffmpeg not found | ffmpeg is not installed, or `FFMPEG_PATH` is wrong. Voice notes are saved and show as "not transcribed". | Install ffmpeg or fix `FFMPEG_PATH` (see "ffmpeg is required"), restart the service, then run `transcribe-voice`. |
| (number) voice notes could not be transcribed on this computer. See docs/SETUP.md, Voice notes | In the last 24 hours, that many voice notes could not be transcribed on this computer: the local engine failed on them 3 tries in a row (empty text from a note with sound, too slow, the engine stopping with an error); ffmpeg could not convert them (not tried again); or the service was stopped in the middle of them again and again for 24 hours. ffmpeg failures with a paid provider count here too. They are saved and show as "could not be transcribed". The line clears by itself a day later. | Read `wa-agent.out.log` for lines with `local_` or `audio_` codes. Fix the cause, then see "Voice notes the local engine could not transcribe" above. If real notes keep failing, tell the developer. |

The key-refused line comes before the budget line (see "What the status line means"), because notes waiting on a refused key are given up after 24 hours. The other lines come after every other line on the Health line, so they never hide a more urgent one. In order: the key line, then the not-set-up and ffmpeg lines, then the could-not-transcribe line.

A slow engine, or many notes at once, can also show `shared files waiting over 30 minutes to be read`: voice notes count there too. It clears by itself once they are transcribed.

In `npm run cli -- status`:

- **The `Files:` line** ends with `· including N voice notes waiting (speech key refused)` while a paid service refuses the key (see the last row above). Those notes are part of the "waiting to be read" count.
- **Voice copies.** If `status` shows `Voice copies: N speech-to-text copies of voice notes could not be deleted from the provider; see SETUP (Voice notes)`, the agent has given up deleting its copies of those voice-note transcripts in the provider's account (ElevenLabs; the local engine keeps no copies). It tries each copy at most 5 times (right after the transcript is stored, then later, at least 15 minutes, 1 hour, 6 hours and 24 hours apart); a copy made by a provider that is no longer `VOICE_STT_PROVIDER` is not tried at all. This line is on `status` only, not on the Health line. What to do: delete those transcripts in the provider's account yourself. If `VOICE_STT_PROVIDER` was changed, setting it back lets the agent try the copies it has not tried 5 times yet. The count is a reminder: it does not go down when you delete copies by hand.

## Meeting summaries (Phase 3)

When this is on, the agent finds the Google Meet recordings of client meetings and makes a summary Google Doc for each one, in `WA Agent > Clients > <client name> > Meetings`. The meeting's action items and decisions go into the same tracker as WhatsApp, without making a second task for work WhatsApp already tracks.

- It is **off** until you switch it on (`MEETINGS_ENABLED`). Off means no meeting call to Google at all.
- It asks Google Meet for the meetings the **mailbox** account hosted or joined, and reads the attendees from the Calendar invite. It **never reads email**.
- It only reads. Nothing in the founder's Drive is changed, moved or deleted.
- A meeting is processed only when it clearly belongs to one client (see "Which meetings are processed" below). The rest wait for you, or are ignored as internal.
- Only meetings from the day it is switched on are picked up. Older ones need `meeting backfill` (see the commands below).
- Each check looks back 72 hours. If the service was stopped for more than 3 days, run `meeting backfill --since <the day it stopped>`.

Do the steps below once, in order.

### 1. Before you start

- **Speech-to-text.** The speech-to-text test (bake-off, `docs/STT-BAKEOFF.md`) has picked a provider. Meetings use `STT_PROVIDER`. Voice notes have their own setting, `VOICE_STT_PROVIDER` (see "Voice notes"); a paid voice service must be this same provider and key. On the Mac, `STT_PROVIDER=local` sends meetings through the free local engine voice notes use (SETUP-mac.md, section 8, "Meetings on the same engine"): no key and no speech cost, but slow (about 4 hours for a 3-hour meeting on Voxtral) and with no speaker labels. After switching to `STT_PROVIDER=local`, the copies a paid provider kept of earlier meeting transcripts (ElevenLabs keeps one per call) are not deleted while the setting stays `local`: `status` counts them as left, and they are deleted once that provider is set again, or you can delete them in that provider's own console.
- **Internal Google app.** The OAuth consent screen is **Internal** (section 4 of this guide). One of the new permissions (Meet files in Drive) is a "restricted" one. **If the app is not Internal, stop and ask.**
- **Privacy steps done** (step 6 below). Do them before the first real meeting is sent.

### 2. Install ffmpeg (admin)

ffmpeg turns a recording into a small audio file on this PC. The service account must be able to run it.

1. In your normal browser, open ffmpeg.org > Download > Windows builds, and take the **gyan.dev** "release essentials" build (a zip). Write down its version number.
2. **Check the download before you unzip it.** gyan.dev shows a SHA-256 checksum next to each release build. In an admin window:

```bat
certutil -hashfile "%USERPROFILE%\Downloads\ffmpeg-release-essentials.zip" SHA256
```

   Use the zip's real file name. The long number printed must be exactly the one gyan.dev shows for that file. If it differs, or you cannot find a checksum, delete the download and ask.

3. Unzip it to `C:\Tools\ffmpeg` and lock the folder, so only administrators can change it and waagent can only run it:

```bat
mkdir C:\Tools\ffmpeg
tar -xf "%USERPROFILE%\Downloads\ffmpeg-release-essentials.zip" -C C:\Tools\ffmpeg --strip-components 1
icacls C:\Tools\ffmpeg /inheritance:r /grant:r "Administrators:(OI)(CI)F" "SYSTEM:(OI)(CI)F" "waagent:(OI)(CI)RX"
```

4. In the waagent window, check that it runs:

```bat
C:\Tools\ffmpeg\bin\ffmpeg.exe -version
```

5. Put the full path in `.env` (step 4): `FFMPEG_PATH=C:\Tools\ffmpeg\bin\ffmpeg.exe`. Without `FFMPEG_PATH` the agent looks for `ffmpeg` on the PATH.

Only `ffmpeg.exe` is used; `ffprobe` is not needed. If ffmpeg cannot be found, meetings pause and the status line says so.

### 3. Switch on the Google APIs

Signed in as the **mailbox** Google account, in console.cloud.google.com, project `WA Agent`:

1. APIs & Services > Library > enable **Google Meet API** (it may be listed as "Google Meet REST API").
2. APIs & Services > Library > enable **Google Calendar API**.

The Google Drive API is already on (section 4 of this guide).

### 4. Settings

In an admin window or the waagent window, open `notepad C:\wa-agent\.env` and fill in these names. Values stay on this PC only; `.env.example` explains each one.

| Setting | What it is |
|---|---|
| `MEETINGS_ENABLED` | `true` to switch meetings on. Default `false`. |
| `TEAM_EMAIL_DOMAINS` | Our own email domains, comma-separated, for example `ourstudio.in`. Required when meetings are on. Public mail domains such as gmail.com are refused. |
| `MEETING_POLL_MINUTES` | How often to look for new recordings. Default 5, allowed 2–60. |
| `MEETING_MAX_MINUTES` | Longer meetings are listed as "too long" and not transcribed. Default 180 (3 hours), allowed 10–300. |
| `MEETINGS_SINCE` | Optional, `YYYY-MM-DD`: only meetings from this day on. Empty means from the day the service first ran with meetings on (stored, so a restart does not move it). |
| `FFMPEG_PATH` | Full path to `ffmpeg.exe` (step 2). |
| `STT_PROVIDER` | `local`, `sarvam`, `elevenlabs`, `openai` or `none`. Default `none`: meetings are found and matched, but wait. `local` is the engine on the Mac (needs `STT_LOCAL_BIN` and `STT_LOCAL_MODEL`, SETUP-mac.md section 8). |
| `STT_API_KEY` | The speech-to-text provider's key. Required when `STT_PROVIDER` is not `none` or `local`. Type it into `.env` yourself, never into chat or code. |
| `INR_PER_USD` | Rupees per US dollar, for Sarvam's rupee prices. Default 88, allowed 40–200. |

Then tell the agent which meetings belong to which client. In `config\allowed-groups.json`, each client can have two more fields:

```json
{ "groupId": "120363000000000001@g.us", "name": "Client name", "code": "ABC",
  "emailDomains": ["clientcompany.example"], "meetingKeywords": ["Client project"] }
```

- **`emailDomains`**: the client's own email domains. An attendee from that domain, or from a subdomain of it, points to this client. Public mail domains (gmail.com, outlook.com, yahoo.com and the like) are refused, because they would match everyone.
- **`meetingKeywords`**: words in a meeting title that point to this client, as whole words. Each must keep at least 3 characters (spaces not counted) once punctuation and symbols are removed, so "c++" is refused; at most 20 per client. Capitals and punctuation do not matter when matching. The client's name counts too.
- A very short client name, such as "AB", never matches a title. Such a client is matched only by its keywords or email domains.
- The service picks up changes to this file within seconds, as before. Run `npm run cli -- status` and check the client is still listed.

### 5. Sign in to Google again (as waagent)

With `MEETINGS_ENABLED=true` saved in `.env`, in the waagent window:

```bat
npm run cli -- google-auth
```

It first prints the permissions it will ask for. Besides Google Drive (only the files WA Agent creates), there are three new ones, all **read only**:

- **Google Meet recordings list (read only)**: the meetings the mailbox account hosted or joined.
- **Calendar invites (read only)**: invite titles and attendee emails.
- **Meet files in Drive (read only)**: only files that Google Meet made, such as recordings.

Tick every box Google shows. If one is missing, `google-auth` says which, saves nothing, and you run it again. Until all three are granted, meetings stay paused and the status line says so.

### 5b. More Google accounts that record meetings (optional)

If meetings are recorded on other Google accounts too (for example sir's accounts at other companies), sign each one in once. Give each a short name of your choice: lower-case letters, digits or `-`, for example `company2`. In the waagent window:

```bat
npm run cli -- google-auth --account company2
npm run cli -- google-auth --account company3
```

- Each command prints a link. Open it, **choose that account** in Google's account chooser, and tick every box.
- An extra account gets the three **read-only** meeting permissions only. It never gets Drive file access: summaries still go to the mailbox account's **WA Agent** folder.
- The agent then checks every account for new recordings. Each recording is matched to a client exactly as above. A meeting seen by two accounts is processed once.
- Restart the service after adding or removing an account.
- `meeting check` shows, at the end of each line, which account found the recording, for example `[company2]`.
- To stop using an account: `npm run cli -- google-auth --account company2 --remove` (it asks first). Then also remove WA Agent at myaccount.google.com/permissions while signed in as that account.
- If Google refuses one account's sign-in later, only that account's meetings wait. The status line names it: `Meetings: Google sign-in lost for company2`. Run `google-auth --account company2` again.

**Accounts on other company domains need one Google Cloud change.** An **Internal** OAuth app (step 1) only lets accounts of the mailbox account's own company sign in. For accounts at other companies:

1. In console.cloud.google.com, project `WA Agent`, open APIs & Services > OAuth consent screen. Set the user type to **External**, then **Publish app** (status "In production", not "Testing"; in Testing, sign-ins expire every 7 days).
2. At sign-in Google warns "Google hasn't verified this app". It is your own private app: click **Advanced > Go to WA Agent**. Google may limit an unverified app to a small number of users, which is fine here.
3. If a company's Google Workspace admin blocks outside apps, that account's sign-in is refused. The admin must allow the app (Admin console > Security > API controls), using the client ID from `.env`.

**TEAM_EMAIL_DOMAINS:** list the other companies' domains there only if everyone at those companies counts as your own team. A meeting whose attendees are all in team domains is internal and is never processed.

### 6. Privacy steps (required before the first real meeting)

1. **Tell clients.** Say in the agreement, or at onboarding, that recorded meetings are transcribed and summarised for the project tracker. Google Meet itself shows everyone that a meeting is being recorded.
2. **Set the speech-to-text account's privacy settings**, as for voice notes:
   - **Sarvam:** opt out of training, and set data retention to 0 days.
   - **ElevenLabs:** switch off "Improve the models for everyone". The agent also deletes each transcript from the ElevenLabs account once it is stored on this PC.
3. **Know what stays on this PC:**
   - the transcript and the summary, in the tracker database;
   - the meeting's audio, in `C:\wa-agent\data\meetings\<CODE>\<year-month>\` (about 28 MB per hour of meeting);
   - the downloaded video and audio parts only while they are needed, in `data\meetings\tmp\`. The agent deletes only its own files there;
   - the logs hold ids, counts and error codes only, never titles, names, emails or what was said.
4. **Internal meetings** (only our team) are never downloaded, transcribed or summarised. Only ids (meeting, recording, Drive file, Meet code), the start time and status are kept.
5. **In Drive** the agent only adds the summary Docs. It never changes, moves or deletes the founder's recordings or any other file. Share the Meetings folders with the team only, never clients (they are inside the **WA Agent** folder, section 6 of this guide).

### 7. Check first, then start

Before the service starts processing meetings, see what it would do. In the waagent window:

```bat
npm run cli -- meeting check
```

- It lists the last 7 days' recordings not stored yet (stored ones are only counted), which client each one matches (or "unassigned" or "internal"), and whether each file opens.
- It only reads: it downloads nothing and stores nothing. The service may keep running.
- A recording marked as not opening usually belongs to a meeting recorded by someone else. The agent cannot open it, and lists it as "no access".
- If a client meeting shows as unassigned, add a keyword or domain for that client (step 4) and run the check again.

When the list looks right, restart the service (`net stop wa-agent`, then `net start wa-agent`).

### Which meetings are processed

The client is chosen **before** anything is downloaded or sent anywhere:

1. The meeting title (from the invite, or the recording's name) contains a client's name or one of its keywords, as whole words.
2. Otherwise, an attendee's email domain is in a client's `emailDomains`.

- **Exactly one client found:** the meeting is processed.
- **None, or more than one:** it waits as **Unassigned** until you assign it (`meeting assign`). The Overview tab lists unassigned meetings by number, date and length only. Titles and attendees are shown only by `meeting list`, on this PC.
- **Internal:** an invite with at least one other attendee, every attendee from `TEAM_EMAIL_DOMAINS`, and no client name or keyword in the title. A meeting with no invite or no attendees is never internal.
- **Too long:** over `MEETING_MAX_MINUTES`. It is listed, not transcribed.

### What a meeting does

1. Downloads the recording into `data\meetings\tmp\`, makes a small audio file with ffmpeg, and deletes the video.
2. Turns the speech into text: with speaker labels from a paid provider, as plain text (each line labelled "Speaker") from the local engine.
3. Has Claude write the summary.
4. Makes the Google Doc: meeting info (client, date, length, attendees), what happened, discussion points, decisions, action items (ours and the client's, with owner and deadline when said), open questions, conclusion and next steps, then the full transcript with times and speaker names (with the local engine there are no speaker names: each line is labelled "Speaker"). The name is `YYYY-MM-DD – <Client> – <Meeting title>`.
5. Updates the tracker. A meeting can do what a WhatsApp message can: add tasks (marked "Meeting"), update tasks first raised on WhatsApp, close tasks, mark them maybe done, and log reminders and decisions. It never changes anyone's role.

- **Closing tasks** follows the chat rules: a task closes only when the meeting clearly says the work is done or approved by the right person. "Sent" without an approval makes it maybe done. Speech-to-text can mishear, so check closes from meetings: the Doc has the transcript, and `task reopen` undoes a wrong close.
- A task a person reopened by hand is closed again only by a meeting that started after the reopen.
- **Speaker names** come only from the invite's attendees and from people signed in to Google in the meeting. A name someone just says, or a guest's self-chosen name, is never used. Unknown speakers stay labels such as "speaker_2". With the local engine there are no speaker names: each line is labelled "Speaker".
- Meetings are processed one at a time. Each step is saved before the next, so a restart carries on where it stopped and does not pay twice for finished work.

### Cost of meetings

Speech-to-text is booked as `stt` and the summary as `ai`. Both count toward `DAILY_SPEND_CAP_USD`. Expected cost for a 1-hour meeting, at list prices:

| Step | Cost |
|---|---|
| Speech | ElevenLabs $0.22, Sarvam about $0.41, OpenAI $0.36, local engine $0 |
| Summary | about $0.15–0.25 |
| Tracker update | about $0.05–0.08 |
| **Total** | **about $0.45–0.70** (about $0.20–0.33 with the local engine) |

- Before speech-to-text starts, the agent holds the list price for the meeting's measured length. When the answer comes, the real cost is booked.
- A meeting that does not fit in what is left of today's budget waits, and is processed after midnight India time.
- **Restarting during speech-to-text.** If the service is stopped while a part of a meeting is being transcribed, that part is booked at its full list price, and (ElevenLabs or OpenAI) sent again after the start. A Sarvam job is picked up again instead. With the local engine nothing is booked: the part is simply transcribed again.
- **The meeting golden check** sends a few made-up meetings to Claude and checks the answers. It costs money on the Anthropic account, so it needs the owner's approval. The first command sends nothing and shows the most each case could cost; the second runs them:

```bat
npm run golden -- --meetings
npm run golden -- --meetings --yes
```

### Meeting commands (run in the waagent window)

| Command | What it does |
|---|---|
| `npm run cli -- meeting list` | Lists meetings: number, date, client (or "unassigned" or "internal"), status and title. On screen only. Without `--all`, only meetings that need you: unassigned, queued, failed and no access. Internal meetings show no title. Add `--all` to see every meeting. |
| `npm run cli -- meeting assign 12 ABC` | Gives meeting 12 to client ABC and queues it. Works for unassigned and internal meetings, and for a "no access" meeting without a client (its download is tried again for that client). |
| `npm run cli -- meeting skip 12` | An unassigned meeting is never processed. |
| `npm run cli -- meeting retry 12` | Puts a failed or "no access" meeting back in the queue, at the step it reached. A meeting without a client (found as unassigned or internal) cannot be processed: it goes back to unassigned, and the command says to assign it with `meeting assign 12 <CODE>`. |
| `npm run cli -- meeting backfill --since 2026-10-01` | For older meetings: shows the recordings it would store (for a client, unassigned, internal, no access, too long), the hours of the client ones and the most they could cost, and changes nothing. Add `--yes` to store them; the client ones are queued. Needs the service stopped, with or without `--yes`. |
| `npm run cli -- meeting check` | Read only: the last 7 days' recordings not stored yet (stored ones are only counted), their client match, and whether each file opens. The service may keep running. |

`status` also prints a `Meetings:` line, for example `Meetings: 4 done, 1 waiting, 2 unassigned, 0 failed`, with `, N no access` and `, N too long` added when not 0, and today's spend split as `(AI $x, speech $y)`.

If `status` shows `Speech copies: N speech-to-text copies could not be deleted from the provider`, the agent has given up deleting its copies of those transcripts in the provider's account (ElevenLabs). It tries each copy at most 5 times (when the meeting's transcript is stored, then at later service starts, at least 15 minutes, 1 hour, 6 hours and 24 hours apart); a copy made by a provider that is no longer `STT_PROVIDER` is not tried at all. This line is on `status` only, not on the Health line. What to do: delete those transcripts in the provider's account yourself. If `STT_PROVIDER` was changed, setting it back lets the agent try the copies it has not tried 5 times yet. The count is a reminder: it does not go down when you delete copies by hand.

### Meeting status lines

These appear on the `Health:` line, after the shared-file lines and before low disk:

| What you see | What it means | What to do |
|---|---|---|
| Meetings paused: Google sign-in needs meeting access. Run: npm run cli -- google-auth | The three meeting permissions are not all granted. | Run `npm run cli -- google-auth` in the waagent window (step 5), tick every box, then restart the service. |
| Meetings paused: ffmpeg not found | `FFMPEG_PATH` is wrong, or ffmpeg is not on the PATH. | Check step 2, fix `FFMPEG_PATH` in `.env`, restart the service. |
| (number) meetings could not be processed | Meetings failed after their retries (for example the speech-to-text key was refused for 24 hours). Meetings the agent cannot open are not counted here: `status` lists them as `no access`. | Run `npm run cli -- meeting list`. Read `wa-agent.out.log` (look for lines with `meeting`). After a fix, run `meeting retry <number>`. |
| Meetings waiting: speech-to-text is not set up | `STT_PROVIDER` is `none`. Meetings are found and matched, but not transcribed. | Set `STT_PROVIDER` and `STT_API_KEY` in `.env` (or `STT_PROVIDER=local` on the Mac), then restart the service. With `local`, waiting meetings are picked up right after the restart; with a paid provider, within the hour. |
| Meetings waiting: the local speech engine is not set up (STT_LOCAL_BIN) | `STT_PROVIDER` is `local`, but there is no file at `STT_LOCAL_BIN` (the engine program). Meetings wait; nothing is lost. | Check the path in `.env` (SETUP-mac.md, section 8), then restart the service. |
| Meetings waiting: the local speech engine is not set up (STT_LOCAL_MODEL) | `STT_PROVIDER` is `local`, but there is no file at `STT_LOCAL_MODEL` (the model). Meetings wait; nothing is lost. | Check the path in `.env` (SETUP-mac.md, section 8), then restart the service. |
| Meetings waiting: the speech-to-text key was refused | The provider refused `STT_API_KEY`. The agent tries again every hour. After 24 hours of refusals in one service run the meeting fails; run `meeting retry <number>` after fixing the key. | Check the key in the provider's console. Put a working key in `.env`, then restart the service. |

### Turning meetings off

Set `MEETINGS_ENABLED=false` in `.env` and restart the service. Nothing is deleted: the Docs, the tasks and the saved audio stay. Meetings already found wait, untouched, until you switch it on again.

## Uptime monitoring (optional, UptimeRobot)

The agent can visit an UptimeRobot **Heartbeat** monitor link every 5 minutes while it is working, so UptimeRobot alerts you when the visits stop (the PC is off, the service stopped, WhatsApp is unlinked or disconnected for over 30 minutes, the Google sign-in expired, or tracker updates fail for over an hour). It sends nothing but the visit.

1. In UptimeRobot add a **Heartbeat** monitor with a 5-minute interval, and copy its link (`https://heartbeat.uptimerobot.com/...`). Keep it secret.
2. Paste it after `HEARTBEAT_URL=` in `.env`, save, and restart the service (`net stop wa-agent`, then `net start wa-agent`).
3. After an alert, run `npm run cli -- status`: the Health line says what is wrong. To switch it off, empty `HEARTBEAT_URL=` and restart.

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

  4. On the founder's phone, remove the old "WA Agent - Tracker" device first (Settings > Linked devices). After the move, `link --reset` will say "No saved WhatsApp link to reset" and skip its question, so it will not remind you.
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

  3. On the founder's phone, remove the old "WA Agent - Tracker" device (Settings > Linked devices).
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
  3. On the founder's phone, remove the old "WA Agent - Tracker" device if it is still listed.
  4. In the waagent window: `npm run cli -- link --reset` (type `yes`), then scan the QR code.
  5. **Start the service again** (see above).
