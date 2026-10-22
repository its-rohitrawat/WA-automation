import { pino, type DestinationStream, type Logger } from 'pino';

const CONTENT_NAMES = ['text', 'body', 'content', 'message', 'messages', 'prompt', 'quote', 'caption', 'conversation', 'payload', 'raw', 'transcript', 'response'];
/** Field names that could carry a person's identity, a credential, or the address and key of a WhatsApp file. */
const IDENTITY_AND_SECRET_NAMES = [
  'name', 'pushName', 'number', 'phone', 'jid',
  'token', 'refreshToken', 'refresh_token', 'accessToken', 'access_token', 'apiKey', 'secret', 'password',
  'mediaKey', 'directPath', 'url', 'ref', 'fileName',
];

/**
 * Field names that could carry chat content, identities or credentials. Always censored, even if a caller logs them by mistake.
 * Honest limit: top level and one level deep; call sites must log only ids, counts and error codes, never message objects.
 */
const SENSITIVE_NAMES = [...CONTENT_NAMES, ...IDENTITY_AND_SECRET_NAMES];
const REDACT = [...SENSITIVE_NAMES, ...SENSITIVE_NAMES.map((n) => `*.${n}`)];

export type { Logger };

/** Error serializer: type, code and stack frames only. Never the message, which can echo chat or prompt text. */
function serializeErr(err: unknown): Record<string, unknown> {
  const e = (err ?? {}) as { name?: string; code?: unknown; stack?: unknown };
  const out: Record<string, unknown> = { type: e.name ?? 'Error' };
  if (e.code !== undefined) out.code = e.code;
  if (typeof e.stack === 'string') {
    // Keep only real frame lines: drops the first line and any further lines of a multi-line message.
    out.stack = e.stack
      .split('\n')
      .slice(1)
      .filter((l) => /^\s+at /.test(l))
      .join('\n');
  }
  return out;
}

export function createLogger(level: string, destination?: DestinationStream): Logger {
  const opts = { level, base: undefined, redact: { paths: REDACT, censor: '[REDACTED]' }, serializers: { err: serializeErr },
    hooks: {
      // pino copies err.message into "msg" when no message string is given; force a fixed one instead.
      logMethod(this: Logger, args: unknown[], method: (...a: unknown[]) => void) {
        const first = args[0];
        const isErr = first instanceof Error || (typeof first === 'object' && first !== null && 'err' in first);
        if (isErr && typeof args[1] !== 'string') return method.apply(this, [first, 'error']);
        return method.apply(this, args);
      },
    },
  };
  return destination ? pino(opts, destination) : pino(opts);
}

export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
