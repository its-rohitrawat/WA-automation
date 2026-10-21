import { Command } from 'commander';
import { defaultDeps, googleAuthCommand, linkCommand, listGroupsCommand, statusCommand } from './cli/commands.ts';
import { loadEnv } from './config/env.ts';
import { trackerDbPath } from './config/paths.ts';
import { openDb, type Db } from './store/db.ts';
import { closeTask, editTask, reopenTask, requestRebuild, requestReprocess, setClientPhase, setPersonRole, type EditOptions } from './cli/corrections.ts';

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
  .description('Mark someone as team or client')
  .option('--client <code>', 'only in this client group')
  .action((number: string, role: string, opts: { client?: string }) => {
    const n = withDb((db) => setPersonRole(db, number, role, opts.client, new Date()));
    console.log(`Updated ${n} group membership(s).`);
  });

program
  .command('phase')
  .description('Fix client phases')
  .command('set <client> <phase>')
  .description("Set a client's current phase")
  .action((client: string, phase: string) => {
    withDb((db) => setClientPhase(db, client, phase, new Date()));
    console.log('Phase updated.');
  });

program.command('rebuild').description('Rebuild and republish the workbook now').action(() => {
  withDb((db) => requestRebuild(db, new Date()));
  console.log('Rebuild requested; the service publishes within about a minute.');
});

program
  .command('reprocess <client>')
  .description('Send messages from a date onward to the AI again (respects your fixes)')
  .requiredOption('--since <YYYY-MM-DD>')
  .action((client: string, opts: { since: string }) => {
    const n = withDb((db) => requestReprocess(db, client, opts.since, new Date()));
    console.log(`${n} messages re-queued for the AI.`);
    console.log('The running service will now make new AI calls for them. This costs money and counts toward the daily spend cap.');
  });
program.parseAsync(process.argv).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : 'Command failed');
  process.exit(1);
});

