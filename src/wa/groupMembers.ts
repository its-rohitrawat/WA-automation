import type { GroupMetadata } from 'baileys';

// Who is in a group, from WhatsApp's group data (Open chat's group info and tagging, November release). A read: the
// founder gateway asks for one approved group's data while open (gateway.groupMembers). No names are kept from it: the
// dashboard names a member from the agent's own people, else shows its number, else says the number is hidden.

export interface GroupMember {
  /**
   * The id WhatsApp uses for this member in this group: a phone-number id (…@s.whatsapp.net) or a hidden-number one
   * (…@lid). A mention names this id.
   */
  id: string;
  /** The member's phone-number id, when WhatsApp gives one; null for a hidden number (never a guessed one). */
  phoneNumber: string | null;
  /** The member's hidden-number id, when WhatsApp gives one. */
  lid: string | null;
  admin: boolean;
}

/**
 * The group's own phone's members of an approved group while open; null when it cannot ask (or the read failed). fresh:
 * not from the 5-minute keep (a send with tags, final review S2), though still through a read already in flight.
 */
export type GroupMembersSource = (groupId: string, o?: MembersRead) => Promise<GroupMember[] | null>;
export type MembersRead = { fresh?: boolean };

/** How long a group's members are kept before WhatsApp is asked again. */
export const MEMBERS_CACHE_MS = 5 * 60_000;
/** How long a failed read is kept: no group is asked again sooner, whoever asks (final review, S6). */
export const MEMBERS_FAILED_MS = 30_000;
/** How long one read may take before it counts as failed. */
export const MEMBERS_READ_MS = 5_000;

/** A person's id: digits, an optional device part (dropped), and a phone-number or hidden-number server. */
const PERSON = /^(\d{5,20})(?::\d{1,3})?@(s\.whatsapp\.net|lid)$/;

/** The id without a device part, when it is a person's; null otherwise. */
function person(v: unknown, server?: 's.whatsapp.net' | 'lid'): string | null {
  if (typeof v !== 'string') return null;
  const m = PERSON.exec(v);
  if (!m || (server && m[2] !== server)) return null;
  return `${m[1]}@${m[2]}`;
}

/** The group's members, each once, in WhatsApp's order. Anything that is not a person's id is left out. */
export function membersOf(meta: Pick<GroupMetadata, 'participants'> | undefined): GroupMember[] {
  const list: unknown = meta?.participants;
  if (!Array.isArray(list)) return [];
  const out: GroupMember[] = [];
  const seen = new Set<string>();
  for (const p of list as unknown[]) {
    if (!p || typeof p !== 'object') continue;
    const r = p as { id?: unknown; lid?: unknown; phoneNumber?: unknown; admin?: unknown };
    const id = person(r.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const pn = id.endsWith('@s.whatsapp.net') ? id : person(r.phoneNumber, 's.whatsapp.net');
    const lid = id.endsWith('@lid') ? id : person(r.lid, 'lid');
    out.push({ id, phoneNumber: pn, lid, admin: r.admin === 'admin' || r.admin === 'superadmin' });
  }
  return out;
}

/** The digits after "@" that tag a member in a message's text: the user part of the id WhatsApp uses. */
export function tagOf(id: string): string {
  return id.split('@')[0]!.split(':')[0]!;
}

/** A tag in a message's text: "@" (not inside a word), then 5 to 20 digits, and no digit after. */
const TAG = /(?<![\p{L}\p{N}_])@(\d{5,20})(?!\d)/gu;

/** The tags a message's text holds, once each, in order: what WhatsApp reads as "@<member>". */
export function mentionTags(text: string): Set<string> {
  return new Set([...text.matchAll(TAG)].map((m) => m[1]!));
}
