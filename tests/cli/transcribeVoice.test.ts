import { beforeEach, describe, expect, it } from 'vitest';
import { CorrectionError } from '../../src/cli/corrections.ts';
import { transcribeVoiceCommand, type TranscribeVoiceDeps } from '../../src/cli/transcribeVoice.ts';
import { parseEnv } from '../../src/config/env.ts';
import { syncClients } from '../../src/store/clients.ts';
import type { Db } from '../../src/store/db.ts';
import { claimMedia, failMedia, finishMedia, getMedia, insertMedia, markDownloaded, messageRowId, type MediaKind, type NewMedia } from '../../src/store/media.ts';
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

beforeEach(async () => {
  db = await seededDb();
  lines = [];
  ffmpegAsked = [];
});

/** Sarvam for meetings and voice notes, unless a test says otherwise. Voice notes follow VOICE_STT_PROVIDER (amendment L2). */
function env(over: Record<string, string> = {}) {
  return parseEnv({ STT_PROVIDER: 'sarvam', VOICE_STT_PROVIDER: 'sarvam', STT_API_KEY: KEY, INR_PER_USD: '88', STT_MAX_SECONDS: '600', ...over });
}
/** The local engine for voice notes: no key, no paid provider (Phase 2b amendment L2). */
const localEnv = (over: Record<string, string> = {}) =>
  parseEnv({ VOICE_STT_PROVIDER: 'local', STT_LOCAL_BIN: '/opt/stt/transcribe-cli', STT_LOCAL_MODEL: '/opt/stt/voxtral.gguf', STT_MAX_SECONDS: '600', ...over });

/** A fake ffmpeg finder: present (its path) or absent (null); records what it was asked. */
const finder = (found: boolean) => async (configured: string | undefined): Promise<string | null> => {
  ffmpegAsked.push(configured);
  return found ? (configured ?? 'ffmpeg') : null;
};

/**
 * ffmpeg is there unless a test says otherwise: every file needs it (Task 5 review round 1). The local engine's files
 * are there too (the paths in localEnv are not real files); the tests of that check pass their own.
 */
function deps(over: Partial<TranscribeVoiceDeps> = {}): TranscribeVoiceDeps {
  return { env: env(), out: (l) => void lines.push(l), db, clock: manualClock(QUEUED_AT), findFfmpeg: finder(true), checkLocalEngine: () => null, ...over };
}

const run = (opts: { client?: string; yes?: boolean; failed?: boolean } = {}, over: Partial<TranscribeVoiceDeps> = {}) =>
  transcribeVoiceCommand({ ...opts, yes: opts.yes === true, failed: opts.failed === true }, deps(over));

let seq = 0;
/** A 2a voice note: saved on disk, finished without a transcript, its message processed. */
async function backlogVoice(o: { clientId?: number; kind?: MediaKind; fileSize?: number; mimeType?: string | null; note?: string | null; text?: string } = {}): Promise<number> {
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
  await markDownloaded(db, id, { localPath: `media/SHA/2026-10/${waId}-${id}.ogg`, sha256: 'x', fileSize: o.fileSize ?? 90_000, at: NOW });
  await claimMedia(db, id, { nextAttemptAt: LATER, at: NOW });
  await finishMedia(db, id, {
    textKind: o.text === undefined ? null : 'extract', text: o.text ?? null, pageCount: null, note: o.note ?? null, at: NOW,
  });
  markProcessed(db, [messageId], NOW);
  return id;
}

