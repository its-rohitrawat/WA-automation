import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INDIAN_MOBILE } from '../../src/config/env.ts';
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
    const step6 = step(6);
    expect(step6).toContain('only while the service is running');
    expect(step6).toContain("refuses if today's report was already sent");
    const step4 = step(4);
    expect(step4).toContain('with no `+` or spaces');
    expect(step4).toContain('refuses to start');
  });

  it('the documented recipient example matches the validation', () => {
    expect(INDIAN_MOBILE.test('919812345678')).toBe(true);
    for (const bad of ['+919812345678', '91 9812345678', '9812345678']) expect(INDIAN_MOBILE.test(bad)).toBe(false);
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
  });
});
