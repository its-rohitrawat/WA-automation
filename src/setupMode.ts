import type { Env } from './config/env.ts';
import { requireKey } from './config/env.ts';
import { hubMeetingAccounts, LiveMeetingsApi } from './meetings/multiAccount.ts';
import { googleDriveApi, type DriveApi } from './output/drive.ts';
import { MAIN_ACCOUNT } from './output/googleAuth.ts';
import { GoogleAuthHub, type OAuthCredentials } from './output/googleAuthHub.ts';
import type { Db } from './store/db.ts';
import type { Logger } from './util/logger.ts';
import type { GatewayLike } from './wa/gateway.ts';
import { SwitchableGateway } from './wa/switchableGateway.ts';

// Setup mode (D3). With the dashboard on, the service starts even when the founder's WhatsApp was never linked or
// Google has no main token: that part waits as 'not linked' / 'not connected', and the owner links it from the
// dashboard (Connections). With the dashboard off, startup is exactly as before: it stops with the same message.

export const WHATSAPP_NOT_LINKED_EXIT = 'WhatsApp is not linked. Stop the service and run: npm run cli -- link';
export const GOOGLE_NOT_CONNECTED_EXIT = 'Google Drive is not connected. Run: npm run cli -- google-auth';

export type StartupPlan = { exit: string } | { whatsapp: 'linked' | 'not_linked'; google: 'connected' | 'not_connected' };

/**
 * Whether the service may start. Dashboard off: no founder link, then no Google token, stop the service (in that order,
 * with today's messages). Dashboard on: it always starts, and says which part waits.
 */
export function planStartup(o: { dashboardEnabled: boolean; whatsappLinked: boolean; googleToken: boolean }): StartupPlan {
  if (!o.dashboardEnabled) {
    if (!o.whatsappLinked) return { exit: WHATSAPP_NOT_LINKED_EXIT };
    if (!o.googleToken) return { exit: GOOGLE_NOT_CONNECTED_EXIT };
  }
  return { whatsapp: o.whatsappLinked ? 'linked' : 'not_linked', google: o.googleToken ? 'connected' : 'not_connected' };
}

/**
 * The OAuth clients from .env. Desktop (google-auth on the Mac): required as before when the dashboard is off, optional
 * with it on (an owner may connect every account from the dashboard). Web (the dashboard): when both names are set.
 */
export function googleCredentials(env: Env): { desktop?: OAuthCredentials; web?: OAuthCredentials } {
  const desktop: OAuthCredentials | undefined = env.DASHBOARD_ENABLED
    ? env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET
      ? { clientId: env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET }
      : undefined
    : { clientId: requireKey(env, 'GOOGLE_OAUTH_CLIENT_ID'), clientSecret: requireKey(env, 'GOOGLE_OAUTH_CLIENT_SECRET') };
  const web: OAuthCredentials | undefined =
    env.DASHBOARD_GOOGLE_CLIENT_ID && env.DASHBOARD_GOOGLE_CLIENT_SECRET
      ? { clientId: env.DASHBOARD_GOOGLE_CLIENT_ID, clientSecret: env.DASHBOARD_GOOGLE_CLIENT_SECRET }
      : undefined;
  return { ...(desktop ? { desktop } : {}), ...(web ? { web } : {}) };
}

/** The founder's gateway inside its holder: the real one when linked, none ('not_linked') in setup mode. */
export function founderGateway(o: { linked: boolean; build: () => GatewayLike }): SwitchableGateway {
  return o.linked ? new SwitchableGateway({ inner: o.build() }) : new SwitchableGateway({ initialState: 'not_linked' });
}

export interface GoogleParts {
  hub: GoogleAuthHub;
  /** Drive for the publisher and the uploader: the main account's current client on every call. */
  drive: DriveApi;
  /** Meetings across every account, rebuilt when one is reconnected. Undefined with meetings off. */
  meetings: LiveMeetingsApi | undefined;
  /** The main account has a usable client (a token this key reads, issued by a configured client). */
  connected(): boolean;
}

/** Google for the service: one hub, with Drive and meetings reading their clients from it. Calls Google for nothing. */
export async function buildGoogle(o: {
  db: Db;
  key: Buffer;
  credentials: { desktop?: OAuthCredentials; web?: OAuthCredentials };
  meetingsEnabled: boolean;
  log: Logger;
  hub?: GoogleAuthHub;
}): Promise<GoogleParts> {
  const hub = o.hub ?? (await GoogleAuthHub.open({ db: o.db, key: o.key, credentials: o.credentials, log: o.log }));
  // Accounts with a stored token that cannot be used, by label and reason only (no token, no email).
  for (const label of hub.labels()) {
    const problem = hub.problem(label);
    if (problem) o.log.warn({ account: label, code: problem }, 'Google account cannot be used; reconnect it (dashboard or google-auth)');
  }
  if (hub.labels().length > 1) o.log.info({ accounts: hub.labels() }, 'several Google accounts');
  const meetings = o.meetingsEnabled ? new LiveMeetingsApi(() => hubMeetingAccounts(o.db, hub), o.log) : undefined;
  if (meetings) hub.onChange(() => void meetings.rebuild());
  return {
    hub,
    drive: googleDriveApi(hub.getter(MAIN_ACCOUNT)),
    meetings,
    connected: () => hub.client(MAIN_ACCOUNT) !== undefined,
  };
}

export { setupLine } from './health/setupLine.ts';
