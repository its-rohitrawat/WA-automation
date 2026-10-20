/** Exact WhatsApp group IDs the agent may read. Everything else is dropped on arrival. */
export class AllowList {
  #ids: Set<string>;

  constructor(groupIds: Iterable<string>) {
    this.#ids = new Set(groupIds);
  }

  has(jid: string | null | undefined): boolean {
    return typeof jid === 'string' && this.#ids.has(jid);
  }

  replace(groupIds: Iterable<string>): void {
    this.#ids = new Set(groupIds);
  }

  get size(): number {
    return this.#ids.size;
  }
}
