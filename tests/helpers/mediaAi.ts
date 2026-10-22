import type { MediaAi, MediaAiResult } from '../../src/brain/mediaClient.ts';

const ZERO = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

/** Answers in order from a queue (an Error in the queue is thrown); defaults cost 1 cent. */
export class FakeMediaAi implements MediaAi {
  readonly calls: { kind: 'image' | 'pdf'; bytes: Buffer }[] = [];
  readonly #queue: (Partial<MediaAiResult> | Error)[];

  constructor(queue: (Partial<MediaAiResult> | Error)[] = []) {
    this.#queue = [...queue];
  }

  async describeImage(image: { data: Buffer; mediaType: 'image/jpeg' }): Promise<MediaAiResult> {
    this.calls.push({ kind: 'image', bytes: image.data });
    return this.#next('A screenshot of a payment receipt. Visible text: Paid ₹42,000');
  }

  async readScannedPdf(pdf: Buffer): Promise<MediaAiResult> {
    this.calls.push({ kind: 'pdf', bytes: pdf });
    return this.#next('Quotation No. 17. Total ₹1,20,000');
  }

  #next(text: string): MediaAiResult {
    const n = this.#queue.shift();
    if (n instanceof Error) throw n;
    return { text, usage: ZERO, costUsd: 0.01, fallbackUsed: false, ...n };
  }
}
