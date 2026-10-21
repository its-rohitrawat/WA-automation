# WA Agent: office PC setup and pilot

Do the steps once, in order. Commands run in **Command Prompt**. "Admin" means: right-click Command Prompt and choose *Run as administrator*.

What WA Agent does: it quietly reads the WhatsApp client groups you allow, keeps a task tracker, and updates an Excel file in Google Drive. It never sends a WhatsApp message.

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

- **ANTHROPIC_API_KEY**: console.anthropic.com > API keys > Create key, named `wa-agent-office-pc`.
- **Spend limits.** `DAILY_SPEND_CAP_USD` is a *soft* cap. In rare cases (a request already running, or a backup model) the agent can go over it by a few dollars. So also set a **monthly spend limit in the Anthropic console**. That limit is the hard stop.
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

This is optional. Without it the tracker starts from today. If you do it, the first service start sends that history to the AI. This costs a little and counts toward the daily spend cap.

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

   Stopping can take up to 2.5 minutes if the agent is finishing an AI call. That is normal. Wait for it.

7. In Google Drive (mailbox account), share the **WA Agent** folder with team members only, never clients. Share the **folder**, not the `Tracker.xlsx` file. If the file is ever re-created, people who have the folder still reach it.

**Log files.** WinSW writes two logs in `C:\wa-agent\deploy\winsw\` (next to `wa-agent.xml`). Read them in an admin window or the waagent window:

- `wa-agent.out.log`: the normal log, and crashes while running.
- `wa-agent.err.log`: the reason the service refused to start.

### Google Drive: do not use the Bin

Do not move the "WA Agent" folder or `Tracker.xlsx` to the Bin (trash). Drive keeps accepting updates to a binned file, so the tracker would look frozen with no error.

- If it happens: restore both from the Bin.
- If the folder or file was deleted for good: the agent creates a new one on its next update. The old shared link stops working, so share the new folder again.

## 7. Pilot week

- Keep only 1-2 groups in the allow-list.
- Every day:
  - Run `npm run cli -- status`. Expect `✅` and no group with a failed batch.
  - Open `Tracker.xlsx` in Drive. Check the Overview's "Built ... IST" time is recent.
  - Check spend in the Anthropic console.
  - Compare the tracker with what the team knows. Write every mistake in a simple list: date, client, what was wrong. Send the list to the developer.
- Fix mistakes with the commands below. If the same kind of mistake repeats, report it to the developer.
- **Check that the founder never looks "online" because of the agent.** From another phone, look at the founder's WhatsApp contact while his own phone is locked. He must not show "online". If he does, stop the service and report it. The cause would be a presence update sent by the WhatsApp library (Baileys, when its credentials change); the fix is a small patch to it. This check means nothing if the founder has hidden his online status in WhatsApp privacy settings.
- A **clean week** means: no wrongly closed tasks and no missed client requests. After a clean week, add the remaining groups to `config\allowed-groups.json`. The service picks up the change within seconds; no restart needed. Run `status` and check each new client appears.

## Everyday commands (run in the waagent window)

| Command | What it does |
|---|---|
| `npm run cli -- status` | Connection, queued messages, failures, spend, disk |
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

- **`task edit`** options: `--title`, `--side` (us or client), `--category` (design, development, content, payment, approval, other), `--priority` (high, medium, low), `--assigned-to`, `--asked-by`, `--deadline` (YYYY-MM-DD or `none`), `--latest-progress`. Fields you fix by hand stay fixed until you run `task unlock`.
- **`person set <number> <team|client>`**: use the full number with country code and no `+` or spaces (for example `919812345678`). A WhatsApp id (it contains `@`) also works. People who show no number in the People section cannot be fixed with `person set` yet. Add `--client ABC` to change the role in one client group only.
- **`task unlock`** and **`phase unlock`** let the AI change that task or phase again.
- **`rebuild`** shows up in Drive within about a minute (a 30-second check, then a 60-second upload wait).
- **`reprocess <client> --since <date> [--until <date>]`** sends old messages to the AI again. This **costs money** and counts toward the daily cap, so keep the date range short. Above 200 messages it only shows the count and the most it could cost; add `--yes` to run it. It will not re-create tasks you closed.
- **Limit of `reprocess`:** it will not create a second task from a message that already produced one. If the AI missed a second piece of work in an old message, add a note to an existing task with `task edit <code> --latest-progress "..."`, or tell the team. There is no "task add" command yet.

## What the status line means

In `npm run cli -- status` it appears as the `Health:` line. It is also the first line on the Overview tab. The Google sign-in and Tracker update lines are never shown in the workbook, because the workbook cannot upload while those are failing; look at `status` instead.

| What you see | What it means | What to do |
|---|---|---|
| Connected, last update (time) | All good. | Nothing. |
| Connected, waiting for new messages | All good, no messages processed yet since the start. | Nothing. |
| WhatsApp unlinked since (time) | The founder removed the linked device, or WhatsApp logged it out. | Follow "Status logged_out" below. |
| Another copy of WA Agent took over the WhatsApp session | Another copy of the agent, or WhatsApp Web on another computer, took the linked-device slot. | Follow "Status replaced" below. Do **not** reset the link. |
| WhatsApp refused this number (403) | WhatsApp blocked this device. | Look at the founder's phone for a WhatsApp warning. Do not reset the link. |
| Disconnected since (time) | No WhatsApp connection for over 30 minutes. | Check the PC's internet. The agent keeps trying to reconnect. If it stays down, restart the service. |
| Google sign-in expired | Drive no longer lets the agent in. | Run `npm run cli -- google-auth`, then restart the service. |
| The WhatsApp session could not be saved | The agent cannot write its session to disk. | Check free disk space and the permissions on `C:\wa-agent\data`. |
| Tracker update failing since (time) | The Excel file has not reached Drive for over an hour. | Check the PC's internet. If it stays, read `wa-agent.out.log`. |
| Daily spend cap reached. Paused until midnight IST | The AI budget for today is used up. Messages are saved and processed later. | Wait for midnight India time. Raise `DAILY_SPEND_CAP_USD` in `.env` and restart the service only if the higher spend is intended. |
| (number) groups waiting (AI error) | The AI call failed for some groups. Nothing is lost. | Wait: failed batches retry every hour. If it persists, read `wa-agent.out.log` and run `status`. |
| Low disk: (number) GB free | Under 10 GB left. | Free up disk space. |

## If the service will not start

When the agent refuses to start it exits, and WinSW tries again every minute or so. So `net stop` alone may not hold it down. Use the two procedures below around every fix.

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
