import type { BaileysEventMap, GroupMetadata } from 'baileys';
import { vi } from 'vitest';
import type { SocketLike } from '../../src/wa/gateway.ts';

/** Send-type methods a real Baileys socket has. The gateway must never call any of them. */
export const SEND_METHODS = ['sendMessage', 'readMessages', 'sendPresenceUpdate', 'sendReceipt', 'chatModify'] as const;

type AnyListener = (arg: unknown) => void;

export class FakeSocket implements SocketLike {
  readonly #handlers = new Map<string, AnyListener[]>();

  readonly ev = {
    on: <T extends keyof BaileysEventMap>(event: T, listener: (arg: BaileysEventMap[T]) => void): void => {
      const list = this.#handlers.get(event) ?? [];
      list.push(listener as AnyListener);
      this.#handlers.set(event, list);
    },
  };

  /** The event names something subscribed to, in first-subscription order. */
  subscribedEvents(): string[] {
    return [...this.#handlers.keys()];
  }

  emit<T extends keyof BaileysEventMap>(event: T, arg: BaileysEventMap[T]): void {
    for (const listener of this.#handlers.get(event) ?? []) listener(arg);
  }

  groupFetchAllParticipating = vi.fn(
    async (): Promise<{ [jid: string]: GroupMetadata }> => ({
      '120363999999999999@g.us': { id: '120363999999999999@g.us', subject: 'Family' } as GroupMetadata,
      '120363000000000001@g.us': { id: '120363000000000001@g.us', subject: 'Sharma Interiors x Studio' } as GroupMetadata,
    }),
  );

  end = vi.fn();
  sendMessage = vi.fn();
  readMessages = vi.fn();
  sendPresenceUpdate = vi.fn();
  sendReceipt = vi.fn();
  chatModify = vi.fn();
}

export function closeWith(sock: FakeSocket, statusCode: number): void {
  sock.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: Object.assign(new Error('closed'), { output: { statusCode } }), date: new Date() },
  });
}
