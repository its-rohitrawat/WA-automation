import { z } from 'zod';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { dailyDown, dayOutages, outageText, type DayDown, type Interval, type Outage, type UptimeLog, type UptimeRatios } from './uptimeLog.ts';

// UptimeRobot's read-only API, for the uptime history (D5 Task 3), used only when UPTIMEROBOT_READ_KEY is set. The call
// is made by the agent, never the browser. The key goes only in the POST body to api.uptimerobot.com: never in a URL, a
// header, a log line or an answer. Any failure gives null, and the screen falls back to the agent's own log.

const URL = 'https://api.uptimerobot.com/v2/getMonitors';
const CACHE_MS = 5 * 60_000;
/** After a failure, the next try waits this long, so a broken key or an outage is not asked about on every poll. */
const RETRY_MS = 60_000;
const TIMEOUT_MS = 10_000;
const REASON_MAX = 100;
const DAY_MS = 86_400_000;
/** A down log longer than this is not believed (a bad value would break the dates). */
const MAX_DURATION_S = 400 * 86_400;

/** The part of fetch this client uses, so tests can record the request. */
export type FetchLike = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'error' },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface RobotReading {
  ratios: UptimeRatios;
  /** Newest first; end null while the monitor is still down. */
  outages: Outage[];
}

const RATIO = /^\d{1,3}(?:\.\d+)?$/;
const AnswerSchema = z.looseObject({
  stat: z.literal('ok'),
  monitors: z.array(
    z.looseObject({
      /** 9: down now. */
      status: z.number().optional(),
      custom_uptime_ratio: z.string(),
      logs: z
        .array(
          z.looseObject({
            type: z.number(),
            datetime: z.number(),
            duration: z.number(),
            reason: z.looseObject({ code: z.union([z.string(), z.number()]).optional(), detail: z.string().optional() }).optional(),
          }),
        )
        .optional(),
    }),
  ),
});

/** UptimeRobot log type 1: the monitor went down. Monitor status 9: down now. Monitor type 5: heartbeat. */
const DOWN = 1;
const DOWN_NOW = 9;
const HEARTBEAT = '5';

type Refusal = 'bad_answer' | 'not_one_monitor';

function toReading(raw: unknown, now: number): RobotReading | Refusal {
  const a = AnswerSchema.safeParse(raw);
  if (!a.success) return 'bad_answer';
  // Only heartbeat monitors are asked for, and the agent's (HEARTBEAT_URL) must be the only one: with several, which one
  // is the agent's cannot be told, so nothing is shown rather than another monitor's history.
  if (a.data.monitors.length !== 1) return 'not_one_monitor';
  const m = a.data.monitors[0]!;
  const parts = m.custom_uptime_ratio.split('-');
  if (parts.length !== 3 || !parts.every((p) => RATIO.test(p) && Number(p) <= 100)) return 'bad_answer';
  const [d1, d7, d30] = parts.map(Number);
  const logs = (m.logs ?? []).filter((l) => Number.isFinite(l.datetime) && l.datetime > 0 && l.datetime * 1000 <= now);
  const newest = logs.reduce<(typeof logs)[number] | undefined>((x, l) => (x === undefined || l.datetime > x.datetime ? l : x), undefined);
  const outages = logs
    .filter((l) => l.type === DOWN && Number.isFinite(l.duration) && l.duration >= 0 && l.duration <= MAX_DURATION_S)
    .sort((x, y) => y.datetime - x.datetime)
    .map((l) => {
      const start = l.datetime * 1000;
      const ongoing = l === newest && m.status === DOWN_NOW;
      const end = ongoing ? null : Math.min(start + l.duration * 1000, now);
      const detail = l.reason?.detail?.trim();
      return {
        start: new Date(start).toISOString(),
        end: end === null ? null : new Date(end).toISOString(),
        minutes: Math.round(((end ?? now) - start) / 60_000),
        reason: detail ? detail.slice(0, REASON_MAX) : null,
      };
    });
  return { ratios: { d1: d1!, d7: d7!, d30: d30! }, outages };
}

export class UptimeRobotClient {
  readonly #key: string;
  readonly #fetch: FetchLike;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #timeoutMs: number;
  #cached: { at: number; reading: RobotReading | null } | undefined;
  #inFlight: Promise<RobotReading | null> | undefined;

  constructor(o: { apiKey: string; fetch?: FetchLike; clock: Clock; log: Logger; timeoutMs?: number | undefined }) {
    this.#key = o.apiKey;
    this.#fetch = o.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.#clock = o.clock;
    this.#log = o.log;
    this.#timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
  }

