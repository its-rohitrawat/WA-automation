import { describe, expect, it } from 'vitest';
import {
  applyEdit, applyRevoke, clientIdsWithUnprocessed, insertMessage, lastActivity, listRecentProcessed, listUnprocessed,
  markProcessed, reactionsFor, resetProcessedSince, upsertReaction, type NewMessage,
} from '../../src/store/messages.ts';
import { NOW, seededDb } from '../helpers/db.ts';

const msg = (o: Partial<NewMessage> = {}): NewMessage => ({
  waId: 'm1', clientId: 1, senderJid: '919800000001@s.whatsapp.net', senderNumber: '919800000001', senderName: 'Mr. Sharma',
  fromMe: false, ts: '2026-10-10T08:00:00.000Z', text: 'hello', quotedWaId: null, mediaType: null, ...o,
});

describe('messages repository', () => {
  it('inserts each WhatsApp message once', () => {
    const db = seededDb();
    expect(insertMessage(db, msg())).toBe(true);
    expect(insertMessage(db, msg())).toBe(false);
    expect(listUnprocessed(db, 1)).toHaveLength(1);
  });

  it('keeps the edit history and queues the message again', () => {
    const db = seededDb();
    insertMessage(db, msg());
    markProcessed(db, [listUnprocessed(db, 1)[0]!.id], NOW);
    expect(applyEdit(db, 1, 'm1', 'hello edited', '2026-10-10T09:00:00.000Z')).toBe(true);
    expect(listUnprocessed(db, 1)[0]).toMatchObject({ text: 'hello edited', editedAt: '2026-10-10T09:00:00.000Z', processedAt: null });
    expect(db.prepare('SELECT previous_text FROM message_edits').get()).toEqual({ previous_text: 'hello' });
    expect(applyEdit(db, 1, 'm1', 'hello edited', '2026-10-10T09:05:00.000Z')).toBe(false);
  });

  it('flags revoked messages without deleting them and marks their tasks', () => {
    const db = seededDb();
    insertMessage(db, msg());
    db.prepare(`INSERT INTO tasks (code, client_id, side, title, category, priority, raised_on, source_wa_id, created_at, updated_at)
      VALUES ('SHA-001', 1, 'us', 't', 'design', 'high', '2026-10-10', 'm1', ?, ?)`).run(NOW, NOW);
    expect(applyRevoke(db, 1, 'm1')).toBe(true);
    expect(listUnprocessed(db, 1)).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT source_revoked FROM tasks').get()).toEqual({ source_revoked: 1 });
  });

  it('lists recent processed messages oldest first', () => {
    const db = seededDb();
    insertMessage(db, msg({ waId: 'a', ts: '2026-10-10T08:00:00.000Z' }));
    insertMessage(db, msg({ waId: 'b', ts: '2026-10-10T09:00:00.000Z' }));
    insertMessage(db, msg({ waId: 'c', ts: '2026-10-10T10:00:00.000Z' }));
    markProcessed(db, listUnprocessed(db, 1).map((m) => m.id), NOW);
    expect(listRecentProcessed(db, 1, 2).map((m) => m.waId)).toEqual(['b', 'c']);
    expect(lastActivity(db, 1)).toBe('2026-10-10T10:00:00.000Z');
  });

  it('upserts reactions and hides removed ones', () => {
    const db = seededDb();
    upsertReaction(db, { clientId: 1, targetWaId: 'm1', reactorJid: 'r1', emoji: '✅', ts: NOW });
    upsertReaction(db, { clientId: 1, targetWaId: 'm1', reactorJid: 'r1', emoji: '👍', ts: NOW });
    expect(reactionsFor(db, 1, ['m1'])).toEqual([{ targetWaId: 'm1', reactorJid: 'r1', emoji: '👍' }]);
    upsertReaction(db, { clientId: 1, targetWaId: 'm1', reactorJid: 'r1', emoji: '', ts: NOW });
    expect(reactionsFor(db, 1, ['m1'])).toEqual([]);
    expect(reactionsFor(db, 1, [])).toEqual([]);
  });

  it('finds clients with work and can re-queue a date range', () => {
    const db = seededDb();
    insertMessage(db, msg({ waId: 'a', ts: '2026-10-01T08:00:00.000Z' }));
    insertMessage(db, msg({ waId: 'b', ts: '2026-10-10T08:00:00.000Z' }));
    expect(clientIdsWithUnprocessed(db)).toEqual([1]);
    markProcessed(db, listUnprocessed(db, 1).map((m) => m.id), NOW);
    expect(clientIdsWithUnprocessed(db)).toEqual([]);
    expect(resetProcessedSince(db, 1, '2026-10-05T00:00:00.000Z')).toBe(1);
    expect(listUnprocessed(db, 1).map((m) => m.waId)).toEqual(['b']);
  });

  describe('re-check markers', () => {
    const processed = () => {
      const db = seededDb();
      insertMessage(db, msg());
      markProcessed(db, [listUnprocessed(db, 1)[0]!.id], NOW);
      return db;
    };
    const rx = (emoji: string) => ({ clientId: 1, targetWaId: 'm1', reactorJid: 'r1', emoji, ts: NOW });

    it('a reaction on a processed message queues it again', () => {
      const db = processed();
      upsertReaction(db, rx('✅'));
      expect(listUnprocessed(db, 1)[0]).toMatchObject({ waId: 'm1', requeueReason: 'reaction', processedAt: null });
    });

    it('a reaction on an unprocessed message adds no marker', () => {
      const db = seededDb();
      insertMessage(db, msg());
      upsertReaction(db, rx('✅'));
      expect(listUnprocessed(db, 1)[0]).toMatchObject({ requeueReason: null });
    });

    it('a removed reaction queues nothing', () => {
      const db = processed();
      upsertReaction(db, rx(''));
      expect(listUnprocessed(db, 1)).toHaveLength(0);
    });

    it('an edit of a processed message is marked as an edit', () => {
      const db = processed();
      applyEdit(db, 1, 'm1', 'hello edited', '2026-10-10T09:00:00.000Z');
      expect(listUnprocessed(db, 1)[0]).toMatchObject({ requeueReason: 'edit' });
    });

    it('markProcessed clears the marker', () => {
      const db = processed();
      upsertReaction(db, rx('✅'));
      markProcessed(db, [listUnprocessed(db, 1)[0]!.id], NOW);
      expect(listRecentProcessed(db, 1)[0]).toMatchObject({ requeueReason: null });
    });
  });
});
