// The invite email (SaaS design section 5, step 2): what it says, and the sender interface. The real sender is the
// founder's Gmail (gmailSender.ts); tests use a fake. Nothing here retries: an unclear outcome is "unknown" and the
// founder decides (Resend or Cancel), so an invite is never sent twice by itself.

export interface InviteEmail {
  to: string;
  business: string;
  /** The founder's name, as the email's signature and "who invited you". */
  founderName: string;
  link: string;
  expiresAt: string;
}

export type MailOutcome =
  | { state: 'sent' }
  /** Surely not sent (refused before anything left, for example no Gmail permission). */
  | { state: 'failed'; code: string }
  /** Asked, but no clear answer: it may have gone. */
  | { state: 'unknown'; code: string };

export interface InviteMailer {
  /** The address the email comes from (the founder's Gmail), or null when it is not known. */
  readonly from: string | null;
  send(mail: InviteEmail): Promise<MailOutcome>;
}

/** "5 Nov 2026", in India time. */
function day(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
}

/** One line of plain text: no line breaks, so nothing can add an email header. */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

/** The subject and plain-text body (design: a short plain message with the link). */
export function inviteText(m: InviteEmail): { subject: string; body: string } {
  const founder = oneLine(m.founderName) || 'WA Agent';
  const business = oneLine(m.business);
  return {
    subject: `${founder} invited you to WA Agent`,
    body: [
      'Hi,',
      '',
      `${founder} has invited ${business} to WA Agent. It reads your client WhatsApp groups and keeps a task tracker up to date for you.`,
      '',
      'Open your invite:',
      m.link,
      '',
      `Sign in with this Google account: ${m.to}`,
      `The link works once and expires on ${day(m.expiresAt)}.`,
      '',
      "If you weren't expecting this, you can ignore this email.",
      '',
      founder,
      '',
    ].join('\r\n'),
  };
}

/** RFC 2047 encoding for a header value that is not plain ASCII. */
function headerWord(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

/**
 * The whole message (RFC 5322) as Gmail's API takes it: base64url of the raw text. Headers are built from fixed parts
 * and single-line values only; the To address is the stored, checked one.
 */
export function rawInviteMessage(m: InviteEmail, from: string): string {
  const { subject, body } = inviteText(m);
  const lines = [
    `From: ${headerWord(oneLine(m.founderName))} <${oneLine(from)}>`,
    `To: ${oneLine(m.to)}`,
    `Subject: ${headerWord(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}
