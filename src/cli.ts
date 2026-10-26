import { Command } from 'commander';
import {
  defaultDeps, googleAuthCommand, linkCommand, linkSenderCommand, listGroupsCommand, reportSendNowCommand, reportStatusCommand, statusCommand,
} from './cli/commands.ts';
import { loadEnv } from './config/env.ts';
import { trackerDbPath } from './config/paths.ts';
import { openDb, type Db } from './store/db.ts';
import {
  closeTask, editTask, reopenTask, reprocess, requestRebuild, setClientPhase, setPersonRole, unlockClientPhase, unlockTask, type EditOptions,
} from './cli/corrections.ts';

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
program.command('google-auth').description('Connect Google Drive through a browser sign-in').action(async () => googleAuthCommand(deps()));

program
  .command('link-sender')
  .description('Link the spare number that sends the morning report (stop the service first)')
  .option('--reset', 'discard the saved spare-number session only, or move a damaged one aside (the founder link and tracker data are kept); asks first')
  .action(async (opts: { reset?: boolean }) => linkSenderCommand({ reset: opts.reset === true }, deps()));

const report = program.command('report').description('Morning report');
report.command('status').description("Today's morning report and the last 7 days").action(() => reportStatusCommand(deps()));
report
  .command('send-now')
  .description("Ask the running service to send today's report now (asks first; refuses if already sent)")
  .action(async () => reportSendNowCommand(deps()));

// No single-instance lock: the service and the CLI share the DB through WAL with a busy timeout.
function withDb<T>(fn: (db: Db) => T): T {
  const db = openDb(trackerDbPath(loadEnv().DATA_DIR));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const task = program.command('task').description('Fix a task');
task.command('close <code>').description('Mark a task done').action((code: string) => {
  const t = withDb((db) => closeTask(db, code, new Date()));
  console.log(`${t.code} closed.`);
});
task.command('reopen <code>').description('Reopen a task').action((code: string) => {
  const t = withDb((db) => reopenTask(db, code, new Date()));
  console.log(`${t.code} reopened.`);
});
task.command('unlock <code>').description('Let the AI change this task again (clears your locks)').action((code: string) => {
  const t = withDb((db) => unlockTask(db, code, new Date()));
  console.log(`${t.code} unlocked.`);
});
task
  .command('edit <code>')
  .description('Change task fields; "none" clears a field')
  .option('--title <text>')
  .option('--side <us|client>')
  .option('--category <design|development|content|payment|approval|other>')
  .option('--priority <high|medium|low>')
  .option('--assigned-to <name>')
  .option('--asked-by <name>')
  .option('--deadline <YYYY-MM-DD|none>')
  .option('--latest-progress <text>')
  .action((code: string, opts: EditOptions) => {
    const t = withDb((db) => editTask(db, code, opts, new Date()));
    console.log(`${t.code} updated.`);
  });

program
  .command('person')
  .description('Fix people')
  .command('set <number> <role>')
  .description('Mark someone as team or client (number with country code, or a WhatsApp id)')
  .option('--client <code>', 'only in this client group')
  .action((number: string, role: string, opts: { client?: string }) => {
    const n = withDb((db) => setPersonRole(db, number, role, opts.client, new Date()));
    console.log(`Updated ${n} group membership(s).`);
  });

const phase = program.command('phase').description('Fix client phases');
phase
  .command('set <client> <phase>')
  .description("Set a client's current phase")
  .action((client: string, name: string) => {
    withDb((db) => setClientPhase(db, client, name, new Date()));
    console.log('Phase updated.');
  });
phase.command('unlock <client>').description("Let the AI change a client's phase again").action((client: string) => {
  withDb((db) => unlockClientPhase(db, client, new Date()));
  console.log('Phase unlocked.');
});

program.command('rebuild').description('Rebuild and republish the workbook now').action(() => {
  withDb((db) => requestRebuild(db, new Date()));
  console.log('Rebuild requested; the service publishes within about a minute.');
});

program
  .command('reprocess <client>')
  .description('Send already-processed messages from a date onward to the AI again (respects your fixes; costs money)')
  .requiredOption('--since <YYYY-MM-DD>')
  .option('--until <YYYY-MM-DD>', 'last day to include')
  .option('--yes', 'confirm a large job (more than 200 messages)')
  .action((client: string, opts: { since: string; until?: string; yes?: boolean }) => {
    const r = withDb((db) => reprocess(db, client, opts.since, opts.until, opts.yes === true, new Date()));
    if (r.count === 0) {
      console.log('No processed messages in that range; nothing changed.');
    } else if (r.needsConfirm) {
      console.log(`This would send ${r.count} old messages to the AI again (about $${r.maxCostUsd.toFixed(2)} at most). Re-run with --yes to confirm.`);
    } else {
      console.log(`${r.queued} messages re-queued for the AI.`);
      console.log('The running service will now make new AI calls for them. This costs money and counts toward the daily spend cap.');
    }
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : 'Command failed');
  process.exit(1);
});

