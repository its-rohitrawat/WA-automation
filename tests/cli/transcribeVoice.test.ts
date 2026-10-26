import { beforeEach, describe, expect, it } from 'vitest';
import { CorrectionError } from '../../src/cli/corrections.ts';
import { transcribeVoiceCommand, type TranscribeVoiceDeps } from '../../src/cli/transcribeVoice.ts';
import { parseEnv } from '../../src/config/env.ts';
import { syncClients } from '../../src/store/clients.ts';
import type { Db } from '../../src/store/db.ts';
import { claimMedia, finishMedia, getMedia, insertMedia, markDownloaded, messageRowId, type MediaKind, type NewMedia } from '../../src/store/media.ts';
import { insertMessage, listUnprocessed, markProcessed } from '../../src/store/messages.ts';
import { VOICE_LENGTH_TOLERANCE_S, voiceCeilingUsd } from '../../src/stt/voice.ts';
import { manualClock } from '../../src/util/clock.ts';
import { LATER, NOW, SHARMA, seededDb } from '../helpers/db.ts';

// `cli transcribe-voice` (Phase 2b Task 8, V6, N2, N4) against a seeded database: no service, no network, no real ffmpeg.

const QUEUED_AT = '2026-10-26T07:30:00.000Z';
const KEY = 'test-stt-key-not-real';
const OGG = 'audio/ogg; codecs=opus';
/** The sender's file name and a transcript: never printed. */
const FILE_NAME = 'Secret Plans Rahul.ogg';
const TRANSCRIPT = 'Payment done, please check the invoice';

let db: Db;
let lines: string[];
let ffmpegAsked: (string | undefined)[];

beforeEach(() => {
  db = seededDb();
  lines = [];
  ffmpegAsked = [];
});

function env(over: Record<string, string> = {}) {
  return parseEnv({ STT_PROVIDER: 'sarvam', STT_API_KEY: KEY, INR_PER_USD: '88', STT_MAX_SECONDS: '600', ...over });
}

/** A fake ffmpeg finder: present (its path) or absent (null); records what it was asked. */
const finder = (found: boolean) => async (configured: string | undefined): Promise<string | null> => {
  ffmpegAsked.push(configured);
  return found ? (configured ?? 'ffmpeg') : null;
};

/** ffmpeg is there unless a test says otherwise: every file needs it (Task 5 review round 1). */
function deps(over: Partial<TranscribeVoiceDeps> = {}): TranscribeVoiceDeps {
  return { env: env(), out: (l) => void lines.push(l), db, clock: manualClock(QUEUED_AT), findFfmpeg: finder(true), ...over };
}

const run = (opts: { client?: string; yes?: boolean } = {}, over: Partial<TranscribeVoiceDeps> = {}) =>
  transcribeVoiceCommand({ ...opts, yes: opts.yes === true }, deps(over));

let seq = 0;
/** A 2a voice note: saved on disk, finished without a transcript, its message processed. */
function backlogVoice(o: { clientId?: number; kind?: MediaKind; fileSize?: number; mimeType?: string | null; note?: string | null; text?: string } = {}): number {
  const clientId = o.clientId ?? 1;
  const kind = o.kind ?? 'voice';
  const waId = `W${++seq}`;
  insertMessage(db, {
    waId, clientId, senderJid: '919800000001@s.whatsapp.net', senderNumber: '919800000001', senderName: 'Mr. Sharma', fromMe: false,
    ts: '2026-10-10T08:00:00.000Z', text: null, quotedWaId: null, mediaType: kind,
  });
  const messageId = messageRowId(db, clientId, waId)!;
  const row: NewMedia = {
    messageId, clientId, kind, status: 'pending', mimeType: o.mimeType === undefined ? OGG : o.mimeType, fileName: FILE_NAME, fileSize: 1000,
    seconds: 5, forwarded: false, refEnc: Buffer.from('sealed'), errorCode: null, createdAt: NOW,
  };
  const id = insertMedia(db, row);
  markDownloaded(db, id, { localPath: `media/SHA/2026-10/${waId}-${id}.ogg`, sha256: 'x', fileSize: o.fileSize ?? 90_000, at: NOW });
  claimMedia(db, id, { nextAttemptAt: LATER, at: NOW });
  finishMedia(db, id, {
    textKind: o.text === undefined ? null : 'extract', text: o.text ?? null, pageCount: null, note: o.note ?? null, at: NOW,
  });
  markProcessed(db, [messageId], NOW);
  return id;
}

