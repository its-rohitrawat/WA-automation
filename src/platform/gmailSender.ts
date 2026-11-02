import { rawInviteMessage, type InviteEmail, type InviteMailer, type MailOutcome } from './mailer.ts';

// The founder's Gmail as the invite sender (SaaS design section 5, step 2): Gmail's messages.send, called once per
// invite through the founder's existing Google sign-in (google-auth-library's OAuth2Client.request, which refreshes the
// token), so no new package. It needs the gmail.send permission, granted once in the Google connect flow (hookups doc).
// The outcome is sorted, and never retried here:
// - a 2xx with a message id: sent;
// - a 4xx (Gmail refused it, or the sign-in or permission is missing): failed, nothing was sent;
// - anything else (no answer, a time-out, a 5xx, a 2xx without an id): unknown, it may have gone.
// No error text, address or link is kept: only a short code.

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
export const GMAIL_TIMEOUT_MS = 30_000;

/** One POST to Gmail. Resolves with the status and body for any HTTP answer; rejects only when there was none. */
export interface GmailTransport {
  post(url: string, body: { raw: string }, timeoutMs: number): Promise<{ status: number; data: unknown }>;
}

/** What the transport needs of an OAuth2Client (google-auth-library). */
export interface RequestingClient {
  request(o: { url: string; method: 'POST'; data: unknown; timeout: number; validateStatus: (status: number) => boolean }): Promise<{ status: number; data: unknown }>;
}

/**
 * The transport over the founder's Google sign-in. `client` is read on every send, so a reconnected account applies
 * at once. A refused token refresh comes back as an error with the token endpoint's 4xx answer: failed, as it should be.
 */
export function oauthGmailTransport(client: () => RequestingClient): GmailTransport {
  return {
    async post(url, body, timeoutMs) {
      const r = await client().request({ url, method: 'POST', data: body, timeout: timeoutMs, validateStatus: () => true });
      return { status: r.status, data: r.data };
    },
  };
}

/** The HTTP status in an error from gaxios (google-auth-library's HTTP client), when there was an answer. */
function answeredStatus(e: unknown): number | undefined {
  const status = (e as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof status === 'number' ? status : undefined;
}

export class GmailInviteMailer implements InviteMailer {
  readonly from: string;
  readonly #transport: GmailTransport;
  readonly #timeoutMs: number;

  constructor(o: { transport: GmailTransport; from: string; timeoutMs?: number }) {
    this.from = o.from;
    this.#transport = o.transport;
    this.#timeoutMs = o.timeoutMs ?? GMAIL_TIMEOUT_MS;
  }

  async send(mail: InviteEmail): Promise<MailOutcome> {
    const raw = rawInviteMessage(mail, this.from);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.#timeoutMs + 1_000);
    });
    try {
      const r = await Promise.race([this.#transport.post(GMAIL_SEND_URL, { raw }, this.#timeoutMs), late]);
      if (r === 'timeout') return { state: 'unknown', code: 'timeout' };
      if (r.status >= 200 && r.status < 300) {
        const id = (r.data as { id?: unknown } | null)?.id;
        return typeof id === 'string' && id !== '' ? { state: 'sent' } : { state: 'unknown', code: 'no_message_id' };
      }
      if (r.status >= 400 && r.status < 500) return { state: 'failed', code: `http_${r.status}` };
      return { state: 'unknown', code: `http_${r.status}` };
    } catch (e) {
      const status = answeredStatus(e);
      if (status !== undefined && status >= 400 && status < 500) return { state: 'failed', code: `http_${status}` };
      return { state: 'unknown', code: status === undefined ? 'no_answer' : `http_${status}` };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The founder's mailer when Gmail can send: the sign-in has the gmail.send permission and its email is known. null
 * otherwise (invites then go by Copy link only).
 */
export function founderMailer(o: { grantedScopes: readonly string[]; from: string | null; transport: GmailTransport }): GmailInviteMailer | null {
  if (!o.from || !o.grantedScopes.includes(GMAIL_SEND_SCOPE)) return null;
  return new GmailInviteMailer({ transport: o.transport, from: o.from });
}
