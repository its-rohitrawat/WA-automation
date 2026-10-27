import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INDIAN_MOBILE, parseEnv, reportSettings } from '../../src/config/env.ts';
import type { TrackerView } from '../../src/output/view.ts';
import { buildShortMorningText, trackerLink, TRACKER_ID_KEY } from '../../src/report/morningReport.ts';
import { describeReport, REASON_TEXT, SENDER_WARNINGS, UNKNOWN_WARNING } from '../../src/report/scheduler.ts';
import { setKv } from '../../src/store/kv.ts';
import type { ReportRow } from '../../src/store/reports.ts';
import { seededDb } from '../helpers/db.ts';

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
/** The tracker holds client task data: it is shared with the founder's Google account only, never by a public link. */
const PUBLIC_SHARING = /\banyone\b|public|general access|link sharing|restricted/i;
/** Any wording that says a file goes with the message, once the one allowed "No file is attached" is taken out. */
const saysAttached = (text: string): boolean =>
  /attach|comes with the message|\.xlsx file is sent|tracker file (also )?(comes|goes|is sent)|Tracker-YYYY-MM-DD|\b(workbook|spreadsheet|document|file|xlsx)\b[^.,]*\b(sent|goes|comes)\b/i.test(
    text.replaceAll('No file is attached', ''),
  );
