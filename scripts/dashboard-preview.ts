// A local preview of the dashboard: the real web server and front end with fixed fake data (scripts/dashboardFake.ts),
// already signed in as a test owner. Listens on 127.0.0.1 only. Sign out and "Continue with Google" work (the fake
// sign-in skips Google). Nothing touches the agent, WhatsApp, Google, a database or any data folder.
//
//   npm run preview:dashboard [-- --port 8790] [-- --empty] [-- --setup]
//
// --setup starts as a new install with no founder link (the Overview asks to link the phone). Linking a phone runs a
// fake link (two codes, a scan, done). Continue with Google opens Google's real page, which refuses the fake request.
//
// Stop it with Ctrl+C.
import { fakeDashboard } from './dashboardFake.ts';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const port = Number(arg('port') ?? 8790);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('--port must be a number from 1024 to 65535');

const web = fakeDashboard({ port, state: { signedIn: true, empty: process.argv.includes('--empty'), setup: process.argv.includes('--setup') } });
const { port: bound } = await web.start();
console.log(`Dashboard preview (fake data) on http://127.0.0.1:${bound}/dashboard - Ctrl+C to stop.`);

const stop = () => {
  void web.stop().then(() => process.exit(0));
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
