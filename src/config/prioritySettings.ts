import type { PriorityKeywords } from '../brain/priorityKeywords.ts';
import { ControlError, type Audit } from '../control/errors.ts';
import type { Db, Sql } from '../store/db.ts';
import { setKv } from '../store/kv.ts';
import { PRIORITIES, type Priority } from '../store/tasks.ts';
import type { Clock } from '../util/clock.ts';

// Priority and sentiment settings (29 Oct 2026), changed from the dashboard's Settings screen and kept in the settings
// table (migration v9) as JSON, like the briefing's. Keywords: four lists, one per priority level. Sentiment: one switch,
// off by default, because it adds a little to every AI read. A list or the switch never saved uses the default below.
// Keywords are the owner's own words, not chat text, but the audit line still names only counts.

export const PRIORITY_SETTING_KEYS = ['priorityKeywords', 'sentimentEnabled'] as const;
export type PrioritySettingKey = (typeof PRIORITY_SETTING_KEYS)[number];

/** At most this many keywords per level, each at most KEYWORD_MAX_CHARS characters (code points). */
export const KEYWORDS_PER_LEVEL = 30;
export const KEYWORD_MAX_CHARS = 40;

/**
 * The lists before the owner saves any. Kept short and with no word inside another level's phrase, since the most
 * urgent match wins: "jaldi" is left out because "koi jaldi nahi" would then be major.
 */
export const DEFAULT_KEYWORDS: PriorityKeywords = {
  critical: ['urgent', 'asap', 'emergency', 'immediately', 'site down', 'not working', 'turant', 'तुरंत'],
  major: ['important', 'zaroori', 'zaruri', 'जरूरी'],
  medium: [],
  low: ['no rush', 'whenever possible', 'koi hurry nahi'],
};

export interface PriorityConfig {
  keywords: PriorityKeywords;
  sentimentEnabled: boolean;
}

/** What the browser gets: the lists, the switch and where each comes from. */
export interface PrioritySettingsView extends PriorityConfig {
  source: Record<PrioritySettingKey, 'default' | 'dashboard'>;
  limits: { perLevel: number; maxChars: number };
}

const LEVEL_WORDS: Record<Priority, string> = { critical: 'Critical', major: 'Major', medium: 'Medium', low: 'Low' };
/** Control, format and private-use characters, and lone surrogates: never part of a keyword. */
const HIDDEN = /[\p{C}]/u;
const HAS_WORD = /[\p{L}\p{N}]/u;

/** One keyword as saved: NFC, trimmed, single spaces (empty when there was only space). */
const clean = (s: string): string => s.normalize('NFC').replace(/\s+/gu, ' ').trim();
/** Two keywords are the same when they match the same text: case and spacing aside. */
const sameKey = (s: string): string => s.toLocaleLowerCase('en');

/**
 * Checks four lists offered for saving and returns them cleaned (trimmed, single-spaced, without repeats in a list).
 * Throws ControlError 422 naming the level and the keyword's place in its list, never the keyword.
 */
export function checkKeywords(raw: unknown): PriorityKeywords {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ControlError(422, 'Send the keywords as four lists: critical, major, medium and low', 'priorityKeywords');
  const keys = Object.keys(raw);
  if (keys.length !== PRIORITIES.length || !PRIORITIES.every((l) => keys.includes(l))) {
    throw new ControlError(422, 'Send the keywords as four lists: critical, major, medium and low', 'priorityKeywords');
  }
  const out = {} as Record<Priority, string[]>;
  const levelOf = new Map<string, Priority>();
  for (const level of PRIORITIES) {
    const list = (raw as Record<string, unknown>)[level];
    if (!Array.isArray(list)) throw new ControlError(422, `${LEVEL_WORDS[level]} keywords must be a list`, level);
    // A bound on the work before cleaning; the real limit is checked on what is kept.
    if (list.length > KEYWORDS_PER_LEVEL * 4) throw new ControlError(422, `${LEVEL_WORDS[level]} can have at most ${KEYWORDS_PER_LEVEL} keywords`, level);
    const kept: string[] = [];
    const seen = new Set<string>();
    list.forEach((item, i) => {
      const where = `${LEVEL_WORDS[level]} keyword ${i + 1}`;
      if (typeof item !== 'string') throw new ControlError(422, `${where} must be text`, level);
      const k = clean(item);
      if (k === '') return; // an empty chip is dropped, not refused
      if (HIDDEN.test(k)) throw new ControlError(422, `${where} has a hidden or control character`, level);
      if (!HAS_WORD.test(k)) throw new ControlError(422, `${where} needs at least one letter or number`, level);
      if ([...k].length > KEYWORD_MAX_CHARS) throw new ControlError(422, `${where} is longer than ${KEYWORD_MAX_CHARS} characters`, level);
      const key = sameKey(k);
      if (seen.has(key)) return; // a repeat in the same list is dropped
      const other = levelOf.get(key);
      if (other) throw new ControlError(422, `${where} is already in ${LEVEL_WORDS[other]}: keep each keyword in one list`, level);
      seen.add(key);
      levelOf.set(key, level);
      kept.push(k);
    });
    if (kept.length > KEYWORDS_PER_LEVEL) throw new ControlError(422, `${LEVEL_WORDS[level]} can have at most ${KEYWORDS_PER_LEVEL} keywords`, level);
    out[level] = kept;
  }
  return out;
}

