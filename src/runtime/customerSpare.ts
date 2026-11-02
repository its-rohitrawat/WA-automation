import { spareLinkDriver, type SpareLinkDeps } from '../report/senderLink.ts';
import { openSenderSession, sessionStored } from '../wa/authState.ts';
import type { LinkDriver } from '../wa/linkSession.ts';

// A customer's own spare phone (S4.6 A). The founder's spare is the morning report's (openMorningReport); a customer has
// no report in Phase B, so its spare is only linked: into its own session rows, under its data key, and never to its own
// main number. No recipient: there is no report to send to.

export interface CustomerSpare {
  /** The dashboard's spare link driver; a kept link marks the spare as linked. */
  driver: LinkDriver;
  /** Whether the spare has a linked session (read at start, set when a link is kept). */
  linked(): boolean;
}

export async function customerSpare(d: Omit<SpareLinkDeps, 'recipient' | 'reportDb' | 'scheduler' | 'makeSender' | 'adoptDb'> & {
  sessions: NonNullable<SpareLinkDeps['sessions']>;
}): Promise<CustomerSpare> {
  // Read without creating a session: only a phone with rows is opened.
  let linked = false;
  if (await sessionStored(d.sessions, 'spare')) {
    const s = await openSenderSession(d.sessions, d.key);
    if (s.ok) {
      linked = s.auth.hasSession;
      await s.db.close();
    }
  }
  const inner = spareLinkDriver({ ...d, recipient: () => undefined });
  return {
    driver: {
      ...inner,
      async run(hooks, signal) {
        const r = await inner.run(hooks, signal);
        if (r.ok) linked = true;
        return r;
      },
    },
    linked: () => linked,
  };
}
