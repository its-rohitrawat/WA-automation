# Going live on Postgres (the Mac)

This guide moves WA Agent's data from its SQLite files to Postgres on the Mac, so more than one business can use it,
each kept apart. You run every step yourself, on the Mac, with the Mac assistant's help. Claude never changes the Mac.

- **Time:** about 30 minutes to install (once). A rehearsal takes about 15 minutes, with no downtime. The switch takes
  about 30 minutes of downtime. Choose a quiet evening, not before a morning report you rely on.
- **Nothing is deleted.** The SQLite files are only read, and stay exactly as they were. You can go back at any time
  (part 6).
- **Two windows,** as in [SETUP-mac.md](SETUP-mac.md):
  - the **waagent window** (`sudo -u waagent -i`, then `cd /opt/wa-agent`) for every `npm run cli -- …` command and every
    edit of `.env`;
  - a **normal Terminal window** for `brew` and `sudo launchctl …`.
- **Placeholders** look like `<this>`. Replace each one, including the `<` and `>`. Never paste a password into a chat,
  an email or a screenshot.

> **To confirm at S2.** Some names below are fixed only when the Postgres code (S2) is finished, at its last step
> (S2.10). Each place is marked **[confirm at S2]**. Check these against the released version before the evening of
> the switch:
> - the commands `db-bootstrap`, `db-migrate`, `migrate-to-postgres` and `export-to-sqlite`;
> - that `db-bootstrap` asks for the `postgres` password, then the backup password twice, and shows nothing as you type
>   (it never takes a password on the command line);
> - the `.env` names `DB_ENGINE`, `DATABASE_URL`, `DATABASE_OWNER_URL` and `DATABASE_PLATFORM_URL` (the backup password
>   is never in `.env`);
> - the role names `wa_owner`, `wa_app`, `wa_platform` and `wa_backup`, and the migrations P1 to P3;
> - the switch for the customer parts, `PLATFORM_ENABLED` (off by default, part 7);
> - the `status` line that names the database engine.

---

## Part 1. Install Postgres 17 (once, about 20 minutes)

Postgres runs on this Mac only, at `127.0.0.1`, and starts at boot as the `waagent` user, like the agent itself. Nothing
outside the Mac can reach it.

1. **Install** (normal window):

   ```sh
   brew install postgresql@17
   ls /usr/local/opt/postgresql@17/bin/postgres
   ```

   You should see the path printed back. Do **not** run `brew services start postgresql@17`: that would start a
   second copy under your own account. The service in step 5 is the one that runs.

2. **A folder for the database**, outside the code folder, so updates never touch it (normal window):

   ```sh
   sudo mkdir -p /opt/wa-agent-db
   sudo chown waagent:staff /opt/wa-agent-db
   sudo chmod 700 /opt/wa-agent-db
   ```

3. **Make the `postgres` superuser password** (normal window): `openssl rand -hex 24`. Save it in your password
   manager as "WA Agent Postgres superuser". You need it in step 4, in part 2 and for the restore test in part 5.

4. **Create the database cluster** (waagent window). It asks for the password from step 3, twice, and shows nothing
   as you type:

   ```sh
   /usr/local/opt/postgresql@17/bin/initdb -D /opt/wa-agent-db/data -U postgres --pwprompt --auth=scram-sha-256 --encoding=UTF8 --locale=C
   echo "listen_addresses = '127.0.0.1'" >> /opt/wa-agent-db/data/postgresql.conf
   ```

   You should see `Success. You can now start the database server`.

   Then check who may connect:

   ```sh
   grep -vE '^\s*(#|$)' /opt/wa-agent-db/data/pg_hba.conf
   ```

   Every line must end in `scram-sha-256`, and the addresses must be only `127.0.0.1/32` and `::1/128` (plus `local`
   lines). If you see anything else, stop and ask.