/** A saved voice note that failed with errorCode after its tries (its message processed: the tracker went ahead). */
async function failedVoice(errorCode: string, o: { clientId?: number; kind?: MediaKind; fileSize?: number } = {}): Promise<number> {
  const clientId = o.clientId ?? 1;
  const kind = o.kind ?? 'voice';
  const waId = `F${++seq}`;
  insertMessage(db, {
    waId, clientId, senderJid: '919800000001@s.whatsapp.net', senderNumber: '919800000001', senderName: 'Mr. Sharma', fromMe: false,
    ts: '2026-10-25T08:00:00.000Z', text: null, quotedWaId: null, mediaType: kind,
  });
  const messageId = messageRowId(db, clientId, waId)!;
  const id = insertMedia(db, {
    messageId, clientId, kind, status: 'pending', mimeType: OGG, fileName: FILE_NAME, fileSize: 1000, seconds: 5, forwarded: false,
    refEnc: Buffer.from('sealed'), errorCode: null, createdAt: NOW,
  });
  await markDownloaded(db, id, { localPath: `media/SHA/2026-10/${waId}-${id}.ogg`, sha256: 'x', fileSize: o.fileSize ?? 90_000, at: NOW });
  await claimMedia(db, id, { nextAttemptAt: LATER, at: NOW });
  await failMedia(db, id, { status: 'failed', errorCode, at: NOW });
  markProcessed(db, [messageId], NOW);
  return id;
}

const statusOf = async (id: number) => {
  const m = (await getMedia(db, id))!;
  return { status: m.status, backlog: m.backlog, note: m.note, text: m.text, attempts: m.attempts, createdAt: m.createdAt };
};
const allMedia = () => db.raw.prepare('SELECT * FROM media ORDER BY id').all();
const output = () => lines.join('\n');
const NEEDS_FFMPEG = 'ffmpeg, skipped (install ffmpeg, or set FFMPEG_PATH; after installing ffmpeg, restart the service, then run this again).';
/** The cost line, in the command's words. */
const costLine = (about: string, most: string, provider = 'sarvam', maxSeconds = 600) =>
  `Cost: about $${about} from the file sizes (speech, ${provider} list price); at most $${most} if every file runs to the STT_MAX_SECONDS limit (${maxSeconds} seconds).`;

describe('transcribe-voice: speech-to-text off', () => {
  const OFF = 'Speech-to-text for voice notes is not set up (VOICE_STT_PROVIDER is none). Nothing changed.';

  it('says so and changes nothing', async () => {
    const id = await backlogVoice();
    const before = allMedia();
    await run({}, { env: parseEnv({}) });
    expect(lines).toEqual([OFF]);
    expect(allMedia()).toEqual(before);
    await run({ yes: true }, { env: parseEnv({}) });
    expect((await statusOf(id)).status).toBe('done');
    expect(ffmpegAsked).toEqual([]);
  });

  // Phase 2b amendment L2: STT_PROVIDER is the meetings' setting; VOICE_STT_PROVIDER decides voice notes.
  it('is off when VOICE_STT_PROVIDER is none, even with a paid STT_PROVIDER and its key', async () => {
    const id = await backlogVoice();
    await run({ yes: true }, { env: env({ VOICE_STT_PROVIDER: 'none' }) });
    expect(lines).toEqual([OFF]);
    expect((await statusOf(id)).status).toBe('done');
  });
});

