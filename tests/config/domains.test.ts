import { describe, expect, it } from 'vitest';
import { DomainSchema, isDomain, PUBLIC_MAIL_DOMAINS } from '../../src/config/domains.ts';

describe('isDomain', () => {
  it('accepts ordinary domains', () => {
    for (const d of ['client.example', 'sharma-interiors.example', 'mail.client.co.example', 'a1.example']) expect(isDomain(d)).toBe(true);
  });

  it('refuses things that are not domains', () => {
    for (const d of ['', 'client', 'client.', '.client.example', 'a@client.example', 'client..example', '-client.example', 'client-.example', 'cli ent.example', 'client.c', 'client.123', 'Client.example', 'http://client.example']) {
      expect(isDomain(d)).toBe(false);
    }
  });
});

describe('DomainSchema', () => {
  it('trims and lower-cases', () => {
    expect(DomainSchema.parse('  Client.EXAMPLE ')).toBe('client.example');
  });

  it('refuses every public mail domain, in any case', () => {
    expect(PUBLIC_MAIL_DOMAINS).toEqual([
      'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'yahoo.co.in',
      'icloud.com', 'me.com', 'rediffmail.com', 'proton.me', 'protonmail.com', 'zoho.com', 'aol.com',
      'yahoo.in', 'ymail.com', 'msn.com', 'live.in', 'hotmail.co.uk', 'pm.me', 'gmx.com', 'mail.com', 'yandex.com',
    ]);
    for (const d of PUBLIC_MAIL_DOMAINS) {
      const r = DomainSchema.safeParse(d.toUpperCase());
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.message).toMatch(/public mail domain/);
    }
  });

  it('explains a bad shape without echoing the value', () => {
    const r = DomainSchema.safeParse('not-a-domain-xyz');
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/must look like a domain/);
    expect(r.error?.issues[0]?.message).not.toContain('not-a-domain-xyz');
  });
});