5. **The service** (normal window). Create the file with `sudo nano /Library/LaunchDaemons/com.wa-agent.postgres.plist`,
   paste this, and save:

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key>
     <string>com.wa-agent.postgres</string>
     <key>UserName</key>
     <string>waagent</string>
     <key>GroupName</key>
     <string>staff</string>
     <key>ProgramArguments</key>
     <array>
       <string>/usr/local/opt/postgresql@17/bin/postgres</string>
       <string>-D</string>
       <string>/opt/wa-agent-db/data</string>
     </array>
     <key>RunAtLoad</key>
     <true/>
     <key>KeepAlive</key>
     <true/>
     <key>StandardErrorPath</key>
     <string>/opt/wa-agent-db/postgres.log</string>
   </dict>
   </plist>
   ```

   Then:

   ```sh
   sudo chown root:wheel /Library/LaunchDaemons/com.wa-agent.postgres.plist
   sudo chmod 644 /Library/LaunchDaemons/com.wa-agent.postgres.plist
   sudo launchctl bootstrap system /Library/LaunchDaemons/com.wa-agent.postgres.plist
   ```

6. **Check it** (normal window), after 10 seconds:

   ```sh
   /usr/local/opt/postgresql@17/bin/pg_isready -h 127.0.0.1
   sudo lsof -nP -iTCP:5432 -sTCP:LISTEN
   ```

   You should see:
   - `127.0.0.1:5432 - accepting connections`;
   - one listening line with `127.0.0.1:5432`, and **never** `*:5432`.

   If you see `*:5432`, Postgres is open to the network: stop it with
   `sudo launchctl bootout system/com.wa-agent.postgres` and ask.

## Part 2. The roles and the empty database (once, about 10 minutes)

The agent and its jobs connect with their own limited roles, never the superuser:
- `wa_app`, for the customers' data, which row level security keeps apart;
- `wa_platform`, for the customers list and invites;
- `wa_owner`, which owns the tables and runs the upgrades;
- `wa_backup`, which may only read, for the nightly backup (part 5).

**[confirm at S2]**

1. **Make four passwords** (normal window), each with `openssl rand -hex 24`. Save them in your password manager as
   "WA Agent Postgres app", "… platform", "… owner" and "… backup". Hex keeps them safe inside an address.

2. **Add three of them to `.env`** (waagent window, `nano .env`). Add these four lines, with your passwords in place of
   the placeholders. `db-bootstrap` reads them to set those roles' passwords. The backup password does **not** go in
   `.env`: the agent never uses it. Leave `DB_ENGINE` on `sqlite` for now: nothing changes yet. **[confirm at S2]**

   ```env
   DB_ENGINE=sqlite
   DATABASE_URL=postgres://wa_app:<app password>@127.0.0.1:5432/wa_agent
   DATABASE_PLATFORM_URL=postgres://wa_platform:<platform password>@127.0.0.1:5432/wa_agent
   DATABASE_OWNER_URL=postgres://wa_owner:<owner password>@127.0.0.1:5432/wa_agent
   ```

3. **Create the roles and the database** (waagent window). It asks for the `postgres` password from part 1, step 3,
   then for the "… backup" password, twice. It shows nothing as you type:

   ```sh
   npm run cli -- db-bootstrap
   npm run cli -- db-migrate
   ```

   You should see that the four roles and the database `wa_agent` are ready, then `P1, P2, P3 applied`. No password
   is ever printed. **[confirm at S2]**

4. **Check that nothing changed for the agent** (waagent window): `npm run cli -- status`. It is still on SQLite, as
   before.

## Part 3. A rehearsal on a copy (about 15 minutes, no downtime)

This copies a **copy** of today's data into Postgres, checks every table, and then undoes everything (a dry run). The
agent keeps running, and nothing in Postgres or in `data/` changes. Do it a day or two before the switch.

1. **Copy the data** (waagent window). `.backup` makes a consistent copy even while the agent is writing:

   ```sh
   mkdir -m 700 /opt/wa-agent-db/rehearsal
   for f in tracker session sender-session; do [ -f data/$f.db ] && sqlite3 data/$f.db ".backup '/opt/wa-agent-db/rehearsal/$f.db'"; done
   ls -l /opt/wa-agent-db/rehearsal
   ```

   You should see `tracker.db`, `session.db`, and `sender-session.db` if the spare number is linked.

2. **The dry run on the copy** (waagent window). `time` shows how long it took:

   ```sh
   time npm run cli -- migrate-to-postgres --data-dir /opt/wa-agent-db/rehearsal
   ```

   **[confirm at S2]** You should see:
   - one line per table, each ending in `OK`;
   - then `DRY RUN: every table matched. Nothing was written.`

   Write down how long it took: the switch takes about that long, twice over.

   - A `-wal` or `-shm` file may appear beside the copies. That is normal.
   - If any line says `MISMATCH`, nothing was written. Send that report to Claude: the table names and counts only.

3. **Remove the rehearsal copies** (waagent window), the copies only: `rm -r /opt/wa-agent-db/rehearsal`.

## Part 4. The switch (about 30 minutes of downtime)

**4.1 Before you stop.** Open the dashboard and write down:
- the number of clients and of open tasks on the Overview;
- the time of the newest message in Activity.

You compare them in 4.8.

**4.2 Stop the agent** (normal window):

```sh
sudo launchctl disable system/com.wa-agent
sudo launchctl bootout system/com.wa-agent
sudo launchctl print system/com.wa-agent | grep -E 'state'
```

The last command should print nothing, or say it could not find the service. The agent is stopped. Postgres keeps
running.

**4.3 Back up `data/`, twice.**
- A zip of the whole folder (normal window; the date goes in the name):

  ```sh
  sudo ditto -c -k --sequesterRsrc --keepParent /opt/wa-agent/data ~/wa-backup-$(date +%Y%m%d-%H%M).zip
  unzip -l ~/wa-backup-*.zip | tail -3
  ```

  The last line shows the number of files: more than zero.
- A checked copy of each database (waagent window):

  ```sh
  mkdir -m 700 /opt/wa-agent-db/sqlite-before-postgres
  for f in tracker session sender-session; do [ -f data/$f.db ] && sqlite3 data/$f.db ".backup '/opt/wa-agent-db/sqlite-before-postgres/$f.db'"; done
  sqlite3 /opt/wa-agent-db/sqlite-before-postgres/tracker.db "PRAGMA integrity_check"
  ```

  It should say `ok`.

Keep both until at least a week after the switch.

**4.4 The dry run on the real files** (waagent window):

```sh
npm run cli -- migrate-to-postgres
```

Every line should say `OK`, and the last one `DRY RUN … Nothing was written`. **[confirm at S2]**

**4.5 The copy** (waagent window). The tool makes one more backup, checks it against the files, and refuses a folder
that already exists:

```sh
npm run cli -- migrate-to-postgres --apply --backup-dir /opt/wa-agent-db/copy-backup-$(date +%Y%m%d-%H%M)
```

Every line should say `OK`, and the last one `APPLIED`. **[confirm at S2]**

**If any line says `MISMATCH`, nothing was written.** Start the agent again as it was, still on SQLite (4.7), and send
the report to Claude.

**4.6 Switch the engine** (waagent window): `nano .env`, change `DB_ENGINE=sqlite` to `DB_ENGINE=postgres`, and save.
**[confirm at S2]**

**4.7 Start the agent** (normal window):

```sh
sudo launchctl enable system/com.wa-agent
sudo launchctl bootstrap system /Library/LaunchDaemons/com.wa-agent.plist
```

**4.8 Check** (about 10 minutes, after waiting one minute):
1. Waagent window: `npm run cli -- status`. You should see `Health: ✅ Connected…`, the `WhatsApp:` line saying `open`,
   and the database engine `postgres`. **[confirm at S2]**
2. Dashboard: **sign in again.** Sign-in sessions are not copied. The Overview shows the same numbers you wrote down in
   4.1, and Activity's newest message is the same one.
3. Send a short test message in an approved group. It should appear in Activity within a minute.
4. Waagent window: `npm run cli -- rebuild`. The Tracker publishes, and its time on the dashboard moves to now.
5. Settings shows the morning report time as before.

**If a check fails and you can't fix it in a few minutes, use rollback A (part 6) now.**

## Part 5. Nightly backups of Postgres, and a restore test

The dumps hold every business's data: keep them on this Mac only. FileVault protects them at rest.

1. **The password file** for the dumps (waagent window). Run `nano ~/.pgpass`, type this one line with the "… backup"
   password from part 2, and save:

   ```text
   127.0.0.1:5432:wa_agent:wa_backup:<backup password>
   ```

   Then `chmod 600 ~/.pgpass`. Type the password with `nano`, never with `echo`, which would keep it in the shell
   history.

   The dumps run as `wa_backup`, a role that may only read. It still sees every business's rows, which a full backup
   needs: the owner role can't, because row level security applies to it too. The dump job reads only this file, never
   the agent's `.env`. **[confirm at S2]**

2. **The nightly job** (normal window). It runs at 02:30 and keeps one dump per weekday, so seven rolling files:

   ```sh
   sudo mkdir -p /opt/wa-agent-db/backups && sudo chown waagent:staff /opt/wa-agent-db/backups && sudo chmod 700 /opt/wa-agent-db/backups
   sudo nano /Library/LaunchDaemons/com.wa-agent.pgdump.plist
   ```

   Paste and save:

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key>
     <string>com.wa-agent.pgdump</string>
     <key>UserName</key>
     <string>waagent</string>
     <key>ProgramArguments</key>
     <array>
       <string>/bin/sh</string>
       <string>-c</string>
       <string>/usr/local/opt/postgresql@17/bin/pg_dump -h 127.0.0.1 -U wa_backup -Fc -f /opt/wa-agent-db/backups/wa-$(date +%a).dump wa_agent</string>
     </array>
     <key>StartCalendarInterval</key>
     <dict>
       <key>Hour</key>
       <integer>2</integer>
       <key>Minute</key>
       <integer>30</integer>
     </dict>
     <key>StandardErrorPath</key>
     <string>/opt/wa-agent-db/pgdump.log</string>
   </dict>
   </plist>
   ```

   ```sh
   sudo chown root:wheel /Library/LaunchDaemons/com.wa-agent.pgdump.plist
   sudo chmod 644 /Library/LaunchDaemons/com.wa-agent.pgdump.plist
   sudo launchctl bootstrap system /Library/LaunchDaemons/com.wa-agent.pgdump.plist
   sudo launchctl kickstart system/com.wa-agent.pgdump
   ```

   After a minute, `sudo ls -l /opt/wa-agent-db/backups` shows today's `wa-<Day>.dump`, larger than zero.

