import type { ClientConfig } from '../config/groups.ts';
import { listClients } from '../store/clients.ts';
import type { Db } from '../store/db.ts';
import type { Clock } from '../util/clock.ts';
import type { GatewayState } from '../wa/gateway.ts';

// The dashboard's group list (D2). Names come live from the running WhatsApp gateway and are kept in memory only: a group
// name reaches disk only when the owner approves the group (groupsWriter.ts). Names are untrusted text; the web layer
// renders them as text, never as HTML.

/** What the directory needs from the gateway (the real WhatsAppGateway, or the SwitchableGateway around it). */
export interface GroupSource {
  status(): { state: GatewayState };
  listGroups(): Promise<{ id: string; subject: string }[]>;
}

export interface LiveGroup {
  id: string;
  subject: string;
}

export type ListingReason = 'whatsapp_not_connected' | 'list_failed';

export interface GroupListing {
  groups: LiveGroup[];
  /** True when the groups are not a fresh answer from an open connection (the last cache, or none). */
  stale: boolean;
  reason: ListingReason | null;
  /** When the groups were fetched; null when never. */
  fetchedAt: string | null;
}

const DEFAULT_TTL_MS = 600_000;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 500;

/** The live group list, cached for ttlMs. Concurrent calls share one request to WhatsApp. */
export class GroupDirectory {
  readonly #gateway: GroupSource;
  readonly #clock: Clock;
  readonly #ttlMs: number;
  readonly #fetchTimeoutMs: number;
  #cache: { groups: LiveGroup[]; at: number } | undefined;
  #inFlight: Promise<GroupListing> | undefined;
  /** What the last list() answer said, for cachedListing. */
  #last: { stale: boolean; reason: ListingReason | null } | undefined;

  /** fetchTimeoutMs bounds one listGroups call (Baileys itself may wait about 60 s). */
  constructor(o: { gateway: GroupSource; clock: Clock; ttlMs?: number; fetchTimeoutMs?: number }) {
    this.#gateway = o.gateway;
    this.#clock = o.clock;
    this.#ttlMs = o.ttlMs ?? DEFAULT_TTL_MS;
    this.#fetchTimeoutMs = o.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  }

  async list(opts: { refresh?: boolean } = {}): Promise<GroupListing> {
    // The connection first: a fresh cache is still stale once WhatsApp has dropped, so the owner sees why.
    if (this.#gateway.status().state !== 'open') return this.#fromCache(true, 'whatsapp_not_connected');
    if (this.#inFlight) return copy(await this.#inFlight);
    const now = this.#clock.now().getTime();
    const fresh = this.#cache !== undefined && now - this.#cache.at < this.#ttlMs;
    if (fresh && !opts.refresh) return this.#fromCache(false, null);
    const request = this.#fetch();
    this.#inFlight = request;
    try {
      return copy(await request);
    } finally {
      this.#inFlight = undefined;
    }
  }

  async #fetch(): Promise<GroupListing> {
    let groups: LiveGroup[];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), this.#fetchTimeoutMs);
      });
      groups = (await Promise.race([this.#gateway.listGroups(), timeout])).map((g) => ({ id: g.id, subject: g.subject ?? '' }));
    } catch {
      // The connection may have closed while listing. No error text is kept: it could carry group details.
      return this.#fromCache(true, this.#gateway.status().state === 'open' ? 'list_failed' : 'whatsapp_not_connected');
    } finally {
      clearTimeout(timer);
    }
    this.#cache = { groups, at: this.#clock.now().getTime() };
    return this.#fromCache(false, null);
  }

  /** The groups of the last list, as copies, without asking WhatsApp; null before the first list. */
  cachedGroups(): LiveGroup[] | null {
    return this.#cache ? this.#cache.groups.map((g) => ({ ...g })) : null;
  }

  /**
   * The last list as a listing, without asking WhatsApp. Stale when WhatsApp is not open, before the first list, or when
   * the last answer was stale; the reason 'list_failed' is kept only while WhatsApp is open.
   */
  cachedListing(): GroupListing {
    if (this.#gateway.status().state !== 'open') return this.#view(true, 'whatsapp_not_connected');
    const last = this.#last;
    return this.#view(last?.stale ?? true, last?.reason === 'list_failed' ? 'list_failed' : null);
  }

  /** The answer list() gives; remembered for cachedListing. */
  #fromCache(stale: boolean, reason: ListingReason | null): GroupListing {
    this.#last = { stale, reason };
    return this.#view(stale, reason);
  }

  #view(stale: boolean, reason: ListingReason | null): GroupListing {
    const c = this.#cache;
    return copy({ groups: c?.groups ?? [], stale, reason, fetchedAt: c ? new Date(c.at).toISOString() : null });
  }
}

function copy(l: GroupListing): GroupListing {
  return { ...l, groups: l.groups.map((g) => ({ ...g })) };
}

