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
    2. Run `npm run cli -- status` and check the error.
    3. Only after confirming with the person responsible, move `data/keys/master.key.dpapi` and `data/session.db` to a dated backup folder. Do not delete them.
    4. Re-link WhatsApp: `npm run cli -- link --reset`.
    5. Re-run `npm run cli -- google-auth`.
  - **Consequences:** the tracker database itself is kept. Only the WhatsApp session and the Google token are recreated.
- **`SessionDecryptError` / "wrong key for this session"**
  - **What it means:** the session store was encrypted with a different master key.
  - **What to do:** same steps as above.
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
