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
  it('inserts each WhatsApp message once', async () => {
    const db = await seededDb();
    expect(await insertMessage(db, msg())).toBe(true);
    expect(await insertMessage(db, msg())).toBe(false);
    expect(await listUnprocessed(db, 1)).toHaveLength(1);
  });

  it('skips only a duplicate: a message missing a required field is an error, not dropped in silence', async () => {
    const db = await seededDb();
    await expect(insertMessage(db, msg({ senderJid: null as unknown as string }))).rejects.toThrow(/NOT NULL/);
    expect(await listUnprocessed(db, 1)).toEqual([]);
  });

  it('keeps the edit history and queues the message again', async () => {
    const db = await seededDb();
    await insertMessage(db, msg());
    await markProcessed(db, [(await listUnprocessed(db, 1))[0]!.id], NOW);
    expect(await applyEdit(db, 1, 'm1', 'hello edited', '2026-10-10T09:00:00.000Z')).toBe(true);
    expect((await listUnprocessed(db, 1))[0]).toMatchObject({ text: 'hello edited', editedAt: '2026-10-10T09:00:00.000Z', processedAt: null });
    expect(db.raw.prepare('SELECT previous_text FROM message_edits').get()).toEqual({ previous_text: 'hello' });
    expect(await applyEdit(db, 1, 'm1', 'hello edited', '2026-10-10T09:05:00.000Z')).toBe(false);
  });

  it('flags revoked messages without deleting them and marks their tasks', async () => {
    const db = await seededDb();
    await insertMessage(db, msg());
    db.raw.prepare(`INSERT INTO tasks (code, client_id, side, title, category, priority, raised_on, source_wa_id, created_at, updated_at)
      VALUES ('SHA-001', 1, 'us', 't', 'design', 'high', '2026-10-10', 'm1', ?, ?)`).run(NOW, NOW);
    expect(await applyRevoke(db, 1, 'm1')).toBe(true);
    expect(await listUnprocessed(db, 1)).toHaveLength(0);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 1 });
    expect(db.raw.prepare('SELECT source_revoked FROM tasks').get()).toEqual({ source_revoked: 1 });
  });

  it('lists recent processed messages oldest first', async () => {
    const db = await seededDb();
    await insertMessage(db, msg({ waId: 'a', ts: '2026-10-10T08:00:00.000Z' }));
    await insertMessage(db, msg({ waId: 'b', ts: '2026-10-10T09:00:00.000Z' }));
    await insertMessage(db, msg({ waId: 'c', ts: '2026-10-10T10:00:00.000Z' }));
    await markProcessed(db, (await listUnprocessed(db, 1)).map((m) => m.id), NOW);
    expect((await listRecentProcessed(db, 1, 2)).map((m) => m.waId)).toEqual(['b', 'c']);
    expect(await lastActivity(db, 1)).toBe('2026-10-10T10:00:00.000Z');
  });

  it('lists only processed messages sent before a given time, when one is given', async () => {
    const db = await seededDb();
    await insertMessage(db, msg({ waId: 'a', ts: '2026-10-10T08:00:00.000Z' }));
    await insertMessage(db, msg({ waId: 'b', ts: '2026-10-10T09:00:00.000Z' }));
    await insertMessage(db, msg({ waId: 'c', ts: '2026-10-10T10:00:00.000Z' }));
    await markProcessed(db, (await listUnprocessed(db, 1)).map((m) => m.id), NOW);
    expect((await listRecentProcessed(db, 1, 30, '2026-10-10T10:00:00.000Z')).map((m) => m.waId)).toEqual(['a', 'b']);
    expect((await listRecentProcessed(db, 1, 1, '2026-10-10T10:00:00.000Z')).map((m) => m.waId)).toEqual(['b']);
    expect((await listRecentProcessed(db, 1, 30)).map((m) => m.waId)).toEqual(['a', 'b', 'c']);
  });

  it('upserts reactions and hides removed ones', async () => {
    const db = await seededDb();
    await upsertReaction(db, { clientId: 1, targetWaId: 'm1', reactorJid: 'r1', emoji: '✅', ts: NOW });
    await upsertReaction(db, { clientId: 1, targetWaId: 'm1', reactorJid: 'r1', emoji: '👍', ts: NOW });
    expect(await reactionsFor(db, 1, ['m1'])).toEqual([{ targetWaId: 'm1', reactorJid: 'r1', emoji: '👍', ts: NOW }]);
    await upsertReaction(db, { clientId: 1, targetWaId: 'm1', reactorJid: 'r1', emoji: '', ts: NOW });
    expect(await reactionsFor(db, 1, ['m1'])).toEqual([]);
    expect(await reactionsFor(db, 1, [])).toEqual([]);
  });

  it('finds clients with work and can re-queue a date range', async () => {
    const db = await seededDb();
    await insertMessage(db, msg({ waId: 'a', ts: '2026-10-01T08:00:00.000Z' }));
    await insertMessage(db, msg({ waId: 'b', ts: '2026-10-10T08:00:00.000Z' }));
    expect(await clientIdsWithUnprocessed(db)).toEqual([1]);
    await markProcessed(db, (await listUnprocessed(db, 1)).map((m) => m.id), NOW);
    expect(await clientIdsWithUnprocessed(db)).toEqual([]);
    expect(await resetProcessedSince(db, 1, '2026-10-05T00:00:00.000Z')).toBe(1);
    expect((await listUnprocessed(db, 1)).map((m) => m.waId)).toEqual(['b']);
  });

  describe('re-check markers', () => {
    const processed = async () => {
      const db = await seededDb();
      await insertMessage(db, msg());
      await markProcessed(db, [(await listUnprocessed(db, 1))[0]!.id], NOW);
      return db;
    };
    const rx = (emoji: string) => ({ clientId: 1, targetWaId: 'm1', reactorJid: 'r1', emoji, ts: NOW });

    it('a reaction on a processed message queues it again', async () => {
      const db = await processed();
      await upsertReaction(db, rx('✅'));
      expect((await listUnprocessed(db, 1))[0]).toMatchObject({ waId: 'm1', requeueReason: 'reaction', processedAt: null });
    });

    it('a reaction on an unprocessed message adds no marker', async () => {
      const db = await seededDb();
      await insertMessage(db, msg());
      await upsertReaction(db, rx('✅'));
      expect((await listUnprocessed(db, 1))[0]).toMatchObject({ requeueReason: null });
    });

    it('a removed reaction queues nothing', async () => {
      const db = await processed();
      await upsertReaction(db, rx(''));
      expect(await listUnprocessed(db, 1)).toHaveLength(0);
    });

    it('the same reaction delivered twice re-queues only the first time', async () => {
      const db = await processed();
      await upsertReaction(db, rx('✅'));
      await markProcessed(db, [(await listUnprocessed(db, 1))[0]!.id], NOW);
      await upsertReaction(db, rx('✅'));
      expect(await listUnprocessed(db, 1)).toHaveLength(0);
      expect(db.raw.prepare("SELECT processed_at AS p FROM messages WHERE wa_id = 'm1'").get()).toEqual({ p: NOW });
    });

    it('changing a reaction re-queues', async () => {
      const db = await processed();
      await upsertReaction(db, rx('✅'));
      await markProcessed(db, [(await listUnprocessed(db, 1))[0]!.id], NOW);
      await upsertReaction(db, rx('👍'));
      expect((await listUnprocessed(db, 1))[0]).toMatchObject({ requeueReason: 'reaction' });
    });

    it('an edit after a reaction leaves the marker as edit', async () => {
      const db = await processed();
      await upsertReaction(db, rx('✅'));
      await applyEdit(db, 1, 'm1', 'hello edited', '2026-10-10T09:00:00.000Z');
      expect((await listUnprocessed(db, 1))[0]).toMatchObject({ requeueReason: 'edit' });
    });

    it('an edit of a processed message is marked as an edit', async () => {
      const db = await processed();
      await applyEdit(db, 1, 'm1', 'hello edited', '2026-10-10T09:00:00.000Z');
      expect((await listUnprocessed(db, 1))[0]).toMatchObject({ requeueReason: 'edit' });
    });

    it('markProcessed clears the marker', async () => {
      const db = await processed();
      await upsertReaction(db, rx('✅'));
      await markProcessed(db, [(await listUnprocessed(db, 1))[0]!.id], NOW);
      expect((await listRecentProcessed(db, 1))[0]).toMatchObject({ requeueReason: null });
    });
  });

  describe('versions for changes during an AI call', () => {
    const rx = (emoji: string, targetWaId = 'm1') => ({ clientId: 1, targetWaId, reactorJid: 'r1', emoji, ts: NOW });
    const version = (db: Awaited<ReturnType<typeof seededDb>>, waId = 'm1') =>
      db.raw.prepare('SELECT version, touch_reason AS touch FROM messages WHERE wa_id = ?').get(waId) as { version: number; touch: string | null };

    it('starts at version 0 and an edit bumps it', async () => {
      const db = await seededDb();
      await insertMessage(db, msg());
      expect((await listUnprocessed(db, 1))[0]).toMatchObject({ version: 0 });
      await applyEdit(db, 1, 'm1', 'hello edited', '2026-10-10T09:00:00.000Z');
      expect((await listUnprocessed(db, 1))[0]).toMatchObject({ version: 1 });
      expect(version(db)).toEqual({ version: 1, touch: 'edit' });
    });

    it('a new reaction bumps the version, a repeated identical one does not', async () => {
      const db = await seededDb();
      await insertMessage(db, msg());
      await upsertReaction(db, rx('✅'));
      expect(version(db)).toEqual({ version: 1, touch: 'reaction' });
      await upsertReaction(db, rx('✅'));
      expect(version(db)).toEqual({ version: 1, touch: 'reaction' });
      await upsertReaction(db, rx(''));
      expect(version(db)).toEqual({ version: 1, touch: 'reaction' });
    });

    it('a reaction after an edit keeps the touch reason as edit', async () => {
      const db = await seededDb();
      await insertMessage(db, msg());
      await applyEdit(db, 1, 'm1', 'hello edited', '2026-10-10T09:00:00.000Z');
      await upsertReaction(db, rx('✅'));
      expect(version(db)).toEqual({ version: 2, touch: 'edit' });
    });

    it('markProcessedIfUnchanged skips a row that changed and queues it with a re-check marker', async () => {
      const db = await seededDb();
      await insertMessage(db, msg({ waId: 'm1' }));
      await insertMessage(db, msg({ waId: 'm2', ts: '2026-10-10T08:01:00.000Z' }));
      await insertMessage(db, msg({ waId: 'm3', ts: '2026-10-10T08:02:00.000Z' }));
      const seen = (await listUnprocessed(db, 1)).map((m) => ({ id: m.id, version: m.version }));
      await applyEdit(db, 1, 'm1', 'hello edited', '2026-10-10T09:00:00.000Z');
      await upsertReaction(db, rx('✅', 'm2'));

      expect(await markProcessedIfUnchanged(db, seen, NOW)).toBe(2);
      expect((await listUnprocessed(db, 1)).map((m) => [m.waId, m.requeueReason])).toEqual([['m1', 'edit'], ['m2', 'reaction']]);
      expect((await listRecentProcessed(db, 1)).map((m) => m.waId)).toEqual(['m3']);
    });

    it('markProcessedIfUnchanged returns 1 for one changed row and clears the touch reason of processed ones', async () => {
      const db = await seededDb();
      await insertMessage(db, msg({ waId: 'm1' }));
      await insertMessage(db, msg({ waId: 'm2', ts: '2026-10-10T08:01:00.000Z' }));
      await applyEdit(db, 1, 'm2', 'edited before the run', '2026-10-10T08:30:00.000Z');
      const seen = (await listUnprocessed(db, 1)).map((m) => ({ id: m.id, version: m.version }));
      await applyEdit(db, 1, 'm1', 'hello edited', '2026-10-10T09:00:00.000Z');

      expect(await markProcessedIfUnchanged(db, seen, NOW)).toBe(1);
      expect((await listUnprocessed(db, 1))[0]).toMatchObject({ waId: 'm1', requeueReason: 'edit', processedAt: null });
      expect(version(db, 'm2')).toEqual({ version: 1, touch: null });
      expect((await listRecentProcessed(db, 1))[0]).toMatchObject({ waId: 'm2', requeueReason: null, processedAt: NOW });
    });

    describe('a touch from before the run never labels the message queued again (Job C: P2)', () => {
      const EDITED = '2026-10-10T09:00:00.000Z';
      /** What a run does when it starts: it lists its batch, then clears the touches at the versions it read. */
      const startRun = async (db: Db) => {
        const seen = (await listUnprocessed(db, 1)).map((m) => ({ id: m.id, version: m.version }));
        await clearTouches(db, seen);
        return seen;
      };
      const unprocessed = async () => {
        const db = await seededDb();
        await insertMessage(db, msg());
        return db;
      };
      const editBefore = (db: Db) => applyEdit(db, 1, 'm1', 'hello edited', EDITED);
      const editRecheck = async (db: Db) => {
        await markProcessed(db, [(await listUnprocessed(db, 1))[0]!.id], NOW);
        await applyEdit(db, 1, 'm1', 'hello edited', EDITED);
      };

      it.each([
        { why: 'an edit before the first run', before: editBefore },
        { why: 'an edit re-check in flight', before: editRecheck },
      ])('$why, then a reaction during the run: queued again as a reaction re-check', async ({ before }) => {
        const db = await unprocessed();
        await before(db);
        const seen = await startRun(db);
        await upsertReaction(db, rx('✅'));
        expect(await markProcessedIfUnchanged(db, seen, NOW)).toBe(1);
        expect((await listUnprocessed(db, 1))[0]).toMatchObject({ waId: 'm1', requeueReason: 'reaction', processedAt: null });
      });

      it.each([
        { why: 'nothing before the run', before: (_db: Db) => {} },
        { why: 'an edit before the first run', before: editBefore },
        { why: 'a reaction before the first run', before: (db: Db) => upsertReaction(db, rx('👍')) },
      ])('$why, then an edit during the run: queued again as an edit re-check', async ({ before }) => {
        const db = await unprocessed();
        await before(db);
        const seen = await startRun(db);
        await applyEdit(db, 1, 'm1', 'hello edited again', LATER);
        expect(await markProcessedIfUnchanged(db, seen, NOW)).toBe(1);
        expect((await listUnprocessed(db, 1))[0]).toMatchObject({ waId: 'm1', requeueReason: 'edit', processedAt: null });
      });

      it('clears a touch only at the version the run read, so a touch made after the listing is kept', async () => {
        const db = await unprocessed();
        const seen = (await listUnprocessed(db, 1)).map((m) => ({ id: m.id, version: m.version }));
        await applyEdit(db, 1, 'm1', 'hello edited', EDITED); // between the listing and the clearing
        await clearTouches(db, seen);
        expect(version(db)).toEqual({ version: 1, touch: 'edit' });
        expect(await markProcessedIfUnchanged(db, seen, NOW)).toBe(1);
        expect((await listUnprocessed(db, 1))[0]).toMatchObject({ waId: 'm1', requeueReason: 'edit' });
      });

      it('leaves the re-check marker the run shows alone, and touches no other row', async () => {
        const db = await unprocessed();
        await insertMessage(db, msg({ waId: 'm2', ts: '2026-10-10T08:01:00.000Z' }));
        await editRecheck(db);
        await upsertReaction(db, rx('✅', 'm2'));
        const m1 = (await listUnprocessed(db, 1)).find((m) => m.waId === 'm1')!;
        await clearTouches(db, [{ id: m1.id, version: m1.version }]);
        expect(version(db)).toEqual({ version: 1, touch: null });
        expect((await listUnprocessed(db, 1))[0]).toMatchObject({ waId: 'm1', requeueReason: 'edit', processedAt: null });
        expect(version(db, 'm2')).toEqual({ version: 1, touch: 'reaction' });
      });
    });
  });
});

