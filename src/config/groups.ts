import { readFileSync, unwatchFile, watchFile, type Stats } from 'node:fs';
import { z } from 'zod';

export const DEFAULT_PHASES = ['Discovery', 'Design', 'Development', 'Review', 'Launch'];

const ClientSchema = z.object({
  groupId: z.string().regex(/^[0-9-]+@g\.us$/, 'must look like 120363...@g.us'),
  name: z.string().trim().min(1).max(80),
  code: z.string().regex(/^[A-Z]{3,4}$/, 'must be 3-4 capital letters'),
  phases: z.array(z.string().trim().min(1)).min(1).optional(),
  emailDomains: z.array(z.string()).optional(),
  meetingKeywords: z.array(z.string()).optional(),
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
    if (groups.has(c.groupId)) throw new Error(`allowed-groups.json lists group ${c.groupId} twice`);
    if (codes.has(c.code)) throw new Error(`allowed-groups.json uses code ${c.code} twice`);
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
  return parseGroupsFile(readFileSync(path, 'utf8'));
}

/** Polls the file (reliable on Windows). Returns a function that stops watching. */
export function watchGroupsFile(
  path: string,
  onChange: (clients: ClientConfig[]) => void,
  onError: (err: Error) => void,
  intervalMs = 2000,
): () => void {
  const listener = (curr: Stats, prev: Stats) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    try {
      onChange(loadGroupsFile(path));
    } catch (e) {
      onError(e as Error);
    }
  };
  watchFile(path, { interval: intervalMs }, listener);
  return () => unwatchFile(path, listener);
}
