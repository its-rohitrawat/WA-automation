import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INDIAN_MOBILE, parseEnv, reportSettings } from '../../src/config/env.ts';
import { describeReport, REASON_TEXT, SENDER_WARNINGS, UNKNOWN_WARNING } from '../../src/report/scheduler.ts';
import type { ReportRow } from '../../src/store/reports.ts';

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
    for (const name of ['REPORT_ENABLED', 'REPORT_TIME', 'REPORT_DEADLINE', 'REPORT_DAYS', 'REPORT_RECIPIENT']) expect(example).toMatch(new RegExp(`^${name}=$`, 'm'));
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
  /** The one sentence allowed to say a file can be deleted: the renamed damaged copies, once the new link works. */
  const damagedMayGo = /`sender-session\.db\.damaged-…` files in `C:\\wa-agent\\data` can be deleted/g;
  /** True when the text tells the owner to delete a file, in any wording, outside "do not delete" and the damaged-copy sentence. */
  const deletesSomething = (text: string): boolean =>
    /\b(del|erase|rd|rmdir|remove-item|rm|delete|deleted|deleting)\b/i.test(text.replace(damagedMayGo, '').replace(/\b(do not|never|not) deleted?\b/gi, ''));
  /** Every move or copy of something under C:\wa-agent\data that is not exactly the spare number's sender-session.db* files. */
  const unsafeDataMoves = (text: string): string[] =>
    [...text.matchAll(/\b(move|copy|xcopy|robocopy|move-item|copy-item) "?C:\\wa-agent\\data\S*/gi)]
      .map((m) => m[0])
      .filter((cmd) => !/^(move|copy) C:\\wa-agent\\data\\sender-session\.db\*$/i.test(cmd));

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
    // send-now works for a result that could not be saved too (it is not refused as "being sent right now")
    expect(unknown).toContain('the result could not be saved and the send has said nothing for over 10 minutes');
    expect(unknown).not.toMatch(/even if/i);
    expect(unknown).not.toMatch(/tries again by itself|retries/);
    expect(unknown.indexOf("Look at the founder's WhatsApp")).toBeLessThan(unknown.indexOf('report send-now'));
    for (const line of unknown.split('\n').filter((l) => l.includes('send-now'))) expect(line).toContain("If today's report is not there");
    const row = healthLines.find((line) => line.startsWith('| Morning report: unknown, check WhatsApp |'));
    expect(row).toBeDefined();
    expect(row).toContain('does not resend it by itself');
    expect(row).toContain('It may have reached the founder');
    expect(row).not.toMatch(/did not reach|run .*send-now/i);
  });

  it('setup stops the service before link-sender, send-now needs the running service and refuses a second send', () => {
    const steps = sectionOf('### Setup (about 15 minutes)');
    const step = (n: number) => {
      const start = steps.indexOf(`\n${n}. `);
      expect(start, `step ${n}`).toBeGreaterThanOrEqual(0);
      const end = steps.indexOf(`\n${n + 1}. `);
      return steps.slice(start, end >= 0 ? end : undefined);
    };
    const step2 = step(2);
    expect(step2).toContain("From the founder's phone");
    expect(step2).toContain('("hi")');
    const step3 = step(3);
    expect(step3).toContain('Stop the service safely');
    expect(step3.indexOf('Stop the service safely')).toBeLessThan(step3.indexOf('link-sender'));
    expect(step3).not.toMatch(/keep the service running/i);
    expect(step3).toContain('from the **spare** phone');
    expect(step3).toContain("not from the founder's phone");
    expect(step3).not.toMatch(/from the \*\*founder/);
    const step6 = step(6);
    expect(step6).toContain('view access to `Tracker.xlsx`');
    expect(step6).toContain("the founder's Google account");
    expect(step6).toContain('the link asks for access');
    const step7 = step(7);
    expect(step7).toContain('only while the service is running');
    expect(step7).toContain("refuses if today's report was already sent");
    expect(step7).toContain('any day, weekends too');
    expect(steps.indexOf('view access to `Tracker.xlsx`')).toBeLessThan(steps.indexOf('report send-now'));
    const step4 = step(4);
    expect(step4).toContain('with no `+` or spaces');
    expect(step4).toContain('refuses to start');
    expect(step4).toContain('`REPORT_DAYS`');
    expect(step4).toContain('`REPORT_DAYS=mon-sat`');
    expect(step4).toContain('`REPORT_DAYS=daily`');
    expect(step(5)).toContain('If the service will not start');
    expect(step(8)).toContain('at least every 14 days');
  });

  it('the documented recipient example matches the validation', () => {
    const example = report.match(/for example `(\d+)`/);
    expect(example).not.toBeNull();
    expect(INDIAN_MOBILE.test(example![1]!)).toBe(true);
  });

  it('the documented times and days are the code defaults', () => {
    const { time, deadline, days } = reportSettings(parseEnv({}));
    expect(days).toBe('weekdays');
    expect(report).toContain(`Monday to Friday at ${time} IST`);
    expect(report).not.toMatch(/Every day at|Sundays included/);
    expect(report).toContain(`empty for ${time} and ${deadline} IST`);
    expect(report).toContain(`only until ${deadline} IST`);
  });

  it('turning the report off is a setting, never deleting the session', () => {
    const off = sectionOf('### Turning it off');
    expect(off).toContain('REPORT_ENABLED=false');
    expect(deletesSomething(off)).toBe(false);
    expect(off).not.toContain('sender-session.db');
  });

  it('the guards catch a delete in any wording and any move of more than the spare-number files', () => {
    for (const bad of [
      'erase C:\\wa-agent\\data\\sender-session.db*',
      'del C:\\wa-agent\\data\\sender-session.db*',
      'delete C:\\wa-agent\\data\\sender-session.db*',
      'rd /s C:\\wa-agent\\data',
      'rmdir C:\\wa-agent\\data',
      'Remove-Item C:\\wa-agent\\data\\sender-session.db',
      'the sender-session.db files can be deleted',
    ]) expect(deletesSomething(bad), bad).toBe(true);
    expect(deletesSomething('Copy (do not delete) the session')).toBe(false);
    expect(deletesSomething('The `sender-session.db.damaged-…` files in `C:\\wa-agent\\data` can be deleted')).toBe(false);
    for (const bad of [
      'move C:\\wa-agent\\data C:\\wa-agent\\backups\\2026-10-21-1430\\moved\\',
      'move C:\\wa-agent\\data\\s*.db* C:\\wa-agent\\backups\\x\\',
      'copy C:\\wa-agent\\data\\* C:\\wa-agent\\backups\\x\\',
      'move C:\\wa-agent\\data\\session.db* C:\\wa-agent\\backups\\x\\',
    ]) expect(unsafeDataMoves(bad), bad).toHaveLength(1);
    expect(unsafeDataMoves('copy C:\\wa-agent\\data\\sender-session.db* C:\\wa-agent\\backups\\x\\')).toEqual([]);
  });

  it('the command table lists the three report commands', () => {
    const commands = sectionOf('## Everyday commands (run in the waagent window)');
    expect(commands).toContain('| `npm run cli -- report status` |');
    const sendNowRow = commands.split('\n').find((line) => line.startsWith('| `npm run cli -- report send-now` |'));
    expect(sendNowRow).toBeDefined();
    expect(sendNowRow).toContain('asks first');
    expect(sendNowRow).toContain('refuses if already sent');
    const linkRow = commands.split('\n').find((line) => line.startsWith('| `npm run cli -- link-sender` |'));
    expect(linkRow).toBeDefined();
    expect(linkRow).toContain('(stop the service first)');
  });

  it('the Health table has a row for every morning-report warning the code can show', () => {
    const warnings = [UNKNOWN_WARNING, ...Object.values(SENDER_WARNINGS)];
    expect(warnings.length).toBe(8);
    for (const warning of warnings) {
      const core = coreOf(warning);
      expect(core.startsWith('Morning report: '), warning).toBe(true);
      expect(healthLines.some((line) => line.startsWith(`| ${core} |`)), core).toBe(true);
    }
  });

  it('a damaged spare-number session is renamed aside by link-sender --reset; nothing is deleted or moved by hand', () => {
    const notLinked = sectionOf('### Status "Morning report: the spare number is not linked"');
    expect(notLinked).toContain('npm run cli -- link-sender --reset');
    expect(notLinked).toContain('different master key');
    expect(notLinked).toContain('sender-session.db.damaged-');
    expect(notLinked).toContain('mkdir C:\\wa-agent\\backups\\');
    expect(notLinked).toContain('**Replaced:**');
    expect(notLinked).toContain("the founder's `session.db` files stay where they are");
    expect(notLinked).not.toMatch(/\bmove C:\\wa-agent\\data/i);
    expect(deletesSomething(report)).toBe(false);
    expect(unsafeDataMoves(report)).toEqual([]);
    expect(report.match(/\bcopy C:\\wa-agent\\data\S*/gi)?.length).toBeGreaterThanOrEqual(3);
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
    const stop = notLinkedBullet.indexOf('stop the service safely');
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(stop).toBeLessThan(notLinkedBullet.indexOf('link-sender'));
    expect(notLinkedBullet).toContain('scan from the spare phone');
    expect(notLinkedBullet).toContain('start the service again');
    expect(notLinkedBullet).toContain('If the service will not start');

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
    expect(unreadable).toContain('sender-session.db.damaged-');
    expect(unreadable).toContain('Another WA Agent process is using this data folder');
    expect(unreadable).toContain('the service is still running. Go back to step 1');
    expect(unreadable).toContain('MASTER_KEY');
    expect(unreadable).toContain('Do not move any files');
    expect(unreadable).toContain('`report status` is clean');

    const refused = bullet('Refused (403) or banned:**');
    expect(refused).toContain('check the spare phone');
    const refusedStop = refused.indexOf('Stop the service safely');
    expect(refusedStop).toBeGreaterThanOrEqual(0);
    expect(refusedStop).toBeLessThan(refused.indexOf(copy));
    expect(refused.indexOf(copy)).toBeLessThan(refused.indexOf('link-sender --reset'));
    expect(refused).toContain('scan from the new spare phone');
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

describe('morning report documentation: short message with the tracker link (27 Oct 2026)', () => {
  const setup = read('docs/SETUP.md');
  const report = setup.slice(setup.indexOf('\n## Morning report\n'), setup.indexOf('\n## Everyday commands'));
  const settings = reportSettings(parseEnv({}));
  const row = (o: Partial<ReportRow>): ReportRow => ({
    date: '2026-10-30',
    status: 'retry',
    detail: null,
    attempts: 1,
    nextAttemptAt: null,
    forced: false,
    createdAt: '2026-10-30T00:30:00.000Z',
    updatedAt: '2026-10-30T00:30:00.000Z',
    ...o,
  });
  /** The rows of the report status table under "Checking it". */
  const statusRows = (): string[] => {
    const checking = report.slice(report.indexOf('\n### Checking it\n'), report.indexOf('\n### ', report.indexOf('\n### Checking it\n') + 1));
    return checking.split('\n').filter((line) => line.startsWith('| Morning report'));
  };

  it('describes the short message with the link and no attachment', () => {
    expect(report).toContain('`Good morning. 5 open tasks, 2 overdue. Today\'s tracker: https://drive.google.com/file/d/…/view`');
    expect(report).toContain('`Good morning. No open tasks. Today\'s tracker: …`');
    expect(report).toContain('No file is attached');
    expect(report).toContain('**Today** tab');
    expect(report).not.toMatch(/Tracker-YYYY-MM-DD|is attached as|attached as/);
  });

  it('names the report days and REPORT_DAYS', () => {
    expect(report).toContain('Monday to Friday');
    expect(report).toContain('No report goes out on Saturday or Sunday');
    expect(report).toContain('`REPORT_DAYS`');
  });

  it('the founder needs view access to Tracker.xlsx, by sharing the folder with his Google account', () => {
    expect(report).toContain('view access to `Tracker.xlsx`');
    expect(report).toContain("the founder's Google account");
    expect(report).toContain('the link asks for access');
    expect(report).toContain('Share the **WA Agent** folder');
  });

  it('the status table lists the weekend line and the no_tracker_link lines exactly as the code writes them', () => {
    const rows = statusRows();
    const has = (text: string) => expect(rows.some((line) => line.startsWith(`| ${text} |`)), text).toBe(true);
    const saturday = describeReport(undefined, new Date('2026-10-31T03:00:00Z'), settings, 'idle');
    expect(saturday).toEqual({ text: 'Morning report: no report today (weekend)', warning: null });
    has(saturday.text);
    const retry = describeReport(row({ detail: 'no_tracker_link', nextAttemptAt: '2026-10-30T00:32:00.000Z' }), new Date('2026-10-30T00:31:00Z'), settings, 'idle');
    expect(retry.text).toBe(`Morning report: not sent yet (${REASON_TEXT.no_tracker_link!}), next try 06:02 IST`);
    has(retry.text.replace('06:02', 'HH:MM'));
    const skipped = describeReport(row({ status: 'skipped', detail: 'no_tracker_link' }), new Date('2026-10-30T07:00:00Z'), settings, 'idle');
    has(skipped.text);
    expect(skipped.text).toBe(`Morning report skipped today (${REASON_TEXT.no_tracker_link!})`);
    has(`Morning report: due at ${settings.time} IST`);
    has('Morning report: sent at HH:MM IST');
  });

  it('SETUP-mac.md section 7 says the same, short', () => {
    const mac = read('docs/SETUP-mac.md');
    const start = mac.indexOf('\n## 7. Morning report');
    expect(start).toBeGreaterThanOrEqual(0);
    const section = mac.slice(start, mac.indexOf('\n## ', start + 1));
    expect(section).toContain('Monday to Friday at 06:00 IST');
    expect(section).toContain('link to the tracker on Google Drive');
    expect(section).toContain('No file is attached');
    expect(section).toContain('`REPORT_DAYS`');
    expect(section).toContain('view access to `Tracker.xlsx`');
    expect(section).toContain("the founder's Google account");
    expect(section).not.toMatch(/Tracker-YYYY-MM-DD|attached as|Excel sheet every morning/);
  });

  it('the spec has the 27 Oct 2026 amendment with D1 to D4', () => {
    const spec = read('docs/superpowers/specs/2026-10-23-morning-report-design.md');
    const amendment = spec.slice(spec.indexOf('\n## Amendment, 27 Oct 2026\n'));
    expect(spec).toContain('\n## Amendment, 27 Oct 2026\n');
    for (const d of ['**D1', '**D2', '**D3', '**D4']) expect(amendment).toContain(d);
    expect(amendment).toContain("`Good morning. {open} open tasks, {overdue} overdue. Today's tracker: {link}`");
    expect(amendment).toContain('`REPORT_DAYS`');
  });
});