/** The REPORT_DAYS values a text names: `REPORT_DAYS=v`, or a lower-case `v` on a line that names `REPORT_DAYS`. */
const reportDaysValues = (text: string): string[] =>
  text
    .split('\n')
    .filter((line) => line.includes('REPORT_DAYS'))
    .flatMap((line) => [...line.matchAll(/`(?:REPORT_DAYS=)?([a-z][a-z-]*)`/g)].map((m) => m[1]!));

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
  /** Numbered step n of the setup list (up to the next step). */
  const step = (n: number): string => {
    const start = report.indexOf(`\n${n}. `);
    expect(start, `step ${n}`).toBeGreaterThanOrEqual(0);
    const next = report.indexOf(`\n${n + 1}. `, start + 1);
    return report.slice(start, next < 0 ? undefined : next);
  };
  /** A stand-in tracker view: active clients with the given open and overdue counts (none: no active clients). */
  const fakeView = (...clients: { open: number; overdue: number }[]): TrackerView =>
    ({ clients: clients.map((c) => ({ client: { active: true }, usOpen: new Array(c.open).fill(null), clientOpen: [], overdue: c.overdue })) }) as unknown as TrackerView;

  it('describes the short message with the link and no attachment', () => {
    const example = buildShortMorningText(fakeView({ open: 3, overdue: 2 }, { open: 2, overdue: 0 }), '2026-10-30', 'https://drive.google.com/file/d/…/view');
    expect(example).toBe('Good morning. 5 open tasks, 2 overdue. Today\'s tracker: https://drive.google.com/file/d/…/view');
    expect(report).toContain(`\`${example}\``);
    expect(report).toContain(`With no active clients it reads \`${buildShortMorningText(fakeView(), '2026-10-30', '…')}\``);
    expect(report).toContain(`with active clients and nothing open it reads \`${buildShortMorningText(fakeView({ open: 0, overdue: 0 }), '2026-10-30', '…')}\``);
    expect(report).not.toContain('With no open tasks it reads');
    expect(report).toContain('No file is attached');
    expect(report).toContain('**Today** tab');
    expect(report).not.toMatch(/Tracker-YYYY-MM-DD|is attached as|attached as/);
    expect(saysAttached(report)).toBe(false);
  });

  it('names the report days and REPORT_DAYS', () => {
    expect(report).toContain('Monday to Friday');
    expect(report).toContain('No report goes out on Saturday or Sunday');
    expect(report).toContain('`REPORT_DAYS`');
    expect(report).toContain('`report send-now` still works on any day');
    expect(report).not.toMatch(/refused on weekends|weekdays only/);
  });

  it('nothing is sent until the tracker link exists', () => {
    expect(report).toContain('Until then the report is not sent, and the status says why');
    expect(report).not.toMatch(/sent without a link/);
    const bullet = report.split('\n').find((line) => line.startsWith('- The link exists only once'));
    expect(bullet).toBeDefined();
    expect(bullet).not.toMatch(/goes out|sent with|totals only|without/i);
  });

  it('the attachment guard catches a file sent in any wording', () => {
    for (const bad of [
      '- The tracker is attached to the message.',
      '- The workbook is also sent to the founder as a document.',
      '- The spreadsheet goes with the message.',
      '- A copy of the xlsx comes along each morning.',
    ]) expect(saysAttached(bad), bad).toBe(true);
    expect(saysAttached('No file is attached. The link opens on the **Today** tab.')).toBe(false);
  });

  it('the public-sharing guard catches any link-sharing wording', () => {
    for (const bad of [
      'or set the folder so anyone who has the link can view it',
      'make it public',
      'under General access pick a setting',
      'turn on link sharing',
      'change Restricted to something else',
    ]) expect(bad, bad).toMatch(PUBLIC_SHARING);
  });

  it('the founder needs view access to Tracker.xlsx, by sharing the folder with his Google account', () => {
    expect(report).toContain('view access to `Tracker.xlsx`');
    expect(report).toContain("the founder's Google account");
    expect(report).toContain('the link asks for access');
    expect(report).toContain('share the **WA Agent** folder');
    expect(step(6)).toContain('share the **WA Agent** folder');
    expect(step(6)).toContain('as Viewer');
    expect(step(6)).toContain('Sharing the folder, not the file');
    expect(step(6)).not.toMatch(/Editor/);
    expect(step(6)).not.toMatch(PUBLIC_SHARING);
    expect(report).not.toMatch(PUBLIC_SHARING);
  });

  it('the status table lists the weekend line and the no_tracker_link lines exactly as the code writes them', () => {
    const rows = statusRows();
    const has = (text: string) => expect(rows.some((line) => line.startsWith(`| ${text} |`)), text).toBe(true);
    const saturday = describeReport(undefined, new Date('2026-10-31T03:00:00Z'), settings, 'idle');
    expect(saturday).toEqual({ text: 'Morning report: no report today (weekend)', warning: null });
    has(saturday.text);
    const weekendRow = rows.find((r) => r.startsWith(`| ${saturday.text} |`))!;
    expect(weekendRow).toContain('No scheduled report is sent or skipped');
    expect(weekendRow).not.toMatch(/recorded as skipped|is skipped/);
    const retry = describeReport(row({ detail: 'no_tracker_link', nextAttemptAt: '2026-10-30T00:32:00.000Z' }), new Date('2026-10-30T00:31:00Z'), settings, 'idle');
    expect(retry.text).toBe(`Morning report: not sent yet (${REASON_TEXT.no_tracker_link!}), next try 06:02 IST`);
    has(retry.text.replace('06:02', 'HH:MM'));
    const skipped = describeReport(row({ status: 'skipped', detail: 'no_tracker_link' }), new Date('2026-10-30T07:00:00Z'), settings, 'idle');
    has(skipped.text);
    expect(skipped.text).toBe(`Morning report skipped today (${REASON_TEXT.no_tracker_link!})`);
    for (const line of [retry.text.replace('06:02', 'HH:MM'), skipped.text]) {
      expect(rows.find((r) => r.startsWith(`| ${line} |`)), line).toContain('Nothing was sent.');
    }
    // The advice signs in to Google (which makes the Drive link), never re-links the spare phone.
    const retryRow = rows.find((r) => r.startsWith(`| ${retry.text.replace('06:02', 'HH:MM')} |`))!;
    expect(retryRow).toContain('run `npm run cli -- google-auth`');
    expect(retryRow).toContain('If Google is already signed in');
    expect(retryRow).toContain('Tracker update failing');
    expect(retryRow).toContain('Google sign-in expired');
    expect(retryRow).not.toContain('link-sender');
    expect(rows.find((r) => r.startsWith(`| ${skipped.text} |`))).not.toContain('link-sender');
  });

  it('the status table has a row for every line describeReport and Health can show', () => {
    const rows = statusRows();
    const has = (text: string) => expect(rows.some((line) => line.startsWith(`| ${text} |`)), text).toBe(true);
    const at = (iso: string) => new Date(iso);
    // Friday 30 Oct 2026, a report day. Times are UTC (06:00 IST is 00:30Z, 12:00 IST is 06:30Z).
    const states: [ReportRow | undefined, Date, string][] = [
      [undefined, at('2026-10-30T00:00:00Z'), `Morning report: due at ${settings.time} IST`],
      [undefined, at('2026-10-30T01:00:00Z'), 'Morning report: due now'],
      [row({ status: 'sent', updatedAt: '2026-10-30T00:31:00.000Z' }), at('2026-10-30T01:00:00Z'), 'Morning report: sent at HH:MM IST'],
      [row({ status: 'sending' }), at('2026-10-30T00:31:00Z'), 'Morning report: sending now'],
      [row({ status: 'unknown' }), at('2026-10-30T01:00:00Z'), 'Morning report: unknown, check WhatsApp'],
      [row({ detail: 'not_linked', nextAttemptAt: '2026-10-30T00:32:00.000Z' }), at('2026-10-30T00:31:00Z'), 'Morning report: not sent yet (reason), next try HH:MM IST'],
      [row({ detail: 'not_linked', nextAttemptAt: '2026-10-30T06:35:00.000Z' }), at('2026-10-30T06:25:00Z'), `Morning report: not sent yet (reason); no more tries today, it will be skipped at ${settings.deadline} IST`],
      [row({ status: 'skipped', detail: 'not_linked' }), at('2026-10-30T07:00:00Z'), 'Morning report skipped today (reason)'],
    ];
    for (const [r, now, expected] of states) {
      const { text } = describeReport(r, now, settings, 'idle');
      // Times other than the fixed 06:00 and 12:00 become HH:MM; the first bracket becomes (reason).
      const general = text
        .replace(/\d\d:\d\d(?= IST)/g, (hm) => (hm === settings.time || hm === settings.deadline ? hm : 'HH:MM'))
        .replace(/\([^)]*(\([^)]*\))?[^)]*\)/, '(reason)');
      expect(general).toBe(expected);
      has(expected);
    }
    expect(settings.deadline).toBe('12:00');
    has('Morning report: off');
    // The scheduler waits for REPORT_TIME before any try, so a send-now that fails before 06:00 next tries at 06:00.
    const retryRow = rows.find((r) => r.startsWith('| Morning report: not sent yet (reason), next try HH:MM IST |'))!;
    expect(retryRow).toContain('after 2, 5 and 10 minutes, until 12:00');
    expect(retryRow).toContain(`A failure before ${settings.time} (from \`report send-now\`) waits until ${settings.time} for its next try.`);
  });

  it('SETUP-mac.md section 7 says the same, short', () => {
    const mac = read('docs/SETUP-mac.md');
    const start = mac.indexOf('\n## 7. Morning report');
    expect(start).toBeGreaterThanOrEqual(0);
    const section = mac.slice(start, mac.indexOf('\n## ', start + 1));
    expect(section).toContain('Monday to Friday at 06:00 IST');
    expect(section).toContain('empty is Monday to Friday');
    expect(section).not.toMatch(/every day|Sundays included/i);
    expect(section).toContain('link to the tracker on Google Drive');
    expect(section).toContain('No file is attached');
    expect(section).toContain('`REPORT_DAYS`');
    expect(section).toContain('view access to `Tracker.xlsx`');
    expect(section).toContain("the founder's Google account");
    expect(section).toContain('(Viewer)');
    expect(section).toContain('works on any day');
    expect(section).not.toMatch(/Editor|weekdays only/);
    const steps = section.split('\n').filter((line) => /^\d\. /.test(line));
    const share = steps.findIndex((line) => line.includes('share the **WA Agent** folder'));
    const test = steps.findIndex((line) => line.includes('report send-now'));
    expect(share, 'a numbered share step').toBeGreaterThanOrEqual(0);
    expect(steps[share]).toContain('as Viewer');
    expect(steps[share]).not.toMatch(PUBLIC_SHARING);
    expect(section).not.toMatch(PUBLIC_SHARING);
    expect(share).toBeLessThan(test);
    expect(section).not.toMatch(/Tracker-YYYY-MM-DD|attached as|Excel sheet every morning/);
    expect(saysAttached(section)).toBe(false);
  });

  it('the spec has the 27 Oct 2026 amendment with D1 to D4', () => {
    const spec = read('docs/superpowers/specs/2026-10-23-morning-report-design.md');
    const amendment = spec.slice(spec.indexOf('\n## Amendment, 27 Oct 2026\n'));
    expect(spec).toContain('\n## Amendment, 27 Oct 2026\n');
    for (const d of ['**D1', '**D2', '**D3', '**D4']) expect(amendment).toContain(d);
    expect(amendment).toContain('**D4 no attachment:**');
    const saturday = describeReport(undefined, new Date('2026-10-31T03:00:00Z'), reportSettings(parseEnv({})), 'idle');
    expect(saturday.warning).toBeNull();
    expect(amendment).toContain(`The status says \`${saturday.text}\`, with no warning`);
    expect(amendment).toContain("`Good morning. {open} open tasks, {overdue} overdue. Today's tracker: {link}`");
    expect(amendment).toContain('`REPORT_DAYS`');
    for (const rule of [
      'linkPreview: null',
      'only `REPORT_RECIPIENT`',
      'never retried automatically',
      'only `src/wa/senderGateway.ts`',
      'use the singular',
      'no claim, no row, no skipped row',
      '`report send-now` is still honoured on any day',
      'keeps the normal retry waits and the deadline skip',
      'The founder-number reader never sends',
      'the sender messages only `REPORT_RECIPIENT`',
      'claim before send',
      'at most once per IST date',
      'catch up until the deadline',
      'no AI spend',
      'Nothing is sent.',
      '`no_tracker_link`',
      'only the text is sent',
      '`ReportSender.sendReport(text)` takes no file',
      'Totals count active clients only',
      'no "due" promise',
    ]) expect(amendment, rule).toContain(rule);
    expect(amendment).not.toMatch(/every client|active or not|with a warning/i);
    // The documented link format is the one the code builds.
    const db = seededDb();
    setKv(db, TRACKER_ID_KEY, 'IDPLACEHOLDER');
    const link = trackerLink(db)!.replace('IDPLACEHOLDER', '{id}');
    expect(link).toBe('https://drive.google.com/file/d/{id}/view');
    expect(amendment).toContain(`\`{link}\` is \`${link}\``);
    expect(amendment).not.toMatch(PUBLIC_SHARING);
  });

  it('every REPORT_DAYS value in the docs and the spec is one the code accepts, and the default is weekdays', () => {
    const setupValues = reportDaysValues(report);
    const mac = read('docs/SETUP-mac.md');
    const macStart = mac.indexOf('\n## 7. Morning report');
    const macValues = reportDaysValues(mac.slice(macStart, mac.indexOf('\n## ', macStart + 1)));
    const spec = read('docs/superpowers/specs/2026-10-23-morning-report-design.md');
    const amendment = spec.slice(spec.indexOf('\n## Amendment, 27 Oct 2026\n'));
    const specValues = reportDaysValues(amendment);
    expect(setupValues).toEqual(['mon-sat', 'daily']);
    expect(macValues).toEqual(['mon-sat', 'daily']);
    expect(specValues).toEqual(['weekdays', 'mon-sat', 'daily']);
    for (const v of [...setupValues, ...macValues, ...specValues]) expect(reportSettings(parseEnv({ REPORT_DAYS: v })).days, v).toBe(v);
    expect(() => parseEnv({ REPORT_DAYS: 'everyday' })).toThrow();
    expect(settings.days).toBe('weekdays');
    expect(amendment).toContain(`\`${settings.days}\` (default)`);
    expect(amendment.match(/\(default\)/g)).toHaveLength(1);
  });
});

