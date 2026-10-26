import Anthropic from '@anthropic-ai/sdk';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMarkedAsUntransferable } from 'node:worker_threads';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IMAGE_MAX_TOKENS, IMAGE_TOKEN_CEILING, MEDIA_SYSTEM_PROMPT, PDF_MAX_TOKENS, PDF_TOKENS_PER_PAGE } from '../../src/brain/mediaClient.ts';
import { SpendCapReachedError } from '../../src/brain/paidCall.ts';
import { createExtractor, imageCeilingUsd, imageEstimateUsd, isPaidVoiceError, scannedPdfCeilingUsd, type ExtractInput } from '../../src/media/extract.ts';
import type { PreparedImage } from '../../src/media/image.ts';
import type { ParseJob, ParseResult } from '../../src/media/parse/types.ts';
import { MEDIA_LIMITS } from '../../src/media/types.ts';
import { estimateCostUsd, type Prices } from '../../src/spend/pricing.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import type { Db } from '../../src/store/db.ts';
import { AudioError } from '../../src/stt/audio.ts';
import { SttHttpError, SttJobError, SttNoAnswerError } from '../../src/stt/http.ts';
import { SttBookingError } from '../../src/stt/paidStt.ts';
import { sizeBoundSeconds, SttPartialError, voiceCeilingUsd, voiceTranscriber, type VoiceTranscriber } from '../../src/stt/voice.ts';
import { manualClock } from '../../src/util/clock.ts';
import { seededDb } from '../helpers/db.ts';
import { tinyDocx, tinyPdf } from '../helpers/files.ts';
import { FakeMediaAi } from '../helpers/mediaAi.ts';
import { FakeVoiceTranscriber, HearingProvider, MeasuringFfmpeg } from '../helpers/voice.ts';

const P: Prices = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 };
const PDF = Buffer.from('%PDF-1.4 fake');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const NONE = { textKind: null, text: null, pageCount: null, note: null };
/** Where the processor saved the original (the extractor only passes it on to the voice transcriber). */
const NOTE_PATH = '/data/media/acme/2026-10/wa1-7.ogg';

/** A Buffer that owns its whole memory, as files read from disk do, so a transfer really moves it. */
const owned = (b: Uint8Array): Buffer => Buffer.from(new Uint8Array(b).buffer);

function setup(
  o: { parse?: ParseResult; capUsd?: number; ai?: FakeMediaAi; realParse?: boolean; realImage?: boolean; voice?: VoiceTranscriber | null; maxVoiceSeconds?: number } = {},
) {
  const db = seededDb();
  const spend = new SpendGuard({ db, clock: manualClock('2026-10-19T08:00:00Z'), capUsd: o.capUsd ?? 15 });
  const ai = o.ai ?? new FakeMediaAi();
  // Behaves like parseFile: with transfer, bytes that own their memory are moved away and the caller's view is
  // emptied. Bytes that share memory (a pooled Buffer) are copied instead, so they stay intact.
  const parse = vi.fn(async (job: ParseJob, opts?: { transfer?: boolean }): Promise<ParseResult> => {
    const buf = job.bytes.buffer;
    const movable = buf instanceof ArrayBuffer && !isMarkedAsUntransferable(buf) && job.bytes.byteOffset === 0 && job.bytes.byteLength === buf.byteLength;
    if (opts?.transfer && movable) structuredClone(buf, { transfer: [buf] });
    return o.parse ?? { text: '', pageCount: 1 };
  });
  const prepareImage = vi.fn(async (bytes: Buffer): Promise<PreparedImage> => ({ data: Buffer.concat([bytes, Buffer.from('-small')]), mediaType: 'image/jpeg', width: 1000, height: 750 }));
  const extract = createExtractor({
    ai, spend, prices: P, parse: o.realParse ? undefined : parse, prepareImage: o.realImage ? undefined : prepareImage,
    ...(o.voice === undefined ? {} : { voice: o.voice }), ...(o.maxVoiceSeconds === undefined ? {} : { maxVoiceSeconds: o.maxVoiceSeconds }),
  });
  const input = (i: Partial<ExtractInput> = {}): ExtractInput => ({
    mediaId: 7, kind: 'image', mimeType: 'image/jpeg', fileName: null, forwarded: false, bytes: Buffer.from('img'), path: NOTE_PATH, ...i,
  });
  const reserve = vi.spyOn(spend, 'reserve');
  return { db, spend, ai, parse, prepareImage, extract, input, reserve };
}
const spendRows = (db: Db) => db.prepare('SELECT usd, detail FROM spend').all() as { usd: number; detail: string }[];

