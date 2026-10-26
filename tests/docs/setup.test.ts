import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INDIAN_MOBILE, parseEnv, reportSettings } from '../../src/config/env.ts';
import { SENDER_WARNINGS, UNKNOWN_WARNING } from '../../src/report/scheduler.ts';

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

describe('morning report documentation', () => {
  it('SETUP.md explains setup, the commands and both warnings', () => {
    const setup = read('docs/SETUP.md');
    expect(setup).toContain('\n## Morning report\n');
    for (const text of [
      'npm run cli -- link-sender',
      'npm run cli -- link-sender --reset',
      'npm run cli -- report status',
      'npm run cli -- report send-now',
      'REPORT_ENABLED=true',
      'REPORT_RECIPIENT=your_founder_number_here',
      '### Status "Morning report: unknown, check WhatsApp"',
      '### Status "Morning report: the spare number is not linked"',
      'sender-session.db',
    ]) {
      expect(setup).toContain(text);
    }
  });

  it('SETUP.md asks for the recipient as 91 and the 10-digit Indian mobile', () => {
    const setup = read('docs/SETUP.md');
    const section = setup.slice(setup.indexOf('\n## Morning report\n'), setup.indexOf('\n## Everyday commands'));
    expect(section).toContain('`91` then the 10-digit mobile number (12 digits in all)');
    expect(section).toContain('`919812345678`');
  });

  it('SETUP.md covers a spare-number session that cannot be read', () => {
    const setup = read('docs/SETUP.md');
    expect(setup).toContain("the spare number's saved session cannot be read");
  });

  it('.env.example lists the report settings with empty values', () => {
    const example = read('.env.example');
    for (const name of ['REPORT_ENABLED', 'REPORT_TIME', 'REPORT_DEADLINE', 'REPORT_RECIPIENT']) expect(example).toMatch(new RegExp(`^${name}=$`, 'm'));
  });
});

