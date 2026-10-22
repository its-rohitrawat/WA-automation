import type { HeapInfo } from 'node:v8';
import { Worker } from 'node:worker_threads';
import { getDocumentProxy } from 'unpdf';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { extractPdfText } from '../../src/media/parse/pdf.ts';
import { parseFile } from '../../src/media/parse/runner.ts';
import { bigDrawingPdf, flateBombPdf, tinyPdf } from '../helpers/files.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The real unpdf, with a spy around getDocumentProxy so a test can see the options the reader passes.
vi.mock('unpdf', async (importOriginal) => {
  const real = await importOriginal<typeof import('unpdf')>();
  return { ...real, getDocumentProxy: vi.fn(real.getDocumentProxy) };
});

afterEach(() => {
  vi.mocked(getDocumentProxy).mockClear();
});

/**
 * tinyPdf with a standard-security /Encrypt entry whose password check can never pass, so PDF.js asks for a
 * password.
 */
function passwordPdf(): Buffer {
  const pdf = tinyPdf([['Secret quotation']]).toString('latin1');
  const hash = 'ab'.repeat(32);
  const id = '01'.repeat(16);
  const encrypt = `/Encrypt << /Filter /Standard /V 1 /R 2 /O <${hash}> /U <${hash}> /P -4 >> /ID [<${id}> <${id}>]`;
  return Buffer.from(pdf.replace('/Root 1 0 R >>', `/Root 1 0 R ${encrypt} >>`), 'latin1');
}

/**
 * Opens the next document with the real PDF.js and spies on how the reader releases it: the document's loading task
 * (destroy frees the document) and each page it reads (cleanup). With failPage, getPage rejects for that page.
 */
async function spyOnNextDocument(o: { failPage?: number } = {}): Promise<{ destroy: () => Mock | undefined; cleanups: Mock[] }> {
  const { getDocumentProxy: real } = await vi.importActual<typeof import('unpdf')>('unpdf');
  let destroy: Mock | undefined;
  const cleanups: Mock[] = [];
  vi.mocked(getDocumentProxy).mockImplementationOnce(async (data, options) => {
    const pdf = await real(data, options);
    destroy = vi.spyOn(pdf.loadingTask, 'destroy');
    const getPage = pdf.getPage.bind(pdf);
    vi.spyOn(pdf, 'getPage').mockImplementation(async (n) => {
      if (n === o.failPage) throw new Error('damaged page');
      const page = await getPage(n);
      cleanups.push(vi.spyOn(page, 'cleanup'));
      return page;
    });
    return pdf;
  });
  return { destroy: () => destroy, cleanups };
}

/**
 * The next document opened is a stand-in whose pages hold these items, as PDF.js reports them: text items, and
 * marked-content items (`{ type }`, no text).
 */
function fakeNextDocument(pages: ({ str: string; hasEOL: boolean } | { type: string })[][]): void {
  const pdf = {
    numPages: pages.length,
    getPage: async (n: number) => ({ getTextContent: async () => ({ items: pages[n - 1] ?? [] }), cleanup: () => true }),
    loadingTask: { destroy: async () => {} },
  };
  vi.mocked(getDocumentProxy).mockResolvedValueOnce(pdf as unknown as Awaited<ReturnType<typeof getDocumentProxy>>);
}

