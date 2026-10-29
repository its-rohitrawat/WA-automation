import { ControlError, type Audit } from '../control/errors.ts';
import type { ReportDays, ReportSettings } from '../report/types.ts';
import { tx, type Db } from '../store/db.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { INDIAN_MOBILE, maskNumber, type Env } from './env.ts';

// Runtime settings (D5 Task 1, spec 4.7): the values the owner changes from the dashboard, kept in the settings table
// (migration v9) as JSON. .env gives the defaults; a dashboard value wins. Only these keys exist: the spend cap,
// the send time and the deadline stay .env-only, so raising a limit stays a deliberate step on the Mac.
// dashboardSend (Open chat) has no .env value: it is off until the owner switches it on in Settings.
// The founder's number is never put in an error or an audit line in full: maskNumber shows its last 4 digits.

export const SETTING_KEYS = ['reportEnabled', 'reportDays', 'reportRecipient', 'dashboardSend'] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];
export type SettingSource = 'env' | 'dashboard';

const REPORT_DAYS: readonly ReportDays[] = ['weekdays', 'mon-sat', 'daily'];
const DAYS_WORDS: Record<ReportDays, string> = { weekdays: 'Monday to Friday', 'mon-sat': 'Monday to Saturday', daily: 'every day' };

export interface RuntimeSettings {
  reportEnabled: boolean;
  reportDays: ReportDays;
  /** The founder's number, digits only. Server-side only: the browser gets view() instead. */
  reportRecipient: string | undefined;
  /** Open chat may send from the founder's WhatsApp. Off by default. */
  dashboardSend: boolean;
  source: Record<SettingKey, SettingSource>;
}

/** What the browser may see: the number masked to its last 4 digits. */
export interface SettingsView {
  reportEnabled: boolean;
  reportDays: ReportDays;
  recipientMasked: string | null;
  /** The earliest send time and the catch-up deadline, IST "HH:MM" (.env only). */
  sendAt: string;
  deadline: string;
  dashboardSend: boolean;
  source: Record<SettingKey, SettingSource>;
}

type Listener = (settings: RuntimeSettings, key: SettingKey) => void;

/** A stored or offered value for a key, checked; undefined when it is not valid. */
function check(key: SettingKey, v: unknown): boolean | ReportDays | string | undefined {
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

export class SettingsStore {
  readonly #db: Db;
  readonly #env: Pick<Env, 'REPORT_ENABLED' | 'REPORT_DAYS' | 'REPORT_RECIPIENT' | 'REPORT_TIME' | 'REPORT_DEADLINE'>;
  readonly #clock: Clock;
  readonly #spareLinked: () => boolean;
  readonly #log: Logger | undefined;
  readonly #listeners = new Set<Listener>();

  /**
   * spareLinked: whether the spare phone is linked (the briefing's sender has a session). Not given: never, so the
   * briefing cannot be switched on.
   */
  constructor(o: {
    db: Db;
    env: Pick<Env, 'REPORT_ENABLED' | 'REPORT_DAYS' | 'REPORT_RECIPIENT' | 'REPORT_TIME' | 'REPORT_DEADLINE'>;
    clock: Clock;
    spareLinked?: () => boolean;
    log?: Logger;
  }) {
    this.#db = o.db;
    this.#env = o.env;
    this.#clock = o.clock;
    this.#spareLinked = o.spareLinked ?? (() => false);
    this.#log = o.log;
  }

  /** The value stored from the dashboard, when there is a valid one. */
  #stored(key: SettingKey): { value: boolean | ReportDays | string } | undefined {
    const r = this.#db.prepare('SELECT v FROM settings WHERE k = ?').get(key) as { v: string } | undefined;
    if (!r) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.v);
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
    const send = this.#stored('dashboardSend');
    return {
      reportEnabled: enabled ? (enabled.value as boolean) : this.#env.REPORT_ENABLED,
      reportDays: days ? (days.value as ReportDays) : this.#env.REPORT_DAYS,
      reportRecipient: recipient ? (recipient.value as string) : this.#env.REPORT_RECIPIENT,
      dashboardSend: send ? (send.value as boolean) : false,
      source: {
        reportEnabled: enabled ? 'dashboard' : 'env', reportDays: days ? 'dashboard' : 'env', reportRecipient: recipient ? 'dashboard' : 'env',
        dashboardSend: send ? 'dashboard' : 'env',
      },
    };
  }

  /** The settings as the browser may see them. */
  view(): SettingsView {
    const s = this.get();
    return {
      reportEnabled: s.reportEnabled, reportDays: s.reportDays, recipientMasked: s.reportRecipient ? maskNumber(s.reportRecipient) : null,
      sendAt: this.#env.REPORT_TIME, deadline: this.#env.REPORT_DEADLINE, dashboardSend: s.dashboardSend, source: s.source,
    };
  }

  /** What the report scheduler reads on every tick. */
  reportSettings(): ReportSettings {
    const s = this.get();
    return { enabled: s.reportEnabled, time: this.#env.REPORT_TIME, deadline: this.#env.REPORT_DEADLINE, days: s.reportDays };
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
  set(rawKey: string, raw: unknown, actor: string, audit: Audit): RuntimeSettings {
    if (!(SETTING_KEYS as readonly string[]).includes(rawKey)) throw new ControlError(422, 'That setting cannot be changed here', 'key');
    const key = rawKey as SettingKey;
    const value = key === 'reportRecipient' ? typedNumber(raw) : check(key, raw);
    if (value === undefined) {
      const message = {
        reportEnabled: 'reportEnabled must be true or false',
        dashboardSend: 'dashboardSend must be true or false',
        reportDays: `reportDays must be one of: ${REPORT_DAYS.join(', ')}`,
        reportRecipient: 'The number must be an Indian mobile number with 91 in front, for example 91 98765 43210',
      }[key];
      throw new ControlError(422, message, key);
    }
    const current = this.get();
    if (key === 'reportEnabled' && value === true) {
      if (!current.reportRecipient) throw new ControlError(409, "Set the founder's number first", key);
      if (!this.#spareLinked()) throw new ControlError(409, 'Link the spare phone first', key);
    }
    if (current[key] === value) return current;
    const detail =
      key === 'reportEnabled' ? `Morning briefing switched ${value ? 'on' : 'off'}`
      : key === 'dashboardSend' ? `Sending from the dashboard switched ${value ? 'on' : 'off'}`
      : key === 'reportDays' ? `Morning briefing days set to ${DAYS_WORDS[value as ReportDays]}`
      : `Morning briefing number changed to ${maskNumber(value as string)}`;
    tx(this.#db, () => {
      this.#db
        .prepare('INSERT INTO settings (k, v, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at, updated_by = excluded.updated_by')
        .run(key, JSON.stringify(value), this.#clock.now().toISOString(), actor);
      audit({ actor, event: `settings.${key}`, kind: 'config', detail });
    });
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
