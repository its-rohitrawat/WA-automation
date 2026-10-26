import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/store/db.ts';
import { failMedia, finishMedia, getMedia, insertMedia, type MediaKind } from '../../src/store/media.ts';
import {
  applyEdit, applyRevoke, clearTouches, clientIdsWithUnprocessed, insertMessage, lastActivity, listRecentProcessed, listUnprocessed,
  markProcessed, markProcessedIfUnchanged, reactionsFor, resetProcessedSince, unprocessedCounts, upsertReaction, type NewMessage,
} from '../../src/store/messages.ts';
import { LATER, NOW, seededDb } from '../helpers/db.ts';

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

    describe('a touch from before the run never labels the message queued again (Job C: P2)', () => {
      const EDITED = '2026-10-10T09:00:00.000Z';
      /** What a run does when it starts: it lists its batch, then clears the touches at the versions it read. */
      const startRun = (db: Db) => {
        const seen = listUnprocessed(db, 1).map((m) => ({ id: m.id, version: m.version }));
        clearTouches(db, seen);
        return seen;
      };
      const unprocessed = () => {
        const db = seededDb();
        insertMessage(db, msg());
        return db;
      };
      const editBefore = (db: Db) => applyEdit(db, 1, 'm1', 'hello edited', EDITED);
      const editRecheck = (db: Db) => {
        markProcessed(db, [listUnprocessed(db, 1)[0]!.id], NOW);
        applyEdit(db, 1, 'm1', 'hello edited', EDITED);
      };

      it.each([
        { why: 'an edit before the first run', before: editBefore },
        { why: 'an edit re-check in flight', before: editRecheck },
      ])('$why, then a reaction during the run: queued again as a reaction re-check', ({ before }) => {
        const db = unprocessed();
        before(db);
        const seen = startRun(db);
        upsertReaction(db, rx('✅'));
        expect(markProcessedIfUnchanged(db, seen, NOW)).toBe(1);
        expect(listUnprocessed(db, 1)[0]).toMatchObject({ waId: 'm1', requeueReason: 'reaction', processedAt: null });
      });

      it.each([
        { why: 'nothing before the run', before: (_db: Db) => {} },
        { why: 'an edit before the first run', before: editBefore },
        { why: 'a reaction before the first run', before: (db: Db) => upsertReaction(db, rx('👍')) },
      ])('$why, then an edit during the run: queued again as an edit re-check', ({ before }) => {
        const db = unprocessed();
        before(db);
        const seen = startRun(db);
        applyEdit(db, 1, 'm1', 'hello edited again', LATER);
        expect(markProcessedIfUnchanged(db, seen, NOW)).toBe(1);
        expect(listUnprocessed(db, 1)[0]).toMatchObject({ waId: 'm1', requeueReason: 'edit', processedAt: null });
      });

      it('clears a touch only at the version the run read, so a touch made after the listing is kept', () => {
        const db = unprocessed();
        const seen = listUnprocessed(db, 1).map((m) => ({ id: m.id, version: m.version }));
        applyEdit(db, 1, 'm1', 'hello edited', EDITED); // between the listing and the clearing
        clearTouches(db, seen);
        expect(version(db)).toEqual({ version: 1, touch: 'edit' });
        expect(markProcessedIfUnchanged(db, seen, NOW)).toBe(1);
        expect(listUnprocessed(db, 1)[0]).toMatchObject({ waId: 'm1', requeueReason: 'edit' });
      });

      it('leaves the re-check marker the run shows alone, and touches no other row', () => {
        const db = unprocessed();
        insertMessage(db, msg({ waId: 'm2', ts: '2026-10-10T08:01:00.000Z' }));
        editRecheck(db);
        upsertReaction(db, rx('✅', 'm2'));
        const m1 = listUnprocessed(db, 1).find((m) => m.waId === 'm1')!;
        clearTouches(db, [{ id: m1.id, version: m1.version }]);
        expect(version(db)).toEqual({ version: 1, touch: null });
        expect(listUnprocessed(db, 1)[0]).toMatchObject({ waId: 'm1', requeueReason: 'edit', processedAt: null });
        expect(version(db, 'm2')).toEqual({ version: 1, touch: 'reaction' });
      });
    });
  });
});

