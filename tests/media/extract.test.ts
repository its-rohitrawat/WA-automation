import Anthropic from '@anthropic-ai/sdk';
import { isMarkedAsUntransferable } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import { IMAGE_MAX_TOKENS, IMAGE_TOKEN_CEILING, MEDIA_SYSTEM_PROMPT, PDF_MAX_TOKENS, PDF_TOKENS_PER_PAGE } from '../../src/brain/mediaClient.ts';
import { SpendCapReachedError } from '../../src/brain/paidCall.ts';
import { createExtractor, imageCeilingUsd, imageEstimateUsd, scannedPdfCeilingUsd, type ExtractInput } from '../../src/media/extract.ts';
import type { PreparedImage } from '../../src/media/image.ts';
import type { ParseJob, ParseResult } from '../../src/media/parse/types.ts';
import { MEDIA_LIMITS } from '../../src/media/types.ts';
import { estimateCostUsd, type Prices } from '../../src/spend/pricing.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import type { Db } from '../../src/store/db.ts';
import { manualClock } from '../../src/util/clock.ts';
import { seededDb } from '../helpers/db.ts';
import { tinyPdf } from '../helpers/files.ts';
import { FakeMediaAi } from '../helpers/mediaAi.ts';

const P: Prices = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 };
const PDF = Buffer.from('%PDF-1.4 fake');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const NONE = { textKind: null, text: null, pageCount: null, note: null };

/** A Buffer that owns its whole memory, as files read from disk do, so a transfer really moves it. */
const owned = (b: Uint8Array): Buffer => Buffer.from(new Uint8Array(b).buffer);

function setup(o: { parse?: ParseResult; capUsd?: number; ai?: FakeMediaAi; realParse?: boolean } = {}) {
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
  const extract = createExtractor({ ai, spend, prices: P, parse: o.realParse ? undefined : parse, prepareImage });
  const input = (i: Partial<ExtractInput> = {}): ExtractInput => ({
    mediaId: 7, kind: 'image', mimeType: 'image/jpeg', fileName: null, forwarded: false, bytes: Buffer.from('img'), ...i,
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

  it('describes an image that was sent as a document', async () => {
    const { ai, extract, input } = setup();
    expect((await extract(input({ kind: 'document', mimeType: 'image/png', fileName: 'homepage-v3.png' }))).textKind).toBe('description');
    expect(ai.calls).toHaveLength(1);
  });

  it('reads a PDF with a text layer locally, without Claude', async () => {
    const { ai, parse, extract, input } = setup({ parse: { text: 'Quotation 17\nTotal 1,20,000 for the full website build', pageCount: 2 } });
    expect(await extract(input({ kind: 'document', mimeType: 'application/pdf', fileName: 'quote.pdf', bytes: PDF }))).toEqual({
      textKind: 'extract', text: 'Quotation 17\nTotal 1,20,000 for the full website build', pageCount: 2, note: null,
    });
    expect(parse.mock.calls[0]![0]).toMatchObject({ kind: 'pdf', maxPages: 200 });
    expect(ai.calls).toHaveLength(0);
  });

  it('marks a PDF that was read only up to the page cap', async () => {
    const { extract, input } = setup({ parse: { text: 'x'.repeat(4_000), pageCount: 250 } });
    expect(await extract(input({ kind: 'document', mimeType: 'application/pdf', bytes: PDF }))).toMatchObject({ textKind: 'extract', pageCount: 250, note: 'first_pages_only' });
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
    expect(parse.mock.calls[0]![0]).toMatchObject({ kind: 'docx', maxXmlBytes: 20 * 1024 * 1024, maxEntries: 2_000 });
  });

  it('keeps other files as originals only, and reads nothing for voice notes yet', async () => {
    const { ai, parse, extract, input } = setup();
    expect(await extract(input({ kind: 'document', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName: 'budget.xlsx', bytes: ZIP }))).toEqual(NONE);
    expect(await extract(input({ kind: 'document', mimeType: 'text/plain', bytes: Buffer.from('hello') }))).toEqual(NONE);
    expect(await extract(input({ kind: 'voice', mimeType: 'audio/ogg', bytes: Buffer.from('ogg') }))).toEqual(NONE);
    expect(parse).not.toHaveBeenCalled();
    expect(ai.calls).toHaveLength(0);
  });

  it('caps the stored text', async () => {
    const { extract, input } = setup({ parse: { text: 'a'.repeat(1_000_010), pageCount: 1 } });
    expect((await extract(input({ kind: 'document', mimeType: 'application/pdf', bytes: PDF }))).text).toHaveLength(1_000_000);
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

    it('does not decode an image when the budget left today cannot hold its ceiling', async () => {
      const { spend, ai, prepareImage, extract, input } = setup();
      spend.record('ai', 14.95, 'batch 1');
      expect(spend.canSpend(imageCeilingUsd(P))).toBe(false);
      await expect(extract(input())).rejects.toBeInstanceOf(SpendCapReachedError);
      expect(prepareImage).not.toHaveBeenCalled();
      expect(ai.calls).toHaveLength(0);
    });

    it('does not call Claude for a scan when the ceiling does not fit under what is left today', async () => {
      const { db, spend, ai, extract, input } = setup({ parse: { text: '', pageCount: 3 } });
      spend.record('ai', 11, 'batch 1');
      await expect(extract(input({ kind: 'document', mimeType: 'application/pdf', bytes: PDF }))).rejects.toBeInstanceOf(SpendCapReachedError);
      expect(ai.calls).toHaveLength(0);
      expect(spendRows(db)).toEqual([{ usd: 11, detail: 'batch 1' }]);
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
