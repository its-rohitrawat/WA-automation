import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { UptimeLog } from '../../src/health/uptimeLog.ts';
import { uptimeReport, UptimeRobotClient, type FetchLike } from '../../src/health/uptimeRobot.ts';
import { openDb } from '../../src/store/db.ts';
import { manualClock } from '../../src/util/clock.ts';
import { createLogger } from '../../src/util/logger.ts';

// A made-up key: the tests check it never leaves except in the request body to UptimeRobot.
const KEY = 'ur-test-key-0000-do-not-use';
const NOW = '2026-10-20T06:30:00.000Z'; // 12:00 IST

function capture() {
  const lines: string[] = [];
  const sink = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
  return { log: createLogger('debug', sink), out: () => lines.join('') };
}

interface Call { url: string; method: string; headers: Record<string, string>; body: string }

function fakeFetch(respond: (call: Call) => Promise<{ status: number; json: unknown }> | { status: number; json: unknown }) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { url: String(url), method: init.method, headers: { ...init.headers }, body: String(init.body) };
    calls.push(call);
    const r = await respond(call);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json };
  };
  return { fetch, calls };
}

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const GOOD = {
  stat: 'ok',
  monitors: [{
    id: 1, custom_uptime_ratio: '100.000-99.500-98.250',
    logs: [
      { type: 2, datetime: at('2026-10-19T18:40:00.000Z'), duration: 0 },
      { type: 1, datetime: at('2026-10-19T18:20:00.000Z'), duration: 20 * 60, reason: { code: '0', detail: 'No heartbeat' } },
      { type: 98, datetime: at('2026-10-01T00:00:00.000Z'), duration: 0 },
    ],
  }],
};

function client(fetch: FetchLike, o: { clock?: ReturnType<typeof manualClock>; timeoutMs?: number } = {}) {
  const clock = o.clock ?? manualClock(NOW);
  const c = capture();
  return { robot: new UptimeRobotClient({ apiKey: KEY, fetch, clock, log: c.log, timeoutMs: o.timeoutMs }), clock, out: c.out };
}

describe('UptimeRobotClient', () => {
  it('asks getMonitors for 1, 7 and 30 day ratios, sending the key only in the body to UptimeRobot', async () => {
    const f = fakeFetch(() => ({ status: 200, json: GOOD }));
    const { robot, out } = client(f.fetch);
    const r = await robot.read();
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0]!;
    expect(call.url).toBe('https://api.uptimerobot.com/v2/getMonitors');
    expect(call.method).toBe('POST');
    expect(call.url).not.toContain(KEY);
    expect(JSON.stringify(call.headers)).not.toContain(KEY);
    const body = new URLSearchParams(call.body);
    expect(body.get('api_key')).toBe(KEY);
    expect(body.get('custom_uptime_ratios')).toBe('1-7-30');
    expect(r).toEqual({
      ratios: { d1: 100, d7: 99.5, d30: 98.25 },
      outages: [{ start: '2026-10-19T18:20:00.000Z', end: '2026-10-19T18:40:00.000Z', minutes: 20, reason: 'No heartbeat' }],
    });
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(out()).not.toContain(KEY);
  });

  it('keeps an answer for 5 minutes', async () => {
    const f = fakeFetch(() => ({ status: 200, json: GOOD }));
    const { robot, clock } = client(f.fetch);
    await robot.read();
    clock.advance(4 * 60_000);
    await robot.read();
    expect(f.calls).toHaveLength(1);
    clock.advance(61_000);
    await robot.read();
    expect(f.calls).toHaveLength(2);
  });

  it('gives null on a refusal, a bad answer, a network error or a timeout, and logs no key', async () => {
    const answers: (() => Promise<{ status: number; json: unknown }>)[] = [
      async () => ({ status: 401, json: { stat: 'fail' } }),
      async () => ({ status: 200, json: { stat: 'fail', error: { message: `api_key ${KEY} is wrong` } } }),
      async () => ({ status: 200, json: { stat: 'ok', monitors: [] } }),
      async () => ({ status: 200, json: { stat: 'ok', monitors: [{ custom_uptime_ratio: 'x-y-z' }] } }),
      async () => ({ status: 200, json: 'not an object' }),
      async () => {
        throw new Error(`connect failed api_key=${KEY}`);
      },
    ];
    for (const answer of answers) {
      const { robot, out } = client(fakeFetch(answer).fetch);
      expect(await robot.read()).toBeNull();
      expect(out()).not.toContain(KEY);
      expect(out()).toContain('uptimerobot_unavailable');
    }
  });

  it('gives up after its timeout', async () => {
    const f: FetchLike = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    const { robot } = client(f, { timeoutMs: 20 });
    expect(await robot.read()).toBeNull();
  });

  it('waits a minute after a failure before asking again', async () => {
    let fail = true;
    const f = fakeFetch(() => (fail ? { status: 500, json: {} } : { status: 200, json: GOOD }));
    const { robot, clock } = client(f.fetch);
    expect(await robot.read()).toBeNull();
    fail = false;
    expect(await robot.read()).toBeNull();
    expect(f.calls).toHaveLength(1);
    clock.advance(61_000);
    expect(await robot.read()).not.toBeNull();
  });

  it('keeps a reason short', async () => {
    const long = { ...GOOD, monitors: [{ ...GOOD.monitors[0]!, logs: [{ type: 1, datetime: at(NOW) - 60, duration: 60, reason: { code: '1', detail: 'x'.repeat(500) } }] }] };
    const { robot } = client(fakeFetch(() => ({ status: 200, json: long })).fetch);
    expect((await robot.read())!.outages[0]!.reason).toHaveLength(100);
  });
});

