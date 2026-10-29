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

/**
 * The dashboard's sign-out route is a URL path (spec section 8), not a Baileys call: that one exact string literal is
 * removed before the scan, and only in the dashboard's auth routes.
 */
const DASHBOARD_SIGN_OUT_PATH = "'/dashboard/auth/logout'";

function sources(): { file: string; text: string }[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => {
      const file = f.replaceAll('\\', '/');
      const text = readFileSync(join(SRC, f), 'utf8');
      return { file, text: file === 'web/routes/auth.ts' ? text.replaceAll(DASHBOARD_SIGN_OUT_PATH, "''") : text };
    });
}

describe('who may send on WhatsApp', () => {
  it('scans the real source tree', () => {
    const files = sources().map((s) => s.file);
    expect(files.length).toBeGreaterThan(40);
    expect(files).toEqual(expect.arrayContaining(['wa/gateway.ts', 'wa/senderGateway.ts', 'app.ts']));
  });

  it('no module except src/wa/senderGateway.ts and src/wa/groupSend.ts names a Baileys send method', () => {
    const offenders = sources().filter((s) => s.file !== 'wa/senderGateway.ts' && s.file !== 'wa/groupSend.ts' && SEND_NAMES.test(s.text)).map((s) => s.file);
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

describe('the one request the founder reader makes (history backfill, 28 Oct 2026)', () => {
  it('fetchMessageHistory is named only in src/wa/gateway.ts, called once, behind the allow-list and the open check', () => {
    const named = sources().filter((s) => /\bfetchMessageHistory\b/.test(s.text)).map((s) => s.file);
    expect(named).toEqual(['wa/gateway.ts']);
    const text = readFileSync(join(SRC, 'wa', 'gateway.ts'), 'utf8');
    expect(text.match(/\.fetchMessageHistory\(/g)).toHaveLength(1);
    // The guard sits right before the call: stopped, no socket, not open, or not an approved group asks for nothing.
    const call = text.indexOf('.fetchMessageHistory(');
    const guard = text.lastIndexOf("if (this.#stopped || !sock || this.#status.state !== 'open' || !this.#opts.allow.has(groupId)) return false;", call);
    expect(guard).toBeGreaterThan(-1);
    expect(call - guard).toBeLessThan(300);
  });
});

describe('the one send from the founder’s WhatsApp (Open chat, 29 Oct 2026)', () => {
  const groupSend = () => readFileSync(join(SRC, 'wa', 'groupSend.ts'), 'utf8');

  it('groupSend calls sendMessage once, and names no other outbound method', () => {
    const text = groupSend();
    expect(text.match(/\.sendMessage\(/g)).toHaveLength(1);
    // The interface, the check that a socket has it, and the one call. Nothing else.
    expect(text.match(/\bsendMessage\b/g)).toHaveLength(3);
    expect(text).not.toMatch(OTHER_OUTBOUND);
  });

  it('the call comes after the group check and the founder gateway’s own check', () => {
    const text = groupSend();
    const body = text.slice(text.indexOf('export async function sendGroupText('));
    const call = body.indexOf('sock.sendMessage(');
    expect(call).toBeGreaterThan(-1);
    for (const before of ['if (!GROUP_JID.test(groupId)) return', 'const sock = source(groupId);', 'if (!sock) return']) {
      expect(body.indexOf(before), before).toBeGreaterThan(-1);
      expect(body.indexOf(before), before).toBeLessThan(call);
    }
  });

  it('the founder gateway gives its socket only for an approved group while open, right before handing it over', () => {
    const text = readFileSync(join(SRC, 'wa', 'gateway.ts'), 'utf8');
    const give = text.indexOf('return asGroupSendSocket(sock);');
    expect(give).toBeGreaterThan(-1);
    expect(text.match(/asGroupSendSocket\(/g)).toHaveLength(1);
    const guard = text.lastIndexOf("if (this.#stopped || !sock || this.#status.state !== 'open' || !this.#opts.allow.has(groupId)) return null;", give);
    expect(guard).toBeGreaterThan(-1);
    expect(give - guard).toBeLessThan(200);
  });

  it('only the dashboard’s chat route sends, and only the gateways hand out the socket', () => {
    expect(sources().filter((s) => /\bsendGroupText\(/.test(s.text)).map((s) => s.file).sort()).toEqual(['wa/groupSend.ts', 'web/routes/chat.ts']);
    expect(sources().filter((s) => /\bgroupSocket\(/.test(s.text)).map((s) => s.file).sort()).toEqual(['main.ts', 'wa/gateway.ts', 'wa/switchableGateway.ts']);
  });

  it('the chat route checks the setting, the client and the limits, and claims the row before it sends', () => {
    const text = readFileSync(join(SRC, 'web', 'routes', 'chat.ts'), 'utf8');
    const send = text.indexOf('await sendGroupText(');
    expect(send).toBeGreaterThan(-1);
    for (const before of ['if (!deps.sendingOn()) return', 'const c = approvedClient(deps, code);', 'claimOutbox(deps.db,', 'markSending(deps.db,', "'dashboard send: asking WhatsApp'"]) {
      expect(text.indexOf(before), before).toBeGreaterThan(-1);
      expect(text.indexOf(before), before).toBeLessThan(send);
    }
  });
});
