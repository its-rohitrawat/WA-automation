import { ControlError, type Audit } from '../control/errors.ts';
import { nextReport } from '../report/scheduler.ts';
import type { ReportDays, ReportSettings } from '../report/types.ts';
import type { Db } from '../store/db.ts';
import { reportFor } from '../store/reports.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { istDate, istTime } from '../util/time.ts';
import { HHMM, INDIAN_MOBILE, maskNumber, type Env } from './env.ts';

// Runtime settings (D5 Task 1, spec 4.7): the values the owner changes from the dashboard, kept in the settings table
// (migration v9) as JSON. .env gives the defaults; a dashboard value wins. Only these five keys exist: the spend cap and
// the catch-up deadline stay .env-only, so raising a limit stays a deliberate step on the Mac. The send time joined them
// on the owner's request (29 Oct 2026): any time of day (its deadline follows it, see deadlineFor), and a time set after it has passed today starts
// tomorrow, as today keeps the time it had (TODAY_KEY), so a change never sends a day twice nor drops one.
// dashboardSend (Open chat) has no .env value: it is off until the owner switches it on in Settings.
// The founder's number is never put in an error or an audit line in full: maskNumber shows its last 4 digits.

export const SETTING_KEYS = ['reportEnabled', 'reportDays', 'reportRecipient', 'reportTime', 'dashboardSend'] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];
export type SettingSource = 'env' | 'dashboard';

const REPORT_DAYS: readonly ReportDays[] = ['weekdays', 'mon-sat', 'daily'];
const DAYS_WORDS: Record<ReportDays, string> = { weekdays: 'Monday to Friday', 'mon-sat': 'Monday to Saturday', daily: 'every day' };
/** Not a setting (set() refuses it): today's send time, kept when the time was changed after today's had passed. */
const TODAY_KEY = 'reportTimeToday';

/** How long after a send time at or after REPORT_DEADLINE a day not yet sent is still tried. */
const LATE_CATCH_UP_MINUTES = 180;

/**
 * The deadline for a send time: REPORT_DEADLINE while the time is before it (the morning rule, unchanged), else the
 * time plus LATE_CATCH_UP_MINUTES, never past 23:59 IST, so any time of day can be picked and a day still ends.
 */
