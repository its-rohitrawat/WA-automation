import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
/**
 * Baileys socket methods, other than sendMessage, that put traffic on WhatsApp in the account's name: a receipt, presence,
 * a chat or profile change, a call rejection, a group, community or newsletter action, a retry or analytics packet, a raw
 * node or IQ query (sendNode, query), an app-state patch or a star, a block, a logout or a pairing-code request.
 * The scan matches whole words, also in comments: a comment in src/ that needs one of these words is reworded.
 * (updateMediaMessage and reuploadRequest are checked by tests/media/fetch.test.ts.)
 */
const OUTBOUND = [
  'relayMessage', 'sendPresenceUpdate', 'presenceSubscribe', 'readMessages', 'sendReceipt', 'sendReceipts', 'chatModify',
  'sendMessageAck', 'sendPeerDataOperationMessage', 'sendRetryRequest', 'rejectCall', 'updateProfile\\w*',
  'group(?:Create|Leave|ParticipantsUpdate|Update\\w*)', 'newsletter\\w*', 'sendWAMBuffer', 'sendNode', 'query', 'appPatch', 'star',
  'updateBlockStatus', 'logout', 'requestPairingCode', 'community\\w*',
].join('|');
/** Every Baileys method that sends something to WhatsApp. */
const SEND_NAMES = new RegExp(`\\b(sendMessage|${OUTBOUND})\\b`);
const OTHER_OUTBOUND = new RegExp(`\\b(${OUTBOUND})\\b`);

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

  it('senderGateway calls sendMessage in one place, and no other outbound method', () => {
    const text = readFileSync(join(SRC, 'wa', 'senderGateway.ts'), 'utf8');
    expect(text.match(/\.sendMessage\(/g)).toHaveLength(1);
    // Every mention, with or without a dot: the interface declaration and the one call in #send. Nothing else.
    const lines = text.split('\n').filter((l) => /\bsendMessage\b/.test(l)).map((l) => l.trim());
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^sendMessage\(jid: string, content: AnyMessageContent\): Promise</);
    expect(lines[1]).toMatch(/^sock\.sendMessage\(jid, content\),$/);
    expect(text.match(/\bsendMessage\b/g)).toHaveLength(2);
    expect(text).not.toMatch(OTHER_OUTBOUND);
  });

  it('the outbound list catches every method it names, and not read-only ones', () => {
    for (const name of [
      'sendMessage', 'relayMessage', 'sendPresenceUpdate', 'presenceSubscribe', 'readMessages', 'sendReceipt', 'sendReceipts',
      'chatModify', 'sendMessageAck', 'sendPeerDataOperationMessage', 'sendRetryRequest', 'rejectCall', 'updateProfileStatus',
      'updateProfileName', 'updateProfilePicture', 'groupCreate', 'groupLeave', 'groupParticipantsUpdate', 'groupUpdateSubject',
      'newsletterCreate', 'newsletterFollow', 'sendWAMBuffer', 'sendNode', 'query', 'appPatch', 'star', 'updateBlockStatus', 'logout',
      'requestPairingCode', 'communityCreate', 'communityLeave', 'communityParticipantsUpdate',
    ]) {
      expect(`sock.${name}(x)`).toMatch(SEND_NAMES);
      if (name !== 'sendMessage') expect(`sock.${name}(x)`).toMatch(OTHER_OUTBOUND);
    }
    for (const read of ['groupMetadata', 'groupFetchAllParticipating', 'onWhatsApp', 'profilePictureUrl']) {
      expect(`sock.${read}(x)`).not.toMatch(SEND_NAMES);
    }
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
