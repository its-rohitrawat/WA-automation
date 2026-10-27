import { z } from 'zod';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { dailyDown, type DayDown, type Interval, type Outage, type UptimeLog, type UptimeRatios } from './uptimeLog.ts';

// UptimeRobot's read-only API, for the uptime history (D5 Task 3), used only when UPTIMEROBOT_READ_KEY is set. The call
// is made by the agent, never the browser. The key goes only in the POST body to api.uptimerobot.com: never in a URL, a
// header, a log line or an answer. Any failure gives null, and the screen falls back to the agent's own log.

const URL = 'https://api.uptimerobot.com/v2/getMonitors';
const CACHE_MS = 5 * 60_000;
/** After a failure, the next try waits this long, so a broken key or an outage is not asked about on every poll. */
const RETRY_MS = 60_000;
const TIMEOUT_MS = 10_000;
const REASON_MAX = 100;

/** The part of fetch this client uses, so tests can record the request. */
export type FetchLike = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface RobotReading {
  ratios: UptimeRatios;
  /** Newest first. */
  outages: Outage[];
}

const RATIO = /^\d{1,3}(?:\.\d+)?$/;
const AnswerSchema = z.looseObject({
  stat: z.literal('ok'),
  monitors: z
    .array(
      z.looseObject({
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
    )
    .min(1),
});

/** UptimeRobot log type 1: the monitor went down. */
const DOWN = 1;

function toReading(raw: unknown): RobotReading | null {
  const a = AnswerSchema.safeParse(raw);
  if (!a.success) return null;
  // The first monitor: the agent's heartbeat (HEARTBEAT_URL) is the account's monitor for it.
  const m = a.data.monitors[0]!;
  const parts = m.custom_uptime_ratio.split('-');
  if (parts.length !== 3 || !parts.every((p) => RATIO.test(p))) return null;
  const [d1, d7, d30] = parts.map((p) => Math.min(100, Number(p)));
  const outages = (m.logs ?? [])
    .filter((l) => l.type === DOWN && Number.isFinite(l.datetime) && Number.isFinite(l.duration) && l.duration >= 0)
    .sort((x, y) => y.datetime - x.datetime)
    .map((l) => {
      const start = l.datetime * 1000;
      const detail = l.reason?.detail?.trim();
      return {
        start: new Date(start).toISOString(),
        end: new Date(start + l.duration * 1000).toISOString(),
        minutes: Math.round(l.duration / 60),
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
    const reading = await this.#ask();
    this.#cached = { at: now, reading };
    return reading;
  }

  async #ask(): Promise<RobotReading | null> {
    const body = new URLSearchParams({ api_key: this.#key, format: 'json', custom_uptime_ratios: '1-7-30', logs: '1', logs_limit: '50' }).toString();
    try {
      const res = await this.#fetch(URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'cache-control': 'no-cache' },
        body,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!res.ok) {
        this.#log.warn({ reason: 'uptimerobot_unavailable', status: res.status }, 'UptimeRobot could not be read; using the agent log');
        return null;
      }
      const reading = toReading(await res.json());
      // The answer's own text (an error message can quote the request) is never logged.
      if (!reading) this.#log.warn({ reason: 'uptimerobot_unavailable', status: res.status }, 'UptimeRobot gave an answer it could not use; using the agent log');
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
  days: DayDown[];
  outages: Outage[];
}

/** The uptime screen: UptimeRobot when its key is set and it answers, else the agent's own log. */
export async function uptimeReport(o: { log: UptimeLog; robot?: UptimeRobotClient | undefined; now: Date; days?: number }): Promise<UptimeReport> {
  const days = o.days ?? 30;
  const reading = o.robot ? await o.robot.read() : null;
  if (reading) {
    const intervals: Interval[] = reading.outages.map((x) => ({ start: Date.parse(x.start), end: x.end === null ? null : Date.parse(x.end) }));
    return { source: 'uptimerobot', ratios: reading.ratios, days: dailyDown(intervals, o.now.getTime(), days), outages: reading.outages };
  }
  return { source: 'agent', ratios: o.log.ratios(), days: o.log.daily(days), outages: o.log.outages(days) };
}