// Phase 2b amendment L2: the local engine costs nothing, but every file still needs ffmpeg.
describe('transcribe-voice: the local engine', () => {
  const LOCAL_COST = 'Cost: $0 (local engine on this computer).';
  const FREE = 'It costs nothing and does not count toward the daily spend cap.';

  it('the dry run counts the files and the minutes, and says the cost is $0, with no key and no paid provider', async () => {
    await backlogVoice({ fileSize: 900_000 });
    await backlogVoice({ fileSize: 450_000, clientId: 2 });
    const before = allMedia();
    await run({}, { env: localEnv() });
    expect(lines).toEqual([
      'To transcribe: 2 voice notes or audio files saved before Phase 2b, about 15 minutes.',
      LOCAL_COST,
      `With --yes the running service transcribes them, for the record. ${FREE}`,
      'Nothing was changed. Re-run with --yes to queue them.',
    ]);
    expect(output()).not.toContain('list price');
    expect(output()).not.toContain('spend cap ($');
    expect(allMedia()).toEqual(before);
  });

  it('--yes queues them, saying the cost is $0', async () => {
    const a = await backlogVoice({ fileSize: 90_000 });
    const b = await backlogVoice({ fileSize: 90_000, kind: 'audio', mimeType: 'audio/mpeg' });
    await run({ yes: true }, { env: localEnv() });
    expect(lines).toEqual([
      'To transcribe: 2 voice notes or audio files saved before Phase 2b, about 2 minutes.',
      LOCAL_COST,
      `2 queued. The running service now transcribes them, for the record. ${FREE}`,
    ]);
    expect(await statusOf(a)).toMatchObject({ status: 'pending', backlog: true });
    expect(await statusOf(b)).toMatchObject({ status: 'pending', backlog: true });
  });

  it('without ffmpeg every file is skipped as needing it, and nothing is queued', async () => {
    const id = await backlogVoice();
    await run({ yes: true }, { env: localEnv({ FFMPEG_PATH: '/opt/ffmpeg' }), findFfmpeg: finder(false) });
    expect(ffmpegAsked).toEqual(['/opt/ffmpeg']);
    expect(lines).toEqual([
      'To transcribe: 0 voice notes or audio files saved before Phase 2b.',
      `1 needs ${NEEDS_FFMPEG}`,
      'Nothing was changed.',
    ]);
    expect(await statusOf(id)).toMatchObject({ status: 'done', backlog: false });
  });

  it('never prints a file name, a transcript or a setting value', async () => {
    await backlogVoice({ text: TRANSCRIPT });
    await backlogVoice({ fileSize: 90_000 });
    await run({}, { env: localEnv() });
    await run({ yes: true }, { env: localEnv() });
    for (const secret of [FILE_NAME, TRANSCRIPT, '/opt/stt', 'voxtral.gguf', '.ogg', 'media/SHA']) expect(output()).not.toContain(secret);
  });
});