describe('extractPdfText', () => {
  it('reads the text layer', async () => {
    const r = await extractPdfText(tinyPdf([['Quotation 17', 'Total 1,20,000']]), { maxPages: 200 });
    expect(r.pageCount).toBe(1);
    expect(r.text).toContain('Quotation 17');
    expect(r.text).toContain('Total 1,20,000');
  });

  it('reads text with brackets and backslashes', async () => {
    const r = await extractPdfText(tinyPdf([['Advance (50%) paid \\ balance due']]), { maxPages: 200 });
    expect(r.text).toContain('Advance (50%) paid \\ balance due');
  });

  it('reads at most maxPages pages but reports the real page count', async () => {
    const r = await extractPdfText(tinyPdf([['Page 1'], ['Page 2'], ['Page 3'], ['Page 4'], ['Page 5']]), { maxPages: 2 });
    expect(r.pageCount).toBe(5);
    expect(r.text).toBe('Page 1\n\nPage 2'); // pages are separated by a blank line
  });

  it('corrects a page count that is too high, but takes one that is too low as given and reads only that many pages', async () => {
    // The count comes from the file's own /Count entry. It is advisory: never a limit for paid work on the file
    // (plan amendment 9g).
    const fivePages = [['Page 1'], ['Page 2'], ['Page 3'], ['Page 4'], ['Page 5']];
    expect(await extractPdfText(tinyPdf(fivePages, { count: 9 }), { maxPages: 200 })).toEqual({
      text: 'Page 1\n\nPage 2\n\nPage 3\n\nPage 4\n\nPage 5',
      pageCount: 5,
    });
    expect(await extractPdfText(tinyPdf(fivePages, { count: 2 }), { maxPages: 200 })).toEqual({ text: 'Page 1\n\nPage 2', pageCount: 2 });
    expect(await extractPdfText(tinyPdf(fivePages, { count: 1 }), { maxPages: 200 })).toEqual({ text: 'Page 1', pageCount: 1 });
  });

  it('refuses a file whose page count is below 1, rather than report it as a scan with no text, and frees the document', async () => {
    // A forged /Count 0 on a text file would otherwise read as no pages and no text, which looks like a scan.
    for (const count of [0, -3]) {
      const spies = await spyOnNextDocument();
      await expect(extractPdfText(tinyPdf([['Page 1'], ['Page 2'], ['Page 3']], { count }), { maxPages: 200 })).rejects.toMatchObject({
        name: 'ParseError',
        code: 'pdf_no_pages',
      });
      expect(spies.destroy()).toHaveBeenCalledTimes(1);
    }
  });

  it('frees the document and each page it read', async () => {
    const spies = await spyOnNextDocument();
    await extractPdfText(tinyPdf([['Page 1'], ['Page 2'], ['Page 3']]), { maxPages: 2 });
    expect(spies.destroy()).toHaveBeenCalledTimes(1);
    expect(spies.cleanups).toHaveLength(2);
    for (const cleanup of spies.cleanups) expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('stops reading pages once it holds as much text as is kept, and cuts the text there', async () => {
    const spies = await spyOnNextDocument();
    // 'Page 1' and 'Page 2' have 5 characters each that are not spaces, so the cap of 10 is reached on page 2.
    expect(await extractPdfText(tinyPdf([['Page 1'], ['Page 2'], ['Page 3']]), { maxPages: 200, maxTextChars: 10 })).toEqual({ text: 'Page 1\n\nPa', pageCount: 3 });
    expect(spies.cleanups).toHaveLength(2);
  });

  it('counts only characters that are not spaces towards the text cap, since spaces are tidied away', async () => {
    fakeNextDocument([[{ str: ' '.repeat(50), hasEOL: true }], [{ str: 'Quote 7', hasEOL: false }], [{ str: 'Total', hasEOL: false }]]);
    expect(await extractPdfText(tinyPdf([[]]), { maxPages: 200, maxTextChars: 10 })).toEqual({ text: 'Quote 7\n\nT', pageCount: 3 });
  });

  it('frees the document when a page cannot be read, and still fails', async () => {
    const spies = await spyOnNextDocument({ failPage: 2 });
    await expect(extractPdfText(tinyPdf([['Page 1'], ['Page 2'], ['Page 3']]), { maxPages: 200 })).rejects.toThrow('damaged page');
    expect(spies.destroy()).toHaveBeenCalledTimes(1);
  });

  it('drops blank pages and the blank lines they leave at the start, in the middle and at the end', async () => {
    const r = await extractPdfText(tinyPdf([[], ['Quote 7', 'Total', 'Due'], [], [], ['Thanks'], []]), { maxPages: 200 });
    expect(r).toEqual({ text: 'Quote 7\nTotal\nDue\n\nThanks', pageCount: 6 });
  });

  it('removes spaces and tabs at the ends of lines, keeps at most one blank line in a row, trims the text, and skips marked-content items', async () => {
    fakeNextDocument([
      [
        { str: '  Quote 7  ', hasEOL: true },
        { type: 'beginMarkedContent' }, // no text of its own; PDF.js lists these only with includeMarkedContent
        { str: 'Total \t', hasEOL: true },
        { type: 'endMarkedContent' },
        { str: '', hasEOL: true },
        { str: '', hasEOL: true },
        { str: 'Due  ', hasEOL: false },
      ],
      [{ str: ' \t', hasEOL: true }],
      [{ str: 'Thanks \t ', hasEOL: false }],
    ]);
    const { text } = await extractPdfText(tinyPdf([[]]), { maxPages: 200 });
    expect(text).not.toContain('undefined');
    expect(text).toBe('Quote 7\nTotal\n\nDue\n\nThanks');
  });

  it('returns no text for a scan without a text layer', async () => {
    expect(await extractPdfText(tinyPdf([[]]), { maxPages: 200 })).toEqual({ text: '', pageCount: 1 });
  });

  it('refuses bytes that are not a PDF', async () => {
    await expect(extractPdfText(Buffer.from('this is not a pdf'), { maxPages: 200 })).rejects.toMatchObject({ name: 'ParseError', code: 'not_pdf' });
  });

  it('refuses a password-protected PDF with its own code', async () => {
    await expect(extractPdfText(passwordPdf(), { maxPages: 200 })).rejects.toMatchObject({ name: 'ParseError', code: 'pdf_password' });
  });

  it('opens the file with PDF.js hardening options: errors-only logging and a 16-megapixel image cap', async () => {
    await extractPdfText(tinyPdf([['Hardened']]), { maxPages: 200 });
    expect(getDocumentProxy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getDocumentProxy).mock.calls[0]?.[1]).toEqual(expect.objectContaining({ verbosity: 0, maxImageSize: 16_000_000 }));
  });

  it("gives PDF.js a copy, so the caller's bytes stay intact even when they own their memory", async () => {
    const pdf = tinyPdf([['Still here']]);
    const bytes = new Uint8Array(pdf); // owns its whole ArrayBuffer, so PDF.js could move (detach) it
    await extractPdfText(bytes, { maxPages: 200 });
    expect(vi.mocked(getDocumentProxy).mock.calls[0]?.[0] === bytes).toBe(false);
    expect(bytes.byteLength).toBe(pdf.length);
    expect(Buffer.from(bytes).equals(pdf)).toBe(true);
  });

  it('hands bytes it owns (the worker) to PDF.js without a copy, but still copies a Buffer or a view into shared memory', async () => {
    const pdf = tinyPdf([['Owned']]);
    const owned = new Uint8Array(pdf);
    expect((await extractPdfText(owned, { maxPages: 200 }, { ownsBytes: true })).text).toBe('Owned');
    expect(vi.mocked(getDocumentProxy).mock.calls[0]?.[0] === owned).toBe(true);

    const buffer = Buffer.alloc(pdf.length); // owns its whole ArrayBuffer, but PDF.js refuses a Node Buffer
    pdf.copy(buffer);
    const wider = new Uint8Array(pdf.length + 8);
    wider.set(pdf, 8);
    const view = wider.subarray(8); // shares its ArrayBuffer with other bytes
    for (const [i, bytes] of [buffer, view].entries()) {
      expect((await extractPdfText(bytes, { maxPages: 200 }, { ownsBytes: true })).text).toBe('Owned');
      const given = vi.mocked(getDocumentProxy).mock.calls[i + 1]?.[0];
      expect(given === bytes || Buffer.isBuffer(given)).toBe(false);
      expect(Buffer.from(bytes).equals(pdf)).toBe(true);
    }
  });
});

describe('parseFile (worker thread), PDF', () => {
  it('reads a PDF in the worker', async () => {
    const r = await parseFile({ kind: 'pdf', bytes: tinyPdf([['From the worker']]), maxPages: 200 }, { timeoutMs: 20_000 });
    expect(r.text).toContain('From the worker');
    expect(r.pageCount).toBe(1);
  });

  it('applies the page cap in the worker', async () => {
    const r = await parseFile({ kind: 'pdf', bytes: tinyPdf([['First page'], ['Second page']]), maxPages: 1 }, { timeoutMs: 20_000 });
    expect(r).toEqual({ text: 'First page', pageCount: 2 });
  });

  it('applies the text cap in the worker', async () => {
    const r = await parseFile({ kind: 'pdf', bytes: tinyPdf([['First page'], ['Second page']]), maxPages: 200, maxTextChars: 5 }, { timeoutMs: 20_000 });
    expect(r).toEqual({ text: 'First', pageCount: 2 });
  });

  it('refuses a page count below 1 in the worker, and takes a count that is too low as given', async () => {
    const fivePages = [['Page 1'], ['Page 2'], ['Page 3'], ['Page 4'], ['Page 5']];
    await expect(parseFile({ kind: 'pdf', bytes: tinyPdf(fivePages, { count: 0 }), maxPages: 200 }, { timeoutMs: 20_000 })).rejects.toMatchObject({
      name: 'ParseError',
      code: 'pdf_no_pages',
    });
    expect(await parseFile({ kind: 'pdf', bytes: tinyPdf(fivePages, { count: 1 }), maxPages: 200 }, { timeoutMs: 20_000 })).toEqual({ text: 'Page 1', pageCount: 1 });
  });

  it('stops a decompression bomb whose decoded streams outgrow the memory cap outside the JS heap, and the service keeps running', async () => {
    // 200 MB of spaces in one content stream. PDF.js decodes it into buffers outside the V8 heap, which the worker's
    // heap limits do not cover; unchecked, this file reads "ok" after pushing the process up by about 400 MB.
    const bomb = await flateBombPdf(200);
    expect(bomb.length).toBeLessThan(300_000);
    // The long parse timeout lets the memory stop win even when the full suite keeps every core busy: with 20 s the
    // decode was too slow to reach the cap and the file ended as parse_timeout instead.
    await expect(parseFile({ kind: 'pdf', bytes: bomb, maxPages: 200 }, { timeoutMs: 90_000 })).rejects.toMatchObject({ name: 'ParseError', code: 'parse_memory' });
    expect(await parseFile({ kind: 'pdf', bytes: tinyPdf([['Still here']]), maxPages: 200 }, { timeoutMs: 20_000 })).toEqual({ text: 'Still here', pageCount: 1 });
  }, 150_000);

  it('reads a large drawing whose content stream inflates to tens of MB, without a false memory stop', async () => {
    // About 46 MB on disk, mostly a scan that text extraction never decodes, and 85 MiB of line-drawing commands once
    // inflated. PDF.js holds an inflated stream twice while decoding it, so this file needs about 230 MiB outside the
    // heap: under the 256 MiB cap only because the worker gives PDF.js its own bytes instead of a second copy (280 MiB).
    const pdf = bigDrawingPdf({ drawingMb: 85, imageMb: 44 });
    expect(pdf.length).toBeGreaterThan(44 * 1024 * 1024);
    expect(await parseFile({ kind: 'pdf', bytes: pdf, maxPages: 200 }, { timeoutMs: 60_000 })).toEqual({ text: 'Site plan', pageCount: 1 });
  }, 90_000);

  it('stops checking the parser memory once the parse has settled: after a reply, an error and a timeout', async () => {
    // A check left running would poll a stopped worker every 50 ms for good, one more timer for each file parsed.
    const memoryChecks = vi.spyOn(Worker.prototype, 'getHeapStatistics');
    const checksInNext300Ms = async (): Promise<number> => {
      const before = memoryChecks.mock.calls.length;
      await sleep(300);
      return memoryChecks.mock.calls.length - before;
    };
    expect(await parseFile({ kind: 'pdf', bytes: tinyPdf([['Settled']]), maxPages: 200 }, { timeoutMs: 20_000 })).toEqual({ text: 'Settled', pageCount: 1 });
    expect(await checksInNext300Ms()).toBe(0);

    await expect(parseFile({ kind: 'pdf', bytes: Buffer.from('this is not a pdf'), maxPages: 200 }, { timeoutMs: 20_000 })).rejects.toMatchObject({ code: 'not_pdf' });
    expect(await checksInNext300Ms()).toBe(0);

    const beforeTimeout = memoryChecks.mock.calls.length;
    const hangWorker = new URL('../fixtures/hangWorker.ts', import.meta.url);
    await expect(parseFile({ kind: 'pdf', bytes: new Uint8Array(1), maxPages: 200 }, { timeoutMs: 300, workerUrl: hangWorker })).rejects.toMatchObject({
      code: 'parse_timeout',
    });
    expect(memoryChecks.mock.calls.length).toBeGreaterThan(beforeTimeout); // the check was running while the parser was
    expect(await checksInNext300Ms()).toBe(0);
  });

  it('runs one memory check at a time: a slow answer is not stacked up under more checks every 50 ms', async () => {
    // Each check answers only when the test releases it, as a busy worker can be slow to answer.
    const releases: (() => void)[] = [];
    const memoryChecks = vi
      .spyOn(Worker.prototype, 'getHeapStatistics')
      .mockImplementation(() => new Promise<HeapInfo>((resolve) => releases.push(() => resolve({ external_memory: 0 } as HeapInfo))));
    const hangWorker = new URL('../fixtures/hangWorker.ts', import.meta.url);
    const parsing = parseFile({ kind: 'pdf', bytes: new Uint8Array(1), maxPages: 200 }, { timeoutMs: 3_000, workerUrl: hangWorker });

    await vi.waitFor(() => expect(memoryChecks).toHaveBeenCalledTimes(1));
    await sleep(300); // six more ticks
    expect(memoryChecks).toHaveBeenCalledTimes(1);

    releases[0]?.(); // the first check answers; the next tick starts the second
    await vi.waitFor(() => expect(memoryChecks).toHaveBeenCalledTimes(2));
    await sleep(300);
    expect(memoryChecks).toHaveBeenCalledTimes(2);

    await expect(parsing).rejects.toMatchObject({ name: 'ParseError', code: 'parse_timeout' });
  });

  it("passes the PDF reader's error codes back", async () => {
    await expect(parseFile({ kind: 'pdf', bytes: Buffer.from('this is not a pdf'), maxPages: 200 }, { timeoutMs: 20_000 })).rejects.toMatchObject({
      name: 'ParseError',
      code: 'not_pdf',
    });
    await expect(parseFile({ kind: 'pdf', bytes: passwordPdf(), maxPages: 200 }, { timeoutMs: 20_000 })).rejects.toMatchObject({
      name: 'ParseError',
      code: 'pdf_password',
    });
  });
});