/** A stored value, checked again on every read: a damaged row falls back to the default. */
function storedKeywords(v: unknown): PriorityKeywords | undefined {
  try {
    return checkKeywords(v);
  } catch {
    return undefined;
  }
}

const counts = (k: PriorityKeywords): string => PRIORITIES.map((l) => `${LEVEL_WORDS[l]} ${k[l].length}`).join(', ');

const ROWS = `SELECT k, v FROM settings WHERE k IN (${PRIORITY_SETTING_KEYS.map(() => '?').join(', ')})`;
const PUT =
  'INSERT INTO settings (k, v, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at, updated_by = excluded.updated_by';

export class PrioritySettings {
  readonly #db: Db;
  readonly #clock: Clock;
  /** Its rows (k to v), kept in memory: only set() writes them, and it updates this after its commit. */
  readonly #rows = new Map<string, string>();
  /** Saves run one at a time, so each one compares against the value the one before it saved. */
  #saving: Promise<unknown> = Promise.resolve();

  /** Loads its rows synchronously (S1 only, on the raw connection); `PrioritySettings.open` is the async way. */
  constructor(o: { db: Db; clock: Clock }) {
    this.#db = o.db;
    this.#clock = o.clock;
    this.#fill(this.#db.raw.prepare(ROWS).all(...PRIORITY_SETTING_KEYS) as { k: string; v: string }[]);
  }

  static async open(o: { db: Db; clock: Clock }): Promise<PrioritySettings> {
    const store = new PrioritySettings(o);
    await store.load();
    return store;
  }

  /** Reads its rows again (only a test that writes them directly needs this). */
  async load(): Promise<void> {
    this.#fill(await this.#db.all<{ k: string; v: string }>(ROWS, [...PRIORITY_SETTING_KEYS]));
  }

  #fill(rows: { k: string; v: string }[]): void {
    this.#rows.clear();
    for (const r of rows) this.#rows.set(r.k, r.v);
  }

  #stored(key: PrioritySettingKey): unknown {
    const v = this.#rows.get(key);
    if (v === undefined) return undefined;
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return undefined;
    }
  }

  #read(): { config: PriorityConfig; source: PrioritySettingsView['source'] } {
    const keywords = storedKeywords(this.#stored('priorityKeywords'));
    const switched = this.#stored('sentimentEnabled');
    const sentiment = typeof switched === 'boolean' ? switched : undefined;
    return {
      config: { keywords: keywords ?? DEFAULT_KEYWORDS, sentimentEnabled: sentiment ?? false },
      source: { priorityKeywords: keywords ? 'dashboard' : 'default', sentimentEnabled: sentiment === undefined ? 'default' : 'dashboard' },
    };
  }

  /** What each AI read uses: from memory, which every save updates, so a change applies to the next batch. */
  get(): PriorityConfig {
    return this.#read().config;
  }

  view(): PrioritySettingsView {
    const { config, source } = this.#read();
    return { ...config, source, limits: { perLevel: KEYWORDS_PER_LEVEL, maxChars: KEYWORD_MAX_CHARS } };
  }

  /**
   * Checks and saves one value and audits it in the same transaction. A value already in force changes nothing.
   * Throws ControlError 422 for an unknown key or a bad value.
   */
  set(rawKey: string, raw: unknown, actor: string, audit: Audit): Promise<PrioritySettingsView> {
    const run = this.#saving.then(() => this.#set(rawKey, raw, actor, audit));
    this.#saving = run.catch(() => undefined);
    return run;
  }

  async #set(rawKey: string, raw: unknown, actor: string, audit: Audit): Promise<PrioritySettingsView> {
    if (!(PRIORITY_SETTING_KEYS as readonly string[]).includes(rawKey)) throw new ControlError(422, 'That setting cannot be changed here', 'key');
    const key = rawKey as PrioritySettingKey;
    let value: PriorityKeywords | boolean;
    let detail: string;
    if (key === 'sentimentEnabled') {
      if (typeof raw !== 'boolean') throw new ControlError(422, 'sentimentEnabled must be true or false', key);
      value = raw;
      detail = `Sentiment analysis switched ${raw ? 'on' : 'off'}`;
    } else {
      value = checkKeywords(raw);
      detail = `Priority keywords saved (${counts(value)})`;
    }
    const current = this.get();
    const same = key === 'sentimentEnabled' ? current.sentimentEnabled === value : JSON.stringify(current.keywords) === JSON.stringify(value);
    if (same && this.#read().source[key] === 'dashboard') return this.view();
    await this.#db.tx(async (q) => {
      await q.run(PUT, [key, JSON.stringify(value), this.#clock.now().toISOString(), actor]);
      await audit(q, { actor, event: `settings.${key}`, kind: 'config', detail }); // commits or rolls back with the row
      // The tracker's Sentiment column fills or empties with the switch: rebuild it at the next tick, as a task edit does.
      if (key === 'sentimentEnabled') await setKv(q, 'rebuild_requested', this.#clock.now().toISOString());
    });
    this.#rows.set(key, JSON.stringify(value)); // committed: memory follows
    return this.view();
  }
}

/**
 * Whether sentiment is switched on, for the screens and the tracker that only show it then. Read straight from the
 * settings table (not PrioritySettings' memory: the readers here have only the database). `db` may be a transaction
 * handle.
 */
export async function readSentimentEnabled(db: Sql): Promise<boolean> {
  const r = await db.get<{ v: string }>("SELECT v FROM settings WHERE k = 'sentimentEnabled'");
  return r?.v === 'true';
}
