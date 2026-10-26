import { describe, expect, it } from 'vitest';
import type { DestinationStream } from 'pino';
import { createLogger } from '../../src/util/logger.ts';

describe('logger', () => {
  it('censors fields that can carry chat content', () => {
    const lines: string[] = [];
    const dest = { write: (s: string) => { lines.push(s); } } as unknown as DestinationStream;
    const log = createLogger('info', dest);
    log.info({ clientId: 3, text: 'banner thoda bright karo', prompt: 'secret prompt' }, 'stored');
    const out = lines.join('');
    expect(out).toContain('"clientId":3');
    expect(out).not.toContain('banner');
    expect(out).not.toContain('secret prompt');
    expect(out).toContain('[REDACTED]');
  });

  function capture() {
    const lines: string[] = [];
    const dest = { write: (s: string) => { lines.push(s); } } as unknown as DestinationStream;
    return { log: createLogger('info', dest), out: () => lines.join('') };
  }

  it('censors content fields one level deep', () => {
    const { log, out } = capture();
    log.info({ m: { text: 'NESTED-SECRET' } }, 'a');
    log.info({ m: { message: 'NESTED-MSG' } }, 'b');
    expect(out()).not.toContain('NESTED-SECRET');
    expect(out()).not.toContain('NESTED-MSG');
  });

  it('censors caption and conversation at the top level', () => {
    const { log, out } = capture();
    log.info({ caption: 'CAP-SECRET', conversation: 'CONV-SECRET' }, 'c');
    expect(out()).not.toContain('CAP-SECRET');
    expect(out()).not.toContain('CONV-SECRET');
  });

  it('censors identity and credential fields, and keeps id and count fields', () => {
    const { log, out } = capture();
    log.info({ jid: 'x', token: 'y', clientId: 1 }, 'a');
    const line = JSON.parse(out()) as Record<string, unknown>;
    expect(line).toMatchObject({ jid: '[REDACTED]', token: '[REDACTED]', clientId: 1 });
  });

  it.each(['name', 'pushName', 'number', 'phone', 'jid', 'recipient', 'token', 'refreshToken', 'refresh_token', 'accessToken', 'access_token', 'apiKey', 'secret', 'password'])(
    'censors %s at the top level and one level deep',
    (key) => {
      const { log, out } = capture();
      log.info({ [key]: 'TOP-VALUE', nested: { [key]: 'NESTED-VALUE' }, batchId: 7, count: 2 }, 'k');
      expect(out()).not.toContain('TOP-VALUE');
      expect(out()).not.toContain('NESTED-VALUE');
      expect(out()).toContain('"batchId":7');
      expect(out()).toContain('"count":2');
    },
  );

  it('does not leak error message text', () => {
    const { log, out } = capture();
    log.error({ err: new Error('client said SECRET-IN-ERROR') }, 'x');
    expect(out()).toContain('"type":"Error"');
    expect(out()).not.toContain('SECRET-IN-ERROR');
  });

  it('keeps error text out of msg when no message string is given', () => {
    const a = capture();
    a.log.error({ err: new Error('SECRET-A') });
    const b = capture();
    b.log.error(new Error('SECRET-B'));
    for (const [o, secret] of [[a.out(), 'SECRET-A'], [b.out(), 'SECRET-B']] as const) {
      expect(o).not.toContain(secret);
      expect(o).toContain('"msg":"error"');
      expect(o).toContain('"type":"Error"');
    }
  });
});
