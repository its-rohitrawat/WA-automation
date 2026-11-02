import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { senderSessionDbPath, sessionDbPath, trackerDbPath } from '../../src/config/paths.ts';
import { createInvite, redeemInvite } from '../../src/platform/invites.ts';
import { ensurePlatformSchema } from '../../src/platform/schema.ts';
import { ensureFounderTenant } from '../../src/platform/store.ts';
import { syncClients } from '../../src/store/clients.ts';
import { openDb } from '../../src/store/db.ts';
import { openSessionFile } from '../../src/store/engine/sessionFile.ts';
import { setKv } from '../../src/store/kv.ts';
import { insertMedia, messageRowId } from '../../src/store/media.ts';
import { insertMessage } from '../../src/store/messages.ts';
import { manualClock } from '../../src/util/clock.ts';
import { MEHTA, SHARMA } from '../helpers/db.ts';

// SQLite by design: the founder's SQLite data folder the copy reads from (on both runs).
// A data folder as the agent leaves it, for the copy tool's tests: tracker.db (migrated, with clients, messages, a file
// row with a blob, kv, the platform tables with the founder, a customer and an invite), session.db (live and backup
// keys) and, when asked, sender-session.db. Every value is made up.

export interface Fixture {
  dir: string;
  data: string;
  /** SHA-256 of each .db file there, to prove the copy changed none of them. */
  hashes(): Record<string, string>;
}

const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * sender: also a sender-session.db. platform false: the platform tables stay empty (no founder row, customers or
 * invites), for a test server whose platform tables every test shares.
 */
export async function fixture(o: { sender?: boolean; platform?: boolean } = {}): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'wa-copy-'));
  const data = join(dir, 'data');
  const clock = manualClock('2026-10-30T06:00:00.000Z');
  const db = openDb(trackerDbPath(data));
  try {
    await ensurePlatformSchema(db);
    await syncClients(db, [SHARMA, MEHTA], clock.now());
    for (let i = 1; i <= 5; i++) {
      await insertMessage(db, {
        waId: `WA${i}`, clientId: 1 + (i % 2), senderJid: `9198${i}@s.whatsapp.net`, senderNumber: `9198${i}`, senderName: `Person ${i}`,
        fromMe: i === 3, ts: `2026-10-29T0${i}:00:00.000Z`, text: i === 4 ? null : `Message ${i}, with a 'quote' and ₹50`, quotedWaId: null, mediaType: i === 4 ? 'image' : null,
      });
    }
    const messageId = (await messageRowId(db, 1, 'WA4'))!;
    await insertMedia(db, {
      messageId, clientId: 1, kind: 'image', status: 'pending', mimeType: 'image/jpeg', fileName: 'site.jpg', fileSize: 1234, seconds: null,
      forwarded: false, refEnc: Buffer.from([0, 1, 2, 250, 255]), errorCode: null, createdAt: clock.now().toISOString(),
    });
    await setKv(db, 'rebuild_requested', '');
    await setKv(db, 'health', '{"up":true}');
    if (o.platform !== false) {
      await ensureFounderTenant(db, { name: 'Your studio', at: clock.now().toISOString() });
      const made = await createInvite({ db, clock }, 'founder@example.com', { business: 'Kapoor Design Studio', email: 'kapoor@example.com' });
      clock.advance(60_000);
      await redeemInvite({ db, clock }, { token: made.token, email: 'kapoor@example.com', name: 'Asha' });
      await createInvite({ db, clock }, 'founder@example.com', { business: 'Gupta Events', email: 'gupta@example.com' });
    }
  } finally {
    await db.close();
  }
  const session = openSessionFile(sessionDbPath(data));
  await session.run('INSERT INTO auth (k, v) VALUES (?, ?), (?, ?)', ['creds', Buffer.from('made-up creds'), 'pre-key-1', Buffer.from([9, 8, 7])]);
  await session.run('INSERT INTO auth_backup (k, v) VALUES (?, ?)', ['creds', Buffer.from('older made-up creds')]);
  await session.close();
  if (o.sender) {
    const sender = openSessionFile(senderSessionDbPath(data));
    await sender.run('INSERT INTO auth (k, v) VALUES (?, ?)', ['creds', Buffer.from('made-up spare creds')]);
    await sender.close();
  }
  return {
    dir,
    data,
    hashes: () => {
      const out: Record<string, string> = {};
      for (const f of [trackerDbPath(data), sessionDbPath(data), senderSessionDbPath(data)]) if (existsSync(f)) out[f] = sha(f);
      return out;
    },
  };
}
