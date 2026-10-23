import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
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

function setup(o: { scripts?: Script[]; auth?: EncryptedAuth; noAuth?: boolean; connectTimeoutMs?: number; sendTimeoutMs?: number } = {}) {
  const { factory, sockets } = scriptedFactory(o.scripts);
  const gw = new SenderGateway({
    recipient: RECIPIENT,
    factory,
    auth: o.noAuth ? undefined : (o.auth ?? senderAuth(true)),
    connectTimeoutMs: o.connectTimeoutMs ?? 1_000,
    sendTimeoutMs: o.sendTimeoutMs ?? 1_000,
    lingerMs: 0,
  });
  return { gw, sockets };
}

describe('SenderGateway', () => {
  it('sends the text, then the tracker as a document, to the configured recipient, then disconnects', async () => {
    const { gw, sockets } = setup();
    expect(await gw.sendReport('Morning report · 23 Oct', XLSX, FILE)).toEqual({ status: 'sent', messageIds: ['msg-1', 'msg-2'] });
    const sock = sockets[0]!;
    expect(sock.sendMessage.mock.calls).toEqual([
      [JID, { text: 'Morning report · 23 Oct' }],
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
      expect(s.end).toHaveBeenCalled();
      for (const name of SEND_METHODS) expect(s[name]).not.toHaveBeenCalled();
    }
  });

  it('stops when WhatsApp refuses the link', async () => {
    const { factory } = scriptedFactory([(s) => closeWith(s, 401)]);
    expect(await linkSender({ factory, auth: senderAuth(false), onQr: () => {}, timeoutMs: 1_000, settleMs: 0 })).toEqual({ ok: false, code: 'logged_out' });
  });
});
