import { randomBytes } from 'node:crypto';
import { getUrlFromDirectPath } from 'baileys';
import { describe, expect, it } from 'vitest';
import { decrypt } from '../../src/crypto/envelope.ts';
import { isSafeMediaAddress, isSafeMediaUrl, mediaRefAad, MediaRefSealer } from '../../src/media/ref.ts';
import type { MediaRef } from '../../src/media/types.ts';

const MEDIA_KEY = Buffer.alloc(32, 9);
const ref: MediaRef = { contentType: 'imageMessage', url: 'https://mmg.whatsapp.net/v/t1/abc', directPath: '/v/t1/abc', mediaKey: MEDIA_KEY.toString('base64') };

describe('MediaRefSealer', () => {
  it('round-trips with the same key and the same message', () => {
    const s = new MediaRefSealer(randomBytes(32));
    expect(s.open(s.seal(ref, mediaRefAad(1, 'IMG1')), mediaRefAad(1, 'IMG1'))).toEqual(ref);
  });

  it('the sealed bytes show neither the media key nor the address', () => {
    const blob = new MediaRefSealer(randomBytes(32)).seal(ref, mediaRefAad(1, 'IMG1'));
    expect(blob.includes(MEDIA_KEY)).toBe(false);
    expect(blob.toString('latin1')).not.toContain(ref.mediaKey);
    expect(blob.toString('latin1')).not.toContain('mmg.whatsapp.net');
  });

  it('refuses another message, another key, or a tampered value', () => {
    const s = new MediaRefSealer(randomBytes(32));
    const blob = s.seal(ref, mediaRefAad(1, 'IMG1'));
    expect(() => s.open(blob, mediaRefAad(1, 'IMG2'))).toThrow();
    expect(() => s.open(blob, mediaRefAad(2, 'IMG1'))).toThrow();
    expect(() => new MediaRefSealer(randomBytes(32)).open(blob, mediaRefAad(1, 'IMG1'))).toThrow();
    const bad = Buffer.from(blob);
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 1;
    expect(() => s.open(bad, mediaRefAad(1, 'IMG1'))).toThrow();
  });

  it('uses a key derived from the master key, not the master key itself', () => {
    const master = randomBytes(32);
    const blob = new MediaRefSealer(master).seal(ref, 'aad');
    expect(() => decrypt(master, blob, Buffer.from('aad', 'utf8'))).toThrow();
  });

  it('refuses a value of the wrong shape, even one sealed with the same key for the same message', () => {
    const s = new MediaRefSealer(randomBytes(32));
    const aad = mediaRefAad(1, 'IMG1');
    const wrong: [string, unknown][] = [
      ['null', null],
      ['a string', 'imageMessage'],
      ['a video', { ...ref, contentType: 'videoMessage' }],
      ['no content type', { ...ref, contentType: undefined }],
      ['a numeric media key', { ...ref, mediaKey: 42 }],
      ['no media key', { ...ref, mediaKey: undefined }],
      ['no url', { ...ref, url: undefined }],
      ['a numeric url', { ...ref, url: 42 }],
      ['no direct path', { ...ref, directPath: undefined }],
      ['a numeric direct path', { ...ref, directPath: 42 }],
    ];
    for (const [label, value] of wrong) {
      expect(() => s.open(s.seal(value as MediaRef, aad), aad), label).toThrow('Sealed media details have the wrong shape');
    }
  });
});

