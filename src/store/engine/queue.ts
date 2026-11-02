/** First in, first out: each job starts when the previous one has settled, whatever its outcome. */
export class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(job, job);
    this.#tail = next.then(() => undefined, () => undefined);
    return next;
  }
}
