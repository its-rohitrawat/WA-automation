import { pictureWindow } from '../control/chatQueries.ts';
import { getClient } from '../store/clients.ts';
import type { Db } from '../store/db.ts';
import { getKv } from '../store/kv.ts';
import { picturesDue, recordPictureFailed, recordPictureMade, type PictureDue } from '../store/sourcePictures.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import type { GroupMember } from '../wa/groupMembers.ts';
import { drawChatPicture } from './chatPicture.ts';
import { isAuthFailure, type DriveApi } from './drive.ts';
import { DriveRootMissingError, withClientSubfolder } from './folders.ts';

/** At most this many pictures per run, to keep the Mac light; the rest come at the next run. */
export const PICTURES_PER_RUN = 20;
/** After a Google sign-in failure, or when the database cannot save a result, no run starts for this long (as the file uploader). */
const PAUSE_MS = 15 * 60_000;
/** After a Drive failure (a network error, a 5xx or 429 answer, a folder that cannot be made), no run starts for this long. */
const DRIVE_PAUSE_MS = 2 * 60_000;

export interface SourcePicturesOptions {
  db: Db;
  api: DriveApi;
  clock: Clock;
  log: Logger;
  /** The group's members, for a tag the client's people do not name (the gateway's 5-minute keep). Absent: people only. */
  members?: (groupId: string) => Promise<readonly GroupMember[] | null>;
  /** At least one picture reached Drive: the tracker can link it (another upload). */
  onMade: () => void;
  perRun?: number;
}

/** Why runs are paused: the database cannot save a result, Google sign-in failed, or Drive failed. */
type PauseReason = 'ledger' | 'auth' | 'drive';

/** An error's code, or its name: never its message. Short and plain, for the row and the log. */
function codeOf(e: unknown): string {
  const x = e as { code?: unknown; name?: unknown } | null;
  const raw = typeof x?.code === 'string' || typeof x?.code === 'number' ? String(x.code) : typeof x?.name === 'string' ? x.name : 'error';
  return raw.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 60) || 'error';
}

/**
 * Makes each open task's chat picture (owner request, 11 Nov 2026). It picks the tasks due (picturesDue), reads the
 * messages around each source (pictureWindow), draws the picture (drawChatPicture) and uploads it to
 * WA Agent/Clients/<Client>/Sources/<task code>.png, then records it. One run at a time; never deletes or replaces
 * anything in Drive. A changed source gets a new file and the old one stays, as the file uploader leaves its copies.
 * Before the first tracker upload has made the WA Agent folder, a run does nothing. A Google sign-in failure pauses
 * runs for 15 minutes. Any other failure is recorded by its code, and that task is tried again later, each wait longer
 * than the last (picturesDue, retryMs). The step that failed decides what the run does next:
 * - Drive (the Sources folder, or the upload): every other task would fail the same way, so the run stops there and
 *   no run starts for 2 minutes. An outage costs one try per run, not a drawing and a try for every task due.
 * - The messages or the drawing: that picture only, so the run goes on to the next task.
 * The Sources folder is found or made before anything is drawn, so a folder that cannot be made costs no drawing.
 *
 * Duplicate copies are possible, and accepted, for the reasons the file uploader gives: Drive can store a file while
 * its answer never arrives, and the next try then uploads it again. When Drive answers but the database cannot save the
 * id, the id is kept in memory and only the save is retried, never the upload; stop() tries each such save once more.
 * A restart before it is saved forgets it, so that picture is made and uploaded once more. When the database cannot
 * save a result, runs pause for 15 minutes (in memory), so a picture is not drawn and uploaded on every tick.
 */
export class SourcePictures {
  readonly #o: SourcePicturesOptions;
  #current: Promise<void> | undefined;
  #stopped = false;
  #paused: { until: number; reason: PauseReason } | undefined;
  /** Pictures that reached Drive but whose id could not be saved, by task id. */
  readonly #unsaved = new Map<number, { due: PictureDue; fileId: string }>();

  constructor(o: SourcePicturesOptions) {
    this.#o = o;
  }

