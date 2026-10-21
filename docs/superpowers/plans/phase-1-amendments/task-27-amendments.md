# Task 27 amendments (controller decisions; apply on top of the task text)

## 1. Service stop timeout must cover the drain
`app.stop()` (Task 22) waits up to 120 s (`drainMs`) for an AI call in flight, then up to 10 s for a Drive upload in flight. That way a result we already paid for is applied, not thrown away and paid for again after a restart. WinSW kills the process when its `stoptimeout` runs out.

In the WinSW service XML, set `<stoptimeout>150 sec</stoptimeout>` (instead of 15 sec).

Note: a Windows system shutdown limits how long services may take to stop, whatever this value says. Nothing is corrupted if the process is killed: SQLite in WAL mode survives, and the OS releases the single-instance pipe.

## 2. SETUP.md: recovery section
Add a section "If the service will not start", covering these cases.

- **`MASTER_KEY_UNREADABLE`**
  - **What it means:** the DPAPI-protected master key cannot be read. Usually the Windows account or its password was reset by an admin, or the key file was copied from another PC.
  - **What to do:**
    1. Stop the service.
    2. Open the service's error log (`wa-agent.err.log` in the WinSW log folder) and check the last line; it shows the code, e.g. `MASTER_KEY_UNREADABLE: ...`. (`status` cannot show this error, because the service stops before it writes a report.)
    3. Only after confirming with the person responsible, move `data/keys/master.key.dpapi` and `data/session.db` to a dated backup folder. Do not delete them.
    4. Re-link WhatsApp: `npm run cli -- link --reset`.
    5. Re-run `npm run cli -- google-auth`.
  - **Consequences:** the tracker database itself is kept. Only the WhatsApp session and the Google token are recreated.
- **`SessionDecryptError` / "wrong key for this session"**
  - **What it means:** the session store was encrypted with a different master key.
  - **What to do:** run `npm run cli -- link --reset` and scan the new QR. Do **not** move the master key: that would also break the saved Google sign-in.
- **`TokenDecryptError` ("Stored Google sign-in cannot be read")**
  - **What it means:** the saved Google sign-in was encrypted with a different master key.
  - **What to do:** run `npm run cli -- google-auth` again. Nothing else is lost.
- **Status `replaced`**
  - **What it means:** another copy of the agent, or WhatsApp Web on another computer, took over the linked-device slot.
  - **What to do:** find and stop the other copy. **Do not reset the session**; resetting does not help and forces a re-link.
- **Status `logged_out`**
  - **What it means:** the founder removed the linked device from his phone.
  - **What to do:** re-link with `npm run cli -- link --reset`.

## 3. SETUP.md: pilot-week check
Add this to "Pilot week": from another phone, check that the founder never shows "online" because of the agent while his phone is locked. If he does, stop the service and report it. Baileys may send a presence update when its credentials change; the fix is a small patch to Baileys.

## 4. SETUP.md: spend
State that the daily cap (DAILY_SPEND_CAP_USD) is a soft cap. In rare cases (calls in flight, fallback models) it can be overshot by a few dollars. Also set a monthly spend limit in the Anthropic console as the hard backstop. That instruction is already in the task text; keep it.

## 5. SETUP.md: Drive folder
- Tell users not to move the "WA Agent" folder or `Tracker.xlsx` to the Bin in Google Drive. Drive keeps accepting updates to a binned file, so the tracker would look stale without any error.
- If it happens, restore both from the Bin. If the folder or file was deleted permanently, the agent re-creates it on the next update, and the old shared link stops working.
- Share the folder, not the file, with the team, so a re-created file stays reachable.

## 6. SETUP.md: first-time allow-list
- Start with `{ "clients": [] }` in `config/allowed-groups.json`. Then run `npm run cli -- list-groups`, copy the ids of the client groups into the file, and pick a permanent 3-letter code for each.
- The example file's placeholder group is rejected on purpose: client codes are permanent, so the example must never be synced.
- After google-auth or any change to `.env`, restart the service (`net stop wa-agent`, then `net start wa-agent`).
- `link --reset` asks for confirmation. Before confirming, remove the old "WA Agent" device on the founder's phone (Settings → Linked devices).
- **Replace the copy step:** in the runbook step that currently says `copy config\allowed-groups.example.json config\allowed-groups.json` and then "empty the list", write the file directly instead: create `config\allowed-groups.json` containing `{ "clients": [] }`. The example file stays as reference only, because its placeholder group id is rejected.

## 7. SETUP.md: everyday corrections (from the Task 25 review)
- `reprocess <client> --since <date> [--until <date>]` sends old messages to the AI again, which costs money and counts toward the daily cap. Keep the range short. Above 200 messages it only shows the count and cost until you add `--yes`. It will not re-create tasks you closed.
- `person set <number> <team|client> [--client <code>]` needs the full number with country code (e.g. 919812345678), or the WhatsApp id shown in the people list.
- `task unlock <code>` and `phase unlock <client>` hand a field or the phase back to the AI after a manual fix.
- `rebuild` shows up in Drive within about a minute: a 30 s check plus the 60 s upload throttle.
- Limits of `reprocess`:
  - It will not create a second task from a message that already produced one. If the AI missed a second piece of work in an old message, add a note to an existing task with `task edit <code> --latest-progress ...`, or tell the team. There is no "task add" command in Phase 1.
