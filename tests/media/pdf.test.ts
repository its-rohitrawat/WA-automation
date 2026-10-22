import { getDocumentProxy } from 'unpdf';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractPdfText } from '../../src/media/parse/pdf.ts';
import { parseFile } from '../../src/media/parse/runner.ts';
import { tinyPdf } from '../helpers/files.ts';

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
    expect(r.text).toContain('Page 1');
    expect(r.text).toContain('Page 2');
    expect(r.text).not.toContain('Page 3');
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
