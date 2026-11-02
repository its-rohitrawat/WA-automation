import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSessionDb, useSenderAuthState, type EncryptedAuth } from '../../src/wa/authState.ts';
import { checkRecipient, linkSender, recipientJid, RecipientRefusedError, SenderGateway } from '../../src/wa/senderGateway.ts';
import { closeWith, FakeSocket, SEND_METHODS } from '../helpers/fakeSocket.ts';

const RECIPIENT = '919800000000';
const JID = '919800000000@s.whatsapp.net';

type Script = (s: FakeSocket) => void;
const open: Script = (s) => s.emit('connection.update', { connection: 'open' });
const hang: Script = (s) => {
  s.sendMessage.mockImplementation(() => new Promise(() => {}));
  open(s);
};

/** Each new socket answers sendMessage with msg-1, msg-2, ... and runs the next script after the caller added its listeners. */
function scriptedFactory(scripts: Script[] = []) {
  const sockets: FakeSocket[] = [];
  const factory = () => {
    const s = new FakeSocket();
    let n = 0;
    s.sendMessage.mockImplementation(async () => ({ key: { id: `msg-${++n}` } }));
    sockets.push(s);
    const script = scripts.shift() ?? open;
    queueMicrotask(() => script(s));
    return s;
  };
  return { factory, sockets };
}

async function senderAuth(linked: boolean): Promise<EncryptedAuth> {
  const auth = await useSenderAuthState(openSessionDb(':memory:'), randomBytes(32));
  return { ...auth, hasSession: linked };
}

