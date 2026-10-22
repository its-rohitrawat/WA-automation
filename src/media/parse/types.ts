/** One file to parse. The limits travel with the job so the worker needs no configuration. */
export type ParseJob =
  | { kind: 'docx'; bytes: Uint8Array; maxXmlBytes: number; maxEntries: number }
  | { kind: 'pdf'; bytes: Uint8Array; maxPages: number };

export interface ParseResult {
  text: string;
  /** Total pages for a PDF (even when only the first pages were read); null for DOCX. */
  pageCount: number | null;
}

export type ParseReply = { ok: true; result: ParseResult } | { ok: false; code: string };

/** The file could not be read: damaged, wrong type, over a limit, or too slow. Not retried. */
export class ParseError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`File could not be read (${code})`);
    this.name = 'ParseError';
    this.code = code;
  }
}
