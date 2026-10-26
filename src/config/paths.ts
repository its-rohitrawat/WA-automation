import { join } from 'node:path';

export const trackerDbPath = (dataDir: string): string => join(dataDir, 'tracker.db');
export const sessionDbPath = (dataDir: string): string => join(dataDir, 'session.db');
/** The spare number's WhatsApp session (Phase 2c morning report). Never the founder's session. */
export const senderSessionDbPath = (dataDir: string): string => join(dataDir, 'sender-session.db');
/** DPAPI-protected on Windows, an owner-only plain file elsewhere. The names differ, so one is never read as the other. */
export const masterKeyPath = (dataDir: string): string =>
  join(dataDir, 'keys', process.platform === 'win32' ? 'master.key.dpapi' : 'master.key');