const statusOf = (id: number) => {
  const m = getMedia(db, id)!;
  return { status: m.status, backlog: m.backlog, note: m.note, text: m.text, attempts: m.attempts, createdAt: m.createdAt };
};
const allMedia = () => db.prepare('SELECT * FROM media ORDER BY id').all();
const output = () => lines.join('\n');
const NEEDS_FFMPEG = 'ffmpeg, skipped (install ffmpeg, or set FFMPEG_PATH; after installing ffmpeg, restart the service, then run this again).';
/** The cost line, in the command's words. */
const costLine = (about: string, most: string, provider = 'sarvam', maxSeconds = 600) =>
  `Cost: about $${about} from the file sizes (speech, ${provider} list price); at most $${most} if every file runs to the STT_MAX_SECONDS limit (${maxSeconds} seconds).`;

describe('transcribe-voice: speech-to-text off', () => {
  it('says so and changes nothing', async () => {
    const id = backlogVoice();
    const before = allMedia();
    await run({}, { env: parseEnv({}) });
    expect(lines).toEqual(['Speech-to-text is not set up (STT_PROVIDER is none). Nothing changed.']);
    expect(allMedia()).toEqual(before);
    await run({ yes: true }, { env: parseEnv({}) });
    expect(statusOf(id).status).toBe('done');
    expect(ffmpegAsked).toEqual([]);
  });
});

