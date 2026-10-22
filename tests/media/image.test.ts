import sharp, { type JpegOptions, type Metadata, type OutputInfo, type Sharp } from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { IMAGE_LONG_EDGE, MAX_DECODED_IMAGE_BYTES, MAX_HEIF_IMAGE_PIXELS, MAX_PROGRESSIVE_IMAGE_PIXELS, prepareImageForClaude } from '../../src/media/image.ts';
import { MEDIA_LIMITS } from '../../src/media/types.ts';

const rgb = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: { r: 30, g: 90, b: 200 } } });
const rgba = (width: number, height: number) => sharp({ create: { width, height, channels: 4, background: { r: 30, g: 90, b: 200, alpha: 0.5 } } });
/** One channel of 8 bits: a pixel takes one byte once decoded. */
const grey = (width: number, height: number) => rgb(width, height).toColourspace('b-w');
const png = (width: number, height: number) => rgb(width, height).png().toBuffer();
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
    // The extractor passes no cap of its own, so this default is what guards every real image. Both images are grey
    // (one byte per pixel), so they stay well under the decoded-size budget and only the pixel cap decides.
    const side = Math.ceil(Math.sqrt(MEDIA_LIMITS.maxImagePixels)); // 7072 x 7072 is just over the cap, 7071 x 7071 under
    await expect(prepareImageForClaude(await grey(side, side).png().toBuffer())).rejects.toMatchObject({ name: 'ParseError', code: 'image_unreadable' });
    expect(await prepareImageForClaude(await grey(side - 1, side - 1).jpeg().toBuffer())).toMatchObject({ width: IMAGE_LONG_EDGE, height: IMAGE_LONG_EDGE });
  });

  // Review of Task 9: the pixel cap alone ignores bit depth, channels and interlacing, so a small file under it could
  // still make sharp hold hundreds of MB in the service process.
  describe('what an image takes to decode', () => {
    it('sets the budgets: 128 MiB decoded, 16 MiP for a progressive or interlaced image', () => {
      expect(MAX_DECODED_IMAGE_BYTES).toBe(128 * 1024 * 1024);
      expect(MAX_PROGRESSIVE_IMAGE_PIXELS).toBe(16 * 1024 * 1024);
    });

    it('refuses a 16-bit interlaced PNG under the pixel cap', async () => {
      const input = await rgba(4200, 4200).toColourspace('rgb16').png({ progressive: true }).toBuffer();
      expect(input.length).toBeLessThan(1_000_000);
      expect(4200 * 4200).toBeLessThan(MEDIA_LIMITS.maxImagePixels);
      await expect(prepareImageForClaude(input)).rejects.toMatchObject({ name: 'ParseError', code: 'image_unreadable' });
    });

    it('counts two bytes per sample for a 16-bit image', async () => {
      // 4300 x 4300 x 4 channels is 74 MB at 8 bits and 148 MB at 16 bits; neither is interlaced.
      await expect(prepareImageForClaude(await rgba(4300, 4300).toColourspace('rgb16').png().toBuffer())).rejects.toMatchObject({ code: 'image_unreadable' });
      expect(await prepareImageForClaude(await rgba(4300, 4300).png().toBuffer())).toMatchObject({ width: IMAGE_LONG_EDGE, height: IMAGE_LONG_EDGE });
    });

    it('counts every channel, up to the budget exactly', async () => {
      // 8-bit RGB: 6688 x 6688 x 3 fits in 128 MiB, 6689 x 6689 x 3 does not. Both are under the pixel cap.
      const side = Math.floor(Math.sqrt(MAX_DECODED_IMAGE_BYTES / 3));
      expect(side * side * 3).toBeLessThanOrEqual(MAX_DECODED_IMAGE_BYTES);
      expect((side + 1) * (side + 1) * 3).toBeGreaterThan(MAX_DECODED_IMAGE_BYTES);
      expect(await prepareImageForClaude(await rgb(side, side).jpeg().toBuffer())).toMatchObject({ width: IMAGE_LONG_EDGE, height: IMAGE_LONG_EDGE });
      await expect(prepareImageForClaude(await rgb(side + 1, side + 1).jpeg().toBuffer())).rejects.toMatchObject({ code: 'image_unreadable' });
      // The same pixels in grey take a third of the memory.
      expect(await prepareImageForClaude(await grey(side + 1, side + 1).jpeg().toBuffer())).toMatchObject({ width: IMAGE_LONG_EDGE });
    });

    it('holds a progressive JPEG or an interlaced PNG to 16 MiP, since it is decoded whole', async () => {
      // 4096 x 4096 is exactly 16 MiP; one more row is over. A baseline JPEG of the same size is still read.
      expect(await prepareImageForClaude(await rgb(4096, 4096).jpeg({ progressive: true }).toBuffer())).toMatchObject({ width: IMAGE_LONG_EDGE });
      await expect(prepareImageForClaude(await rgb(4096, 4097).jpeg({ progressive: true }).toBuffer())).rejects.toMatchObject({ code: 'image_unreadable' });
      await expect(prepareImageForClaude(await rgb(4096, 4097).png({ progressive: true }).toBuffer())).rejects.toMatchObject({ code: 'image_unreadable' });
      expect(await prepareImageForClaude(await rgb(4096, 4097).jpeg().toBuffer())).toMatchObject({ height: IMAGE_LONG_EDGE });
    });

    it('holds an AVIF image to 8 MiP, since its decoder keeps several whole copies', async () => {
      // AVIF takes about 19 to 26 bytes per pixel while decoding, whatever the file size: a 1 KB AVIF of 6688 x 6688
      // in one colour needed 700 MB. 4096 x 2048 is exactly 8 MiP and 4 bytes per pixel or less once decoded.
      const avif = (width: number, height: number) => rgb(width, height).avif({ effort: 0 }).toBuffer();
      expect(MAX_HEIF_IMAGE_PIXELS).toBe(8 * 1024 * 1024);
      expect(await prepareImageForClaude(await avif(4096, 2048))).toMatchObject({ width: IMAGE_LONG_EDGE, height: 1024 });
      await expect(prepareImageForClaude(await avif(4096, 2049))).rejects.toMatchObject({ code: 'image_unreadable' });
      expect(await prepareImageForClaude(await rgb(4096, 2049).jpeg().toBuffer())).toMatchObject({ width: IMAGE_LONG_EDGE });
    });

    it('still reads ordinary phone photos', async () => {
      // A 12 MP camera photo sent as a document, and a WhatsApp HD photo, which is often progressive.
      expect(await prepareImageForClaude(await rgb(4000, 3000).jpeg().toBuffer())).toMatchObject({ width: IMAGE_LONG_EDGE, height: 1536 });
      expect(await prepareImageForClaude(await rgb(4096, 3072).jpeg({ progressive: true }).toBuffer())).toMatchObject({ width: IMAGE_LONG_EDGE, height: 1536 });
    });

    it('decodes one image at a time, even when two are asked for at once', async () => {
      // The media queue reads two files at once; two large decodes must never overlap.
      const inputs = [await png(3000, 1000), await png(1000, 3000)];
      type Encoded = { data: Buffer; info: OutputInfo };
      const proto = sharp.prototype as { metadata(): Promise<Metadata>; toBuffer(o: { resolveWithObject: true }): Promise<Encoded> };
      const events: string[] = [];
      let active = 0;
      let most = 0;
      const track = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
        events.push(`${name} start`);
        most = Math.max(most, ++active);
        try {
          return await work();
        } finally {
          active--;
          events.push(`${name} end`);
        }
      };
      const metadata = proto.metadata;
      const toBuffer = proto.toBuffer;
      vi.spyOn(proto, 'metadata').mockImplementation(function (this: unknown) {
        return track('metadata', () => metadata.call(this));
      });
      vi.spyOn(proto, 'toBuffer').mockImplementation(function (this: unknown, o) {
        return track('toBuffer', () => toBuffer.call(this, o));
      });
      const [wide, tall] = await Promise.all(inputs.map((input) => prepareImageForClaude(input)));
      expect(wide).toMatchObject({ width: IMAGE_LONG_EDGE, height: 683 });
      expect(tall).toMatchObject({ width: 683, height: IMAGE_LONG_EDGE });
      expect(most).toBe(1);
      const one = ['metadata start', 'metadata end', 'toBuffer start', 'toBuffer end'];
      expect(events).toEqual([...one, ...one]);
    });

    it('does not let a refused image hold up the next one', async () => {
      const small = await png(10, 10);
      const [bad, good] = await Promise.allSettled([prepareImageForClaude(Buffer.from('not an image')), prepareImageForClaude(small)]);
      expect(bad).toMatchObject({ status: 'rejected', reason: { name: 'ParseError', code: 'image_unreadable' } });
      expect(good).toMatchObject({ status: 'fulfilled', value: { width: 10, height: 10 } });
    });
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
