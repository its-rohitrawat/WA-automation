import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { XLSX_MIME } from '../../src/output/workbook.ts';
import { openSessionDb, useSenderAuthState, type EncryptedAuth } from '../../src/wa/authState.ts';
import { checkRecipient, linkSender, recipientJid, RecipientRefusedError, SenderGateway } from '../../src/wa/senderGateway.ts';
import { closeWith, FakeSocket, SEND_METHODS } from '../helpers/fakeSocket.ts';

const RECIPIENT = '919800000000';
const JID = '919800000000@s.whatsapp.net';
const XLSX = Buffer.from('xlsx bytes');
const FILE = 'Tracker-2026-10-23.xlsx';

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

function senderAuth(linked: boolean): EncryptedAuth {
  const auth = useSenderAuthState(openSessionDb(':memory:'), randomBytes(32));
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

function setup(
  o: { scripts?: Script[]; auth?: EncryptedAuth; noAuth?: boolean; connectTimeoutMs?: number; sendTimeoutMs?: number; lingerMs?: number } = {},
) {
  const { factory, sockets } = scriptedFactory(o.scripts);
  const gw = new SenderGateway({
    recipient: RECIPIENT,
    factory,
    auth: o.noAuth ? undefined : (o.auth ?? senderAuth(true)),
    connectTimeoutMs: o.connectTimeoutMs ?? 1_000,
    sendTimeoutMs: o.sendTimeoutMs ?? 1_000,
    lingerMs: o.lingerMs ?? 0,
  });
  return { gw, sockets };
}

describe('SenderGateway', () => {
  it('sends the text, then the tracker as a document, to the configured recipient, then disconnects', async () => {
    const { gw, sockets } = setup();
    expect(await gw.sendReport('Morning report · 23 Oct', XLSX, FILE)).toEqual({ status: 'sent', messageIds: ['msg-1', 'msg-2'] });
    const sock = sockets[0]!;
    expect(sock.sendMessage.mock.calls).toEqual([
      [JID, { text: 'Morning report · 23 Oct', linkPreview: null }],
      [JID, { document: XLSX, mimetype: XLSX_MIME, fileName: FILE }],
    ]);
    expect(sock.end).toHaveBeenCalled();
    expect(gw.status().state).toBe('idle');
  });

  it('sets no presence, sends no read receipts and changes no chat', async () => {
    const { gw, sockets } = setup();
    await gw.sendReport('hi', XLSX, FILE);
    for (const name of SEND_METHODS.filter((n) => n !== 'sendMessage')) expect(sockets[0]![name]).not.toHaveBeenCalled();
  });

  it('refuses any recipient other than REPORT_RECIPIENT, and takes no recipient from the caller', () => {
    expect(recipientJid(RECIPIENT)).toBe(JID);
    expect(() => checkRecipient(JID, JID)).not.toThrow();
    expect(() => checkRecipient('919811111111@s.whatsapp.net', JID)).toThrow(RecipientRefusedError);
    expect(() => checkRecipient('120363000000000001@g.us', JID)).toThrow(RecipientRefusedError);
    for (const bad of ['+919800000000', '91 98000 00000', '120363000000000001@g.us', '']) {
      expect(() => new SenderGateway({ recipient: bad, factory: scriptedFactory().factory, auth: senderAuth(true) })).toThrow(/digits only/);
    }
    expect(SenderGateway.prototype.sendReport.length).toBe(3); // text, xlsx, fileName
  });

  it('accepts only 91 and a 10-digit Indian mobile as the recipient', () => {
    expect(recipientJid('919812345678')).toBe('919812345678@s.whatsapp.net');
    for (const bad of ['9812345678', '919812345', '9198123456789', '915812345678', '449812345678']) {
      expect(() => recipientJid(bad)).toThrow('REPORT_RECIPIENT must be 91 and the 10-digit Indian mobile, digits only');
    }
  });

  it('never puts the refused number or JID in an error message', () => {
    const badRecipients = [
      '+919800000000', '91 98000 00000', '120363000000000001@g.us',
      '9812345678', '919812345', '9198123456789', '915812345678', '449812345678',
    ];
    for (const bad of badRecipients) {
      expectNoLeak(() => recipientJid(bad), [bad]);
      expectNoLeak(() => new SenderGateway({ recipient: bad, factory: scriptedFactory().factory, auth: senderAuth(true) }), [bad]);
    }
    for (const refused of ['919811111111@s.whatsapp.net', '120363000000000001@g.us']) {
      expectNoLeak(() => checkRecipient(refused, JID), [refused, JID]);
    }
  });

  it('has exactly one send method', () => {
    const names = Object.getOwnPropertyNames(SenderGateway.prototype);
    expect(names.filter((n) => /send|read|presence|react|receipt|chatmodify|delete/i.test(n))).toEqual(['sendReport']);
  });

  it('fails definitely, without connecting, when the spare number is not linked', async () => {
    for (const o of [{ noAuth: true }, { auth: senderAuth(false) }]) {
      const { gw, sockets } = setup(o);
      expect(gw.status().state).toBe('not_linked');
      expect(await gw.sendReport('hi', XLSX, FILE)).toEqual({ status: 'failed', code: 'not_linked' });
      expect(sockets).toHaveLength(0);
    }
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
      const { gw, sockets } = setup({ scripts: [c.script], connectTimeoutMs: 20 });
      expect(await gw.sendReport('hi', XLSX, FILE)).toEqual({ status: 'failed', code: c.code });
      expect(sockets[0]!.sendMessage).not.toHaveBeenCalled();
      expect(sockets[0]!.end).toHaveBeenCalled();
      expect(gw.status()).toMatchObject({ state: c.state, lastErrorCode: c.statusCode });
    }
  });

  it('reports unknown when a send times out or fails after it started', async () => {
    const timedOut = setup({ scripts: [hang], sendTimeoutMs: 20 });
    expect(await timedOut.gw.sendReport('hi', XLSX, FILE)).toEqual({ status: 'unknown', code: 'timeout' });

    const docFails: Script = (s) => {
      s.sendMessage.mockResolvedValueOnce({ key: { id: 'msg-1' } }).mockRejectedValueOnce(new Error('upload failed'));
      open(s);
    };
    const failed = setup({ scripts: [docFails] });
    expect(await failed.gw.sendReport('hi', XLSX, FILE)).toEqual({ status: 'unknown', code: 'send_error' });
    expect(failed.sockets[0]!.sendMessage).toHaveBeenCalledTimes(2);
    expect(failed.sockets[0]!.end).toHaveBeenCalled();
  });

  it('sends one report at a time', async () => {
    const { gw } = setup({ scripts: [hang], sendTimeoutMs: 50 });
    const first = gw.sendReport('hi', XLSX, FILE);
    expect(await gw.sendReport('hi', XLSX, FILE)).toEqual({ status: 'failed', code: 'busy' });
    expect(await first).toEqual({ status: 'unknown', code: 'timeout' });
  });

  it('stop ends a send in progress and refuses later sends', async () => {
    const { gw, sockets } = setup({ scripts: [hang], sendTimeoutMs: 50 });
    const p = gw.sendReport('hi', XLSX, FILE);
    await vi.waitFor(() => expect(sockets[0]?.sendMessage).toHaveBeenCalled());
    await gw.stop();
    expect(sockets[0]!.end).toHaveBeenCalled();
    expect(await p).toEqual({ status: 'unknown', code: 'timeout' });
    expect(await gw.sendReport('hi', XLSX, FILE)).toEqual({ status: 'failed', code: 'stopped' });
  });

  it('sends nothing when stop comes while the socket is still connecting', async () => {
    const { gw, sockets } = setup({ scripts: [() => {}] });
    const p = gw.sendReport('hi', XLSX, FILE);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await gw.stop();
    open(sockets[0]!); // WhatsApp reports open after the service stopped
    expect(await p).toEqual({ status: 'failed', code: 'stopped' });
    expect(sockets[0]!.sendMessage).not.toHaveBeenCalled();
    expect(sockets[0]!.end).toHaveBeenCalled();
  });

  it('listens only to creds.update and connection.update: it never reads chats', async () => {
    const { gw, sockets } = setup();
    await gw.sendReport('hi', XLSX, FILE);
    expect(sockets[0]!.subscribedEvents().sort()).toEqual(['connection.update', 'creds.update']);
  });

  it('reports unknown, never sent, when WhatsApp returns no message id', async () => {
    const noId: Script[] = [
      (s) => {
        s.sendMessage.mockResolvedValueOnce(undefined);
        open(s);
      },
      (s) => {
        s.sendMessage.mockResolvedValueOnce({ key: { id: 'msg-1' } }).mockResolvedValueOnce({ key: {} });
        open(s);
      },
    ];
    for (const script of noId) {
      const { gw, sockets } = setup({ scripts: [script] });
      expect(await gw.sendReport('hi', XLSX, FILE)).toEqual({ status: 'unknown', code: 'send_error' });
      expect(sockets[0]!.end).toHaveBeenCalled();
    }
  });

  it('keeps the socket open for the linger time after both messages left', async () => {
    const { gw, sockets } = setup({ lingerMs: 400 });
    const p = gw.sendReport('hi', XLSX, FILE);
    await vi.waitFor(() => expect(sockets[0]?.sendMessage).toHaveBeenCalledTimes(2), { interval: 5 });
    await new Promise((r) => setTimeout(r, 10));
    expect(sockets[0]!.end).not.toHaveBeenCalled();
    expect(await p).toEqual({ status: 'sent', messageIds: ['msg-1', 'msg-2'] });
    expect(sockets[0]!.end).toHaveBeenCalled();
  });

  it('is free for the next send after a send that went out', async () => {
    const { gw, sockets } = setup();
    expect(await gw.sendReport('day 1', XLSX, FILE)).toEqual({ status: 'sent', messageIds: ['msg-1', 'msg-2'] });
    expect(await gw.sendReport('day 2', XLSX, FILE)).toEqual({ status: 'sent', messageIds: ['msg-1', 'msg-2'] });
    expect(sockets).toHaveLength(2);
    for (const s of sockets) expect(s.end).toHaveBeenCalled();
    expect(gw.status().state).toBe('idle');
  });

  it('is free for the next send after a definite failure or an unknown result', async () => {
    const qr: Script = (s) => s.emit('connection.update', { qr: 'QR-1' });
    const afterFailure = setup({ scripts: [qr, open] });
    expect(await afterFailure.gw.sendReport('hi', XLSX, FILE)).toEqual({ status: 'failed', code: 'not_linked' });
    expect(await afterFailure.gw.sendReport('hi', XLSX, FILE)).toEqual({ status: 'sent', messageIds: ['msg-1', 'msg-2'] });
    expect(afterFailure.sockets).toHaveLength(2);

    const afterUnknown = setup({ scripts: [hang, open], sendTimeoutMs: 20 });
    expect(await afterUnknown.gw.sendReport('hi', XLSX, FILE)).toEqual({ status: 'unknown', code: 'timeout' });
    expect(await afterUnknown.gw.sendReport('hi', XLSX, FILE)).toEqual({ status: 'sent', messageIds: ['msg-1', 'msg-2'] });
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
      const { gw, sockets } = setup({ scripts: [script, script] });
      expect(await gw.sendReport('hi', XLSX, FILE)).toEqual({ status: 'sent', messageIds: ['msg-1', 'msg-2'] });
      expect(sockets[0]!.end).toHaveBeenCalled();
      expect(await gw.sendReport('hi', XLSX, FILE)).toEqual({ status: 'sent', messageIds: ['msg-1', 'msg-2'] });
      await expect(gw.stop()).resolves.toBeUndefined();
    }
  });

  it('shows connecting while the socket opens, open while sending, and idle afterwards', async () => {
    const connecting = setup({ scripts: [() => {}], connectTimeoutMs: 50 });
    const p = connecting.gw.sendReport('hi', XLSX, FILE);
    await vi.waitFor(() => expect(connecting.sockets).toHaveLength(1));
    expect(connecting.gw.status().state).toBe('connecting');
    expect(await p).toEqual({ status: 'failed', code: 'connect_timeout' });
    expect(connecting.gw.status().state).toBe('idle');

    const sending = setup({ scripts: [hang], sendTimeoutMs: 50 });
    const q = sending.gw.sendReport('hi', XLSX, FILE);
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
      const auth = { ...senderAuth(true), saveCreds };
      const credsThenOpen: Script = (s) => {
        s.emit('creds.update', {});
        open(s);
      };
      const { gw } = setup({ auth, scripts: [credsThenOpen] });
      expect(await gw.sendReport('hi', XLSX, FILE)).toEqual({ status: 'sent', messageIds: ['msg-1', 'msg-2'] });
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

  function defaultGateway(scripts: Script[]) {
    const { factory, sockets } = scriptedFactory(scripts);
    // No connectTimeoutMs, sendTimeoutMs or lingerMs: the production defaults apply.
    const gw = new SenderGateway({ recipient: RECIPIENT, factory, auth: senderAuth(true) });
    return { gw, sockets };
  }

  it('lingers 15 s after both messages left before closing the socket', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { gw, sockets } = defaultGateway([open]);
    const p = gw.sendReport('hi', XLSX, FILE);
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0]!.sendMessage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(14_900);
    expect(sockets[0]!.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(await p).toEqual({ status: 'sent', messageIds: ['msg-1', 'msg-2'] });
    expect(sockets[0]!.end).toHaveBeenCalled();
  });

  it('waits 60 s for the connection to open', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { gw, sockets } = defaultGateway([() => {}]);
    const p = gw.sendReport('hi', XLSX, FILE);
    await vi.advanceTimersByTimeAsync(59_900);
    expect(sockets[0]!.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(await p).toEqual({ status: 'failed', code: 'connect_timeout' });
  });

  it('leaves no timer running after a send that went out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { gw } = defaultGateway([open]);
    let result: unknown;
    const p = gw.sendReport('hi', XLSX, FILE).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(15_000);
    await p;
    expect(result).toEqual({ status: 'sent', messageIds: ['msg-1', 'msg-2'] });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer running after WhatsApp refuses the connection', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { gw } = defaultGateway([(s) => closeWith(s, 401)]);
    let result: unknown;
    const p = gw.sendReport('hi', XLSX, FILE).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(result).toEqual({ status: 'failed', code: 'logged_out' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives each message 120 s before reporting unknown', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { gw, sockets } = defaultGateway([hang]);
    let result: unknown;
    const p = gw.sendReport('hi', XLSX, FILE).then((r) => (result = r));
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
    const auth = senderAuth(false);
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
    expect(await linkSender({ factory, auth: senderAuth(false), onQr: () => {}, timeoutMs: 1_000, settleMs: 0 })).toEqual({ ok: false, code: 'closed' });
    expect(sockets).toHaveLength(3);
    for (const s of sockets) expect(s.end).toHaveBeenCalled();
  });

  it('keeps the linked socket open for the settle time before saving and closing', async () => {
    const { factory, sockets } = scriptedFactory([(s) => closeWith(s, 515), open]);
    const auth = senderAuth(false);
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
    expect(await linkSender({ factory, auth: senderAuth(false), onQr: () => {}, timeoutMs: 1_000, settleMs: 0 })).toEqual({ ok: false, code: 'logged_out' });
  });
});