3. **The restore test**, once right after the switch and then once a month (waagent window). A backup that has never
   been restored is not a recovery plan. The commands that use `-U postgres` ask for the `postgres` password each time.

   ```sh
   B=/usr/local/opt/postgresql@17/bin
   $B/createdb -h 127.0.0.1 -U postgres wa_restore_test
   $B/pg_restore -h 127.0.0.1 -U postgres -d wa_restore_test /opt/wa-agent-db/backups/wa-$(date +%a).dump
   $B/psql -h 127.0.0.1 -U postgres -d wa_restore_test -tAc "select count(*) from messages"
   $B/psql -h 127.0.0.1 -U wa_backup -d wa_agent -tAc "select count(*) from messages"
   $B/dropdb -h 127.0.0.1 -U postgres wa_restore_test
   ```

   The two counts match, or the live one is a little higher if messages came in since the dump. Only the test
   database `wa_restore_test` is dropped, never `wa_agent`.

## Part 6. Going back (rollback)

Neither way deletes anything in Postgres, and you can switch to Postgres again later.

### A. Flip back to SQLite (one minute)

**Use it when:** a check in 4.8 fails, or something is wrong in the first days and you're fine with messages from
the Postgres days not showing for now. They stay in Postgres, and B brings them back if you ever want them.

