import { Command } from 'commander';
import { googleAuthCommand, linkCommand, listGroupsCommand, statusCommand } from './cli/commands.ts';

const program = new Command().name('wa-agent').description('WA Agent setup and correction commands');

program
  .command('link')
  .description("Link the founder's WhatsApp (stop the service first)")
  .option('--reset', 'discard the saved WhatsApp session only (tracker data is kept); use after WhatsApp unlinked this device')
  .action(async (opts: { reset?: boolean }) => linkCommand({ reset: opts.reset === true }));

program.command('list-groups').description('Show group names and ids on screen (stop the service first)').action(listGroupsCommand);
program.command('status').description('Connection, backlog, failures, spend and disk').action(statusCommand);
program.command('google-auth').description('Connect Google Drive through a browser sign-in').action(googleAuthCommand);

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : 'Command failed');
  process.exit(1);
});
