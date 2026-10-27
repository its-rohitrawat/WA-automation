# Going live: the website and the owner dashboard

This guide is for the owner. It puts the website at `https://waagent.agentsolutionbowl.si/` and the owner dashboard at `https://waagent.agentsolutionbowl.si/dashboard`. Both are served by the agent on the office Mac Pro. Nothing is hosted anywhere else. When the Mac is off, the website and the dashboard are both down; the agent picks up where it left off when the Mac is back.

You do every step yourself. Nothing in this guide is run by Claude. Use it once the developer tells you the dashboard version is ready to merge, and do the steps in order: **step 1 comes before the merge**, because the Mac updates itself as soon as the merge lands, and the new version changes the database on its first start.

Commands in `code` are typed in Terminal on the Mac. "The waagent window" means the Terminal window signed in as the `waagent` user, as in `docs/SETUP-mac.md`. Allow about 1 to 2 hours, plus the time Google takes to confirm the domain (step 3).

## 1. Back up the data folder

The `data` folder holds the tracker database, the WhatsApp sessions and the keys. Keep the copy on the Mac, private to `waagent`. Do this before anything is merged.

1. Stop the service safely (normal Terminal window):

   ```
   sudo launchctl disable system/com.wa-agent
   sudo launchctl bootout system/com.wa-agent
   ```

   Then check that it has really stopped:

   ```
   sudo launchctl print system/com.wa-agent
   ```

   It must answer `Could not find service`. If it still shows the service, wait a minute (it can take up to 3 minutes to finish its work) and check again. Do not copy anything while it is still there.

