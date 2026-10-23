import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
/** Baileys socket methods that send something to WhatsApp: a message, a receipt, presence, or a chat change. */
const SEND_NAMES = /\b(sendMessage|relayMessage|sendPresenceUpdate|readMessages|sendReceipt|sendReceipts|chatModify|sendMessageAck)\b/;

function sources(): { file: string; text: string }[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: f.replaceAll('\\', '/'), text: readFileSync(join(SRC, f), 'utf8') }));
}

describe('who may send on WhatsApp', () => {
  it('scans the real source tree', () => {
    const files = sources().map((s) => s.file);
    expect(files.length).toBeGreaterThan(40);
    expect(files).toEqual(expect.arrayContaining(['wa/gateway.ts', 'wa/senderGateway.ts', 'app.ts']));
  });

  it('no module except src/wa/senderGateway.ts names a Baileys send method', () => {
    const offenders = sources().filter((s) => s.file !== 'wa/senderGateway.ts' && SEND_NAMES.test(s.text)).map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  it('senderGateway calls sendMessage in one place, and never receipts, presence or chat changes', () => {
    const text = readFileSync(join(SRC, 'wa', 'senderGateway.ts'), 'utf8');
    expect(text.match(/\.sendMessage\(/g)).toHaveLength(1);
    // Every mention, with or without a dot: the interface declaration and the one call in #send. Nothing else.
    const lines = text.split('\n').filter((l) => /\bsendMessage\b/.test(l)).map((l) => l.trim());
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^sendMessage\(jid: string, content: AnyMessageContent\): Promise</);
    expect(lines[1]).toMatch(/^sock\.sendMessage\(jid, content\),$/);
    expect(text.match(/\bsendMessage\b/g)).toHaveLength(2);
    expect(text).not.toMatch(/\b(relayMessage|sendPresenceUpdate|readMessages|sendReceipt|sendReceipts|chatModify|sendMessageAck)\b/);
  });

  it('#send checks the recipient before it calls sendMessage', () => {
    const text = readFileSync(join(SRC, 'wa', 'senderGateway.ts'), 'utf8');
    const start = text.indexOf('async #send(');
    expect(start).toBeGreaterThan(-1);
    const body = text.slice(start);
    const check = body.indexOf('checkRecipient(jid, this.#jid);');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(body.indexOf('sock.sendMessage('));
  });

  it('only the two gateways create a Baileys socket', () => {
    const makers = sources().filter((s) => /\bmakeWASocket\b/.test(s.text)).map((s) => s.file).sort();
    expect(makers).toEqual(['wa/gateway.ts', 'wa/senderGateway.ts']);
  });
});
