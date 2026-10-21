import { Command } from 'commander';
import { defaultDeps, googleAuthCommand, linkCommand, listGroupsCommand, statusCommand } from './cli/commands.ts';
import { loadEnv } from './config/env.ts';

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

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : 'Command failed');
  process.exit(1);
});
