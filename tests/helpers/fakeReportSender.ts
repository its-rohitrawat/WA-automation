import type { ReportSender, SenderStatus, SendResult } from '../../src/report/types.ts';

export class FakeReportSender implements ReportSender {
  /** Results handed out in order. Once empty, every send succeeds. */
  results: SendResult[] = [];
  calls: { text: string }[] = [];
  state: SenderStatus = { state: 'idle', since: '2026-10-23T00:00:00.000Z', lastErrorCode: null };
  /** When set, sendReport waits for it (a slow send). */
  gate: Promise<void> | undefined;
  /** When true, the next sendReport throws. */
  throwNext = false;
  stopped = 0;
  /** What maskedRecipient() returns. */
  recipientMasked = '…1234';

  async sendReport(text: string): Promise<SendResult> {
    this.calls.push({ text });
    await this.gate;
    if (this.throwNext) {
      this.throwNext = false;
      throw new Error('sender crashed');
    }
    return this.results.shift() ?? { status: 'sent', messageIds: ['msg-1'] };
  }

  status(): SenderStatus {
    return this.state;
  }

  maskedRecipient(): string {
    return this.recipientMasked;
  }

  async stop(): Promise<void> {
    this.stopped++;
  }
}
