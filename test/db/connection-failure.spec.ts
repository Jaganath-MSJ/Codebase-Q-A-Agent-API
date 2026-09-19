import { describe, it, expect } from 'vitest';
import {
  classifyConnectionFailure,
  MisconfiguredTestDatabaseError,
} from './db-harness';

/**
 * QA round 3 — TC-ENV-007, the pin for DEF-031.
 *
 * The L3 layer skips when the test database is unreachable. That is deliberate
 * (TC-ENV-004): the suite must stay green on a machine with no Postgres.
 *
 * The defect is that the gate could not tell "no database" from "database is
 * right there and refusing my credentials". Both produced a skip, so 55
 * assertions — INV-1's 768-dimension pin among them — stopped running while
 * the suite still reported green, and nothing in the output said so.
 *
 * Tested as a pure classifier, without a database, for the same reason
 * `safety-guard.spec.ts` is: it must be provably correct on every machine,
 * including one where L3 itself legitimately skips.
 *
 * The asymmetry below is deliberate. An UNKNOWN error classifies as
 * `unreachable`, i.e. skip — defaulting to "fail" would risk breaking
 * TC-ENV-004 for some unusual network condition nobody anticipated. The
 * failures that mean "misconfigured" are enumerated instead, because that set
 * is small, well-known, and is what actually bites.
 */

/** Shapes the `pg` driver really produces, not inventions of our own. */
const errno = (code: string) => Object.assign(new Error(code), { code });
const sqlstate = (code: string, message: string) =>
  Object.assign(new Error(message), { code });

describe('classifyConnectionFailure', () => {
  describe('TC-ENV-007a — genuinely unreachable is a legitimate skip', () => {
    const unreachable: [string, unknown][] = [
      ['nothing listening', errno('ECONNREFUSED')],
      ['host does not resolve', errno('ENOTFOUND')],
      ['host unreachable', errno('EHOSTUNREACH')],
      ['network unreachable', errno('ENETUNREACH')],
      ['connection timed out', errno('ETIMEDOUT')],
      ['dns temporary failure', errno('EAI_AGAIN')],
      [
        'pg connection timeout',
        new Error('timeout exceeded when trying to connect'),
      ],
    ];

    it.each(unreachable)('%s', (_label, err) => {
      expect(classifyConnectionFailure(err)).toBe('unreachable');
    });

    it('an unrecognised error skips rather than failing the run', () => {
      expect(classifyConnectionFailure(new Error('something novel'))).toBe(
        'unreachable',
      );
      expect(classifyConnectionFailure(undefined)).toBe('unreachable');
      expect(classifyConnectionFailure(null)).toBe('unreachable');
    });
  });

  describe('TC-ENV-007b — reachable but rejecting is a misconfiguration', () => {
    const rejected: [string, unknown][] = [
      [
        'invalid password (28P01)',
        sqlstate('28P01', 'password authentication failed for user "postgres"'),
      ],
      [
        'invalid authorization (28000)',
        sqlstate('28000', 'no pg_hba.conf entry for host'),
      ],
      [
        'no such database (3D000)',
        sqlstate('3D000', 'database "codebase_qa_agent_test" does not exist'),
      ],
      [
        'insufficient privilege (42501)',
        sqlstate('42501', 'permission denied for database'),
      ],
      // The one this defect was actually found on. It is raised client-side by
      // `pg` before any SQLSTATE exists, so it can only be recognised by text.
      [
        'SASL: password missing',
        new Error(
          'SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string',
        ),
      ],
      [
        'SASL: any other mechanism failure',
        new Error(
          'SASL: SCRAM-SERVER-FINAL-MESSAGE: server signature mismatch',
        ),
      ],
      [
        'client-side password type check',
        new Error('client password must be a string'),
      ],
    ];

    it.each(rejected)('%s', (_label, err) => {
      expect(classifyConnectionFailure(err)).toBe('rejected');
    });

    it('walks `cause`, since pg and drizzle both wrap', () => {
      const wrapped = new Error('Failed to connect', {
        cause: sqlstate('28P01', 'password authentication failed'),
      });
      expect(classifyConnectionFailure(wrapped)).toBe('rejected');
    });
  });

  describe('TC-ENV-007c — the error type exists and is distinct', () => {
    it('is an Error subclass, so it aborts the run like UnsafeTestDatabaseError', () => {
      const err = new MisconfiguredTestDatabaseError('nope');
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe('nope');
    });
  });
});
