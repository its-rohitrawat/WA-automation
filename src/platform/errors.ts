/** A refusal the platform routes turn into an HTTP answer. The message is plain and safe to show. */
export class PlatformError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 429 | 503;
  readonly code: string;
  constructor(status: 400 | 403 | 404 | 409 | 429 | 503, code: string, message: string) {
    super(message);
    this.name = 'PlatformError';
    this.status = status;
    this.code = code;
  }
}
