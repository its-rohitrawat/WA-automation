// The platform-wide daily ceiling (SaaS S4.3, owner decision D3: US$100 a day by default). Each runtime's SpendGuard,
// the founder's included, joins it under its customer's id, and every reservation must then fit the customer's own cap
// and this ceiling. It stops a runaway bug across all runtimes, even though customers pay their own Claude bills.
//
// Nothing is kept here but the members: the total is the sum of their in-memory totals (each loaded from that
// customer's own spend rows by SpendGuard.open, and reset at the IST day change by the guard itself), plus their live
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
