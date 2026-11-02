import { decrypt, encrypt } from '../crypto/envelope.ts';
import { deriveSubkey } from '../crypto/keyProvider.ts';
import type { Sql } from '../store/engine/types.ts';
import type { Clock } from '../util/clock.ts';
import { PlatformError } from './errors.ts';
import { platformAudit } from './store.ts';

// A customer's own Anthropic API key (design section 7; plan 2026-10-29-saas-s3-s6.md, task S4.2). Every Claude call of
// that customer uses only this key; the founder's .env key is never a fallback. The key is:
// - tested once before it is stored, with the free models list call (the same one the Settings check makes);
// - stored only encrypted, with a subkey of the customer's data key (S4.1) and the customer id as the AAD, in the
//   customer's own kv table;
// - never returned, logged or audited: callers see only 'configured' or 'missing', and errors never quote it;
// - tried at most AI_KEY_TRIES_PER_HOUR times an hour per customer.
// load() is for that customer's runtime only, never for a route.

const KV_KEY = 'secret.anthropic';
const KEY_INFO = 'anthropic-api-key v1';
const KEY_FORMAT = /^sk-ant-[A-Za-z0-9_-]{8,300}$/;
export const AI_KEY_TRIES_PER_HOUR = 5;
const TRIED = ['ai_key.set', 'ai_key.refused', 'ai_key.unreachable'] as const;

export type AiKeyState = 'configured' | 'missing';
export type KeyCheck = 'ok' | 'refused' | 'unreachable';
/** Asks Anthropic whether a key works. Injected, so tests never call out. */
export type KeyTester = (apiKey: string) => Promise<KeyCheck>;

/** What the tester needs of the Anthropic client (the SDK's models.list). */
export interface ModelsLister {
  models: { list(params: { limit: number }, options: { timeout: number; maxRetries: number }): PromiseLike<unknown> };
}

/**
 * The production tester: one models list call with the key, no retries, a 10 s limit. 401 and 403 mean the key is
 * refused; anything else (a 5xx, a timeout, no network) means Anthropic did not answer, and nothing is stored.
 * platformSupervisor.ts builds it on a client no founder environment setting reaches (src/brain/anthropicIsolated.ts).
 */
export function modelsListTester(make: (apiKey: string) => ModelsLister, timeoutMs = 10_000): KeyTester {
  return async (apiKey) => {
    try {
      await make(apiKey).models.list({ limit: 1 }, { timeout: timeoutMs, maxRetries: 0 });
      return 'ok';
    } catch (e) {
      const status = (e as { status?: unknown } | null)?.status;
      return status === 401 || status === 403 ? 'refused' : 'unreachable';
    }
  };
}

export interface AiKeysDeps {
  /** The customer's own tables (kv): their tenant-bound Db on Postgres. */
  db: Sql;
  /** The platform tables (the audit). */
  platform: Sql;
  tenantId: string;
  /** The customer's data key (TenantKeys.dataKey). */
  dataKey: () => Promise<Buffer>;
  tester: KeyTester;
  clock: Clock;
}

export class AiKeys {
  readonly #d: AiKeysDeps;

  constructor(d: AiKeysDeps) {
    this.#d = d;
  }

  async state(): Promise<AiKeyState> {
    return (await this.#stored()) === undefined ? 'missing' : 'configured';
  }

  /** Tests the key, then stores it encrypted (replacing any earlier one). */
  async set(input: string, actor: string, requestId?: string): Promise<AiKeyState> {
    const key = input.trim();
    if (!KEY_FORMAT.test(key)) throw new PlatformError(400, 'bad_key', 'That does not look like an Anthropic API key. It starts with sk-ant-.');
    const now = this.#d.clock.now();
    const since = new Date(now.getTime() - 3_600_000).toISOString();
    const marks = TRIED.map(() => '?').join(', ');
    const tries = (await this.#d.platform.get<{ n: number }>(`SELECT COUNT(*) AS n FROM platform_audit WHERE tenant_id = ? AND event IN (${marks}) AND at > ?`, [this.#d.tenantId, ...TRIED, since]))!.n;
    if (tries >= AI_KEY_TRIES_PER_HOUR) throw new PlatformError(429, 'too_many', 'Too many tries. Try again in an hour.');

    let check: KeyCheck;
    try {
      check = await this.#d.tester(key);
    } catch {
      check = 'unreachable'; // a tester that throws gave no answer; its error text is never kept (it could quote the key)
    }
    const at = this.#d.clock.now().toISOString();
    if (check !== 'ok') {
      await this.#audit(at, actor, check === 'refused' ? 'ai_key.refused' : 'ai_key.unreachable', requestId);
      if (check === 'refused') throw new PlatformError(400, 'key_refused', 'Anthropic did not accept this key. Check it and try again.');
      throw new PlatformError(503, 'anthropic_unreachable', 'Anthropic did not answer. Try again in a minute.');
    }
    const sealed = encrypt(await this.#key(), Buffer.from(key, 'utf8'), this.#aad()).toString('base64');
    await this.#d.db.run('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', [KV_KEY, sealed]);
    await this.#audit(at, actor, 'ai_key.set', requestId);
    return 'configured';
  }

  async remove(actor: string, requestId?: string): Promise<AiKeyState> {
    const r = await this.#d.db.run('DELETE FROM kv WHERE k = ?', [KV_KEY]);
    if (r.changes > 0) await this.#audit(this.#d.clock.now().toISOString(), actor, 'ai_key.removed', requestId);
    return 'missing';
  }

  /** The key itself, for this customer's runtime only (its Claude clients). Never for a route or a log. */
  async load(): Promise<string | null> {
    const sealed = await this.#stored();
    if (sealed === undefined) return null;
    try {
      return decrypt(await this.#key(), Buffer.from(sealed, 'base64'), this.#aad()).toString('utf8');
    } catch {
      throw new Error("This customer's Anthropic key cannot be opened with their data key.");
    }
  }

  async #stored(): Promise<string | undefined> {
    return (await this.#d.db.get<{ v: string }>('SELECT v FROM kv WHERE k = ?', [KV_KEY]))?.v;
  }

  async #key(): Promise<Buffer> {
    return deriveSubkey(await this.#d.dataKey(), KEY_INFO);
  }

  #aad(): Buffer {
    return Buffer.from(`anthropic-key:${this.#d.tenantId}`);
  }

  async #audit(at: string, actor: string, event: string, requestId?: string): Promise<void> {
    await platformAudit(this.#d.platform, { at, actor, event, tenantId: this.#d.tenantId, detail: '', requestId: requestId ?? null });
  }
}
