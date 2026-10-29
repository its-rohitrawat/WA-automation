import { OAuth2Client } from 'google-auth-library';
import { describe, expect, it } from 'vitest';
import {
  founderMailer, GMAIL_SEND_SCOPE, GMAIL_SEND_URL, GmailInviteMailer, oauthGmailTransport, type GmailTransport, type RequestingClient,
} from '../../src/platform/gmailSender.ts';
import { inviteText, rawInviteMessage, type InviteEmail } from '../../src/platform/mailer.ts';

// A fake transport only: nothing here reaches Gmail or Google.

const MAIL: InviteEmail = {
  to: 'kapoor.studio@example.com', business: 'Kapoor Design Studio', founderName: 'Rohit',
  link: 'https://agent.example.com/signup?invite=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', expiresAt: '2026-11-05T06:00:00.000Z',
};

/** The message as Gmail would receive it: headers and the decoded body. */
function decode(raw: string): { headers: Record<string, string>; body: string } {
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const [head, ...rest] = text.split('\r\n\r\n');
  const headers: Record<string, string> = {};
  for (const line of head!.split('\r\n')) {
    const i = line.indexOf(': ');
    headers[line.slice(0, i)] = line.slice(i + 2);
  }
  return { headers, body: Buffer.from(rest.join('\r\n\r\n').replace(/\r\n/g, ''), 'base64').toString('utf8') };
}

class FakeTransport implements GmailTransport {
  calls: { url: string; raw: string; timeoutMs: number }[] = [];
  answer: () => Promise<{ status: number; data: unknown }> = async () => ({ status: 200, data: { id: '18c0ffee' } });
  async post(url: string, body: { raw: string }, timeoutMs: number) {
    this.calls.push({ url, raw: body.raw, timeoutMs });
    return this.answer();
  }
}

describe('the invite email', () => {
  it('is a short plain message from the founder to the invited address, with the link and the expiry', () => {
    const raw = rawInviteMessage(MAIL, 'founder@example.com');
    const m = decode(raw);
    expect(m.headers).toMatchObject({
      From: 'Rohit <founder@example.com>', To: 'kapoor.studio@example.com', Subject: 'Rohit invited you to WA Agent',
      'Content-Type': 'text/plain; charset=UTF-8',
    });
    expect(m.body).toContain('Rohit has invited Kapoor Design Studio to WA Agent.');
    expect(m.body).toContain(MAIL.link);
    expect(m.body).toContain('Sign in with this Google account: kapoor.studio@example.com');
    expect(m.body).toContain('The link works once and expires on 5 Nov 2026.');
    expect(inviteText(MAIL).subject).toBe('Rohit invited you to WA Agent');
  });

  it('no value can add a header: line breaks in a name or business stay inside one line', () => {
    const m = decode(rawInviteMessage({ ...MAIL, founderName: 'Rohit\r\nBcc: everyone@example.com', business: 'Evil\r\nBcc: x@example.com' }, 'founder@example.com'));
    expect(Object.keys(m.headers).sort()).toEqual(['Content-Transfer-Encoding', 'Content-Type', 'From', 'MIME-Version', 'Subject', 'To']);
    expect(m.headers.From).not.toContain('\n');
  });

  it('a name that is not plain ASCII is encoded in the header, and arrives whole', () => {
    const m = decode(rawInviteMessage({ ...MAIL, founderName: 'Rohit Śarmā' }, 'founder@example.com'));
    expect(m.headers.From).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <founder@example.com>$/);
    expect(Buffer.from(m.headers.From!.split('?')[3]!, 'base64').toString('utf8')).toBe('Rohit Śarmā');
  });
});