describe('transcribe-voice: the dry run', () => {
  it('prints the count, the minutes and the two cost figures, and changes nothing', async () => {
    // 900,000 bytes bound 600 s, 450,000 bytes 300 s; each estimated at its bound (under STT_MAX_SECONDS + 5 s):
    // 1,500 s, about 25 minutes.
    await backlogVoice({ fileSize: 900_000 });
    await backlogVoice({ fileSize: 900_000, kind: 'audio', mimeType: 'audio/mpeg' });
    await backlogVoice({ fileSize: 450_000, clientId: 2 });
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
    await backlogVoice({ fileSize: 15_000 }); // 10 s: $0.0006; 605 s at the limit: $0.037
    await run({}, { env: env({ STT_PROVIDER: 'elevenlabs', VOICE_STT_PROVIDER: 'elevenlabs' }) });
    expect(lines.slice(0, 2)).toEqual([
      'To transcribe: 1 voice note or audio file saved before Phase 2b, about 1 minute.',
      costLine('0.01', '0.04', 'elevenlabs'),
    ]);
  });

  it('pins both cost figures: each file at min(size bound, STT_MAX_SECONDS + tolerance), and every file at that limit', async () => {
    // STT_MAX_SECONDS 900. Bounds 10 s, 100 s, 900 s (the cap) and 3,334 s (5 MB, a high bitrate), the last estimated at
    // the 905 s limit: 10 + 100 + 900 + 905 = 1,915 s, about 32 minutes.
    await backlogVoice({ fileSize: 15_000 });
    await backlogVoice({ fileSize: 150_000, clientId: 2 });
    await backlogVoice({ fileSize: 1_350_000, kind: 'audio', mimeType: 'audio/mpeg' });
    await backlogVoice({ fileSize: 5_000_000 });
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
    const id = await backlogVoice();
    db.raw.prepare('UPDATE media SET file_size = NULL WHERE id = ?').run(id);
    await run({ yes: true });
    expect(lines).toEqual([
      'To transcribe: 1 voice note or audio file saved before Phase 2b, about 11 minutes.',
      costLine('0.06', '0.06'), // 605 s both ways: $0.057
      '1 queued. The running service now transcribes them, for the record. This costs money and counts toward the daily spend cap ($15.00).',
    ]);
    expect(await statusOf(id)).toMatchObject({ status: 'pending', backlog: true });
  });

  it('says when there is nothing to transcribe', async () => {
    await backlogVoice({ note: 'too_long' });
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
    const fits = await backlogVoice({ fileSize: 900_000 }); // 600 s
    const large = await backlogVoice({ fileSize: 960_000, kind: 'audio', mimeType: 'audio/mpeg' }); // 640 s: estimated at 605 s
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
    expect(await statusOf(fits)).toMatchObject({ status: 'pending', backlog: true });
    expect(await statusOf(large)).toMatchObject({ status: 'pending', backlog: true });
  });

  // Task 5 review round 1: every file is converted first, so every file needs ffmpeg, a WhatsApp voice note too.
  it('without ffmpeg every file is counted as needing it, a voice note too; with ffmpeg the same files are counted (N2)', async () => {
    const ogg = await backlogVoice({ fileSize: 90_000 });
    const m4a = await backlogVoice({ fileSize: 90_000, kind: 'audio', mimeType: 'audio/mp4', note: 'format_not_supported' });
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
    expect(await statusOf(ogg)).toMatchObject({ status: 'done', note: null, backlog: false });
    expect(await statusOf(m4a)).toMatchObject({ status: 'done', note: 'format_not_supported', backlog: false });
    await run({ yes: true }, { findFfmpeg: finder(true) });
    expect(await statusOf(ogg)).toMatchObject({ status: 'pending', note: null, backlog: true });
    expect(await statusOf(m4a)).toMatchObject({ status: 'pending', note: null, backlog: true });
  });

  it.each(['sarvam', 'elevenlabs', 'openai'])('%s: without ffmpeg every file needs it, whatever its format', async (provider) => {
    await backlogVoice();
    await backlogVoice({ mimeType: 'audio/mpeg' });
    await backlogVoice({ mimeType: 'audio/aac' });
    await run({}, { env: env({ STT_PROVIDER: provider, VOICE_STT_PROVIDER: provider }), findFfmpeg: finder(false) });
    expect(lines.slice(0, 2)).toEqual([
      'To transcribe: 0 voice notes or audio files saved before Phase 2b.',
      `3 need ${NEEDS_FFMPEG}`,
    ]);
  });

  it('looks for ffmpeg once per run when a file is waiting, a large one too, and not when none is', async () => {
    await run();
    expect(ffmpegAsked).toEqual([]);
    await backlogVoice({ fileSize: 5_000_000 });
    await backlogVoice();
    await run();
    expect(ffmpegAsked).toEqual([undefined]);
  });

  it('an ffmpeg finder that throws counts as no ffmpeg', async () => {
    await backlogVoice({ mimeType: 'audio/aac' });
    await run({}, { findFfmpeg: async () => { throw new Error('spawn failed'); } });
    expect(lines[1]).toBe(`1 needs ${NEEDS_FFMPEG}`);
  });
});

