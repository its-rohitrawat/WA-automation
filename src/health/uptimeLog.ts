import { tx, type Db } from '../store/db.ts';
import type { Clock } from '../util/clock.ts';
import { fromIstDate, istDate } from '../util/time.ts';

// The agent's own up/down history (D5 Task 3, spec 4.8), for the vitals strip when UptimeRobot's read-only API is not
// set. One uptime_log row at every service start, one each time Health.isUp() changes, and a down row at a clean stop,
// so the time the service was stopped counts as down. After a crash the last state stands until the next start: the
// heartbeat monitor sees that gap, this log cannot. A down row keeps why, when the agent knows (migration v10): a fixed
// code from Health.downReason() or 'stopped', never free text; rows written before v10 have none, and a code this
// version does not know reads as none. An outage shows the reason of its first down row: a stop followed by a start
// that is down for another cause stays one outage, "The service was stopped" (the row of the later cause is kept).

const DAY_MS = 86_400_000;

/** Why the agent went down, as stored in uptime_log.reason. Checked here, not in the table: a new code needs no rebuild. */
export const DOWN_REASONS = {
  stopped: 'The service was stopped',
  whatsapp_logged_out: "WhatsApp was unlinked from the founder's phone",
  whatsapp_replaced: 'Another copy of the agent took over WhatsApp',
  whatsapp_forbidden: "WhatsApp refused the founder's number",
  whatsapp_disconnected: 'WhatsApp was disconnected',
  google_signin: 'The Google sign-in expired',
  tracker_failing: 'Tracker updates kept failing',
} as const;
export type DownReason = keyof typeof DOWN_REASONS;

const isReason = (v: unknown): v is DownReason => typeof v === 'string' && Object.hasOwn(DOWN_REASONS, v);

/** A down stretch, in epoch ms; end null while it is still going. reason: the first down row's, when it has one. */
export interface Interval {
  start: number;
  end: number | null;
  reason?: DownReason | null;
}

export interface DayDown {
  day: string;
  downMinutes: number;
  /** The longest single stretch down within the day. */
  longestMinutes: number;
}

export interface Outage {
  start: string;
  end: string | null;
  /** The whole outage, also the part before the window. */
  minutes: number;
  reason: string | null;
}

export interface UptimeRatios {
  d1: number | null;
  d7: number | null;
  d30: number | null;
}

/** Down stretches from up/down rows in time order: from a down row to the next up row; repeated rows merge. */
export function downIntervals(rows: readonly { at: number; up: boolean; reason?: DownReason | null }[]): Interval[] {
  const out: Interval[] = [];
  let down: { since: number; reason: DownReason | null } | null = null;
  for (const r of rows) {
    if (!r.up && down === null) down = { since: r.at, reason: r.reason ?? null };
    if (r.up && down !== null) {
      out.push({ start: down.since, end: r.at, reason: down.reason });
      down = null;
    }
  }
  if (down !== null) out.push({ start: down.since, end: null, reason: down.reason });
  return out;
}

const minutes = (ms: number) => Math.round(ms / 60_000);

/** "YYYY-MM-DD" minus n days (calendar dates, no time zone involved). */
function minusDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - n * DAY_MS).toISOString().slice(0, 10);
}

/** The last `days` IST days, oldest first, today last (up to now): minutes down and the longest stretch in each. */
export function dailyDown(intervals: readonly Interval[], now: number, days: number): DayDown[] {
  const today = istDate(new Date(now));
  return Array.from({ length: days }, (_, i) => {
    const day = minusDays(today, days - 1 - i);
    const from = fromIstDate(day).getTime();
    const to = Math.min(from + DAY_MS, now);
    let total = 0;
    let longest = 0;
    for (const iv of intervals) {
      const overlap = Math.min(iv.end ?? now, to) - Math.max(iv.start, from);
      if (overlap <= 0) continue;
      total += overlap;
      longest = Math.max(longest, overlap);
    }
    return { day, downMinutes: minutes(total), longestMinutes: minutes(longest) };
  });
}

/**
 * The percentage of the last `days` days spent up, counting only the time since the log began (knownSince); null when
 * nothing was ever recorded. Two decimals.
 */
export function uptimeRatio(intervals: readonly Interval[], knownSince: number | undefined, now: number, days: number): number | null {
  if (knownSince === undefined || knownSince >= now) return null;
  const from = Math.max(now - days * DAY_MS, knownSince);
  let down = 0;
  for (const iv of intervals) down += Math.max(0, Math.min(iv.end ?? now, now) - Math.max(iv.start, from));
  return Math.round(10_000 * (1 - down / (now - from))) / 100;
}

