import { describe, it, expect } from 'vitest';
import { assertSafeTestDatabase, UnsafeTestDatabaseError } from './db-harness';

/**
 * QA pass — TC-ENV-006.
 *
 * The L3 suite truncates every table between tests. This guard is the only
 * thing standing between that and someone's real data, so it is tested
 * *without* a database — it must be provably correct on any machine, including
 * one where L3 itself skips.
 *
 * Its failure mode is silent and unrecoverable, which is exactly the class of
 * risk that deserves paranoid coverage.
 */

const PROD = 'postgres://user:pw@ep-cool-thing-pooler.neon.tech/neondb';
const SAFE = 'postgres://postgres@localhost:5432/codebase_qa_agent_test';

describe('assertSafeTestDatabase', () => {
  describe('TC-ENV-006a — accepts a genuine local test database', () => {
    const acceptable = [
      ['localhost', SAFE],
      [
        '127.0.0.1',
        'postgres://postgres@127.0.0.1:5432/codebase_qa_agent_test',
      ],
      [
        'IPv6 loopback',
        'postgres://postgres@[::1]:5432/codebase_qa_agent_test',
      ],
      ['with a password', 'postgres://postgres:secret@localhost:5432/app_test'],
      ['non-default port', 'postgres://postgres@localhost:5433/app_test'],
    ] as const;

    for (const [label, url] of acceptable) {
      it(`accepts ${label}`, () => {
        expect(() => assertSafeTestDatabase(url, PROD)).not.toThrow();
      });
    }
  });

  describe('TC-ENV-006b — refuses anything not provably disposable', () => {
    it('refuses a database name without the _test suffix', () => {
      expect(() =>
        assertSafeTestDatabase(
          'postgres://postgres@localhost:5432/codebase_qa_agent',
          PROD,
        ),
      ).toThrow(/does not end in "_test"/);
    });

    it('refuses a remote host even when the name ends in _test', () => {
      // The suffix alone is not enough — a colleague's staging box could
      // easily be called something_test.
      expect(() =>
        assertSafeTestDatabase(
          'postgres://user@ep-something.neon.tech/neondb_test',
          PROD,
        ),
      ).toThrow(/is not local/);
    });

    it('refuses the production URL itself', () => {
      expect(() => assertSafeTestDatabase(PROD, PROD)).toThrow(
        UnsafeTestDatabaseError,
      );
    });

    it('refuses a test URL identical to DATABASE_URL', () => {
      const same = 'postgres://postgres@localhost:5432/app_test';
      expect(() => assertSafeTestDatabase(same, same)).toThrow(
        /same host and database/,
      );
    });

    it('refuses a malformed URL', () => {
      expect(() => assertSafeTestDatabase('not-a-url', PROD)).toThrow(
        /not a valid connection URL/,
      );
    });

    it('refuses an empty database name', () => {
      expect(() =>
        assertSafeTestDatabase('postgres://postgres@localhost:5432/', PROD),
      ).toThrow(/does not end in "_test"/);
    });

    it('refuses a host that merely contains "localhost"', () => {
      // "localhost.evil.com" resolves wherever an attacker's DNS says.
      expect(() =>
        assertSafeTestDatabase(
          'postgres://postgres@localhost.evil.com:5432/app_test',
          PROD,
        ),
      ).toThrow(/is not local/);
    });

    it('refuses a name that merely contains "_test" without ending in it', () => {
      expect(() =>
        assertSafeTestDatabase(
          'postgres://postgres@localhost:5432/app_test_production',
          PROD,
        ),
      ).toThrow(/does not end in "_test"/);
    });
  });

  it('TC-ENV-006c still validates when DATABASE_URL is unset', () => {
    // A machine with no production URL configured must not get a free pass.
    expect(() =>
      assertSafeTestDatabase(
        'postgres://postgres@localhost:5432/notatest',
        undefined,
      ),
    ).toThrow(/does not end in "_test"/);
    expect(() => assertSafeTestDatabase(SAFE, undefined)).not.toThrow();
  });

  it('TC-ENV-006d tolerates a malformed DATABASE_URL without crashing', () => {
    // A broken production URL must not stop a valid test URL from being used.
    expect(() => assertSafeTestDatabase(SAFE, 'garbage')).not.toThrow();
  });
});
