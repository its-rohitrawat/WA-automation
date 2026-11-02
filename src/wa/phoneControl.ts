import { maskNumber } from '../config/env.ts';
import type { Audit } from '../control/errors.ts';
import type { Db } from '../store/db.ts';
import type { Logger } from '../util/logger.ts';
import { resetSession, type PhoneId } from './authState.ts';
import type { GatewayLike } from './gateway.ts';
import type { PhoneEntry, PhoneList } from './phoneList.ts';
import type { PhoneSet } from './phoneSet.ts';

// Unlinking a reading phone (lane C, change 7; the design's "Unlink"). The owner confirmed it on the dashboard. In this
// order, each step safe if a later one fails:
//   1. log the linked device out at WhatsApp, so it leaves the phone's Linked devices (it may not answer);
//   2. stop its gateway and take it out of the set: its groups are read by no phone from now on;
//   3. mark it unlinked in the phone list, audited with its label, its masked number and whether WhatsApp confirmed
//      step 1: a restart does not start it again;
//   4. clear its session rows (live and backup): what it was linked with is gone. If this fails, the phone is already
//      unlinked and never started, and the next link of that phone resets its rows anyway.
// Messages, tasks and approvals are not touched: its groups stay approved and show as "phone unlinked".

export interface UnlinkDeps {
  id: PhoneId;
  actor: string;
  audit: Audit;
  list: PhoneList;
  set: PhoneSet;
  /** The phone's own gateway (its SwitchableGateway), whose endLink asks WhatsApp to unlink the device. */
  gateway: Pick<GatewayLike, 'endLink'>;
  /** The phone's own session (its file, or its wa_auth rows). */
  sessionDb: Db;
  /** Its linked number, for the audit line (masked there); undefined when not known. */
  number: string | undefined;
  log: Logger;
}

export interface UnlinkResult {
  phone: PhoneEntry;
  /** False when WhatsApp could not be told: the owner removes "WA Agent - Tracker" from the phone's Linked devices. */
  loggedOut: boolean;
}

export async function unlinkPhone(d: UnlinkDeps): Promise<UnlinkResult> {
  // Before WhatsApp is asked (it may take up to 10 s): a crash while waiting still leaves a trace. No number in it.
  d.log.info({ phone: d.id }, 'asking WhatsApp to unlink a reading phone');
  let loggedOut = false;
  try {
    loggedOut = (await d.gateway.endLink?.()) ?? false;
  } catch {
    loggedOut = false;
  }
  await d.set.remove(d.id);
  const phone = await d.list.unlink(d.id, d.actor, d.audit, d.number ? maskNumber(d.number) : undefined, loggedOut);
  try {
    await resetSession(d.sessionDb);
  } catch (err) {
    d.log.error({ err, phone: d.id }, 'an unlinked phone’s session rows could not be cleared now; its next link resets them');
  }
  return { phone, loggedOut };
}
