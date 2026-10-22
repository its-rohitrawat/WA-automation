import { describe, expect, it } from 'vitest';
import { fileDescription, type FileFacts } from '../../src/media/labels.ts';

const facts = (o: Partial<FileFacts> = {}): FileFacts => ({
  kind: 'document', status: 'done', mimeType: 'application/pdf', fileSize: 24_576, seconds: null, pageCount: 3, textKind: 'extract',
  textStart: 'Homepage brief\nHero banner', note: null, errorCode: null, revoked: false, ...o,
});

describe('fileDescription', () => {
  it('starts a document with its type and pages, then the start of its text on one line', () => {
    expect(fileDescription(facts())).toBe('PDF, 3 pages: Homepage brief Hero banner');
    expect(fileDescription(facts({ pageCount: 1 }))).toBe('PDF, 1 page: Homepage brief Hero banner');
  });

  it('falls back to type and pages, or type and size, when the text holds only spaces or hidden characters (T14-02)', () => {
    // A PDF whose broken font gave only NULs (stored as spaces), or text made only of zero-width characters.
    expect(fileDescription(facts({ pageCount: 2, textStart: ' '.repeat(400) }))).toBe('PDF, 2 pages');
    expect(fileDescription(facts({ pageCount: 2, textStart: ' \u200B\u2060 \u200D\u200C\uFEFF ' }))).toBe('PDF, 2 pages');
    expect(fileDescription(facts({ pageCount: null, textStart: '\n\t \u202E' }))).toBe('PDF, 24 KB');
    expect(fileDescription(facts({ kind: 'image', mimeType: 'image/jpeg', pageCount: null, textKind: 'description', textStart: '\u200B \u2066\u2069' })))
      .toBe('Image, 24 KB');
  });

  it('cuts the start of a document text to 200 characters', () => {
    expect(fileDescription(facts({ textStart: 'y'.repeat(400) }))).toBe(`PDF, 3 pages: ${'y'.repeat(200)}…`);
  });

  it('uses the vision description for images, cut to 300 characters', () => {
    expect(fileDescription(facts({ kind: 'image', mimeType: 'image/jpeg', pageCount: null, textKind: 'description', textStart: 'A payment receipt. Visible text: Paid ₹42,000' })))
      .toBe('A payment receipt. Visible text: Paid ₹42,000');
    expect(fileDescription(facts({ kind: 'image', textKind: 'description', textStart: 'x'.repeat(400) }))).toBe(`${'x'.repeat(300)}…`);
  });

  it('counts characters, not UTF-16 units, when cutting', () => {
    const emoji = '😀'.repeat(301);
    expect(fileDescription(facts({ kind: 'image', textKind: 'description', textStart: emoji }))).toBe(`${'😀'.repeat(300)}…`);
  });

  it('drops control and format characters from the text, so direction overrides cannot disguise it', () => {
    expect(fileDescription(facts({ textStart: 'Paid\u202E 000,24\u200B amount\uFFFE\uFFFF \u0007end' }))).toBe('PDF, 3 pages: Paid 000,24 amount end');
    expect(fileDescription(facts({ kind: 'image', mimeType: 'image/jpeg', textKind: 'description', textStart: '\u2066A receipt\u2069 \u202Etxet' })))
      .toBe('A receipt txet');
  });

  it('keeps the zero-width joiner and non-joiner in file text, and still drops overrides and lone surrogates (T14-12, T4-02)', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'; // one family emoji, joined by ZWJ
    expect(fileDescription(facts({ kind: 'image', mimeType: 'image/jpeg', pageCount: null, textKind: 'description', textStart: `A ${family} photo\u202E` })))
      .toBe(`A ${family} photo`);
    // Devanagari "ksha" written with a ZWJ (half form) and with a ZWNJ (visible virama).
    expect(fileDescription(facts({ textStart: 'Total \u0915\u094D\u200D\u0937 \u0915\u094D\u200C\u0937\uD800' })))
      .toBe('PDF, 3 pages: Total \u0915\u094D\u200D\u0937 \u0915\u094D\u200C\u0937');
  });

  it('says plainly what happened to files that were not read', () => {
    expect(fileDescription(facts({ status: 'pending', textKind: null, textStart: null }))).toBe('PDF, being read');
    expect(fileDescription(facts({ status: 'unavailable', textKind: null, textStart: null }))).toBe('PDF, could not be downloaded from WhatsApp');
    expect(fileDescription(facts({ status: 'failed', textKind: null, textStart: null }))).toBe('PDF, could not be read');
    expect(fileDescription(facts({ kind: 'video', status: 'metadata', mimeType: 'video/mp4', seconds: 42, textKind: null, textStart: null }))).toBe('Video, 0:42 (not downloaded)');
    expect(fileDescription(facts({ kind: 'video', status: 'metadata', mimeType: 'video/mp4', seconds: null, textKind: null, textStart: null }))).toBe('Video (not downloaded)');
    expect(fileDescription(facts({ textKind: null, textStart: null, pageCount: 87, note: 'scan_too_long' }))).toBe('PDF, 87 pages, scanned, too long to read');
    expect(fileDescription(facts({ mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pageCount: null, textKind: null, textStart: null })))
      .toBe('Excel sheet, 24 KB');
  });

  it('says a file over the download limit was too large to download, not that WhatsApp failed (T14-03)', () => {
    const tooLarge = { status: 'unavailable', errorCode: 'too_large', textKind: null, textStart: null, pageCount: null } as const;
    expect(fileDescription(facts({ ...tooLarge, fileSize: 62 * 1024 * 1024 }))).toBe('PDF, 62.0 MB, too large to download (over 50 MB)');
    // Found too large during the download: a declared size under the limit is the sender's claim, so it is not shown.
    expect(fileDescription(facts({ ...tooLarge, fileSize: 24_576 }))).toBe('PDF, too large to download (over 50 MB)');
    expect(fileDescription(facts({ ...tooLarge, fileSize: null }))).toBe('PDF, too large to download (over 50 MB)');
    expect(fileDescription(facts({ ...tooLarge, kind: 'image', mimeType: 'image/jpeg', fileSize: 51 * 1024 * 1024 })))
      .toBe('Image, 51.0 MB, too large to download (over 50 MB)');
    expect(fileDescription(facts({ ...tooLarge, errorCode: 'expired' }))).toBe('PDF, could not be downloaded from WhatsApp');
  });

  it('shows (deleted by sender) instead of the description when the message was deleted for everyone (amendment 14b)', () => {
    expect(fileDescription(facts({ revoked: true }))).toBe('(deleted by sender)');
    expect(fileDescription(facts({ kind: 'image', mimeType: 'image/jpeg', textKind: 'description', textStart: 'A payment receipt', revoked: true }))).toBe('(deleted by sender)');
    expect(fileDescription(facts({ status: 'unavailable', textKind: null, textStart: null, revoked: true }))).toBe('(deleted by sender)');
    expect(fileDescription(facts({ textKind: null, textStart: null, note: 'revoked', revoked: true }))).toBe('(deleted by sender)');
  });

  it('marks forwarded files that were not described (D2, amendment 14c)', () => {
    expect(fileDescription(facts({ kind: 'image', mimeType: 'image/jpeg', pageCount: null, textKind: null, textStart: null, note: 'forwarded_not_described' })))
      .toBe('(forwarded image)');
    // An image sent "as document" is read like an image, so it is a forwarded image too.
    expect(fileDescription(facts({ kind: 'document', mimeType: 'image/png', pageCount: null, textKind: null, textStart: null, note: 'forwarded_not_described' })))
      .toBe('(forwarded image)');
    expect(fileDescription(facts({ pageCount: 4, textKind: null, textStart: null, note: 'forwarded_not_described' }))).toBe('(forwarded scanned PDF)');
  });

  it('still says what happened to a file that is waiting or could not be downloaded', () => {
    expect(fileDescription(facts({ kind: 'image', mimeType: 'image/jpeg', status: 'pending', textKind: null, textStart: null }))).toBe('Image, being read');
    expect(fileDescription(facts({ kind: 'image', mimeType: 'image/jpeg', status: 'unavailable', textKind: null, textStart: null })))
      .toBe('Image, could not be downloaded from WhatsApp');
  });
});
