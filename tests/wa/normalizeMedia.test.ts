import { normalizeMessageContent, proto } from 'baileys';
import { describe, expect, it } from 'vitest';
import { normalizeMessage, type NormalizedEvent } from '../../src/wa/normalize.ts';
import { waRaw, waText } from '../helpers/wa.ts';

const KEY = Buffer.alloc(32, 9);
const media = (e: NormalizedEvent | null) => (e && e.kind === 'message' ? e.media : undefined);

describe('normalizeMessage media details', () => {
  it('keeps what is needed to download an image', () => {
    const e = normalizeMessage(waRaw('i1', {
      imageMessage: { url: 'https://mmg.whatsapp.net/v/t1', directPath: '/v/t1', mediaKey: KEY, mimetype: 'image/jpeg', fileLength: 2048, caption: 'new banner' },
    }));
    expect(e).toMatchObject({ kind: 'message', text: 'new banner', mediaType: 'image' });
    expect(media(e)).toEqual({
      kind: 'image', mimeType: 'image/jpeg', fileName: null, fileSize: 2048, seconds: null, viewOnce: false, forwarded: false,
      ref: { contentType: 'imageMessage', url: 'https://mmg.whatsapp.net/v/t1', directPath: '/v/t1', mediaKey: KEY.toString('base64') },
    });
  });

  it('reads a captioned document with a Long file size', () => {
    const e = normalizeMessage(waRaw('d1', {
      documentWithCaptionMessage: { message: { documentMessage: {
        url: 'https://mmg.whatsapp.net/d', mediaKey: KEY, mimetype: 'application/pdf', fileName: 'brief.pdf', caption: 'brief', fileLength: { toNumber: () => 123456 } as never,
      } } },
    }));
    expect(e).toMatchObject({ text: 'brief', mediaType: 'document' });
    expect(media(e)).toMatchObject({ kind: 'document', fileName: 'brief.pdf', fileSize: 123456, ref: { contentType: 'documentMessage', directPath: null } });
  });

  it('keeps download details for voice notes, as audioMessage', () => {
    const e = normalizeMessage(waRaw('v1', { audioMessage: { url: 'https://mmg.whatsapp.net/a', mediaKey: KEY, mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: 14 } }));
    expect(media(e)).toMatchObject({ kind: 'voice', seconds: 14, ref: { contentType: 'audioMessage' } });
  });

  it('keeps only metadata for videos and stickers', () => {
    expect(media(normalizeMessage(waRaw('vid', { videoMessage: { url: 'u', mediaKey: KEY, mimetype: 'video/mp4', seconds: 42 } }))))
      .toMatchObject({ kind: 'video', seconds: 42, ref: null });
    expect(media(normalizeMessage(waRaw('st', { stickerMessage: { url: 'u', mediaKey: KEY, mimetype: 'image/webp' } }))))
      .toMatchObject({ kind: 'sticker', ref: null });
  });

  it('never keeps download details for view-once media', () => {
    const wrapped = normalizeMessage(waRaw('vo1', { viewOnceMessageV2: { message: { imageMessage: { url: 'u', mediaKey: KEY, mimetype: 'image/jpeg' } } } }));
    expect(media(wrapped)).toMatchObject({ kind: 'image', viewOnce: true, ref: null });
    const flagged = normalizeMessage(waRaw('vo2', { imageMessage: { url: 'u', mediaKey: KEY, viewOnce: true } }));
    expect(media(flagged)).toMatchObject({ viewOnce: true, ref: null });
  });

  it('has no download details without a media key or an address', () => {
    expect(media(normalizeMessage(waRaw('n1', { imageMessage: { url: 'u' } })))!.ref).toBeNull();
    expect(media(normalizeMessage(waRaw('n2', { imageMessage: { mediaKey: KEY } })))!.ref).toBeNull();
  });

  it('caps the untrusted file name and adds nothing to other messages', () => {
    const long = `${'a'.repeat(300)}.pdf`;
    expect(media(normalizeMessage(waRaw('d2', { documentMessage: { url: 'u', mediaKey: KEY, fileName: long } })))!.fileName).toHaveLength(255);
    expect(normalizeMessage(waText('t1', 'hello'))).not.toHaveProperty('media');
    expect(media(normalizeMessage(waRaw('loc', { locationMessage: {} })))).toBeUndefined();
  });
});

/** Every wrapper Baileys' normalizeMessageContent opens, found by asking it about each field of proto.Message. */
const OPENED = Object.keys(proto.Message.prototype).filter((k) => {
  const inner: proto.IMessage = { conversation: 'x' };
  return normalizeMessageContent({ [k]: { message: inner } } as proto.IMessage) === inner;
});
const wrap = (wrapper: string, message: proto.IMessage) => ({ [wrapper]: { message } }) as proto.IMessage;
const plainImage = (): proto.IMessage => ({ imageMessage: { url: 'https://mmg.whatsapp.net/v/t1', directPath: '/v/t1', mediaKey: KEY, mimetype: 'image/jpeg' } });
const viewOnceImage = () => wrap('viewOnceMessageV2', plainImage());

