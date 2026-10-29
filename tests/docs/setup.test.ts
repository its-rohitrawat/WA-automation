import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INDIAN_MOBILE, parseEnv, reportSettings } from '../../src/config/env.ts';
import { MEETING_STT_PROBLEM_LINES } from '../../src/health/health.ts';
import { LOCAL_MEETING_MIN_TIMEOUT_SECONDS } from '../../src/meetings/localTranscriber.ts';
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
    ({ clients: clients.map((c) => ({ client: { active: true }, usOpen: new Array(c.open).fill({ priority: 'medium' }), clientOpen: [], overdue: c.overdue })) }) as unknown as TrackerView;

  it('gives the critical example exactly as the message reads', () => {
    const t = (priority: string) => ({ priority });
    const view = { clients: [{ client: { active: true }, usOpen: [t('critical'), t('critical'), t('medium')], clientOpen: [t('low'), t('major')], overdue: 2 }] } as unknown as TrackerView;
    expect(report).toContain(`\`${buildShortMorningText(view, '2026-10-30', '…')}\``);
    expect(buildShortMorningText(view, '2026-10-30', '…')).toBe("Good morning. 2 critical, 5 open tasks, 2 overdue. Today's tracker: …");
  });

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

  it('the spec has the 27 Oct 2026 amendment with D1 to D4', async () => {
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
    const db = await seededDb();
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

describe('dashboard first, commands as the fallback (D2 task 5, D3 task 10)', () => {
  const setup = () => read('docs/SETUP.md');
  /** A "### title" section of SETUP.md, up to the next heading. */
  const sub = (title: string) => {
    const s = setup();
    const start = s.indexOf(`\n### ${title}\n`);
    expect(start, title).toBeGreaterThan(-1);
    return s.slice(start, s.indexOf('\n#', start + 1));
  };
  const GROUPS = 'Choosing client groups in the dashboard';
  const FIX = 'Fixing a connection in the dashboard';

  it('both sections sit under "Owner dashboard", with setup mode explained', () => {
    const s = setup();
    const owner = s.indexOf('\n## Owner dashboard\n');
    const next = s.indexOf('\n## ', owner + 1);
    for (const title of [GROUPS, FIX]) {
      const at = s.indexOf(`\n### ${title}\n`);
      expect(at, title).toBeGreaterThan(owner);
      expect(at, title).toBeLessThan(next);
    }
    expect(s.slice(owner, next)).toMatch(/\*\*setup mode\*\*/);
    expect(s.slice(owner, next)).toContain('With the dashboard off, a missing link still stops the service, as before.');
  });

  it('choosing groups follows the Manage groups screen, word for word where it quotes it', () => {
    const g = sub(GROUPS);
    const screen = read('src/web/public/views/groups.js');
    const tabs = read('src/web/public/views/clients.js');
    expect(g).toContain('**Clients → Manage groups**');
    expect(tabs).toContain('>Manage groups</button>');
    for (const quoted of ['Saved. The agent picks up the new groups within 2 seconds.', "can't be changed once the client has tasks", 'More: meeting matching']) {
      expect(g, quoted).toContain(quoted);
      expect(screen, quoted).toContain(quoted);
    }
    for (const button of ['Approve', 'Remove']) {
      expect(g, button).toContain(`**${button}**`);
      expect(screen, button).toContain(`>${button}</button>`);
    }
    expect(g).toMatch(/\*\*Pick it carefully: it can't be changed once the client has tasks\.\*\*/);
    expect(g).toContain('No restart is needed.');
    expect(g).toContain('Nothing is deleted');
    // The hand edit stays documented as the fallback.
    expect(g).toMatch(/\*\*Fallback, when the dashboard can't be reached:\*\* edit `allowed-groups\.json` by hand as in step 5/);
  });

  it('fixing a connection starts in the dashboard, with every Connections button named as the screen names it', () => {
    const f = sub(FIX);
    const screen = read('src/web/public/views/connections.js');
    expect(f).toContain('**Fix now**');
    expect(read('src/web/public/views/overview.js')).toContain('>Fix now</button>');
    for (const button of ['Reconnect', 'Link phone', 'Add Google account', 'Upload tracker now', 'Test connection', 'Send test beat']) {
      expect(f, button).toContain(`**${button}**`);
      expect(screen, button).toContain(`'${button}'`);
    }
    expect(f).toContain("Never scan it with the founder's phone");
    expect(f).toContain('the service does not need to be stopped');
    // The link timeout it states is the code's.
    expect(f).toContain('after 5 minutes without a scan');
    expect(read('src/wa/linkSession.ts')).toMatch(/const TIMEOUT_MS = 5 \* 60_000;/);
    // The commands stay as the fallback, with their rules.
    expect(f).toMatch(/\*\*Fallback, when the dashboard can't be reached:\*\*/);
    for (const cmd of ['npm run cli -- link`', 'npm run cli -- link-sender`', 'npm run cli -- google-auth`']) expect(f, cmd).toContain(cmd);
    expect(f).toContain('`link` and `link-sender` need the service stopped first; after `google-auth`, restart the service.');
  });

  it('step 5 and the status line table point to the dashboard sections by their real titles', () => {
    const s = setup();
    expect(s).toContain(`see "${GROUPS}" under "Owner dashboard"`);
    const status = s.slice(s.indexOf('\n## What the status line means\n'));
    expect(status.slice(0, 400)).toContain(`see "${FIX}" under "Owner dashboard"`);
  });

  it('SETUP-mac section 10 sends the owner to the same two sections, keeping the commands as the fallback', () => {
    const mac = read('docs/SETUP-mac.md');
    const start = mac.indexOf('## 10. Owner dashboard (optional)');
    const s = mac.slice(start, mac.indexOf('\n## ', start + 1));
    expect(s).toContain(`7. **Client groups:**`);
    expect(s).toContain(`SETUP.md, "${GROUPS}"`);
    expect(s).toContain(`8. **Connections:**`);
    expect(s).toContain(`SETUP.md, "${FIX}"`);
    expect(s).toMatch(/stay the fallback/);
    expect(mac).toContain('Once the owner dashboard is set up (section 10), choosing groups and fixing a connection start in the dashboard; these commands stay as the fallback.');
    // Both steps come after signing in and before the way to switch it off.
    expect(s.indexOf('**Open**')).toBeLessThan(s.indexOf('7. **Client groups:**'));
    expect(s.indexOf('8. **Connections:**')).toBeLessThan(s.indexOf('DASHBOARD_ENABLED=false'));
  });
});

describe('go-live guide: the website build (GO-LIVE.md step 5)', () => {
  it('says how the website gets into the code, and when the Next.js upgrade is due', () => {
    const g = read('docs/GO-LIVE.md');
    const step = g.slice(g.indexOf('\n## 5. The website files\n'), g.indexOf('\n## 6. '));
    expect(step).toContain('The Mac never builds the website.');
    expect(step).toContain('`npm run site:import`');
    expect(step).toContain('**Due on or after 6 Nov 2026:** the website\'s Next.js upgrade (16.4.0 to 16.4.3).');
    // The command it names is a real script of this repo.
    expect(read('package.json')).toContain('"site:import": "node scripts/site-import.ts"');
    expect(read('scripts/site-import.ts')).toContain('Due on or after 6 Nov 2026');
  });
});

describe('owner fixes in the dashboard docs (plan 2026-10-28-owner-fixes.md, Task 5)', () => {
  const setup = read('docs/SETUP.md');
  /** A ### section of SETUP.md, up to the next ## or ### heading. */
  const section = (heading: string) => {
    const at = setup.indexOf(`\n### ${heading}\n`);
    expect(at, heading).toBeGreaterThanOrEqual(0);
    const ends = ['\n## ', '\n### '].map((h) => setup.indexOf(h, at + 1)).filter((n) => n > 0);
    return setup.slice(at, ends.length > 0 ? Math.min(...ends) : undefined);
  };
  const mac = read('docs/SETUP-mac.md');
  const macStart = mac.indexOf('\n## 10. Owner dashboard (optional)\n');
  const section10 = mac.slice(macStart, mac.indexOf('\n## ', macStart + 1));

  it('approving a group reads up to 7 days back, as far as WhatsApp provides, within the spend cap', () => {
    const groups = section('Choosing client groups in the dashboard');
    expect(groups).toContain('up to 7 days back, as far as WhatsApp provides');
    expect(groups).toMatch(/spend cap: if the cap is reached, the reading pauses and carries on the next day/);
    expect(groups).toMatch(/no message text/);
  });

  it('Connections shows each Google account email, kept masked in logs and Audit logs', () => {
    const fix = section('Fixing a connection in the dashboard');
    expect(fix).toMatch(/Each Google card shows the account's email address/);
    expect(fix).toMatch(/logs and \*\*Audit logs\*\* keep it masked/);
  });

  it('the Sync tracker button and what to do when a new tracker file appears', () => {
    const tracker = section('Keeping the tracker up to date');
    expect(tracker).toContain('Sync tracker button');
    expect(tracker).toContain('**If a new tracker file appears.**');
    expect(tracker).toMatch(/the Google login changed/);
    expect(tracker).toMatch(/sign in with the account that owns the old file/);
    expect(tracker).toMatch(/\*\*Keep the new file:\*\*/);
  });

  it('SETUP-mac section 10 points to those three SETUP.md sections', () => {
    expect(macStart).toBeGreaterThanOrEqual(0);
    for (const name of ['Choosing client groups in the dashboard', 'Fixing a connection in the dashboard', 'Keeping the tracker up to date']) {
      expect(section10).toContain(`"${name}"`);
      expect(setup).toContain(`\n### ${name}\n`);
    }
    expect(section10).toMatch(/up to 7 days back/);
  });
});

describe('meetings on the local speech engine (plan 2026-10-28-meetings-local-stt.md, Task 3)', () => {
  const mac = read('docs/SETUP-mac.md');
  const macStart = mac.indexOf('\n## 8. Voice notes: local speech-to-text\n');
  const section8 = mac.slice(macStart, mac.indexOf('\n## ', macStart + 1));
  const setup = read('docs/SETUP.md');
  const meetStart = setup.indexOf('\n## Meeting summaries (Phase 3)\n');
  const meetings = setup.slice(meetStart, setup.indexOf('\n## ', meetStart + 1));

  it('SETUP-mac.md section 8 says meetings can use the same engine with STT_PROVIDER=local, how long it takes, and that there are no speaker labels', () => {
    expect(macStart).toBeGreaterThanOrEqual(0);
    const para = section8.split('\n\n').find((b) => b.includes('`STT_PROVIDER=local`'));
    expect(para, 'a paragraph naming STT_PROVIDER=local').toBeDefined();
    expect(para).toMatch(/[Mm]eetings/);
    expect(para).toContain('same engine');
    expect(para).toMatch(/3-hour meeting takes about 4 hours on Voxtral and under 3 on Qwen3-ASR/);
    expect(para).toMatch(/no speaker labels/i);
    expect(para).toMatch(/no key/);
    expect(section8).not.toContain('Meetings keep using `STT_PROVIDER`, unchanged.');
    // The setting it names is one the code accepts, with no key.
    const env = parseEnv({ STT_PROVIDER: 'local', STT_LOCAL_BIN: '/opt/stt/bin/transcribe-cli', STT_LOCAL_MODEL: '/opt/stt/models/m.gguf' });
    expect(env.STT_PROVIDER).toBe('local');
    expect(env.STT_API_KEY).toBeUndefined();
  });

  it('SETUP.md meetings section names local as an STT_PROVIDER choice that needs no STT_API_KEY', () => {
    expect(meetStart).toBeGreaterThanOrEqual(0);
    const row = (name: string) => meetings.split('\n').find((l) => l.startsWith(`| \`${name}\` |`));
    expect(row('STT_PROVIDER')).toContain('`local`');
    expect(row('STT_API_KEY')).toMatch(/not `none` or `local`|unless `STT_PROVIDER` is `none` or `local`/);
    expect(meetings).not.toContain('the recommended local engine is not used for meetings');
    expect(meetings).toContain('`STT_PROVIDER=local`');
  });

  it('SETUP-mac.md: the timeout floor for meetings, the ten-minute transcript blocks and the parts given up (review fixes 3 and 5)', () => {
    const para = section8.split('\n\n').find((b) => b.includes('`STT_PROVIDER=local`'))!;
    expect(para).toContain(`keep \`STT_LOCAL_TIMEOUT_SECONDS\` at least ${LOCAL_MEETING_MIN_TIMEOUT_SECONDS}`);
    expect(para).toMatch(/ten-minute blocks/);
    expect(para).toContain('No speech recognised');
  });

  it('SETUP.md meetings section says copies a paid provider kept are not deleted while STT_PROVIDER is local (review fix 6)', () => {
    expect(meetings).toMatch(/switch(?:ing|ed)? to `STT_PROVIDER=local`[^.]*copies[^.]*(?:stay|are not deleted)/);
  });

  it('SETUP.md lists the meeting lines for a local engine that is not set up, exactly as the code writes them', () => {
    const at = meetings.indexOf('\n### Meeting status lines\n');
    expect(at).toBeGreaterThanOrEqual(0);
    const table = meetings.slice(at, meetings.indexOf('\n### ', at + 1));
    const lines = Object.values(MEETING_STT_PROBLEM_LINES).map((l) => l.replace(/^⚠️ /, ''));
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(table.split('\n').filter((r) => r.startsWith(`| ${line} |`)), line).toHaveLength(1);
  });
});

describe('earlier messages of a newly approved group (Task 4, 28 Oct 2026)', () => {
  it('SETUP.md, Manage groups and the client card say the same, honestly: up to 7 days, as far as WhatsApp provides', () => {
    const setup = read('docs/SETUP.md');
    const groups = read('src/web/public/views/groups.js');
    const clients = read('src/web/public/views/clients.js');
    expect(setup).toContain('**up to 7 days back, as far as WhatsApp provides**: WhatsApp may not hand over every old message, so some can be missing.');
    expect(groups).toContain("and its earlier ones up to 7 days back, as far as WhatsApp provides.");
    // The three states, word for word in the doc and the screen (card and panel status line, the panel's Earlier messages row).
    expect(setup).toContain('("Waiting for the first new message to read earlier ones")');
    expect(setup).toContain('say "Reading the last 7 days · <n> found"');
    expect(setup).toContain('**Earlier messages** row says "Last 7 days read · <n> found"');
    // The status line is "<head> · <rest>": the head and the rest as the screen builds them.
    expect(clients).toContain("head: 'Reading the last 7 days', rest: `${s.history?.found ?? 0} found`");
    expect(clients).toContain('<b>${esc(st.head)}</b>${st.rest ? ` <span>· ${esc(st.rest)}</span>` : \'\'}');
    expect(clients).toContain("head: 'Waiting for the first new message to read earlier ones'");
    expect(clients).toContain('`Last 7 days read · ${h.found} found`');
    expect(setup).toContain('within the daily spend cap');
    expect(setup).toContain('Removing the group stops it.');
  });
});

describe('SETUP.md, choosing several groups at once', () => {
  it('names the bar, its buttons and the failure reason as the screen and the agent say them', () => {
    const setup = read('docs/SETUP.md');
    const groups = read('src/web/public/views/groups.js');
    const route = read('src/web/routes/groups.ts');
    for (const text of ['Approve selected', 'Ignore selected', 'Show again', 'Select all']) {
      expect(setup, text).toContain(`**${text}**`);
      expect(groups, text).toContain(text);
    }
    expect(setup).toContain('"4 approved, 1 failed: No code could be made from its name…"');
    expect(route).toContain("'No code could be made from its name. Approve it on its own to choose one.'");
    expect(groups).toContain('${done.length} ${verb}, ${bad.length} failed');
  });
});
