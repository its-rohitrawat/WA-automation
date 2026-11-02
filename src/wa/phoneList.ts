import { ControlError, type Audit } from '../control/errors.ts';
import type { Db } from '../store/db.ts';
import { getKv, setKv } from '../store/kv.ts';
import type { Clock } from '../util/clock.ts';
import { MAX_PHONES, type PhoneId } from './authState.ts';

// The workspace's reading phones (lane C, change 7; docs/superpowers/specs/2026-11-02-nov-c-phones-design.md): up to
// five, in the workspace's own kv (tracker.db, or kv under row security on Postgres). Nothing stored means phone 1 alone,
// "Phone 1", active: today's phone, so an existing install changes nothing until the owner adds a phone. Changes are made
// one at a time (one runtime per workspace holds this list), each in one transaction with its audit row.

export const PHONES_KV_KEY = 'wa_phones';
const LABEL_MAX = 40;

export interface PhoneEntry {
  id: PhoneId;
  label: string;
  /** active: its gateway runs (linked, or waiting for a link). unlinked: stopped by the owner; its groups stay its own. */
  state: 'active' | 'unlinked';
  /** When it was added; null for phone 1 kept from before phones were numbered. */
  addedAt: string | null;
  unlinkedAt?: string;
}

const DEFAULT: readonly PhoneEntry[] = [{ id: 1, label: 'Phone 1', state: 'active', addedAt: null }];

/** One line of plain text, 1 to 40 characters: control, line-break and direction characters become spaces. */
function cleanLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const one = raw.replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return one.length >= 1 && one.length <= LABEL_MAX ? one : null;
}

/** The stored document, checked: anything unreadable is the default (phone 1), never a crash at start. */
function parse(raw: string | undefined): PhoneEntry[] {
  if (raw === undefined) return DEFAULT.map((p) => ({ ...p }));
  try {
    const doc = JSON.parse(raw) as { phones?: unknown };
    const out: PhoneEntry[] = [];
    for (const p of Array.isArray(doc.phones) ? doc.phones : []) {
      const e = p as Partial<PhoneEntry>;
      const label = cleanLabel(e.label);
      if (!Number.isInteger(e.id) || e.id! < 1 || e.id! > MAX_PHONES || label === null || out.some((x) => x.id === e.id)) continue;
      if (e.state !== 'active' && e.state !== 'unlinked') continue;
      out.push({
        id: e.id as PhoneId, label, state: e.state, addedAt: typeof e.addedAt === 'string' ? e.addedAt : null,
        ...(e.state === 'unlinked' && typeof e.unlinkedAt === 'string' ? { unlinkedAt: e.unlinkedAt } : {}),
      });
    }
    return out.length > 0 ? out.sort((a, b) => a.id - b.id) : DEFAULT.map((p) => ({ ...p }));
  } catch {
    return DEFAULT.map((p) => ({ ...p }));
  }
}

export interface PhoneListDeps {
  db: Db;
  clock: Clock;
  /** How many approved groups are on a phone (from the workspace's approved groups): a phone with any is not removed. */
  groupsOn: (id: PhoneId) => number;
}

export class PhoneList {
  readonly #d: PhoneListDeps;
  #phones: PhoneEntry[];
  #saving: Promise<unknown> = Promise.resolve();

  private constructor(d: PhoneListDeps, phones: PhoneEntry[]) {
    this.#d = d;
    this.#phones = phones;
  }

  static async open(d: PhoneListDeps): Promise<PhoneList> {
    return new PhoneList(d, parse(await getKv(d.db, PHONES_KV_KEY)));
  }

  /** The phones, by number. */
  list(): PhoneEntry[] {
    return this.#phones.map((p) => ({ ...p }));
  }

  get(id: number): PhoneEntry | undefined {
    const p = this.#phones.find((x) => x.id === id);
    return p ? { ...p } : undefined;
  }