export function deadlineFor(time: string, envDeadline: string): string {
  if (time < envDeadline) return envDeadline;
  const [h, m] = time.split(':').map(Number) as [number, number];
  const total = Math.min(h * 60 + m + LATE_CATCH_UP_MINUTES, 23 * 60 + 59);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export interface RuntimeSettings {
  reportEnabled: boolean;
  reportDays: ReportDays;
  /** The founder's number, digits only. Server-side only: the browser gets view() instead. */
  reportRecipient: string | undefined;
  /** The send time, IST "HH:MM". */
  reportTime: string;
  /** Open chat may send from the founder's WhatsApp. Off by default. */
  dashboardSend: boolean;
  source: Record<SettingKey, SettingSource>;
}

/** What the browser may see: the number masked to its last 4 digits. */
export interface SettingsView {
  reportEnabled: boolean;
  reportDays: ReportDays;
  recipientMasked: string | null;
  /** The send time (from the dashboard or .env) and the catch-up deadline (.env only), IST "HH:MM". */
  sendAt: string;
  deadline: string;
  /** When the next report goes out ("tomorrow 07:30", see nextReport), or null while the briefing is off. */
  nextReport: string | null;
  dashboardSend: boolean;
  source: Record<SettingKey, SettingSource>;
}

type Listener = (settings: RuntimeSettings, key: SettingKey) => void;

/** A stored or offered value for a key, checked; undefined when it is not valid. */
function check(key: SettingKey, v: unknown): boolean | ReportDays | string | undefined {
  if (key === 'reportTime') return typeof v === 'string' && HHMM.test(v) ? v : undefined;
  switch (key) {
    case 'reportEnabled':
    case 'dashboardSend':
      return typeof v === 'boolean' ? v : undefined;
    case 'reportDays':
      return typeof v === 'string' && (REPORT_DAYS as readonly string[]).includes(v) ? (v as ReportDays) : undefined;
    case 'reportRecipient':
      return typeof v === 'string' && INDIAN_MOBILE.test(v) ? v : undefined;
  }
}

/** A typed number: digits, with spaces, + and - allowed between them. */
function typedNumber(v: unknown): string | undefined {
  if (typeof v !== 'string' || !/^[\d\s+-]{1,30}$/.test(v)) return undefined;
  const digits = v.replace(/\D/g, '');
  return INDIAN_MOBILE.test(digits) ? digits : undefined;
}

const ROWS = 'SELECT k, v FROM settings';
const PUT =
  'INSERT INTO settings (k, v, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at, updated_by = excluded.updated_by';

export interface SettingsStoreOptions {
  db: Db;
  env: Pick<Env, 'REPORT_ENABLED' | 'REPORT_DAYS' | 'REPORT_RECIPIENT' | 'REPORT_TIME' | 'REPORT_DEADLINE'>;
  clock: Clock;
  spareLinked?: () => boolean;
  log?: Logger;
}

export class SettingsStore {
  readonly #db: Db;
  readonly #env: Pick<Env, 'REPORT_ENABLED' | 'REPORT_DAYS' | 'REPORT_RECIPIENT' | 'REPORT_TIME' | 'REPORT_DEADLINE'>;
  readonly #clock: Clock;
  readonly #spareLinked: () => boolean;
  readonly #log: Logger | undefined;
  readonly #listeners = new Set<Listener>();
  /** The settings rows (k to v), kept in memory: only set() writes them, and it updates this after its commit. */
  readonly #rows = new Map<string, string>();
  /** Saves run one at a time, so each one checks against the value the one before it saved. */
  #saving: Promise<unknown> = Promise.resolve();

  /**
   * spareLinked: whether the spare phone is linked (the briefing's sender has a session). Not given: never, so the
   * briefing cannot be switched on. Loads the rows synchronously (S1 only, on the raw connection); `SettingsStore.open`
   * is the async way.
   */
  constructor(o: SettingsStoreOptions) {
    this.#db = o.db;
    this.#env = o.env;
    this.#clock = o.clock;
    this.#spareLinked = o.spareLinked ?? (() => false);
    this.#log = o.log;
    this.#fill(this.#db.raw.prepare(ROWS).all() as { k: string; v: string }[]);
  }

  static async open(o: SettingsStoreOptions): Promise<SettingsStore> {
    const store = new SettingsStore(o);
    await store.load();
    return store;
  }

  /** Reads the rows again (only a test that writes them directly needs this). */
  async load(): Promise<void> {
    this.#fill(await this.#db.all<{ k: string; v: string }>(ROWS));
  }

  #fill(rows: { k: string; v: string }[]): void {
    this.#rows.clear();
    for (const r of rows) this.#rows.set(r.k, r.v);
  }

  /** The value stored from the dashboard, when there is a valid one. */
  #stored(key: SettingKey): { value: boolean | ReportDays | string } | undefined {
    const v = this.#rows.get(key);
    if (v === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(v);
    } catch {
      return undefined;
    }
    const value = check(key, parsed);
    return value === undefined ? undefined : { value };
  }

  get(): RuntimeSettings {
    const enabled = this.#stored('reportEnabled');
    const days = this.#stored('reportDays');
    const recipient = this.#stored('reportRecipient');
    // Any stored HH:MM is used: its deadline follows it (deadlineFor).
    const time = this.#stored('reportTime');
    const timeOk = time !== undefined;
    const send = this.#stored('dashboardSend');
    return {
      reportEnabled: enabled ? (enabled.value as boolean) : this.#env.REPORT_ENABLED,
      reportDays: days ? (days.value as ReportDays) : this.#env.REPORT_DAYS,
      reportRecipient: recipient ? (recipient.value as string) : this.#env.REPORT_RECIPIENT,
      reportTime: timeOk ? (time.value as string) : this.#env.REPORT_TIME,
      dashboardSend: send ? (send.value as boolean) : false,
      source: {
        reportEnabled: enabled ? 'dashboard' : 'env', reportDays: days ? 'dashboard' : 'env', reportRecipient: recipient ? 'dashboard' : 'env',
        reportTime: timeOk ? 'dashboard' : 'env', dashboardSend: send ? 'dashboard' : 'env',
      },
    };
  }

  /** Today's send time when the time was changed after today's had passed (the old one, kept for today), else undefined. */
  #todayTime(date: string): string | undefined {
    const stored = this.#rows.get(TODAY_KEY);
    if (stored === undefined) return undefined;
    try {
      const v = JSON.parse(stored) as unknown;
      if (typeof v !== 'object' || v === null) return undefined;
      const { date: d, time } = v as Record<string, unknown>;
      return d === date && typeof time === 'string' && HHMM.test(time) ? time : undefined;
    } catch {
      return undefined;
    }
  }

  /** The settings as the browser may see them. */
  async view(): Promise<SettingsView> {
    const s = this.get();
    const now = this.#clock.now();
    return {
      reportEnabled: s.reportEnabled, reportDays: s.reportDays, recipientMasked: s.reportRecipient ? maskNumber(s.reportRecipient) : null,
      sendAt: s.reportTime, deadline: deadlineFor(s.reportTime, this.#env.REPORT_DEADLINE),
      nextReport: nextReport(await reportFor(this.#db, istDate(now)), now, this.reportSettings(), s.reportTime), dashboardSend: s.dashboardSend,
      source: s.source,
    };
  }

  /** What the report scheduler reads on every tick: today's send time (see TODAY_KEY), so a change applies without a restart. */
  reportSettings(): ReportSettings {
    const s = this.get();
    const time = this.#todayTime(istDate(this.#clock.now())) ?? s.reportTime;
    return { enabled: s.reportEnabled, time, deadline: deadlineFor(time, this.#env.REPORT_DEADLINE), days: s.reportDays };
  }

  /** Called after each saved change. Returns the function that removes the listener. */
  onChange(fn: Listener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /**
   * Checks and saves one value, audits it (the number masked) in the same transaction, then tells the listeners. A value
   * already in force changes nothing. Throws ControlError: 422 an unknown key or a bad value, 409 switching on without a
   * number or before the spare phone is linked.
   */
  set(rawKey: string, raw: unknown, actor: string, audit: Audit): Promise<RuntimeSettings> {
    const run = this.#saving.then(() => this.#set(rawKey, raw, actor, audit));
    this.#saving = run.catch(() => undefined);
    return run;
  }

  async #set(rawKey: string, raw: unknown, actor: string, audit: Audit): Promise<RuntimeSettings> {
    if (!(SETTING_KEYS as readonly string[]).includes(rawKey)) throw new ControlError(422, 'That setting cannot be changed here', 'key');
    const key = rawKey as SettingKey;
    const value = key === 'reportRecipient' ? typedNumber(raw) : check(key, raw);
    if (value === undefined) {
      const message = {
        reportEnabled: 'reportEnabled must be true or false',
        dashboardSend: 'dashboardSend must be true or false',
        reportDays: `reportDays must be one of: ${REPORT_DAYS.join(', ')}`,
        reportRecipient: 'The number must be an Indian mobile number with 91 in front, for example 91 98765 43210',
        reportTime: 'The time must be HH:MM, for example 07:30',
      }[key];
      throw new ControlError(422, message, key);
    }
    const current = this.get();
    if (key === 'reportEnabled' && value === true) {
      if (!current.reportRecipient) throw new ControlError(409, "Set the founder's number first", key);
      if (!this.#spareLinked()) throw new ControlError(409, 'Link the spare phone first', key);
    }
    if (current[key] === value) return current;
    const now = this.#clock.now();
    // A time that has already passed today starts tomorrow: today keeps the time it had, so today's report is neither
    // sent a second time (the claim forbids that anyway) nor dropped. A time still ahead applies today.
    const keepToday = key === 'reportTime' && (value as string) <= istTime(now) ? { date: istDate(now), time: this.reportSettings().time } : null;
    const detail =
      key === 'reportEnabled' ? `Morning briefing switched ${value ? 'on' : 'off'}`
      : key === 'dashboardSend' ? `Sending from the dashboard switched ${value ? 'on' : 'off'}`
      : key === 'reportDays' ? `Morning briefing days set to ${DAYS_WORDS[value as ReportDays]}`
      : key === 'reportTime' ? `Morning briefing time set to ${value as string} IST${keepToday ? ', from tomorrow' : ''}`
      : `Morning briefing number changed to ${maskNumber(value as string)}`;
    const at = now.toISOString();
    await this.#db.tx(async (q) => {
      await q.run(PUT, [key, JSON.stringify(value), at, actor]);
      if (keepToday) await q.run(PUT, [TODAY_KEY, JSON.stringify(keepToday), at, actor]);
      else if (key === 'reportTime') await q.run('DELETE FROM settings WHERE k = ?', [TODAY_KEY]);
      // Synchronous (src/control/errors.ts): it writes on the same connection, inside this transaction.
      audit({ actor, event: `settings.${key}`, kind: 'config', detail });
    });
    // Committed: memory follows.
    this.#rows.set(key, JSON.stringify(value));
    if (keepToday) this.#rows.set(TODAY_KEY, JSON.stringify(keepToday));
    else if (key === 'reportTime') this.#rows.delete(TODAY_KEY);
    const next = this.get();
    for (const fn of this.#listeners) {
      try {
        fn(next, key);
      } catch (err) {
        this.#log?.error({ err, key }, 'a settings listener failed');
      }
    }
    return next;
  }
}