describe('transcribe-voice --client', () => {
  it('limits the count to that client, by code in any case', async () => {
    await backlogVoice({ fileSize: 90_000 });
    await backlogVoice({ fileSize: 90_000 });
    const mehta = await backlogVoice({ fileSize: 90_000, clientId: 2 });
    await run({ client: 'meh' });
    expect(lines[0]).toBe('To transcribe: 1 voice note or audio file saved before Phase 2b, about 1 minute.');
    await run({ client: 'MEH', yes: true });
    expect(db.raw.prepare("SELECT id FROM media WHERE status = 'pending'").all()).toEqual([{ id: mehta }]);
  });

  it('a code with spaces around it works', async () => {
    const a = await backlogVoice({ fileSize: 90_000 });
    const b = await backlogVoice({ fileSize: 90_000 });
    await backlogVoice({ fileSize: 90_000, clientId: 2 });
    await run({ client: ' sha ' });
    expect(lines[0]).toBe('To transcribe: 2 voice notes or audio files saved before Phase 2b, about 2 minutes.');
    await run({ client: ' sha ', yes: true });
    expect(db.raw.prepare("SELECT id FROM media WHERE status = 'pending' ORDER BY id").all()).toEqual([{ id: a }, { id: b }]);
  });

  it('refuses an unknown code by name, and a client no longer on the allow-list', async () => {
    await backlogVoice();
    await expect(run({ client: 'XYZ' })).rejects.toThrow(new CorrectionError('No client with code XYZ'));
    syncClients(db, [SHARMA]);
    await expect(run({ client: 'MEH', yes: true })).rejects.toThrow(new CorrectionError('Client MEH is not in the allow-list'));
    expect(lines).toEqual([]);
  });
});

describe('transcribe-voice --yes', () => {
  it('queues exactly the sendable files, a large one too, as backlog; their transcripts never queue a message again (V6)', async () => {
    const a = await backlogVoice({ fileSize: 90_000 });
    const b = await backlogVoice({ fileSize: 90_000, clientId: 2, kind: 'audio', mimeType: 'audio/mpeg' });
    const large = await backlogVoice({ fileSize: 900_001 }); // a bound of 601 s: not refused by its size
    const amr = await backlogVoice({ mimeType: 'audio/amr' }); // converted like the others, ffmpeg being there
    await run({ yes: true });
    expect(lines).toEqual([
      'To transcribe: 4 voice notes or audio files saved before Phase 2b, about 14 minutes.',
      costLine('0.08', '0.23'), // 60 + 60 + 601 + 60 = 781 s: $0.074; 4 x 605 s: $0.229
      '4 queued. The running service now transcribes them, for the record. This costs money and counts toward the daily spend cap ($15.00).',
    ]);
    const queued = { status: 'pending', backlog: true, note: null, text: null, attempts: 0, createdAt: QUEUED_AT };
    expect(await statusOf(a)).toEqual(queued);
    expect(await statusOf(b)).toEqual(queued);
    expect(await statusOf(large)).toEqual(queued);
    expect(await statusOf(amr)).toEqual(queued);

    // A fake extractor finishes them: the transcripts are stored and no message is queued or flagged again.
    for (const id of [a, b, large, amr]) await finishMedia(db, id, { textKind: 'extract', text: TRANSCRIPT, pageCount: null, note: null, at: LATER });
    expect(listUnprocessed(db, 1)).toEqual([]);
    expect(listUnprocessed(db, 2)).toEqual([]);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM messages WHERE processed_at IS NULL').get()).toEqual({ n: 0 });
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM media WHERE requeued_for_text = 1').get()).toEqual({ n: 0 });
    // Once transcribed, nothing is left to queue.
    lines = [];
    await run({ yes: true });
    expect(lines).toEqual(['No saved voice notes or audio files are waiting for a transcript. Nothing changed.']);
  });

  it.each([
    ['gets a note', (id: number) => void db.raw.prepare("UPDATE media SET note = 'too_long' WHERE id = ?").run(id)],
    ['has its message deleted for everyone', (id: number) =>
      void db.raw.prepare('UPDATE messages SET revoked = 1 WHERE id = (SELECT message_id FROM media WHERE id = ?)').run(id)],
  ])('a counted file that %s before it is queued is left alone and said so', async (_what, change) => {
    const a = await backlogVoice({ fileSize: 90_000 });
    const b = await backlogVoice({ fileSize: 90_000 });
    const aac = await backlogVoice({ fileSize: 90_000, mimeType: 'audio/aac' }); // every file needs ffmpeg, so the finder is asked
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
    expect(await statusOf(a)).toMatchObject({ status: 'pending', backlog: true });
    expect(await statusOf(aac)).toMatchObject({ status: 'pending', backlog: true });
    expect(await statusOf(b)).toMatchObject({ status: 'done', backlog: false });
  });

  it('leaves rows with a note or text untouched', async () => {
    const tooLong = await backlogVoice({ note: 'too_long' });
    const forwarded = await backlogVoice({ note: 'forwarded_not_transcribed' });
    const transcribed = await backlogVoice({ text: TRANSCRIPT });
    const before = [tooLong, forwarded, transcribed].map((id) => db.raw.prepare('SELECT * FROM media WHERE id = ?').get(id));
    const fresh = await backlogVoice();
    await run({ yes: true });
    expect([tooLong, forwarded, transcribed].map((id) => db.raw.prepare('SELECT * FROM media WHERE id = ?').get(id))).toEqual(before);
    expect((await statusOf(fresh)).status).toBe('pending');
  });

  it('never prints a file name, a transcript or the key', async () => {
    await backlogVoice({ text: TRANSCRIPT });
    await backlogVoice({ fileSize: 90_000 });
    await backlogVoice({ fileSize: 900_001 });
    await backlogVoice({ mimeType: 'audio/aac' });
    await run();
    await run({ yes: true });
    await run({ client: 'SHA' });
    const all = output();
    for (const secret of [FILE_NAME, 'Secret', TRANSCRIPT, 'Payment', KEY, '.ogg', 'media/SHA']) expect(all).not.toContain(secret);
  });
});