describe('transcribe-voice: the dry run', () => {
  it('prints the count, the minutes and the two cost figures, and changes nothing', async () => {
    // 900,000 bytes bound 600 s, 450,000 bytes 300 s; each estimated at its bound (under STT_MAX_SECONDS + 5 s):
    // 1,500 s, about 25 minutes.
    backlogVoice({ fileSize: 900_000 });
    backlogVoice({ fileSize: 900_000, kind: 'audio', mimeType: 'audio/mpeg' });
    backlogVoice({ fileSize: 450_000, clientId: 2 });
    const before = allMedia();
    await run();
    const about = 2 * voiceCeilingUsd('sarvam', 600, 88) + voiceCeilingUsd('sarvam', 300, 88); // about $0.142
    expect(about).toBeCloseTo(0.142, 3);
    expect(3 * voiceCeilingUsd('sarvam', 605, 88)).toBeCloseTo(0.1719, 4);
    expect(lines).toEqual([
      'To transcribe: 3 voice notes or audio files saved before Phase 2b, about 25 minutes.',
      costLine('0.15', '0.18'),
      'With --yes the running service transcribes them, for the record. This costs money and counts toward the daily spend cap ($15.00).',
      'Nothing was changed. Re-run with --yes to queue them.',
    ]);
    expect(allMedia()).toEqual(before);
  });

  it('counts the minutes up to a whole minute and the cost up to a whole cent', async () => {
    backlogVoice({ fileSize: 15_000 }); // 10 s: $0.0006; 605 s at the limit: $0.037
    await run({}, { env: env({ STT_PROVIDER: 'elevenlabs' }) });
    expect(lines.slice(0, 2)).toEqual([
      'To transcribe: 1 voice note or audio file saved before Phase 2b, about 1 minute.',
      costLine('0.01', '0.04', 'elevenlabs'),
    ]);
  });

  it('pins both cost figures: each file at min(size bound, STT_MAX_SECONDS + tolerance), and every file at that limit', async () => {
    // STT_MAX_SECONDS 900. Bounds 10 s, 100 s, 900 s (the cap) and 3,334 s (5 MB, a high bitrate), the last estimated at
    // the 905 s limit: 10 + 100 + 900 + 905 = 1,915 s, about 32 minutes.
    backlogVoice({ fileSize: 15_000 });
    backlogVoice({ fileSize: 150_000, clientId: 2 });
    backlogVoice({ fileSize: 1_350_000, kind: 'audio', mimeType: 'audio/mpeg' });
    backlogVoice({ fileSize: 5_000_000 });
    await run({}, { env: env({ STT_MAX_SECONDS: '900' }) });
    // Sarvam: ₹30 an hour at ₹88 to the dollar.
    const about = [10, 100, 900, 900 + VOICE_LENGTH_TOLERANCE_S].reduce((a, s) => a + voiceCeilingUsd('sarvam', s, 88), 0);
    const most = 4 * voiceCeilingUsd('sarvam', 900 + VOICE_LENGTH_TOLERANCE_S, 88);
    expect(about).toBeCloseTo((1915 * 30) / 3600 / 88, 9); // $0.1813
    expect(most).toBeCloseTo((4 * 905 * 30) / 3600 / 88, 9); // $0.3428
    expect(lines).toEqual([
      'To transcribe: 4 voice notes or audio files saved before Phase 2b, about 32 minutes.',
      costLine('0.19', '0.35', 'sarvam', 900),
      'With --yes the running service transcribes them, for the record. This costs money and counts toward the daily spend cap ($15.00).',
      'Nothing was changed. Re-run with --yes to queue them.',
    ]);
  });

  it('a file with no size is estimated at STT_MAX_SECONDS plus the tolerance, and queued', async () => {
    const id = backlogVoice();
    db.prepare('UPDATE media SET file_size = NULL WHERE id = ?').run(id);
    await run({ yes: true });
    expect(lines).toEqual([
      'To transcribe: 1 voice note or audio file saved before Phase 2b, about 11 minutes.',
      costLine('0.06', '0.06'), // 605 s both ways: $0.057
      '1 queued. The running service now transcribes them, for the record. This costs money and counts toward the daily spend cap ($15.00).',
    ]);
    expect(statusOf(id)).toMatchObject({ status: 'pending', backlog: true });
  });

  it('says when there is nothing to transcribe', async () => {
    backlogVoice({ note: 'too_long' });
    await run();
    expect(lines).toEqual(['No saved voice notes or audio files are waiting for a transcript. Nothing changed.']);
    await run({ yes: true });
    expect(lines).toEqual([
      'No saved voice notes or audio files are waiting for a transcript. Nothing changed.',
      'No saved voice notes or audio files are waiting for a transcript. Nothing changed.',
    ]);
  });

  // Task 5 review round 2: the size never refuses a file. A 1-minute 128 kbit/s MP3 is about 960 KB (a bound of 640 s);
  // the service measures it and refuses only a file measured too long.
  it('a large high-bitrate file is queued, estimated at no more than STT_MAX_SECONDS plus the tolerance', async () => {
    const fits = backlogVoice({ fileSize: 900_000 }); // 600 s
    const large = backlogVoice({ fileSize: 960_000, kind: 'audio', mimeType: 'audio/mpeg' }); // 640 s: estimated at 605 s
    await run();
    // 600 + 605 = 1,205 s, about 21 minutes; $0.114 and 2 x 605 s: $0.115.
    expect(lines).toEqual([
      'To transcribe: 2 voice notes or audio files saved before Phase 2b, about 21 minutes.',
      costLine('0.12', '0.12'),
      'With --yes the running service transcribes them, for the record. This costs money and counts toward the daily spend cap ($15.00).',
      'Nothing was changed. Re-run with --yes to queue them.',
    ]);
    expect(output()).not.toContain('too long');
    // A lower cap lowers the estimate of both, and still queues them.
    lines = [];
    await run({ yes: true }, { env: env({ STT_MAX_SECONDS: '300' }) });
    expect(lines.slice(0, 2)).toEqual([
      'To transcribe: 2 voice notes or audio files saved before Phase 2b, about 11 minutes.', // 2 x 305 s
      costLine('0.06', '0.06', 'sarvam', 300),
    ]);
    expect(statusOf(fits)).toMatchObject({ status: 'pending', backlog: true });
    expect(statusOf(large)).toMatchObject({ status: 'pending', backlog: true });
  });

  // Task 5 review round 1: every file is converted first, so every file needs ffmpeg, a WhatsApp voice note too.
  it('without ffmpeg every file is counted as needing it, a voice note too; with ffmpeg the same files are counted (N2)', async () => {
    const ogg = backlogVoice({ fileSize: 90_000 });
    const m4a = backlogVoice({ fileSize: 90_000, kind: 'audio', mimeType: 'audio/mp4', note: 'format_not_supported' });
    await run({}, { env: env({ FFMPEG_PATH: 'C:\\tools\\ffmpeg.exe' }), findFfmpeg: finder(false) });
    expect(ffmpegAsked).toEqual(['C:\\tools\\ffmpeg.exe']);
    expect(lines).toEqual([
      'To transcribe: 0 voice notes or audio files saved before Phase 2b.',
      `2 need ${NEEDS_FFMPEG}`,
      'Nothing was changed.',
    ]);
    lines = [];
    await run({}, { findFfmpeg: finder(true) });
    expect(lines.slice(0, 2)).toEqual([
      'To transcribe: 2 voice notes or audio files saved before Phase 2b, about 2 minutes.',
      costLine('0.02', '0.12'),
    ]);
    expect(output()).not.toContain('ffmpeg, skipped');

    // --yes without ffmpeg leaves both listed, untouched; with ffmpeg both are queued.
    await run({ yes: true }, { findFfmpeg: finder(false) });
    expect(statusOf(ogg)).toMatchObject({ status: 'done', note: null, backlog: false });
    expect(statusOf(m4a)).toMatchObject({ status: 'done', note: 'format_not_supported', backlog: false });
    await run({ yes: true }, { findFfmpeg: finder(true) });
    expect(statusOf(ogg)).toMatchObject({ status: 'pending', note: null, backlog: true });
    expect(statusOf(m4a)).toMatchObject({ status: 'pending', note: null, backlog: true });
  });

  it.each(['sarvam', 'elevenlabs', 'openai'])('%s: without ffmpeg every file needs it, whatever its format', async (provider) => {
    backlogVoice();
    backlogVoice({ mimeType: 'audio/mpeg' });
    backlogVoice({ mimeType: 'audio/aac' });
    await run({}, { env: env({ STT_PROVIDER: provider }), findFfmpeg: finder(false) });
    expect(lines.slice(0, 2)).toEqual([
      'To transcribe: 0 voice notes or audio files saved before Phase 2b.',
      `3 need ${NEEDS_FFMPEG}`,
    ]);
  });

  it('looks for ffmpeg once per run when a file is waiting, a large one too, and not when none is', async () => {
    await run();
    expect(ffmpegAsked).toEqual([]);
    backlogVoice({ fileSize: 5_000_000 });
    backlogVoice();
    await run();
    expect(ffmpegAsked).toEqual([undefined]);
  });

  it('an ffmpeg finder that throws counts as no ffmpeg', async () => {
    backlogVoice({ mimeType: 'audio/aac' });
    await run({}, { findFfmpeg: async () => { throw new Error('spawn failed'); } });
    expect(lines[1]).toBe(`1 needs ${NEEDS_FFMPEG}`);
  });
});

