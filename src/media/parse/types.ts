/**
 * One file to parse. The limits travel with the job so the worker needs no configuration. maxTextChars caps the text
 * returned, so a huge text layer is never posted to the service (no cap when absent).
 */
export type ParseJob =
  | { kind: 'docx'; bytes: Uint8Array; maxXmlBytes: number; maxEntries: number; maxTextChars?: number }
  | { kind: 'pdf'; bytes: Uint8Array; maxPages: number; maxTextChars?: number };

export interface ParseResult {
  text: string;
  /**
   * Total pages for a PDF (even when only the first pages were read), at least 1; null for DOCX. Advisory only: it
   * comes from the file's own /Count entry, which a sender can set too low. Never use it to cap spend on the file.
   */
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
