import { describe, expect, it } from 'vitest';
// The browser's own module, checked by tsconfig.web.json, which this project's tsconfig does not include: the import is
// untyped here, as in tests/web/public.test.ts.
// @ts-expect-error -- browser module (see above)
import { toWhatsApp } from '../../src/web/public/views/chatTags.js';

// Open chat's tags (November release, change 2): what the owner typed ("@Name") becomes WhatsApp's form ("@<digits>"),
// and the confirm names who is tagged in the order the message does.

const picks = (...p: [string, string][]) => new Map(p);

describe('toWhatsApp', () => {
  it('turns each picked "@Label" into "@<digits>", and names the tagged in the order they stand in the text', () => {
    const r = toWhatsApp('@Neha please check, @Ajay Jain', picks(['Ajay Jain', '919800000013'], ['Neha', '919800000012']));
    expect(r.text).toBe('@919800000012 please check, @919800000013');
    expect(r.tagged).toEqual(['Neha', 'Ajay Jain']);
  });

  it('a longer label is never eaten by a shorter one that begins it', () => {
    const r = toWhatsApp('@Raj and @Raj Kumar', picks(['Raj', '919800000001'], ['Raj Kumar', '919800000002']));
    expect(r.text).toBe('@919800000001 and @919800000002');
    expect(r.tagged).toEqual(['Raj', 'Raj Kumar']);
  });

  it('a label the owner edited away, or one followed by more letters, is no tag', () => {
    const r = toWhatsApp('@Nehal and Neha', picks(['Neha', '919800000012']));
    expect(r).toEqual({ text: '@Nehal and Neha', tagged: [] });
  });

  it('a label with signs in it (a shown number) is matched as written', () => {
    const r = toWhatsApp('hi @+91 98000 00014!', picks(['+91 98000 00014', '919800000014']));
    expect(r).toEqual({ text: 'hi @919800000014!', tagged: ['+91 98000 00014'] });
  });
});
