import { getClientByGroupId } from '../store/clients.ts';
import type { Db } from '../store/db.ts';
import { applyEdit, applyRevoke, insertMessage, upsertReaction } from '../store/messages.ts';
import { upsertPerson } from '../store/people.ts';
import type { NormalizedEvent } from './normalize.ts';

export class Ingestor {
  readonly #db: Db;
  readonly #onNew: (clientId: number) => void;

  constructor(opts: { db: Db; onNewMessages: (clientId: number) => void }) {
    this.#db = opts.db;
    this.#onNew = opts.onNewMessages;
  }

  handle(e: NormalizedEvent): void {
    const db = this.#db;
    // Second line of defence after the gateway's allow-list.
    const client = getClientByGroupId(db, e.groupId);
    if (!client || !client.active) return;

    switch (e.kind) {
      case 'message': {
        const inserted = insertMessage(db, {
          waId: e.waId,
          clientId: client.id,
          senderJid: e.senderJid,
          senderNumber: e.senderNumber,
          senderName: e.senderName,
          fromMe: e.fromMe,
          ts: e.ts.toISOString(),
          text: e.text,
          quotedWaId: e.quotedWaId,
          mediaType: e.mediaType,
        });
        upsertPerson(db, { clientId: client.id, jid: e.senderJid, number: e.senderNumber, name: e.senderName, fromMe: e.fromMe });
        if (inserted) this.#onNew(client.id);
        return;
      }
      case 'edit':
        if (applyEdit(db, client.id, e.waId, e.text, e.ts.toISOString())) this.#onNew(client.id);
        return;
      case 'revoke':
        applyRevoke(db, client.id, e.waId);
        return;
      case 'reaction':
        upsertReaction(db, { clientId: client.id, targetWaId: e.targetWaId, reactorJid: e.reactorJid, emoji: e.emoji, ts: e.ts.toISOString() });
        upsertPerson(db, { clientId: client.id, jid: e.reactorJid, number: null, name: null, fromMe: e.fromMe });
        if (e.emoji) this.#onNew(client.id);
        return;
    }
  }
}