// Phase 2b final review: with the local engine, the command checks the engine's files first, as the service does when
// it starts, so it never queues notes that would only finish "not transcribed" again.
describe('transcribe-voice: the local engine not set up', () => {
  const notSetUp = (name: string) =>
    `The local speech engine is not set up (${name}). Fix ${name} in .env (docs/SETUP-mac.md, section 8), restart the service, then run this again. Nothing changed.`;

  it.each([['STT_LOCAL_BIN'], ['STT_LOCAL_MODEL']] as const)('refuses the dry run and --yes when %s is not a file, naming the setting only', async (name) => {
    const id = await backlogVoice();
    const failed = await failedVoice('local_timeout');
    const before = allMedia();
    for (const opts of [{}, { yes: true }, { failed: true }, { failed: true, yes: true }]) {
      await run(opts, { env: localEnv(), checkLocalEngine: () => name });
    }
    expect(lines).toEqual([notSetUp(name), notSetUp(name), notSetUp(name), notSetUp(name)]);
    expect(allMedia()).toEqual(before);
    expect((await statusOf(id)).status).toBe('done');
    expect((await statusOf(failed)).status).toBe('failed');
    expect(ffmpegAsked).toEqual([]);
  });

  it('with the real check, the example paths (not files on this computer) are refused, and no path is printed', async () => {
    await backlogVoice();
    const { checkLocalEngine: _seam, ...rest } = deps({ env: localEnv() });
    await transcribeVoiceCommand({ yes: true, failed: false }, rest);
    expect(lines).toEqual([notSetUp('STT_LOCAL_BIN')]);
    for (const secret of ['/opt/stt', 'transcribe-cli', 'voxtral.gguf']) expect(output()).not.toContain(secret);
  });

  it('a check that throws counts as STT_LOCAL_BIN not set up', async () => {
    await backlogVoice();
    const throws = (): never => {
      throw new Error('/opt/stt/transcribe-cli: EACCES');
    };
    await run({ yes: true }, { env: localEnv(), checkLocalEngine: throws });
    expect(lines).toEqual([notSetUp('STT_LOCAL_BIN')]);
    expect(output()).not.toContain('/opt/stt');
  });

  it('is not asked for a paid provider', async () => {
    await backlogVoice({ fileSize: 90_000 });
    let asked = 0;
    const check = (): 'STT_LOCAL_BIN' => {
      asked++;
      return 'STT_LOCAL_BIN';
    };
    await run({}, { checkLocalEngine: check });
    expect(asked).toBe(0);
    expect(lines[0]).toBe('To transcribe: 1 voice note or audio file saved before Phase 2b, about 1 minute.');
  });
});

