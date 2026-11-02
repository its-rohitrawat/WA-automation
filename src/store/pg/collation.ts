// The Postgres database's text order (S2.7, the Postgres conversion): byte order, as SQLite's BINARY compares text.
// A database made with a locale collation (en_US.utf8, the server's usual default) orders text and compares ranges
// differently, so prefix ranges and every ORDER BY on text would not match SQLite. db-bootstrap makes the database with
// LC_COLLATE and LC_CTYPE 'C' (TEMPLATE template0, which takes any locale); openStore and db-migrate refuse any other.

/** The current database's collation and character type. Every role can read pg_database. */
export const COLLATION_SQL = 'SELECT datcollate AS "collate", datctype AS "ctype" FROM pg_database WHERE datname = current_database()';

/** The words openStore, db-migrate and db-bootstrap refuse a database with. */
export const COLLATION_REFUSED = 'This database must be created by db-bootstrap (byte-order collation C). Nothing was changed.';

/** True for byte order: C, or its alias POSIX, for both the collation and the character type. */
export function isByteOrder(row: { collate?: unknown; ctype?: unknown } | undefined): boolean {
  const c = (v: unknown) => v === 'C' || v === 'POSIX';
  return row !== undefined && c(row.collate) && c(row.ctype);
}