2. In the waagent window, copy the folder (use today's date in the name):

   ```
   cd /opt/wa-agent
   mkdir -p backups/2026-11-01-data
   cp -Rp data/. backups/2026-11-01-data/
   chmod 700 backups/2026-11-01-data
   ```

3. Check that the copy opens and is whole. The first two commands must print the same number; the third must print `ok`:

   ```
   sqlite3 data/tracker.db "select count(*) from tasks"
   sqlite3 backups/2026-11-01-data/tracker.db "select count(*) from tasks"
   sqlite3 backups/2026-11-01-data/tracker.db "pragma integrity_check"
   ```

   If any of them gives an error or something else, do not go on: make the copy again.

4. Leave the service stopped until the end of step 4.

## 2. Get the new version

1. Make sure the Mac's update, every time it runs, does these in this order. The new version adds parts the dashboard needs (fonts, icons, animation files); without `npm ci` the agent starts with the old parts and the dashboard does not load.

   ```
   cd /opt/wa-agent
   git pull --ff-only
   npm ci
   sudo launchctl kickstart -k system/com.wa-agent
   ```

   Run `git pull` and `npm ci` as `waagent` (in the waagent window, or with `sudo -u waagent -H`).

2. Now merge the new version (or ask the developer to), then bring it in yourself in the waagent window:

   ```
   cd /opt/wa-agent
   git pull --ff-only
   npm ci
   ```

   If the update already ran, this changes nothing. Its restart command fails while the service is stopped: that is expected and harmless.

## 3. Google: the web sign-in client

The dashboard signs owners in with Google. It needs its own "Web application" client: the existing desktop client only allows addresses on the Mac itself. The existing Google connections (Drive and the meeting accounts) keep working as they are.

1. Google Cloud Console, the same project as today: **OAuth consent screen → Branding → Authorized domains**: add `agentsolutionbowl.si`. Google first asks you to prove you own it in Google Search Console (a DNS record at your domain provider). This can take from a few minutes to a day. Do the rest of this step after it is confirmed.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
3. Application type: **Web application**. Name: `WA Agent dashboard`.
4. Under **Authorized redirect URIs**, add all four:

   ```
   https://waagent.agentsolutionbowl.si/dashboard/auth/callback
   https://waagent.agentsolutionbowl.si/dashboard/connect/google/callback
   http://localhost:8787/dashboard/auth/callback
   http://localhost:8787/dashboard/connect/google/callback
   ```

5. Create it. Copy the client ID and the client secret straight into `.env` in step 4. Do not paste them anywhere else (no chat, email or document).
6. Keep the publishing status **In production**. Sign-in asks only for the name and email address of the person signing in.

## 4. Settings in `.env`

In the waagent window, open `/opt/wa-agent/.env` and set these. Use your real values in place of the examples; the two Google values are the ones from step 3.

```
DASHBOARD_ENABLED=true
DASHBOARD_PORT=8787
DASHBOARD_PUBLIC_URL=https://waagent.agentsolutionbowl.si
DASHBOARD_OWNER_EMAILS=owner@example.com,second.owner@example.com
DASHBOARD_GOOGLE_CLIENT_ID=your_web_client_id_here
DASHBOARD_GOOGLE_CLIENT_SECRET=your_web_client_secret_here
UPTIMEROBOT_READ_KEY=
```

- `DASHBOARD_OWNER_EMAILS`: the Google accounts that may open the dashboard, separated by commas, in place of the two example addresses. Anyone else is refused. List a second owner, so one account problem never locks everyone out.
- `UPTIMEROBOT_READ_KEY`: optional. A **read-only** API key from UptimeRobot's API settings (never the main API key) shows the uptime history from UptimeRobot. Left empty, the dashboard shows the agent's own up and down history.
- The daily spending limit stays in `.env` only, as today. The dashboard cannot raise it.

Then start the service again (normal Terminal window):

```
sudo launchctl enable system/com.wa-agent
sudo launchctl bootstrap system /Library/LaunchDaemons/com.wa-agent.plist
```

The agent listens on `127.0.0.1:8787` only: nothing on the office network can reach it directly.

## 5. The website files

The website's files come with the code, in the `site` folder of `/opt/wa-agent`, so step 2 brings them. Until they are there, `/` shows a plain "Website not installed" page and the dashboard still works. The website and the dashboard both run only while `DASHBOARD_ENABLED=true`.

## 6. Point the domain at the Mac

The domain must reach the agent on the Mac without opening a port on the office network. One way is a tunnel that runs on the Mac and connects out, for example Cloudflare Tunnel:

1. In the Cloudflare dashboard, create a tunnel with one public hostname: `waagent.agentsolutionbowl.si` → `http://127.0.0.1:8787`. Cloudflare shows an install command with a token.
2. Install the tunnel program (`cloudflared`) on the Mac and run that command with `sudo` (`sudo cloudflared service install <token>`), so it runs as a system service that starts with the Mac, like the agent. Without `sudo` it runs only while someone is signed in.
3. The domain's DNS must be managed where the tunnel provider asks (for Cloudflare Tunnel, at Cloudflare). Moving DNS keeps your email working only if every existing record (MX and others) is copied across: check the list before you switch.
4. Optional extra lock: put Cloudflare Access with Google sign-in in front of `/dashboard` only, so a request never reaches the agent before the owner has signed in.

## 7. Checks

Use Chrome on the Mac for the first two checks (Safari may refuse the sign-in on a `http://localhost` address).

1. On the Mac, open `http://localhost:8787/`: the website (or "Website not installed").
2. Open `http://localhost:8787/dashboard` and sign in with an owner email: the Overview shows the real numbers.
3. From a phone on mobile data (not office Wi-Fi), open `https://waagent.agentsolutionbowl.si/` and `https://waagent.agentsolutionbowl.si/dashboard`, and sign in.
4. Try to sign in with a Google account that is not in `DASHBOARD_OWNER_EMAILS`: it must be refused ("This account can't open the dashboard").
5. In the waagent window, `npm run cli -- status` shows the usual status line, and the tracker in Drive still updates.
6. Stop the service with the two commands at the start of step 1: the website and the dashboard stop answering. Start it again with the two commands at the end of step 4: both come back within a minute, and WhatsApp reconnects by itself.

## Turning it off again

To go back to the agent without a website or dashboard: set `DASHBOARD_ENABLED=false` in `.env` and restart (`sudo launchctl kickstart -k system/com.wa-agent`). The agent carries on as before; the new tables stay and do no harm. Contact the developer before restoring the backup from step 1: restoring it undoes everything recorded since.
