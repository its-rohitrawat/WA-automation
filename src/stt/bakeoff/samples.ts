import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, extname, join, parse, resolve } from 'node:path';
import type { SampleKind } from '../types.ts';

export interface Sample {
  /** Built from the file's own name only, so other files coming or going never move it; names its files in the output folder. */
  id: string;
  kind: SampleKind;
  path: string;
}

export const SAMPLE_FOLDERS: Record<SampleKind, string> = { voice: 'voice-notes', meeting: 'meetings' };

const MEDIA_EXTENSIONS = new Set(['.ogg', '.opus', '.oga', '.m4a', '.mp3', '.wav', '.aac', '.amr', '.flac', '.mp4', '.webm', '.mkv', '.mov']);

function slug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return s || 'file';
}

/**
 * <kind>-<slug>-<hash>, where hash is the first 8 hex characters of sha256 of the NFC file name. The slug keeps the id
 * readable; the hash keeps names that slug alike apart without depending on which other files exist. NFC, so a name
 * copied from a Mac (decomposed accents) keeps its id.
 */
function sampleId(kind: SampleKind, name: string): string {
  const nfc = name.normalize('NFC');
  return `${kind}-${slug(parse(nfc).name)}-${createHash('sha256').update(nfc).digest('hex').slice(0, 8)}`;
}

/** Audio and video files directly inside <root>\voice-notes and <root>\meetings, sorted by name. Sub-folders are ignored. */
export function findSamples(root: string): Sample[] {
  const out: Sample[] = [];
  const used = new Set<string>();
  for (const kind of ['voice', 'meeting'] as const) {
    const dir = join(root, SAMPLE_FOLDERS[kind]);
    if (!existsSync(dir)) continue;
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && MEDIA_EXTENSIONS.has(extname(e.name).toLowerCase()))
      .map((e) => e.name)
      .sort();
    for (const name of names) {
      const id = sampleId(kind, name);
      // The ledger is keyed by id: two recordings sharing one would share results, so stop instead.
      if (used.has(id)) throw Object.assign(new Error(`Two recordings get the same id ${id}; rename one of them.`), { code: 'duplicate_sample_id' });
      used.add(id);
      out.push({ id, kind, path: join(dir, name) });
    }
  }
  return out;
}

/** True when dir, or a folder above it, holds a .git entry: a repository, or a worktree (where .git is a file). */
export function insideGitRepo(dir: string): boolean {
  let p = resolve(dir);
  for (;;) {
    if (existsSync(join(p, '.git'))) return true;
    const parent = dirname(p);
    if (parent === p) return false;
    p = parent;
  }
}
