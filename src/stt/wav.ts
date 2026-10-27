import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/*
 * The header of a WAV file, read without ffmpeg: the format, and the length from the data chunk's size and the byte
 * rate. For the local engine's check (scripts/stt-local-check.ts), which needs a 16 kHz mono WAV.
 */

export interface WavInfo {
  /** 1 is PCM; for WAVE_FORMAT_EXTENSIBLE, the format inside it. */
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  seconds: number;
}

const PCM = 1;
const EXTENSIBLE = 0xfffe;
const UNKNOWN_SIZE = 0xffffffff;

const tag = (b: Uint8Array, at: number): string => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);
const u16 = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8);
const u32 = (b: Uint8Array, at: number): number => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16)) + b[at + 3]! * 0x1000000;

/**
 * Reads a RIFF/WAVE header from the first bytes of a file (head) and the whole file's size. The chunks are walked up to
 * the data chunk, which must come after the format chunk. A data size larger than the file, or unknown (0xFFFFFFFF, as
 * a streamed writer leaves it), is cut to the bytes really there. Null when it is not a WAV this can read.
 */
export function readWavInfo(head: Uint8Array, fileSize: number): WavInfo | null {
  if (head.length < 12 || tag(head, 0) !== 'RIFF' || tag(head, 8) !== 'WAVE') return null;
  let fmt: Omit<WavInfo, 'seconds'> & { byteRate: number } | null = null;
  let at = 12;
  while (at + 8 <= head.length) {
    const id = tag(head, at);
    const size = u32(head, at + 4);
    const body = at + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > head.length) return null;
      let format = u16(head, body);
      if (format === EXTENSIBLE && size >= 40 && body + 26 <= head.length) format = u16(head, body + 24);
      fmt = { format, channels: u16(head, body + 2), sampleRate: u32(head, body + 4), byteRate: u32(head, body + 8), bitsPerSample: u16(head, body + 14) };
    } else if (id === 'data') {
      if (fmt === null || fmt.byteRate === 0) return null;
      const there = Math.max(0, fileSize - body);
      const bytes = size === UNKNOWN_SIZE || size > there ? there : size;
      const { byteRate, ...rest } = fmt;
      return { ...rest, seconds: bytes / byteRate };
    }
    // Chunks are padded to an even size.
    at = body + size + (size % 2);
  }
  return null;
}

/** What the engines take, and what `ffmpeg -i in -ar 16000 -ac 1 -c:a pcm_s16le out.wav` makes. */
export function isEngineWav(w: WavInfo): boolean {
  return w.format === PCM && w.sampleRate === 16000 && w.channels === 1 && w.bitsPerSample === 16;
}

/** How much of the start of a file is read for the header: enough for the metadata chunks ffmpeg writes before the data. */
const HEAD_BYTES = 64 * 1024;

/** The header of a WAV file on disk; null when it is not one. */
export function readWavFile(path: string): WavInfo | null {
  const fd = openSync(path, 'r');
  try {
    const head = new Uint8Array(HEAD_BYTES);
    const read = readSync(fd, head, 0, HEAD_BYTES, 0);
    return readWavInfo(head.subarray(0, read), fstatSync(fd).size);
  } finally {
    closeSync(fd);
  }
}
