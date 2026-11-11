import { pictureWindow } from '../control/chatQueries.ts';
import { getClient } from '../store/clients.ts';
import type { Db } from '../store/db.ts';
import { picturesDue, recordPictureFailed, recordPictureMade } from '../store/sourcePictures.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import type { GroupMember } from '../wa/groupMembers.ts';
import { drawChatPicture } from './chatPicture.ts';
import { isAuthFailure, type DriveApi } from './drive.ts';
import { DriveRootMissingError, withClientSubfolder } from './folders.ts';

/** At most this many pictures per run, to keep the Mac light; the rest come at the next run. */
export const PICTURES_PER_RUN = 20;
/** After a Google sign-in failure no run starts for this long (as the file uploader). */
const PAUSE_MS = 15 * 60_000;

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
 * runs for 15 minutes; any other failure is recorded by its code and tried again later (picturesDue).
 */
export class SourcePictures {
  readonly #o: SourcePicturesOptions;
  #current: Promise<void> | undefined;
  #stopped = false;
  #pausedUntil = 0;

  constructor(o: SourcePicturesOptions) {
    this.#o = o;
  }

  /** One run over the tasks that are due. A run already going is shared. Does nothing while paused. Never rejects. */
  run(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    if (!this.#current) {
      this.#current = this.#pass()
        .catch((err: unknown) => this.#o.log.error({ err: { name: (err as Error)?.name } }, 'source picture run failed'))
        .finally(() => {
          this.#current = undefined;
        });
    }
    return this.#current;
  }

  /** Starts no more runs and waits for the one going, up to timeoutMs. */
  async stop(timeoutMs: number): Promise<void> {
    this.#stopped = true;
    const current = this.#current;
    if (!current) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([current, new Promise<void>((r) => (t = setTimeout(r, timeoutMs)))]);
    clearTimeout(t);
  }

  async #pass(): Promise<void> {
    const { db, api, clock, log } = this.#o;
    if (clock.now().getTime() < this.#pausedUntil) return;
    const due = await picturesDue(db, clock.now(), this.#o.perRun ?? PICTURES_PER_RUN);
    let made = 0;
    for (const d of due) {
      if (this.#stopped) break;
      const at = clock.now().toISOString();
      try {
        const c = await getClient(db, d.clientId);
        const members = this.#o.members;
        const w = await pictureWindow(db, c, d.messageId, members ? () => members(c.groupId) : undefined);
        if (!w) {
          await recordPictureFailed(db, { ...d, errorCode: 'source_missing', at });
          continue;
        }
        const png = await drawChatPicture(w);
        const fileId = await withClientSubfolder(db, api, { clientId: c.id, clientName: c.name }, 'Sources', (folderId) =>
          api.createFile(`${d.code}.png`, 'image/png', png, folderId));
        await recordPictureMade(db, { ...d, driveFileId: fileId, at });
        made += 1;
      } catch (err) {
        if (err instanceof DriveRootMissingError) break; // the first tracker upload makes it; nothing to record
        if (isAuthFailure(err)) {
          this.#pausedUntil = clock.now().getTime() + PAUSE_MS;
          log.warn({ until: new Date(this.#pausedUntil).toISOString() }, 'source pictures paused: Google sign-in failed');
          break;
        }
        const code = codeOf(err);
        log.warn({ taskId: d.taskId, err: code }, 'source picture not made');
        await recordPictureFailed(db, { ...d, errorCode: code, at }).catch((e: unknown) =>
          log.warn({ taskId: d.taskId, err: codeOf(e) }, 'source picture failure not recorded'));
      }
    }
    if (made > 0) this.#o.onMade();
  }
}