  /** One run over the tasks that are due. A run already going is shared. Does nothing while paused. Never rejects. */
  run(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    if (!this.#current) {
      this.#current = this.#pass()
        .catch((err: unknown) => this.#o.log.error({ err }, 'source picture run failed'))
        .finally(() => {
          this.#current = undefined;
        });
    }
    return this.#current;
  }

  /**
   * Starts no more runs and waits for the one going, up to timeoutMs. Then tries once more to save each Drive id still
   * held in memory, even while paused. A save that fails is logged (task id and code) and left.
   */
  async stop(timeoutMs: number): Promise<void> {
    this.#stopped = true;
    const current = this.#current;
    if (current) {
      let t: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([current, new Promise<void>((r) => (t = setTimeout(r, timeoutMs)))]);
      clearTimeout(t);
    }
    for (const [taskId, u] of this.#unsaved) {
      try {
        await recordPictureMade(this.#o.db, { ...u.due, driveFileId: u.fileId, at: this.#o.clock.now().toISOString() });
        this.#unsaved.delete(taskId);
      } catch (e) {
        this.#o.log.warn({ taskId, code: codeOf(e) }, 'source picture result could not be saved');
      }
    }
  }

  async #pass(): Promise<void> {
    const { db, api, clock, log } = this.#o;
    if (this.#paused) {
      if (clock.now().getTime() < this.#paused.until) return;
      log.info({ reason: this.#paused.reason }, 'source pictures resumed');
      this.#paused = undefined;
    }
    let made = 0;
    try {
      // First the ids that could not be saved last time. Those pictures are already in Drive and are never uploaded again.
      for (const [taskId, u] of this.#unsaved) {
        try {
          await recordPictureMade(db, { ...u.due, driveFileId: u.fileId, at: clock.now().toISOString() });
        } catch (e) {
          log.warn({ taskId, code: codeOf(e) }, 'source picture result could not be saved');
          this.#pause('ledger', PAUSE_MS);
          return;
        }
        this.#unsaved.delete(taskId);
        made += 1;
      }
      // The first tracker upload makes the WA Agent folder; until then nothing is worth drawing.
      if (!(await getKv(db, 'drive_root_id'))) return;
      const due = await picturesDue(db, clock.now(), this.#o.perRun ?? PICTURES_PER_RUN);
      for (const d of due) {
        if (this.#stopped) break;
        const at = clock.now().toISOString();
        let fileId: string;
        // The step under way, so a failure is told apart by where it happened, not by its error code.
        let step: 'messages' | 'draw' | 'drive' = 'messages';
        try {
          const c = await getClient(db, d.clientId);
          const members = this.#o.members;
          const w = await pictureWindow(db, c, d.messageId, members ? () => members(c.groupId) : undefined);
          if (!w) {
            if (!(await this.#failed(d, 'source_missing', at))) break;
            continue;
          }
          // The Sources folder first, so a folder Drive cannot make costs no drawing. When a folder removed in Drive is
          // rebuilt, put runs again with the picture already drawn.
          let png: Buffer | undefined;
          step = 'drive';
          fileId = await withClientSubfolder(db, api, { clientId: c.id, clientName: c.name }, 'Sources', async (folderId) => {
            if (!png) {
              step = 'draw';
              png = await drawChatPicture(w);
              step = 'drive';
            }
            return api.createFile(`${d.code}.png`, 'image/png', png, folderId);
          });
        } catch (err) {
          if (err instanceof DriveRootMissingError) break; // the first tracker upload makes it; nothing to record
          if (isAuthFailure(err)) {
            this.#pause('auth', PAUSE_MS);
            break;
          }
          const code = codeOf(err);
          log.warn({ taskId: d.taskId, code, step }, 'source picture not made');
          if (!(await this.#failed(d, code, at))) break;
          // Drive failed: every task after this one would fail the same way. The run stops, so an outage costs one try
          // per run, not a drawing and a try for every task due.
          if (step === 'drive') {
            this.#pause('drive', DRIVE_PAUSE_MS);
            break;
          }
          continue; // the messages or the drawing failed: that picture only
        }
        try {
          await recordPictureMade(db, { ...d, driveFileId: fileId, at });
        } catch (e) {
          log.warn({ taskId: d.taskId, code: codeOf(e) }, 'source picture result could not be saved');
          this.#unsaved.set(d.taskId, { due: d, fileId });
          this.#pause('ledger', PAUSE_MS);
          break;
        }
        made += 1;
      }
    } finally {
      if (made > 0) {
        try {
          this.#o.onMade();
        } catch (err) {
          log.error({ err }, 'onMade failed');
        }
      }
    }
  }

  /** Records a failed try. When the database cannot write it, pauses and returns false: the run must stop. */
  async #failed(d: PictureDue, errorCode: string, at: string): Promise<boolean> {
    try {
      await recordPictureFailed(this.#o.db, { ...d, errorCode, at });
      return true;
    } catch (e) {
      this.#o.log.warn({ taskId: d.taskId, code: codeOf(e) }, 'source picture failure not recorded');
      this.#pause('ledger', PAUSE_MS);
      return false;
    }
  }

  /** The one pause for every reason: no run starts until ms from now. In memory only, so a restart ends it too. */
  #pause(reason: PauseReason, ms: number): void {
    const until = this.#o.clock.now().getTime() + ms;
    this.#paused = { until, reason };
    this.#o.log.warn({ reason, until: new Date(until).toISOString() }, 'source pictures paused');
  }
}
