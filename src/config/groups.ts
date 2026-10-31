import { readFileSync, unwatchFile, watchFile, type Stats } from 'node:fs';
import { z } from 'zod';
import { DomainSchema } from './domains.ts';
import { isMatchablePhrase, MIN_PHRASE_CHARS } from '../util/text.ts';

export const GROUPS_FILE_MISSING_MESSAGE = 'Allow-list file missing. Create config/allowed-groups.json containing { "clients": [] }, run: npm run cli -- list-groups, then add your client groups (see docs/SETUP.md).';

const EXAMPLE_GROUP_ID = '120363000000000001@g.us';
const EXAMPLE_GROUP_MESSAGE =
  'allowed-groups.json still contains the example group. Replace it with real group ids. To find them, set the file to { "clients": [] } and run: npm run cli -- list-groups';

export const DEFAULT_PHASES = ['Discovery', 'Design', 'Development', 'Review', 'Launch'];

const ClientSchema = z.object({
  groupId: z.string().regex(/^[0-9-]+@g\.us$/, 'must look like 120363...@g.us'),
  name: z.string().trim().min(1).max(80),
  code: z.string().regex(/^[A-Z]{3,4}$/, 'must be 3-4 capital letters'),
  phases: z.array(z.string().trim().min(1)).min(1).optional(),
  emailDomains: z.array(DomainSchema).optional(),
  meetingKeywords: z.array(z.string().trim().min(3, 'must be at least 3 characters')).max(20, 'at most 20 per client').optional(),
});

const FileSchema = z.object({ clients: z.array(ClientSchema) });

export interface ClientConfig {
  groupId: string;
  name: string;
  code: string;
  phases: string[];
  emailDomains: string[];
  meetingKeywords: string[];
}

/**
 * Reads and checks allowed-groups.json. A meeting keyword shorter than MIN_PHRASE_CHARS once normalised is refused. A
 * client name that short (for example "AB") is allowed, but it never matches a meeting title: such a client is matched
 * to meetings only by its keywords or email domains.
 */
export function parseGroupsFile(json: string): ClientConfig[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('allowed-groups.json is not valid JSON');
  }
  const parsed = FileSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.map(String).join('.')} ${i.message}`);
    throw new Error(`allowed-groups.json is invalid: ${problems.join('; ')}`);
  }
  const groups = new Set<string>();
  const codes = new Set<string>();
  for (const c of parsed.data.clients) {
    if (c.groupId === EXAMPLE_GROUP_ID) throw new Error(EXAMPLE_GROUP_MESSAGE);
    if (groups.has(c.groupId)) throw new Error(`allowed-groups.json lists group ${c.groupId} twice`);
    if (codes.has(c.code)) throw new Error(`allowed-groups.json uses code ${c.code} twice`);
    // The matcher ignores such a keyword ('c++' is 'c' once punctuation is removed), so it is refused here instead.
    if ((c.meetingKeywords ?? []).some((k) => !isMatchablePhrase(k))) {
      throw new Error(`allowed-groups.json: client ${c.code} has a meeting keyword with fewer than ${MIN_PHRASE_CHARS} letters once punctuation is removed`);
    }
    groups.add(c.groupId);
    codes.add(c.code);
  }
  return parsed.data.clients.map((c) => ({
    groupId: c.groupId,
    name: c.name,
    code: c.code,
    phases: c.phases ?? DEFAULT_PHASES,
    emailDomains: c.emailDomains ?? [],
    meetingKeywords: c.meetingKeywords ?? [],
  }));
}

export function loadGroupsFile(path: string): ClientConfig[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(GROUPS_FILE_MISSING_MESSAGE);
    throw e;
  }
  return parseGroupsFile(text);
}

/** Polls the file (reliable on Windows). Returns a function that stops watching. */
export function watchGroupsFile(
  path: string,
  onChange: (clients: ClientConfig[]) => void | Promise<void>,
  onError: (err: Error) => void,
  intervalMs = 2000,
): () => void {
  const listener = (curr: Stats, prev: Stats) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    try {
      // An onChange that rejects (a code conflict found by the async reload) is reported the same way as one that throws.
      const r = onChange(loadGroupsFile(path));
      if (r instanceof Promise) r.catch((e: unknown) => onError(e as Error));
    } catch (e) {
      onError(e as Error);
    }
  };
  watchFile(path, { interval: intervalMs }, listener);
  return () => unwatchFile(path, listener);
}