describe('a file read after its message was processed (12h)', () => {
  const READ = { textKind: 'description' as const, text: 'A payment receipt', pageCount: null, note: null, at: LATER };
  /** A message with a pending file, an image unless kind says otherwise. */
  async function withFile(kind: MediaKind = 'image') {
    const db = await seededDb();
    await insertMessage(db, msg({ mediaType: kind }));
    const messageId = (await listUnprocessed(db, 1))[0]!.id;
    const fileId = await insertMedia(db, {
      messageId, clientId: 1, kind, status: 'pending', mimeType: kind === 'image' ? 'image/jpeg' : null, fileName: null, fileSize: 1000, seconds: null,
      forwarded: false, refEnc: null, errorCode: null, createdAt: NOW,
    });
    return { db, messageId, fileId };
  }
  /** Processed with the file unread, then the file is read: the message is queued again with the flag. */
  async function requeuedForFile() {
    const s = await withFile();
    await markProcessed(s.db, [s.messageId], NOW);
    await finishMedia(s.db, s.fileId, READ);
    return s;
  }
  const flag = async (db: Db, fileId: number) => (await getMedia(db, fileId))!.requeuedForText;
  /**
   * The rows a run marks. fileUnread: its prompt showed the file as still being read. fileShown: its prompt showed the
   * file's text as a "file now read" re-check.
   */
  const seenBy = async (db: Db, o: { fileUnread?: boolean; fileShown?: boolean } = {}) =>
    (await listUnprocessed(db, 1)).map((m) => ({ id: m.id, version: m.version, ...o }));
  const reasons = (db: Db) => db.raw.prepare("SELECT requeue_reason AS requeue, touch_reason AS touch FROM messages WHERE wa_id = 'm1'").get();
  const react = (db: Db, ts: string) => upsertReaction(db, { clientId: 1, targetWaId: 'm1', reactorJid: 'r1', emoji: '✅', ts });

  it('markProcessedIfUnchanged clears the flag when it marks the message processed', async () => {
    const { db, fileId } = await requeuedForFile();
    expect(await flag(db, fileId)).toBe(true);
    expect(await markProcessedIfUnchanged(db, await seenBy(db, { fileShown: true }), LATER)).toBe(0);
    expect(await flag(db, fileId)).toBe(false);
    expect((await listRecentProcessed(db, 1))[0]).toMatchObject({ waId: 'm1', processedAt: LATER, requeueReason: null });
  });

  it('markProcessedIfUnchanged keeps the flag when the message changed during a call that did not show the file', async () => {
    const { db, fileId } = await requeuedForFile();
    const seen = await seenBy(db);
    await react(db, LATER);
    expect(await markProcessedIfUnchanged(db, seen, LATER)).toBe(1);
    expect(await flag(db, fileId)).toBe(true);
    expect((await listUnprocessed(db, 1))[0]).toMatchObject({ waId: 'm1', processedAt: null, requeueReason: 'reaction' });
  });

  it.each([
    { why: 'a reaction', change: (db: Db) => react(db, LATER), reason: 'reaction' },
    { why: 'an edit', change: (db: Db) => applyEdit(db, 1, 'm1', 'hello edited', LATER), reason: 'edit' },
  ])('a file re-check whose mark fails for $why clears the flag, since that run showed the file (M2)', async ({ change, reason }) => {
    const { db, fileId } = await requeuedForFile();
    const seen = await seenBy(db, { fileShown: true });
    await change(db);
    expect(await markProcessedIfUnchanged(db, seen, LATER)).toBe(1);
    expect(await flag(db, fileId)).toBe(false);
    expect((await listUnprocessed(db, 1))[0]).toMatchObject({ waId: 'm1', processedAt: null, requeueReason: reason });
  });

  describe('a file read during the call, and nothing else changed then: a plain file re-check, never a stale label (I1)', () => {
    it.each([
      { why: 'an edit before the run of a message never processed', before: (db: Db) => applyEdit(db, 1, 'm1', 'hello edited', NOW) },
      { why: 'a reaction before the run of a message never processed', before: (db: Db) => react(db, NOW) },
      { why: 'an edit re-check in flight', before: async (db: Db, messageId: number) => { await markProcessed(db, [messageId], NOW); await applyEdit(db, 1, 'm1', 'hello edited', NOW); } },
      { why: 'a reaction re-check in flight', before: async (db: Db, messageId: number) => { await markProcessed(db, [messageId], NOW); await react(db, NOW); } },
    ])('$why', async ({ before }) => {
      const { db, messageId, fileId } = await withFile();
      await before(db, messageId);
      const seen = await seenBy(db, { fileUnread: true });
      await finishMedia(db, fileId, READ);
      expect(await markProcessedIfUnchanged(db, seen, LATER)).toBe(1);
      expect(await flag(db, fileId)).toBe(true);
      expect(reasons(db)).toEqual({ requeue: null, touch: null });
      expect((await listUnprocessed(db, 1))[0]).toMatchObject({ waId: 'm1', processedAt: null, requeueReason: null });
    });

    it.each([
      { why: 'an edit before the file is read', change: async (db: Db, fileId: number) => { await applyEdit(db, 1, 'm1', 'hello edited', LATER); await finishMedia(db, fileId, READ); }, reason: 'edit' },
      { why: 'an edit after the file is read', change: async (db: Db, fileId: number) => { await finishMedia(db, fileId, READ); await applyEdit(db, 1, 'm1', 'hello edited', LATER); }, reason: 'edit' },
      { why: 'a reaction', change: async (db: Db, fileId: number) => { await react(db, LATER); await finishMedia(db, fileId, READ); }, reason: 'reaction' },
    ])('a genuine change during the same call keeps its label and the flag: $why', async ({ change, reason }) => {
      const { db, fileId } = await withFile();
      const seen = await seenBy(db, { fileUnread: true });
      await change(db, fileId);
      expect(await markProcessedIfUnchanged(db, seen, LATER)).toBe(1);
      expect(await flag(db, fileId)).toBe(true);
      expect((await listUnprocessed(db, 1))[0]).toMatchObject({ waId: 'm1', processedAt: null, requeueReason: reason });
    });

    it('an edit before the first run, then a reaction and the file read during it: a reaction re-check with the flag, never an edit (Job C: P2)', async () => {
      const { db, fileId } = await withFile();
      await applyEdit(db, 1, 'm1', 'hello edited', NOW);
      const seen = await seenBy(db, { fileUnread: true });
      await clearTouches(db, seen); // the run starts
      await react(db, LATER);
      await finishMedia(db, fileId, READ);
      expect(await markProcessedIfUnchanged(db, seen, LATER)).toBe(1);
      expect(await flag(db, fileId)).toBe(true);
      expect((await listUnprocessed(db, 1))[0]).toMatchObject({ waId: 'm1', processedAt: null, requeueReason: 'reaction' });
    });
  });

  it('a file read during the call wins: the run that showed it unread leaves the message queued and flagged', async () => {
    const { db, fileId } = await withFile();
    const seen = await seenBy(db, { fileUnread: true });
    await finishMedia(db, fileId, READ);
    expect(await flag(db, fileId)).toBe(false); // the message was not processed yet
    expect(await markProcessedIfUnchanged(db, seen, LATER)).toBe(1);
    expect(await flag(db, fileId)).toBe(true);
    expect((await listUnprocessed(db, 1))[0]).toMatchObject({ waId: 'm1', processedAt: null, requeueReason: null });
  });

  it('a run that showed the file unread flags nothing when the message changed but the file has no text yet', async () => {
    const { db, fileId } = await withFile();
    const seen = await seenBy(db, { fileUnread: true });
    await applyEdit(db, 1, 'm1', 'hello edited', LATER);
    expect(await markProcessedIfUnchanged(db, seen, LATER)).toBe(1);
    expect(await flag(db, fileId)).toBe(false);
    await failMedia(db, fileId, { status: 'failed', errorCode: 'not_pdf', at: LATER });
    const again = await seenBy(db, { fileUnread: true });
    await applyEdit(db, 1, 'm1', 'hello edited twice', LATER);
    expect(await markProcessedIfUnchanged(db, again, LATER)).toBe(1);
    expect(await flag(db, fileId)).toBe(false);
  });

  describe('images, documents, voice notes and audio count; videos, stickers and backlog transcripts do not (M1, V1, V6)', () => {
    const TRANSCRIPT = { textKind: 'extract' as const, text: 'Payment done, please check', pageCount: null, note: null, at: LATER };

    it.each(['voice', 'audio'] as const)('kind %s: a file that gets text during the call leaves its message queued and flagged, as an image does', async (kind) => {
      const { db, fileId } = await withFile(kind);
      const seen = await seenBy(db, { fileUnread: true });
      await finishMedia(db, fileId, TRANSCRIPT);
      expect(await markProcessedIfUnchanged(db, seen, LATER)).toBe(1);
      expect(await flag(db, fileId)).toBe(true);
      expect((await listUnprocessed(db, 1))[0]).toMatchObject({ waId: 'm1', processedAt: null, requeueReason: null });
    });

    it.each(['voice', 'audio'] as const)('kind %s: a file that gets text during a call that also saw an edit is flagged, and the edit keeps its label', async (kind) => {
      const { db, fileId } = await withFile(kind);
      const seen = await seenBy(db, { fileUnread: true });
      await applyEdit(db, 1, 'm1', 'hello edited', LATER);
      await finishMedia(db, fileId, TRANSCRIPT);
      expect(await markProcessedIfUnchanged(db, seen, LATER)).toBe(1);
      expect(await flag(db, fileId)).toBe(true);
      expect((await listUnprocessed(db, 1))[0]).toMatchObject({ waId: 'm1', processedAt: null, requeueReason: 'edit' });
    });

    it.each(['video', 'sticker'] as const)('kind %s: a file that gets text during the call leaves its message to be marked processed', async (kind) => {
      const { db, fileId } = await withFile(kind);
      const seen = await seenBy(db, { fileUnread: true });
      await finishMedia(db, fileId, TRANSCRIPT);
      expect(await markProcessedIfUnchanged(db, seen, LATER)).toBe(0);
      expect(await flag(db, fileId)).toBe(false);
      expect(await listUnprocessed(db, 1)).toEqual([]);
    });

    it.each(['voice', 'audio'] as const)('kind %s: a backlog transcript that arrives during the call leaves its message to be marked processed (V6)', async (kind) => {
      const { db, fileId } = await withFile(kind);
      db.raw.prepare('UPDATE media SET backlog = 1 WHERE id = ?').run(fileId);
      const seen = await seenBy(db, { fileUnread: true });
      await finishMedia(db, fileId, TRANSCRIPT);
      expect(await markProcessedIfUnchanged(db, seen, LATER)).toBe(0);
      expect(await flag(db, fileId)).toBe(false);
      expect(await listUnprocessed(db, 1)).toEqual([]);
      expect(await getMedia(db, fileId)).toMatchObject({ status: 'done', text: 'Payment done, please check', backlog: true });
    });
  });

  it('a run that showed the file unread marks the message processed when nothing changed', async () => {
    const { db, fileId } = await withFile();
    expect(await markProcessedIfUnchanged(db, await seenBy(db, { fileUnread: true }), LATER)).toBe(0);
    expect(await flag(db, fileId)).toBe(false);
    expect(await listUnprocessed(db, 1)).toEqual([]);
  });

  it('an edit of a message queued again for its file is marked as an edit', async () => {
    const { db, fileId } = await requeuedForFile();
    await applyEdit(db, 1, 'm1', 'hello edited', LATER);
    expect((await listUnprocessed(db, 1))[0]).toMatchObject({ waId: 'm1', requeueReason: 'edit' });
    expect(await flag(db, fileId)).toBe(true);
  });

  it('a reaction to a message queued again for its file is marked as a reaction', async () => {
    const { db, fileId } = await requeuedForFile();
    await upsertReaction(db, { clientId: 1, targetWaId: 'm1', reactorJid: 'r1', emoji: '✅', ts: LATER });
    expect((await listUnprocessed(db, 1))[0]).toMatchObject({ waId: 'm1', requeueReason: 'reaction' });
    expect(await flag(db, fileId)).toBe(true);
  });

  it('an edit or a reaction of a message never processed is still not a re-check, file or not', async () => {
    const { db, fileId } = await withFile();
    await upsertReaction(db, { clientId: 1, targetWaId: 'm1', reactorJid: 'r1', emoji: '✅', ts: LATER });
    await applyEdit(db, 1, 'm1', 'hello edited', LATER);
    expect((await listUnprocessed(db, 1))[0]).toMatchObject({ waId: 'm1', requeueReason: null });
    expect(await flag(db, fileId)).toBe(false);
  });
});

describe('unprocessedCounts', () => {
  it('counts unprocessed, non-revoked messages per client', async () => {
    const db = await seededDb();
    await insertMessage(db, msg({ waId: 'a' }));
    await insertMessage(db, msg({ waId: 'b' }));
    await insertMessage(db, msg({ waId: 'c' }));
    await insertMessage(db, msg({ waId: 'd', clientId: 2 }));
    await markProcessed(db, [(await listUnprocessed(db, 1))[0]!.id], NOW);
    await applyRevoke(db, 1, 'b');
    expect(await unprocessedCounts(db)).toEqual(new Map([[1, 1], [2, 1]]));
  });
});
