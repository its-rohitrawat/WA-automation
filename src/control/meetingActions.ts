import { CorrectionError } from '../cli/corrections.ts';
import { assignMeetingToClient, retryMeetingById, skipMeetingById } from '../cli/meetings.ts';
import type { SpendGuard } from '../spend/spendGuard.ts';
import { tx, type Db } from '../store/db.ts';
import { getMeetingState } from '../store/meetings.ts';
import { ControlError, type Audit } from './errors.ts';
import { meetingDetail, parseMeetingId, type AccountOf, type DashboardMeetingDetail } from './meetingQueries.ts';

// The Meetings screen's changes (D4 Task 3). Each one is the CLI's own command (src/cli/meetings.ts), run in-process.
// Never meetingBackfillCommand: it takes the data-folder lock, which the running service holds. The audit line names
// the meeting id and client code only, never the title.

export const MEETING_ACTIONS = ['assign', 'skip', 'retry'] as const;
export type MeetingAction = (typeof MEETING_ACTIONS)[number];

/**
 * Shown with every assign and retry: both queue the meeting for paid speech-to-text and AI calls (the CLI's assign says
 * so too). A skip costs nothing.
 */
export const MEETING_COST_WARNING = 'Processing a meeting costs money';
export const SPEND_CAP_REFUSAL = "Today's AI spending limit is reached. Try again after midnight IST.";

export interface MeetingActionResult {
  meeting: DashboardMeetingDetail;
  /** Set for an assign or a retry. */
  warning?: string;
}

/** The CLI's own hint, in the dashboard's words. */
const dashboardWords = (message: string) => message.replace(/; run meeting list again$/, '; refresh the list and try again');

function clientCode(body: unknown): string {
  const raw = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>).client : undefined;
  const code = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (!/^[A-Z]{3,4}$/.test(code)) throw new ControlError(422, 'client must be a client code of 3 or 4 letters', 'client');
  return code;
}

/** A CorrectionError in the dashboard's terms: a client problem is 422 on the client field, any other refusal 409. */
function fromCorrection(e: CorrectionError): ControlError {
  if (/^(No client with code |Client \S+ is not in the allow-list)/.test(e.message)) return new ControlError(422, e.message, 'client');
  return new ControlError(409, dashboardWords(e.message));
}

/**
 * Runs one meeting action and returns the fresh detail. The change and its audit line are one transaction. A retry is
 * refused while today's spend cap is reached. Throws ControlError: 400 an unknown action, 404 no such meeting, 409 the
 * meeting's status does not allow it or the cap is reached, 422 a bad client.
 */
export function runMeetingAction(
  db: Db,
  req: { id: string; action: string; body?: unknown },
  ctx: { actor: string; now: Date; audit: Audit; spend: Pick<SpendGuard, 'isPaused'>; accountOf?: AccountOf },
): MeetingActionResult {
  if (!(MEETING_ACTIONS as readonly string[]).includes(req.action)) {
    throw new ControlError(400, `action must be one of: ${MEETING_ACTIONS.join(', ')}`, 'action');
  }
  const action = req.action as MeetingAction;
  const id = parseMeetingId(req.id);
  if (id === undefined) throw new ControlError(404, 'No meeting with that id');
  if (!getMeetingState(db, id)) throw new ControlError(404, `No meeting ${id}`);
  const code = action === 'assign' ? clientCode(req.body) : undefined;
  if (action === 'retry' && ctx.spend.isPaused()) throw new ControlError(409, SPEND_CAP_REFUSAL);
  const { now } = ctx;
  try {
    tx(db, () => {
      let line: string;
      switch (action) {
        case 'assign': {
          const r = assignMeetingToClient(db, String(id), code!, now);
          line = `Meeting ${id} assigned to ${r.code}`;
          break;
        }
        case 'skip':
          skipMeetingById(db, String(id), now);
          line = `Meeting ${id} skipped`;
          break;
        case 'retry':
          line = retryMeetingById(db, String(id), now).status === 'queued'
            ? `Meeting ${id} queued again`
            : `Meeting ${id} has no client, so it is unassigned again`;
          break;
      }
      ctx.audit({ actor: ctx.actor, event: `meeting.${action}`, kind: 'meeting', detail: line });
    });
  } catch (e) {
    if (e instanceof CorrectionError) throw fromCorrection(e);
    throw e;
  }
  const meeting = meetingDetail(db, String(id), now, ctx.accountOf)!;
  return action === 'skip' ? { meeting } : { meeting, warning: MEETING_COST_WARNING };
}
