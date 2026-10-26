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

function deps(over: Partial<TranscribeVoiceDeps> = {}): TranscribeVoiceDeps {
  return { env: env(), out: (l) => void lines.push(l), db, clock: manualClock(QUEUED_AT), findFfmpeg: finder(false), ...over };
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
    // 900,000 bytes bound 600 s (the cap itself is allowed), 450,000 bytes 300 s; each plus the 5 s tolerance:
    // 1,515 s, about 26 minutes.
    backlogVoice({ fileSize: 900_000 });
    backlogVoice({ fileSize: 900_000, kind: 'audio', mimeType: 'audio/mpeg' });
    backlogVoice({ fileSize: 450_000, clientId: 2 });
    const before = allMedia();
    await run();
    const about = 2 * voiceCeilingUsd('sarvam', 605, 88) + voiceCeilingUsd('sarvam', 305, 88); // about $0.143
    expect(about).toBeCloseTo(0.1435, 4);
    expect(3 * voiceCeilingUsd('sarvam', 605, 88)).toBeCloseTo(0.1719, 4);
    expect(lines).toEqual([
      'To transcribe: 3 voice notes or audio files saved before Phase 2b, about 26 minutes.',
      costLine('0.15', '0.18'),
      'With --yes the running service transcribes them, for the record. This costs money and counts toward the daily spend cap ($15.00).',
      'Nothing was changed. Re-run with --yes to queue them.',
    ]);
    expect(allMedia()).toEqual(before);
  });

  it('counts the minutes up to a whole minute and the cost up to a whole cent', async () => {
    backlogVoice({ fileSize: 15_000 }); // 10 s, 15 s with the tolerance: $0.0009; 605 s at the limit: $0.037
    await run({}, { env: env({ STT_PROVIDER: 'elevenlabs' }) });
    expect(lines.slice(0, 2)).toEqual([
      'To transcribe: 1 voice note or audio file saved before Phase 2b, about 1 minute.',
      costLine('0.01', '0.04', 'elevenlabs'),
    ]);
  });

  it('pins both cost figures: the file sizes plus the tolerance, and every file at STT_MAX_SECONDS plus the tolerance', async () => {
    // STT_MAX_SECONDS 900. Bounds 10 s, 100 s and 900 s (the cap): 15 + 105 + 905 = 1,025 s, about 18 minutes.
    backlogVoice({ fileSize: 15_000 });
    backlogVoice({ fileSize: 150_000, clientId: 2 });
    backlogVoice({ fileSize: 1_350_000, kind: 'audio', mimeType: 'audio/mpeg' });
    backlogVoice({ fileSize: 1_350_001 }); // 901 s: too long, in neither figure
    backlogVoice({ mimeType: 'audio/aac' }); // needs ffmpeg, which is missing: in neither figure
    await run({}, { env: env({ STT_MAX_SECONDS: '900' }) });
    // Sarvam: ₹30 an hour at ₹88 to the dollar.
    const about = [10, 100, 900].reduce((a, s) => a + voiceCeilingUsd('sarvam', s + VOICE_LENGTH_TOLERANCE_S, 88), 0);
    const most = 3 * voiceCeilingUsd('sarvam', 900 + VOICE_LENGTH_TOLERANCE_S, 88);
    expect(about).toBeCloseTo((1025 * 30) / 3600 / 88, 9); // $0.0971
    expect(most).toBeCloseTo((3 * 905 * 30) / 3600 / 88, 9); // $0.2571
    expect(lines).toEqual([
      'To transcribe: 3 voice notes or audio files saved before Phase 2b, about 18 minutes.',
      costLine('0.10', '0.26', 'sarvam', 900),
      '1 too long, skipped (by file size, over STT_MAX_SECONDS: 900 seconds).',
      `1 needs ${NEEDS_FFMPEG}`,
      'With --yes the running service transcribes them, for the record. This costs money and counts toward the daily spend cap ($15.00).',
      'Nothing was changed. Re-run with --yes to queue them.',
    ]);
  });

  it('a file with no size is counted as too long and never queued', async () => {
    const id = backlogVoice();
    db.prepare('UPDATE media SET file_size = NULL WHERE id = ?').run(id);
    await run({ yes: true });
    expect(lines).toEqual([
      'To transcribe: 0 voice notes or audio files saved before Phase 2b.',
      '1 too long, skipped (by file size, over STT_MAX_SECONDS: 600 seconds).',
      'Nothing was changed.',
    ]);
    expect(statusOf(id)).toMatchObject({ status: 'done', backlog: false });
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

  it('a file whose size implies more than STT_MAX_SECONDS is counted as too long, skipped, and not in the minutes or cost (N4)', async () => {
    backlogVoice({ fileSize: 900_000 }); // 600 s: allowed
    const long = backlogVoice({ fileSize: 900_001 }); // 601 s
    await run();
    expect(lines.slice(0, 3)).toEqual([
      'To transcribe: 1 voice note or audio file saved before Phase 2b, about 11 minutes.',
      costLine('0.06', '0.06'), // 605 s both ways: $0.057
      '1 too long, skipped (by file size, over STT_MAX_SECONDS: 600 seconds).',
    ]);
    // A lower cap makes both too long.
    lines = [];
    await run({}, { env: env({ STT_MAX_SECONDS: '300' }) });
    expect(lines).toEqual([
      'To transcribe: 0 voice notes or audio files saved before Phase 2b.',
      '2 too long, skipped (by file size, over STT_MAX_SECONDS: 300 seconds).',
      'Nothing was changed.',
    ]);
    await run({ yes: true }, { env: env({ STT_MAX_SECONDS: '300' }) });
    expect(statusOf(long).status).toBe('done');
  });

  it('a file the transcriber cannot send without ffmpeg is counted as needing ffmpeg; with ffmpeg the same file is counted (N2)', async () => {
    backlogVoice({ fileSize: 90_000 }); // Ogg: goes as it is to Sarvam
    const m4a = backlogVoice({ fileSize: 90_000, kind: 'audio', mimeType: 'audio/mp4', note: 'format_not_supported' });
    await run({}, { env: env({ FFMPEG_PATH: 'C:\\tools\\ffmpeg.exe' }), findFfmpeg: finder(false) });
    expect(ffmpegAsked).toEqual(['C:\\tools\\ffmpeg.exe']);
    expect(lines.slice(0, 3)).toEqual([
      'To transcribe: 1 voice note or audio file saved before Phase 2b, about 2 minutes.',
      costLine('0.01', '0.06'),
      `1 needs ${NEEDS_FFMPEG}`,
    ]);
    lines = [];
    await run({}, { findFfmpeg: finder(true) });
    expect(lines[0]).toBe('To transcribe: 2 voice notes or audio files saved before Phase 2b, about 3 minutes.');
    expect(output()).not.toContain('ffmpeg, skipped');

    // --yes without ffmpeg leaves it listed, untouched; with ffmpeg it is queued.
    await run({ yes: true }, { findFfmpeg: finder(false) });
    expect(statusOf(m4a)).toMatchObject({ status: 'done', note: 'format_not_supported', backlog: false });
    await run({ yes: true }, { findFfmpeg: finder(true) });
    expect(statusOf(m4a)).toMatchObject({ status: 'pending', note: null, backlog: true });
  });

  it('openai converts every file, so without ffmpeg every file needs it', async () => {
    backlogVoice();
    backlogVoice({ mimeType: 'audio/mpeg' });
    await run({}, { env: env({ STT_PROVIDER: 'openai' }) });
    expect(lines.slice(0, 2)).toEqual([
      'To transcribe: 0 voice notes or audio files saved before Phase 2b.',
      `2 need ${NEEDS_FFMPEG}`,
    ]);
  });

  it('does not look for ffmpeg when every file can go as it is', async () => {
    backlogVoice();
    await run();
    expect(ffmpegAsked).toEqual([]);
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
    expect(lines[0]).toBe('To transcribe: 1 voice note or audio file saved before Phase 2b, about 2 minutes.');
    await run({ client: 'MEH', yes: true });
    expect(db.prepare("SELECT id FROM media WHERE status = 'pending'").all()).toEqual([{ id: mehta }]);
  });

  it('a code with spaces around it works', async () => {
    const a = backlogVoice({ fileSize: 90_000 });
    const b = backlogVoice({ fileSize: 90_000 });
    backlogVoice({ fileSize: 90_000, clientId: 2 });
    await run({ client: ' sha ' });
    expect(lines[0]).toBe('To transcribe: 2 voice notes or audio files saved before Phase 2b, about 3 minutes.');
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
  it('queues exactly the sendable files that fit, as backlog; their transcripts never queue a message again (V6)', async () => {
    const a = backlogVoice({ fileSize: 90_000 });
    const b = backlogVoice({ fileSize: 90_000, clientId: 2, kind: 'audio', mimeType: 'audio/mpeg' });
    const long = backlogVoice({ fileSize: 900_001 });
    const needsFfmpeg = backlogVoice({ mimeType: 'audio/amr' });
    await run({ yes: true });
    expect(lines).toEqual([
      'To transcribe: 2 voice notes or audio files saved before Phase 2b, about 3 minutes.',
      costLine('0.02', '0.12'), // 130 s: $0.012; 2 x 605 s: $0.115
      '1 too long, skipped (by file size, over STT_MAX_SECONDS: 600 seconds).',
      `1 needs ${NEEDS_FFMPEG}`,
      '2 queued. The running service now transcribes them, for the record. This costs money and counts toward the daily spend cap ($15.00).',
    ]);
    const queued = { status: 'pending', backlog: true, note: null, text: null, attempts: 0, createdAt: QUEUED_AT };
    expect(statusOf(a)).toEqual(queued);
    expect(statusOf(b)).toEqual(queued);
    expect(statusOf(long)).toMatchObject({ status: 'done', backlog: false });
    expect(statusOf(needsFfmpeg)).toMatchObject({ status: 'done', backlog: false });

    // A fake extractor finishes them: the transcripts are stored and no message is queued or flagged again.
    for (const id of [a, b]) finishMedia(db, id, { textKind: 'extract', text: TRANSCRIPT, pageCount: null, note: null, at: LATER });
    expect(listUnprocessed(db, 1)).toEqual([]);
    expect(listUnprocessed(db, 2)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE processed_at IS NULL').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM media WHERE requeued_for_text = 1').get()).toEqual({ n: 0 });
    // Once transcribed, nothing is left to queue.
    lines = [];
    await run({ yes: true }, { findFfmpeg: finder(true) });
    expect(lines[0]).toBe('To transcribe: 1 voice note or audio file saved before Phase 2b, about 2 minutes.');
    expect(statusOf(needsFfmpeg)).toMatchObject({ status: 'pending', backlog: true });
  });

  it.each([
    ['gets a note', (id: number) => void db.prepare("UPDATE media SET note = 'too_long' WHERE id = ?").run(id)],
    ['has its message deleted for everyone', (id: number) =>
      void db.prepare('UPDATE messages SET revoked = 1 WHERE id = (SELECT message_id FROM media WHERE id = ?)').run(id)],
  ])('a counted file that %s before it is queued is left alone and said so', async (_what, change) => {
    const a = backlogVoice({ fileSize: 90_000 });
    const b = backlogVoice({ fileSize: 90_000 });
    const aac = backlogVoice({ fileSize: 90_000, mimeType: 'audio/aac' }); // needs ffmpeg, so the finder is asked
    // The finder runs after the files are listed and counted, before they are queued.
    const findFfmpeg = async (): Promise<string | null> => {
      change(b);
      return 'ffmpeg';
    };
    await run({ yes: true }, { findFfmpeg });
    expect(lines).toEqual([
      'To transcribe: 3 voice notes or audio files saved before Phase 2b, about 4 minutes.',
      costLine('0.02', '0.18'), // 195 s: $0.018; 3 x 605 s: $0.172
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
