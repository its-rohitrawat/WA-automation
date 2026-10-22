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
 * Decodes an untrusted image (allowed formats only, pixel cap, time limit), applies its orientation, shrinks it to
 * Claude's size and re-encodes it as JPEG. Re-encoding drops EXIF metadata, so EXIF/GPS is stripped from what is sent
 * to Claude. The original saved on the PC (and uploaded to Drive) is the client's file, unchanged.
 */
export async function prepareImageForClaude(bytes: Buffer, maxPixels: number = MEDIA_LIMITS.maxImagePixels): Promise<PreparedImage> {
  try {
    const first = await encode(bytes, maxPixels, IMAGE_LONG_EDGE, 85);
    return first.data.length <= MAX_JPEG_BYTES ? first : await encode(bytes, maxPixels, 1568, 70);
  } catch {
    throw new ParseError('image_unreadable');
  }
}