  /** A new phone, under the lowest free number from 2 to 5. */
  add(rawLabel: unknown, actor: string, audit: Audit): Promise<PhoneEntry> {
    return this.#change(async (phones, at) => {
      const label = this.#label(rawLabel, phones);
      const id = ([1, 2, 3, 4, 5] as PhoneId[]).find((n) => !phones.some((p) => p.id === n));
      if (id === undefined) throw new ControlError(409, `A workspace can have at most ${MAX_PHONES} phones. Remove one first.`, 'label');
      const phone: PhoneEntry = { id, label, state: 'active', addedAt: at };
      return { phones: [...phones, phone], result: phone, entry: { actor, event: 'phone.added', kind: 'connection', detail: `Phone ${id} added: ${label}` } };
    }, audit);
  }

  rename(id: number, rawLabel: unknown, actor: string, audit: Audit): Promise<PhoneEntry> {
    return this.#change(async (phones) => {
      const p = this.#find(phones, id);
      const label = this.#label(rawLabel, phones.filter((x) => x.id !== id));
      const next = { ...p, label };
      return { phones: phones.map((x) => (x.id === id ? next : x)), result: next, entry: { actor, event: 'phone.renamed', kind: 'connection', detail: `Phone ${id} renamed: ${label}` } };
    }, audit);
  }

  /**
   * Marks a phone unlinked (the caller has logged it out and cleared its session), audited with its label and, when
   * known, its number already masked. Already unlinked: nothing new.
   */
  unlink(id: number, actor: string, audit: Audit, maskedNumber?: string): Promise<PhoneEntry> {
    return this.#change(async (phones, at) => {
      const p = this.#find(phones, id);
      if (p.state === 'unlinked') return { phones, result: p };
      const next: PhoneEntry = { ...p, state: 'unlinked', unlinkedAt: at };
      const detail = `Phone ${id} unlinked: ${p.label}${maskedNumber ? ` (${maskedNumber})` : ''}`;
      return { phones: phones.map((x) => (x.id === id ? next : x)), result: next, entry: { actor, event: 'phone.unlinked', kind: 'connection', detail } };
    }, audit);
  }

  /** A link on this phone succeeded: it is active again. The link itself is audited by the link flow. */
  activate(id: number): Promise<PhoneEntry> {
    return this.#change(async (phones) => {
      const p = this.#find(phones, id);
      if (p.state === 'active') return { phones, result: p };
      const { unlinkedAt: _, ...rest } = p;
      const next: PhoneEntry = { ...rest, state: 'active' };
      return { phones: phones.map((x) => (x.id === id ? next : x)), result: next };
    }, async () => undefined);
  }

  /** Frees a phone's number. Never phone 1, and never while approved groups are on it (the owner moves them first). */
  remove(id: number, actor: string, audit: Audit): Promise<PhoneEntry> {
    return this.#change(async (phones) => {
      const p = this.#find(phones, id);
      if (id === 1) throw new ControlError(409, 'Phone 1 cannot be removed. Unlink it instead.');
      const groups = this.#d.groupsOn(p.id);
      if (groups > 0) throw new ControlError(409, `Phone ${id} still has ${groups} approved group${groups === 1 ? '' : 's'}. Move them to another phone first.`);
      return { phones: phones.filter((x) => x.id !== id), result: p, entry: { actor, event: 'phone.removed', kind: 'connection', detail: `Phone ${id} removed: ${p.label}` } };
    }, audit);
  }

  #find(phones: PhoneEntry[], id: number): PhoneEntry {
    const p = phones.find((x) => x.id === id);
    if (!p) throw new ControlError(404, 'There is no such phone.');
    return p;
  }

  #label(raw: unknown, others: PhoneEntry[]): string {
    const label = cleanLabel(raw);
    if (label === null) throw new ControlError(422, `A phone's name is one line of 1 to ${LABEL_MAX} characters.`, 'label');
    if (others.some((p) => p.label.toLowerCase() === label.toLowerCase())) throw new ControlError(422, 'Another phone already has that name.', 'label');
    return label;
  }

  /**
   * One change at a time: the list as it is now, the change, its kv write and its audit row in one transaction; memory
   * follows only once that commits. A change that makes no difference writes nothing.
   */
  #change(
    fn: (phones: PhoneEntry[], at: string) => Promise<{ phones: PhoneEntry[]; result: PhoneEntry; entry?: Parameters<Audit>[1] }>,
    audit: Audit,
  ): Promise<PhoneEntry> {
    const run = this.#saving.then(async () => {
      const at = this.#d.clock.now().toISOString();
      const { phones, result, entry } = await fn(this.list(), at);
      if (phones === undefined || (entry === undefined && JSON.stringify(phones) === JSON.stringify(this.#phones))) return { ...result };
      const next = [...phones].sort((a, b) => a.id - b.id);
      await this.#d.db.tx(async (q) => {
        await setKv(q, PHONES_KV_KEY, JSON.stringify({ phones: next }));
        if (entry) await audit(q, entry);
      });
      this.#phones = next;
      return { ...result };
    });
    this.#saving = run.catch(() => undefined);
    return run;
  }
}