1. Stop the agent (4.2).
2. Waagent window: `nano .env`, set `DB_ENGINE=sqlite`, and save.
3. Start it (4.7), and check (4.8).

The agent is back exactly where it was at 4.2. If WhatsApp shows as not connected, use **Fix now** on the Overview. Its
link keys may have moved on while it ran on Postgres.

### B. Bring the Postgres days back to SQLite (about 15 minutes)

**Use it when:** you're going back to SQLite for longer than a day or two, and you want the messages and tasks from the
Postgres days with you.

1. Stop the agent (4.2).
2. Waagent window. It writes new files into a new folder, and never into `data/`:

   ```sh
   npm run cli -- export-to-sqlite --out /opt/wa-agent-db/from-postgres-$(date +%Y%m%d-%H%M)
   ```

   Every line should say `OK`. **[confirm at S2]** If any says `MISMATCH`, stop and use A instead.
3. Waagent window: move today's files aside (nothing is deleted), then put the exported ones in place:

   ```sh
   mkdir -m 700 /opt/wa-agent-db/sqlite-before-rollback
   for f in tracker session sender-session; do [ -f data/$f.db ] && mv data/$f.db* /opt/wa-agent-db/sqlite-before-rollback/; done
   cp /opt/wa-agent-db/from-postgres-<date>/*.db data/
   ls -l data/*.db
   ```