describe('isSafeMediaAddress (amendment 3a, review C2)', () => {
  const at = (url: string | null, directPath: string | null): MediaRef => ({ ...ref, url, directPath });
  /** The host Baileys downloads from when there is a direct path, with the host pinned to mmg.whatsapp.net as the downloader must do (amendment 5a). */
  const pinnedHost = (directPath: string) => new URL(getUrlFromDirectPath(directPath, 'mmg.whatsapp.net')).host;

  it('accepts the addresses WhatsApp sends', () => {
    expect(isSafeMediaAddress(ref)).toBe(true);
    expect(isSafeMediaAddress(at(null, '/v/t62.7118-24/31_x-2.enc?ccb=11-4&oh=01_Q5A&oe=6750D1F2&_nc_sid=5e03e0'))).toBe(true);
    expect(isSafeMediaAddress(at('https://mmg.whatsapp.net/d/f/AbC.enc', null))).toBe(true);
    expect(isSafeMediaAddress(at('https://media-bom1-1.cdn.whatsapp.net/v/t1?x=1', null))).toBe(true);
  });

  it('refuses the four addresses named in amendment 3a', () => {
    expect(isSafeMediaAddress(at('http://192.168.1.1/x', null))).toBe(false);
    expect(isSafeMediaAddress(at(null, '@evil.com/x'))).toBe(false);
    expect(isSafeMediaAddress(at(null, 'evil.com/x'))).toBe(false);
    expect(isSafeMediaAddress(at('https://evil.com/x', null))).toBe(false);
  });

  it('refuses a bad direct path even next to a good url, because Baileys downloads from the direct path', () => {
    // The premise: Baileys would fetch from a host the sender can own.
    expect(pinnedHost('.evil.example/x')).toBe('mmg.whatsapp.net.evil.example');
    for (const dp of ['.evil.example/x', '@evil.com/x', 'evil.com/x', ':8443/x', '/a b', '/a\\b', '/a@b', '/a\tb', '/a\nb', '/a b']) {
      expect(isSafeMediaAddress(at('https://mmg.whatsapp.net/v/t1', dp)), JSON.stringify(dp)).toBe(false);
    }
  });

  it('every direct path it accepts keeps the download on mmg.whatsapp.net', () => {
    for (const dp of ['/v/t1', '//evil.com/x', '/../evil.com', '/x?u=https://evil.com', '/x#evil.com', '/%2e%2e/evil.com']) {
      expect(isSafeMediaAddress(at(null, dp)), dp).toBe(true);
      expect(pinnedHost(dp), dp).toBe('mmg.whatsapp.net');
    }
  });

  it('with a good direct path the url is never used, so its host does not matter (the downloader pins the host, amendment 5a)', () => {
    expect(isSafeMediaAddress(at('https://evil.com/x', '/v/t1'))).toBe(true);
    expect(isSafeMediaAddress(at('https://10.0.0.5:8443/x', '/v/t1'))).toBe(true);
  });

  it("a url used alone must be a plain https address on WhatsApp's media servers", () => {
    for (const url of [
      'https://mmg.whatsapp.net.evil.com/x', 'https://evilwhatsapp.net/x', 'https://whatsapp.net/x', 'https://mmg.whatsapp.net./x',
      'https://mmg.whatsapp.net:8443/x', 'https://user:pw@mmg.whatsapp.net/x', 'https://user@mmg.whatsapp.net/x',
      'http://mmg.whatsapp.net/x', 'ftp://mmg.whatsapp.net/x', 'https://[::1]/x', 'mmg.whatsapp.net/x', 'u',
    ]) {
      expect(isSafeMediaAddress(at(url, null)), url).toBe(false);
    }
  });

  it('refuses addresses longer than 2,048 characters', () => {
    const path = (chars: number) => `/${'a'.repeat(chars - 1)}`;
    const url = (chars: number) => `https://mmg.whatsapp.net/${'a'.repeat(chars - 'https://mmg.whatsapp.net/'.length)}`;
    expect([path(2_048).length, url(2_048).length]).toEqual([2_048, 2_048]);
    expect(isSafeMediaAddress(at(null, path(2_048)))).toBe(true);
    expect(isSafeMediaAddress(at(null, path(2_049)))).toBe(false);
    expect(isSafeMediaAddress(at('https://mmg.whatsapp.net/v/t1', path(2_049))), 'a good url does not rescue a long direct path').toBe(false);
    expect(isSafeMediaAddress(at(null, path(5 * 1024 * 1024)))).toBe(false);
    expect(isSafeMediaAddress(at(url(2_048), null))).toBe(true);
    expect(isSafeMediaAddress(at(url(2_049), null))).toBe(false);
  });

  it('isSafeMediaUrl checks a url on its own, the way a url used without a direct path is checked', () => {
    expect(isSafeMediaUrl('https://mmg.whatsapp.net/v/t1')).toBe(true);
    expect(isSafeMediaUrl('https://media-bom1-1.cdn.whatsapp.net/v/t1?x=1')).toBe(true);
    for (const u of [null, '', 'https://evil.com/x', 'https://10.0.0.5:8443/x', 'http://mmg.whatsapp.net/x', 'https://mmg.whatsapp.net:8443/x', '/v/t1']) {
      expect(isSafeMediaUrl(u), String(u)).toBe(false);
    }
  });

  it('an empty url or direct path counts as absent, as it does for Baileys', () => {
    expect(isSafeMediaAddress(at('', '/v/t1'))).toBe(true);
    expect(isSafeMediaAddress(at('https://mmg.whatsapp.net/v/t1', ''))).toBe(true);
    expect(isSafeMediaAddress(at('', ''))).toBe(false);
    expect(isSafeMediaAddress(at('', null))).toBe(false);
    expect(isSafeMediaAddress(at(null, ''))).toBe(false);
    expect(isSafeMediaAddress(at(null, null))).toBe(false);
  });
});