describe('uptimeReport', () => {
  function agentLog() {
    const db = openDb(':memory:');
    const clock = manualClock('2026-10-20T00:00:00.000+05:30');
    const log = new UptimeLog(db, clock);
    log.start(true);
    clock.set('2026-10-20T01:00:00.000+05:30');
    log.tick(false);
    clock.set('2026-10-20T01:30:00.000+05:30');
    log.tick(true);
    clock.set(NOW);
    return { log, clock };
  }

  it('uses UptimeRobot when it answers, with days built from its outages', async () => {
    const { log, clock } = agentLog();
    const { robot } = client(fakeFetch(() => ({ status: 200, json: GOOD })).fetch, { clock });
    const r = await uptimeReport({ log, robot, now: clock.now(), days: 2 });
    expect(r).toEqual({
      source: 'uptimerobot',
      ratios: { d1: 100, d7: 99.5, d30: 98.25 },
      days: [{ day: '2026-10-19', downMinutes: 10, longestMinutes: 10 }, { day: '2026-10-20', downMinutes: 10, longestMinutes: 10 }],
      outages: [{ start: '2026-10-19T18:20:00.000Z', end: '2026-10-19T18:40:00.000Z', minutes: 20, reason: 'No heartbeat' }],
    });
  });

  it("falls back to the agent's own log when UptimeRobot fails, or no key is set", async () => {
    const { log, clock } = agentLog();
    const { robot } = client(fakeFetch(() => ({ status: 500, json: {} })).fetch, { clock });
    for (const r of [await uptimeReport({ log, robot, now: clock.now(), days: 1 }), await uptimeReport({ log, now: clock.now(), days: 1 })]) {
      expect(r).toMatchObject({
        source: 'agent',
        days: [{ day: '2026-10-20', downMinutes: 30, longestMinutes: 30 }],
        outages: [{ minutes: 30, reason: null }],
      });
      expect(r.ratios.d1).toBeCloseTo(100 * (1 - 30 / 720), 2);
    }
  });
});