4. `nano .env`, set `DB_ENGINE=sqlite`, and save. Start the agent (4.7), and check (4.8).

## Part 7. Turning on customer invites (once, when you are ready)

Until you turn it on, WA Agent is your business only. The customer parts are **off**, and they stay off by default:
there is no Customers or Invite a customer page, no sign-up page, and no entry for them in the dashboard's menu.

You can do this part before or after the switch to Postgres. A business you invite can sign up either way, but its
workspace opens only on Postgres (a business that signs up earlier is told it opens after an upgrade).

Do the steps in this order: Google first (1 to 3), then the switch (4). The sign-up page must not go live before
Google knows its address.

1. **The sign-up address, in Google.** In Google Cloud console, open APIs & Services, then Credentials, then the
   dashboard's web client. Under Authorized redirect URIs, add `<DASHBOARD_PUBLIC_URL>/signup/callback`, for example
   `https://<your dashboard address>/signup/callback`, and save.
   - Without it, an invited business that presses "Continue with Google" gets an error from Google, and cannot sign up.
2. **Test users.** Until Google reviews the app, only test users can sign in to it or receive its emails, up to 100. In
   OAuth consent screen, then Test users, add each business's Gmail address before you invite them.
3. **The Gmail API** (only if you want invites emailed from your Gmail). In APIs & Services, then Library, find
   "Gmail API" and make sure it is enabled. **[confirm at S2]**
4. **Turn the customer parts on.**
   - Waagent window: `nano .env`, add `PLATFORM_ENABLED=true`, and save. **[confirm at S2]**
   - To email invites from your Gmail, also add `INVITES_GMAIL=true`.
   - Normal window: `sudo launchctl kickstart -k system/com.wa-agent`.
   - If you added `INVITES_GMAIL=true`, open Connections in the dashboard, then Google, and reconnect your account once.
     Approve "Send email as you (invites only)".

   **What changes when `PLATFORM_ENABLED` is on:**
   - The menu shows **Customers** and **Invite a customer** under System, for you only.
   - The sign-up page, `<DASHBOARD_PUBLIC_URL>/signup`, answers the links in your invites. Without an invite link it
     shows only that the link does not work.
   - Nothing else changes: your own business, its data and its screens are as before.
5. **Check:**
   - The menu shows Customers and Invite a customer.
   - Make one invite to a test user's address, open its link in a private window, and press "Continue with Google".
     Google's sign-in page opens. You can cancel there; the link still works afterwards.
   - With `INVITES_GMAIL=true`, the Invite a customer screen says the invites are sent from your Gmail. Without it,
     **Copy link** works, and you send the link yourself.

**To turn the customer parts off again:** remove `PLATFORM_ENABLED=true` (or set it to `false`) and restart. The pages
and the menu entries go away, and nothing is deleted: the invites and the businesses are still there when you turn it
on again.

## Part 8. When something looks wrong

Send Claude:
- the report lines from the command (table names, counts, OK or MISMATCH);
- the output of `npm run cli -- status`;
- the last 50 lines of `logs/wa-agent.err.log` (`tail -n 50 logs/wa-agent.err.log` in the waagent window).

**Never send** the `.env` file, `~/.pgpass`, a password, a dump, or a database file.