describe('createExtractor', () => {
  it('describes an image through Claude and books the actual cost', async () => {
    const { db, ai, prepareImage, extract, input, reserve } = setup();
    expect(await extract(input())).toEqual({ textKind: 'description', text: 'A screenshot of a payment receipt. Visible text: Paid ₹42,000', pageCount: null, note: null });
    expect(prepareImage).toHaveBeenCalledWith(Buffer.from('img'));
    expect(ai.calls).toEqual([{ kind: 'image', bytes: Buffer.from('img-small') }]);
    expect(spendRows(db)).toEqual([{ usd: 0.01, detail: 'media 7' }]);
    expect(reserve).toHaveBeenCalledExactlyOnceWith(imageEstimateUsd({ width: 1000, height: 750 }, P));
  });

  it.each(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'IMAGE/JPEG; charset=x'])('describes an image that was sent as a document (%s)', async (mimeType) => {
    const { ai, parse, extract, input } = setup();
    expect((await extract(input({ kind: 'document', mimeType, fileName: 'homepage-v3' }))).textKind).toBe('description');
    expect(ai.calls).toHaveLength(1);
    expect(parse).not.toHaveBeenCalled();
  });

  it('reads a PDF with a text layer locally, without Claude', async () => {
    const { ai, parse, extract, input } = setup({ parse: { text: 'Quotation 17\nTotal 1,20,000 for the full website build', pageCount: 2 } });
    expect(await extract(input({ kind: 'document', mimeType: 'application/pdf', fileName: 'quote.pdf', bytes: PDF }))).toEqual({
      textKind: 'extract', text: 'Quotation 17\nTotal 1,20,000 for the full website build', pageCount: 2, note: null,
    });
    expect(parse.mock.calls[0]![0]).toMatchObject({ kind: 'pdf', maxPages: 200, maxTextChars: 1_000_000 });
    expect(ai.calls).toHaveLength(0);
  });

  it('counts a PDF with 16 visible characters per page read as text, and one with 15 as a scan', async () => {
    const pdf = { kind: 'document', mimeType: 'application/pdf', bytes: PDF } as const;
    const text = setup({ parse: { text: ' abcd efgh\nijkl mnop ', pageCount: 1 } }); // 16 visible, whitespace not counted
    expect(await text.extract(text.input(pdf))).toEqual({ textKind: 'extract', text: ' abcd efgh\nijkl mnop ', pageCount: 1, note: null });
    expect(text.ai.calls).toHaveLength(0);

    const scan = setup({ parse: { text: ' abcd efgh\nijkl mno ', pageCount: 1 } }); // 15 visible
    expect(await scan.extract(scan.input(pdf))).toEqual({ textKind: 'extract', text: 'Quotation No. 17. Total ₹1,20,000', pageCount: 1, note: 'scan_read_by_ai' });
    expect(scan.ai.calls).toEqual([{ kind: 'pdf', bytes: PDF }]);
  });

  it('marks a PDF that was read only up to the page cap', async () => {
    // 3,500 characters is enough for the 200 pages read (16 x 200) but not for the 250 the file states (16 x 250):
    // the scan check counts only the pages that were read.
    const { extract, input } = setup({ parse: { text: 'x'.repeat(3_500), pageCount: 250 } });
    expect(await extract(input({ kind: 'document', mimeType: 'application/pdf', bytes: PDF }))).toMatchObject({ textKind: 'extract', pageCount: 250, note: 'first_pages_only' });
  });

  it('finds a PDF by its bytes, not by the MIME type the sender gave', async () => {
    const real = setup({ parse: { text: 'Quotation 17\nTotal 1,20,000 for the full website build', pageCount: 2 } });
    expect(await real.extract(real.input({ kind: 'document', mimeType: 'application/octet-stream', fileName: 'quote', bytes: PDF }))).toMatchObject({ textKind: 'extract', pageCount: 2 });
    expect(real.parse).toHaveBeenCalledTimes(1);
    expect(real.parse.mock.calls[0]![0]).toMatchObject({ kind: 'pdf' });

    const fake = setup();
    expect(await fake.extract(fake.input({ kind: 'document', mimeType: 'application/pdf', fileName: 'quote.pdf', bytes: Buffer.from('not a pdf') }))).toEqual(NONE);
    expect(fake.parse).not.toHaveBeenCalled();
    expect(fake.reserve).not.toHaveBeenCalled();
    expect(fake.ai.calls).toHaveLength(0);
  });

  it('sends a short scan to Claude, reserving the scanned-PDF ceiling', async () => {
    const { db, ai, extract, input, reserve } = setup({ parse: { text: '  ', pageCount: 3 } });
    expect(await extract(input({ kind: 'document', mimeType: 'application/pdf', bytes: PDF }))).toEqual({
      textKind: 'extract', text: 'Quotation No. 17. Total ₹1,20,000', pageCount: 3, note: 'scan_read_by_ai',
    });
    expect(ai.calls).toEqual([{ kind: 'pdf', bytes: PDF }]);
    expect(spendRows(db)).toEqual([{ usd: 0.01, detail: 'media 7' }]);
    expect(reserve).toHaveBeenCalledExactlyOnceWith(scannedPdfCeilingUsd(P));
  });

  it('lists a long scan with its page count only', async () => {
    const { ai, extract, input } = setup({ parse: { text: '', pageCount: 30 } });
    expect(await extract(input({ kind: 'document', mimeType: 'application/pdf', bytes: PDF }))).toEqual({ textKind: null, text: null, pageCount: 30, note: 'scan_too_long' });
    expect(ai.calls).toHaveLength(0);
  });

  it('reads DOCX text in the parser, by MIME type or by the .docx name', async () => {
    const { parse, extract, input } = setup({ parse: { text: 'Scope of work', pageCount: null } });
    expect(await extract(input({ kind: 'document', mimeType: DOCX_MIME, bytes: ZIP }))).toEqual({ textKind: 'extract', text: 'Scope of work', pageCount: null, note: null });
    expect(await extract(input({ kind: 'document', mimeType: 'application/octet-stream', fileName: 'Scope.DOCX', bytes: ZIP }))).toMatchObject({ text: 'Scope of work' });
    expect(parse.mock.calls[0]![0]).toMatchObject({ kind: 'docx', maxXmlBytes: 20 * 1024 * 1024, maxEntries: 2_000, maxTextChars: 1_000_000 });
  });

  it('keeps other files as originals only, and reads nothing for voice notes without a transcriber', async () => {
    const { ai, parse, extract, input } = setup();
    expect(await extract(input({ kind: 'document', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName: 'budget.xlsx', bytes: ZIP }))).toEqual(NONE);
    expect(await extract(input({ kind: 'document', mimeType: 'text/plain', bytes: Buffer.from('hello') }))).toEqual(NONE);
    // A DOCX name or MIME type is not enough: the bytes must be a ZIP.
    expect(await extract(input({ kind: 'document', mimeType: DOCX_MIME, fileName: 'x.docx', bytes: Buffer.from('not a zip') }))).toEqual(NONE);
    expect(await extract(input({ kind: 'voice', mimeType: 'audio/ogg', bytes: Buffer.from('ogg') }))).toEqual(NONE);
    expect(parse).not.toHaveBeenCalled();
    expect(ai.calls).toHaveLength(0);
  });

  describe('the stored-text cap', () => {
    const MAX = MEDIA_LIMITS.maxStoredTextChars;
    const pdf = { kind: 'document', mimeType: 'application/pdf', bytes: PDF } as const;

    it.each([
      { path: 'a PDF text layer', parse: { text: 'a'.repeat(MAX + 10), pageCount: 1 }, file: pdf },
      { path: 'DOCX text', parse: { text: 'a'.repeat(MAX + 10), pageCount: null }, file: { kind: 'document', mimeType: DOCX_MIME, bytes: ZIP } as const },
      { path: 'a scan read by Claude', parse: { text: '', pageCount: 3 }, claude: 'a'.repeat(MAX + 10), file: pdf },
      { path: 'an image description', claude: 'a'.repeat(MAX + 10), file: {} },
    ])('caps $path at maxStoredTextChars', async ({ parse, claude, file }) => {
      const { extract, input } = setup({ parse, ai: new FakeMediaAi(claude === undefined ? [] : [{ text: claude }]) });
      expect((await extract(input(file))).text).toHaveLength(MAX);
    });

    it('cuts a huge text layer without stalling the service', async () => {
      // A tiny hostile PDF can make the parser return tens of millions of characters (review of Task 9).
      const { extract, input } = setup({ parse: { text: 'क'.repeat(5_000_000), pageCount: 1 } });
      const started = performance.now();
      const { text } = await extract(input(pdf));
      expect(performance.now() - started).toBeLessThan(250);
      expect(text).toHaveLength(MAX);
    });

    it('never ends the stored text with half of a character', async () => {
      const halfway = setup({ parse: { text: `${'a'.repeat(MAX - 1)}${'😀'.repeat(5)}`, pageCount: 1 } });
      expect((await halfway.extract(halfway.input(pdf))).text).toBe('a'.repeat(MAX - 1));
      const whole = setup({ parse: { text: `${'a'.repeat(MAX - 2)}${'😀'.repeat(5)}`, pageCount: 1 } });
      expect((await whole.extract(whole.input(pdf))).text).toBe(`${'a'.repeat(MAX - 2)}😀`);
    });
  });

  it('decodes an image with the full pixel cap when no image preparer is given', async () => {
    const { ai, extract, input } = setup({ realImage: true });
    const side = Math.ceil(Math.sqrt(MEDIA_LIMITS.maxImagePixels)); // 7072 x 7072 is just over the cap
    // Grey, one byte per pixel, so the images stay under the decoded-size budget and only the pixel cap decides.
    const image = (s: number) => sharp({ create: { width: s, height: s, channels: 3, background: { r: 30, g: 90, b: 200 } } }).toColourspace('b-w');
    expect(await extract(input({ bytes: await image(side - 1).jpeg().toBuffer() }))).toMatchObject({ textKind: 'description' });
    expect([...ai.calls[0]!.bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    await expect(extract(input({ bytes: await image(side).png().toBuffer() }))).rejects.toMatchObject({ name: 'ParseError', code: 'image_unreadable' });
    expect(ai.calls).toHaveLength(1);
  });

  it('estimates are ceilings that include the image or the pages', () => {
    const base = (maxTokens: number) => estimateCostUsd(MEDIA_SYSTEM_PROMPT.length + 200, P, maxTokens);
    expect(imageEstimateUsd({ width: 1000, height: 750 }, P)).toBeCloseTo(base(IMAGE_MAX_TOKENS) + (1000 * 4) / 1e6);
    expect(imageEstimateUsd({ width: 10_000, height: 10_000 }, P)).toBeCloseTo(base(IMAGE_MAX_TOKENS) + (4784 * 4) / 1e6);
    expect(imageCeilingUsd(P)).toBeCloseTo(base(IMAGE_MAX_TOKENS) + (IMAGE_TOKEN_CEILING * 4) / 1e6);
    // Amendment 9g: every page Claude may read from one PDF (600), capped at the largest context window (1M tokens).
    expect(scannedPdfCeilingUsd(P)).toBeCloseTo(base(PDF_MAX_TOKENS) + (Math.min(600 * PDF_TOKENS_PER_PAGE, 1_000_000) * 4) / 1e6);
    expect(scannedPdfCeilingUsd(P)).toBeCloseTo(4.16, 1);
  });

  // Amendments 9a and 9b.
  describe('the daily cap', () => {
    it('lists a file whose ceiling is above the whole daily cap as too costly, without trying or deferring it', async () => {
      const image = setup({ capUsd: 0.001 });
      expect(await image.extract(image.input())).toEqual({ ...NONE, note: 'too_costly' });
      expect(image.prepareImage).not.toHaveBeenCalled();
      expect(image.reserve).not.toHaveBeenCalled();
      expect(image.ai.calls).toHaveLength(0);

      const scan = setup({ capUsd: 4, parse: { text: '', pageCount: 3 } });
      expect(scannedPdfCeilingUsd(P)).toBeGreaterThan(4);
      expect(await scan.extract(scan.input({ kind: 'document', mimeType: 'application/pdf', bytes: PDF }))).toEqual({ ...NONE, pageCount: 3, note: 'too_costly' });
      expect(scan.reserve).not.toHaveBeenCalled();
      expect(scan.ai.calls).toHaveLength(0);
      expect(spendRows(scan.db)).toEqual([]);
    });

    it('still tries an image or a scan when the daily cap equals its ceiling', async () => {
      const image = setup({ capUsd: imageCeilingUsd(P) });
      expect(await image.extract(image.input())).toMatchObject({ textKind: 'description', note: null });
      expect(image.ai.calls).toHaveLength(1);

      const scan = setup({ capUsd: scannedPdfCeilingUsd(P), parse: { text: '', pageCount: 3 } });
      expect(await scan.extract(scan.input({ kind: 'document', mimeType: 'application/pdf', bytes: PDF }))).toMatchObject({ textKind: 'extract', note: 'scan_read_by_ai' });
      expect(scan.reserve).toHaveBeenCalledExactlyOnceWith(scannedPdfCeilingUsd(P));
      expect(scan.ai.calls).toHaveLength(1);
    });

    it('does not decode an image when the budget left today cannot hold its ceiling', async () => {
      const { spend, ai, prepareImage, extract, input } = setup();
      spend.record('ai', 14.95, 'batch 1');
      expect(spend.canSpend(imageCeilingUsd(P))).toBe(false);
      await expect(extract(input())).rejects.toBeInstanceOf(SpendCapReachedError);
      expect(prepareImage).not.toHaveBeenCalled();
      expect(ai.calls).toHaveLength(0);
    });

    it('checks the ceiling before decoding, even when what is left would hold this image', async () => {
      // What is left today holds the estimate for the 1000 x 750 image the fake returns, but not the ceiling for any
      // image. The check must use the ceiling, or the image is decoded and then deferred on every retry (amendment 9b).
      const { spend, ai, prepareImage, extract, input } = setup();
      spend.record('ai', 15 - (imageCeilingUsd(P) - 0.001), 'batch 1');
      expect(spend.canSpend(imageCeilingUsd(P))).toBe(false);
      expect(spend.canSpend(imageEstimateUsd({ width: 1000, height: 750 }, P))).toBe(true);
      await expect(extract(input())).rejects.toBeInstanceOf(SpendCapReachedError);
      expect(prepareImage).not.toHaveBeenCalled();
      expect(ai.calls).toHaveLength(0);
    });

    // Final review FR3c: when only holds of paid calls in flight are in the way, the error says so (busy), so the file
    // waits as spend_busy and Health does not say it waits for midnight.
    it('says whether only paid calls in flight, not the cap, keep an image or a scan from its budget', async () => {
      const busy = async (run: Promise<unknown>) => (await run.then(() => null, (e: unknown) => e)) as SpendCapReachedError;
      const image = setup();
      image.spend.record('ai', 10.8, 'batch 1');
      const hold = image.spend.reserve(scannedPdfCeilingUsd(P))!; // a scan being read holds about $4.16
      let e = await busy(image.extract(image.input()));
      expect(e).toBeInstanceOf(SpendCapReachedError);
      expect(e.busy).toBe(true);
      image.spend.settle(hold, 'ai', 4.15, 'media 99');
      e = await busy(image.extract(image.input()));
      expect(e).toBeInstanceOf(SpendCapReachedError);
      expect(e.busy).toBe(false);
      expect(image.prepareImage).not.toHaveBeenCalled();

      const scan = setup({ parse: { text: '', pageCount: 3 } });
      scan.spend.record('ai', 8, 'batch 1');
      const scanHold = scan.spend.reserve(scannedPdfCeilingUsd(P))!;
      e = await busy(scan.extract(scan.input({ kind: 'document', mimeType: 'application/pdf', bytes: PDF })));
      expect(e.busy).toBe(true);
      scan.spend.settle(scanHold, 'ai', 4, 'media 99');
      e = await busy(scan.extract(scan.input({ kind: 'document', mimeType: 'application/pdf', bytes: PDF })));
      expect(e.busy).toBe(false);
      expect(image.ai.calls).toHaveLength(0);
      expect(scan.ai.calls).toHaveLength(0);
    });

    it('does not call Claude for a scan when the ceiling does not fit under what is left today', async () => {
      const { db, spend, ai, extract, input } = setup({ parse: { text: '', pageCount: 3 } });
      spend.record('ai', 11, 'batch 1');
      await expect(extract(input({ kind: 'document', mimeType: 'application/pdf', bytes: PDF }))).rejects.toBeInstanceOf(SpendCapReachedError);
      expect(ai.calls).toHaveLength(0);
      expect(spendRows(db)).toEqual([{ usd: 11, detail: 'batch 1' }]);
    });
  });

  // Final review FR3a: a file deleted for everyone during its download or decode is never sent to Claude.
  describe('a file deleted for everyone before the paid call', () => {
    it('an image is decoded but not described, and nothing is reserved or booked', async () => {
      const { db, ai, prepareImage, extract, input, reserve } = setup();
      const revoked = vi.fn(() => true);
      expect(await extract(input({ revoked }))).toEqual({ ...NONE, note: 'revoked' });
      expect(prepareImage).toHaveBeenCalledTimes(1);
      expect(revoked).toHaveBeenCalledTimes(1);
      expect(reserve).not.toHaveBeenCalled();
      expect(ai.calls).toHaveLength(0);
      expect(spendRows(db)).toEqual([]);
    });

    it('a scanned PDF is not read', async () => {
      const { db, ai, extract, input, reserve } = setup({ parse: { text: '', pageCount: 3 } });
      expect(await extract(input({ kind: 'document', mimeType: 'application/pdf', bytes: PDF, revoked: () => true }))).toEqual({ ...NONE, note: 'revoked' });
      expect(reserve).not.toHaveBeenCalled();
      expect(ai.calls).toHaveLength(0);
      expect(spendRows(db)).toEqual([]);
    });

    it('a file still wanted is read as usual, and a free read never asks', async () => {
      const { ai, extract, input } = setup({ parse: { text: 'Quotation 17\nTotal 1,20,000 for the full website build', pageCount: 2 } });
      const revoked = vi.fn(() => false);
      expect((await extract(input({ revoked }))).textKind).toBe('description');
      expect(revoked).toHaveBeenCalledTimes(1);
      expect((await extract(input({ kind: 'document', mimeType: 'application/pdf', bytes: PDF, revoked }))).textKind).toBe('extract');
      expect(revoked).toHaveBeenCalledTimes(1); // a PDF with a text layer is read locally, at no cost
      expect(ai.calls).toHaveLength(1);
    });
  });

  // Owner decision D2, amendment 9e.
  describe('forwarded files', () => {
    it('never sends a forwarded image to Claude, also one sent as a document', async () => {
      const { db, ai, prepareImage, extract, input, reserve } = setup();
      expect(await extract(input({ forwarded: true }))).toEqual({ ...NONE, note: 'forwarded_not_described' });
      expect(await extract(input({ forwarded: true, kind: 'document', mimeType: 'image/png', fileName: 'meme.png' }))).toEqual({ ...NONE, note: 'forwarded_not_described' });
      expect(prepareImage).not.toHaveBeenCalled();
      expect(reserve).not.toHaveBeenCalled();
      expect(ai.calls).toHaveLength(0);
      expect(spendRows(db)).toEqual([]);
    });

    it('never sends a forwarded scan to Claude', async () => {
      const { db, ai, extract, input, reserve } = setup({ parse: { text: '', pageCount: 3 } });
      expect(await extract(input({ forwarded: true, kind: 'document', mimeType: 'application/pdf', bytes: PDF }))).toEqual({ ...NONE, pageCount: 3, note: 'forwarded_not_described' });
      expect(reserve).not.toHaveBeenCalled();
      expect(ai.calls).toHaveLength(0);
      expect(spendRows(db)).toEqual([]);
    });

    it('settles a forwarded image before any budget check, so it is never deferred or listed as too costly', async () => {
      const spent = setup();
      spent.spend.record('ai', 14.95, 'batch 1');
      expect(spent.spend.canSpend(imageCeilingUsd(P))).toBe(false);
      expect(await spent.extract(spent.input({ forwarded: true }))).toEqual({ ...NONE, note: 'forwarded_not_described' });

      const tiny = setup({ capUsd: 0.001 });
      expect(imageCeilingUsd(P)).toBeGreaterThan(0.001);
      expect(await tiny.extract(tiny.input({ forwarded: true }))).toEqual({ ...NONE, note: 'forwarded_not_described' });

      for (const s of [spent, tiny]) {
        expect(s.prepareImage).not.toHaveBeenCalled();
        expect(s.reserve).not.toHaveBeenCalled();
        expect(s.ai.calls).toHaveLength(0);
      }
    });

    it('settles a forwarded scan as forwarded when the daily cap is below its ceiling or used up', async () => {
      const pdf = { forwarded: true, kind: 'document', mimeType: 'application/pdf', bytes: PDF } as const;
      const low = setup({ capUsd: 4, parse: { text: '', pageCount: 3 } });
      expect(scannedPdfCeilingUsd(P)).toBeGreaterThan(4);
      expect(await low.extract(low.input(pdf))).toEqual({ ...NONE, pageCount: 3, note: 'forwarded_not_described' });

      const spent = setup({ parse: { text: '', pageCount: 3 } });
      spent.spend.record('ai', 11, 'batch 1');
      expect(await spent.extract(spent.input(pdf))).toEqual({ ...NONE, pageCount: 3, note: 'forwarded_not_described' });

      for (const s of [low, spent]) {
        expect(s.reserve).not.toHaveBeenCalled();
        expect(s.ai.calls).toHaveLength(0);
      }
    });

    it('keeps a forwarded scan that is too long to read as too long', async () => {
      const { ai, extract, input } = setup({ parse: { text: '', pageCount: 30 } });
      expect(await extract(input({ forwarded: true, kind: 'document', mimeType: 'application/pdf', bytes: PDF }))).toEqual({ ...NONE, pageCount: 30, note: 'scan_too_long' });
      expect(ai.calls).toHaveLength(0);
    });

    it('still reads the text of a forwarded PDF or DOCX locally', async () => {
      const pdf = setup({ parse: { text: 'Quotation 17\nTotal 1,20,000 for the full website build', pageCount: 2 } });
      expect(await pdf.extract(pdf.input({ forwarded: true, kind: 'document', mimeType: 'application/pdf', bytes: PDF }))).toEqual({
        textKind: 'extract', text: 'Quotation 17\nTotal 1,20,000 for the full website build', pageCount: 2, note: null,
      });
      const docx = setup({ parse: { text: 'Scope of work', pageCount: null } });
      expect(await docx.extract(docx.input({ forwarded: true, kind: 'document', mimeType: DOCX_MIME, bytes: ZIP }))).toEqual({
        textKind: 'extract', text: 'Scope of work', pageCount: null, note: null,
      });
      expect(pdf.ai.calls).toHaveLength(0);
      expect(docx.ai.calls).toHaveLength(0);
    });
  });

  // Amendment 9f: parseFile moves the caller's bytes only when asked.
  describe('file bytes and the parser', () => {
    it('lets the DOCX parser take the bytes without a copy', async () => {
      const { parse, extract, input } = setup({ parse: { text: 'Scope of work', pageCount: null } });
      const bytes = owned(ZIP);
      expect(await extract(input({ kind: 'document', mimeType: DOCX_MIME, bytes }))).toMatchObject({ text: 'Scope of work' });
      expect(parse).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'docx' }), { transfer: true });
      expect(bytes.length).toBe(0); // moved to the parser, as parseFile does
    });

    it('moves a DOCX to the real parser without a copy', async () => {
      // No fake parser: the default wiring must pass { transfer: true } on to parseFile.
      const { extract, input } = setup({ realParse: true });
      const bytes = owned(await tinyDocx(['Scope of work']));
      expect(await extract(input({ kind: 'document', mimeType: DOCX_MIME, bytes }))).toEqual({ textKind: 'extract', text: 'Scope of work', pageCount: null, note: null });
      expect(bytes.length).toBe(0);
    });

    it('keeps the bytes of a PDF, so Claude receives the whole scan', async () => {
      const { ai, parse, extract, input } = setup({ parse: { text: '', pageCount: 3 } });
      const bytes = owned(PDF);
      await extract(input({ kind: 'document', mimeType: 'application/pdf', bytes }));
      expect(parse.mock.calls[0]![1]?.transfer).toBeUndefined();
      expect(bytes).toEqual(PDF);
      expect(ai.calls).toEqual([{ kind: 'pdf', bytes: PDF }]);
    });

    it('reads a scan of up to the byte limit, and lists a larger one as too long', async () => {
      const scan = (size: number) => {
        const b = Buffer.alloc(size);
        b.write('%PDF-1.4', 0, 'latin1');
        return b;
      };
      const atLimit = setup({ parse: { text: '', pageCount: 3 } });
      const full = scan(MEDIA_LIMITS.maxScannedPdfBytes);
      expect((await atLimit.extract(atLimit.input({ kind: 'document', mimeType: 'application/pdf', bytes: full }))).note).toBe('scan_read_by_ai');
      expect(atLimit.ai.calls[0]!.bytes.length).toBe(MEDIA_LIMITS.maxScannedPdfBytes);

      const over = setup({ parse: { text: '', pageCount: 3 } });
      const big = scan(MEDIA_LIMITS.maxScannedPdfBytes + 1);
      expect(await over.extract(over.input({ kind: 'document', mimeType: 'application/pdf', bytes: big }))).toEqual({ ...NONE, pageCount: 3, note: 'scan_too_long' });
      expect(over.ai.calls).toHaveLength(0);
      expect(big.length).toBe(MEDIA_LIMITS.maxScannedPdfBytes + 1);
    });
  });

  // Amendment 9g: the page count comes from the file itself and is never a spend limit. These use the real parser.
  describe('a PDF whose page count is forged', () => {
    const forgedScan = () => tinyPdf([[], [], []], { count: 1 });

    it('reserves the scanned-PDF ceiling for a 3-page scan that claims 1 page, and sends Claude every byte', async () => {
      const { ai, extract, input, reserve } = setup({ realParse: true });
      const bytes = forgedScan();
      expect(await extract(input({ kind: 'document', mimeType: 'application/pdf', bytes }))).toEqual({
        textKind: 'extract', text: 'Quotation No. 17. Total ₹1,20,000', pageCount: 1, note: 'scan_read_by_ai',
      });
      expect(reserve).toHaveBeenCalledExactlyOnceWith(scannedPdfCeilingUsd(P));
      expect(ai.calls).toEqual([{ kind: 'pdf', bytes: forgedScan() }]);
    });

    it('lists the same scan as too costly when the daily cap is below the ceiling', async () => {
      const { ai, extract, input, reserve } = setup({ realParse: true, capUsd: 4 });
      expect(await extract(input({ kind: 'document', mimeType: 'application/pdf', bytes: forgedScan() }))).toEqual({ ...NONE, pageCount: 1, note: 'too_costly' });
      expect(reserve).not.toHaveBeenCalled();
      expect(ai.calls).toHaveLength(0);
    });

    it('fails a text PDF that claims no pages as unreadable, without a paid call', async () => {
      const { db, ai, extract, input } = setup({ realParse: true });
      const bytes = tinyPdf([['Page 1'], ['Page 2']], { count: 0 });
      await expect(extract(input({ kind: 'document', mimeType: 'application/pdf', bytes }))).rejects.toMatchObject({ name: 'ParseError', code: 'pdf_no_pages' });
      expect(ai.calls).toHaveLength(0);
      expect(spendRows(db)).toEqual([]);
    });
  });

  // Amendment 9h: media calls make one SDK attempt, so a lost connection is booked once.
  describe('a connection lost during a paid call', () => {
    it('books an image estimate once', async () => {
      const { db, extract, input } = setup({ ai: new FakeMediaAi([new Anthropic.APIConnectionTimeoutError()]) });
      await expect(extract(input())).rejects.toBeInstanceOf(Anthropic.APIConnectionTimeoutError);
      const rows = spendRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.detail).toBe('media 7 (connection lost, estimated)');
      expect(rows[0]!.usd).toBeCloseTo(imageEstimateUsd({ width: 1000, height: 750 }, P), 12);
    });

    it('books the scanned-PDF ceiling once', async () => {
      const { db, extract, input } = setup({ ai: new FakeMediaAi([new Anthropic.APIConnectionTimeoutError()]), parse: { text: '', pageCount: 3 } });
      await expect(extract(input({ kind: 'document', mimeType: 'application/pdf', bytes: PDF }))).rejects.toBeInstanceOf(Anthropic.APIConnectionTimeoutError);
      const rows = spendRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.detail).toBe('media 7 (connection lost, estimated)');
      expect(rows[0]!.usd).toBeCloseTo(scannedPdfCeilingUsd(P), 12);
    });
  });
});