  /** The ratios and outages, or null when UptimeRobot could not be read. Answers are kept 5 minutes, failures 1. */
  async read(): Promise<RobotReading | null> {
    const now = this.#clock.now().getTime();
    const c = this.#cached;
    if (c && now - c.at < (c.reading ? CACHE_MS : RETRY_MS)) return c.reading;
    // Polls that arrive while a request is out share it: one call to UptimeRobot, never one per poll.
    if (this.#inFlight) return this.#inFlight;
    const ask = this.#ask(now).then((reading) => {
      this.#cached = { at: now, reading };
      return reading;
    });
    this.#inFlight = ask;
    try {
      return await ask;
    } finally {
      this.#inFlight = undefined;
    }
  }

  async #ask(now: number): Promise<RobotReading | null> {
    const body = new URLSearchParams({
      api_key: this.#key, format: 'json', types: HEARTBEAT, custom_uptime_ratios: '1-7-30', logs: '1', logs_limit: '50',
    }).toString();
    try {
      // A redirect is refused: following it would send the body, and the key in it, somewhere else.
      const res = await this.#fetch(URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'cache-control': 'no-cache' },
        body,
        signal: AbortSignal.timeout(this.#timeoutMs),
        redirect: 'error',
      });
      if (!res.ok) {
        this.#log.warn({ reason: 'uptimerobot_unavailable', status: res.status }, 'UptimeRobot could not be read; using the agent log');
        return null;
      }
      const reading = toReading(await res.json(), now);
      // The answer's own text (an error message can quote the request) is never logged.
      if (typeof reading === 'string') {
        this.#log.warn({ reason: 'uptimerobot_unavailable', detail: reading }, 'UptimeRobot gave an answer it could not use; using the agent log');
        return null;
      }
      return reading;
    } catch (err) {
      // Only the error's name: its message could hold anything the request carried.
      this.#log.warn({ reason: 'uptimerobot_unavailable', error: err instanceof Error ? err.name : 'unknown' }, 'UptimeRobot could not be read; using the agent log');
      return null;
    }
  }
}

export interface UptimeReport {
  source: 'uptimerobot' | 'agent';
  ratios: UptimeRatios;
  /** outages: that day's outages in plain words with their exact times (outageText), oldest first. */
  days: (DayDown & { outages: string[] })[];
  /** text: the outage in plain words with its exact times, IST. */
  outages: (Outage & { text: string })[];
  /** The agent's log: the IST day it began (earlier days are unknown, not up). Null for UptimeRobot, or an empty log. */
  knownSinceDay: string | null;
}

/** Down stretches in time order with overlaps joined, so no minute is counted twice. */
function merged(intervals: Interval[], now: number): Interval[] {
  const out: Interval[] = [];
  for (const iv of [...intervals].sort((x, y) => x.start - y.start)) {
    const prev = out.at(-1);
    if (prev && iv.start <= (prev.end ?? now)) {
      prev.end = prev.end === null || iv.end === null ? null : Math.max(prev.end, iv.end);
    } else {
      out.push({ ...iv });
    }
  }
  return out;
}

/** The uptime screen: UptimeRobot when its key is set and it answers, else the agent's own log. */
export async function uptimeReport(o: { log: UptimeLog; robot?: UptimeRobotClient | undefined; now: Date; days?: number }): Promise<UptimeReport> {
  const days = o.days ?? 30;
  const now = o.now.getTime();
  const reading = o.robot ? await o.robot.read() : null;
  // Each outage and each day also in plain words with the exact times (owner request, 29 Oct 2026).
  const withTimes = (daily: DayDown[], outages: Outage[], intervals: Interval[]) => ({
    days: daily.map((d) => ({ ...d, outages: dayOutages(intervals, d.day, now) })),
    outages: outages.map((x) => ({ ...x, text: outageText(Date.parse(x.start), x.end === null ? null : Date.parse(x.end), now) })),
  });
  const toIntervals = (outages: Outage[]) => outages.map((x) => ({ start: Date.parse(x.start), end: x.end === null ? null : Date.parse(x.end) }));
  if (reading) {
    // As with the agent's own log: only outages that reach into the window.
    const outages = reading.outages.filter((x) => (x.end === null ? now : Date.parse(x.end)) > now - days * DAY_MS);
    const intervals = merged(toIntervals(outages), now);
    return { source: 'uptimerobot', ratios: reading.ratios, ...withTimes(dailyDown(intervals, now, days), outages, intervals), knownSinceDay: null };
  }
  const outages = await o.log.outages(days);
  return { source: 'agent', ratios: await o.log.ratios(), ...withTimes(await o.log.daily(days), outages, toIntervals(outages)), knownSinceDay: await o.log.knownSinceDay() };
}
