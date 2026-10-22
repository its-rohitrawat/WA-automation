import { describe, expect, it } from 'vitest';
import { fileDescription, type FileFacts } from '../../src/media/labels.ts';

const facts = (o: Partial<FileFacts> = {}): FileFacts => ({
  kind: 'document', status: 'done', mimeType: 'application/pdf', fileSize: 24_576, seconds: null, pageCount: 3, textKind: 'extract',
  textStart: 'Homepage brief\nHero banner', note: null, revoked: false, ...o,
});

describe('fileDescription', () => {
  it('starts a document with its type and pages, then the start of its text on one line', () => {
    expect(fileDescription(facts())).toBe('PDF, 3 pages: Homepage brief Hero banner');
    expect(fileDescription(facts({ pageCount: 1 }))).toBe('PDF, 1 page: Homepage brief Hero banner');
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
