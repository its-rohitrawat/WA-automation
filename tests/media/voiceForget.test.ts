import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { FORGET_WAITS_MS, MAX_FORGET_ATTEMPTS } from '../../src/meetings/sttForget.ts';
import { forgetVoiceCopies } from '../../src/media/voiceForget.ts';
import type { Db } from '../../src/store/db.ts';
import { finishMedia, insertMedia, markDownloaded, messageRowId } from '../../src/store/media.ts';
import { insertMessage } from '../../src/store/messages.ts';
import { SttHttpError, SttNoAnswerError } from '../../src/stt/http.ts';
import type { ProviderId } from '../../src/stt/types.ts';
import { manualClock } from '../../src/util/clock.ts';
import { createLogger, silentLogger } from '../../src/util/logger.ts';
import { NOW, seededDb } from '../helpers/db.ts';
import { FakeVoiceTranscriber } from '../helpers/voice.ts';

/** A transcribed voice note whose provider kept a copy named `ref`, noted by finishMedia (N1). Returns the media id. */
async function copied(db: Db, waId: string, ref: string, provider: ProviderId = 'elevenlabs'): Promise<number> {
  insertMessage(db, {
    waId, clientId: 1, senderJid: '919800000001@s.whatsapp.net', senderNumber: '919800000001', senderName: 'Mr. Sharma', fromMe: false,
    ts: '2026-10-10T08:00:00.000Z', text: null, quotedWaId: null, mediaType: 'voice',
  });
  const id = insertMedia(db, {
    messageId: messageRowId(db, 1, waId)!, clientId: 1, kind: 'voice', status: 'pending', mimeType: 'audio/ogg; codecs=opus', fileName: null, fileSize: 9000,
    seconds: 14, forwarded: false, refEnc: Buffer.from('sealed'), errorCode: null, createdAt: NOW,
  });
  await markDownloaded(db, id, { localPath: `media/SHA/2026-10/${waId}-${id}.ogg`, sha256: 'x', fileSize: 9000, at: NOW });
  await finishMedia(db, id, { textKind: 'extract', text: 'payment bhej diya', pageCount: null, note: null, at: NOW, forget: { provider, ref } });
  return id;
}

const rows = (db: Db) =>
  db.raw.prepare('SELECT media_id AS mediaId, provider, ref, attempts, next_try_at AS nextTryAt FROM media_stt_forget ORDER BY id').all() as {
    mediaId: number; provider: string; ref: string; attempts: number; nextTryAt: string | null;
  }[];

const later = (ms: number): string => new Date(Date.parse(NOW) + ms).toISOString();

function capturingLogger() {
  const lines: string[] = [];
  const log = createLogger('info', new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } }));
  return { lines, log };
}

