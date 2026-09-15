import { config as loadDotenv } from 'dotenv';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../src/db/pool';

/**
 * vitest does not load `.env` — the app does that at boot via its own config
 * module, which these tests bypass entirely. Without this, DATABASE_URL_TEST
 * is `undefined` inside the runner and the whole L3 layer skips silently even
 * when a perfectly good database is running.
 *
 * Loaded here rather than in a global setup file on purpose: it keeps the
 * blast radius to L3. Several L1 specs (`config.service.spec.ts`,
 * `env.schema.spec.ts`) assert behaviour for *absent* variables, and populating
 * the whole suite's environment could quietly change what they exercise.
 */
loadDotenv({ quiet: true });

/**
 * QA pass — the L3 database harness.
 *
 * Connects to a **real** Postgres so the things that only exist in SQL can be
 * asserted: the halfvec(768) column type, the HNSW index and its opclass, the
 * RRF fusion query, cascade deletes, and the job-lease concurrency guard.
 *
 * Two hard rules, both about not destroying the developer's data:
 *
 *  1. Tests TRUNCATE between cases, so the target must be provably a throwaway
 *     database. `assertSafeTestDatabase` refuses anything that is not local,
 *     not `_test`-suffixed, or that matches DATABASE_URL.
 *  2. If DATABASE_URL_TEST is unset OR unreachable, the whole layer **skips**
 *     rather than fails — the suite must stay green on a machine with no
 *     database (TC-ENV-004).
 */

export interface DbHarness {
  db: Db;
  pool: Pool;
  truncateAll: () => Promise<void>;
  close: () => Promise<void>;
  /** Runs raw SQL and returns typed rows. */
  rows: <T = Record<string, unknown>>(query: SQL) => Promise<T[]>;
  /** Runs raw SQL and returns the first row, or undefined. */
  row: <T = Record<string, unknown>>(query: SQL) => Promise<T | undefined>;
}

/**
 * Tables are discovered from the database rather than hardcoded.
 *
 * A hardcoded list was the first thing that broke here — it named
 * `credentials` when the real table is `source_credentials` — and the failure
 * mode of a *stale* list is worse than a wrong one: a table added later would
 * silently escape truncation and leak rows between tests, which surfaces as a
 * baffling order-dependent failure somewhere else entirely.
 *
 * Drizzle's own migration bookkeeping lives in the `drizzle` schema, so
 * restricting to `public` leaves it untouched.
 */
async function discoverTables(db: Db): Promise<string[]> {
  const result = (await db.execute(sql`
    select tablename from pg_tables where schemaname = 'public'
  `)) as unknown as { rows: { tablename: string }[] };
  return result.rows.map((r) => r.tablename);
}

export class UnsafeTestDatabaseError extends Error {}

/**
 * Digs the Postgres SQLSTATE out of a rejected drizzle query.
 *
 * drizzle wraps driver errors in its own `Failed query: ...` Error, so the
 * pg code and detail live on `cause` (sometimes nested). Matching on the
 * wrapper's message text would assert nothing about *why* the query failed —
 * every failure looks identical from the outside.
 *
 * Mirrors the same cause-walk `JobsService.isUniqueViolation` does in
 * production, so the tests recognise a constraint the same way the app does.
 */
export function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const candidate = err as { code?: string; cause?: unknown };
  if (typeof candidate.code === 'string') return candidate.code;
  return pgErrorCode(candidate.cause);
}

/** Common SQLSTATEs, named so assertions read as intent rather than as digits. */
export const PG = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
  /** pgvector raises this for a dimension mismatch. */
  DATA_EXCEPTION: '22000',
} as const;

