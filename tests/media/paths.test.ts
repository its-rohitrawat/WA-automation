import { describe, expect, it } from 'vitest';
import { displayName, formatDuration, formatSize, typeLabel } from '../../src/media/labels.ts';
import { extForMime, mediaRelPath, safeSegment, sanitizeFileName } from '../../src/media/paths.ts';

const OCT = '2026-10-10T08:00:00.000Z';

describe('mediaRelPath', () => {
  it('uses the client code, the India month, the message id and the media id', () => {
    expect(mediaRelPath({ clientCode: 'SHA', ts: '2026-10-31T19:00:00.000Z', waId: '3EB0C4F2A1', mediaId: 7, ext: 'jpg' })).toBe('media/SHA/2026-11/3EB0C4F2A1-7.jpg');
    expect(mediaRelPath({ clientCode: 'SHA', ts: OCT, waId: '3EB0C4F2A1', mediaId: 17, ext: 'jpg' })).toBe('media/SHA/2026-10/3EB0C4F2A1-17.jpg');
  });

  it('gives message ids that differ only in case different files, because Windows ignores case', () => {
    const at = { clientCode: 'SHA', ts: OCT, ext: 'jpg' };
    const upper = mediaRelPath({ ...at, waId: '3EB0ABC', mediaId: 1 });
    const lower = mediaRelPath({ ...at, waId: '3eb0abc', mediaId: 2 });
    expect(upper).toBe('media/SHA/2026-10/3EB0ABC-1.jpg');
    expect(lower).toBe('media/SHA/2026-10/3eb0abc-2.jpg');
    const names = [
      upper,
      lower,
      mediaRelPath({ ...at, waId: '3Eb0aBc', mediaId: 12 }),
      mediaRelPath({ ...at, waId: '3eb0abc-1', mediaId: 3 }),
      mediaRelPath({ ...at, waId: 'a:b', mediaId: 4 }),
      mediaRelPath({ ...at, waId: 'M4', mediaId: 5 }),
    ];
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
  });

  it('falls back to the row id for message ids that are unsafe on Windows', () => {
    for (const waId of ['a:b', '..', 'CON', 'lpt1', 'x/y', 'a.b', '']) {
      expect(mediaRelPath({ clientCode: 'SHA', ts: OCT, waId, mediaId: 7, ext: 'pdf' })).toBe('media/SHA/2026-10/m7.pdf');
    }
  });

  it('keeps a message id of up to 100 characters and leaves out a longer one, so the path stays short', () => {
    const at = { clientCode: 'SHA', ts: OCT, mediaId: 7, ext: 'pdf' };
    const id100 = '3EB0C4F2A1'.repeat(10);
    expect(mediaRelPath({ ...at, waId: id100 })).toBe(`media/SHA/2026-10/${id100}-7.pdf`);
    expect(mediaRelPath({ ...at, waId: `${id100}B` })).toBe('media/SHA/2026-10/m7.pdf');
  });

  it('never uses a device name as the client folder, or an odd extension', () => {
    expect(mediaRelPath({ clientCode: 'CON', ts: OCT, waId: 'A1', mediaId: 7, ext: 'exe;rm' })).toBe('media/_CON/2026-10/A1-7.bin');
  });

  it('builds a fallback client folder from letters and digits only, so it never leaves the media folder', () => {
    const at = { ts: OCT, waId: 'A1', mediaId: 7, ext: 'pdf' };
    expect(mediaRelPath({ ...at, clientCode: '../x' })).toBe('media/_x/2026-10/A1-7.pdf');
    expect(mediaRelPath({ ...at, clientCode: 'a/../../etc/passwd' })).toBe('media/_aetcpass/2026-10/A1-7.pdf');
    for (const clientCode of ['', '..', '../', '..\\', ':*?']) {
      expect(mediaRelPath({ ...at, clientCode })).toBe('media/_client/2026-10/A1-7.pdf');
    }
    for (const clientCode of ['..\\..\\Windows', 'C:\\Users', 'x.y', 'a b']) {
      expect(mediaRelPath({ ...at, clientCode }).split('/')[1]).toMatch(/^_[A-Za-z0-9]{1,8}$/);
    }
  });

  it('keeps an extension of up to 5 lower-case letters or digits, and uses bin for anything else', () => {
    const at = { clientCode: 'SHA', ts: OCT, waId: 'A1', mediaId: 7 };
    expect(mediaRelPath({ ...at, ext: 'abcde' })).toBe('media/SHA/2026-10/A1-7.abcde');
    expect(mediaRelPath({ ...at, ext: 'abcdef' })).toBe('media/SHA/2026-10/A1-7.bin');
    expect(mediaRelPath({ ...at, ext: 'JPG' })).toBe('media/SHA/2026-10/A1-7.bin');
    expect(mediaRelPath({ ...at, ext: '' })).toBe('media/SHA/2026-10/A1-7.bin');
  });

  it('safeSegment keeps plain names and replaces device names', () => {
    expect(safeSegment('SHA', 'x')).toBe('SHA');
    expect(safeSegment('nul', 'x')).toBe('x');
    expect(safeSegment('COM3', 'x')).toBe('x');
    expect(safeSegment('com0', 'x')).toBe('x');
    expect(safeSegment('LPT0', 'x')).toBe('x');
  });

  it('safeSegment keeps a name of up to 100 characters and replaces a longer one', () => {
    expect(safeSegment('A'.repeat(100), 'x')).toBe('A'.repeat(100));
    expect(safeSegment('A'.repeat(101), 'x')).toBe('x');
  });
});