describe('morning report documentation: safety statements', () => {
  const setup = read('docs/SETUP.md');
  /** From the heading (inclusive) to the next heading of the same or a higher level. */
  const sectionOf = (heading: string): string => {
    const start = setup.indexOf(`\n${heading}`);
    expect(start, heading).toBeGreaterThanOrEqual(0);
    const level = heading.match(/^#+/)![0];
    const rest = setup.slice(start + 1 + heading.length);
    const ends = ['\n## ', ...(level === '###' ? ['\n### '] : [])].map((h) => rest.indexOf(h)).filter((i) => i >= 0);
    return setup.slice(start + 1, start + 1 + heading.length + (ends.length ? Math.min(...ends) : rest.length));
  };
  const report = sectionOf('## Morning report');
  const healthTable = sectionOf('## What the status line means');
  const healthLines = healthTable.split('\n');
  const coreOf = (warning: string): string => warning.replace(/^⚠️ /, '').split(/\. (?=Stop the service|Check|Restart|See)/)[0]!;

  it('says the founder number never sends, the spare number only sends to the recipient, once a day, until the deadline', () => {
    expect(report).toContain('never sends from it');
    expect(report).toContain('The spare number sends only to `REPORT_RECIPIENT`');
    expect(report).not.toMatch(/also sends|any chat/);
    expect(report).toContain('It reads no chats, sends no read receipts, and is online only for the minute it takes to send.');
    expect(report).not.toMatch(/sends read receipts|stays online/);
    expect(report).toContain('only until 12:00 IST');
    expect(report).toContain('never sent twice on one day');
    expect(report).toContain('the number ending …');
    const withoutExample = report.split('\n').filter((line) => !line.includes('`919812345678`')).join('\n');
    expect(withoutExample).not.toMatch(/\b91\d{10}\b/);
  });

  it('says an unknown outcome is never retried by the agent', () => {
    const unknown = sectionOf('### Status "Morning report: unknown, check WhatsApp"');
    expect(unknown).toContain('does **not** try again by itself');
    expect(unknown).toContain("Look at the founder's WhatsApp");
    expect(unknown).toContain('report send-now');
    expect(unknown).toContain("If today's report is not there, run `npm run cli -- report send-now`");
    expect(unknown).toContain('If it is there, do nothing');
    expect(unknown).not.toMatch(/even if/i);
    expect(unknown).not.toMatch(/tries again by itself|retries/);
    const row = healthLines.find((line) => line.startsWith('| Morning report: unknown, check WhatsApp |'));
    expect(row).toBeDefined();
    expect(row).toContain('does not resend it by itself');
  });

  it('setup stops the service before link-sender, send-now needs the running service and refuses a second send', () => {
    const steps = sectionOf('### Setup (about 15 minutes)');
    const step = (n: number) => steps.slice(steps.indexOf(`\n${n}. `), steps.indexOf(`\n${n + 1}. `));
    const step3 = step(3);
    expect(step3).toContain('Stop the service safely');
    expect(step3.indexOf('Stop the service safely')).toBeLessThan(step3.indexOf('link-sender'));
    expect(step3).not.toMatch(/keep the service running/i);
    expect(step3).toContain('from the **spare** phone');
    expect(step3).toContain("not from the founder's phone");
    expect(step3).not.toMatch(/from the \*\*founder/);
    const step6 = step(6);
    expect(step6).toContain('only while the service is running');
    expect(step6).toContain("refuses if today's report was already sent");
    const step4 = step(4);
    expect(step4).toContain('with no `+` or spaces');
    expect(step4).toContain('refuses to start');
  });

  it('the documented recipient example matches the validation', () => {
    const example = report.match(/for example `(\d+)`/);
    expect(example).not.toBeNull();
    expect(INDIAN_MOBILE.test(example![1]!)).toBe(true);
  });

  it('the documented times are the code defaults', () => {
    const { time, deadline } = reportSettings(parseEnv({}));
    expect(report).toContain(`Every day at ${time} IST`);
    expect(report).toContain(`empty for ${time} and ${deadline} IST`);
    expect(report).toContain(`only until ${deadline} IST`);
  });

  it('turning the report off is a setting, never deleting the session', () => {
    const off = sectionOf('### Turning it off');
    expect(off).toContain('REPORT_ENABLED=false');
    expect(off).not.toMatch(/delete|\bdel\b|sender-session\.db/i);
  });

  it('the command table lists the three report commands', () => {
    const commands = sectionOf('## Everyday commands (run in the waagent window)');
    expect(commands).toContain('| `npm run cli -- report status` |');
    expect(commands).toContain('| `npm run cli -- report send-now` |');
    const linkRow = commands.split('\n').find((line) => line.startsWith('| `npm run cli -- link-sender` |'));
    expect(linkRow).toBeDefined();
    expect(linkRow).toContain('(stop the service first)');
  });

  it('the Health table has a row for every morning-report warning the code can show', () => {
    const warnings = [UNKNOWN_WARNING, ...Object.values(SENDER_WARNINGS)];
    expect(warnings.length).toBe(6);
    for (const warning of warnings) {
      const core = coreOf(warning);
      expect(core.startsWith('Morning report: '), warning).toBe(true);
      expect(healthLines.some((line) => line.startsWith(`| ${core} |`)), core).toBe(true);
    }
  });

  it('a damaged spare-number session is moved aside, not only reset', () => {
    const notLinked = sectionOf('### Status "Morning report: the spare number is not linked"');
    expect(notLinked).toContain('npm run cli -- link-sender --reset');
    expect(notLinked).toContain('different master key');
    expect(notLinked).toContain('move C:\\wa-agent\\data\\sender-session.db* ');
    expect(notLinked).toContain('mkdir C:\\wa-agent\\backups\\');
    expect(notLinked).toContain('**Replaced:**');
    expect(notLinked).not.toMatch(/\bdel\b|delete the/i);
    expect(notLinked).toContain("the founder's `session.db` files stay where they are");
    expect(notLinked).not.toMatch(/(move|copy) C:\\wa-agent\\data\\(\*|session\.db)/i);
  });

  it('each spare-number recovery bullet stops the service, links from the spare phone and copies before a reset', () => {
    const notLinked = sectionOf('### Status "Morning report: the spare number is not linked"');
    expect(notLinked).not.toMatch(/keep the service running/i);
    expect(notLinked).not.toMatch(/scan from the founder|on the founder's phone/i);
    const bullet = (label: string): string => {
      const start = notLinked.indexOf(`\n- **${label}`);
      expect(start, label).toBeGreaterThanOrEqual(0);
      const end = notLinked.indexOf('\n- **', start + 1);
      return notLinked.slice(start, end >= 0 ? end : undefined);
    };
    const copy = 'copy C:\\wa-agent\\data\\sender-session.db* C:\\wa-agent\\backups\\';

    const notLinkedBullet = bullet('Not linked:**');
    const stop = notLinkedBullet.toLowerCase().indexOf('stop the service');
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(stop).toBeLessThan(notLinkedBullet.indexOf('link-sender'));
    expect(notLinkedBullet).toContain('scan from the spare phone');

    const loggedOut = bullet('Logged out**');
    expect(loggedOut).toContain('Stop the service');
    expect(loggedOut).toContain('link-sender --reset');
    expect(loggedOut).toContain('scan from the spare phone');
    expect(loggedOut).toContain(copy);
    expect(loggedOut.indexOf(copy)).toBeLessThan(loggedOut.indexOf('link-sender --reset'));

    const unreadable = bullet(`"the spare number's saved session cannot be read"**`);
    expect(unreadable).toContain('Stop the service safely');
    expect(unreadable).toContain(copy);
    expect(unreadable.indexOf(copy)).toBeLessThan(unreadable.indexOf('link-sender --reset'));
    expect(unreadable).toContain('move C:\\wa-agent\\data\\sender-session.db* ');
  });

  it('a takeover of the spare number points at another copy of the agent, not link-sender', () => {
    const notLinked = sectionOf('### Status "Morning report: the spare number is not linked"');
    const replaced = notLinked.slice(notLinked.indexOf('\n- **Replaced:**'));
    expect(replaced).toContain('no other copy of the agent');
    expect(replaced).not.toContain('link-sender');
    const row = healthLines.find((line) => line.startsWith('| Morning report: another session took over the spare number |'));
    expect(row).toBeDefined();
    expect(row).toContain('Another copy of the agent');
    expect(row).not.toContain('link-sender');
  });
});
