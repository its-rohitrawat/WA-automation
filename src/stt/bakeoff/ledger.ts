import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROVIDER_IDS, type ProviderId, type ProviderResult, type SampleKind, type Segment } from '../types.ts';

/** new: never sent. unknown: sent, and no outcome was recorded. done / failed: the outcome. */
export type SlotState = 'new' | 'done' | 'failed' | 'unknown';

/** Written before the first paid request of a slot, so a crash or a lost answer leaves evidence. */
export interface Attempt {
  sampleId: string;
  provider: ProviderId;
  model: string;
  startedAt: string;
  /** Provider job ids by part number, so a later run can wait on a job instead of paying twice. */
  jobIds: Record<string, string>;
  /**
   * Job ids the provider no longer has (see SttJobLostError), by part number: "1", or "1-2" for the second lost job of
   * part 1. They cannot be waited on, but the jobs may be billed, so they are kept as evidence for the dashboard check.
   */
  lostJobIds?: Record<string, string>;
  /** ISO time of each paid request, written just before it goes out: the record of what may be billed. */
  sends: string[];
}

export interface Outcome {
  sampleId: string;
  kind: SampleKind;
  provider: ProviderId;
  model: string;
  status: 'done' | 'failed';
  audioSeconds: number;
  billedSeconds: number | null;
  /** List-price cost; 0 for a failed slot (the provider's dashboard has the real figure). */
  costUsd: number;
  processingSeconds: number;
  parts: number;
  /** A short code such as "http_401 invalid_api_key"; never provider text. */
  error: string | null;
  segments: Segment[];
  finishedAt: string;
}

/** Where a part sits in the prepared audio. A saved answer is reused only for the same cut. */
export interface PartCut {
  offset: number;
  seconds: number;
}

interface SavedPart extends PartCut {
  result: ProviderResult;
}

/** A saved answer matches a cut when its offset and length agree within this many seconds. */
const CUT_TOLERANCE_S = 0.01;

/** The ledger could not be read or written. The run stops: sending on without a record could pay twice. */
export class LedgerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

export interface LedgerOptions {
  /** renameSync; replaced in tests to act out a file lock. */
  rename?: (from: string, to: string) => void;
  /** Blocks for ms. The ledger is synchronous, so a lock is waited out in place. */
  pause?: (ms: number) => void;
  /** Clock for the names of moved-aside files. */
  now?: () => number;
}

/** Antivirus scanners and the search indexer briefly lock a new file on Windows, which makes a rename fail. */
const LOCK_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRIES = 20;
const RENAME_PAUSE_MS = 100;

function errnoCode(e: unknown, fallback: string): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : fallback;
}

function pauseSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Errors name the file: the path is local and safe to show, the content is not. */
function readJson(path: string): unknown {
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new LedgerError(errnoCode(e, 'read_failed'), `Could not read the ledger file ${path}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LedgerError('damaged_file', `The ledger file ${path} is damaged (not valid JSON)`);
  }
}

/**
 * The bake-off's state on disk, all inside the private output folder:
 * - results/<sample>/<provider>.attempt.json: written before sending;
 * - results/<sample>/<provider>.part-<n>.json: each part's answer with its cut, reused by a retry;
 * - results/<sample>/<provider>.json: the outcome.
 * Every failure to read or write it is a LedgerError.
 */
export class Ledger {
  readonly #dir: string;
  readonly #rename: (from: string, to: string) => void;
  readonly #pause: (ms: number) => void;
  readonly #now: () => number;

  constructor(outDir: string, opts: LedgerOptions = {}) {
    this.#dir = join(outDir, 'results');
    this.#rename = opts.rename ?? renameSync;
    this.#pause = opts.pause ?? pauseSync;
    this.#now = opts.now ?? Date.now;
  }

  state(sampleId: string, provider: ProviderId): SlotState {
    const outcome = this.outcome(sampleId, provider);
    if (outcome) return outcome.status;
    return this.attempt(sampleId, provider) ? 'unknown' : 'new';
  }

  outcome(sampleId: string, provider: ProviderId): Outcome | null {
    return readJson(this.#file(sampleId, provider, '')) as Outcome | null;
  }

  attempt(sampleId: string, provider: ProviderId): Attempt | null {
    return readJson(this.#file(sampleId, provider, '.attempt')) as Attempt | null;
  }

  begin(attempt: Attempt): void {
    this.#write(this.#file(attempt.sampleId, attempt.provider, '.attempt'), attempt);
  }

  saveJobId(sampleId: string, provider: ProviderId, part: number, jobId: string): void {
    const attempt = this.attempt(sampleId, provider);
    if (!attempt) throw new LedgerError('no_attempt', 'saveJobId called before begin');
    attempt.jobIds[String(part)] = jobId;
    this.begin(attempt);
  }

  /**
   * Moves part n's job id to lostJobIds: the provider no longer has that job, so nothing is left to wait on and the next
   * plan shows a new, paid send. A part without a saved job id is left as it is.
   */
  dropJobId(sampleId: string, provider: ProviderId, part: number): void {
    const attempt = this.attempt(sampleId, provider);
    if (!attempt) throw new LedgerError('no_attempt', 'dropJobId called before begin');
    const key = String(part);
    const id = attempt.jobIds[key];
    if (id === undefined) return;
    const jobIds = { ...attempt.jobIds };
    delete jobIds[key];
    const lost = { ...(attempt.lostJobIds ?? {}) };
    // An earlier lost job of the same part keeps its entry; this one takes the next free name.
    let name = key;
    for (let k = 2; Object.hasOwn(lost, name); k++) name = `${key}-${k}`;
    lost[name] = id;
    this.begin({ ...attempt, jobIds, lostJobIds: lost });
  }

  /** Appends the time of a paid request to the attempt. Called before the request, so a lost answer still shows it. */
  noteSend(sampleId: string, provider: ProviderId, at: string): void {
    const attempt = this.attempt(sampleId, provider);
    if (!attempt) throw new LedgerError('no_attempt', 'noteSend called before begin');
    this.begin({ ...attempt, sends: [...(attempt.sends ?? []), at] });
  }

  /**
   * The saved answer for part n, or null when there is none. One saved for another cut (the audio was split differently
   * since) is a LedgerError part_cache_mismatch: reusing it would put words at the wrong times, or miss some.
   */
  part(sampleId: string, provider: ProviderId, n: number, expect: PartCut): ProviderResult | null {
    const path = this.#file(sampleId, provider, `.part-${n}`);
    const saved = readJson(path) as Partial<SavedPart> | null;
    if (saved === null) return null;
    const near = (a: unknown, b: number): boolean => typeof a === 'number' && Math.abs(a - b) <= CUT_TOLERANCE_S;
    if (!near(saved.offset, expect.offset) || !near(saved.seconds, expect.seconds) || !saved.result) {
      throw new LedgerError('part_cache_mismatch', `The saved answer ${path} was cut differently from the audio now being sent`);
    }
    return saved.result;
  }

  /**
   * True when every part n < parts has a saved job id to wait on or a saved answer, so going on costs nothing. Whether a
   * saved answer fits today's cut is only known once the audio is split; the runner checks that before sending.
   */
  canResume(sampleId: string, provider: ProviderId, parts: number): boolean {
    if (parts < 1) return false;
    const jobIds = this.attempt(sampleId, provider)?.jobIds ?? {};
    for (let n = 0; n < parts; n++) {
      if (!jobIds[String(n)] && !existsSync(this.#file(sampleId, provider, `.part-${n}`))) return false;
    }
    return true;
  }

  savePart(sampleId: string, provider: ProviderId, n: number, cut: PartCut, result: ProviderResult): void {
    const saved: SavedPart = { offset: cut.offset, seconds: cut.seconds, result };
    this.#write(this.#file(sampleId, provider, `.part-${n}`), saved);
  }

  finish(outcome: Outcome): void {
    this.#write(this.#file(outcome.sampleId, outcome.provider, ''), outcome);
  }

  /**
   * Starts sending a failed slot again (--retry-failed) with the fresh attempt. The old outcome and attempt are kept on
   * disk as <provider>.failed-<ms>-<n>.json and .attempt.json; the attempt goes too, since its job ids belong to the
   * failed jobs. Saved part answers stay: they were paid for and the retry reuses them.
   *
   * The order keeps the slot from ever reading "new", which a plain run would send unasked: the old attempt goes aside
   * and the fresh one is written while the failed outcome still makes the slot read failed; only then does the outcome
   * go aside, and the fresh attempt makes it read unknown. A crash or a LedgerError at any step leaves failed or unknown.
   */
  reopen(fresh: Attempt): void {
    const { sampleId, provider } = fresh;
    const aside = this.#asideFailure(sampleId, provider);
    this.begin(fresh);
    this.#move(this.#file(sampleId, provider, ''), this.#file(sampleId, provider, aside));
  }

  /**
   * Records a new failure over an old one, keeping the old outcome and attempt on disk as for reopen. The slot reads
   * failed at every step: the old outcome is copied aside and then replaced in one rename, never removed first.
   */
  replaceFailed(outcome: Outcome): void {
    if (outcome.status !== 'failed') throw new LedgerError('not_failed', 'replaceFailed called with an outcome that is not a failure');
    const { sampleId, provider } = outcome;
    const old = this.outcome(sampleId, provider);
    const aside = this.#asideFailure(sampleId, provider);
    this.#write(this.#file(sampleId, provider, aside), old);
    this.finish(outcome);
  }

  /**
   * For a failed slot: picks a free name <provider>.failed-<ms>-<n> and moves the attempt, if any, aside under it, so
   * the slot still reads failed. Returns the name's suffix for the outcome. Throws when the slot is not failed.
   */
  #asideFailure(sampleId: string, provider: ProviderId): string {
    const status = this.outcome(sampleId, provider)?.status;
    if (status !== 'failed') throw new LedgerError('not_failed', `A failed slot was expected, but this one is ${status ?? 'not finished'}`);
    const ms = this.#now();
    let n = 0;
    while (existsSync(this.#file(sampleId, provider, `.failed-${ms}-${n}`)) || existsSync(this.#file(sampleId, provider, `.failed-${ms}-${n}.attempt`))) n++;
    const attempt = this.#file(sampleId, provider, '.attempt');
    if (existsSync(attempt)) this.#move(attempt, this.#file(sampleId, provider, `.failed-${ms}-${n}.attempt`));
    return `.failed-${ms}-${n}`;
  }

  outcomes(): Outcome[] {
    if (!existsSync(this.#dir)) return [];
    return readdirSync(this.#dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => PROVIDER_IDS.map((p) => this.outcome(d.name, p)).filter((o): o is Outcome => o !== null));
  }

  #file(sampleId: string, provider: ProviderId, suffix: string): string {
    return join(this.#dir, sampleId, `${provider}${suffix}.json`);
  }

  /** Written in full and flushed to disk under a temporary name, then renamed: a crash leaves the old file or the new one. */
  #write(path: string, value: unknown): void {
    const tmp = `${path}.tmp`;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const data = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
      const fd = openSync(tmp, 'w');
      try {
        for (let at = 0; at < data.length; ) at += writeSync(fd, data, at);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (e) {
      throw new LedgerError(errnoCode(e, 'write_failed'), `Could not write the ledger file ${path}`);
    }
    this.#move(tmp, path);
  }

  /** A rename that waits out a brief lock (up to 2 s in all), then gives up with a LedgerError. */
  #move(from: string, to: string): void {
    for (let retries = 0; ; retries++) {
      try {
        this.#rename(from, to);
        return;
      } catch (e) {
        const code = errnoCode(e, 'rename_failed');
        if (retries >= RENAME_RETRIES || !LOCK_CODES.has(code)) throw new LedgerError(code, `Could not write the ledger file ${to}`);
        this.#pause(RENAME_PAUSE_MS);
      }
    }
  }
}
