import '../../src/media/image.ts'; // the app blocks sharp's SVG loader this way: the picture must draw under it
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { PictureMessage, PictureWindow } from '../../src/control/chatQueries.ts';
import { drawChatPicture, markup, PICTURE_WIDTH, roundRect } from '../../src/output/chatPicture.ts';

const msg = (o: Partial<PictureMessage> = {}): PictureMessage => ({
  id: 1, at: '2026-11-03T05:12:00.000Z', mine: false, sender: 'Rahul', text: 'Banner thoda bright karo', kind: 'text', seconds: null,
  transcript: null, quote: null, edited: false, deleted: false, source: false, ...o,
});
const win = (messages: PictureMessage[], name = 'Sharma Interiors'): PictureWindow => ({ client: { code: 'SHA', name }, messages });
const size = async (png: Buffer) => {
  const m = await sharp(png).metadata();
  return { format: m.format, width: m.width, height: m.height ?? 0 };
};

describe('drawChatPicture (11 Nov 2026)', () => {
  it('escapes Pango markup, so text is always drawn as text', () => {
    expect(markup('<b>Tom & "Jerry"</b>')).toBe('&lt;b&gt;Tom &amp; "Jerry"&lt;/b&gt;');
  });

  it('draws a PNG of the picture width, taller with more messages', async () => {
    const one = await size(await drawChatPicture(win([msg({ source: true })])));
    const four = await size(await drawChatPicture(win([msg(), msg({ mine: true, sender: 'Founder', text: 'ok, today' }), msg({ source: true }), msg()])));
    expect(one).toMatchObject({ format: 'png', width: PICTURE_WIDTH });
    expect(four.height).toBeGreaterThan(one.height);
  });

  it('draws markup-looking, Hindi and emoji text, replies, media and deleted messages without error', async () => {
    const png = await drawChatPicture(win([
      msg({ text: '<span foreground="red">x</span> & <b>bold?</b>', sender: 'R&D <team>' }),
      msg({ text: 'बैनर थोड़ा ब्राइट करो 👍', quote: { sender: 'P&Q <x>', text: 'logo & <final>?', kind: 'text' } }),
      msg({ text: 'reply', quote: { sender: 'Priya', text: '', kind: 'text' } }),
      msg({ kind: 'voice', seconds: 42, text: '', transcript: 'Blue & <red> works' }),
      msg({ kind: 'image', text: 'see this' }),
      msg({ deleted: true, text: '' }),
      msg({ source: true, edited: true }),
    ], 'A&B <Co>\u0007'));
    expect((await size(png)).width).toBe(PICTURE_WIDTH);
  });

  it('cuts a message of many lines, so a picture stays a picture', async () => {
    const { height } = await size(await drawChatPicture(win([msg({ source: true, text: 'a\n'.repeat(300) })])));
    expect(height).toBeLessThan(2600);
  });

  it('cuts a very long message, so a picture stays a picture', async () => {
    const { height } = await size(await drawChatPicture(win([msg({ source: true, text: 'word '.repeat(2000) })])));
    expect(height).toBeLessThan(2600);
  });
});

describe('roundRect', () => {
  it('paints a box of radius 0 solid, and only the part of a box on the canvas', () => {
    // A black canvas 4 pixels wide and 3 high; a pixel's colour as [r, g, b].
    const canvas = () => Buffer.alloc(4 * 3 * 4);
    const at = (buf: Buffer, x: number, y: number) => [...buf.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 3)];
    const square = canvas();
    roundRect(square, 4, 1, 1, 2, 2, 0, '#ff0000');
    for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]] as const) expect(at(square, x, y)).toEqual([255, 0, 0]);
    expect(at(square, 0, 0)).toEqual([0, 0, 0]);
    // 4 wide from x = 2: its last two pixels are off the right edge, and must not land at the start of row 1.
    const wide = canvas();
    roundRect(wide, 4, 2, 0, 4, 1, 0, '#0000ff');
    expect(at(wide, 3, 0)).toEqual([0, 0, 255]);
    expect([at(wide, 0, 1), at(wide, 1, 1)]).toEqual([[0, 0, 0], [0, 0, 0]]);
  });
});
