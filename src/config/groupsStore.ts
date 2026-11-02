import type { Db } from '../store/db.ts';
import { getKv, setKv } from '../store/kv.ts';
import type { Logger } from '../util/logger.ts';
import { loadGroupsFile, parseGroupsFile, type ClientConfig } from './groups.ts';
import { applyGroupChanges, applyToDocument, type FileOps, type GroupChangeResult, type GroupChanges } from './groupsWriter.ts';

// Where an allow-list lives (Phase B). The founder's is config/allowed-groups.json, written as before and reloaded by the
// file watcher. A customer has no file: their list is the same JSON document, kept in their own kv in their own
// database (RLS-scoped on Postgres), changed under the same rules (applyToDocument), and their runtime is told at once
// (onChange: reloadClients, which writes their clients rows as the watcher does for the founder). The document holds
// group ids: it never leaves the customer's database and is never logged.

/** What the dashboard's group routes use: the changes of an approve, remove or edit, and the list as stored now. */
export interface GroupsStore {
  /** As applyGroupChanges: throws GroupChangeError, changing nothing, when a change breaks a rule. */
  apply(changes: GroupChanges): Promise<GroupChangeResult>;
  /** The approved clients as stored now. */
  list(): Promise<ClientConfig[]>;
}

/** The founder's allow-list: config/allowed-groups.json, exactly as before (applyGroupChanges, loadGroupsFile). */
export function fileGroupsStore(path: string, o: { db: Db; ops?: Partial<FileOps> }): GroupsStore {
  return {
    apply: (changes) => applyGroupChanges(path, changes, o),
    list: async () => loadGroupsFile(path),
  };
}

/** The kv key of a customer's allow-list document. */
export const GROUPS_KV_KEY = 'allowed_groups';
/** A customer who has approved nothing yet: the same document an empty file holds. */
const EMPTY = `${JSON.stringify({ clients: [] }, null, 2)}\n`;

/**
 * A customer's allow-list, in their own database. One change at a time, in call order; each reads, checks and writes the
 * document in one transaction. After it commits (never inside it), onChange gets the new list. If onChange fails, the
 * change stands, the failure is logged (its type only) and the result says `warning: 'reload_failed'`: the runtime's
 * next start syncs the clients from the saved list (list()), as the founder's start syncs from the file.
 */
export function dbGroupsStore(o: { db: Db; onChange: (configs: ClientConfig[]) => unknown; log: Logger }): GroupsStore {
  let queue: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn);
    queue = run.catch(() => undefined);
    return run;
  };
  return {
    apply: (changes) =>
      inTurn(async () => {
        const { result, differs } = await o.db.tx(async (q) => {
          const r = await applyToDocument((await getKv(q, GROUPS_KV_KEY)) ?? EMPTY, changes, { db: q });
          if (r.differs) await setKv(q, GROUPS_KV_KEY, r.text);
          return r;
        });
        if (!differs) return result;
        try {
          await o.onChange(result.configs);
        } catch (err) {
          // The type only: the error may name a client or a code.
          o.log.error({ code: (err as Error | null)?.name ?? 'Error' }, 'clients not reloaded after a group change; the next start syncs them');
          return { ...result, warning: 'reload_failed' as const };
        }
        return result;
      }),
    list: async () => parseGroupsFile((await getKv(o.db, GROUPS_KV_KEY)) ?? EMPTY),
  };
}
