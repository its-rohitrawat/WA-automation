import { drive } from '@googleapis/drive';
import type { Db } from '../store/db.ts';
import type { Logger } from '../util/logger.ts';
import { accountEmail, grantedScopes, saveAccountEmail, type OAuth2Client } from './googleAuth.ts';
import type { GoogleAuthHub } from './googleAuthHub.ts';

/** Asks Google which address an account's client belongs to; null when it does not say. */
export type EmailLookup = (client: OAuth2Client) => Promise<string | null>;

/** Drive's own answer (about.get, the signed-in user's address only). Needs a Drive scope such as drive.file. */
export const driveAboutEmail: EmailLookup = async (client) => {
  const r = await drive({ version: 'v3', auth: client, timeout: 15_000 }).about.get({ fields: 'user(emailAddress)' });
  const email = r.data.user?.emailAddress;
  return typeof email === 'string' ? email : null;
};

/** The Drive scopes about.get answers with (the main account's drive.file among them); meeting-only accounts have none. */
const ABOUT_SCOPES = ['drive.file', 'drive', 'drive.readonly', 'drive.metadata.readonly'].map((s) => `https://www.googleapis.com/auth/${s}`);
const hasDriveScope = (db: Db, label: string) => grantedScopes(db, label).some((s) => ABOUT_SCOPES.includes(s));

/**
 * Fills the email of accounts connected before the dashboard asked for one (google-auth): once per account, at startup
 * and after a reconnect, through Drive when the account has a Drive scope. An account without a usable client or a Drive
 * scope, or whose lookup fails, stays without an email (the dashboard says so); a failure is logged by the account's
 * label and the error's type only, never the address. Returns how many were filled.
 */
export async function fillAccountEmails(o: { db: Db; hub: GoogleAuthHub; log: Logger; lookup?: EmailLookup; labels?: readonly string[] }): Promise<number> {
  const lookup = o.lookup ?? driveAboutEmail;
  let filled = 0;
  for (const label of o.labels ?? o.hub.labels()) {
    if (accountEmail(o.db, label) !== null || !hasDriveScope(o.db, label)) continue;
    const client = o.hub.client(label);
    if (!client) continue;
    try {
      const email = await lookup(client);
      // A reconnect while Google answered brings its own email: keep that, never this older answer.
      if (o.hub.client(label) !== client || accountEmail(o.db, label) !== null) continue;
      if (email !== null && saveAccountEmail(o.db, label, email)) filled++;
    } catch (err) {
      o.log.warn({ account: label, code: (err as Error | null)?.name ?? 'Error' }, 'Google account email could not be read; the dashboard shows it after a reconnect');
    }
  }
  return filled;
}
