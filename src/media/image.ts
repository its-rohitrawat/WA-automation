import sharp from 'sharp';
import { ParseError } from './parse/types.ts';
import { MEDIA_LIMITS } from './types.ts';

/**
 * sharp decodes untrusted images in the service process, so only the loaders for common photo formats are allowed:
 * JPEG, PNG, WebP, GIF and HEIF/AVIF, each from a Buffer. Every other loader (SVG, TIFF, PDF, files on disk and the
 * rest) is blocked for the whole process, which shrinks what a hostile file can reach. Nothing is cached, so decoded
 * images do not stay in memory after use.
 */
sharp.block({ operation: ['VipsForeignLoad'] });
sharp.unblock({
  operation: ['VipsForeignLoadJpegBuffer', 'VipsForeignLoadPngBuffer', 'VipsForeignLoadWebpBuffer', 'VipsForeignLoadNsgifBuffer', 'VipsForeignLoadHeifBuffer'],
});
sharp.cache(false);

/** Long edge sent to Claude: enough to read screenshot text, under the model's 2576 px high-resolution limit. */
export const IMAGE_LONG_EDGE = 2048;
/** Base64 adds a third, so this keeps each image under the API's 5 MB per-image limit. */
const MAX_JPEG_BYTES = 3_750_000;
/**
 * Most memory one image may take once decoded: width x height x channels x bytes per sample. The pixel cap alone
 * ignores bit depth and channels, and a file of a few hundred KB under it can decode to hundreds of MB, outside the V8
 * heap of the service process (review of Task 9). A 12 to 16 MP phone photo (8 bits, 3 channels) takes 36 to 48 MB.
 */
export const MAX_DECODED_IMAGE_BYTES = 128 * 1024 * 1024;
/**
 * A progressive JPEG or an interlaced PNG cannot be read line by line, so it is decoded whole, and peak memory is about
 * twice its decoded size. Such images are read only up to this many pixels; a WhatsApp HD photo (4096 x 3072) fits.
 */
export const MAX_PROGRESSIVE_IMAGE_PIXELS = 16 * 1024 * 1024;
/**
 * HEIF/AVIF is decoded whole, and the decoder keeps several copies: about 19 bytes per pixel at 8 bits and 26 at 10 or
 * 12 bits, whatever the file size (a 1 KB AVIF of 6688 x 6688 in one colour took 700 MB). So it has its own, smaller
 * pixel limit, which keeps its peak near that of the other formats at their limits (about 230 MB). 4K (3840 x 2160) fits.
 */
export const MAX_HEIF_IMAGE_PIXELS = 8 * 1024 * 1024;
/** Bytes per sample for each libvips band format; the allowed loaders give only uchar or ushort. Anything else counts 8. */
const SAMPLE_BYTES: Readonly<Record<string, number>> = { uchar: 1, char: 1, ushort: 2, short: 2, uint: 4, int: 4, float: 4, double: 8 };

export interface PreparedImage {
  data: Buffer;
  mediaType: 'image/jpeg';
  width: number;
  height: number;
}

async function encode(bytes: Buffer, maxPixels: number, edge: number, quality: number): Promise<PreparedImage> {
  const { data, info } = await sharp(bytes, { limitInputPixels: maxPixels, autoOrient: true, animated: false })
    .timeout({ seconds: 30 })
    .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality })
    .toBuffer({ resolveWithObject: true });
  return { data, mediaType: 'image/jpeg', width: info.width, height: info.height };
}

/**
 * Reads only the header (a few ms, no pixels decoded) and throws when the image would take too much memory to decode:
 * over the pixel cap (sharp refuses), over MAX_DECODED_IMAGE_BYTES, progressive/interlaced and over
 * MAX_PROGRESSIVE_IMAGE_PIXELS, or HEIF/AVIF and over MAX_HEIF_IMAGE_PIXELS. Animated images count their first frame
 * only, the one that is decoded.
 */
async function checkDecodeSize(bytes: Buffer, maxPixels: number): Promise<void> {
  const m = await sharp(bytes, { limitInputPixels: maxPixels, animated: false }).metadata();
  const pixels = (m.width ?? 0) * (m.height ?? 0);
  if (!(pixels > 0)) throw new Error('no size');
  const decoded = pixels * (m.channels ?? 4) * (SAMPLE_BYTES[m.depth ?? ''] ?? 8);
  if (decoded > MAX_DECODED_IMAGE_BYTES) throw new Error('too large decoded');
  if (m.isProgressive === true && pixels > MAX_PROGRESSIVE_IMAGE_PIXELS) throw new Error('too large progressive');
  if (m.format === 'heif' && pixels > MAX_HEIF_IMAGE_PIXELS) throw new Error('too large heif');
}

/** The end of the line of image decodes. Each one starts after the one before it has ended, failed or not. */
let lastDecode: Promise<unknown> = Promise.resolve();

/**
 * Runs one image decode after any other has ended. The media queue reads two files at once, and two large decodes at
 * once would double the memory sharp holds in the service process.
 */
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = lastDecode.then(work);
  lastDecode = run.catch(() => undefined);
  return run;
}

/**
 * Decodes an untrusted image (allowed formats only, pixel cap, decoded-size budget, time limit, one at a time),
 * applies its orientation, shrinks it to Claude's size and re-encodes it as JPEG. Re-encoding drops EXIF metadata, so
 * EXIF/GPS is stripped from what is sent to Claude. The original saved on the PC (and uploaded to Drive) is the
 * client's file, unchanged.
 */
export function prepareImageForClaude(bytes: Buffer, maxPixels: number = MEDIA_LIMITS.maxImagePixels): Promise<PreparedImage> {
  return oneAtATime(async () => {
    try {
      await checkDecodeSize(bytes, maxPixels);
      const first = await encode(bytes, maxPixels, IMAGE_LONG_EDGE, 85);
      return first.data.length <= MAX_JPEG_BYTES ? first : await encode(bytes, maxPixels, 1568, 70);
    } catch {
      throw new ParseError('image_unreadable');
    }
  });
}