describe('view-once detection follows Baileys unwrapping (amendment 2a)', () => {
  it('finds every wrapper Baileys rc14 opens', () => {
    expect(OPENED).toEqual(expect.arrayContaining([
      'ephemeralMessage', 'viewOnceMessage', 'documentWithCaptionMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension',
      'editedMessage', 'associatedChildMessage', 'groupStatusMessage', 'groupStatusMessageV2',
    ]));
  });

  it('sees view-once media inside every wrapper Baileys opens', () => {
    for (const w of OPENED) {
      expect(media(normalizeMessage(waRaw('vo3', wrap(w, viewOnceImage())))), w).toMatchObject({ kind: 'image', viewOnce: true, ref: null });
    }
  });

  it('follows the same wrapper as Baileys when one message has two', () => {
    for (const a of OPENED) {
      for (const b of OPENED) {
        if (a === b) continue;
        const opened = normalizeMessageContent({ ...wrap(a, { conversation: a }), ...wrap(b, { conversation: b }) })?.conversation;
        const [first, other] = opened === a ? [a, b] : [b, a];
        // Only the wrapper Baileys opens holds the view-once file.
        const e = normalizeMessage(waRaw('vo4', { ...wrap(first, viewOnceImage()), ...wrap(other, plainImage()) }));
        expect(media(e), `${first} before ${other}`).toMatchObject({ kind: 'image', viewOnce: true, ref: null });
      }
    }
  });

  it('looks as deep as Baileys does', () => {
    // Baileys opens at most five wrappers: here four disappearing-message wrappers, then the view-once one.
    let deep = viewOnceImage();
    for (let i = 0; i < 4; i++) deep = wrap('ephemeralMessage', deep);
    expect(media(normalizeMessage(waRaw('vo5', deep)))).toMatchObject({ kind: 'image', viewOnce: true, ref: null });
    // After five wrappers Baileys stops and reads the file beside a view-once wrapper it did not open.
    let last: proto.IMessage = { ...plainImage(), ...viewOnceImage() };
    for (let i = 0; i < 5; i++) last = wrap('ephemeralMessage', last);
    expect(media(normalizeMessage(waRaw('vo6', last)))).toMatchObject({ kind: 'image', viewOnce: true, ref: null });
  });

  it('counts a view-once wrapper beside the one Baileys opens', () => {
    const e = normalizeMessage(waRaw('vo7', { ...wrap('ephemeralMessage', plainImage()), ...wrap('viewOnceMessage', plainImage()) }));
    expect(media(e)).toMatchObject({ kind: 'image', viewOnce: true, ref: null });
  });

  it('still downloads a file in a wrapper that is not view-once', () => {
    const e = normalizeMessage(waRaw('vo8', wrap('ephemeralMessage', wrap('associatedChildMessage', plainImage()))));
    expect(media(e)).toMatchObject({ kind: 'image', viewOnce: false, ref: { contentType: 'imageMessage', directPath: '/v/t1' } });
  });
});

describe('forwarded files (owner decision D2, amendment 2b)', () => {
  const image = (id: string, contextInfo?: proto.IContextInfo) =>
    media(normalizeMessage(waRaw(id, { imageMessage: { ...plainImage().imageMessage, ...(contextInfo ? { contextInfo } : {}) } })));

  it('is forwarded when isForwarded is set or the forwarding score is above 0, and is still downloaded', () => {
    expect(image('f1', { isForwarded: true })).toMatchObject({ forwarded: true, ref: { contentType: 'imageMessage' } });
    expect(image('f2', { forwardingScore: 3 })).toMatchObject({ forwarded: true, ref: { contentType: 'imageMessage' } });
  });

  it('is not forwarded without either flag', () => {
    expect(image('f3')).toMatchObject({ forwarded: false });
    expect(image('f4', { isForwarded: false, forwardingScore: 0 })).toMatchObject({ forwarded: false });
    expect(image('f5', { stanzaId: 'm1' })).toMatchObject({ forwarded: false });
  });

  it('reads the flag of a captioned document', () => {
    const e = normalizeMessage(waRaw('f6', {
      documentWithCaptionMessage: { message: { documentMessage: { url: 'u', mediaKey: KEY, fileName: 'a.pdf', caption: 'see', contextInfo: { forwardingScore: 1 } } } },
    }));
    expect(media(e)).toMatchObject({ kind: 'document', forwarded: true });
  });
});
