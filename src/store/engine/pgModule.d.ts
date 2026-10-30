// The parts of node-postgres (pg 8.23.1, which ships no types) that src/store/engine/pg.ts uses. Written here rather than
// adding @types/pg: only the engine imports pg, and only these calls.
declare module 'pg' {
  export interface QueryResult {
    rows: Record<string, unknown>[];
    rowCount: number | null;
  }

  export interface PoolClient {
    query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
    /** An Error (or true) destroys the connection instead of returning it to the pool. */
    release(err?: Error | boolean): void;
  }

  export interface PoolConfig {
    connectionString?: string;
    max?: number;
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
    application_name?: string;
  }

  export class Pool {
    constructor(config?: PoolConfig);
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
    on(event: 'error', listener: (err: Error) => void): this;
  }

  export class Client {
    constructor(config?: { connectionString?: string; application_name?: string; connectionTimeoutMillis?: number });
    connect(): Promise<void>;
    query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
    end(): Promise<void>;
  }

  export const types: {
    setTypeParser(oid: number, parser: (value: string) => unknown): void;
    getTypeParser(oid: number): (value: string) => unknown;
  };

  const pg: { Pool: typeof Pool; Client: typeof Client; types: typeof types };
  export default pg;
}
