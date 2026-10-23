import { closeSync, constants, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { clientFolder } from '../media/paths.ts';
import { getClient } from '../store/clients.ts';
import type { Db } from '../store/db.ts';
import { advanceStage, failMeeting, getMeetingState, MEETING_STAGES, type MeetingRow, type MeetingStage, type MeetingStatus } from '../store/meetings.ts';
import { AudioError, type Ffmpeg } from '../stt/audio.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { istDate } from '../util/time.ts';
import type { MeetingsGoogleApi } from './googleApi.ts';
import { DownloadTooBigError } from './googleErrors.ts';

// Audio preparation (Task 5): the Drive recording is downloaded into the agent's own work folder, made into a mono
// 16 kHz MP3 and measured; the MP3 is kept and the downloaded video deleted. Nothing in Drive is ever changed or deleted
// (M7): the only files removed here are the agent's own work files in data/meetings/tmp/, named <id>.mp4.part, <id>.mp3,
// <id>.mp3.part.mp3 and <id>-parts/. Logs carry ids, counts and codes only, never names or paths.

/** The download cap: a larger file stops the download and the meeting is too_long (too_big). */
export const MEETING_MAX_BYTES = 6 * 1024 ** 3;
/** Free space that must remain on top of the file's size before a download starts. */
export const MEETING_DISK_HEADROOM_BYTES = 10 * 1024 ** 3;

/** The meeting tries again later, without counting an attempt (the processor maps the code to its wait). */
export class MeetingDeferral extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Meeting deferred (${code})`);
    this.name = 'MeetingDeferral';
    this.code = code;
  }
}

/** A final outcome: the processor stores it with failMeeting. */
export class MeetingFailure extends Error {
  readonly status: 'failed' | 'no_access' | 'too_long';
  readonly code: string;
  constructor(status: 'failed' | 'no_access' | 'too_long', code: string) {
    super(`Meeting ${status} (${code})`);
    this.name = 'MeetingFailure';
    this.status = status;
    this.code = code;
  }
}

export interface PrepareAudioDeps {
  db: Db;
  api: MeetingsGoogleApi;
  /** Runs with minimalEnv() by default, so no key in the agent's environment reaches ffmpeg. */
  ffmpeg: Ffmpeg;
  dataDir: string;
  clock: Clock;
  log: Logger;
  /** MEETING_MAX_MINUTES. */
  maxMinutes: number;
  /**
   * Free bytes on the volume of a folder. The caller (Task 10) wraps Health's defaultFreeBytes, whose null (space cannot
   * be read) must be passed on as 0, so the meeting is deferred low_disk rather than downloaded blind.
   */
  freeBytes: (dir: string) => Promise<number>;
}

export type PrepareAudioResult =
  | { outcome: 'audio'; audioPath: string; audioSeconds: number }
  /** Stored as too_long (too_long_measured); the MP3 is kept at audioPath. */
  | { outcome: 'too_long'; audioPath: string; audioSeconds: number };

export const meetingsTmpDir = (dataDir: string): string => join(dataDir, 'meetings', 'tmp');

/** Where a meeting's MP3 is kept, relative to DATA_DIR, with forward slashes: "meetings/SHA/2026-11/12.mp3" (the India month). */
export function meetingAudioRelPath(o: { clientCode: string; startedAt: string; id: number }): string {
  if (!Number.isSafeInteger(o.id) || o.id <= 0) throw new Error('meetingAudioRelPath: the meeting id is not a positive integer');
  return ['meetings', clientFolder(o.clientCode), istDate(new Date(o.startedAt)).slice(0, 7), `${o.id}.mp3`].join('/');
}

/** Removes one of our own work files if it is there. Anything that is not a plain file (a folder, a link) is left alone. */
function removeOwnFile(path: string): void {
  let isFile: boolean;
  try {
    isFile = lstatSync(path).isFile();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  if (isFile) unlinkSync(path);
}

const errno = (e: unknown): unknown => (e as NodeJS.ErrnoException | null)?.code;
const DISK_BUSY: ReadonlySet<unknown> = new Set(['EPERM', 'EBUSY', 'EACCES', 'EXDEV']);

/**
 * A local disk error as a deferral: ENOSPC is disk_full; EPERM, EBUSY, EACCES and EXDEV (a file held by another
 * program, such as a virus scanner, or a folder that cannot be written) are disk_busy. Anything else is returned as it is.
 */
function asDiskError(e: unknown): unknown {
  const code = errno(e);
  if (code === 'ENOSPC') return new MeetingDeferral('disk_full');
  return DISK_BUSY.has(code) ? new MeetingDeferral('disk_busy') : e;
}

/**
 * Moves our MP3 to its kept place. Both are under DATA_DIR, so a rename; if they are on different volumes after all
 * (EXDEV, for example a folder linked elsewhere), the file is copied (never over an existing one), synced to disk, and
 * only then the source removed. A copy that fails is removed: it is the file this call just created. Removing the source
 * after a good copy is best-effort (cleanupTemp removes it at the next start).
 */
function moveFile(from: string, to: string, warn: (code: unknown) => void): void {
  try {
    renameSync(from, to);
    return;
  } catch (e) {
    if (errno(e) !== 'EXDEV') throw e;
  }
  let created = false;
  try {
    copyFileSync(from, to, constants.COPYFILE_EXCL);
    created = true;
    const fd = openSync(to, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    if (created) {
      try {
        removeOwnFile(to);
      } catch (removeErr) {
        warn(errno(removeErr));
      }
    }
    throw e;
  }
  try {
    removeOwnFile(from);
  } catch (e) {
    warn(errno(e));
  }
}

/**
 * Takes a queued meeting at stage found to stage audio:
 * 1. an MP3 already kept for the meeting is reused (measured only);
 * 2. otherwise free space must be at least Drive's size (0 when unknown) plus 10 GB;
 * 3. the recording is downloaded to tmp/<id>.mp4.part (a leftover from a crash is removed first), at most
 *    MEETING_MAX_BYTES;
 * 4. converted to tmp/<id>.mp3 and measured; the video is deleted (best-effort); the MP3 is moved to meetingAudioRelPath;
 * 5. a measured length over maxMinutes is stored as too_long (too_long_measured) with the MP3 and its length kept;
 *    otherwise advanceStage('audio').
 *
 * Outcomes the processor maps:
 * - returns: stage audio, or too_long already stored;
 * - MeetingDeferral (no attempt counted): low_disk (not enough free space), disk_full (ENOSPC while writing), disk_busy
 *   (a local file or folder could not be removed, created or moved: EPERM, EBUSY, EACCES, EXDEV);
 * - MeetingFailure (final): too_long/too_big (over the download cap), failed/bad_audio (a kept MP3 that cannot be measured);
 * - AudioError (ffmpeg failed) and Google errors from videoInfo or download: rethrown as they are, the processor retries;
 * - an abort: the signal's reason, rethrown once ffmpeg has exited.
 * On any failure after the download starts, every work file of this meeting in tmp is removed, so a retry starts with a
 * fresh download: simpler and safer than keeping a large half-processed video between attempts. A kept MP3 is never
 * removed.
 */
export async function prepareAudio(
  meeting: Pick<MeetingRow, 'id' | 'clientId' | 'startedAt' | 'driveFileId'>,
  deps: PrepareAudioDeps,
  signal: AbortSignal,
): Promise<PrepareAudioResult> {
  signal.throwIfAborted();
  const { id } = meeting;
  if (meeting.clientId === null) throw new Error(`prepareAudio: meeting ${id} has no client`);
  const audioPath = meetingAudioRelPath({ clientCode: getClient(deps.db, meeting.clientId).code, startedAt: meeting.startedAt, id });
  const finalAbs = join(deps.dataDir, ...audioPath.split('/'));
  const warn = (code: unknown) => deps.log.warn({ meetingId: id, code }, 'meeting work file could not be removed');

  let audioSeconds: number;
  if (existsSync(finalAbs)) {
    try {
      audioSeconds = await deps.ffmpeg.seconds(finalAbs, signal);
    } catch (e) {
      // Kept, never removed: a person can look at it. `meeting retry` measures it again.
      if (e instanceof AudioError) throw new MeetingFailure('failed', 'bad_audio');
      throw e;
    }
  } else {
    const tmp = meetingsTmpDir(deps.dataDir);
    const video = join(tmp, `${id}.mp4.part`);
    const mp3 = join(tmp, `${id}.mp3`);
    const ffmpegPart = `${mp3}.part.mp3`;
    const removeWorkFiles = () => {
      for (const f of [video, mp3, ffmpegPart]) {
        try {
          removeOwnFile(f);
        } catch (e) {
          warn(errno(e));
        }
      }
    };

    const info = await deps.api.videoInfo(meeting.driveFileId, signal);
    const need = (info.size ?? 0) + MEETING_DISK_HEADROOM_BYTES;
    if ((await deps.freeBytes(deps.dataDir)) < need) throw new MeetingDeferral('low_disk');

    try {
      mkdirSync(tmp, { recursive: true });
      removeOwnFile(video);
      removeOwnFile(ffmpegPart);
      removeOwnFile(mp3);
      try {
        await deps.api.download(meeting.driveFileId, video, MEETING_MAX_BYTES, signal);
      } catch (e) {
        if (e instanceof DownloadTooBigError) throw new MeetingFailure('too_long', 'too_big');
        throw e;
      }
      await deps.ffmpeg.toMp3(video, mp3, signal);
      audioSeconds = await deps.ffmpeg.seconds(mp3, signal);
    } catch (e) {
      removeWorkFiles();
      throw asDiskError(e);
    }
    // The MP3 is good: failing to remove the video must not cost it (cleanupTemp removes the video at the next start).
    try {
      removeOwnFile(video);
    } catch (e) {
      warn(errno(e));
    }
    try {
      mkdirSync(dirname(finalAbs), { recursive: true });
      moveFile(mp3, finalAbs, warn);
    } catch (e) {
      removeWorkFiles();
      throw asDiskError(e);
    }
  }

  const at = deps.clock.now().toISOString();
  if (audioSeconds > deps.maxMinutes * 60) {
    failMeeting(deps.db, id, { status: 'too_long', errorCode: 'too_long_measured', at, audioPath, audioSeconds });
    deps.log.info({ meetingId: id, seconds: Math.round(audioSeconds) }, 'meeting too long by measured length; audio kept');
    return { outcome: 'too_long', audioPath, audioSeconds };
  }
  advanceStage(deps.db, id, 'audio', { audioPath, audioSeconds }, at);
  deps.log.info({ meetingId: id, seconds: Math.round(audioSeconds) }, 'meeting audio prepared');
  return { outcome: 'audio', audioPath, audioSeconds };
}

const TERMINAL: ReadonlySet<MeetingStatus> = new Set(['done', 'skipped', 'internal', 'too_long', 'no_access', 'failed']);
/** Ids are written without leading zeros, so "012.mp3" is never taken for meeting 12's file. */
const WORK_NAME = /^([1-9]\d{0,14})(\.mp4\.part|\.mp3|\.mp3\.part\.mp3|-parts)$/;
const PART_NAME = /^(part-\d{3}\.mp3|\.done)$/;
const stageAtLeast = (stage: MeetingStage, min: MeetingStage): boolean => MEETING_STAGES.indexOf(stage) >= MEETING_STAGES.indexOf(min);

/**
 * At startup: removes the work files in data/meetings/tmp/ that are no longer needed, and nothing else. An entry is
 * removed only when all of these hold:
 * - it sits directly in tmp and its name matches <id>.mp4.part, <id>.mp3, <id>.mp3.part.mp3 or <id>-parts;
 * - the meeting exists and is terminal, or has finished the stage the file is for (audio for the video and MP3 files,
 *   transcribed for the parts folder);
 * - a file is a plain file; a parts folder is a plain folder holding only plain files named part-NNN.mp3 or .done
 *   (anything else: the folder is left whole and the meeting id logged).
 * Links are never followed or removed. Returns counts; logs counts and meeting ids only.
 */
export function cleanupTemp(db: Db, dataDir: string, log: Logger): { removed: number; kept: number } {
  const tmp = meetingsTmpDir(dataDir);
  let entries;
  try {
    entries = readdirSync(tmp, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { removed: 0, kept: 0 };
    throw e;
  }
  let removed = 0;
  let kept = 0;
  for (const entry of entries) {
    const m = WORK_NAME.exec(entry.name);
    const state = m ? getMeetingState(db, Number(m[1])) : undefined;
    const isParts = m?.[2] === '-parts';
    const finished = state !== undefined && (TERMINAL.has(state.status) || stageAtLeast(state.stage, isParts ? 'transcribed' : 'audio'));
    if (!m || !state || !finished) {
      kept++;
      continue;
    }
    const path = join(tmp, entry.name);
    try {
      if (!isParts && entry.isFile()) {
        unlinkSync(path);
        removed++;
      } else if (isParts && entry.isDirectory() && removePartsFolder(path)) {
        removed++;
      } else {
        if (isParts && entry.isDirectory()) log.warn({ meetingId: state.id }, 'meeting parts folder holds unexpected entries; left alone');
        kept++;
      }
    } catch (e) {
      log.warn({ meetingId: state.id, code: (e as NodeJS.ErrnoException).code }, 'meeting work file could not be removed');
      kept++;
    }
  }
  log.info({ removed, kept }, 'meeting work files cleaned');
  return { removed, kept };
}

/** Removes a parts folder only when every entry is a plain file named part-NNN.mp3 or .done. False: left as it is. */
function removePartsFolder(dir: string): boolean {
  const inside = readdirSync(dir, { withFileTypes: true });
  if (!inside.every((e) => e.isFile() && PART_NAME.test(e.name))) return false;
  for (const e of inside) unlinkSync(join(dir, e.name));
  rmdirSync(dir); // not recursive: anything that appeared meanwhile makes this fail, and the folder stays
  return true;
}