describe('extForMime', () => {
  it('takes the extension from the MIME type, never from the file name', () => {
    expect(extForMime('image/jpeg', 'image')).toBe('jpg');
    expect(extForMime('audio/ogg; codecs=opus', 'voice')).toBe('ogg');
    expect(extForMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'document')).toBe('docx');
    expect(extForMime(null, 'image')).toBe('jpg');
    expect(extForMime('application/x-msdownload', 'document')).toBe('bin');
  });

  it('finds nothing for a declared type that names an object property', () => {
    for (const mime of ['constructor', '__proto__', 'constructor; x=y']) {
      expect(extForMime(mime, 'document')).toBe('bin');
      expect(extForMime(mime, 'image')).toBe('jpg');
    }
  });
});

describe('sanitizeFileName', () => {
  it('removes path characters, control characters and direction overrides', () => {
    expect(sanitizeFileName('Q3/brief\\final:v2*?.pdf')).toBe('Q3_brief_final_v2__.pdf');
    expect(sanitizeFileName('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
    expect(sanitizeFileName('a\nb\tc.pdf')).toBe('abc.pdf');
    expect(sanitizeFileName('  ..hidden.pdf.. ')).toBe('hidden.pdf');
  });

  it('also removes the other invisible format characters: direction marks, joiners and tag characters', () => {
    expect(sanitizeFileName('bill\u061C\u2060\u00AD.pdf')).toBe('bill.pdf');
    // Tag characters spell hidden ASCII ("HI" here) that a reader cannot see.
    expect(sanitizeFileName('bill\u{E0001}\u{E0048}\u{E0049}\u{E007F}.pdf')).toBe('bill.pdf');
    expect(sanitizeFileName('\u200B\u2066\uFEFF')).toBeNull();
  });

  it('removes U+FFFE and U+FFFF, which XML does not allow in the workbook', () => {
    expect(sanitizeFileName('a\uFFFFb\uFFFE.pdf')).toBe('ab.pdf');
    expect(sanitizeFileName('\uFFFF')).toBeNull();
  });

  it('turns line separators, no-break spaces and runs of spaces into one plain space', () => {
    expect(sanitizeFileName('a\u2028b   c.pdf')).toBe('a b c.pdf');
    expect(sanitizeFileName('a\u00A0\u2029b.pdf')).toBe('a b.pdf');
  });

  it('returns null for nothing left, and cuts long names by code points', () => {
    expect(sanitizeFileName('...')).toBeNull();
    expect(sanitizeFileName(null)).toBeNull();
    expect(sanitizeFileName(`${'é'.repeat(130)}.pdf`)).toHaveLength(120);
    expect([...(sanitizeFileName('😀'.repeat(130)) ?? '')]).toHaveLength(120);
  });

  it('drops a space or a dot that the cut leaves at the end', () => {
    expect(sanitizeFileName(`${'a'.repeat(119)} b.pdf`)).toBe('a'.repeat(119));
    expect(sanitizeFileName(`${'a'.repeat(119)}.b.pdf`)).toBe('a'.repeat(119));
    expect(sanitizeFileName(`${'a'.repeat(118)}. b.pdf`)).toBe('a'.repeat(118));
  });

  it('cleans a name with a very long run of dots and spaces quickly', () => {
    // An end-trimming regex such as /[.\s]+$/ takes quadratic time on this name: about 20 seconds.
    const name = `report${'. '.repeat(50_000)}final.pdf`;
    const started = performance.now();
    expect(sanitizeFileName(name)).toBe('report');
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('labels', () => {
  it('names file types in plain words', () => {
    expect(typeLabel('application/pdf', 'document')).toBe('PDF');
    expect(typeLabel('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'document')).toBe('Excel sheet');
    expect(typeLabel('image/png', 'document')).toBe('Image');
    expect(typeLabel(null, 'document')).toBe('File');
    expect(typeLabel(null, 'video')).toBe('Video');
  });

  it('names a declared type that is an object property as a plain file', () => {
    expect(typeLabel('constructor', 'document')).toBe('File');
    expect(typeLabel('__proto__', 'document')).toBe('File');
  });

  it('formats sizes and durations', () => {
    expect(formatSize(900)).toBe('900 B');
    expect(formatSize(24_576)).toBe('24 KB');
    expect(formatSize(3_355_443)).toBe('3.2 MB');
    expect(formatDuration(42)).toBe('0:42');
    expect(formatDuration(125)).toBe('2:05');
    expect(formatDuration(-5)).toBe('0:00');
  });

  it('shows the sanitised name, or a dated name for a file without one', () => {
    expect(displayName({ kind: 'document', fileName: 'Q3/brief.pdf', mimeType: 'application/pdf', ts: '2026-10-19T08:35:00.000Z', mediaId: 7 })).toBe('Q3_brief.pdf');
    expect(displayName({ kind: 'image', fileName: null, mimeType: 'image/jpeg', ts: '2026-10-19T08:35:00.000Z', mediaId: 7 })).toBe('image-2026-10-19-1405-7.jpg');
    expect(displayName({ kind: 'document', fileName: '\u202E', mimeType: 'constructor', ts: '2026-10-19T08:35:00.000Z', mediaId: 7 })).toBe('document-2026-10-19-1405-7.bin');
  });
});