describe('go-live guide (docs/GO-LIVE.md, D5 task 6)', () => {
  const guide = () => read('docs/GO-LIVE.md');

  /** Where `text` first appears; fails the test when it is missing (so an order check never passes on -1). */
  const at = (g: string, text: string) => {
    const i = g.indexOf(text);
    expect(i, text).toBeGreaterThan(-1);
    return i;
  };

  it('backs up before the merge: stop, confirm stopped, copy, private, then check the copy opens and is whole', () => {
    const g = guide();
    expect(g).toMatch(/step 1 comes before the merge/i);
    const steps = [
      '## 1. Back up the data folder',
      'sudo launchctl bootout system/com.wa-agent',
      'Could not find service',
      'cp -Rp data/. backups/2026-11-01-data/',
      'chmod 700 backups/2026-11-01-data',
      'sqlite3 backups/2026-11-01-data/tracker.db "select count(*) from tasks"',
      'sqlite3 backups/2026-11-01-data/tracker.db "pragma integrity_check"',
      '## 2. Get the new version',
    ].map((s) => at(g, s));
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
  });

  it('makes the update pull, then run npm ci, then restart; and pulls by hand after the merge', () => {
    const g = guide();
    const update = g.slice(at(g, '## 2. Get the new version'), at(g, '## 3.'));
    // The update's own commands, in this order, one after the other.
    expect(update).toMatch(/cd \/opt\/wa-agent\s+git pull --ff-only\s+npm ci\s+sudo launchctl kickstart -k system\/com\.wa-agent/);
    // And the pull by hand after the merge, without a restart (the service stays stopped until step 4).
    expect(update).toMatch(/cd \/opt\/wa-agent\s+git pull --ff-only\s+npm ci\s+```/);
    expect(update.match(/git pull --ff-only/g)).toHaveLength(2);
    expect(update).toMatch(/fails while the service is stopped: that is expected and harmless/);
  });

  it('starts the service again before the checks', () => {
    const g = guide();
    expect(at(g, 'sudo launchctl bootstrap system /Library/LaunchDaemons/com.wa-agent.plist')).toBeLessThan(at(g, '## 7. Checks'));
  });

  it('names every dashboard setting, with placeholders only', () => {
    const g = guide();
    for (const name of ['DASHBOARD_ENABLED=true', 'DASHBOARD_PORT=8787', 'DASHBOARD_PUBLIC_URL=https://waagent.agentsolutionbowl.si', 'DASHBOARD_OWNER_EMAILS=',
      'DASHBOARD_GOOGLE_CLIENT_ID=', 'DASHBOARD_GOOGLE_CLIENT_SECRET=', 'UPTIMEROBOT_READ_KEY=']) {
      expect(g, name).toContain(name);
    }
    expect(g).toContain('DASHBOARD_GOOGLE_CLIENT_SECRET=your_web_client_secret_here');
    expect(g).toContain('DASHBOARD_OWNER_EMAILS=owner@example.com,second.owner@example.com');
    // Nothing that looks like a real Google client secret, client id or API key.
    expect(g).not.toMatch(/GOCSPX-|\d{6,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com|AIza[0-9A-Za-z_-]{20,}|\bu\d{6,}-[0-9a-f]{20,}/);
  });

  it('lists the four redirect addresses of the web sign-in client', () => {
    const g = guide();
    for (const uri of [
      'https://waagent.agentsolutionbowl.si/dashboard/auth/callback',
      'https://waagent.agentsolutionbowl.si/dashboard/connect/google/callback',
      'http://localhost:8787/dashboard/auth/callback',
      'http://localhost:8787/dashboard/connect/google/callback',
    ]) expect(g, uri).toContain(uri);
    expect(g).toContain('Web application');
    expect(g).toContain('In production');
    // Google takes https redirects only for an authorized domain: the domain comes first.
    expect(at(g, 'Authorized domains')).toBeLessThan(at(g, 'Authorized redirect URIs'));
  });

  it('points the domain straight at the agent on the Mac, with no Pages, Worker or offline page', () => {
    const g = guide();
    expect(g).toContain('127.0.0.1:8787');
    expect(g).not.toMatch(/\bPages\b|\bWorker\b|offline page|Agent offline/i);
    expect(g).toMatch(/When the Mac is off, the website and the dashboard are both down/);
    expect(g).toContain('sudo cloudflared service install <token>');
  });

  it('says the owner runs every step, and how to turn it all off again', () => {
    const g = guide();
    expect(g).toMatch(/nothing in this guide is run by Claude/i);
    expect(g).toContain('DASHBOARD_ENABLED=false');
    expect(g).toContain('## 7. Checks');
  });
});

describe('owner dashboard setup (SETUP-mac.md section 10, D1 task 8)', () => {
  const section = () => {
    const mac = read('docs/SETUP-mac.md');
    const start = mac.indexOf('## 10. Owner dashboard (optional)');
    expect(start).toBeGreaterThan(-1);
    return mac.slice(start, mac.indexOf('\n## ', start + 1));
  };

  it('names every dashboard setting, with placeholders only', () => {
    const s = section();
    for (const name of ['DASHBOARD_ENABLED=true', 'DASHBOARD_PORT=8787', 'DASHBOARD_OWNER_EMAILS=owner@example.com', 'DASHBOARD_GOOGLE_CLIENT_ID=your_web_client_id_here',
      'DASHBOARD_GOOGLE_CLIENT_SECRET=your_web_client_secret_here', 'DASHBOARD_PUBLIC_URL=', 'UPTIMEROBOT_READ_KEY=']) {
      expect(s, name).toContain(name);
    }
    // Every name it sets is a real setting of src/config/env.ts.
    const envSource = read('src/config/env.ts');
    const names = [...s.matchAll(/^\s*([A-Z][A-Z_]+)=/gm)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThanOrEqual(7);
    for (const name of names) expect(envSource, name).toMatch(new RegExp(`^\\s*${name}: `, 'm'));
  });

  it('backs up, gets the new version with npm ci after pulling, sets up, then starts the stopped service, in that order', () => {
    const s = section();
    expect(s).toMatch(/always run `npm ci` after pulling/);
    const at = (text: string) => {
      const i = s.indexOf(text);
      expect(i, text).toBeGreaterThan(-1);
      return i;
    };
    const steps = [
      at('**Back up first.**'), at('step 1 of [GO-LIVE.md](GO-LIVE.md)'),
      at('**Get the new version'), at('`git pull --ff-only`, then `npm ci`'),
      at('**Google web sign-in client.**'), at('**Settings.**'),
      // The service was booted out in the backup: a restart (kickstart) cannot start it, only enable and bootstrap.
      at('**Start the service again**'), at('sudo launchctl enable system/com.wa-agent'), at('sudo launchctl bootstrap system /Library/LaunchDaemons/com.wa-agent.plist'),
      at('**Open**'),
    ];
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
  });

  it('adds the Web application client with the localhost redirects first, then signs in on localhost', () => {
    const s = section();
    expect(s).toContain('Web application');
    expect(s).toContain('http://localhost:8787/dashboard/auth/callback');
    expect(s).toContain('http://localhost:8787/dashboard/connect/google/callback');
    expect(s).not.toContain('https://waagent.agentsolutionbowl.si/dashboard/auth/callback'); // the domain's come later, in GO-LIVE.md
    expect(s).toContain('sudo launchctl kickstart -k system/com.wa-agent');
    expect(s).toContain('http://localhost:8787/dashboard');
    expect(s).toContain('DASHBOARD_ENABLED=false');
  });

  it('SETUP.md points to it, with the npm ci note', () => {
    const setup = read('docs/SETUP.md');
    expect(setup).toContain('\n## Owner dashboard\n');
    expect(setup).toContain('[SETUP-mac.md](SETUP-mac.md), section 10 "Owner dashboard"');
    expect(setup).toMatch(/update step must run `npm ci` after pulling/);
  });
});