describe('UptimeRobotClient review fixes', () => {
  const answer = (monitor: Record<string, unknown>) => ({ status: 200, json: { stat: 'ok', monitors: [{ custom_uptime_ratio: '100-100-100', ...monitor }] } });

  it('asks for heartbeat monitors only, refuses redirects, and needs exactly one monitor', async () => {
    const f = fakeFetch(() => ({ status: 200, json: { stat: 'ok', monitors: [GOOD.monitors[0], GOOD.monitors[0]] } }));
    const { robot, out } = client(f.fetch);
    expect(await robot.read()).toBeNull();
    expect(new URLSearchParams(f.calls[0]!.body).get('types')).toBe('5');
    expect(out()).toContain('not_one_monitor');
    let redirect: string | undefined;
    const g: FetchLike = async (_url, init) => {
      redirect = init.redirect;
      return { ok: true, status: 200, json: async () => GOOD };
    };
    await client(g).robot.read();
    expect(redirect).toBe('error');
  });

  it('refuses a ratio over 100', async () => {
    const { robot } = client(fakeFetch(() => answer({ custom_uptime_ratio: '150-99-99' })).fetch);
    expect(await robot.read()).toBeNull();
  });

  it('drops logs with a negative or unbelievable duration, or a time in the future', async () => {
    const now = at(NOW);
    const { robot } = client(fakeFetch(() => answer({ logs: [
      { type: 1, datetime: now - 600, duration: -60 },
      { type: 1, datetime: now - 600, duration: 1e12 },
      { type: 1, datetime: now + 3600, duration: 60 },
      { type: 1, datetime: 1e15, duration: 60 },
      { type: 1, datetime: now - 600, duration: 120 },
    ] })).fetch);
    expect((await robot.read())!.outages).toEqual([{ start: new Date((now - 600) * 1000).toISOString(), end: new Date((now - 480) * 1000).toISOString(),
      minutes: 2, reason: null }]);
  });

  it('marks the newest outage as still going while the monitor is down, and cuts an end past now', async () => {
    const now = at(NOW);
    const down = client(fakeFetch(() => answer({ status: 9, logs: [{ type: 1, datetime: now - 1800, duration: 600 }] })).fetch);
    expect((await down.robot.read())!.outages[0]).toMatchObject({ end: null, minutes: 30 });
    const past = client(fakeFetch(() => answer({ status: 2, logs: [{ type: 1, datetime: now - 600, duration: 3600 }] })).fetch);
    expect((await past.robot.read())!.outages[0]).toMatchObject({ end: NOW, minutes: 10 });
  });

  it('keeps an answer for just under 5 minutes', async () => {
    const f = fakeFetch(() => ({ status: 200, json: GOOD }));
    const { robot, clock } = client(f.fetch);
    await robot.read();
    clock.advance(4 * 60_000 + 59_000);
    await robot.read();
    expect(f.calls).toHaveLength(1);
  });
});

describe('uptimeReport review fixes', () => {
  it('joins overlapping UptimeRobot outages and leaves out those before the window', async () => {
    const db = openDb(':memory:');
    const clock = manualClock(NOW);
    const log = new UptimeLog(db, clock);
    const hour = at('2026-10-20T03:00:00.000Z');
    const old = at('2026-09-01T00:00:00.000Z');
    const { robot } = client(fakeFetch(() => ({ status: 200, json: { stat: 'ok', monitors: [{ custom_uptime_ratio: '99-99-99', logs: [
      { type: 1, datetime: hour, duration: 3600 }, { type: 1, datetime: hour, duration: 3600 }, { type: 1, datetime: hour + 1800, duration: 3600 },
      { type: 1, datetime: old, duration: 60 },
    ] }] } })).fetch, { clock });
    const r = await uptimeReport({ log, robot, now: clock.now(), days: 1 });
    expect(r.days).toEqual([{ day: '2026-10-20', downMinutes: 90, longestMinutes: 90 }]);
    expect(r.outages).toHaveLength(3);
  });
});

describe('UptimeRobotClient shares a request in flight', () => {
  it('polls at the same moment make one call', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = fakeFetch(async () => {
      await gate;
      return { status: 200, json: GOOD };
    });
    const { robot } = client(f.fetch);
    const reads = [robot.read(), robot.read(), robot.read()];
    release();
    const results = await Promise.all(reads);
    expect(f.calls).toHaveLength(1);
    expect(results.every((r) => r !== null)).toBe(true);
  });
});
