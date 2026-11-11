import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// docs/GO-LIVE-postgres.md is the owner's guide for the switch to Postgres on the Mac (plan 2026-10-29-saas-s3-s6.md,
// task S6.1). These checks keep it honest as the code moves: the commands it names exist (or are listed as still to
// confirm at S2), the service commands match SETUP-mac.md, Postgres stays on 127.0.0.1, and no secret is in it.

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const guide = read('docs/GO-LIVE-postgres.md');
const cli = read('src/cli.ts');

/** The commands S2 and S3 bring; the guide lists them under "To confirm at S2" until they exist. */
const S2_COMMANDS = ['db-bootstrap', 'db-migrate', 'migrate-to-postgres', 'export-to-sqlite'];
const confirmBox = guide.slice(guide.indexOf('> **Checked against the code**'), guide.indexOf('\n---\n'));

describe('GO-LIVE-postgres.md', () => {
  it('names only CLI commands that exist, or that it lists as still to confirm at S2', () => {
    const named = [...new Set([...guide.matchAll(/npm run cli -- ([a-z][a-z-]*)/g)].map((m) => m[1]!))];
    expect(named.length).toBeGreaterThan(4);
    for (const c of named) {
      const registered = cli.includes(`.command('${c}')`);
      expect(registered || (S2_COMMANDS.includes(c) && confirmBox.includes(`\`${c}\``)), c).toBe(true);
    }
  });

  it("stops and starts the agent exactly as SETUP-mac.md does, with the agent's real service label", () => {
    const mac = read('docs/SETUP-mac.md');
    expect(read('deploy/macos/com.wa-agent.plist')).toContain('<string>com.wa-agent</string>');
    for (const cmd of [
      'sudo launchctl disable system/com.wa-agent',
      'sudo launchctl bootout system/com.wa-agent',
      'sudo launchctl enable system/com.wa-agent',
      'sudo launchctl bootstrap system /Library/LaunchDaemons/com.wa-agent.plist',
      'sudo launchctl kickstart -k system/com.wa-agent',
    ]) {
      expect(guide, cmd).toContain(cmd);
      expect(mac, cmd).toContain(cmd);
    }
  });

  it('keeps Postgres on 127.0.0.1, run by waagent, with scram passwords', () => {
    expect(guide).toContain("listen_addresses = '127.0.0.1'");
    expect(guide).toContain('--auth=scram-sha-256');
    expect(guide).toContain('never** `*:<port>`');
    for (const host of guide.matchAll(/ -h (\S+)/g)) expect(host[1]).toBe('127.0.0.1');
    const plists = [...guide.matchAll(/<plist version="1\.0">([\s\S]*?)<\/plist>/g)].map((m) => m[1]!);
    expect(plists).toHaveLength(2);
    for (const p of plists) expect(p).toContain('<key>UserName</key>\n     <string>waagent</string>');
    expect(guide).toContain('Do **not** run `brew services start postgresql@17`');
  });

  it('holds no secret: every database address is a placeholder on 127.0.0.1, and no key or token appears', () => {
    const urls = [...guide.matchAll(/postgres:\/\/[^\n`]+/g)].map((m) => m[0].trim()); // placeholders hold spaces
    expect(urls).toHaveLength(3);
    for (const u of urls) expect(u).toMatch(/^postgres:\/\/wa_(app|platform|owner):<(app|platform|owner) password>@127\.0\.0\.1:<port>\/wa_agent$/);
    // The nightly dump reads only its own password file, as the read-only wa_backup role; its password is never in the
    // agent's .env (lane A's S2 decision, b405561).
    expect(guide).not.toContain('DATABASE_BACKUP_URL=');
    expect(guide).toContain('127.0.0.1:<port>:wa_agent:wa_backup:<backup password>');
    expect(guide).toContain('pg_dump -h 127.0.0.1 -p <port> -U wa_backup');
    expect(guide).not.toContain(':postgres:<'); // no superuser password file
    expect(guide).not.toMatch(/sk-ant|[0-9a-f]{32,}|[A-Za-z0-9+/]{40,}={0,2}/);
  });

  it('turns the customer parts on only by a deliberate switch, after Google knows the sign-up address', () => {
    const part7 = guide.slice(guide.indexOf('## Part 7.'), guide.indexOf('## Part 8.'));
    expect(part7).toContain('PLATFORM_ENABLED=true');
    expect(part7).toContain('**off**, and they stay off by default');
    // The redirect URI is step 1; the switch is step 4.
    expect(part7.indexOf('<DASHBOARD_PUBLIC_URL>/signup/callback')).toBeLessThan(part7.indexOf('PLATFORM_ENABLED=true'));
    expect(part7).toContain('**What changes when `PLATFORM_ENABLED` is on:**');
    expect(part7).toContain('**To turn the customer parts off again:**');
    expect(guide).toContain('`PLATFORM_ENABLED` (off by default, part 7)');
    // The Gmail API is enabled in Google before the switch, with what fails without it (settled 30 Oct).
    expect(part7.indexOf('find "Gmail API" and press **Enable**')).toBeGreaterThan(-1);
    expect(part7.indexOf('find "Gmail API" and press **Enable**')).toBeLessThan(part7.indexOf('PLATFORM_ENABLED=true'));
    expect(part7).toContain('Gmail API has not been used in project');
    // The optional name on invites, a placeholder only, with its default said.
    expect(part7).toContain("`PLATFORM_FOUNDER_NAME=<your name or your business's name>`");
    expect(guide).toContain('`PLATFORM_FOUNDER_NAME` (optional, default "WA Agent")');
  });

  it('has nothing left to confirm, and quotes the status line the code prints (src/store/open.ts databaseLine)', () => {
    expect(guide).not.toContain('confirm at S2');
    expect(confirmBox).toContain('> **Checked against the code**');
    expect(guide).toContain('`Database: SQLite (data/tracker.db)`');
    expect(guide).toContain('`Database: Postgres (127.0.0.1:<port>/wa_agent as wa_app)`');
    expect(read('src/store/open.ts')).toContain("`Database: Postgres (${u.hostname}:${u.port || '5432'}${decodeURIComponent(u.pathname)} as ${decodeURIComponent(u.username)})`");
  });

  it('names the port wherever it connects: 5433 on the office Mac, never the ATP server’s 5432 (November release)', () => {
    expect(guide).toContain("On the office Mac, WA Agent's own Postgres is on **5433**");
    expect(guide).toContain('never point anything of WA Agent\'s at 5432');
    expect(guide).toContain('echo "port = <port>" >> /opt/wa-agent-db/data/postgresql.conf');
    // Every command that connects (pg_isready, createdb, pg_restore, psql, dropdb, pg_dump) names the port.
    const connecting = [...guide.matchAll(/\b(pg_isready|createdb|pg_restore|psql|dropdb|pg_dump) -h 127\.0\.0\.1( -p <port>)?/g)];
    expect(connecting.map((m) => m[1])).toEqual(expect.arrayContaining(['pg_isready', 'createdb', 'pg_restore', 'psql', 'dropdb', 'pg_dump']));
    for (const m of connecting) expect(m[2], m[0]).toBe(' -p <port>');
    for (const m of guide.matchAll(/ -h 127\.0\.0\.1( -p <port>)?/g)) expect(m[1], m[0]).toBe(' -p <port>');
    expect(guide).not.toContain('127.0.0.1:5432');
  });

  it('locks the data-folder zip to its owner: it holds the WhatsApp logins and the keys', () => {
    const zips = [...guide.matchAll(/sudo ditto -c -k --sequesterRsrc --keepParent \/opt\/wa-agent\/data "\$Z"\n\s*sudo chmod 600 "\$Z"/g)];
    expect(zips).toHaveLength(3); // 4.3, part 9 and part 11
    expect(guide.match(/sudo ditto /g)).toHaveLength(3);
  });

  it('carries every phone’s session file (session-2 to session-5) in the copies and in rollback B', () => {
    const files = 'for f in tracker session session-2 session-3 session-4 session-5 sender-session; do [ -f data/$f.db ] && ';
    expect(guide).toContain(`${files}sqlite3 data/$f.db ".backup '/opt/wa-agent-db/rehearsal/$f.db'"`);
    expect(guide).toContain(`${files}sqlite3 data/$f.db ".backup '/opt/wa-agent-db/sqlite-before-postgres/$f.db'"`);
    const b = guide.slice(guide.indexOf('### B. Bring the Postgres days back to SQLite'), guide.indexOf('## Part 7.'));
    expect(b).toContain(`${files}mv data/$f.db* /opt/wa-agent-db/sqlite-before-rollback/`); // -wal and -shm too, moved, not deleted
    expect(b).not.toMatch(/\brm\b/);
    expect(guide.match(/for f in /g)).toHaveLength(3);
  });

  it('updates to the November release in a safe order, and says a revert alone is not enough on Postgres', () => {
    const part9 = guide.slice(guide.indexOf('## Part 9.'), guide.indexOf('## Part 10.'));
    const at = (s: string) => {
      expect(part9, s).toContain(s);
      return part9.indexOf(s);
    };
    // Stopped and backed up before the merge; the dump kept under its own name and checked; then the update.
    expect(at('sudo launchctl bootout system/com.wa-agent')).toBeLessThan(at('sudo launchctl kickstart system/com.wa-agent.pgdump'));
    expect(at('/opt/wa-agent-db/before-november.dump')).toBeLessThan(at('git pull --ff-only'));
    expect(at('pg_restore -l /opt/wa-agent-db/before-november.dump')).toBeLessThan(at('git pull --ff-only'));
    expect(at('git pull --ff-only')).toBeLessThan(at('npm ci'));
    expect(at('npm ci')).toBeLessThan(at('npm run cli -- db-migrate'));
    expect(at('`Applied P6`, then `Applied P7`, then `Access rules checked: …`')).toBeLessThan(at('sudo launchctl bootstrap system /Library/LaunchDaemons/com.wa-agent.plist'));
    expect(part9).toContain('putting the old version back is **not** enough by itself');
    expect(part9).toContain('restore `before-november.dump` into a fresh database');
    expect(read('src/store/pg/migrations.ts')).toMatch(/\{ version: 7, sql: P7_SQL \}/);
    // The phones part: the limits as the code sets them.
    const part10 = guide.slice(guide.indexOf('## Part 10.'), guide.indexOf('## Part 11.'));
    expect(part10).toContain('up to **5 reading phones**');
    expect(part10).toContain('**One link at a time.**');
    expect(read('src/wa/authState.ts')).toContain('export const MAX_PHONES = 5;');
  });

  it('updates to the chat-picture release (P8) with Part 9’s commands, in the same order (11 Nov 2026)', () => {
    const part9 = guide.slice(guide.indexOf('## Part 9.'), guide.indexOf('## Part 10.'));
    const part11 = guide.slice(guide.indexOf('## Part 11.'));
    expect(guide.indexOf('## Part 10.')).toBeLessThan(guide.indexOf('## Part 11.'));
    // Every command block is Part 9's, word for word, with only the dump's name changed.
    const blocks = (part: string) => [...part.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1]!.replace(/^ +/gm, ''));
    expect(blocks(part9).length).toBeGreaterThan(5);
    expect(blocks(part11)).toEqual(blocks(part9).map((b) => b.replaceAll('before-november', 'before-pictures')));
    const at = (s: string) => {
      expect(part11, s).toContain(s);
      return part11.indexOf(s);
    };
    expect(at('**Do steps 1 and 2 before anything is merged.**')).toBeLessThan(at('sudo launchctl bootout system/com.wa-agent'));
    expect(at('pg_restore -l /opt/wa-agent-db/before-pictures.dump')).toBeLessThan(at('git pull --ff-only'));
    expect(at('`Applied P8`, then `Access rules checked: …`')).toBeLessThan(at('sudo launchctl bootstrap system /Library/LaunchDaemons/com.wa-agent.plist'));
    expect(part11).toContain('putting the old version back is **not** enough by itself');
    expect(part11).toContain('restore `before-pictures.dump` into a fresh database');
    expect(read('src/store/pg/migrations.ts')).toMatch(/\{ version: 8, sql: P8_SQL \}/);
    expect(guide).toContain('applies the migrations P1 to P8');
  });

  it('says when to use each way back, and never sends a secret to Claude', () => {
    expect(guide).toMatch(/### A\. Flip back to SQLite[\s\S]*\*\*Use it when:\*\*/);
    expect(guide).toMatch(/### B\. Bring the Postgres days back to SQLite[\s\S]*\*\*Use it when:\*\*/);
    expect(guide).toContain('**Never send** the `.env` file, `~/.pgpass`, a password, a dump, or a database file.');
  });
});
