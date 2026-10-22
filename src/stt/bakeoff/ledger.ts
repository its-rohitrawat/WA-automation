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
 * - results/<sample>/<provider>.part-<n>.json: each part's answer, reused by a retry;
 * - results/<sample>/<provider>.json: the outcome.
 * Every failure to read or write it is a LedgerError.
 */
export class Ledger {
  readonly #dir: string;
  readonly #rename: (from: string, to: string) => void;
  readonly #pause: (ms: number) => void;

  constructor(outDir: string, opts: LedgerOptions = {}) {
    this.#dir = join(outDir, 'results');
    this.#rename = opts.rename ?? renameSync;
    this.#pause = opts.pause ?? pauseSync;
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

  part(sampleId: string, provider: ProviderId, n: number): ProviderResult | null {
    return readJson(this.#file(sampleId, provider, `.part-${n}`)) as ProviderResult | null;
  }

  savePart(sampleId: string, provider: ProviderId, n: number, result: ProviderResult): void {
    this.#write(this.#file(sampleId, provider, `.part-${n}`), result);
  }

  finish(outcome: Outcome): void {
    this.#write(this.#file(outcome.sampleId, outcome.provider, ''), outcome);
  }

  /** Moves a failed outcome aside, kept on disk as a record, so the slot can be sent again. */
  reopen(sampleId: string, provider: ProviderId): void {
    const path = this.#file(sampleId, provider, '');
    if (existsSync(path)) this.#move(path, this.#file(sampleId, provider, `.failed-${Date.now()}`));
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
