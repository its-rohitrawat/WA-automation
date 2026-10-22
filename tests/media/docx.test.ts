import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markAsUntransferable } from 'node:worker_threads';
import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { docxXmlToText, extractDocxText } from '../../src/media/parse/docx.ts';
import { parseFile } from '../../src/media/parse/runner.ts';
import { tinyDocx } from '../helpers/files.ts';

const LIMITS = { maxXmlBytes: 1_000_000, maxEntries: 50 };
const fixture = (name: string): URL => new URL(`../fixtures/${name}`, import.meta.url);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * About `size` characters of random words. They compress only about 7:1, so each 16 KB block of compressed data
 * inflates to about 100 KB, and a reader that stops early has inflated only a small part of the text.
 */
function randomWords(size: number): string {
  const words = ['logo', 'final', 'payment', 'brief', 'draft', 'invoice', 'client', 'review', 'banner', 'poster', 'video', 'reel', 'deck', 'copy', 'edit', 'print'];
  const out: string[] = [];
  let seed = 0x2545f491; // xorshift32, so the text is the same on every run
  for (let n = 0; n < size; ) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const word = words[seed >>> 28] ?? '';
    out.push(word);
    n += word.length + 1;
  }
  return out.join(' ');
}

/** Counts every inflated byte jszip hands to the stream of a file in a zip, that is, what the reader may hold in memory. */
function countInflatedBytes(): () => number {
  let bytes = 0;
  const zipObject = Object.getPrototypeOf(new JSZip().file('probe.txt', '').file('probe.txt')) as JSZip.JSZipObject;
  const nodeStream = zipObject.nodeStream;
  vi.spyOn(zipObject, 'nodeStream').mockImplementation(function (this: JSZip.JSZipObject, ...args) {
    const stream = nodeStream.apply(this, args) as NodeJS.ReadableStream & { push(chunk: Uint8Array | null): boolean };
    const push = stream.push.bind(stream);
    stream.push = (chunk) => {
      bytes += chunk?.length ?? 0;
      return push(chunk);
    };
    return stream;
  });
  return () => bytes;
}

/**
 * A Word file whose compressed word/document.xml is damaged. 'block type': the first deflate block has the reserved
 * type 11. 'tail': the second half of the compressed data is zeroed.
 */
async function damagedDocx(how: 'block type' | 'tail'): Promise<Buffer> {
  const zip = Buffer.from(await tinyDocx(['Damaged inside the compressed text, '.repeat(40)]));
  const name = Buffer.from('word/document.xml');
  for (let at = zip.indexOf('PK\x03\x04', 0, 'latin1'); at !== -1; at = zip.indexOf('PK\x03\x04', at + 4, 'latin1')) {
    const nameLen = zip.readUInt16LE(at + 26);
    if (!zip.subarray(at + 30, at + 30 + nameLen).equals(name)) continue;
    expect(zip.readUInt16LE(at + 8)).toBe(8); // deflate
    const data = at + 30 + nameLen + zip.readUInt16LE(at + 28);
    const size = zip.readUInt32LE(at + 18);
    if (how === 'block type') zip[data] = 0b111; // BFINAL = 1, BTYPE = 11 (reserved)
    else zip.fill(0, data + Math.floor(size / 2), data + size);
    return zip;
  }
  throw new Error('word/document.xml not found');
}

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

  it('stops inflating a zip bomb soon after the cap, without inflating the whole text', async () => {
    const docx = await tinyDocx([randomWords(4_000_000)]); // about 600 KB compressed
    const inflated = countInflatedBytes();
    await expect(extractDocxText(docx, { maxXmlBytes: 10_000, maxEntries: 50 })).rejects.toMatchObject({ name: 'ParseError', code: 'too_large_uncompressed' });
    const atRejection = inflated();
    expect(atRejection).toBeGreaterThan(10_000); // the counter saw the stream
    expect(atRejection).toBeLessThan(1_000_000);
    // Inflating that was already under way may finish, but it must not carry on through the rest of the file.
    await sleep(300);
    expect(inflated()).toBeLessThan(1_000_000);
  });

  it('refuses archives with too many entries, bytes that are not a zip, and zips without a document', async () => {
    const many = new JSZip();
    for (let i = 0; i < 60; i++) many.file(`f${i}.txt`, 'x');
    many.file('word/document.xml', '<w:p/>');
    await expect(extractDocxText(await many.generateAsync({ type: 'nodebuffer' }), LIMITS)).rejects.toMatchObject({ code: 'too_many_entries' });
    await expect(extractDocxText(Buffer.from('not a zip at all'), LIMITS)).rejects.toMatchObject({ code: 'not_docx' });
    const empty = new JSZip();
    empty.file('readme.txt', 'hi');
    await expect(extractDocxText(await empty.generateAsync({ type: 'nodebuffer' }), LIMITS)).rejects.toMatchObject({ name: 'ParseError', code: 'not_docx' });
  });
});