describe('transcribe-voice --client', () => {
  it('limits the count to that client, by code in any case', async () => {
    backlogVoice({ fileSize: 90_000 });
    backlogVoice({ fileSize: 90_000 });
    const mehta = backlogVoice({ fileSize: 90_000, clientId: 2 });
    await run({ client: 'meh' });
    expect(lines[0]).toBe('To transcribe: 1 voice note or audio file saved before Phase 2b, about 1 minute.');
    await run({ client: 'MEH', yes: true });
    expect(db.prepare("SELECT id FROM media WHERE status = 'pending'").all()).toEqual([{ id: mehta }]);
  });

  it('a code with spaces around it works', async () => {
    const a = backlogVoice({ fileSize: 90_000 });
    const b = backlogVoice({ fileSize: 90_000 });
    backlogVoice({ fileSize: 90_000, clientId: 2 });
    await run({ client: ' sha ' });
    expect(lines[0]).toBe('To transcribe: 2 voice notes or audio files saved before Phase 2b, about 2 minutes.');
    await run({ client: ' sha ', yes: true });
    expect(db.prepare("SELECT id FROM media WHERE status = 'pending' ORDER BY id").all()).toEqual([{ id: a }, { id: b }]);
  });

  it('refuses an unknown code by name, and a client no longer on the allow-list', async () => {
    backlogVoice();
    await expect(run({ client: 'XYZ' })).rejects.toThrow(new CorrectionError('No client with code XYZ'));
    syncClients(db, [SHARMA]);
    await expect(run({ client: 'MEH', yes: true })).rejects.toThrow(new CorrectionError('Client MEH is not in the allow-list'));
    expect(lines).toEqual([]);
  });
});