// Phase 2b, Task 5: V2, V4, V5, N2.
describe('voice and audio', () => {
  const OGG = 'audio/ogg; codecs=opus';
  /** 90,000 bytes: a size bound of 60 seconds. */
  const note = (i: Partial<ExtractInput> = {}): Partial<ExtractInput> => ({ kind: 'voice', mimeType: OGG, bytes: Buffer.alloc(90_000), ...i });
  const voiceSetup = (v: VoiceTranscriber | null = new FakeVoiceTranscriber(), o: { capUsd?: number; maxVoiceSeconds?: number } = {}) => setup({ voice: v, ...o });
  const sttRows = (db: Db) => db.prepare('SELECT kind, usd, detail FROM spend').all() as { kind: string; usd: number; detail: string }[];
  const caught = async (run: Promise<unknown>): Promise<unknown> => run.then(() => null, (e: unknown) => e);
  /** A folder of its own for the real transcriber's conversions, removed after each test. */
  const dirs: string[] = [];
  const workDir = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'wa-extract-voice-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('keeps a voice note as in 2a when no transcriber is set up (STT_PROVIDER none)', async () => {
    const { db, extract, input, reserve } = voiceSetup(null);
    expect(await extract(input(note()))).toEqual(NONE);
    expect(await extract(input(note({ kind: 'audio', forwarded: true, bytes: Buffer.alloc(5_000_000) })))).toEqual(NONE);
    expect(reserve).not.toHaveBeenCalled();
    expect(spendRows(db)).toEqual([]);
  });

  it('transcribes a voice note inside one stt hold and books its cost', async () => {
    const v = new FakeVoiceTranscriber({ results: [{ text: 'payment bhej diya, ₹42,000', billedSeconds: 41 }] });
    const { db, extract, input, reserve } = voiceSetup(v);
    expect(await extract(input(note()))).toEqual({ textKind: 'extract', text: 'payment bhej diya, ₹42,000', pageCount: null, note: null, forget: null });
    // The cap, not the size bound, goes to prepare (review override).
    expect(v.prepared).toEqual([{ mediaId: 7, path: NOTE_PATH, maxSeconds: 600 }]);
    expect(v.transcribed).toBe(1);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve.mock.calls[0]!.slice(0, 2)).toEqual([v.ceilingUsd(60), 'stt']);
    expect(v.costCalls).toEqual([{ maxSeconds: 60, billedSeconds: 41, measuredSeconds: 45 }]);
    expect(sttRows(db)).toEqual([{ kind: 'stt', usd: v.costUsd({ maxSeconds: 60, billedSeconds: 41, measuredSeconds: 45 }), detail: 'media 7' }]);
    expect(v.disposals).toBe(1);
  });

  it('passes the measured length on to the cost', async () => {
    const v = new FakeVoiceTranscriber({ measuredSeconds: 47 });
    const { extract, input } = voiceSetup(v);
    await extract(input(note()));
    expect(v.costCalls).toEqual([{ maxSeconds: 60, billedSeconds: null, measuredSeconds: 47 }]);
  });

  // Task 5 review round 1, Fix 2: the declared length is not an input any more, so it can never lower the booking.
  it('a declared length of 0 cannot book $0: a Sarvam-like answer (no billed seconds) books the measured length', async () => {
    const provider = new HearingProvider('sarvam'); // billedSeconds null, as Sarvam
    const v = voiceTranscriber(provider, { inrPerUsd: 88, ffmpeg: new MeasuringFfmpeg(30), tmpDir: workDir() });
    const { db, extract, input } = voiceSetup(v);
    // A caller that still passed the row's declared length: it is not read.
    expect(await extract({ ...input(note()), declaredSeconds: 0 } as ExtractInput)).toMatchObject({ textKind: 'extract', text: 'namaste' });
    expect(sttRows(db)).toEqual([{ kind: 'stt', usd: voiceCeilingUsd('sarvam', 30, 88), detail: 'media 7' }]);
    expect(sttRows(db)[0]!.usd).toBeGreaterThan(0);
  });

  it('the fake prices like the real one: billed, else measured, else the bound; never a negative, NaN or infinite length', () => {
    const v = new FakeVoiceTranscriber();
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(v.costUsd({ maxSeconds: 60, billedSeconds: bad, measuredSeconds: 47 })).toBeCloseTo(v.ceilingUsd(47), 12);
      expect(v.costUsd({ maxSeconds: 60, billedSeconds: bad, measuredSeconds: bad })).toBeCloseTo(v.ceilingUsd(60), 12);
    }
    expect(v.costUsd({ maxSeconds: 60, billedSeconds: 0, measuredSeconds: 47 })).toBe(0);
  });

  it('never sends a forwarded voice note, before any other check (V4)', async () => {
    const v = new FakeVoiceTranscriber({ canSend: () => false });
    const { db, extract, input, reserve } = voiceSetup(v, { capUsd: 0.000_001 });
    expect(await extract(input(note({ forwarded: true })))).toEqual({ ...NONE, note: 'forwarded_not_transcribed' });
    // Too long as well: still listed as forwarded.
    expect(await extract(input(note({ forwarded: true, bytes: Buffer.alloc(5_000_000) })))).toEqual({ ...NONE, note: 'forwarded_not_transcribed' });
    expect(v.prepared).toEqual([]);
    expect(v.transcribed).toBe(0);
    expect(reserve).not.toHaveBeenCalled();
    expect(spendRows(db)).toEqual([]);
  });

  describe('too long (V2, V5)', () => {
    it('refuses a file whose size allows more than the cap, without preparing it', async () => {
      const v = new FakeVoiceTranscriber();
      const { db, extract, input, reserve } = voiceSetup(v);
      expect(sizeBoundSeconds(900_001)).toBe(601);
      expect(await extract(input(note({ bytes: Buffer.alloc(900_001) })))).toEqual({ ...NONE, note: 'too_long' });
      expect(v.prepared).toEqual([]);
      expect(reserve).not.toHaveBeenCalled();
      expect(await extract(input(note({ bytes: Buffer.alloc(900_000) })))).toMatchObject({ textKind: 'extract', note: null });
      expect(v.transcribed).toBe(1);
      expect(sttRows(db)).toHaveLength(1);
    });

    it('follows the cap it is given', async () => {
      const v = new FakeVoiceTranscriber({ measuredSeconds: 30 });
      const { extract, input } = voiceSetup(v, { maxVoiceSeconds: 30 });
      expect(await extract(input(note({ bytes: Buffer.alloc(45_001) })))).toEqual({ ...NONE, note: 'too_long' });
      expect(await extract(input(note({ bytes: Buffer.alloc(45_000) })))).toMatchObject({ textKind: 'extract' });
      expect(v.prepared.map((p) => p.maxSeconds)).toEqual([30]);
    });

    it('checks the size before the format', async () => {
      const v = new FakeVoiceTranscriber({ canSend: () => false });
      const { extract, input } = voiceSetup(v);
      expect(await extract(input(note({ bytes: Buffer.alloc(900_001) })))).toEqual({ ...NONE, note: 'too_long' });
    });

    it('never lets a declared length change the bound, the cap check, the hold or the booking', async () => {
      const v = new FakeVoiceTranscriber();
      const { extract, input, reserve } = voiceSetup(v);
      const declaring = (seconds: number, i: Partial<ExtractInput> = {}) => ({ ...input(note(i)), declaredSeconds: seconds }) as ExtractInput;
      expect(await extract(declaring(5, { bytes: Buffer.alloc(900_001) }))).toEqual({ ...NONE, note: 'too_long' });
      expect(await extract(declaring(5_000))).toMatchObject({ textKind: 'extract' });
      expect(v.prepared.map((p) => p.maxSeconds)).toEqual([600]);
      expect(reserve.mock.calls[0]![0]).toBe(v.ceilingUsd(60));
      expect(v.costCalls).toEqual([{ maxSeconds: 60, billedSeconds: null, measuredSeconds: 45 }]);
    });

    it('turns a note measured too long by prepare into the note too_long, with no hold and no spend', async () => {
      const v = new FakeVoiceTranscriber({ measuredSeconds: 606 });
      const { db, extract, input, reserve } = voiceSetup(v);
      expect(await extract(input(note()))).toEqual({ ...NONE, note: 'too_long' });
      expect(v.prepared).toHaveLength(1);
      expect(v.transcribed).toBe(0);
      expect(reserve).not.toHaveBeenCalled();
      expect(spendRows(db)).toEqual([]);
    });

    // Review override: prepare is given the cap, not the size bound, so an honest note recorded below 12 kbit/s goes.
    it('gives prepare the cap, so an honest note below 12 kbit/s is sent, held at its measured length', async () => {
      const provider = new HearingProvider('sarvam');
      const v = voiceTranscriber(provider, { inrPerUsd: 88, ffmpeg: new MeasuringFfmpeg(60), tmpDir: workDir() });
      const { extract, input, reserve } = voiceSetup(v);
      // 60,000 bytes: a bound of 40 seconds, measured at 60 (8 kbit/s).
      expect(await extract(input(note({ bytes: Buffer.alloc(60_000) })))).toMatchObject({ textKind: 'extract', text: 'namaste', note: null });
      expect(provider.calls).toHaveLength(1);
      expect(reserve.mock.calls[0]![0]).toBe(voiceCeilingUsd('sarvam', 60, 88));
    });

    it('with the real transcriber: measured 700 s, bound 600, cap 900 is sent and held at 700 s', async () => {
      const provider = new HearingProvider('elevenlabs');
      const v = voiceTranscriber(provider, { inrPerUsd: 88, ffmpeg: new MeasuringFfmpeg(700), tmpDir: workDir() });
      const { db, extract, input, reserve } = voiceSetup(v, { maxVoiceSeconds: 900 });
      expect(sizeBoundSeconds(900_000)).toBe(600);
      expect(await extract(input(note({ bytes: Buffer.alloc(900_000) })))).toMatchObject({ textKind: 'extract', note: null });
      expect(provider.calls).toHaveLength(1);
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(reserve.mock.calls[0]!.slice(0, 2)).toEqual([v.ceilingUsd(700), 'stt']);
      // Settled at the measured length: the fake provider reports no billed seconds.
      expect(sttRows(db)).toEqual([{ kind: 'stt', usd: v.ceilingUsd(700), detail: 'media 7' }]);
    });

    it('with the real transcriber: measured 906 s with cap 900 is too_long, with no provider call', async () => {
      const provider = new HearingProvider('elevenlabs');
      const v = voiceTranscriber(provider, { inrPerUsd: 88, ffmpeg: new MeasuringFfmpeg(906), tmpDir: workDir() });
      const { db, extract, input, reserve } = voiceSetup(v, { maxVoiceSeconds: 900 });
      expect(await extract(input(note({ bytes: Buffer.alloc(900_000) })))).toEqual({ ...NONE, note: 'too_long' });
      expect(provider.calls).toHaveLength(0);
      expect(reserve).not.toHaveBeenCalled();
      expect(spendRows(db)).toEqual([]);
      // 905 s is inside the tolerance.
      const ok = voiceSetup(voiceTranscriber(provider, { inrPerUsd: 88, ffmpeg: new MeasuringFfmpeg(905), tmpDir: workDir() }), { maxVoiceSeconds: 900 });
      expect(await ok.extract(ok.input(note({ bytes: Buffer.alloc(900_000) })))).toMatchObject({ textKind: 'extract' });
      expect(provider.calls).toHaveLength(1);
    });
  });

  it('lists a file the transcriber cannot send as format_not_supported, without preparing it (N2)', async () => {
    const v = new FakeVoiceTranscriber({ canSend: (m) => m !== 'audio/aac' });
    const { db, extract, input, reserve } = voiceSetup(v);
    expect(await extract(input(note({ kind: 'audio', mimeType: 'audio/aac' })))).toEqual({ ...NONE, note: 'format_not_supported' });
    expect(v.prepared).toEqual([]);
    expect(reserve).not.toHaveBeenCalled();
    expect(spendRows(db)).toEqual([]);
  });

  // Task 5 review round 1: every file is converted first, so without ffmpeg nothing is sent, not even a WhatsApp note.
  it('with the real transcriber and no ffmpeg, every voice note and audio file is format_not_supported, with no hold', async () => {
    const provider = new HearingProvider('elevenlabs');
    const v = voiceTranscriber(provider, { inrPerUsd: 88, ffmpeg: null, tmpDir: workDir() });
    const { db, extract, input, reserve } = voiceSetup(v);
    for (const i of [note(), note({ kind: 'audio', mimeType: 'audio/mpeg' }), note({ kind: 'audio', mimeType: 'audio/mp4' })]) {
      expect(await extract(input(i))).toEqual({ ...NONE, note: 'format_not_supported' });
    }
    expect(provider.calls).toEqual([]);
    expect(reserve).not.toHaveBeenCalled();
    expect(spendRows(db)).toEqual([]);
  });

  it('with the real transcriber and ffmpeg, a WhatsApp voice note is converted, stopped past the cap, and sent as mp3', async () => {
    const provider = new HearingProvider('sarvam');
    const ffmpeg = new MeasuringFfmpeg(42);
    const v = voiceTranscriber(provider, { inrPerUsd: 88, ffmpeg, tmpDir: workDir() });
    const { extract, input } = voiceSetup(v);
    expect(await extract(input(note()))).toMatchObject({ textKind: 'extract', text: 'namaste' });
    expect(ffmpeg.limits).toEqual([600 + 5 + 1]);
    expect(provider.calls.map((c) => [c.format, c.seconds])).toEqual([['mp3', 42]]);
    expect(provider.calls[0]!.path).not.toBe(NOTE_PATH);
  });

  describe('local failures in prepare book nothing', () => {
    it.each([
      ['an ffmpeg failure', new AudioError('ffmpeg_failed')],
      ['no ffmpeg', new AudioError('no_ffmpeg')],
      ['a file that cannot be read', Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })],
    ])('%s reaches the caller with no hold and no spend row', async (_name, error) => {
      const v = new FakeVoiceTranscriber({ prepareError: error });
      const { db, extract, input, reserve } = voiceSetup(v);
      expect(await caught(extract(input(note())))).toBe(error);
      expect(v.transcribed).toBe(0);
      expect(reserve).not.toHaveBeenCalled();
      expect(spendRows(db)).toEqual([]);
      expect(v.disposals).toBe(0); // nothing was prepared
    });
  });

  it('lists a note whose ceiling is above the whole daily cap as too costly, and disposes it', async () => {
    const v = new FakeVoiceTranscriber();
    const { db, extract, input, reserve } = voiceSetup(v, { capUsd: 0.005 });
    expect(v.ceilingUsd(60)).toBeGreaterThan(0.005);
    expect(await extract(input(note()))).toEqual({ ...NONE, note: 'too_costly' });
    expect(v.transcribed).toBe(0);
    expect(reserve).not.toHaveBeenCalled();
    expect(spendRows(db)).toEqual([]);
    expect(v.disposals).toBe(1);
  });

  it('still sends a note whose ceiling is exactly the whole daily cap', async () => {
    const v = new FakeVoiceTranscriber();
    const { db, extract, input, reserve } = voiceSetup(v, { capUsd: new FakeVoiceTranscriber().ceilingUsd(60) });
    expect(await extract(input(note()))).toMatchObject({ textKind: 'extract', note: null });
    expect(v.transcribed).toBe(1);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(sttRows(db)).toHaveLength(1);
  });

  it('does not send a note deleted for everyone just before the call, and disposes it', async () => {
    const v = new FakeVoiceTranscriber();
    const { db, extract, input, reserve } = voiceSetup(v);
    const revoked = vi.fn(() => true);
    expect(await extract(input(note({ revoked })))).toEqual({ ...NONE, note: 'revoked' });
    expect(v.prepared).toHaveLength(1);
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(v.transcribed).toBe(0);
    expect(reserve).not.toHaveBeenCalled();
    expect(spendRows(db)).toEqual([]);
    expect(v.disposals).toBe(1);
  });

  it('holds the larger of the size bound and the measured length', async () => {
    const longer = new FakeVoiceTranscriber({ measuredSeconds: 603 });
    const a = voiceSetup(longer);
    expect(await a.extract(a.input(note({ bytes: Buffer.alloc(900_000) })))).toMatchObject({ textKind: 'extract' });
    expect(a.reserve.mock.calls[0]![0]).toBe(longer.ceilingUsd(603));

    const shorter = new FakeVoiceTranscriber({ measuredSeconds: 20 });
    const b = voiceSetup(shorter);
    expect(await b.extract(b.input(note()))).toMatchObject({ textKind: 'extract' });
    expect(b.reserve.mock.calls[0]![0]).toBe(shorter.ceilingUsd(60));
  });

  it('notes the provider copy to delete (N1)', async () => {
    const v = new FakeVoiceTranscriber({ provider: 'elevenlabs', results: [{ forgetRef: 'tr_1' }] });
    const { extract, input } = voiceSetup(v);
    expect(await extract(input(note()))).toEqual({ textKind: 'extract', text: 'namaste', pageCount: null, note: null, forget: { provider: 'elevenlabs', ref: 'tr_1' } });
  });

  it("names the copy's provider from the result, not from the transcriber", async () => {
    const v = new FakeVoiceTranscriber({ provider: 'sarvam', results: [{ provider: 'elevenlabs', forgetRef: 'tr_1' }] });
    const { extract, input } = voiceSetup(v);
    expect((await extract(input(note()))).forget).toEqual({ provider: 'elevenlabs', ref: 'tr_1' });
  });

  // Task 5 review round 1, Fix 3: the provider answered (and billed), then the booking itself failed.
  describe('a booking that fails after a successful paid call', () => {
    const TRANSCRIPT = 'payment bhej diya, ₹42,000';
    const answered = (o: { forgetError?: Error } = {}) =>
      new FakeVoiceTranscriber({ provider: 'elevenlabs', results: [{ text: TRANSCRIPT, billedSeconds: 12, forgetRef: 'tr_1' }], ...o });
    const lateRows = (db: Db) => sttRows(db).filter((r) => r.detail === 'media 7 (booked late)');

    it.each([
      // As the real settle does when its write throws: the hold is freed first.
      ['settle', (spend: SpendGuard) => vi.spyOn(spend, 'settle').mockImplementationOnce((id) => {
        spend.release(id);
        throw new Error('database is locked');
      })],
      ['record', (spend: SpendGuard) => vi.spyOn(spend, 'record').mockImplementationOnce(() => {
        throw new Error('database is locked');
      })],
    ] as const)("%s throwing once: one call, booked late, the copy deleted, and the error marked paid", async (_name, breakIt) => {
      const v = answered();
      const { db, spend, extract, input } = voiceSetup(v);
      breakIt(spend);
      const record = vi.spyOn(spend, 'record');
      const err = await caught(extract(input(note())));
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('database is locked');
      expect(v.transcribed).toBe(1);
      expect(record).toHaveBeenCalledWith('stt', v.costUsd({ maxSeconds: 60, billedSeconds: 12, measuredSeconds: 45 }), 'media 7 (booked late)');
      expect(lateRows(db)).toEqual([{ kind: 'stt', usd: 12 * 0.0001, detail: 'media 7 (booked late)' }]);
      expect(sttRows(db)).toHaveLength(1);
      expect(v.forgotten).toEqual(['tr_1']);
      expect(isPaidVoiceError(err)).toBe(true);
      // Nothing the sender said, and no provider id, is in the error.
      const shown = `${String(err)} ${JSON.stringify(err)} ${(err as Error).stack ?? ''}`;
      for (const secret of [TRANSCRIPT, 'tr_1', 'payment']) expect(shown).not.toContain(secret);
      // The hold ($0.006) is gone: only the late booking ($0.0012) counts.
      expect(spend.canSpend(15 - 0.002)).toBe(true);
      expect(v.disposals).toBe(1);
    });

    it('a late booking and a forget that fail too still throw the first error, marked paid', async () => {
      const v = answered({ forgetError: new Error('forget failed') });
      const { db, spend, extract, input } = voiceSetup(v);
      vi.spyOn(spend, 'record').mockImplementation(() => {
        throw new Error('disk full');
      });
      const err = await caught(extract(input(note())));
      expect((err as Error).message).toBe('disk full');
      expect(isPaidVoiceError(err)).toBe(true);
      expect(v.transcribed).toBe(1);
      expect(v.forgotten).toEqual(['tr_1']);
      expect(sttRows(db)).toEqual([]);
    });

    it('pricing that throws after the answer: withSttHold books the ceiling once, nothing late, the copy deleted, marked paid', async () => {
      const v = answered();
      const { db, extract, input } = voiceSetup(v);
      const pricing = new Error('pricing failed');
      vi.spyOn(v, 'costUsd').mockImplementationOnce(() => {
        throw pricing;
      });
      const err = await caught(extract(input(note())));
      expect(err).toBe(pricing);
      expect(isPaidVoiceError(err)).toBe(true);
      expect(sttRows(db)).toEqual([{ kind: 'stt', usd: v.ceilingUsd(60), detail: 'media 7 (unknown, estimated)' }]);
      expect(v.forgotten).toEqual(['tr_1']);
    });

    it('pricing and the ceiling booking both failing: the ceiling is booked late', async () => {
      const v = answered();
      const { db, spend, extract, input } = voiceSetup(v);
      vi.spyOn(v, 'costUsd').mockImplementationOnce(() => {
        throw new Error('pricing failed');
      });
      vi.spyOn(spend, 'record').mockImplementationOnce(() => {
        throw new Error('database is locked');
      });
      const err = await caught(extract(input(note())));
      expect(err).toBeInstanceOf(SttBookingError);
      expect(isPaidVoiceError(err)).toBe(true);
      expect(sttRows(db)).toEqual([{ kind: 'stt', usd: v.ceilingUsd(60), detail: 'media 7 (booked late)' }]);
    });

    it('with no copy to delete, nothing is forgotten', async () => {
      const v = new FakeVoiceTranscriber({ results: [{ billedSeconds: 12 }] });
      const { spend, extract, input } = voiceSetup(v);
      vi.spyOn(spend, 'settle').mockImplementationOnce(() => {
        throw new Error('database is locked');
      });
      expect(isPaidVoiceError(await caught(extract(input(note()))))).toBe(true);
      expect(v.forgotten).toEqual([]);
    });

    it('a call that failed is not a paid voice error: withSttHold books it, and the processor decides', async () => {
      for (const error of [new SttHttpError(401, 'invalid_api_key'), new SttNoAnswerError('timeout')]) {
        const v = new FakeVoiceTranscriber({ provider: 'elevenlabs', results: [error] });
        const { extract, input } = voiceSetup(v);
        const err = await caught(extract(input(note())));
        expect(err).toBe(error);
        expect(isPaidVoiceError(err)).toBe(false);
        expect(v.forgotten).toEqual([]);
      }
      // Neither is a refused prepare, the spend cap, or anything that is not an error object.
      const capped = voiceSetup(new FakeVoiceTranscriber({ usdPerSecond: 1 }), { capUsd: 100 });
      capped.spend.record('ai', 99, 'batch 1');
      expect(isPaidVoiceError(await caught(capped.extract(capped.input(note()))))).toBe(false);
      for (const x of [null, undefined, 'x', 3, new Error('other')]) expect(isPaidVoiceError(x)).toBe(false);
    });
  });

  it('lists a note with no speech as no_speech, still booking its cost and noting its copy', async () => {
    const v = new FakeVoiceTranscriber({ provider: 'elevenlabs', results: [{ text: '', billedSeconds: 12, forgetRef: 'tr_2' }] });
    const { db, extract, input } = voiceSetup(v);
    expect(await extract(input(note()))).toEqual({ ...NONE, note: 'no_speech', forget: { provider: 'elevenlabs', ref: 'tr_2' } });
    expect(sttRows(db)).toEqual([{ kind: 'stt', usd: 12 * 0.0001, detail: 'media 7' }]);
    expect(v.disposals).toBe(1);
  });

  it('cuts a long transcript at maxStoredTextChars', async () => {
    const v = new FakeVoiceTranscriber({ results: [{ text: 'a'.repeat(MEDIA_LIMITS.maxStoredTextChars + 10) }] });
    const { extract, input } = voiceSetup(v);
    expect((await extract(input(note()))).text).toHaveLength(MEDIA_LIMITS.maxStoredTextChars);
  });

  it('defers on the spend cap without a call, busy when only holds are in the way', async () => {
    const v = new FakeVoiceTranscriber({ usdPerSecond: 0.01 }); // $0.60 for the 60-second bound
    const { db, spend, extract, input } = voiceSetup(v, { capUsd: 1 });
    spend.record('ai', 0.2, 'batch 1');
    const hold = spend.reserve(0.5)!;
    let e = await caught(extract(input(note())));
    expect(e).toBeInstanceOf(SpendCapReachedError);
    expect((e as SpendCapReachedError).busy).toBe(true);
    spend.settle(hold, 'ai', 0.5, 'media 99');
    e = await caught(extract(input(note())));
    expect(e).toBeInstanceOf(SpendCapReachedError);
    expect((e as SpendCapReachedError).busy).toBe(false);
    expect(v.transcribed).toBe(0);
    expect(v.disposals).toBe(2);
    expect(sttRows(db).filter((r) => r.kind === 'stt')).toEqual([]);
  });

  // withSttHold with no hooks: each failure is booked by its outcome (Phase 3's fix of paidStt.ts).
  describe('a paid call that fails', () => {
    it('frees the hold on an SttHttpError(401) and throws it', async () => {
      const error = new SttHttpError(401, 'invalid_api_key');
      const v = new FakeVoiceTranscriber({ results: [error] });
      const { db, spend, extract, input } = voiceSetup(v);
      expect(await caught(extract(input(note())))).toBe(error);
      expect(spendRows(db)).toEqual([]);
      expect(spend.canSpend(15)).toBe(true); // the hold is gone
      expect(v.disposals).toBe(1);
    });

    it.each([
      ['no answer', new SttNoAnswerError('timeout'), 'media 7 (unknown, estimated)'],
      ['a failed job', new SttJobError('failed'), 'media 7 (job failed, estimated)'],
      ['a later part failing', new SttPartialError(1, 2, new SttHttpError(503)), 'media 7 (unknown, estimated)'],
    ])('books the ceiling as stt on %s and throws it', async (_name, error, detail) => {
      const v = new FakeVoiceTranscriber({ results: [error] });
      const { db, extract, input } = voiceSetup(v);
      expect(await caught(extract(input(note())))).toBe(error);
      expect(sttRows(db)).toEqual([{ kind: 'stt', usd: v.ceilingUsd(60), detail }]);
      expect(v.disposals).toBe(1);
    });
  });

  it('transcribes team and founder voice notes too: the input carries no sender to filter on', async () => {
    const v = new FakeVoiceTranscriber();
    const { extract, input } = voiceSetup(v);
    // The same note from the client (7), a team member (8) and the founder (9).
    for (const mediaId of [7, 8, 9]) expect(await extract(input(note({ mediaId })))).toMatchObject({ textKind: 'extract', text: 'namaste' });
    expect(v.prepared.map((p) => p.mediaId)).toEqual([7, 8, 9]);
    expect(v.transcribed).toBe(3);
  });

  it('follows the same rules for kind audio', async () => {
    const v = new FakeVoiceTranscriber({ canSend: (m) => m !== 'audio/amr' });
    const { db, extract, input } = voiceSetup(v);
    const audio = (i: Partial<ExtractInput> = {}) => input(note({ kind: 'audio', mimeType: 'audio/mpeg', ...i }));
    expect(await extract(audio({ forwarded: true }))).toEqual({ ...NONE, note: 'forwarded_not_transcribed' });
    expect(await extract(audio({ bytes: Buffer.alloc(900_001) }))).toEqual({ ...NONE, note: 'too_long' });
    expect(await extract(audio({ mimeType: 'audio/amr' }))).toEqual({ ...NONE, note: 'format_not_supported' });
    expect(await extract(audio())).toEqual({ textKind: 'extract', text: 'namaste', pageCount: null, note: null, forget: null });
    expect(v.prepared).toEqual([{ mediaId: 7, path: NOTE_PATH, maxSeconds: 600 }]);
    expect(sttRows(db)).toEqual([{ kind: 'stt', usd: v.ceilingUsd(45), detail: 'media 7' }]);
  });

  it('still reads nothing for video and stickers', async () => {
    const v = new FakeVoiceTranscriber();
    const { extract, input } = voiceSetup(v);
    expect(await extract(input(note({ kind: 'video', mimeType: 'video/mp4' })))).toEqual(NONE);
    expect(await extract(input(note({ kind: 'sticker', mimeType: 'image/webp' })))).toEqual(NONE);
    expect(v.prepared).toEqual([]);
  });
});
