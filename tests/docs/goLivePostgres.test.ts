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
const confirmBox = guide.slice(guide.indexOf('> **To confirm at S2.**'), guide.indexOf('\n---\n'));

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
    expect(guide).toContain('never** `*:5432`');
    for (const host of guide.matchAll(/ -h (\S+)/g)) expect(host[1]).toBe('127.0.0.1');
    const plists = [...guide.matchAll(/<plist version="1\.0">([\s\S]*?)<\/plist>/g)].map((m) => m[1]!);
    expect(plists).toHaveLength(2);
    for (const p of plists) expect(p).toContain('<key>UserName</key>\n     <string>waagent</string>');
    expect(guide).toContain('Do **not** run `brew services start postgresql@17`');
  });

  it('holds no secret: every database address is a placeholder on 127.0.0.1, and no key or token appears', () => {
    const urls = [...guide.matchAll(/postgres:\/\/[^\n`]+/g)].map((m) => m[0].trim()); // placeholders hold spaces
    expect(urls).toHaveLength(4);
    for (const u of urls) expect(u).toMatch(/^postgres:\/\/wa_(app|platform|owner|backup):<(app|platform|owner|backup) password>@127\.0\.0\.1:5432\/wa_agent$/);
    // The nightly dump reads only its own password file, as the read-only wa_backup role, never the agent's .env.
    expect(guide).toContain('127.0.0.1:5432:wa_agent:wa_backup:<backup password>');
    expect(guide).toContain('pg_dump -h 127.0.0.1 -U wa_backup');
    expect(guide).not.toContain(':postgres:<'); // no superuser password file
    expect(guide).not.toMatch(/sk-ant|[0-9a-f]{32,}|[A-Za-z0-9+/]{40,}={0,2}/);
  });

  it('says when to use each way back, and never sends a secret to Claude', () => {
    expect(guide).toMatch(/### A\. Flip back to SQLite[\s\S]*\*\*Use it when:\*\*/);
    expect(guide).toMatch(/### B\. Bring the Postgres days back to SQLite[\s\S]*\*\*Use it when:\*\*/);
    expect(guide).toContain('**Never send** the `.env` file, `~/.pgpass`, a password, a dump, or a database file.');
  });
});
