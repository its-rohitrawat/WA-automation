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
 * a ceiling for paid work on the file.
 */
export async function extractPdfText(bytes: Uint8Array, limits: { maxPages: number }): Promise<ParseResult> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // A plain Uint8Array copy: PDF.js takes over (detaches) the buffer it is given, and refuses a Node Buffer.
    pdf = await getDocumentProxy(new Uint8Array(bytes), PDF_OPTIONS);
  } catch (e) {
    throw new ParseError((e as { name?: string } | null)?.name === 'PasswordException' ? 'pdf_password' : 'not_pdf');
  }
  try {
    const pageCount = pdf.numPages;
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
