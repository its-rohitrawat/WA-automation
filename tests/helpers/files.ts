import { once } from 'node:events';
import { createDeflate, deflateSync } from 'node:zlib';
import JSZip from 'jszip';

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ' +
  'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';

const xmlEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A minimal .docx with one paragraph per string. */
export async function tinyDocx(paragraphs: string[]): Promise<Buffer> {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(p)}</w:t></w:r></w:p>`).join('');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * A minimal valid PDF, one entry per page. Each page lists its text lines. An empty list draws a line and has no
 * text layer, like a scan. With `count`, the page tree's /Count entry claims that many pages instead of the real
 * number, as a forged file can.
 */
export function tinyPdf(pages: string[][], o: { count?: number } = {}): Buffer {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  return pdfOfStreams(
    pages.map((lines) => ({
      data: lines.length ? `BT /F1 12 Tf 14 TL 72 720 Td ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET` : '0 0 m 200 200 l S',
      filter: '',
    })),
    o.count,
  );
}

/**
 * A one-page PDF whose content stream is `inflatedMb` MB of spaces and then one line of text, compressed with deflate.
 * A decompression bomb: spaces compress about 1,000:1, so 200 MB of them fit in about 200 KB.
 */
export async function flateBombPdf(inflatedMb: number): Promise<Buffer> {
  const deflate = createDeflate({ level: 9 });
  const chunks: Buffer[] = [];
  deflate.on('data', (chunk: Buffer) => chunks.push(chunk));
  const ended = once(deflate, 'end');
  const spaces = Buffer.alloc(1024 * 1024, 0x20);
  for (let i = 0; i < inflatedMb; i++) if (!deflate.write(spaces)) await once(deflate, 'drain');
  deflate.end('BT /F1 12 Tf 72 720 Td (Bomb end) Tj ET');
  await ended;
  return pdfOfStreams([{ data: Buffer.concat(chunks).toString('latin1'), filter: ' /Filter /FlateDecode' }]);
}

/**
 * A one-page drawing like a CAD export, as a real file can be: a content stream of `drawingMb` MiB of line-drawing
 * commands (compressed with deflate) after one line of text, plus an uncompressed `imageMb` MiB scan on the same
 * page. Text extraction never decodes the scan; it only makes the file itself large.
 */
export function bigDrawingPdf(o: { drawingMb: number; imageMb: number }): Buffer {
  const MiB = 1024 * 1024;
  const drawing = Buffer.concat([Buffer.from('q 612 0 0 792 0 0 cm /Im1 Do Q\nBT /F1 12 Tf 72 720 Td (Site plan) Tj ET\n'), Buffer.alloc(o.drawingMb * MiB, '72 72 m 540 720 l S\n')]);
  const content = deflateSync(drawing, { level: 1 }).toString('latin1');
  const width = 4096;
  const scan = Buffer.alloc(o.imageMb * MiB, 0x7f).toString('latin1');
  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Kids [4 0 R] /Count 1 >>';
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[4] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 5 0 R >>';
  objects[5] = `<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n${content}\nendstream`;
  objects[6] =
    `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${scan.length / width} /ColorSpace /DeviceGray /BitsPerComponent 8 ` +
    `/Length ${scan.length} >>\nstream\n${scan}\nendstream`;
  return pdfOfObjects(objects);
}

/**
 * A PDF with one page per content stream, and a /Count of `count` (default: the real number of pages). Stream data
 * travels as latin1 text, so binary bytes stay intact.
 */
function pdfOfStreams(streams: { data: string; filter: string }[], count = streams.length): Buffer {
  const objects: string[] = [];
  const pageIds = streams.map((_, i) => 4 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${count} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  streams.forEach(({ data, filter }, i) => {
    const pageId = 4 + i * 2;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${Buffer.byteLength(data, 'latin1')}${filter} >>\nstream\n${data}\nendstream`;
  });
  return pdfOfObjects(objects);
}

/** A PDF of the given objects (numbered from 1, object 1 the catalog), with its cross-reference table. Latin1 text. */
function pdfOfObjects(objects: string[]): Buffer {
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(out, 'latin1');
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