export class UptimeLog {
  readonly #db: Db;
  readonly #clock: Clock;
  #last: boolean | undefined;

  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
    const r = db.prepare('SELECT up FROM uptime_log ORDER BY at DESC, id DESC LIMIT 1').get() as { up: number } | undefined;
    this.#last = r === undefined ? undefined : r.up === 1;
  }

  /** An up row never keeps a reason; a down row keeps one only when it is a known code. */
  #write(up: boolean, reason: DownReason | null): void {
    const r = !up && isReason(reason) ? reason : null;
    this.#db.prepare('INSERT INTO uptime_log (at, up, reason) VALUES (?, ?, ?)').run(this.#clock.now().toISOString(), up ? 1 : 0, r);
    this.#last = up;
  }

  /** At service start: always one row, so the time since a stop row ends the outage it began. */
  start(up: boolean, reason: DownReason | null = null): void {
    this.#write(up, reason);
  }

  /** From the app tick: a row only when up changed. reason: Health.downReason(). */
  tick(up: boolean, reason: DownReason | null = null): void {
    if (up !== this.#last) this.#write(up, reason);
  }

  /** At a clean stop: the stopped time counts as down. */
  stop(): void {
    if (this.#last !== false) this.#write(false, 'stopped');
  }

  /**
   * The daily retention: removes rows older than `days` days, keeping the newest one before the cutoff (and, when that
   * one is down, the row where its outage began), so the state at the window's start and an outage's start stay known.
   * Returns how many went.
   */
  purgeOlderThan(days: number): number {
    if (!Number.isInteger(days) || days < 1) throw new Error('the uptime log keeps at least one day');
    const cutoff = new Date(this.#clock.now().getTime() - days * DAY_MS).toISOString();
    return tx(this.#db, () => {
      const last = this.#db.prepare('SELECT id, up FROM uptime_log WHERE at < ? ORDER BY at DESC, id DESC LIMIT 1').get(cutoff) as
        { id: number; up: number } | undefined;
      if (!last) return 0;
      const keep = [last.id];
      if (last.up === 0) {
        const began = this.#db
          .prepare(`SELECT id FROM uptime_log WHERE at < @cutoff AND up = 0
            AND at > COALESCE((SELECT MAX(at) FROM uptime_log WHERE at < @cutoff AND up = 1), '') ORDER BY at, id LIMIT 1`)
          .get({ cutoff }) as { id: number };
        keep.push(began.id);
      }
      return this.#db.prepare('DELETE FROM uptime_log WHERE at < ? AND id NOT IN (SELECT value FROM json_each(?))').run(cutoff, JSON.stringify(keep)).changes;
    });
  }

  /** The down stretches overlapping the last `days` days, and when the log began. */
  #intervals(days: number): { intervals: Interval[]; knownSince: number | undefined } {
    const now = this.#clock.now().getTime();
    const from = new Date(now - days * DAY_MS).toISOString();
    // The last row before the window says whether the window starts inside an outage. If it does, the outage began at the
    // first down row after the last up row (a down tick, then a stop row, then a start(false) row are one outage).
    type Row = { at: string; up: number; reason: string | null };
    const last = this.#db.prepare('SELECT at, up, reason FROM uptime_log WHERE at < ? ORDER BY at DESC, id DESC LIMIT 1').get(from) as Row | undefined;
    let before: Row[] = last ? [last] : [];
    if (last?.up === 0) {
      const began = this.#db
        .prepare(`SELECT at, up, reason FROM uptime_log WHERE at < @from AND up = 0
          AND at > COALESCE((SELECT MAX(at) FROM uptime_log WHERE at < @from AND up = 1), '') ORDER BY at, id LIMIT 1`)
        .get({ from }) as Row;
      before = [began];
    }
    const inside = this.#db.prepare('SELECT at, up, reason FROM uptime_log WHERE at >= ? ORDER BY at, id').all(from) as Row[];
    const first = this.#db.prepare('SELECT MIN(at) AS at FROM uptime_log').get() as { at: string | null };
    const rows = [...before, ...inside].map((r) => ({ at: Date.parse(r.at), up: r.up === 1, reason: isReason(r.reason) ? r.reason : null }));
    return { intervals: downIntervals(rows), knownSince: first.at === null ? undefined : Date.parse(first.at) };
  }

  daily(days = 30): DayDown[] {
    return dailyDown(this.#intervals(days).intervals, this.#clock.now().getTime(), days);
  }

  /** Newest first. */
  outages(days = 30): Outage[] {
    const now = this.#clock.now().getTime();
    return this.#intervals(days).intervals.reverse().map((iv) => ({
      start: new Date(iv.start).toISOString(),
      end: iv.end === null ? null : new Date(iv.end).toISOString(),
      minutes: minutes((iv.end ?? now) - iv.start),
      reason: iv.reason ? DOWN_REASONS[iv.reason] : null,
    }));
  }

  ratios(): UptimeRatios {
    const now = this.#clock.now().getTime();
    const { intervals, knownSince } = this.#intervals(30);
    return { d1: uptimeRatio(intervals, knownSince, now, 1), d7: uptimeRatio(intervals, knownSince, now, 7), d30: uptimeRatio(intervals, knownSince, now, 30) };
  }
}
