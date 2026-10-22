import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { docxXmlToText, extractDocxText } from '../../src/media/parse/docx.ts';
import { parseFile } from '../../src/media/parse/runner.ts';
import { ParseError } from '../../src/media/parse/types.ts';
import { tinyDocx } from '../helpers/files.ts';

const LIMITS = { maxXmlBytes: 1_000_000, maxEntries: 50 };

describe('docxXmlToText', () => {
  it('keeps paragraphs, tabs and breaks, and decodes entities', () => {
    const xml =
      '<w:body><w:p><w:r><w:t>Logo</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve"> final &amp; approved</w:t></w:r></w:p>' +
      '<w:p w:rsidR="00A1"><w:r><w:t>Line one</w:t><w:br/><w:t>Line two &#x2713; &#2350;</w:t></w:r></w:p><w:p/>' +
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cell B</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body>';
    expect(docxXmlToText(xml)).toBe('Logo\t final & approved\nLine one\nLine two ✓ म\n\nCell A\nCell B');
  });
});

describe('extractDocxText', () => {
  it('reads the paragraphs of a Word file', async () => {
    expect(await extractDocxText(await tinyDocx(['Logo final', 'Payment: ₹42,000 & GST']), LIMITS)).toEqual({ text: 'Logo final\nPayment: ₹42,000 & GST', pageCount: null });
  });

  it('stops a zip bomb at the inflated-size cap', async () => {
    await expect(extractDocxText(await tinyDocx(['x'.repeat(2_000_000)]), LIMITS)).rejects.toMatchObject({ name: 'ParseError', code: 'too_large_uncompressed' });
  });

  it('refuses archives with too many entries, bytes that are not a zip, and zips without a document', async () => {
    const many = new JSZip();
    for (let i = 0; i < 60; i++) many.file(`f${i}.txt`, 'x');
    many.file('word/document.xml', '<w:p/>');
    await expect(extractDocxText(await many.generateAsync({ type: 'nodebuffer' }), LIMITS)).rejects.toMatchObject({ code: 'too_many_entries' });
    await expect(extractDocxText(Buffer.from('not a zip at all'), LIMITS)).rejects.toMatchObject({ code: 'not_docx' });
    const empty = new JSZip();
    empty.file('readme.txt', 'hi');
    await expect(extractDocxText(await empty.generateAsync({ type: 'nodebuffer' }), LIMITS)).rejects.toBeInstanceOf(ParseError);
  });
});

describe('parseFile (worker thread)', () => {
  it('reads a Word file in a worker', async () => {
    const bytes = await tinyDocx(['Hello from the worker']);
    expect(await parseFile({ kind: 'docx', bytes, ...LIMITS }, { timeoutMs: 15_000 })).toEqual({ text: 'Hello from the worker', pageCount: null });
  });

  it("passes the reader's error code back", async () => {
    const bomb = await tinyDocx(['x'.repeat(2_000_000)]);
    await expect(parseFile({ kind: 'docx', bytes: bomb, ...LIMITS }, { timeoutMs: 15_000 })).rejects.toMatchObject({ name: 'ParseError', code: 'too_large_uncompressed' });
  });

  it('stops a parser that never finishes', async () => {
    const started = Date.now();
    const hang = new URL('../fixtures/hangWorker.ts', import.meta.url);
    await expect(parseFile({ kind: 'docx', bytes: new Uint8Array(1), ...LIMITS }, { timeoutMs: 500, workerUrl: hang })).rejects.toMatchObject({ code: 'parse_timeout' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('moves file bytes that own their memory to the worker instead of copying them', async () => {
    const owned = new Uint8Array(await tinyDocx(['Moved, not copied']));
    expect(owned.byteOffset === 0 && owned.byteLength === owned.buffer.byteLength).toBe(true);
    expect(await parseFile({ kind: 'docx', bytes: owned, ...LIMITS }, { timeoutMs: 15_000 })).toEqual({ text: 'Moved, not copied', pageCount: null });
    // Transferred, not cloned: the memory now belongs to the worker, so the caller's view is empty.
    expect(owned.byteLength).toBe(0);
  });

  it('still parses a Buffer that shares its memory (a pooled Buffer), and leaves it intact', async () => {
    const pooled = Buffer.from(await tinyDocx(['From the shared pool']));
    const copy = Buffer.from(pooled);
    // Small Buffers live in Node's shared pool, which cannot be transferred, so the runner copies them once.
    expect(pooled.byteLength).toBeLessThan(pooled.buffer.byteLength);
    expect(await parseFile({ kind: 'docx', bytes: pooled, ...LIMITS }, { timeoutMs: 15_000 })).toEqual({ text: 'From the shared pool', pageCount: null });
    expect(pooled.equals(copy)).toBe(true);
  });

  it('copies a view into a larger buffer, so the bytes around it stay usable', async () => {
    const docx = await tinyDocx(['Inside a larger buffer']);
    const big = new Uint8Array(docx.length + 20);
    big.fill(7);
    big.set(docx, 10);
    const view = big.subarray(10, 10 + docx.length);
    expect(await parseFile({ kind: 'docx', bytes: view, ...LIMITS }, { timeoutMs: 15_000 })).toEqual({ text: 'Inside a larger buffer', pageCount: null });
    expect(big.byteLength).toBe(docx.length + 20);
    expect(big[0]).toBe(7);
    expect(Buffer.from(view).equals(docx)).toBe(true);
  });
});
