import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { senderSessionDbPath } from '../../src/config/paths.ts';
import { spareDriver } from '../../src/report/dashboardReport.ts';
import { silentLogger } from '../../src/util/logger.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('spareDriver', () => {
  it('a link cancelled while the briefing finished a send never touches the session file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wa-spare-'));
    dirs.push(dir);
    const abort = new AbortController();
    const linking: boolean[] = [];
    let released = 0;
    const driver = spareDriver({
      dataDir: dir, key: Buffer.alloc(32, 7), factory: (() => { throw new Error('no socket in this test'); }) as never,
      founderNumber: () => undefined, settingsNumber: () => undefined, adoptDb: () => {}, log: silentLogger(),
      linking: (on) => linking.push(on),
      briefing: {
        // The send in flight ends after the owner cancelled.
        pause: async () => {
          abort.abort('cancelled');
          return () => void released++;
        },
        reportDb: () => undefined, scheduler: () => undefined, recipient: () => undefined,
      },
    });
    const qr: string[] = [];
    const out = await driver.run({ qr: (q: string) => qr.push(q) } as never, abort.signal);
    expect(out).toEqual({ ok: false, code: 'cancelled' });
    expect(linking).toEqual([true, false]);
    expect(released).toBe(1);
    expect(qr).toEqual([]);
    expect(existsSync(senderSessionDbPath(dir))).toBe(false); // never opened, never made
  });
});