/** Asserts a promise rejects with a specific Postgres SQLSTATE. */
export async function expectPgError(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const actual = pgErrorCode(err);
    if (actual === code) return;
    throw new Error(
      `Expected Postgres error ${code} but got ${actual ?? 'none'}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  throw new Error(`Expected Postgres error ${code} but the query succeeded`);
}

/**
 * Refuses to hand back a connection unless the target is unmistakably a
 * disposable local test database.
 *
 * This is deliberately paranoid. The failure it prevents — a TRUNCATE loop
 * pointed at the developer's real project data, or at the Neon production
 * branch — is unrecoverable, and the only thing standing between the two is
 * one environment variable.
 */
export function assertSafeTestDatabase(
  testUrl: string,
  productionUrl: string | undefined,
): void {
  let parsed: URL;
  try {
    parsed = new URL(testUrl);
  } catch {
    throw new UnsafeTestDatabaseError(
      'DATABASE_URL_TEST is not a valid connection URL',
    );
  }

  const database = parsed.pathname.replace(/^\//, '');

  if (!database.endsWith('_test')) {
    throw new UnsafeTestDatabaseError(
      `Refusing to run: database "${database}" does not end in "_test". ` +
        'L3 truncates every table between tests.',
    );
  }

  const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (!localHosts.has(parsed.hostname)) {
    throw new UnsafeTestDatabaseError(
      `Refusing to run: host "${parsed.hostname}" is not local. ` +
        'L3 truncates every table between tests.',
    );
  }

  if (productionUrl) {
    let prod: URL | null = null;
    try {
      prod = new URL(productionUrl);
    } catch {
      prod = null;
    }
    if (prod) {
      const prodDatabase = prod.pathname.replace(/^\//, '');
      if (prod.hostname === parsed.hostname && prodDatabase === database) {
        throw new UnsafeTestDatabaseError(
          'Refusing to run: DATABASE_URL_TEST points at the same host and ' +
            'database as DATABASE_URL.',
        );
      }
    }
  }
}

let cachedReachable: boolean | null = null;
let cachedReason = '';

/**
 * True when a real test database is configured AND reachable. Cached, so the
 * probe runs once per process rather than once per spec file.
 */
export async function testDatabaseAvailable(): Promise<boolean> {
  if (cachedReachable !== null) return cachedReachable;

  const url = process.env.DATABASE_URL_TEST;
  if (!url) {
    cachedReason = 'DATABASE_URL_TEST is not set';
    cachedReachable = false;
    return false;
  }

  // Deliberately NOT wrapped in try/catch: a misconfigured target must abort
  // the run loudly. Silently skipping is safe for "no database configured",
  // but "configured, and pointing somewhere dangerous" is the one case where
  // staying quiet would be the wrong behaviour.
  assertSafeTestDatabase(url, process.env.DATABASE_URL);

  const pool = new Pool({
    connectionString: url,
    connectionTimeoutMillis: 3000,
  });
  try {
    await pool.query('select 1');
    cachedReachable = true;
  } catch (err) {
    cachedReason = err instanceof Error ? err.message : String(err);
    cachedReachable = false;
  } finally {
    await pool.end().catch(() => undefined);
  }
  return cachedReachable;
}

export function skipReason(): string {
  return cachedReason || 'test database unavailable';
}

/**
 * Every `.int-spec.ts` file shares the one test database, and vitest runs spec
 * files in parallel by default — so without coordination, file A's
 * `truncateAll()` deletes the rows file B just seeded. The symptom is ugly:
 * each file passes alone and they fail together, which reads like flakiness
 * rather than a design problem.
 *
 * A session-level advisory lock serialises them at the database, which is more
 * robust than turning off vitest's file parallelism: it holds no matter how the
 * suite is invoked, and it slows only L3 rather than the whole run.
 */
const L3_ADVISORY_LOCK = 8_150_315;

/** Opens a pool against the test database. Callers must `close()`. */
export async function createDbHarness(): Promise<DbHarness> {
  const url = process.env.DATABASE_URL_TEST!;
  assertSafeTestDatabase(url, process.env.DATABASE_URL);

  const pool = new Pool({ connectionString: url, max: 5 });
  const db = drizzle(pool) as unknown as Db;

  // Held on its own connection for the file's whole lifetime; released in
  // close(). A second file blocks here until the first finishes.
  const lockClient = await pool.connect();
  await lockClient.query('SELECT pg_advisory_lock($1)', [L3_ADVISORY_LOCK]);

  let tableCache: string[] | null = null;
  const truncateAll = async () => {
    tableCache ??= await discoverTables(db);
    if (tableCache.length === 0) return; // migrations have not run yet
    await db.execute(
      sql.raw(
        `TRUNCATE TABLE ${tableCache.join(', ')} RESTART IDENTITY CASCADE`,
      ),
    );
  };

  /**
   * drizzle's node-postgres `execute()` resolves to a pg `QueryResult`, not a
   * bare array — destructuring it directly yields "is not iterable". These two
   * helpers keep every call site honest about that.
   */
  const rows = async <T = Record<string, unknown>>(
    query: SQL,
  ): Promise<T[]> => {
    const result = (await db.execute(query)) as unknown as { rows: T[] };
    return result.rows;
  };

  return {
    db,
    pool,
    truncateAll,
    rows,
    row: async <T = Record<string, unknown>>(query: SQL) =>
      (await rows<T>(query))[0],
    close: async () => {
      await lockClient
        .query('SELECT pg_advisory_unlock($1)', [L3_ADVISORY_LOCK])
        .catch(() => undefined);
      lockClient.release();
      await pool.end();
    },
  };
}
