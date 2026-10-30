import { Command } from 'commander';
import { addReportCommands, defaultDeps, googleAccountCommand, googleAuthCommand, linkCommand, listGroupsCommand, statusCommand } from './cli/commands.ts';
import { loadEnv } from './config/env.ts';
import { masterKeyPath } from './config/paths.ts';
import { DpapiKeyProvider } from './crypto/keyProvider.ts';
import { systemClock } from './util/clock.ts';
import type { Db } from './store/db.ts';
import { openStore } from './store/open.ts';
import {
  closeTask, editTask, reopenTask, reprocess, requestRebuild, setClientPhase, setPersonRole, unlockClientPhase, unlockTask, type EditOptions,
} from './cli/corrections.ts';
import {
  assignMeetingToClient, defaultMeetingDeps, meetingBackfillCommand, meetingCheckCommand, meetingListLines, retryLine, retryMeetingById, skipMeetingById,
} from './cli/meetings.ts';
import { transcribeVoiceCommand } from './cli/transcribeVoice.ts';
import { dbBootstrapCommand, dbMigrateCommand, defaultDbDeps } from './cli/db.ts';

// Without these Node prints the raw error (Boom data, gaxios request config), bypassing any redaction.
function fatal(err: unknown): void {
  try {
    process.stderr.write(`${err instanceof Error ? `${err.name}: ${err.message}` : 'Fatal error'}\n`);
  } finally {
    process.exit(1);
  }
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

const program = new Command().name('wa-agent').description('WA Agent setup and correction commands');
const deps = () => defaultDeps(loadEnv());

program
  .command('link')
  .description("Link the founder's WhatsApp (stop the service first)")
  .option('--reset', 'discard the saved WhatsApp session only (tracker data is kept); asks first')
  .action(async (opts: { reset?: boolean }) => linkCommand({ reset: opts.reset === true }, deps()));

program
  .command('list-groups')
  .description('Show group names and ids on screen; allowed groups are still saved (stop the service first)')
  .action(async () => listGroupsCommand(deps()));
program.command('status').description('Connection, backlog, failures, spend and disk').action(() => statusCommand(deps()));
program
  .command('google-auth')
  .description('Connect Google Drive through a browser sign-in')
  .option('--account <name>', 'connect one more Google account that records Meet meetings (read only), e.g. company2')
  .option('--remove', 'with --account: forget that account here; asks first')
  .action(async (opts: { account?: string; remove?: boolean }) => {
    if (opts.account !== undefined) return googleAccountCommand({ account: opts.account, remove: opts.remove === true }, deps());
    if (opts.remove) throw new Error('--remove needs --account <name>');
    return googleAuthCommand(deps());
  });

addReportCommands(program, deps);

// No single-instance lock: the service and the CLI share the DB through WAL with a busy timeout.
async function withDb<T>(fn: (db: Db) => T | Promise<T>): Promise<T> {
  const db = await openStore(loadEnv());
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

const task = program.command('task').description('Fix a task');
task.command('close <code>').description('Mark a task done').action(async (code: string) => {
  const t = await withDb((db) => closeTask(db, code, new Date()));
  console.log(`${t.code} closed.`);
});
task.command('reopen <code>').description('Reopen a task').action(async (code: string) => {
  const t = await withDb((db) => reopenTask(db, code, new Date()));
  console.log(`${t.code} reopened.`);
});
task.command('unlock <code>').description('Let the AI change this task again (clears your locks)').action(async (code: string) => {
  const t = await withDb((db) => unlockTask(db, code, new Date()));
  console.log(`${t.code} unlocked.`);
});
task
  .command('edit <code>')
  .description('Change task fields; "none" clears a field')
  .option('--title <text>')
  .option('--side <us|client>')
  .option('--category <design|development|content|payment|approval|other>')
  .option('--priority <critical|major|medium|low>')
  .option('--assigned-to <name>')
  .option('--asked-by <name>')
  .option('--deadline <YYYY-MM-DD|none>')
  .option('--latest-progress <text>')
  .action(async (code: string, opts: EditOptions) => {
    const t = await withDb((db) => editTask(db, code, opts, new Date()));
    console.log(`${t.code} updated.`);
  });

program
  .command('person')
  .description('Fix people')
  .command('set <number> <role>')
  .description('Mark someone as team or client (number with country code, or a WhatsApp id)')
  .option('--client <code>', 'only in this client group')
  .action(async (number: string, role: string, opts: { client?: string }) => {
    const n = await withDb((db) => setPersonRole(db, number, role, opts.client, new Date()));
    console.log(`Updated ${n} group membership(s).`);
  });

const phase = program.command('phase').description('Fix client phases');
phase
  .command('set <client> <phase>')
  .description("Set a client's current phase")
  .action(async (client: string, name: string) => {
    await withDb((db) => setClientPhase(db, client, name, new Date()));
    console.log('Phase updated.');
  });
phase.command('unlock <client>').description("Let the AI change a client's phase again").action(async (client: string) => {
  await withDb((db) => unlockClientPhase(db, client, new Date()));
  console.log('Phase unlocked.');
});

program.command('rebuild').description('Rebuild and republish the workbook now').action(async () => {
  await withDb((db) => requestRebuild(db, new Date()));
  console.log('Rebuild requested; the service publishes within about a minute.');
});

program
  .command('reprocess <client>')
  .description('Send already-processed messages from a date onward to the AI again (respects your fixes; costs money)')
  .requiredOption('--since <YYYY-MM-DD>')
  .option('--until <YYYY-MM-DD>', 'last day to include')
  .option('--yes', 'confirm a large job (more than 200 messages)')
  .action(async (client: string, opts: { since: string; until?: string; yes?: boolean }) => {
    const r = await withDb((db) => reprocess(db, client, opts.since, opts.until, opts.yes === true, new Date()));
    if (r.count === 0) {
      console.log('No processed messages in that range; nothing changed.');
    } else if (r.needsConfirm) {
      console.log(`This would send ${r.count} old messages to the AI again (about $${r.maxCostUsd.toFixed(2)} at most). Re-run with --yes to confirm.`);
    } else {
      console.log(`${r.queued} messages re-queued for the AI.`);
      console.log('The running service will now make new AI calls for them. This costs money and counts toward the daily spend cap.');
    }
  });

program
  .command('transcribe-voice')
  .description(
    'Transcribe voice notes saved before Phase 2b, for the record (costs money only with a paid provider). Without --yes only shows the count and cost',
  )
  .option('--client <code>', 'only this client')
  .option('--failed', 'instead, the notes the local engine could not transcribe (VOICE_STT_PROVIDER=local only)')
  .option('--yes', 'queue them; the running service transcribes them')
  .action((opts: { client?: string; yes?: boolean; failed?: boolean }) =>
    transcribeVoiceCommand({ ...opts, yes: opts.yes === true, failed: opts.failed === true }, deps()),
  );

const meeting = program.command('meeting').description('Fix and check recorded meetings');
meeting
  .command('list')
  .description('Meetings that need you (titles are shown on this screen only)')
  .option('--all', 'every meeting, done and skipped included')
  .action(async (opts: { all?: boolean }) => {
    for (const l of await withDb((db) => meetingListLines(db, opts.all === true))) console.log(l);
  });
meeting.command('assign <id> <client>').description('Give an unassigned, internal or client-less no-access meeting to a client; it is then processed').action(async (id: string, client: string) => {
  const r = await withDb((db) => assignMeetingToClient(db, id, client, new Date()));
  console.log(`Meeting ${r.id} assigned to ${r.code}; the service processes it next (this costs money).`);
});
meeting.command('skip <id>').description('Do not process an unassigned meeting').action(async (id: string) => {
  console.log(`Meeting ${await withDb((db) => skipMeetingById(db, id, new Date()))} skipped.`);
});
meeting.command('retry <id>').description('Try a failed or no-access meeting again (one without a client goes back to unassigned)').action(async (id: string) => {
  console.log(retryLine(await withDb((db) => retryMeetingById(db, id, new Date()))));
});
const meetingDeps = () => {
  const env = loadEnv();
  return defaultMeetingDeps(env, new DpapiKeyProvider(masterKeyPath(env.DATA_DIR)), systemClock);
};
meeting
  .command('backfill')
  .description('Find older recordings (stop the service first). Without --yes only shows the count and cost')
  .requiredOption('--since <YYYY-MM-DD>')
  .option('--yes', 'store them, so the service processes the client ones (costs money)')
  .action(async (opts: { since: string; yes?: boolean }) => meetingBackfillCommand({ since: opts.since, yes: opts.yes === true }, meetingDeps()));
meeting
  .command('check')
  .description("Read-only: the last 7 days' recordings, their client match and whether each file opens")
  .action(async () => meetingCheckCommand(meetingDeps()));

program
  .command('db-bootstrap')
  .description('Postgres, once: create the agent roles and the database (asks for the superuser and wa_backup passwords)')
  .option('--superuser <name>', 'the Postgres superuser', 'postgres')
  .action(async (opts: { superuser: string }) => dbBootstrapCommand(loadEnv(), opts, defaultDbDeps()));
program
  .command('db-migrate')
  .description('Postgres: apply the schema changes this version needs, as wa_owner')
  .action(async () => dbMigrateCommand(loadEnv(), defaultDbDeps()));

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : 'Command failed');
  process.exit(1);
});

