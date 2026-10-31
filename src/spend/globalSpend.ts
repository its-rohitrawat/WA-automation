// The platform-wide daily ceiling (SaaS S4.3, owner decision D3: US$100 a day by default) over spend billed to the
// founder (owner, 30 Oct): today that is the founder's runtime. A guard that joins it under its tenant id must then fit
// both its own cap and this ceiling. Customers pay their own Claude bills on their own key, so their guards never join:
// each is limited by its own daily cap only, and one busy customer can never pause anyone else.
//
// Nothing is kept here but the members: the total is the sum of their in-memory totals (each loaded from that
// tenant's own spend rows by SpendGuard.open, and reset at the IST day change by the guard itself), plus their live
// reservations. So it counts what was booked (a settled call's actual cost, not its estimate), resets with the day,
// and is never written to the database. A runtime that restarts joins again under the same id and replaces its old
// guard, so its spend is never counted twice; a stopped runtime's guard stays counted until then (the safe side).

/** What the ceiling reads of each member (a SpendGuard). */
export interface SpendMember {
  /** Today's booked spend (IST day). */
  spentToday(): number;
  /** Today's live reservations: paid calls in flight, at their estimates. */
  heldUsd(): number;
}

export class GlobalSpend {
  readonly #cap: number;
  readonly #members = new Map<string, SpendMember>();

  constructor(opts: { capUsd: number }) {
    this.#cap = opts.capUsd;
  }

  get capUsd(): number {
    return this.#cap;
  }

  /** Adds a customer's guard, replacing the one it had (a restarted runtime). */
  join(tenantId: string, member: SpendMember): void {
    this.#members.set(tenantId, member);
  }

  /** Booked spend today across every customer. */
  spentToday(): number {
    let t = 0;
    for (const m of this.#members.values()) t += m.spentToday();
    return t;
  }

  /** Booked spend today per customer, for the platform screens. */
  spentTodayByTenant(): Record<string, number> {
    return Object.fromEntries([...this.#members].map(([id, m]) => [id, m.spentToday()]));
  }

  isPaused(): boolean {
    return this.spentToday() >= this.#cap;
  }

  /** Whether a new hold of `estimateUsd` fits under the ceiling, with every live reservation counted. */
  fits(estimateUsd: number): boolean {
    let held = 0;
    for (const m of this.#members.values()) held += m.heldUsd();
    return this.spentToday() + held + estimateUsd <= this.#cap;
  }

  /** As fits(), with no paid call in flight anywhere. */
  fitsIgnoringHolds(estimateUsd: number): boolean {
    return this.spentToday() + estimateUsd <= this.#cap;
  }
}