// Phase 2b final review: a backlog note queued, then finished while voice notes were off, is listed again.
describe('transcribe-voice: a queued note finished with no transcriber', () => {
  it('round trip: queued, finished with no transcriber, listed and queued again', async () => {
    const id = await backlogVoice({ fileSize: 90_000 });
    await run({ yes: true }, { env: localEnv() });
    expect(await statusOf(id)).toMatchObject({ status: 'pending', backlog: true });
    // The service ran with VOICE_STT_PROVIDER=none meanwhile: the note finished without a transcript, as in 2a.
    await finishMedia(db, id, { textKind: null, text: null, pageCount: null, note: null, at: LATER });
    lines = [];
    await run({}, { env: localEnv() });
    expect(lines[0]).toBe('To transcribe: 1 voice note or audio file saved before Phase 2b, about 1 minute.');
    lines = [];
    await run({ yes: true }, { env: localEnv(), clock: manualClock('2026-10-26T09:00:00.000Z') });
    expect(lines.at(-1)).toBe('1 queued. The running service now transcribes them, for the record. It costs nothing and does not count toward the daily spend cap.');
    expect(await statusOf(id)).toMatchObject({ status: 'pending', backlog: true, createdAt: '2026-10-26T09:00:00.000Z' });
  });
});

// Phase 2b final review: notes the local engine (or ffmpeg) could not transcribe after their tries can be tried again.
describe('transcribe-voice --failed', () => {
  const LOCAL_COST = 'Cost: $0 (local engine on this computer).';
  const FREE = 'It costs nothing and does not count toward the daily spend cap.';
  const NEEDS_LOCAL =
    'transcribe-voice --failed tries again notes the local engine could not transcribe: it works only with VOICE_STT_PROVIDER=local. Nothing changed.';
  const NONE_FAILED = 'No voice notes or audio files failed in the local engine. Nothing changed.';

  it('the dry run counts the failed notes and the minutes, says the cost is $0, and changes nothing', async () => {
    await failedVoice('local_empty_output', { fileSize: 900_000 });
    await failedVoice('audio_convert_failed', { fileSize: 450_000, clientId: 2, kind: 'audio' });
    await failedVoice('stt_partial'); // failed at a paid provider: never counted
    await backlogVoice(); // the backlog is another listing
    const before = allMedia();
    await run({ failed: true }, { env: localEnv() });
    expect(lines).toEqual([
      'To try again: 2 voice notes or audio files the local engine could not transcribe, about 15 minutes.',
      LOCAL_COST,
      `With --yes the running service tries them again (3 tries each). ${FREE}`,
      'Nothing was changed. Re-run with --yes to queue them again.',
    ]);
    expect(allMedia()).toEqual(before);
  });

  it('--yes queues them again: pending, attempts 0, no error, no note, created now, backlog by the same rule as the backlog', async () => {
    const a = await failedVoice('local_timeout');
    const b = await failedVoice('audio_no_duration', { kind: 'audio' });
    const unprocessed = await failedVoice('local_exit_1');
    db.raw.prepare('UPDATE messages SET processed_at = NULL WHERE id = ?').run((await getMedia(db, unprocessed))!.messageId);
    const paid = await failedVoice('stt_paid_unbooked');
    const backlog = await backlogVoice();
    await run({ failed: true, yes: true }, { env: localEnv() });
    expect(lines).toEqual([
      'To try again: 3 voice notes or audio files the local engine could not transcribe, about 3 minutes.',
      LOCAL_COST,
      `3 queued again. The running service now tries them again (3 tries each). ${FREE}`,
    ]);
    const fresh = { status: 'pending', note: null, text: null, attempts: 0, createdAt: QUEUED_AT };
    expect(await statusOf(a)).toEqual({ ...fresh, backlog: true });
    expect(await statusOf(b)).toEqual({ ...fresh, backlog: true });
    expect(await statusOf(unprocessed)).toEqual({ ...fresh, backlog: false });
    for (const id of [a, b, unprocessed]) expect(await getMedia(db, id)).toMatchObject({ errorCode: null, nextAttemptAt: null });
    expect(await getMedia(db, paid)).toMatchObject({ status: 'failed', errorCode: 'stt_paid_unbooked', attempts: 1 });
    expect(await statusOf(backlog)).toMatchObject({ status: 'done' }); // --failed queues only failed notes
    lines = [];
    await run({ failed: true, yes: true }, { env: localEnv() });
    expect(lines).toEqual([NONE_FAILED]);
  });

  it.each(['sarvam', 'elevenlabs', 'openai'])('is refused with VOICE_STT_PROVIDER=%s: those failures may have been paid', async (provider) => {
    const id = await failedVoice('local_timeout');
    const before = allMedia();
    await run({ failed: true, yes: true }, { env: env({ STT_PROVIDER: provider, VOICE_STT_PROVIDER: provider }) });
    expect(lines).toEqual([NEEDS_LOCAL]);
    expect(allMedia()).toEqual(before);
    expect((await statusOf(id)).status).toBe('failed');
    expect(ffmpegAsked).toEqual([]);
  });

  it('with VOICE_STT_PROVIDER=none it says voice notes are off', async () => {
    await failedVoice('local_timeout');
    await run({ failed: true, yes: true }, { env: parseEnv({}) });
    expect(lines).toEqual(['Speech-to-text for voice notes is not set up (VOICE_STT_PROVIDER is none). Nothing changed.']);
  });

  it('says when nothing failed', async () => {
    await failedVoice('stt_partial');
    await backlogVoice();
    await run({ failed: true }, { env: localEnv() });
    expect(lines).toEqual([NONE_FAILED]);
  });

  it('without ffmpeg they are skipped as needing it, and nothing is queued', async () => {
    const id = await failedVoice('audio_convert_failed');
    await run({ failed: true, yes: true }, { env: localEnv(), findFfmpeg: finder(false) });
    expect(lines).toEqual([
      'To try again: 0 voice notes or audio files the local engine could not transcribe.',
      `1 needs ${NEEDS_FFMPEG}`,
      'Nothing was changed.',
    ]);
    expect((await statusOf(id)).status).toBe('failed');
  });

  it('--client limits it to that client', async () => {
    await failedVoice('local_timeout');
    const mehta = await failedVoice('local_timeout', { clientId: 2 });
    await run({ failed: true, yes: true, client: 'meh' }, { env: localEnv() });
    expect(lines[0]).toBe('To try again: 1 voice note or audio file the local engine could not transcribe, about 1 minute.');
    expect(db.raw.prepare("SELECT id FROM media WHERE status = 'pending'").all()).toEqual([{ id: mehta }]);
  });

  it('a note that changed since it was counted is left alone and said so', async () => {
    const a = await failedVoice('local_timeout');
    const b = await failedVoice('local_timeout');
    const findFfmpeg = async (): Promise<string | null> => {
      db.raw.prepare('UPDATE messages SET revoked = 1 WHERE id = (SELECT message_id FROM media WHERE id = ?)').run(b);
      return 'ffmpeg';
    };
    await run({ failed: true, yes: true }, { env: localEnv(), findFfmpeg });
    expect(lines.slice(2)).toEqual([`1 queued again. The running service now tries them again (3 tries each). ${FREE}`, '1 changed since they were counted and were left alone.']);
    expect((await statusOf(a)).status).toBe('pending');
    expect((await statusOf(b)).status).toBe('failed');
  });

  it('never prints a file name, a path or a setting value', async () => {
    await failedVoice('local_timeout');
    await run({ failed: true }, { env: localEnv() });
    await run({ failed: true, yes: true }, { env: localEnv() });
    for (const secret of [FILE_NAME, '/opt/stt', 'voxtral.gguf', '.ogg', 'media/SHA']) expect(output()).not.toContain(secret);
  });
});