describe('a file read after its message was processed (12h)', () => {
  const READ = { textKind: 'description' as const, text: 'A payment receipt', pageCount: null, note: null, at: LATER };
  /** A message with a pending file, an image unless kind says otherwise. */
  function withFile(kind: MediaKind = 'image') {
    const db = seededDb();
    insertMessage(db, msg({ mediaType: kind }));
    const messageId = listUnprocessed(db, 1)[0]!.id;
    const fileId = insertMedia(db, {
      messageId, clientId: 1, kind, status: 'pending', mimeType: kind === 'image' ? 'image/jpeg' : null, fileName: null, fileSize: 1000, seconds: null,
      forwarded: false, refEnc: null, errorCode: null, createdAt: NOW,
    });
    return { db, messageId, fileId };
  }
  /** Processed with the file unread, then the file is read: the message is queued again with the flag. */
  function requeuedForFile() {
    const s = withFile();
    markProcessed(s.db, [s.messageId], NOW);
    finishMedia(s.db, s.fileId, READ);
    return s;
  }
  const flag = (db: Db, fileId: number) => getMedia(db, fileId)!.requeuedForText;
  /**
   * The rows a run marks. fileUnread: its prompt showed the file as still being read. fileShown: its prompt showed the
   * file's text as a "file now read" re-check.
   */
  const seenBy = (db: Db, o: { fileUnread?: boolean; fileShown?: boolean } = {}) =>
    listUnprocessed(db, 1).map((m) => ({ id: m.id, version: m.version, ...o }));
  const reasons = (db: Db) => db.prepare("SELECT requeue_reason AS requeue, touch_reason AS touch FROM messages WHERE wa_id = 'm1'").get();
  const react = (db: Db, ts: string) => upsertReaction(db, { clientId: 1, targetWaId: 'm1', reactorJid: 'r1', emoji: '✅', ts });

  it('markProcessedIfUnchanged clears the flag when it marks the message processed', () => {
    const { db, fileId } = requeuedForFile();
    expect(flag(db, fileId)).toBe(true);
    expect(markProcessedIfUnchanged(db, seenBy(db, { fileShown: true }), LATER)).toBe(0);
    expect(flag(db, fileId)).toBe(false);
    expect(listRecentProcessed(db, 1)[0]).toMatchObject({ waId: 'm1', processedAt: LATER, requeueReason: null });
  });

  it('markProcessedIfUnchanged keeps the flag when the message changed during a call that did not show the file', () => {
    const { db, fileId } = requeuedForFile();
    const seen = seenBy(db);
    react(db, LATER);
    expect(markProcessedIfUnchanged(db, seen, LATER)).toBe(1);
    expect(flag(db, fileId)).toBe(true);
    expect(listUnprocessed(db, 1)[0]).toMatchObject({ waId: 'm1', processedAt: null, requeueReason: 'reaction' });
  });

  it.each([
    { why: 'a reaction', change: (db: Db) => react(db, LATER), reason: 'reaction' },
    { why: 'an edit', change: (db: Db) => applyEdit(db, 1, 'm1', 'hello edited', LATER), reason: 'edit' },
  ])('a file re-check whose mark fails for $why clears the flag, since that run showed the file (M2)', ({ change, reason }) => {
    const { db, fileId } = requeuedForFile();
    const seen = seenBy(db, { fileShown: true });
    change(db);
    expect(markProcessedIfUnchanged(db, seen, LATER)).toBe(1);
    expect(flag(db, fileId)).toBe(false);
    expect(listUnprocessed(db, 1)[0]).toMatchObject({ waId: 'm1', processedAt: null, requeueReason: reason });
  });

  describe('a file read during the call, and nothing else changed then: a plain file re-check, never a stale label (I1)', () => {
    it.each([
      { why: 'an edit before the run of a message never processed', before: (db: Db) => applyEdit(db, 1, 'm1', 'hello edited', NOW) },
      { why: 'a reaction before the run of a message never processed', before: (db: Db) => react(db, NOW) },
      { why: 'an edit re-check in flight', before: (db: Db, messageId: number) => { markProcessed(db, [messageId], NOW); applyEdit(db, 1, 'm1', 'hello edited', NOW); } },
      { why: 'a reaction re-check in flight', before: (db: Db, messageId: number) => { markProcessed(db, [messageId], NOW); react(db, NOW); } },
    ])('$why', ({ before }) => {
      const { db, messageId, fileId } = withFile();
      before(db, messageId);
      const seen = seenBy(db, { fileUnread: true });
      finishMedia(db, fileId, READ);
      expect(markProcessedIfUnchanged(db, seen, LATER)).toBe(1);
      expect(flag(db, fileId)).toBe(true);
      expect(reasons(db)).toEqual({ requeue: null, touch: null });
      expect(listUnprocessed(db, 1)[0]).toMatchObject({ waId: 'm1', processedAt: null, requeueReason: null });
    });

    it.each([
      { why: 'an edit before the file is read', change: (db: Db, fileId: number) => { applyEdit(db, 1, 'm1', 'hello edited', LATER); finishMedia(db, fileId, READ); }, reason: 'edit' },
      { why: 'an edit after the file is read', change: (db: Db, fileId: number) => { finishMedia(db, fileId, READ); applyEdit(db, 1, 'm1', 'hello edited', LATER); }, reason: 'edit' },
      { why: 'a reaction', change: (db: Db, fileId: number) => { react(db, LATER); finishMedia(db, fileId, READ); }, reason: 'reaction' },
    ])('a genuine change during the same call keeps its label and the flag: $why', ({ change, reason }) => {
      const { db, fileId } = withFile();
      const seen = seenBy(db, { fileUnread: true });
      change(db, fileId);
      expect(markProcessedIfUnchanged(db, seen, LATER)).toBe(1);
      expect(flag(db, fileId)).toBe(true);
      expect(listUnprocessed(db, 1)[0]).toMatchObject({ waId: 'm1', processedAt: null, requeueReason: reason });
    });

    it('an edit before the first run, then a reaction and the file read during it: a reaction re-check with the flag, never an edit (Job C: P2)', () => {
      const { db, fileId } = withFile();
      applyEdit(db, 1, 'm1', 'hello edited', NOW);
      const seen = seenBy(db, { fileUnread: true });
      clearTouches(db, seen); // the run starts
      react(db, LATER);
      finishMedia(db, fileId, READ);
      expect(markProcessedIfUnchanged(db, seen, LATER)).toBe(1);
      expect(flag(db, fileId)).toBe(true);
      expect(listUnprocessed(db, 1)[0]).toMatchObject({ waId: 'm1', processedAt: null, requeueReason: 'reaction' });
    });
  });

  it('a file read during the call wins: the run that showed it unread leaves the message queued and flagged', () => {
    const { db, fileId } = withFile();
    const seen = seenBy(db, { fileUnread: true });
    finishMedia(db, fileId, READ);
    expect(flag(db, fileId)).toBe(false); // the message was not processed yet
    expect(markProcessedIfUnchanged(db, seen, LATER)).toBe(1);
    expect(flag(db, fileId)).toBe(true);
    expect(listUnprocessed(db, 1)[0]).toMatchObject({ waId: 'm1', processedAt: null, requeueReason: null });
  });

  it('a run that showed the file unread flags nothing when the message changed but the file has no text yet', () => {
    const { db, fileId } = withFile();
    const seen = seenBy(db, { fileUnread: true });
    applyEdit(db, 1, 'm1', 'hello edited', LATER);
    expect(markProcessedIfUnchanged(db, seen, LATER)).toBe(1);
    expect(flag(db, fileId)).toBe(false);
    failMedia(db, fileId, { status: 'failed', errorCode: 'not_pdf', at: LATER });
    const again = seenBy(db, { fileUnread: true });
    applyEdit(db, 1, 'm1', 'hello edited twice', LATER);
    expect(markProcessedIfUnchanged(db, again, LATER)).toBe(1);
    expect(flag(db, fileId)).toBe(false);
  });

  describe('images, documents, voice notes and audio count; videos, stickers and backlog transcripts do not (M1, V1, V6)', () => {
    const TRANSCRIPT = { textKind: 'extract' as const, text: 'Payment done, please check', pageCount: null, note: null, at: LATER };

    it.each(['voice', 'audio'] as const)('kind %s: a file that gets text during the call leaves its message queued and flagged, as an image does', (kind) => {
      const { db, fileId } = withFile(kind);
      const seen = seenBy(db, { fileUnread: true });
      finishMedia(db, fileId, TRANSCRIPT);
      expect(markProcessedIfUnchanged(db, seen, LATER)).toBe(1);
      expect(flag(db, fileId)).toBe(true);
      expect(listUnprocessed(db, 1)[0]).toMatchObject({ waId: 'm1', processedAt: null, requeueReason: null });
    });

    it.each(['voice', 'audio'] as const)('kind %s: a file that gets text during a call that also saw an edit is flagged, and the edit keeps its label', (kind) => {
      const { db, fileId } = withFile(kind);
      const seen = seenBy(db, { fileUnread: true });
      applyEdit(db, 1, 'm1', 'hello edited', LATER);
      finishMedia(db, fileId, TRANSCRIPT);
      expect(markProcessedIfUnchanged(db, seen, LATER)).toBe(1);
      expect(flag(db, fileId)).toBe(true);
      expect(listUnprocessed(db, 1)[0]).toMatchObject({ waId: 'm1', processedAt: null, requeueReason: 'edit' });
    });

    it.each(['video', 'sticker'] as const)('kind %s: a file that gets text during the call leaves its message to be marked processed', (kind) => {
      const { db, fileId } = withFile(kind);
      const seen = seenBy(db, { fileUnread: true });
      finishMedia(db, fileId, TRANSCRIPT);
      expect(markProcessedIfUnchanged(db, seen, LATER)).toBe(0);
      expect(flag(db, fileId)).toBe(false);
      expect(listUnprocessed(db, 1)).toEqual([]);
    });

    it.each(['voice', 'audio'] as const)('kind %s: a backlog transcript that arrives during the call leaves its message to be marked processed (V6)', (kind) => {
      const { db, fileId } = withFile(kind);
      db.prepare('UPDATE media SET backlog = 1 WHERE id = ?').run(fileId);
      const seen = seenBy(db, { fileUnread: true });
      finishMedia(db, fileId, TRANSCRIPT);
      expect(markProcessedIfUnchanged(db, seen, LATER)).toBe(0);
      expect(flag(db, fileId)).toBe(false);
      expect(listUnprocessed(db, 1)).toEqual([]);
      expect(getMedia(db, fileId)).toMatchObject({ status: 'done', text: 'Payment done, please check', backlog: true });
    });
  });

  it('a run that showed the file unread marks the message processed when nothing changed', () => {
    const { db, fileId } = withFile();
    expect(markProcessedIfUnchanged(db, seenBy(db, { fileUnread: true }), LATER)).toBe(0);
    expect(flag(db, fileId)).toBe(false);
    expect(listUnprocessed(db, 1)).toEqual([]);
  });

  it('an edit of a message queued again for its file is marked as an edit', () => {
    const { db, fileId } = requeuedForFile();
    applyEdit(db, 1, 'm1', 'hello edited', LATER);
    expect(listUnprocessed(db, 1)[0]).toMatchObject({ waId: 'm1', requeueReason: 'edit' });
    expect(flag(db, fileId)).toBe(true);
  });

  it('a reaction to a message queued again for its file is marked as a reaction', () => {
    const { db, fileId } = requeuedForFile();
    upsertReaction(db, { clientId: 1, targetWaId: 'm1', reactorJid: 'r1', emoji: '✅', ts: LATER });
    expect(listUnprocessed(db, 1)[0]).toMatchObject({ waId: 'm1', requeueReason: 'reaction' });
    expect(flag(db, fileId)).toBe(true);
  });

  it('an edit or a reaction of a message never processed is still not a re-check, file or not', () => {
    const { db, fileId } = withFile();
    upsertReaction(db, { clientId: 1, targetWaId: 'm1', reactorJid: 'r1', emoji: '✅', ts: LATER });
    applyEdit(db, 1, 'm1', 'hello edited', LATER);
    expect(listUnprocessed(db, 1)[0]).toMatchObject({ waId: 'm1', requeueReason: null });
    expect(flag(db, fileId)).toBe(false);
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
