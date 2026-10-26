import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isEngineWav, readWavFile, readWavInfo } from '../../src/stt/wav.ts';

interface Chunk {
  id: string;
  body: Buffer;
}

function fmtChunk(o: { format?: number; channels?: number; sampleRate?: number; bits?: number; extensibleFormat?: number } = {}): Chunk {
  const format = o.format ?? 1;
  const channels = o.channels ?? 1;
  const sampleRate = o.sampleRate ?? 16000;
  const bits = o.bits ?? 16;
  const body = Buffer.alloc(format === 0xfffe ? 40 : 16);
  body.writeUInt16LE(format, 0);
  body.writeUInt16LE(channels, 2);
  body.writeUInt32LE(sampleRate, 4);
  body.writeUInt32LE((sampleRate * channels * bits) / 8, 8);
  body.writeUInt16LE((channels * bits) / 8, 12);
  body.writeUInt16LE(bits, 14);
  if (format === 0xfffe) {
    body.writeUInt16LE(22, 16);
    body.writeUInt16LE(o.extensibleFormat ?? 1, 24);
  }
  return { id: 'fmt ', body };
}

/** A RIFF/WAVE file from its chunks; a chunk's declared size can be overridden. */
function wav(chunks: (Chunk & { declared?: number })[]): Buffer {
  const parts = chunks.map((c) => {
    const head = Buffer.alloc(8);
    head.write(c.id, 0, 'latin1');
    head.writeUInt32LE(c.declared ?? c.body.length, 4);
    const pad = c.body.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0);
    return Buffer.concat([head, c.body, pad]);
  });
  const body = Buffer.concat([Buffer.from('WAVE', 'latin1'), ...parts]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

const data = (bytes: number): Chunk => ({ id: 'data', body: Buffer.alloc(bytes) });

describe('readWavInfo', () => {
  it('reads the length from the data size and the byte rate', () => {
    // 16 kHz mono 16-bit: 32,000 bytes a second.
    const file = wav([fmtChunk(), data(80_000)]);
    expect(readWavInfo(file, file.length)).toEqual({ format: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16, seconds: 2.5 });
  });

  it('skips other chunks before the data, including an odd-sized one with its pad byte', () => {
    const list: Chunk = { id: 'LIST', body: Buffer.from('INFOISFT\x05\x00\x00\x00Lavf\x00', 'latin1') };
    const odd: Chunk = { id: 'junk', body: Buffer.alloc(7) };
    const file = wav([fmtChunk(), list, odd, data(32_000)]);
    expect(readWavInfo(file, file.length)?.seconds).toBe(1);
  });

  it('reads other formats too, so the check can say what is wrong', () => {
    const stereo = wav([fmtChunk({ channels: 2, sampleRate: 44100 }), data(176_400)]);
    expect(readWavInfo(stereo, stereo.length)).toEqual({ format: 1, channels: 2, sampleRate: 44100, bitsPerSample: 16, seconds: 1 });
  });

  it('reads the real format of a WAVE_FORMAT_EXTENSIBLE file', () => {
    const file = wav([fmtChunk({ format: 0xfffe, extensibleFormat: 1 }), data(32_000)]);
    expect(readWavInfo(file, file.length)?.format).toBe(1);
  });

  it('a data size larger than the file, or unknown (0xFFFFFFFF), is cut to the bytes really there', () => {
    const real = wav([fmtChunk(), data(64_000)]);
    const tooBig = wav([fmtChunk(), { ...data(64_000), declared: 64_000_000 }]);
    expect(readWavInfo(tooBig, tooBig.length)?.seconds).toBe(2);
    const streamed = wav([fmtChunk(), { ...data(64_000), declared: 0xffffffff }]);
    expect(readWavInfo(streamed, streamed.length)?.seconds).toBe(2);
    // Only the head is read: the size of the whole file decides.
    expect(readWavInfo(real.subarray(0, 100), real.length)?.seconds).toBe(2);
  });

  it('is null for something that is not a WAV, or has no format or data', () => {
    const ogg = Buffer.concat([Buffer.from('OggS', 'latin1'), Buffer.alloc(60)]);
    expect(readWavInfo(ogg, ogg.length)).toBeNull();
    const notWave = wav([fmtChunk(), data(10)]);
    notWave.write('AVI ', 8, 'latin1');
    expect(readWavInfo(notWave, notWave.length)).toBeNull();
    const noData = wav([fmtChunk()]);
    expect(readWavInfo(noData, noData.length)).toBeNull();
    const dataFirst = wav([data(32_000), fmtChunk()]);
    expect(readWavInfo(dataFirst, dataFirst.length)).toBeNull();
    const zeroRate = wav([fmtChunk({ sampleRate: 0 }), data(32_000)]);
    expect(readWavInfo(zeroRate, zeroRate.length)).toBeNull();
    expect(readWavInfo(Buffer.alloc(0), 0)).toBeNull();
    expect(readWavInfo(Buffer.from('RIFF'), 4)).toBeNull();
  });

  it('a data size smaller than the bytes after it (a trailing LIST chunk) is the length', () => {
    const tail: Chunk = { id: 'LIST', body: Buffer.alloc(64_000) };
    const file = wav([fmtChunk(), data(32_000), tail]);
    expect(readWavInfo(file, file.length)?.seconds).toBe(1);
  });

  it('is null for a format chunk under 16 bytes, or a head cut inside the format chunk', () => {
    const short: Chunk = { id: 'fmt ', body: fmtChunk().body.subarray(0, 14) };
    const tooShort = wav([short, data(32_000)]);
    expect(readWavInfo(tooShort, tooShort.length)).toBeNull();
    const file = wav([fmtChunk(), data(32_000)]);
    // RIFF header (12), the format chunk's header (8), then only 10 of its 16 bytes.
    expect(readWavInfo(file.subarray(0, 30), file.length)).toBeNull();
    expect(readWavInfo(file.subarray(0, 20), file.length)).toBeNull();
  });

  it('is null for another RIFF-like magic', () => {
    for (const magic of ['RIFX', 'RF64', 'riff', 'FORM']) {
      const file = wav([fmtChunk(), data(32_000)]);
      file.write(magic, 0, 'latin1');
      expect(readWavInfo(file, file.length)).toBeNull();
    }
  });

  it('reads sample rates of 65536 and more in full', () => {
    for (const sampleRate of [65_536, 96_000, 192_000]) {
      const file = wav([fmtChunk({ sampleRate }), data(sampleRate * 2)]);
      const info = readWavInfo(file, file.length);
      expect(info).toEqual({ format: 1, channels: 1, sampleRate, bitsPerSample: 16, seconds: 1 });
      expect(isEngineWav(info!)).toBe(false);
    }
  });

  it('an empty data chunk is 0 seconds', () => {
    const file = wav([fmtChunk(), data(0)]);
    expect(readWavInfo(file, file.length)?.seconds).toBe(0);
  });
});

describe('isEngineWav', () => {
  it('is true only for 16 kHz mono 16-bit PCM, what ffmpeg -ar 16000 -ac 1 -c:a pcm_s16le makes', () => {
    const ok = { format: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16, seconds: 1 };
    expect(isEngineWav(ok)).toBe(true);
    expect(isEngineWav({ ...ok, channels: 2 })).toBe(false);
    expect(isEngineWav({ ...ok, sampleRate: 48000 })).toBe(false);
    expect(isEngineWav({ ...ok, bitsPerSample: 24 })).toBe(false);
    expect(isEngineWav({ ...ok, format: 3 })).toBe(false);
  });
});

describe('readWavFile', () => {
  it('reads a file from disk, and is null for a file that is not a WAV', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wav-'));
    try {
      const good = join(dir, 'note.wav');
      writeFileSync(good, wav([fmtChunk(), data(96_000)]));
      expect(readWavFile(good)?.seconds).toBe(3);
      const bad = join(dir, 'note.ogg');
      writeFileSync(bad, 'OggS not a wav');
      expect(readWavFile(bad)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads past a metadata chunk of more than 44 bytes before the data, as ffmpeg can write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wav-'));
    try {
      const path = join(dir, 'note.wav');
      const list: Chunk = { id: 'LIST', body: Buffer.alloc(2_000, 0x41) };
      writeFileSync(path, wav([fmtChunk(), list, data(64_000)]));
      expect(readWavFile(path)).toEqual({ format: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16, seconds: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