describe('forgetVoiceCopies (N1)', () => {
  it('deletes every due copy through the transcriber and removes its row', async () => {
    const db = await seededDb();
    const a = await copied(db, 'A', 'tr_1');
    await copied(db, 'B', 'tr_2');
    const v = new FakeVoiceTranscriber({ provider: 'elevenlabs' });
    expect(rows(db).map((r) => r.mediaId)).toContain(a);
    expect(await forgetVoiceCopies(db, v, silentLogger(), { clock: manualClock(NOW) })).toBe(2);
    expect(v.forgotten).toEqual(['tr_1', 'tr_2']);
    expect(rows(db)).toEqual([]);
  });

  it('with a media id, deletes only that file\'s copies', async () => {
    const db = await seededDb();
    await copied(db, 'A', 'tr_1');
    const b = await copied(db, 'B', 'tr_2');
    const v = new FakeVoiceTranscriber({ provider: 'elevenlabs' });
    expect(await forgetVoiceCopies(db, v, silentLogger(), { mediaId: b, clock: manualClock(NOW) })).toBe(1);
    expect(v.forgotten).toEqual(['tr_2']);
    expect(rows(db).map((r) => r.ref)).toEqual(['tr_1']);
  });

  it('a 404 means the copy is already gone: the row is removed', async () => {
    const db = await seededDb();
    await copied(db, 'A', 'tr_1');
    const v = new FakeVoiceTranscriber({ provider: 'elevenlabs', forgetError: new SttHttpError(404) });
    expect(await forgetVoiceCopies(db, v, silentLogger(), { clock: manualClock(NOW) })).toBe(1);
    expect(v.forgotten).toEqual(['tr_1']);
    expect(rows(db)).toEqual([]);
  });

  it('counts each try, with the time of the next one, before the provider is asked', async () => {
    const db = await seededDb();
    await copied(db, 'A', 'tr_1');
    const seen: { attempts: number; nextTryAt: string | null }[] = [];
    class Watching extends FakeVoiceTranscriber {
      override async forget(ref: string): Promise<void> {
        const r = rows(db)[0]!;
        seen.push({ attempts: r.attempts, nextTryAt: r.nextTryAt });
        await super.forget(ref);
      }
    }
    const v = new Watching({ provider: 'elevenlabs', forgetError: new SttNoAnswerError('timeout') });
    expect(await forgetVoiceCopies(db, v, silentLogger(), { clock: manualClock(NOW) })).toBe(0);
    expect(seen).toEqual([{ attempts: 1, nextTryAt: later(FORGET_WAITS_MS[0]) }]);
    expect(rows(db)).toEqual([expect.objectContaining({ ref: 'tr_1', attempts: 1, nextTryAt: later(15 * 60_000) })]);
  });

  it('waits 15 minutes, 1 hour, 6 hours, then daily between tries, and stops after the last', async () => {
    const db = await seededDb();
    await copied(db, 'A', 'tr_1');
    const clock = manualClock(NOW);
    const v = new FakeVoiceTranscriber({ provider: 'elevenlabs', forgetError: new SttNoAnswerError('timeout') });
    const { lines, log } = capturingLogger();
    let elapsed = 0;
    for (const wait of [15 * 60_000, 60 * 60_000, 6 * 3_600_000, 24 * 3_600_000, 24 * 3_600_000]) {
      await forgetVoiceCopies(db, v, log, { clock });
      expect(rows(db)[0]).toMatchObject({ nextTryAt: later(elapsed + wait) });
      // Not before its next try is due.
      clock.advance(wait - 1);
      await forgetVoiceCopies(db, v, log, { clock });
      clock.advance(1);
      elapsed += wait;
    }
    expect(v.forgotten).toHaveLength(MAX_FORGET_ATTEMPTS);
    expect(rows(db)[0]).toMatchObject({ attempts: MAX_FORGET_ATTEMPTS });
    // The cap: the row is left alone, for a person to look at, however long it waits.
    clock.advance(30 * 24 * 3_600_000);
    expect(await forgetVoiceCopies(db, v, log, { clock })).toBe(0);
    expect(v.forgotten).toHaveLength(MAX_FORGET_ATTEMPTS);
    expect(rows(db)).toHaveLength(1);
    expect(lines.filter((l) => l.includes('tried again later'))).toHaveLength(MAX_FORGET_ATTEMPTS - 1);
    expect(lines.filter((l) => l.includes('no more tries'))).toHaveLength(1);
  });

  it('one copy that fails does not stop the others', async () => {
    const db = await seededDb();
    await copied(db, 'A', 'tr_1');
    await copied(db, 'B', 'tr_2');
    class FailsFirst extends FakeVoiceTranscriber {
      override async forget(ref: string): Promise<void> {
        await super.forget(ref);
        if (ref === 'tr_1') throw new SttHttpError(500);
      }
    }
    const v = new FailsFirst({ provider: 'elevenlabs' });
    expect(await forgetVoiceCopies(db, v, silentLogger(), { clock: manualClock(NOW) })).toBe(1);
    expect(rows(db)).toEqual([expect.objectContaining({ ref: 'tr_1', attempts: 1 })]);
  });

  it('skips, without counting a try, copies whose provider is not the one set up now, or when there is none', async () => {
    const db = await seededDb();
    const id = await copied(db, 'A', 'tr_1');
    const { lines, log } = capturingLogger();
    const openai = new FakeVoiceTranscriber({ provider: 'openai' });
    const noCopies = new FakeVoiceTranscriber({ provider: 'elevenlabs' });
    Object.defineProperty(noCopies, 'canForget', { value: false });
    expect(await forgetVoiceCopies(db, openai, log, { clock: manualClock(NOW) })).toBe(0);
    expect(await forgetVoiceCopies(db, null, log, { clock: manualClock(NOW) })).toBe(0);
    expect(await forgetVoiceCopies(db, noCopies, log, { clock: manualClock(NOW) })).toBe(0);
    expect(openai.forgotten).toEqual([]);
    expect(noCopies.forgotten).toEqual([]);
    expect(rows(db)).toEqual([{ mediaId: id, provider: 'elevenlabs', ref: 'tr_1', attempts: 0, nextTryAt: null }]);
    expect(lines.filter((l) => l.includes('"code":"provider_unavailable"') && l.includes(`"mediaId":${id}`))).toHaveLength(3);
    // Set up again: deleted.
    const el = new FakeVoiceTranscriber({ provider: 'elevenlabs' });
    expect(await forgetVoiceCopies(db, el, log, { clock: manualClock(NOW) })).toBe(1);
  });

  it('with a warned set (the service\'s), warns provider_unavailable once per row, still skipping it each time without counting', async () => {
    const db = await seededDb();
    const a = await copied(db, 'A', 'tr_1');
    const { lines, log } = capturingLogger();
    const warned = new Set<number>();
    const openai = new FakeVoiceTranscriber({ provider: 'openai' });
    const clock = manualClock(NOW);
    expect(await forgetVoiceCopies(db, openai, log, { clock, warned })).toBe(0);
    expect(await forgetVoiceCopies(db, openai, log, { clock, warned })).toBe(0);
    expect(await forgetVoiceCopies(db, null, log, { clock, warned })).toBe(0);
    const unavailable = (id: number) => lines.filter((l) => l.includes('"code":"provider_unavailable"') && l.includes(`"mediaId":${id}`));
    expect(unavailable(a)).toHaveLength(1);
    // A row noted later is warned about once too.
    const b = await copied(db, 'B', 'tr_2');
    expect(await forgetVoiceCopies(db, openai, log, { clock, warned })).toBe(0);
    expect(await forgetVoiceCopies(db, openai, log, { clock, warned })).toBe(0);
    expect(unavailable(a)).toHaveLength(1);
    expect(unavailable(b)).toHaveLength(1);
    expect(rows(db).map((r) => r.attempts)).toEqual([0, 0]); // never counted
    expect(openai.forgotten).toEqual([]);
    // Set up again: both are deleted.
    expect(await forgetVoiceCopies(db, new FakeVoiceTranscriber({ provider: 'elevenlabs' }), log, { clock, warned })).toBe(2);
  });

  it('logs the media id, provider and a code only: never the copy\'s id', async () => {
    const db = await seededDb();
    const id = await copied(db, 'A', 'tr_secret_1');
    const { lines, log } = capturingLogger();
    const failing = new FakeVoiceTranscriber({ provider: 'elevenlabs', forgetError: new SttHttpError(500, 'server_error') });
    const clock = manualClock(NOW);
    await forgetVoiceCopies(db, new FakeVoiceTranscriber({ provider: 'openai' }), log, { clock });
    for (let i = 0; i < MAX_FORGET_ATTEMPTS; i++) {
      await forgetVoiceCopies(db, failing, log, { clock });
      clock.advance(25 * 3_600_000);
    }
    expect(lines.length).toBeGreaterThanOrEqual(MAX_FORGET_ATTEMPTS + 1);
    const out = lines.join('');
    expect(out).not.toContain('tr_secret_1');
    expect(out).not.toContain('payment');
    for (const line of lines) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      expect(entry).toMatchObject({ mediaId: id, provider: 'elevenlabs' });
      for (const key of Object.keys(entry)) expect(['level', 'time', 'msg', 'mediaId', 'provider', 'code', 'attempts']).toContain(key);
    }
    expect(out).toContain('"code":"http_500"');
    // Each failed try says which try it was, as the meeting version does.
    const tries = lines.map((l) => (JSON.parse(l) as { attempts?: number }).attempts).filter((a) => a !== undefined);
    expect(tries).toEqual(Array.from({ length: MAX_FORGET_ATTEMPTS }, (_, i) => i + 1));
  });
});
