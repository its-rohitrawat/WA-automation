import { getDocumentProxy } from 'unpdf';
import { ParseError, type ParseResult } from './types.ts';

/**
 * PDF.js options for untrusted files. verbosity 0: errors only. maxImageSize: images over 16 megapixels are not
 * decoded. That covers images only, which text extraction does not decode anyway. Content and font streams have no
 * size cap in PDF.js, so a decompression bomb in them is stopped by the runner's memory check (parseFile,
 * MEDIA_LIMITS.maxParserExternalBytes), not here. PDF.js 6 (in unpdf 1.8.1) no longer evaluates font code and has no
 * isEvalSupported option.
 */
const PDF_OPTIONS = { verbosity: 0, maxImageSize: 16_000_000 };

/**
 * Runs inside the parser worker. Reads the text layer of the first maxPages pages.
 *
 * pageCount is advisory: PDF.js takes it from the file's own /Count entry, which the sender controls. A forged count
 * that is too high is corrected, but one that is too low is not, and the pages past it are never read. Never use it as
 * a ceiling for paid work on the file. A count below 1 is refused ('pdf_no_pages'): it would read as a file with no
 * text, which looks like a scan, while Claude would read every real page.
 *
 * PDF.js takes over (detaches) the buffer it is given and refuses a Node Buffer, so it gets a plain Uint8Array copy and
 * the caller's bytes stay intact. With ownsBytes (the worker, whose bytes are its own and never read again), a plain
 * Uint8Array that owns its whole buffer is handed over as it is: a second copy of a 50 MB file would use a large part
 * of the worker's memory cap outside the heap (MEDIA_LIMITS.maxParserExternalBytes) and stop real files. The bytes may
 * be emptied then.
 */
export async function extractPdfText(bytes: Uint8Array, limits: { maxPages: number }, o: { ownsBytes?: boolean } = {}): Promise<ParseResult> {
  const whole = bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
  const data = o.ownsBytes === true && whole && !Buffer.isBuffer(bytes) ? bytes : new Uint8Array(bytes);
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await getDocumentProxy(data, PDF_OPTIONS);
  } catch (e) {
    throw new ParseError((e as { name?: string } | null)?.name === 'PasswordException' ? 'pdf_password' : 'not_pdf');
  }
  try {
    const pageCount = pdf.numPages;
    if (!(pageCount >= 1)) throw new ParseError('pdf_no_pages');
    const pages: string[] = [];
    for (let i = 1; i <= Math.min(pageCount, limits.maxPages); i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((it) => ('str' in it ? `${it.str}${it.hasEOL ? '\n' : ''}` : '')).join(''));
      page.cleanup();
    }
    const text = pages.join('\n\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return { text, pageCount };
  } finally {
    // PDF.js 6 has no PDFDocumentProxy.destroy(); destroying the loading task frees the document.
    await pdf.loadingTask.destroy();
  }
}