/** Lower case, accents removed, runs of white space as one space: what search compares. */
export function searchKey(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export type GroupFilter = 'all' | 'approved' | 'not_approved' | 'ignored';

export interface GroupClientInfo {
  name: string;
  code: string;
  /** The client row is active (false for a group approved in the file but not synced yet, or synced as inactive). */
  active: boolean;
  hasTasks: boolean;
  /** The client row exists in the DB, so the code is permanent (syncClients refuses a change). */
  codeLocked: boolean;
  emailDomains: string[];
  meetingKeywords: string[];
}

export interface GroupRow {
  groupId: string;
  /** The WhatsApp group name; for an approved group missing from the list, the client's name. */
  name: string;
  approved: boolean;
  /** False only for an approved group that a fresh list no longer has ("No longer in WhatsApp"). */
  inWhatsApp: boolean;
  /** The owner set this untracked group aside (Ignore): it leaves the Not approved list. Never true for an approved group. */
  ignored: boolean;
  client: GroupClientInfo | null;
}

export interface GroupsOverview {
  rows: GroupRow[];
  /** Rows matching the search and filter, before the limit. */
  total: number;
  /** Over every group, ignoring search and filter. all counts ignored groups too; notApproved does not. */
  counts: { all: number; approved: number; notApproved: number; ignored: number };
  stale: boolean;
  reason: ListingReason | null;
  fetchedAt: string | null;
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/**
 * The Manage groups list: the live groups merged with the allow-list (configs) and the clients table. Approved groups
 * first, then by name. Search matches the group name and the client name, ignoring case and accents. `ignored` says
 * which untracked groups the owner set aside: the not_approved filter leaves them out, the ignored filter shows only them.
 */
export async function groupsOverview(o: {
  db: Db;
  listing: GroupListing;
  configs: readonly ClientConfig[];
  q?: string;
  filter?: GroupFilter;
  limit?: number;
  ignored?: (groupId: string) => boolean;
}): Promise<GroupsOverview> {
  const { db, listing } = o;
  const isIgnored = o.ignored ?? (() => false);
  const byGroup = new Map((await listClients(db, false)).map((c) => [c.groupId, c]));
  const withTasks = new Set((await db.all<{ id: number }>('SELECT DISTINCT client_id AS id FROM tasks')).map((r) => r.id));
  const approved = new Map(o.configs.map((c) => [c.groupId, c]));
  const liveIds = new Set(listing.groups.map((g) => g.id));

  const clientInfo = (c: ClientConfig): GroupClientInfo => {
    const row = byGroup.get(c.groupId);
    return {
      name: c.name, code: c.code, active: row?.active ?? false, hasTasks: row ? withTasks.has(row.id) : false, codeLocked: row !== undefined,
      emailDomains: [...c.emailDomains], meetingKeywords: [...c.meetingKeywords],
    };
  };

  // A group removed earlier keeps its client row: approving it again must use that code, so the row says so.
  const formerClient = (groupId: string): GroupClientInfo | null => {
    const row = byGroup.get(groupId);
    return row ? { name: row.name, code: row.code, active: row.active, hasTasks: withTasks.has(row.id), codeLocked: true, emailDomains: [], meetingKeywords: [] } : null;
  };

  const rows: GroupRow[] = listing.groups.map((g) => {
    const c = approved.get(g.id);
    return {
      groupId: g.id, name: g.subject, approved: c !== undefined, inWhatsApp: true, ignored: c === undefined && isIgnored(g.id),
      client: c ? clientInfo(c) : formerClient(g.id),
    };
  });
  for (const c of o.configs) {
    if (liveIds.has(c.groupId)) continue;
    // A stale list says nothing about whether the group still exists.
    rows.push({ groupId: c.groupId, name: c.name, approved: true, inWhatsApp: listing.stale, ignored: false, client: clientInfo(c) });
  }
  rows.sort((a, b) => Number(b.approved) - Number(a.approved) || collator.compare(a.name, b.name) || a.groupId.localeCompare(b.groupId));

  const approvedCount = rows.filter((r) => r.approved).length;
  const ignoredCount = rows.filter((r) => r.ignored).length;
  const q = searchKey(o.q ?? '');
  const filter = o.filter ?? 'all';
  const inFilter = (r: GroupRow) =>
    filter === 'all' || (filter === 'approved' ? r.approved : filter === 'ignored' ? r.ignored : !r.approved && !r.ignored);
  const matching = rows.filter(
    (r) => inFilter(r) && (q === '' || searchKey(r.name).includes(q) || (r.client !== null && searchKey(r.client.name).includes(q))),
  );
  const limit = Number.isFinite(o.limit) ? Math.max(0, Math.floor(o.limit!)) : DEFAULT_LIMIT;
  return {
    rows: matching.slice(0, limit),
    total: matching.length,
    counts: { all: rows.length, approved: approvedCount, notApproved: rows.length - approvedCount - ignoredCount, ignored: ignoredCount },
    stale: listing.stale,
    reason: listing.reason,
    fetchedAt: listing.fetchedAt,
  };
}
