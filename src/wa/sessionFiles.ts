import { existsSync, renameSync } from 'node:fs';
import { basename } from 'node:path';
import { istDate, istTime } from '../util/time.ts';

/** "20261026T061500": the IST date and time, safe in a Windows file name. IST is a whole number of minutes ahead of UTC. */
function fileStamp(d: Date): string {
  return `${istDate(d).replace(/-/g, '')}T${istTime(d).replace(':', '')}${String(d.getUTCSeconds()).padStart(2, '0')}`;
}

/**
 * Renames a damaged session file and its -wal and -shm files to `<name>.damaged-<stamp>`. Nothing is deleted, and an
 * earlier damaged copy is never overwritten (a -2, -3 ... suffix is added instead). The -wal and -shm files go first, so
 * a fresh file is never opened next to a stale write-ahead log. Returns the new name of the main file (no folder).
 * Used by `cli link-sender --reset` and the dashboard's spare-phone link.
 */
export function moveDamagedSession(file: string, now: Date): string {
  const parts = ['-wal', '-shm', ''];
  const stamp = fileStamp(now);
  for (let n = 1; ; n++) {
    const suffix = `.damaged-${stamp}${n === 1 ? '' : `-${n}`}`;
    if (parts.some((p) => existsSync(`${file}${p}${suffix}`))) continue;
    for (const p of parts) if (existsSync(`${file}${p}`)) renameSync(`${file}${p}`, `${file}${p}${suffix}`);
    return `${basename(file)}${suffix}`;
  }
}
