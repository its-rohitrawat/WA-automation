import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/** Size and modification time of a recording, saved beside its MP3 as <mp3>.source.json. */
export interface SourcePrint {
  size: number;
  mtimeMs: number;
}

export function sourcePrint(path: string): SourcePrint {
  const st = statSync(path);
  return { size: st.size, mtimeMs: st.mtimeMs };
}

const printFile = (mp3: string): string => `${mp3}.source.json`;

/** The saved print; one that cannot be read counts as different, so a run stops rather than guessing. */
function savedPrint(mp3: string): SourcePrint | 'unreadable' | null {
  const path = printFile(mp3);
  if (!existsSync(path)) return null;
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as Partial<SourcePrint> | null;
    return typeof v?.size === 'number' && typeof v.mtimeMs === 'number' ? { size: v.size, mtimeMs: v.mtimeMs } : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

/**
 * True when a recording no longer matches what was prepared, and maybe sent, from it: its MP3 exists without a saved
 * print, or a saved print differs or cannot be read. Old results must then not be mixed with the new recording.
 */
export function sourceChanged(mp3: string, now: SourcePrint): boolean {
  const saved = savedPrint(mp3);
  if (saved === null) return existsSync(mp3);
  return saved === 'unreadable' || saved.size !== now.size || saved.mtimeMs !== now.mtimeMs;
}

/** Written after the MP3 is made. */
export function saveSourcePrint(mp3: string, print: SourcePrint): void {
  writeFileSync(printFile(mp3), `${JSON.stringify(print)}\n`);
}

/**
 * Takes <dir>\run.lock with an exclusive create, making the folder first. Returns its path, or null when the file is
 * already there: another run is using the folder, or one stopped without removing it.
 */
export function takeRunLock(dir: string, note: string): string | null {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'run.lock');
  let fd: number;
  try {
    fd = openSync(path, 'wx');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw e;
  }
  try {
    writeSync(fd, `${note}\n`);
  } catch (e) {
    closeSync(fd);
    // Our own file, just made: never leave it behind to block the next run.
    rmSync(path, { force: true });
    throw e;
  }
  closeSync(fd);
  return path;
}
