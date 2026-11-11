import '../../src/media/image.ts'; // the app blocks sharp's SVG loader this way: the picture must draw under it
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { PictureMessage, PictureWindow } from '../../src/control/chatQueries.ts';
import { drawChatPicture, markup, PICTURE_WIDTH } from '../../src/output/chatPicture.ts';

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
