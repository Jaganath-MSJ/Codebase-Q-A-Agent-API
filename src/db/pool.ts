import { Pool } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

export function createPool(connectionString: string): Pool {
  const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 10_000,
    // Neon closes idle connections aggressively; TCP keepalive makes a dropped
    // connection surface promptly (and less often mid-query) rather than as a
    // surprise ECONNRESET on the next use.
    keepAlive: true,
  });
  // node-postgres emits 'error' on a pooled client that fails *while idle* —
  // most commonly Neon resetting an idle connection (ECONNRESET) during a long
  // CPU-bound phase such as tree-sitter chunking, when no query is in flight to
  // reject. With no listener attached, pg rethrows it as an uncaught exception
  // and takes the whole process down. A dropped idle connection is not fatal:
  // the pool discards it and dials a fresh one on the next query, so log and
  // carry on.
  pool.on('error', (err) => {
    console.error(`[pg pool] idle client error (non-fatal): ${err.message}`);
  });
  return pool;
}

export type Db = NodePgDatabase<typeof schema>;

export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema });
}