/** Runs fn, which must throw, and checks its message holds none of the given values, nor any run of 5 or more digits. */
function expectNoLeak(fn: () => unknown, values: string[]): void {
  let message: string | undefined;
  try {
    fn();
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toBeDefined();
  for (const v of values) {
    expect(message).not.toContain(v);
    for (const run of v.match(/\d{5,}/g) ?? []) {
      for (let i = 0; i + 5 <= run.length; i++) expect(message).not.toContain(run.slice(i, i + 5));
    }
  }
  expect(message).not.toMatch(/\d{5,}/);
}

async function setup(
  o: { scripts?: Script[]; auth?: EncryptedAuth; noAuth?: boolean; connectTimeoutMs?: number; sendTimeoutMs?: number; lingerMs?: number } = {},
) {
  const { factory, sockets } = scriptedFactory(o.scripts);
  const gw = new SenderGateway({
    recipient: RECIPIENT,
    factory,
    auth: o.noAuth ? undefined : (o.auth ?? await senderAuth(true)),
    connectTimeoutMs: o.connectTimeoutMs ?? 1_000,
    sendTimeoutMs: o.sendTimeoutMs ?? 1_000,
    lingerMs: o.lingerMs ?? 0,
  });
  return { gw, sockets };
}

describe('SenderGateway', () => {
  it('sends one text message with the link preview off, and no document, to the configured recipient, then disconnects', async () => {
    const { gw, sockets } = await setup();
    expect(await gw.sendReport('Morning report · 23 Oct')).toEqual({ status: 'sent', messageIds: ['msg-1'] });
    const sock = sockets[0]!;
    expect(sock.sendMessage.mock.calls).toEqual([[JID, { text: 'Morning report · 23 Oct', linkPreview: null }]]);
    for (const [, content] of sock.sendMessage.mock.calls) expect(content).not.toHaveProperty('document');
    expect(sock.end).toHaveBeenCalled();
    expect(gw.status().state).toBe('idle');
  });

  it('sets no presence, sends no read receipts and changes no chat', async () => {
    const { gw, sockets } = await setup();
    await gw.sendReport('hi');
    for (const name of SEND_METHODS.filter((n) => n !== 'sendMessage')) expect(sockets[0]![name]).not.toHaveBeenCalled();
  });

  it('refuses any recipient other than REPORT_RECIPIENT, and takes no recipient from the caller', async () => {
    expect(recipientJid(RECIPIENT)).toBe(JID);
    expect(() => checkRecipient(JID, JID)).not.toThrow();
    expect(() => checkRecipient('919811111111@s.whatsapp.net', JID)).toThrow(RecipientRefusedError);
    expect(() => checkRecipient('120363000000000001@g.us', JID)).toThrow(RecipientRefusedError);
    const auth = await senderAuth(true);
    for (const bad of ['+919800000000', '91 98000 00000', '120363000000000001@g.us', '']) {
      expect(() => new SenderGateway({ recipient: bad, factory: scriptedFactory().factory, auth })).toThrow(/digits only/);
    }
    expect(SenderGateway.prototype.sendReport.length).toBe(1); // the text only
  });

  it('accepts only 91 and a 10-digit Indian mobile as the recipient', () => {
    expect(recipientJid('919812345678')).toBe('919812345678@s.whatsapp.net');
    for (const bad of ['9812345678', '919812345', '9198123456789', '915812345678', '449812345678']) {
      expect(() => recipientJid(bad)).toThrow('REPORT_RECIPIENT must be 91 and the 10-digit Indian mobile, digits only');
    }
  });

  it('never puts the refused number or JID in an error message', async () => {
    const badRecipients = [
      '+919800000000', '91 98000 00000', '120363000000000001@g.us',
      '9812345678', '919812345', '9198123456789', '915812345678', '449812345678',
    ];
    const auth = await senderAuth(true);
    for (const bad of badRecipients) {
      expectNoLeak(() => recipientJid(bad), [bad]);
      expectNoLeak(() => new SenderGateway({ recipient: bad, factory: scriptedFactory().factory, auth }), [bad]);
    }
    for (const refused of ['919811111111@s.whatsapp.net', '120363000000000001@g.us']) {
      expectNoLeak(() => checkRecipient(refused, JID), [refused, JID]);
    }
  });

  it('tells the masked recipient it sends to: the last 4 digits only', async () => {
    const { gw } = await setup();
    expect(gw.maskedRecipient()).toBe('…0000');
    expect(gw.maskedRecipient()).not.toMatch(/\d{5,}/);
  });

  it('has exactly one send method', () => {
    const names = Object.getOwnPropertyNames(SenderGateway.prototype);
    expect(names.filter((n) => /send|read|presence|react|receipt|chatmodify|delete/i.test(n))).toEqual(['sendReport']);
  });

  it('fails definitely, without connecting, when the spare number is not linked', async () => {
    const { gw, sockets } = await setup({ auth: await senderAuth(false) });
    expect(gw.status().state).toBe('not_linked');
    expect(await gw.sendReport('hi')).toEqual({ status: 'failed', code: 'not_linked' });
    expect(sockets).toHaveLength(0);
  });

  it("fails definitely, without connecting, when the saved link is the recipient's own number (scanned with the founder's phone)", async () => {
    for (const id of [`${RECIPIENT}:5@s.whatsapp.net`, `${RECIPIENT}@s.whatsapp.net`]) {
      const auth = await senderAuth(true);
      auth.state.creds.me = { id, name: 'Founder' };
      const { gw, sockets } = await setup({ auth });
      expect(gw.status().state).toBe('self_send');
      expect(await gw.sendReport('hi')).toEqual({ status: 'failed', code: 'self_send' });
      expect(gw.status().state).toBe('self_send');
      expect(sockets).toHaveLength(0);
    }
  });

  it("fails definitely, without connecting, when the saved link is the founder reader's own number, also when it is not REPORT_RECIPIENT", async () => {
    const FOUNDER = '919811112222';
    for (const id of [`${FOUNDER}:7@s.whatsapp.net`, `${FOUNDER}@s.whatsapp.net`]) {
      const auth = await senderAuth(true);
      auth.state.creds.me = { id, name: 'Founder' };
      const { factory, sockets } = scriptedFactory();
      const gw = new SenderGateway({ recipient: RECIPIENT, founderNumber: FOUNDER, factory, auth, connectTimeoutMs: 1_000, lingerMs: 0 });
      expect(gw.status().state).toBe('self_send');
      expect(await gw.sendReport('hi')).toEqual({ status: 'failed', code: 'self_send' });
      expect(gw.status().state).toBe('self_send');
      expect(sockets).toHaveLength(0);
    }
    // sendReport checks again at send time, not only at construction.
    const auth = await senderAuth(true);
    auth.state.creds.me = { id: '919800000099:2@s.whatsapp.net', name: 'Spare' };
    const { factory, sockets } = scriptedFactory();
    const gw = new SenderGateway({ recipient: RECIPIENT, founderNumber: FOUNDER, factory, auth, connectTimeoutMs: 1_000, lingerMs: 0 });
    expect(gw.status().state).toBe('idle');
    auth.state.creds.me = { id: `${FOUNDER}:7@s.whatsapp.net`, name: 'Founder' };
    expect(await gw.sendReport('hi')).toEqual({ status: 'failed', code: 'self_send' });
    expect(gw.status().state).toBe('self_send');
    expect(sockets).toHaveLength(0);
  });

  it('sends normally with a founder number set when the saved link is a third number', async () => {
    const auth = await senderAuth(true);
    auth.state.creds.me = { id: '919800000099:2@s.whatsapp.net', name: 'Spare' };
    const { factory, sockets } = scriptedFactory();
    const gw = new SenderGateway({ recipient: RECIPIENT, founderNumber: '919811112222', factory, auth, connectTimeoutMs: 1_000, lingerMs: 0 });
    expect(gw.status().state).toBe('idle');
    expect(await gw.sendReport('hi')).toEqual({ status: 'sent', messageIds: ['msg-1'] });
    expect(sockets).toHaveLength(1);
  });

  it('sends normally when the saved link is another number', async () => {
    const auth = await senderAuth(true);
    auth.state.creds.me = { id: '919800000099:2@s.whatsapp.net', name: 'Spare' };
    const { gw, sockets } = await setup({ auth });
    expect(gw.status().state).toBe('idle');
    expect(await gw.sendReport('hi')).toEqual({ status: 'sent', messageIds: ['msg-1'] });
    expect(sockets).toHaveLength(1);
  });

  it('fails definitely, without connecting, when the stored session could not be read (no auth)', async () => {
    const { gw, sockets } = await setup({ noAuth: true });
    expect(gw.status().state).toBe('unreadable');
    expect(await gw.sendReport('hi')).toEqual({ status: 'failed', code: 'session_unreadable' });
    expect(gw.status().state).toBe('unreadable');
    expect(sockets).toHaveLength(0);
  });

  it('fails definitely, without connecting, when the session file could not be opened (disk, permissions or a lock)', async () => {
    const { factory, sockets } = scriptedFactory();
    const gw = new SenderGateway({ recipient: RECIPIENT, factory, auth: undefined, authProblem: 'unavailable' });
    expect(gw.status().state).toBe('unavailable');
    expect(await gw.sendReport('hi')).toEqual({ status: 'failed', code: 'session_unavailable' });
    expect(gw.status().state).toBe('unavailable');
    expect(sockets).toHaveLength(0);
  });

  it('fails definitely when WhatsApp shows a QR code, refuses the session or never connects', async () => {
    const cases: { script: Script; code: string; state: string; statusCode: number | null }[] = [
      { script: (s) => s.emit('connection.update', { qr: 'QR-1' }), code: 'not_linked', state: 'not_linked', statusCode: null },
      { script: (s) => closeWith(s, 401), code: 'logged_out', state: 'logged_out', statusCode: 401 },
      { script: (s) => closeWith(s, 403), code: 'forbidden', state: 'forbidden', statusCode: 403 },
      { script: (s) => closeWith(s, 440), code: 'replaced', state: 'replaced', statusCode: 440 },
      { script: (s) => closeWith(s, 428), code: 'closed', state: 'idle', statusCode: 428 },
      { script: () => {}, code: 'connect_timeout', state: 'idle', statusCode: null },
    ];
    for (const c of cases) {
      const { gw, sockets } = await setup({ scripts: [c.script], connectTimeoutMs: 20 });
      expect(await gw.sendReport('hi')).toEqual({ status: 'failed', code: c.code });
      expect(sockets[0]!.sendMessage).not.toHaveBeenCalled();
      expect(sockets[0]!.end).toHaveBeenCalled();
      expect(gw.status()).toMatchObject({ state: c.state, lastErrorCode: c.statusCode });
    }
  });

  it('reports unknown when a send times out or fails after it started', async () => {
    const timedOut = await setup({ scripts: [hang], sendTimeoutMs: 20 });
    expect(await timedOut.gw.sendReport('hi')).toEqual({ status: 'unknown', code: 'timeout' });

    const textFails: Script = (s) => {
      s.sendMessage.mockRejectedValueOnce(new Error('socket error'));
      open(s);
    };
    const failed = await setup({ scripts: [textFails] });
    expect(await failed.gw.sendReport('hi')).toEqual({ status: 'unknown', code: 'send_error' });
    expect(failed.sockets[0]!.sendMessage).toHaveBeenCalledTimes(1);
    expect(failed.sockets[0]!.end).toHaveBeenCalled();
  });

  it('fails definitely (connect_error, retried by the scheduler) when making or opening the socket throws: nothing was sent', async () => {
    // The factory throws before any socket exists.
    let made = 0;
    const throwing = new SenderGateway({
      recipient: RECIPIENT,
      factory: () => {
        made++;
        throw new Error('bad socket options');
      },
      auth: await senderAuth(true),
      connectTimeoutMs: 1_000,
      lingerMs: 0,
    });
    expect(await throwing.sendReport('hi')).toEqual({ status: 'failed', code: 'connect_error' });
    expect(throwing.status().state).toBe('idle');
    expect(await throwing.sendReport('hi')).toEqual({ status: 'failed', code: 'connect_error' }); // not stuck busy
    expect(made).toBe(2);

    // The socket exists but throws while the gateway listens for it to open: it is closed, and nothing was sent.
    const sock = new FakeSocket();
    sock.ev.on = () => {
      throw new Error('listener failed');
    };
    const broken = new SenderGateway({ recipient: RECIPIENT, factory: () => sock, auth: await senderAuth(true), connectTimeoutMs: 1_000, lingerMs: 0 });
    expect(await broken.sendReport('hi')).toEqual({ status: 'failed', code: 'connect_error' });
    expect(sock.sendMessage).not.toHaveBeenCalled();
    expect(sock.end).toHaveBeenCalled();
    expect(broken.status().state).toBe('idle');
  });

  it('sends one report at a time', async () => {
    const { gw } = await setup({ scripts: [hang], sendTimeoutMs: 50 });
    const first = gw.sendReport('hi');
    expect(await gw.sendReport('hi')).toEqual({ status: 'failed', code: 'busy' });
    expect(await first).toEqual({ status: 'unknown', code: 'timeout' });
  });

  it('stop ends a send in progress and refuses later sends', async () => {
    const { gw, sockets } = await setup({ scripts: [hang], sendTimeoutMs: 50 });
    const p = gw.sendReport('hi');
    await vi.waitFor(() => expect(sockets[0]?.sendMessage).toHaveBeenCalled());
    await gw.stop();
    expect(sockets[0]!.end).toHaveBeenCalled();
    expect(await p).toEqual({ status: 'unknown', code: 'timeout' });
    expect(await gw.sendReport('hi')).toEqual({ status: 'failed', code: 'stopped' });
  });

  it('sends nothing when stop comes while the socket is still connecting', async () => {
    const { gw, sockets } = await setup({ scripts: [() => {}] });
    const p = gw.sendReport('hi');
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await gw.stop();
    open(sockets[0]!); // WhatsApp reports open after the service stopped
    expect(await p).toEqual({ status: 'failed', code: 'stopped' });
    expect(sockets[0]!.sendMessage).not.toHaveBeenCalled();
    expect(sockets[0]!.end).toHaveBeenCalled();
  });

  it('listens only to creds.update and connection.update: it never reads chats', async () => {
    const { gw, sockets } = await setup();
    await gw.sendReport('hi');
    expect(sockets[0]!.subscribedEvents().sort()).toEqual(['connection.update', 'creds.update']);
  });

  it('reports unknown, never sent, when WhatsApp returns no message id', async () => {
    const noId: Script[] = [
      (s) => {
        s.sendMessage.mockResolvedValueOnce(undefined);
        open(s);
      },
      (s) => {
        s.sendMessage.mockResolvedValueOnce({ key: {} });
        open(s);
      },
    ];
    for (const script of noId) {
      const { gw, sockets } = await setup({ scripts: [script] });
      expect(await gw.sendReport('hi')).toEqual({ status: 'unknown', code: 'send_error' });
      expect(sockets[0]!.end).toHaveBeenCalled();
    }
  });

  it('keeps the socket open for the linger time after the message left', async () => {
    const { gw, sockets } = await setup({ lingerMs: 400 });
    const p = gw.sendReport('hi');
    await vi.waitFor(() => expect(sockets[0]?.sendMessage).toHaveBeenCalledTimes(1), { interval: 5 });
    await new Promise((r) => setTimeout(r, 10));
    expect(sockets[0]!.end).not.toHaveBeenCalled();
    expect(await p).toEqual({ status: 'sent', messageIds: ['msg-1'] });
    expect(sockets[0]!.end).toHaveBeenCalled();
  });

  it('stop() during the linger ends it at once and keeps the sent result: the message id is already back', async () => {
    const { gw, sockets } = await setup({ lingerMs: 60_000 });
    const p = gw.sendReport('hi');
    await vi.waitFor(() => expect(sockets[0]?.sendMessage).toHaveBeenCalledTimes(1), { interval: 5 });
    await new Promise((r) => setTimeout(r, 10)); // now in the linger
    await gw.stop();
    expect(await p).toEqual({ status: 'sent', messageIds: ['msg-1'] });
    expect(sockets[0]!.end).toHaveBeenCalledTimes(1);
  });

  it('is free for the next send after a send that went out', async () => {
    const { gw, sockets } = await setup();
    expect(await gw.sendReport('day 1')).toEqual({ status: 'sent', messageIds: ['msg-1'] });
    expect(await gw.sendReport('day 2')).toEqual({ status: 'sent', messageIds: ['msg-1'] });
    expect(sockets).toHaveLength(2);
    for (const s of sockets) expect(s.end).toHaveBeenCalled();
    expect(gw.status().state).toBe('idle');
  });

  it('is free for the next send after a definite failure or an unknown result', async () => {
    const qr: Script = (s) => s.emit('connection.update', { qr: 'QR-1' });
    const afterFailure = await setup({ scripts: [qr, open] });
    expect(await afterFailure.gw.sendReport('hi')).toEqual({ status: 'failed', code: 'not_linked' });
    expect(await afterFailure.gw.sendReport('hi')).toEqual({ status: 'sent', messageIds: ['msg-1'] });
    expect(afterFailure.sockets).toHaveLength(2);

    const afterUnknown = await setup({ scripts: [hang, open], sendTimeoutMs: 20 });
    expect(await afterUnknown.gw.sendReport('hi')).toEqual({ status: 'unknown', code: 'timeout' });
    expect(await afterUnknown.gw.sendReport('hi')).toEqual({ status: 'sent', messageIds: ['msg-1'] });
    expect(afterUnknown.sockets).toHaveLength(2);
  });

  it('keeps the sent result and frees the gateway when closing the socket throws or rejects', async () => {
    const endThrows: Script = (s) => {
      s.end.mockImplementation(() => {
        throw new Error('dead');
      });
      open(s);
    };
    const endRejects: Script = (s) => {
      s.end.mockImplementation(() => Promise.reject(new Error('dead')));
      open(s);
    };
    for (const script of [endThrows, endRejects]) {
      const { gw, sockets } = await setup({ scripts: [script, script] });
      expect(await gw.sendReport('hi')).toEqual({ status: 'sent', messageIds: ['msg-1'] });
      expect(sockets[0]!.end).toHaveBeenCalled();
      expect(await gw.sendReport('hi')).toEqual({ status: 'sent', messageIds: ['msg-1'] });
      await expect(gw.stop()).resolves.toBeUndefined();
    }
  });

  it('shows connecting while the socket opens, open while sending, and idle afterwards', async () => {
    const connecting = await setup({ scripts: [() => {}], connectTimeoutMs: 50 });
    const p = connecting.gw.sendReport('hi');
    await vi.waitFor(() => expect(connecting.sockets).toHaveLength(1));
    expect(connecting.gw.status().state).toBe('connecting');
    expect(await p).toEqual({ status: 'failed', code: 'connect_timeout' });
    expect(connecting.gw.status().state).toBe('idle');

    const sending = await setup({ scripts: [hang], sendTimeoutMs: 50 });
    const q = sending.gw.sendReport('hi');
    await vi.waitFor(() => expect(sending.sockets[0]?.sendMessage).toHaveBeenCalled());
    expect(sending.gw.status().state).toBe('open');
    expect(await q).toEqual({ status: 'unknown', code: 'timeout' });
    expect(sending.gw.status().state).toBe('idle');
  });

  it('a failed credential save does not become an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      // A plain function, not vi.fn: a mock attaches its own handler to the promises it returns, which would hide the bug.
      let saves = 0;
      const saveCreds = (): Promise<void> => {
        saves++;
        return Promise.reject(new Error('disk'));
      };
      const auth = { ...(await senderAuth(true)), saveCreds };
      const credsThenOpen: Script = (s) => {
        s.emit('creds.update', {});
        open(s);
      };
      const { gw } = await setup({ auth, scripts: [credsThenOpen] });
      expect(await gw.sendReport('hi')).toEqual({ status: 'sent', messageIds: ['msg-1'] });
      expect(saves).toBeGreaterThan(0);
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('SenderGateway default timings', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function defaultGateway(scripts: Script[]) {
    const { factory, sockets } = scriptedFactory(scripts);
    // No connectTimeoutMs, sendTimeoutMs or lingerMs: the production defaults apply.
    const gw = new SenderGateway({ recipient: RECIPIENT, factory, auth: await senderAuth(true) });
    return { gw, sockets };
  }

  it('lingers 15 s after the message left before closing the socket', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { gw, sockets } = await defaultGateway([open]);
    const p = gw.sendReport('hi');
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0]!.sendMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(14_900);
    expect(sockets[0]!.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(await p).toEqual({ status: 'sent', messageIds: ['msg-1'] });
    expect(sockets[0]!.end).toHaveBeenCalled();
  });

  it('leaves no connect timer when adding the connection listener throws, and fails definitely', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const sock = new FakeSocket();
    const on = sock.ev.on;
    sock.ev.on = ((event: string, listener: never) => {
      if (event === 'connection.update') throw new Error('listener failed');
      on(event as 'creds.update', listener);
    }) as typeof sock.ev.on;
    const gw = new SenderGateway({ recipient: RECIPIENT, factory: () => sock, auth: await senderAuth(true) });
    expect(await gw.sendReport('hi')).toEqual({ status: 'failed', code: 'connect_error' });
    expect(sock.end).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits 60 s for the connection to open', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { gw, sockets } = await defaultGateway([() => {}]);
    const p = gw.sendReport('hi');
    await vi.advanceTimersByTimeAsync(59_900);
    expect(sockets[0]!.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(await p).toEqual({ status: 'failed', code: 'connect_timeout' });
  });

  it('leaves no timer running after a send that went out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { gw } = await defaultGateway([open]);
    let result: unknown;
    const p = gw.sendReport('hi').then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(15_000);
    await p;
    expect(result).toEqual({ status: 'sent', messageIds: ['msg-1'] });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop() while the text send is in flight: a send that then returns its id is sent, with no linger and no timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let release: (msg: { key: { id: string } }) => void = () => {};
    const gated: Script = (s) => {
      s.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
      open(s);
    };
    const { gw, sockets } = await defaultGateway([gated]);
    let result: unknown;
    const p = gw.sendReport('hi').then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0]!.sendMessage).toHaveBeenCalledTimes(1); // the text is on its way
    await gw.stop();
    release({ key: { id: 'msg-1' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toEqual({ status: 'sent', messageIds: ['msg-1'] });
    await p;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives a socket whose end() never resolves 3 s: a send whose ids are back still returns sent, with no timer left', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const endHangs: Script = (s) => {
      s.end.mockImplementation(() => new Promise<void>(() => {}));
      open(s);
    };
    const { factory, sockets } = scriptedFactory([endHangs]);
    const gw = new SenderGateway({ recipient: RECIPIENT, factory, auth: await senderAuth(true), lingerMs: 0 });
    let result: unknown;
    const p = gw.sendReport('hi').then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(2_900);
    expect(sockets[0]!.end).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    expect(result).toEqual({ status: 'sent', messageIds: ['msg-1'] });
    await p;
    expect(gw.status().state).toBe('idle');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop() gives a socket whose end() never resolves 3 s, then returns', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stuck: Script = (s) => {
      s.end.mockImplementation(() => new Promise<void>(() => {}));
      s.sendMessage.mockImplementationOnce(() => new Promise(() => {})); // the text send never answers
      open(s);
    };
    const { gw, sockets } = await defaultGateway([stuck]);
    let result: unknown;
    const p = gw.sendReport('hi').then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0]!.sendMessage).toHaveBeenCalledTimes(1);
    let stopped = false;
    const s = gw.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(2_900);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(stopped).toBe(true);
    await s;
    expect(sockets[0]!.end).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000); // the text send's own limit
    await p;
    expect(result).toEqual({ status: 'unknown', code: 'timeout' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer running after WhatsApp refuses the connection', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { gw } = await defaultGateway([(s) => closeWith(s, 401)]);
    let result: unknown;
    const p = gw.sendReport('hi').then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(result).toEqual({ status: 'failed', code: 'logged_out' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives the message 120 s before reporting unknown', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { gw, sockets } = await defaultGateway([hang]);
    let result: unknown;
    const p = gw.sendReport('hi').then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(119_900);
    expect(sockets[0]!.sendMessage).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(result).toEqual({ status: 'unknown', code: 'timeout' });
  });
});

describe('linkSender', () => {
  it('shows the QR code, reconnects once after the scan, saves the session and sends nothing', async () => {
    const { factory, sockets } = scriptedFactory([
      (s) => {
        s.emit('connection.update', { qr: 'QR-1' });
        closeWith(s, 515); // restart required after the scan
      },
      open,
    ]);
    const auth = await senderAuth(false);
    const saveCreds = vi.fn(auth.saveCreds);
    const qr: string[] = [];
    expect(await linkSender({ factory, auth: { ...auth, saveCreds }, onQr: (q) => qr.push(q), timeoutMs: 1_000, settleMs: 0 })).toEqual({ ok: true });
    expect(qr).toEqual(['QR-1']);
    expect(saveCreds).toHaveBeenCalled();
    expect(sockets).toHaveLength(2);
    for (const s of sockets) {
      expect(s.subscribedEvents().sort()).toEqual(['connection.update', 'creds.update']);
      expect(s.end).toHaveBeenCalled();
      for (const name of SEND_METHODS) expect(s[name]).not.toHaveBeenCalled();
    }
  });

  it('opens at most 3 sockets when WhatsApp keeps asking for a restart', async () => {
    const restart: Script = (s) => closeWith(s, 515);
    const { factory, sockets } = scriptedFactory([restart, restart, restart, restart, restart, restart]);
    expect(await linkSender({ factory, auth: await senderAuth(false), onQr: () => {}, timeoutMs: 1_000, settleMs: 0 })).toEqual({ ok: false, code: 'closed' });
    expect(sockets).toHaveLength(3);
    for (const s of sockets) expect(s.end).toHaveBeenCalled();
  });

  it('keeps the linked socket open for the settle time before saving and closing', async () => {
    const { factory, sockets } = scriptedFactory([(s) => closeWith(s, 515), open]);
    const auth = await senderAuth(false);
    const saveCreds = vi.fn(auth.saveCreds);
    const p = linkSender({ factory, auth: { ...auth, saveCreds }, onQr: () => {}, timeoutMs: 1_000, settleMs: 200 });
    await vi.waitFor(() => expect(sockets).toHaveLength(2), { interval: 5 });
    await new Promise((r) => setTimeout(r, 20));
    expect(sockets[1]!.end).not.toHaveBeenCalled();
    expect(saveCreds).not.toHaveBeenCalled();
    expect(await p).toEqual({ ok: true });
    expect(saveCreds).toHaveBeenCalled();
    expect(sockets[1]!.end).toHaveBeenCalled();
  });

  it('stops when WhatsApp refuses the link', async () => {
    const { factory } = scriptedFactory([(s) => closeWith(s, 401)]);
    expect(await linkSender({ factory, auth: await senderAuth(false), onQr: () => {}, timeoutMs: 1_000, settleMs: 0 })).toEqual({ ok: false, code: 'logged_out' });
  });
});

describe('linkSender with a signal (the dashboard)', () => {
  it('an abort closes the socket and gives closed; no settle wait, no save', async () => {
    const { factory, sockets } = scriptedFactory([(s) => s.emit('connection.update', { qr: 'QR-1' })]);
    const auth = await senderAuth(false);
    const saveCreds = vi.fn(auth.saveCreds);
    const stop = new AbortController();
    const p = linkSender({ factory, auth: { ...auth, saveCreds }, onQr: () => {}, timeoutMs: 60_000, settleMs: 60_000, signal: stop.signal });
    await vi.waitFor(() => expect(sockets).toHaveLength(1), { interval: 5 });
    stop.abort();
    expect(await p).toEqual({ ok: false, code: 'closed' });
    expect(sockets[0]!.end).toHaveBeenCalled();
    expect(saveCreds).not.toHaveBeenCalled();
  });

  it('an abort during the settle time ends the open socket without saving', async () => {
    const { factory, sockets } = scriptedFactory([open]);
    const auth = await senderAuth(false);
    const saveCreds = vi.fn(auth.saveCreds);
    const stop = new AbortController();
    const p = linkSender({ factory, auth: { ...auth, saveCreds }, onQr: () => {}, timeoutMs: 1_000, settleMs: 60_000, signal: stop.signal });
    await vi.waitFor(() => expect(sockets).toHaveLength(1), { interval: 5 });
    await new Promise((r) => setTimeout(r, 10));
    stop.abort();
    expect(await p).toEqual({ ok: false, code: 'closed' });
    expect(saveCreds).not.toHaveBeenCalled();
    expect(sockets[0]!.end).toHaveBeenCalled();
  });

  it('onScanned fires when WhatsApp asks for its restart after a QR code, not for a restart with no QR', async () => {
    let scanned = 0;
    const withQr = scriptedFactory([(s) => { s.emit('connection.update', { qr: 'QR-1' }); closeWith(s, 515); }, open]);
    await linkSender({ factory: withQr.factory, auth: await senderAuth(false), onQr: () => {}, onScanned: () => scanned++, timeoutMs: 1_000, settleMs: 0 });
    expect(scanned).toBe(1);
    scanned = 0;
    const noQr = scriptedFactory([(s) => closeWith(s, 515), open]);
    await linkSender({ factory: noQr.factory, auth: await senderAuth(false), onQr: () => {}, onScanned: () => scanned++, timeoutMs: 1_000, settleMs: 0 });
    expect(scanned).toBe(0);
  });
});
