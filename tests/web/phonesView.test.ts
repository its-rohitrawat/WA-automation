import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
// Browser modules; their JSDoc types are checked by tsconfig.web.json, so the imports are untyped here.
// @ts-expect-error -- browser module (see above)
import { readConnections, readPhones } from '../../src/web/public/contract.js';
// @ts-expect-error -- browser module (see above)
import { fixFor } from '../../src/web/public/views/connect.js';

// Connections' reading phones (lane C, change 7): the list the dashboard reads, and what "Fix now" does with several.

describe('readPhones', () => {
  it('reads each phone, keeps only phones 1 to 5 with a label, and never throws on a broken answer', () => {
    const r = readPhones({
      max: 5,
      phones: [
        { id: 1, label: 'Phone 1', state: 'active', number: '+91 •••• 1234', status: 'open', groups: 3, accountName: 'Rohit Rawat' },
        { id: 2, label: 'Front desk', state: 'unlinked', number: null, status: null, groups: 1 },
        { id: 6, label: 'Too many', state: 'active' },
        { id: 3, label: '' },
        null,
      ],
    });
    expect(r.max).toBe(5);
    expect(r.phones).toEqual([
      { id: 1, label: 'Phone 1', state: 'active', number: '+91 •••• 1234', status: 'open', groups: 3, accountName: 'Rohit Rawat' },
      { id: 2, label: 'Front desk', state: 'unlinked', number: null, status: null, groups: 1, accountName: null },
    ]);
    const hostile = { toString: 1, valueOf: 1 };
    for (const bad of [null, undefined, 7, 'x', [], { phones: 'x' }, { phones: [hostile, { id: hostile, label: hostile }] }]) {
      expect(() => readPhones(bad)).not.toThrow();
      expect(readPhones(bad).phones).toEqual([]);
    }
    expect(readPhones(null).max).toBe(5);
  });
});

describe('Fix now on the WhatsApp part', () => {
  it('with several phones it opens Connections (each phone has its own Link); with one, the dialogs as before', () => {
    expect(fixFor({ key: 'whatsapp', state: 'warn', detail: '2 of 3 phones connected' })).toBeNull();
    expect(fixFor({ key: 'whatsapp', state: 'down', detail: '0 of 3 phones connected' })).toBeNull();
    expect(fixFor({ key: 'whatsapp', state: 'down', detail: 'Not linked' })).toBe('founder-link');
    expect(fixFor({ key: 'whatsapp', state: 'down', detail: 'Unlinked from the phone' })).toBe('founder');
    expect(fixFor({ key: 'whatsapp', state: 'down', detail: 'Disconnected' })).toBeNull();
  });
});

// Owner follow-up (2 Nov): WhatsApp's own name for each phone, and a Google card's whole email.

/** dom.js reads matchMedia when it loads; the views themselves only build strings. */
async function views() {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  // @ts-expect-error -- browser module (see above)
  return (await import('../../src/web/public/views/connections.js')) as { renderPhones: (l: unknown) => string; renderConnections: (c: unknown) => string };
}
const phone = (accountName: unknown) => ({ max: 5, phones: [{ id: 2, label: 'Front desk', state: 'active', number: '…7788', status: 'open', groups: 2, accountName }] });
/** The text a browser shows for some markup: tags dropped, entities read. */
const text = (html: string) => html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

describe("WhatsApp's own name on each phone card", () => {
  it('reads it as one line of at most 60 characters with no control or invisible characters; anything else is unknown', () => {
    const name = (v: unknown) => readPhones(phone(v)).phones[0]?.accountName;
    expect(name('Rohit\u200B Ra\u202Ewat\u0007\n')).toBe('Rohit Rawat');
    expect(name('A'.repeat(70))).toBe('A'.repeat(60));
    for (const bad of [undefined, null, '', ' \u200B ', 7, { toString: 1 }]) expect(name(bad), JSON.stringify(bad)).toBeNull();
  });

  it('shows "WhatsApp name: …" under the name the owner gave it, escaped; nothing when it is not known', async () => {
    const { renderPhones } = await views();
    const html = renderPhones(readPhones(phone('Rohit <b>Rawat</b> & "co"')));
    expect(html).toContain('WhatsApp name: Rohit &lt;b&gt;Rawat&lt;/b&gt; &amp; &quot;co&quot;');
    expect(html).not.toContain('<b>Rawat');
    expect(html.indexOf('Front desk')).toBeLessThan(html.indexOf('WhatsApp name:')); // under the owner's name
    expect(html).toContain('<article class="card conn conn-stack" data-conn="phone-2">'); // on the card's full width
    expect(renderPhones(readPhones(phone(null)))).not.toContain('WhatsApp name');
  });
});

