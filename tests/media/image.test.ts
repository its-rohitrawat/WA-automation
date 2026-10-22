import sharp, { type JpegOptions, type OutputInfo, type Sharp } from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { IMAGE_LONG_EDGE, prepareImageForClaude } from '../../src/media/image.ts';
import { MEDIA_LIMITS } from '../../src/media/types.ts';

const png = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: { r: 30, g: 90, b: 200 } } }).png().toBuffer();
const solid = () => sharp({ create: { width: 30, height: 20, channels: 3, background: { r: 200, g: 40, b: 40 } } });
const isJpeg = (b: Buffer) => [...b.subarray(0, 3)].join(',') === [0xff, 0xd8, 0xff].join(',');

describe('prepareImageForClaude', () => {
  it('shrinks a large image to the long-edge limit and sends JPEG', async () => {
    const out = await prepareImageForClaude(await png(4000, 1000));
    expect(out).toMatchObject({ mediaType: 'image/jpeg', width: IMAGE_LONG_EDGE, height: 512 });
    expect([...out.data.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  });

  it('never enlarges a small image', async () => {
    expect(await prepareImageForClaude(await png(10, 10))).toMatchObject({ width: 10, height: 10 });
  });

  it('drops EXIF metadata such as location from what is sent to Claude', async () => {
    const tagged = await sharp(await png(40, 40)).withExif({ IFD0: { Copyright: 'GPS-SECRET-12.97,77.59' } }).jpeg().toBuffer();
    expect(tagged.includes(Buffer.from('GPS-SECRET'))).toBe(true);
    const out = await prepareImageForClaude(tagged);
    expect(out.data.includes(Buffer.from('GPS-SECRET'))).toBe(false);
    expect((await sharp(out.data).metadata()).exif).toBeUndefined();
  });

  it('refuses bytes that are not an image, and images over the pixel cap', async () => {
    await expect(prepareImageForClaude(Buffer.from('not an image'))).rejects.toMatchObject({ name: 'ParseError', code: 'image_unreadable' });
    await expect(prepareImageForClaude(await png(20, 20), 100)).rejects.toMatchObject({ code: 'image_unreadable' });
  });

  it('applies the decompression-bomb pixel cap by default', async () => {
    // The extractor passes no cap of its own, so this default is what guards every real image.
    const side = Math.ceil(Math.sqrt(MEDIA_LIMITS.maxImagePixels)); // 7072 x 7072 is just over the cap, 7071 x 7071 under
    await expect(prepareImageForClaude(await png(side, side))).rejects.toMatchObject({ name: 'ParseError', code: 'image_unreadable' });
    const under = await sharp({ create: { width: side - 1, height: side - 1, channels: 3, background: { r: 30, g: 90, b: 200 } } }).jpeg().toBuffer();
    expect(await prepareImageForClaude(under)).toMatchObject({ width: IMAGE_LONG_EDGE, height: IMAGE_LONG_EDGE });
  });

  it('turns a phone photo upright from its EXIF orientation', async () => {
    const sideways = await solid().jpeg().withMetadata({ orientation: 6 }).toBuffer(); // stored 30 x 20, shown turned 90°
    expect(await prepareImageForClaude(sideways)).toMatchObject({ width: 20, height: 30 });
  });

  it('gives sharp at most 30 seconds per image', async () => {
    const timeout = vi.spyOn(sharp.prototype as Sharp, 'timeout');
    await prepareImageForClaude(await png(10, 10));
    expect(timeout).toHaveBeenCalledWith({ seconds: 30 });
  });

  it('re-encodes smaller and at lower quality when the first JPEG is over the API image limit', async () => {
    // Even random noise at 2048 px stays under 3.75 MB as a quality-85 JPEG, so the first encode is made to look too big.
    const input = await png(4000, 3000);
    type Encoded = { data: Buffer; info: OutputInfo };
    const proto = sharp.prototype as { toBuffer(o: { resolveWithObject: true }): Promise<Encoded>; jpeg(o?: JpegOptions): Sharp };
    const toBuffer = proto.toBuffer;
    vi.spyOn(proto, 'toBuffer').mockImplementationOnce(async function (this: unknown, o) {
      const first = await toBuffer.call(this, o);
      return { ...first, data: Buffer.concat([first.data, Buffer.alloc(3_750_001)]) };
    });
    const jpeg = vi.spyOn(proto, 'jpeg');
    const out = await prepareImageForClaude(input);
    expect(jpeg.mock.calls.map(([o]) => o?.quality)).toEqual([85, 70]);
    expect(out).toMatchObject({ mediaType: 'image/jpeg', width: 1568, height: 1176 });
    expect(out.data.length).toBeLessThanOrEqual(3_750_000);
  });

  // Amendment 9c: sharp decodes untrusted images in the service process, so only the common photo formats may load.
  it('reads JPEG, PNG, WebP, GIF and AVIF', async () => {
    const inputs = [await solid().jpeg().toBuffer(), await solid().png().toBuffer(), await solid().webp().toBuffer(), await solid().gif().toBuffer(), await solid().avif().toBuffer()];
    for (const input of inputs) {
      const out = await prepareImageForClaude(input);
      expect(out).toMatchObject({ mediaType: 'image/jpeg', width: 30, height: 20 });
      expect(isJpeg(out.data)).toBe(true);
    }
  });

  it('puts a transparent image on white, so dark text drawn on it stays readable', async () => {
    const clear = await sharp({ create: { width: 30, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const out = await prepareImageForClaude(clear);
    const pixels = await sharp(out.data).raw().toBuffer();
    expect(Math.min(...pixels.subarray(0, 3))).toBeGreaterThan(240);
  });

  it('decodes only the first frame of an animated GIF or WebP', async () => {
    // Three 30 x 20 frames in different colours, stacked into one 30 x 60 strip.
    const frames = Buffer.concat([[200, 40, 40], [40, 200, 40], [40, 40, 200]].map((rgb) => Buffer.from(Array.from({ length: 30 * 20 }, () => rgb).flat())));
    const strip = () => sharp(frames, { raw: { width: 30, height: 60, channels: 3, pageHeight: 20 } });
    for (const animated of [await strip().gif().toBuffer(), await strip().webp().toBuffer()]) {
      expect((await sharp(animated).metadata()).pages).toBe(3);
      expect(await prepareImageForClaude(animated)).toMatchObject({ mediaType: 'image/jpeg', width: 30, height: 20 });
    }
  });

  it('refuses SVG and TIFF input', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20"><rect width="30" height="20" fill="red"/></svg>');
    const tiff = await solid().tiff().toBuffer();
    await expect(prepareImageForClaude(svg)).rejects.toMatchObject({ name: 'ParseError', code: 'image_unreadable' });
    await expect(prepareImageForClaude(tiff)).rejects.toMatchObject({ name: 'ParseError', code: 'image_unreadable' });
    // The refusal comes from the loader block, not from the bytes: sharp can still describe what it was given.
    expect(sharp.format.svg.input.buffer).toBe(true);
    expect(sharp.format.tiff.input.buffer).toBe(true);
  });

  it('keeps no decoded images in the sharp cache', () => {
    expect(sharp.cache().items.max).toBe(0);
    expect(sharp.cache().memory.max).toBe(0);
  });
});
