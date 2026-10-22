import { join } from 'node:path';

export const trackerDbPath = (dataDir: string): string => join(dataDir, 'tracker.db');
export const sessionDbPath = (dataDir: string): string => join(dataDir, 'session.db');
export const masterKeyPath = (dataDir: string): string => join(dataDir, 'keys', 'master.key.dpapi');