describe('parseFile (worker thread)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('reads a Word file in a worker', async () => {
    const bytes = await tinyDocx(['Hello from the worker']);
    expect(await parseFile({ kind: 'docx', bytes, ...LIMITS }, { timeoutMs: 15_000 })).toEqual({ text: 'Hello from the worker', pageCount: null });
  });

  it("passes the reader's error code back", async () => {
    const bomb = await tinyDocx(['x'.repeat(2_000_000)]);
    await expect(parseFile({ kind: 'docx', bytes: bomb, ...LIMITS }, { timeoutMs: 15_000 })).rejects.toMatchObject({ name: 'ParseError', code: 'too_large_uncompressed' });
  });

  it('fails a Word file whose compressed text is damaged, without waiting for the time limit', async () => {
    for (const how of ['block type', 'tail'] as const) {
      await expect(parseFile({ kind: 'docx', bytes: await damagedDocx(how), ...LIMITS }, { timeoutMs: 15_000 })).rejects.toMatchObject({ name: 'ParseError', code: 'parse_failed' });
    }
  });

  it('stops a parser that never finishes, and its thread really stops running', async () => {
    const beats = new Int32Array(new SharedArrayBuffer(4));
    const job = { kind: 'docx' as const, bytes: new Uint8Array(1), ...LIMITS, beats };
    const started = Date.now();
    // 2 s, so that even on a busy PC the thread has started spinning before the time limit.
    await expect(parseFile(job, { timeoutMs: 2_000, workerUrl: fixture('hangWorker.ts') })).rejects.toMatchObject({ name: 'ParseError', code: 'parse_timeout' });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(Atomics.load(beats, 0)).not.toBe(0); // it was running
    // terminate() takes effect asynchronously: the count must stop rising soon. A thread left running never stops.
    const deadline = Date.now() + 5_000;
    let last = Atomics.load(beats, 0);
    for (;;) {
      await sleep(300);
      const now = Atomics.load(beats, 0);
      if (now === last) break;
      if (Date.now() > deadline) throw new Error('the parser thread is still running');
      last = now;
    }
  });

  it('starts each parser with its own small memory limits', async () => {
    const r = await parseFile({ kind: 'docx', bytes: new Uint8Array(1), ...LIMITS }, { timeoutMs: 15_000, workerUrl: fixture('limitsWorker.ts') });
    expect(JSON.parse(r.text)).toMatchObject({ maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 });
  });

  it("starts each parser with an empty environment, so the service's secrets are not in the thread that reads untrusted files", async () => {
    process.env.PARSER_ENV_PROBE = 'set-in-the-service';
    try {
      const r = await parseFile({ kind: 'docx', bytes: new Uint8Array(1), ...LIMITS }, { timeoutMs: 15_000, workerUrl: fixture('envWorker.ts') });
      expect(JSON.parse(r.text)).toEqual({ probe: false, count: 0 });
    } finally {
      delete process.env.PARSER_ENV_PROBE;
    }
  });

  it('stops a parser that runs out of memory, and the service keeps running', async () => {
    await expect(parseFile({ kind: 'docx', bytes: new Uint8Array(1), ...LIMITS }, { timeoutMs: 30_000, workerUrl: fixture('oomWorker.ts') })).rejects.toMatchObject({
      name: 'ParseError',
      code: 'parse_memory',
    });
    expect(await parseFile({ kind: 'docx', bytes: await tinyDocx(['Still here']), ...LIMITS }, { timeoutMs: 15_000 })).toEqual({ text: 'Still here', pageCount: null });
  }, 45_000);

  it('fails at once when the parser exits without replying', async () => {
    const started = Date.now();
    await expect(parseFile({ kind: 'docx', bytes: new Uint8Array(1), ...LIMITS }, { timeoutMs: 15_000, workerUrl: fixture('exitWorker.ts') })).rejects.toMatchObject({
      name: 'ParseError',
      code: 'parse_failed',
    });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("reads and discards the parser's console output, so a parser that waits for its output to be written still finishes", async () => {
    expect(await parseFile({ kind: 'docx', bytes: new Uint8Array(1), ...LIMITS }, { timeoutMs: 15_000, workerUrl: fixture('floodWorker.ts') })).toEqual({
      text: 'replied after flushing',
      pageCount: null,
    });
  });

  it("keeps the parser's console output out of the service's output", async () => {
    const out = vi.spyOn(process.stdout, 'write');
    const err = vi.spyOn(process.stderr, 'write');
    expect(await parseFile({ kind: 'docx', bytes: new Uint8Array(1), ...LIMITS }, { timeoutMs: 15_000, workerUrl: fixture('noisyWorker.ts') })).toEqual({ text: 'replied', pageCount: null });
    await sleep(300); // a worker's console output arrives asynchronously
    const written = [...out.mock.calls, ...err.mock.calls].map(([chunk]) => (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')));
    expect(written.join('')).not.toContain('parser-console-noise');
  });

  it("leaves the caller's bytes intact by default, even when they own their memory", async () => {
    const owned = new Uint8Array(await tinyDocx(['Copied for the worker']));
    const before = Buffer.from(owned);
    expect(owned.byteOffset === 0 && owned.byteLength === owned.buffer.byteLength).toBe(true);
    expect(await parseFile({ kind: 'docx', bytes: owned, ...LIMITS }, { timeoutMs: 15_000 })).toEqual({ text: 'Copied for the worker', pageCount: null });
    expect(Buffer.from(owned).equals(before)).toBe(true);
  });

  it('leaves a Buffer read from disk intact by default (readFile returns a Buffer that owns its memory)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wa-docx-'));
    dirs.push(dir);
    const docx = await tinyDocx(['Read from disk']);
    writeFileSync(join(dir, 'brief.docx'), docx);
    const bytes = await readFile(join(dir, 'brief.docx'));
    expect(await parseFile({ kind: 'docx', bytes, ...LIMITS }, { timeoutMs: 15_000 })).toEqual({ text: 'Read from disk', pageCount: null });
    expect(bytes.equals(docx)).toBe(true);
  });

  it('with transfer, moves bytes that own their memory to the worker instead of copying them', async () => {
    const owned = new Uint8Array(await tinyDocx(['Moved, not copied']));
    expect(owned.byteOffset === 0 && owned.byteLength === owned.buffer.byteLength).toBe(true);
    expect(await parseFile({ kind: 'docx', bytes: owned, ...LIMITS }, { timeoutMs: 15_000, transfer: true })).toEqual({ text: 'Moved, not copied', pageCount: null });
    // Transferred, not cloned: the memory now belongs to the worker, so the caller's view is empty.
    expect(owned.byteLength).toBe(0);
  });

  it('with transfer, still parses a Buffer that shares its memory (a pooled Buffer), and leaves it intact', async () => {
    const pooled = Buffer.from(await tinyDocx(['From the shared pool']));
    const copy = Buffer.from(pooled);
    // Small Buffers live in Node's shared pool, which cannot be transferred, so the runner copies them once.
    expect(pooled.byteLength).toBeLessThan(pooled.buffer.byteLength);
    expect(await parseFile({ kind: 'docx', bytes: pooled, ...LIMITS }, { timeoutMs: 15_000, transfer: true })).toEqual({ text: 'From the shared pool', pageCount: null });
    expect(pooled.equals(copy)).toBe(true);
  });

  it('with transfer, copies a view into a larger buffer, so the bytes around it stay usable', async () => {
    const docx = await tinyDocx(['Inside a larger buffer']);
    // In the middle of the buffer, and at its start (offset 0, but shorter than the buffer).
    for (const offset of [10, 0]) {
      const big = new Uint8Array(docx.length + 20);
      big.fill(7);
      big.set(docx, offset);
      const view = big.subarray(offset, offset + docx.length);
      expect(await parseFile({ kind: 'docx', bytes: view, ...LIMITS }, { timeoutMs: 15_000, transfer: true })).toEqual({ text: 'Inside a larger buffer', pageCount: null });
      expect(big.byteLength).toBe(docx.length + 20);
      expect(big[offset === 0 ? big.length - 1 : 0]).toBe(7);
      expect(Buffer.from(view).equals(docx)).toBe(true);
    }
  });

  it('with transfer, copies bytes whose memory is marked untransferable, and leaves them intact', async () => {
    const docx = await tinyDocx(['Marked untransferable']);
    const memory = new ArrayBuffer(docx.length);
    const bytes = new Uint8Array(memory);
    bytes.set(docx);
    markAsUntransferable(memory);
    expect(await parseFile({ kind: 'docx', bytes, ...LIMITS }, { timeoutMs: 15_000, transfer: true })).toEqual({ text: 'Marked untransferable', pageCount: null });
    expect(Buffer.from(bytes).equals(docx)).toBe(true);
  });

  it('turns bytes that were already moved away into a ParseError', async () => {
    const gone = new Uint8Array(16);
    structuredClone(gone.buffer, { transfer: [gone.buffer] });
    expect(gone.byteLength).toBe(0);
    await expect(parseFile({ kind: 'docx', bytes: gone, ...LIMITS }, { timeoutMs: 15_000 })).rejects.toMatchObject({ name: 'ParseError', code: 'parse_failed' });
    await expect(parseFile({ kind: 'docx', bytes: gone, ...LIMITS }, { timeoutMs: 15_000, transfer: true })).rejects.toMatchObject({ name: 'ParseError', code: 'parse_failed' });
  });
});
