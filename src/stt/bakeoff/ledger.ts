import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function readJson(path: string): unknown {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : null;
}

/**
 * The bake-off's state on disk, all inside the private output folder:
 * - results/<sample>/<provider>.attempt.json: written before sending;
 * - results/<sample>/<provider>.part-<n>.json: each part's answer, reused by a retry;
 * - results/<sample>/<provider>.json: the outcome.
 */
export class Ledger {
  readonly #dir: string;

  constructor(outDir: string) {
    this.#dir = join(outDir, 'results');
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
    writeJson(this.#file(attempt.sampleId, attempt.provider, '.attempt'), attempt);
  }

  saveJobId(sampleId: string, provider: ProviderId, part: number, jobId: string): void {
    const attempt = this.attempt(sampleId, provider);
    if (!attempt) throw new Error('saveJobId called before begin');
    attempt.jobIds[String(part)] = jobId;
    this.begin(attempt);
  }

  part(sampleId: string, provider: ProviderId, n: number): ProviderResult | null {
    return readJson(this.#file(sampleId, provider, `.part-${n}`)) as ProviderResult | null;
  }

  savePart(sampleId: string, provider: ProviderId, n: number, result: ProviderResult): void {
    writeJson(this.#file(sampleId, provider, `.part-${n}`), result);
  }

  finish(outcome: Outcome): void {
    writeJson(this.#file(outcome.sampleId, outcome.provider, ''), outcome);
  }

  /** Moves a failed outcome aside, kept on disk as a record, so the slot can be sent again. */
  reopen(sampleId: string, provider: ProviderId): void {
    const path = this.#file(sampleId, provider, '');
    if (existsSync(path)) renameSync(path, this.#file(sampleId, provider, `.failed-${Date.now()}`));
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
}
