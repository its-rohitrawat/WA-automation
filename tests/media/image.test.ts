import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { IMAGE_LONG_EDGE, prepareImageForClaude } from '../../src/media/image.ts';

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

  // Amendment 9c: sharp decodes untrusted images in the service process, so only the common photo formats may load.
  it('reads JPEG, PNG, WebP, GIF and AVIF', async () => {
    const inputs = [await solid().jpeg().toBuffer(), await solid().png().toBuffer(), await solid().webp().toBuffer(), await solid().gif().toBuffer(), await solid().avif().toBuffer()];
    for (const input of inputs) {
      const out = await prepareImageForClaude(input);
      expect(out).toMatchObject({ mediaType: 'image/jpeg', width: 30, height: 20 });
      expect(isJpeg(out.data)).toBe(true);
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
