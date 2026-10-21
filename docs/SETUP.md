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
runas /user:waagent /profile "cmd /c echo profile ready"
```

Choose a strong password and keep it in your password manager. The `runas` line creates the account's Windows profile, which the encryption (DPAPI, Windows' built-in key protection) needs.

## 3. Install the software (admin)

1. Install **Node.js 24 LTS** from nodejs.org (the Windows installer). Check with `node --version`.
2. Install **Git for Windows**, then:

```bat
git clone https://github.com/its-rohitrawat/WA-automation.git C:\wa-agent
cd /d C:\wa-agent
npm ci
icacls C:\wa-agent /grant "waagent:(OI)(CI)M"
```

## 4. Keys and settings

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
  3. OAuth consent screen > User type **Internal** > app name `WA Agent`.
  4. Credentials > Create credentials > OAuth client ID > **Desktop app** > copy the client ID and secret into `.env`.
- Never share `.env` or commit it (it is already git-ignored).
- Create the allow-list file `config\allowed-groups.json` containing exactly this (an empty list, for now):

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

1. `google-auth` prints a link. Open it in a browser signed in as the mailbox account and allow access.
2. `link` shows a QR code. On the founder's phone: WhatsApp > Settings > Linked devices > Link a device. With an empty allow-list nothing is stored.
3. `list-groups` prints every group's id and name on screen only. Copy the ids of the 1-2 pilot groups into `config\allowed-groups.json`, like this:

```json
{
  "clients": [
    { "groupId": "120363000000000000@g.us", "name": "Client name", "code": "ABC" }
  ]
}
```

The `code` is 3 or 4 capital letters. **Pick it carefully: it is permanent**, and task numbers are built from it (for example `ABC-012`). Each group id and each code can appear only once.

`link` and `list-groups` need the service to be stopped (the first time it is not installed yet, so that is fine).

**Optional, to load recent history for the pilot groups:** WhatsApp sends recent history only when a device is first linked. To get it:

1. On the founder's phone open Settings > Linked devices and remove the old "WA Agent" device.
2. Run `npm run cli -- link --reset`. It asks you to type `yes`. It deletes only the saved WhatsApp link, not your tracker data.
3. Scan the new QR code.

This is optional. Without it the tracker starts from today.

## 6. Install and start the service (admin)

1. Download **WinSW-x64.exe** version 2.12.0 from github.com/winsw/winsw/releases/tag/v2.12.0 and save it as `C:\wa-agent\deploy\winsw\wa-agent.exe`.
2. Install it:

```bat
cd /d C:\wa-agent\deploy\winsw
wa-agent.exe install
```

3. Open `services.msc` > **WA Agent** > Log On > This account: `.\waagent` with its password. (This keeps the password out of command history and grants "Log on as a service".)
4. Lock down the data folder, then start:

```bat
icacls C:\wa-agent\data /inheritance:r /grant:r "waagent:(OI)(CI)F" "Administrators:(OI)(CI)F" "SYSTEM:(OI)(CI)F"
net start wa-agent
```

5. Check from the waagent window: `npm run cli -- status`. Logs are in `C:\wa-agent\deploy\winsw\`.
6. **After `google-auth` or any change to `.env`, restart the service** so it picks the change up:

```bat
net stop wa-agent
net start wa-agent
```

Stopping can take up to 2.5 minutes if the agent is finishing an AI call. That is normal. Wait for it.

7. In Google Drive (mailbox account), share the **WA Agent** folder with team members only, never clients. Share the **folder**, not the `Tracker.xlsx` file. If the file is ever re-created, people who have the folder still reach it.

### Google Drive: do not use the Bin

Do not move the "WA Agent" folder or `Tracker.xlsx` to the Bin (trash). Drive keeps accepting updates to a binned file, so the tracker would look frozen with no error.

- If it happens: restore both from the Bin.
- If the folder or file was deleted for good: the agent creates a new one on its next update. The old shared link stops working, so share the new folder again.

## 7. Pilot week

- Keep only 1-2 groups in the allow-list.
- Every day, open `Tracker.xlsx` in Drive and compare it with what the team knows. Note every wrong task, missing task or wrong role.
- Fix mistakes with the commands below. If the same kind of mistake repeats, tune the prompt and re-run the golden check (ask before the paid run).
- **Check that the founder never looks "online" because of the agent.** From another phone, look at the founder's WhatsApp contact while his own phone is locked. He must not show "online". If he does, stop the service (`net stop wa-agent`) and report it. The cause would be a presence update sent by the WhatsApp library (Baileys, when its credentials change); the fix is a small patch to it.
- After a clean week, add the remaining groups to `config\allowed-groups.json`. The service picks up the change within seconds; no restart needed.

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
- **`person set <number> <team|client>`**: use the full number with country code and no `+` or spaces (for example `919812345678`), or the WhatsApp id shown in the people list. Add `--client ABC` to change the role in one client group only.
- **`task unlock`** and **`phase unlock`** let the AI change that task or phase again.
- **`rebuild`** shows up in Drive within about a minute (a 30-second check, then a 60-second upload wait).
- **`reprocess <client> --since <date> [--until <date>]`** sends old messages to the AI again. This **costs money** and counts toward the daily cap, so keep the date range short. Above 200 messages it only shows the count and the most it could cost; add `--yes` to run it. It will not re-create tasks you closed.
- **Limit of `reprocess`:** it will not create a second task from a message that already produced one. If the AI missed a second piece of work in an old message, add a note to an existing task with `task edit <code> --latest-progress "..."`, or tell the team. There is no "task add" command yet.

## What the status line means

The status line is the first line on the Overview tab and the top of `npm run cli -- status`.

| What you see | What it means | What to do |
|---|---|---|
| Connected, last update (time) | All good. | Nothing. |
| Connected, waiting for new messages | All good, no messages processed yet since the start. | Nothing. |
| WhatsApp unlinked since (time) | The founder removed the linked device, or WhatsApp logged it out. | Stop the service. In the waagent window run `npm run cli -- link --reset`, scan the QR code, start the service. |
| Another copy of WA Agent took over the WhatsApp session | Another copy of the agent, or WhatsApp Web on another computer, took the linked-device slot. | Find and stop the other copy, then restart the service. Do **not** reset the link. |
| WhatsApp refused this number (403) | WhatsApp blocked this device. | Look at the founder's phone for a WhatsApp warning. Do not reset the link. |
| Disconnected since (time) | No WhatsApp connection for over 30 minutes. | Check the PC's internet. The agent reconnects by itself. If it stays down, restart the service. |
| Google sign-in expired | Drive no longer lets the agent in. | Run `npm run cli -- google-auth`, then restart the service. |
| The WhatsApp session could not be saved | The agent cannot write its session to disk. | Check free disk space and the permissions on `C:\wa-agent\data`. |
| Tracker update failing since (time) | The Excel file has not reached Drive for over an hour. | Check the internet and that the Drive folder is not in the Bin. If it stays, read the logs. |
| Daily spend cap reached. Paused until midnight IST | The AI budget for today is used up. Messages are saved and processed later. | Wait for midnight India time. Raise `DAILY_SPEND_CAP_USD` in `.env` and restart the service only if the higher spend is intended. |
| (number) groups waiting (AI error) | The AI call failed for some groups. Nothing is lost. | Wait: failed batches retry every hour. If it persists, read the logs and run `status`. |
| Low disk: (number) GB free | Under 10 GB left. | Free up disk space. |

## If the service will not start

First look at the error log: `C:\wa-agent\deploy\winsw\wa-agent.err.log`. The last line names the problem. (`status` cannot show it, because the service stops before it writes a report.) Then find it below.

### MASTER_KEY_UNREADABLE

- **Meaning:** the agent cannot read its master key (the key that protects the WhatsApp session and the Google sign-in). Usually an admin reset the waagent account or its password, or the key file was copied from another PC.
- **What to do:**
  1. Stop the service: `net stop wa-agent`.
  2. Read the last line of `wa-agent.err.log` to confirm the code.
  3. Only after checking with the person responsible, **move** (do not delete) `data\keys\master.key.dpapi` and `data\session.db` to a dated backup folder, for example `C:\wa-agent-backup-2026-10-21`.
  4. Re-link WhatsApp: `npm run cli -- link --reset`.
  5. Sign in to Google again: `npm run cli -- google-auth`.
  6. Start the service: `net start wa-agent`.
- **Result:** the tracker database is kept. Only the WhatsApp link and the Google sign-in are recreated.

### SessionDecryptError ("wrong key for this session")

- **Meaning:** the saved WhatsApp session was locked with a different master key.
- **What to do:** run `npm run cli -- link --reset` and scan the new QR code. Do **not** move the master key: that would also break the saved Google sign-in.

### TokenDecryptError ("Stored Google sign-in cannot be read")

- **Meaning:** the saved Google sign-in was locked with a different master key.
- **What to do:** run `npm run cli -- google-auth` again, then restart the service. Nothing else is lost.

### Status "replaced"

- **Meaning:** another copy of the agent, or WhatsApp Web on another computer, took over the linked-device slot.
- **What to do:** find and stop the other copy. **Do not reset the session**: that does not help and forces a new QR scan.

### Status "logged_out"

- **Meaning:** the founder removed the linked device from his phone.
- **What to do:** stop the service, run `npm run cli -- link --reset` (first remove the old "WA Agent" device on his phone, then type `yes` when asked), scan the QR code, start the service.

## Other problems

- **A command says the agent is already running:** `link` and `list-groups` need the service stopped. Run `net stop wa-agent`, do the command, then `net start wa-agent`.
- **"Allow-list file missing":** create `config\allowed-groups.json` containing `{ "clients": [] }`, then follow step 5.
- **"still contains the example group":** the file was copied from the example. Set it back to `{ "clients": [] }` and run `list-groups` to get real ids.
