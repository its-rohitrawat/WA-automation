import { Readable } from 'node:stream';
import JSZip from 'jszip';
import { ParseError, type ParseResult } from './types.ts';

/** Paragraph ends, empty paragraphs, tabs, breaks and text runs of word/document.xml, in document order. */
const TOKENS = /<w:p\b[^>]*\/>|<\/w:p>|<w:tab\/>|<w:br\b[^>]*\/>|<w:cr\/>|<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (_m, e: string) => {
    const named = NAMED[e];
    if (named !== undefined) return named;
    const cp = e.startsWith('#x') ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
    return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
  });
}

/** Plain text of word/document.xml: one line per paragraph, tabs kept. */
export function docxXmlToText(xml: string): string {
  let out = '';
  for (const m of xml.matchAll(TOKENS)) {
    if (m[1] !== undefined) out += decodeXml(m[1]);
    else if (m[0].startsWith('<w:tab')) out += '\t';
    else out += '\n';
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Runs inside the parser worker. */
export async function extractDocxText(bytes: Uint8Array, limits: { maxXmlBytes: number; maxEntries: number }): Promise<ParseResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new ParseError('not_docx');
  }
  if (Object.keys(zip.files).length > limits.maxEntries) throw new ParseError('too_many_entries');
  const doc = zip.file('word/document.xml');
  if (!doc) throw new ParseError('not_docx');
  const chunks: Buffer[] = [];
  let total = 0;
  // jszip's nodeStream() is an old-style stream that cannot be iterated with for await, so wrap it in a modern one.
  const stream = new Readable().wrap(doc.nodeStream('nodebuffer'));
  try {
    // Zip-bomb guard: count the inflated bytes as they stream out and stop at the cap.
    for await (const chunk of stream) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += b.length;
      if (total > limits.maxXmlBytes) throw new ParseError('too_large_uncompressed');
      chunks.push(b);
    }
  } finally {
    stream.destroy();
  }
  return { text: docxXmlToText(Buffer.concat(chunks).toString('utf8')), pageCount: null };
}
