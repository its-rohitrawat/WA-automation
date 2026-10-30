import { randomBytes } from 'node:crypto';
import { decrypt, encrypt } from '../crypto/envelope.ts';
import { deriveSubkey } from '../crypto/keyProvider.ts';
import type { Sql } from '../store/engine/types.ts';
import type { Clock } from '../util/clock.ts';
import { FOUNDER_TENANT_ID } from './store.ts';

// Each customer's data key (design section 7; plan 2026-10-29-saas-s3-s6.md, task S4.1): 32 random bytes, stored only
// wrapped (AES-256-GCM) by a key derived from the Mac's master key, with the customer id as the AAD, so a wrapped key
// copied onto another customer's row does not open. The founder's data key is the master key itself: everything the
// agent stored before the SaaS (WhatsApp auth, Google tokens, media references) was encrypted with it, so nothing has to
// be re-encrypted at the cutover. Keys are cached in memory and handed out as copies.

const WRAP_INFO = 'wa-agent tenant data keys v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UNREADABLE = "This customer's data key cannot be opened with this Mac's master key.";

export class TenantKeys {
  readonly #db: Sql;
  readonly #master: Buffer;
  readonly #wrap: Buffer;
  readonly #clock: Clock;
  readonly #cache = new Map<string, Buffer>();

  /** db: the platform tables (tenants, tenant_keys). */
  constructor(o: { db: Sql; master: Buffer; clock: Clock }) {
    if (o.master.length !== 32) throw new Error('The master key must be 32 bytes');
    this.#db = o.db;
    this.#master = Buffer.from(o.master);
    this.#wrap = deriveSubkey(o.master, WRAP_INFO);
    this.#clock = o.clock;
  }

  /** The customer's data key, made on first use. */
  async dataKey(tenantId: string): Promise<Buffer> {
    if (!UUID.test(tenantId)) throw new Error('dataKey needs a customer id');
    if (tenantId === FOUNDER_TENANT_ID) return Buffer.from(this.#master);
    const hit = this.#cache.get(tenantId);
    if (hit) return Buffer.from(hit);
    const aad = Buffer.from(`tenant:${tenantId}`);
    let row = await this.#wrapped(tenantId);
    if (!row) {
      if (!(await this.#db.get('SELECT 1 AS x FROM tenants WHERE id = ?', [tenantId]))) throw new Error('There is no such customer.');
      const fresh = randomBytes(32);
      await this.#db.run('INSERT INTO tenant_keys (tenant_id, wrapped, created_at) VALUES (?, ?, ?) ON CONFLICT (tenant_id) DO NOTHING', [
        tenantId, encrypt(this.#wrap, fresh, aad), this.#clock.now().toISOString(),
      ]);
      // Another start may have stored its key first: always use what is stored.
      row = await this.#wrapped(tenantId);
    }
    let key: Buffer;
    try {
      key = decrypt(this.#wrap, Buffer.from(row!), aad);
    } catch {
      throw new Error(UNREADABLE);
    }
    if (key.length !== 32) throw new Error(UNREADABLE);
    this.#cache.set(tenantId, key);
    return Buffer.from(key);
  }

  async #wrapped(tenantId: string): Promise<Uint8Array | undefined> {
    return (await this.#db.get<{ wrapped: Uint8Array }>('SELECT wrapped FROM tenant_keys WHERE tenant_id = ?', [tenantId]))?.wrapped;
  }
}
