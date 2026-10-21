import { describe, expect, it } from 'vitest';
import {
  applyEdit, applyRevoke, clientIdsWithUnprocessed, insertMessage, lastActivity, listRecentProcessed, listUnprocessed,
  markProcessed, markProcessedIfUnchanged, reactionsFor, resetProcessedSince, unprocessedCounts, upsertReaction, type NewMessage,
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

  it('lists only processed messages sent before a given time, when one is given', () => {
    const db = seededDb();
    insertMessage(db, msg({ waId: 'a', ts: '2026-10-10T08:00:00.000Z' }));
    insertMessage(db, msg({ waId: 'b', ts: '2026-10-10T09:00:00.000Z' }));
    insertMessage(db, msg({ waId: 'c', ts: '2026-10-10T10:00:00.000Z' }));
    markProcessed(db, listUnprocessed(db, 1).map((m) => m.id), NOW);
    expect(listRecentProcessed(db, 1, 30, '2026-10-10T10:00:00.000Z').map((m) => m.waId)).toEqual(['a', 'b']);
    expect(listRecentProcessed(db, 1, 1, '2026-10-10T10:00:00.000Z').map((m) => m.waId)).toEqual(['b']);
    expect(listRecentProcessed(db, 1, 30).map((m) => m.waId)).toEqual(['a', 'b', 'c']);
  });

  it('upserts reactions and hides removed ones', () => {
    const db = seededDb();
    upsertReaction(db, { clientId: 1, targetWaId: 'm1', reactorJid: 'r1', emoji: '✅', ts: NOW });
    upsertReaction(db, { clientId: 1, targetWaId: 'm1', reactorJid: 'r1', emoji: '👍', ts: NOW });
    expect(reactionsFor(db, 1, ['m1'])).toEqual([{ targetWaId: 'm1', reactorJid: 'r1', emoji: '👍', ts: NOW }]);
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

    it('the same reaction delivered twice re-queues only the first time', () => {
      const db = processed();
      upsertReaction(db, rx('✅'));
      markProcessed(db, [listUnprocessed(db, 1)[0]!.id], NOW);
      upsertReaction(db, rx('✅'));
      expect(listUnprocessed(db, 1)).toHaveLength(0);
      expect(db.prepare("SELECT processed_at AS p FROM messages WHERE wa_id = 'm1'").get()).toEqual({ p: NOW });
    });

    it('changing a reaction re-queues', () => {
      const db = processed();
      upsertReaction(db, rx('✅'));
      markProcessed(db, [listUnprocessed(db, 1)[0]!.id], NOW);
      upsertReaction(db, rx('👍'));
      expect(listUnprocessed(db, 1)[0]).toMatchObject({ requeueReason: 'reaction' });
    });

    it('an edit after a reaction leaves the marker as edit', () => {
      const db = processed();
      upsertReaction(db, rx('✅'));
      applyEdit(db, 1, 'm1', 'hello edited', '2026-10-10T09:00:00.000Z');
      expect(listUnprocessed(db, 1)[0]).toMatchObject({ requeueReason: 'edit' });
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

  describe('versions for changes during an AI call', () => {
    const rx = (emoji: string, targetWaId = 'm1') => ({ clientId: 1, targetWaId, reactorJid: 'r1', emoji, ts: NOW });
    const version = (db: ReturnType<typeof seededDb>, waId = 'm1') =>
      db.prepare('SELECT version, touch_reason AS touch FROM messages WHERE wa_id = ?').get(waId) as { version: number; touch: string | null };

    it('starts at version 0 and an edit bumps it', () => {
      const db = seededDb();
      insertMessage(db, msg());
      expect(listUnprocessed(db, 1)[0]).toMatchObject({ version: 0 });
      applyEdit(db, 1, 'm1', 'hello edited', '2026-10-10T09:00:00.000Z');
      expect(listUnprocessed(db, 1)[0]).toMatchObject({ version: 1 });
      expect(version(db)).toEqual({ version: 1, touch: 'edit' });
    });

    it('a new reaction bumps the version, a repeated identical one does not', () => {
      const db = seededDb();
      insertMessage(db, msg());
      upsertReaction(db, rx('✅'));
      expect(version(db)).toEqual({ version: 1, touch: 'reaction' });
      upsertReaction(db, rx('✅'));
      expect(version(db)).toEqual({ version: 1, touch: 'reaction' });
      upsertReaction(db, rx(''));
      expect(version(db)).toEqual({ version: 1, touch: 'reaction' });
    });

    it('a reaction after an edit keeps the touch reason as edit', () => {
      const db = seededDb();
      insertMessage(db, msg());
      applyEdit(db, 1, 'm1', 'hello edited', '2026-10-10T09:00:00.000Z');
      upsertReaction(db, rx('✅'));
      expect(version(db)).toEqual({ version: 2, touch: 'edit' });
    });

    it('markProcessedIfUnchanged skips a row that changed and queues it with a re-check marker', () => {
      const db = seededDb();
      insertMessage(db, msg({ waId: 'm1' }));
      insertMessage(db, msg({ waId: 'm2', ts: '2026-10-10T08:01:00.000Z' }));
      insertMessage(db, msg({ waId: 'm3', ts: '2026-10-10T08:02:00.000Z' }));
      const seen = listUnprocessed(db, 1).map((m) => ({ id: m.id, version: m.version }));
      applyEdit(db, 1, 'm1', 'hello edited', '2026-10-10T09:00:00.000Z');
      upsertReaction(db, rx('✅', 'm2'));

      expect(markProcessedIfUnchanged(db, seen, NOW)).toBe(2);
      expect(listUnprocessed(db, 1).map((m) => [m.waId, m.requeueReason])).toEqual([['m1', 'edit'], ['m2', 'reaction']]);
      expect(listRecentProcessed(db, 1).map((m) => m.waId)).toEqual(['m3']);
    });

    it('markProcessedIfUnchanged returns 1 for one changed row and clears the touch reason of processed ones', () => {
      const db = seededDb();
      insertMessage(db, msg({ waId: 'm1' }));
      insertMessage(db, msg({ waId: 'm2', ts: '2026-10-10T08:01:00.000Z' }));
      applyEdit(db, 1, 'm2', 'edited before the run', '2026-10-10T08:30:00.000Z');
      const seen = listUnprocessed(db, 1).map((m) => ({ id: m.id, version: m.version }));
      applyEdit(db, 1, 'm1', 'hello edited', '2026-10-10T09:00:00.000Z');

      expect(markProcessedIfUnchanged(db, seen, NOW)).toBe(1);
      expect(listUnprocessed(db, 1)[0]).toMatchObject({ waId: 'm1', requeueReason: 'edit', processedAt: null });
      expect(version(db, 'm2')).toEqual({ version: 1, touch: null });
      expect(listRecentProcessed(db, 1)[0]).toMatchObject({ waId: 'm2', requeueReason: null, processedAt: NOW });
    });
  });
});

describe('unprocessedCounts', () => {
  it('counts unprocessed, non-revoked messages per client', () => {
    const db = seededDb();
    insertMessage(db, msg({ waId: 'a' }));
    insertMessage(db, msg({ waId: 'b' }));
    insertMessage(db, msg({ waId: 'c' }));
    insertMessage(db, msg({ waId: 'd', clientId: 2 }));
    markProcessed(db, [listUnprocessed(db, 1)[0]!.id], NOW);
    applyRevoke(db, 1, 'b');
    expect(unprocessedCounts(db)).toEqual(new Map([[1, 1], [2, 1]]));
  });
});