describe("WhatsApp's own name on the spare phone's card", () => {
  const spareCard = (accountName: unknown) =>
    readConnections({ spare: { state: 'ok', label: 'Linked', recipientMasked: '•••• 0000', accountName } }).find((c: { id: string }) => c.id === 'spare');

  it("is read as a phone's name is: one line of at most 60 characters with no control or invisible characters", () => {
    expect(spareCard('Morning​ de‮sk\u0007\n').accountName).toBe('Morning desk');
    expect(spareCard('A'.repeat(70)).accountName).toBe('A'.repeat(60));
    for (const bad of [undefined, null, '', ' ​ ', 7, { toString: 1 }]) expect(spareCard(bad).accountName, JSON.stringify(bad)).toBeNull();
  });

  it('shows "WhatsApp name: …" under the card title, escaped, the title on the full width; nothing when it is not known', async () => {
    const { renderConnections } = await views();
    const html = renderConnections([spareCard('Desk <b>2</b> & "co"')]);
    expect(html).toContain('WhatsApp name: Desk &lt;b&gt;2&lt;/b&gt; &amp; &quot;co&quot;');
    expect(html).not.toContain('<b>2');
    expect(html.indexOf('Spare WhatsApp')).toBeLessThan(html.indexOf('WhatsApp name:'));
    expect(html).toContain('<article class="card conn conn-stack" data-conn="spare"');
    expect(renderConnections([spareCard(null)])).not.toContain('WhatsApp name');
  });
});

describe("a Google card's email", () => {
  const google = (email: string) => readConnections({ google: [{ label: 'org2', email, state: 'ok', usedFor: ['Meetings'] }] }).filter((c: { kind: string }) => c.kind === 'google');
  const LONG = 'meetings.and.calendar@example-consulting.co.in';

  /** The pieces an email is shown in, each between two places to wrap. */
  const pieces = (html: string) => html.split('<wbr>').map((p) => /^<span class="em-part">([^<]*)<\/span>$/.exec(p)?.[1] ?? `NOT A PIECE: ${p}`);

  it('is shown whole, in pieces that wrap after the @ and before the dots, with the whole address as its tooltip', async () => {
    const { renderConnections } = await views();
    const html = renderConnections(google(LONG));
    const h3 = /<h3[^>]*>([\s\S]*?)<\/h3>/.exec(html)!;
    expect(h3[0]).toContain(`title="${LONG}"`);
    expect(html).toContain('<article class="card conn conn-stack" data-conn="google:org2"'); // on the card's full width
    expect(text(h3[1]!)).toBe(LONG); // every character there: no ellipsis
    expect(pieces(h3[1]!)).toEqual(['meetings', '.and', '.calendar@', 'example-consulting', '.co', '.in']);
    // Escaped, piece by piece: markup in an address stays text.
    const evil = /<h3[^>]*>([\s\S]*?)<\/h3>/.exec(renderConnections(google('a"<b>&x@evil.example')))![1]!;
    expect(pieces(evil)).toEqual(['a&quot;&lt;b&gt;&amp;x@', 'evil', '.example']);
    expect(evil).not.toMatch(/<b>&/);
  });

  it('the stylesheet never cuts it and keeps each piece whole (not at a hyphen); a long WhatsApp name wraps too', () => {
    const css = readFileSync('src/web/public/styles.css', 'utf8');
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)];
    const titles = rules.filter(([, sel]) => /\.conn\b[^,]*\bh3\b/.test(sel!));
    expect(titles.length).toBeGreaterThan(0);
    for (const [, sel, body] of titles) expect(body, sel!.trim()).not.toMatch(/ellipsis|nowrap|overflow:\s*hidden/);
    const rule = (sel: RegExp, body: RegExp) => rules.some(([, s, b]) => sel.test(s!) && body.test(b!));
    expect(rule(/\.conn \.em-part\s*$/, /display:\s*inline-block;\s*max-width:\s*100%/)).toBe(true);
    expect(rule(/\.conn-stack \.top-row \.grow-1\s*$/, /flex:\s*1 0 100%/)).toBe(true); // the title's own line
    expect(rule(/\.conn \.wa-name\s*$/, /overflow-wrap:\s*anywhere/)).toBe(true);
  });
});