describe('transcribe-voice --yes', () => {
  it('queues exactly the sendable files, a large one too, as backlog; their transcripts never queue a message again (V6)', async () => {
    const a = backlogVoice({ fileSize: 90_000 });
    const b = backlogVoice({ fileSize: 90_000, clientId: 2, kind: 'audio', mimeType: 'audio/mpeg' });
    const large = backlogVoice({ fileSize: 900_001 }); // a bound of 601 s: not refused by its size
    const amr = backlogVoice({ mimeType: 'audio/amr' }); // converted like the others, ffmpeg being there
    await run({ yes: true });
    expect(lines).toEqual([
      'To transcribe: 4 voice notes or audio files saved before Phase 2b, about 14 minutes.',
      costLine('0.08', '0.23'), // 60 + 60 + 601 + 60 = 781 s: $0.074; 4 x 605 s: $0.229
      '4 queued. The running service now transcribes them, for the record. This costs money and counts toward the daily spend cap ($15.00).',
    ]);
    const queued = { status: 'pending', backlog: true, note: null, text: null, attempts: 0, createdAt: QUEUED_AT };
    expect(statusOf(a)).toEqual(queued);
    expect(statusOf(b)).toEqual(queued);
    expect(statusOf(large)).toEqual(queued);
    expect(statusOf(amr)).toEqual(queued);

    // A fake extractor finishes them: the transcripts are stored and no message is queued or flagged again.
    for (const id of [a, b, large, amr]) finishMedia(db, id, { textKind: 'extract', text: TRANSCRIPT, pageCount: null, note: null, at: LATER });
    expect(listUnprocessed(db, 1)).toEqual([]);
    expect(listUnprocessed(db, 2)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE processed_at IS NULL').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM media WHERE requeued_for_text = 1').get()).toEqual({ n: 0 });
    // Once transcribed, nothing is left to queue.
    lines = [];
    await run({ yes: true });
    expect(lines).toEqual(['No saved voice notes or audio files are waiting for a transcript. Nothing changed.']);
  });

  it.each([
    ['gets a note', (id: number) => void db.prepare("UPDATE media SET note = 'too_long' WHERE id = ?").run(id)],
    ['has its message deleted for everyone', (id: number) =>
      void db.prepare('UPDATE messages SET revoked = 1 WHERE id = (SELECT message_id FROM media WHERE id = ?)').run(id)],
  ])('a counted file that %s before it is queued is left alone and said so', async (_what, change) => {
    const a = backlogVoice({ fileSize: 90_000 });
    const b = backlogVoice({ fileSize: 90_000 });
    const aac = backlogVoice({ fileSize: 90_000, mimeType: 'audio/aac' }); // every file needs ffmpeg, so the finder is asked
    // The finder runs after the files are listed and counted, before they are queued.
    const findFfmpeg = async (): Promise<string | null> => {
      change(b);
      return 'ffmpeg';
    };
    await run({ yes: true }, { findFfmpeg });
    expect(lines).toEqual([
      'To transcribe: 3 voice notes or audio files saved before Phase 2b, about 3 minutes.',
      costLine('0.02', '0.18'), // 180 s: $0.017; 3 x 605 s: $0.172
      '2 queued. The running service now transcribes them, for the record. This costs money and counts toward the daily spend cap ($15.00).',
      '1 changed since they were counted and were left alone.',
    ]);
    expect(statusOf(a)).toMatchObject({ status: 'pending', backlog: true });
    expect(statusOf(aac)).toMatchObject({ status: 'pending', backlog: true });
    expect(statusOf(b)).toMatchObject({ status: 'done', backlog: false });
  });

  it('leaves rows with a note or text untouched', async () => {
    const tooLong = backlogVoice({ note: 'too_long' });
    const forwarded = backlogVoice({ note: 'forwarded_not_transcribed' });
    const transcribed = backlogVoice({ text: TRANSCRIPT });
    const before = [tooLong, forwarded, transcribed].map((id) => db.prepare('SELECT * FROM media WHERE id = ?').get(id));
    const fresh = backlogVoice();
    await run({ yes: true });
    expect([tooLong, forwarded, transcribed].map((id) => db.prepare('SELECT * FROM media WHERE id = ?').get(id))).toEqual(before);
    expect(statusOf(fresh).status).toBe('pending');
  });

  it('never prints a file name, a transcript or the key', async () => {
    backlogVoice({ text: TRANSCRIPT });
    backlogVoice({ fileSize: 90_000 });
    backlogVoice({ fileSize: 900_001 });
    backlogVoice({ mimeType: 'audio/aac' });
    await run();
    await run({ yes: true });
    await run({ client: 'SHA' });
    const all = output();
    for (const secret of [FILE_NAME, 'Secret', TRANSCRIPT, 'Payment', KEY, '.ogg', 'media/SHA']) expect(all).not.toContain(secret);
  });
});