describe('the Gmail sender', () => {
  it('sends once to Gmail\'s messages.send, with the whole message', async () => {
    const t = new FakeTransport();
    const out = await new GmailInviteMailer({ transport: t, from: 'founder@example.com' }).send(MAIL);
    expect(out).toEqual({ state: 'sent' });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({ url: GMAIL_SEND_URL, timeoutMs: 30_000 });
    expect(decode(t.calls[0]!.raw).headers.To).toBe('kapoor.studio@example.com');
  });

  it('sorts the outcome: refused is failed, anything unclear is unknown; never sent twice', async () => {
    const cases: [() => Promise<{ status: number; data: unknown }>, unknown][] = [
      [async () => ({ status: 403, data: { error: { message: 'Insufficient Permission for kapoor.studio@example.com' } } }), { state: 'failed', code: 'http_403' }],
      [async () => ({ status: 401, data: {} }), { state: 'failed', code: 'http_401' }],
      [async () => ({ status: 429, data: {} }), { state: 'failed', code: 'http_429' }],
      [async () => ({ status: 500, data: {} }), { state: 'unknown', code: 'http_500' }],
      [async () => ({ status: 200, data: {} }), { state: 'unknown', code: 'no_message_id' }],
      [async () => Promise.reject(new Error('socket hang up')), { state: 'unknown', code: 'no_answer' }],
      // A refused token refresh: gaxios rejects with the token endpoint's 400.
      [async () => Promise.reject(Object.assign(new Error('invalid_grant'), { response: { status: 400 } })), { state: 'failed', code: 'http_400' }],
      [async () => Promise.reject(Object.assign(new Error('bad gateway'), { response: { status: 502 } })), { state: 'unknown', code: 'http_502' }],
    ];
    for (const [answer, want] of cases) {
      const t = new FakeTransport();
      t.answer = answer;
      expect(await new GmailInviteMailer({ transport: t, from: 'founder@example.com' }).send(MAIL)).toEqual(want);
      expect(t.calls).toHaveLength(1);
    }
  });

  it('a send that never answers is unknown after the time-out', async () => {
    const t = new FakeTransport();
    t.answer = () => new Promise(() => {});
    const out = await new GmailInviteMailer({ transport: t, from: 'founder@example.com', timeoutMs: 10 }).send(MAIL);
    expect(out).toEqual({ state: 'unknown', code: 'timeout' });
    expect(t.calls).toHaveLength(1);
  });

  it('is there only with the gmail.send permission and a known address', () => {
    const t = new FakeTransport();
    expect(founderMailer({ grantedScopes: ['https://www.googleapis.com/auth/drive.file'], from: 'founder@example.com', transport: t })).toBeNull();
    expect(founderMailer({ grantedScopes: [GMAIL_SEND_SCOPE], from: null, transport: t })).toBeNull();
    expect(founderMailer({ grantedScopes: [GMAIL_SEND_SCOPE], from: 'founder@example.com', transport: t })?.from).toBe('founder@example.com');
  });

  it('the transport posts through the sign-in\'s own client, taking every answer, and reads the client on each send', async () => {
    const seen: unknown[] = [];
    let n = 0;
    const client = (): RequestingClient => ({
      request: async (o) => {
        seen.push({ ...o, validateStatus: o.validateStatus(500), client: ++n });
        return { status: 200, data: { id: 'x' } };
      },
    });
    const t = oauthGmailTransport(client);
    await t.post(GMAIL_SEND_URL, { raw: 'abc' }, 1234);
    await t.post(GMAIL_SEND_URL, { raw: 'def' }, 1234);
    expect(seen).toEqual([
      { url: GMAIL_SEND_URL, method: 'POST', data: { raw: 'abc' }, timeout: 1234, validateStatus: true, client: 1 },
      { url: GMAIL_SEND_URL, method: 'POST', data: { raw: 'def' }, timeout: 1234, validateStatus: true, client: 2 },
    ]);
    // google-auth-library's own OAuth2Client fits (checked by the type check; never called here).
    const real: () => RequestingClient = () => new OAuth2Client();
    expect(typeof real).toBe('function');
  });
});
