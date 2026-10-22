import { getDocumentProxy } from 'unpdf';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { extractPdfText } from '../../src/media/parse/pdf.ts';
import { parseFile } from '../../src/media/parse/runner.ts';
import { flateBombPdf, tinyPdf } from '../helpers/files.ts';

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

  it('frees the document and each page it read', async () => {
    const spies = await spyOnNextDocument();
    await extractPdfText(tinyPdf([['Page 1'], ['Page 2'], ['Page 3']]), { maxPages: 2 });
    expect(spies.destroy()).toHaveBeenCalledTimes(1);
    expect(spies.cleanups).toHaveLength(2);
    for (const cleanup of spies.cleanups) expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('frees the document when a page cannot be read, and still fails', async () => {
    const spies = await spyOnNextDocument({ failPage: 2 });
    await expect(extractPdfText(tinyPdf([['Page 1'], ['Page 2'], ['Page 3']]), { maxPages: 200 })).rejects.toThrow('damaged page');
    expect(spies.destroy()).toHaveBeenCalledTimes(1);
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

  it('stops a decompression bomb whose decoded streams outgrow the memory cap outside the JS heap, and the service keeps running', async () => {
    // 200 MB of spaces in one content stream. PDF.js decodes it into buffers outside the V8 heap, which the worker's
    // heap limits do not cover; unchecked, this file reads "ok" after pushing the process up by about 400 MB.
    const bomb = await flateBombPdf(200);
    expect(bomb.length).toBeLessThan(300_000);
    await expect(parseFile({ kind: 'pdf', bytes: bomb, maxPages: 200 }, { timeoutMs: 20_000 })).rejects.toMatchObject({ name: 'ParseError', code: 'parse_memory' });
    expect(await parseFile({ kind: 'pdf', bytes: tinyPdf([['Still here']]), maxPages: 200 }, { timeoutMs: 20_000 })).toEqual({ text: 'Still here', pageCount: 1 });
  }, 40_000);

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
