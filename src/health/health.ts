import { statfsSync } from 'node:fs';
import type { ReconcileOutcome } from '../brain/reconciler.ts';
import type { HealthLine } from '../output/view.ts';
import type { SpendGuard } from '../spend/spendGuard.ts';
import type { Db } from '../store/db.ts';
import { getKv, setKv } from '../store/kv.ts';
import type { Clock } from '../util/clock.ts';
import { istDate, istShortDate, istTime } from '../util/time.ts';
import type { GatewayStatus } from '../wa/gateway.ts';

const LOW_DISK_GB = 10;
const DISCONNECT_GRACE_MS = 30 * 60_000;
const PUBLISH_FAIL_MS = 60 * 60_000;

export interface HealthSnapshot {
  at: string;
  line: HealthLine;
  whatsapp: GatewayStatus;
  downSince: string | null;
  failed: { clientId: number; errorCode: string }[];
  lastSuccessAt: string | null;
  lastPublishedAt: string | null;
  spentToday: number;
  capUsd: number;
  freeGb: number | null;
  publishFailingSince: string | null;
}

function defaultFreeBytes(dir: string): number | null {
  try {
    const s = statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

const stamp = (d: Date) => `${istShortDate(d)} ${istTime(d)}`;

export class Health {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #spend: SpendGuard;
  readonly #dataDir: string;
  readonly #freeBytes: (dir: string) => number | null;
  #wa: GatewayStatus;
  #downSince: Date | null;
  #failed = new Map<number, string>();
  #paused = new Map<number, string>(); // clientId -> IST day
  #publishFailedSince: Date | null = null;
  #publishAuthFailed = false;
  #lastSuccess: Date | null = null;
  #lastPublished: Date | null = null;

  constructor(o: { db: Db; clock: Clock; spend: SpendGuard; dataDir?: string; freeBytes?: (dir: string) => number | null }) {
    this.#db = o.db;
    this.#clock = o.clock;
    this.#spend = o.spend;
    this.#dataDir = o.dataDir ?? '.';
    this.#freeBytes = o.freeBytes ?? defaultFreeBytes;
    const now = this.#clock.now();
    this.#wa = { state: 'stopped', since: now.toISOString(), lastErrorCode: null, credsSaveFailures: 0 };
    this.#downSince = now; // not connected yet
  }

  setWhatsApp(s: GatewayStatus): void {
    this.#wa = s;
    if (s.state === 'open') this.#downSince = null;
    else this.#downSince ??= new Date(s.since);
    this.persist();
  }

  recordOutcome(clientId: number, o: ReconcileOutcome): void {
    if (o.status === 'paused') this.#paused.set(clientId, istDate(this.#clock.now()));
    else {
      this.#paused.delete(clientId);
      if (o.status === 'failed') this.#failed.set(clientId, o.errorCode);
      else this.#failed.delete(clientId);
    }
    if (o.status === 'ok') this.#lastSuccess = this.#clock.now();
    this.persist();
  }

  forget(clientId: number): void {
    this.#failed.delete(clientId);
    this.#paused.delete(clientId);
  }

  markPublishFailed(f: { step: 'build' | 'drive'; auth: boolean }): void {
    this.#publishFailedSince ??= this.#clock.now();
    this.#publishAuthFailed = f.auth;
    this.persist();
  }

  markPublished(): void {
    this.#lastPublished = this.#clock.now();
    this.#publishFailedSince = null;
    this.#publishAuthFailed = false;
    this.persist();
  }

  #hasPaused(now: Date): boolean {
    const today = istDate(now);
    for (const day of this.#paused.values()) if (day === today) return true;
    return false;
  }

  #freeGb(): number | null {
    const bytes = this.#freeBytes(this.#dataDir);
    return bytes === null ? null : bytes / 1e9;
  }

  line(): HealthLine {
    return this.#compute(true);
  }

  /** Same as line() but without publish failures: used inside the uploaded workbook. */
  workbookLine(): HealthLine {
    return this.#compute(false);
  }

  #compute(withPublish: boolean): HealthLine {
    const now = this.#clock.now();
    const since = stamp(new Date(this.#wa.since));
    if (this.#wa.state === 'logged_out') return { ok: false, text: `❌ WhatsApp unlinked since ${since}. Run: npm run cli -- link --reset` };
    if (this.#wa.state === 'replaced') return { ok: false, text: `❌ Another copy of WA Agent took over the WhatsApp session at ${since}. Stop the other copy, then restart the service.` };
    if (this.#wa.state === 'forbidden') return { ok: false, text: `❌ WhatsApp refused this number (403) since ${since}. Check the founder's phone.` };
    if (this.#downSince && now.getTime() - this.#downSince.getTime() > DISCONNECT_GRACE_MS) {
      return { ok: false, text: `❌ Disconnected since ${stamp(this.#downSince)}` };
    }
    const pubFail = withPublish ? this.#publishFailedSince : null;
    if (pubFail && this.#publishAuthFailed) return { ok: false, text: '❌ Google sign-in expired. Run: npm run cli -- google-auth' };
    if (this.#wa.credsSaveFailures > 0) return { ok: false, text: '⚠️ The WhatsApp session could not be saved. Check disk space and the data folder permissions.' };
    if (pubFail && now.getTime() - pubFail.getTime() > PUBLISH_FAIL_MS) {
      return { ok: false, text: `⚠️ Tracker update failing since ${stamp(pubFail)}` };
    }
    if (this.#spend.isPaused() || this.#hasPaused(now)) return { ok: false, text: '⚠️ Daily spend cap reached. Paused until midnight IST' };
    if (this.#failed.size > 0) {
      const n = this.#failed.size;
      return { ok: false, text: `⚠️ ${n} group${n === 1 ? '' : 's'} waiting (AI error)` };
    }
    const free = this.#freeGb();
    if (free !== null && free < LOW_DISK_GB) return { ok: false, text: `⚠️ Low disk: ${free.toFixed(1)} GB free` };
    return { ok: true, text: this.#lastSuccess ? `✅ Connected · last update ${stamp(this.#lastSuccess)}` : '✅ Connected · waiting for new messages' };
  }

  snapshot(): HealthSnapshot {
    return {
      at: this.#clock.now().toISOString(),
      line: this.line(),
      whatsapp: this.#wa,
      downSince: this.#downSince?.toISOString() ?? null,
      failed: [...this.#failed].map(([clientId, errorCode]) => ({ clientId, errorCode })),
      lastSuccessAt: this.#lastSuccess?.toISOString() ?? null,
      lastPublishedAt: this.#lastPublished?.toISOString() ?? null,
      spentToday: this.#spend.spentToday(),
      capUsd: this.#spend.capUsd,
      freeGb: this.#freeGb(),
      publishFailingSince: this.#publishFailedSince?.toISOString() ?? null,
    };
  }

  persist(): void {
    setKv(this.#db, 'health', JSON.stringify(this.snapshot()));
  }
}

export function readHealthSnapshot(db: Db): HealthSnapshot | undefined {
  const v = getKv(db, 'health');
  if (!v) return undefined;
  try {
    const o = JSON.parse(v) as Partial<HealthSnapshot> | null;
    if (!o || typeof o !== 'object' || typeof o.at !== 'string') return undefined;
    if (!o.line || typeof o.line.text !== 'string' || typeof o.line.ok !== 'boolean') return undefined;
    return o as HealthSnapshot;
  } catch {
    return undefined;
  }
}
