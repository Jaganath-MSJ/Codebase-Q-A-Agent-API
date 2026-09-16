import { describe, it, expect } from 'vitest';
import { validateEnv } from './env.schema';

/**
 * QA pass — TC-CFG-*.
 *
 * Config errors are the quietest class of bug in this system: a mistyped
 * provider name or a silently-defaulted key does not crash, it just makes the
 * app behave as something other than what the operator asked for. This is the
 * one place Zod is used (`class-validator` owns the HTTP boundary), so the
 * schema is also an invariant worth pinning.
 */

const MINIMAL = { DATABASE_URL: 'postgres://localhost/db' };

describe('validateEnv', () => {
  describe('TC-CFG-001..003 — required values', () => {
    it('TC-CFG-001 accepts a minimal config', () => {
      expect(validateEnv(MINIMAL).DATABASE_URL).toBe('postgres://localhost/db');
    });

    it('TC-CFG-002 rejects a missing DATABASE_URL', () => {
      expect(() => validateEnv({})).toThrow(
        /Invalid environment configuration/,
      );
    });

    it('TC-CFG-003 rejects an empty DATABASE_URL', () => {
      // An empty string is the realistic failure — an unset variable in a .env
      // file reaches the process as "" rather than undefined.
      expect(() => validateEnv({ DATABASE_URL: '' })).toThrow(
        /DATABASE_URL is required/,
      );
    });
  });

  describe('TC-CFG-010..017 — defaults', () => {
    const defaults = () => validateEnv(MINIMAL);

    it('TC-CFG-010 defaults EMBEDDING_PROVIDER to local', () => {
      expect(defaults().EMBEDDING_PROVIDER).toBe('local');
    });

    it('TC-CFG-011 defaults CHAT_PROVIDER to gemini', () => {
      expect(defaults().CHAT_PROVIDER).toBe('gemini');
    });

    it('TC-CFG-012 defaults DATA_DIR to ./data', () => {
      expect(defaults().DATA_DIR).toBe('./data');
    });

    it('TC-CFG-013 defaults PORT to 3000 as a number', () => {
      expect(defaults().PORT).toBe(3000);
      expect(typeof defaults().PORT).toBe('number');
    });

    it('TC-CFG-014 defaults NODE_ENV to development', () => {
      expect(defaults().NODE_ENV).toBe('development');
    });

    it('TC-CFG-015 defaults LLM_CACHE to on', () => {
      expect(defaults().LLM_CACHE).toBe('on');
    });

    it('TC-CFG-016 defaults the API keys to empty strings, not undefined', () => {
      expect(defaults().GOOGLE_API_KEY).toBe('');
      expect(defaults().GROQ_API_KEY).toBe('');
    });

    it('TC-CFG-017 defaults CREDENTIAL_KEY to an empty string', () => {
      // Length-checking lives in credentials/crypto.util.ts, so an absent key
      // is accepted here and only fails when credentials are actually used.
      expect(defaults().CREDENTIAL_KEY).toBe('');
    });
  });

  describe('TC-CFG-020..027 — enum validation', () => {
    it('TC-CFG-020 accepts both EMBEDDING_PROVIDER values', () => {
      for (const EMBEDDING_PROVIDER of ['local', 'gemini']) {
        expect(
          validateEnv({ ...MINIMAL, EMBEDDING_PROVIDER }).EMBEDDING_PROVIDER,
        ).toBe(EMBEDDING_PROVIDER);
      }
    });

    it('TC-CFG-021 rejects an unknown EMBEDDING_PROVIDER', () => {
      expect(() =>
        validateEnv({ ...MINIMAL, EMBEDDING_PROVIDER: 'openai' }),
      ).toThrow(/Invalid environment configuration/);
    });

    it('TC-CFG-022 accepts both CHAT_PROVIDER values', () => {
      for (const CHAT_PROVIDER of ['gemini', 'groq']) {
        expect(validateEnv({ ...MINIMAL, CHAT_PROVIDER }).CHAT_PROVIDER).toBe(
          CHAT_PROVIDER,
        );
      }
    });

    it('TC-CFG-023 rejects an unknown CHAT_PROVIDER', () => {
      expect(() =>
        validateEnv({ ...MINIMAL, CHAT_PROVIDER: 'anthropic' }),
      ).toThrow(/Invalid environment configuration/);
    });

    it('TC-CFG-024 is case sensitive about enum values', () => {
      // "Local" in a .env is a plausible typo and must fail loudly rather than
      // silently falling back to the default.
      expect(() =>
        validateEnv({ ...MINIMAL, EMBEDDING_PROVIDER: 'Local' }),
      ).toThrow();
      expect(() => validateEnv({ ...MINIMAL, LLM_CACHE: 'ON' })).toThrow();
    });

    it('TC-CFG-025 accepts both LLM_CACHE values', () => {
      expect(validateEnv({ ...MINIMAL, LLM_CACHE: 'off' }).LLM_CACHE).toBe(
        'off',
      );
      expect(validateEnv({ ...MINIMAL, LLM_CACHE: 'on' }).LLM_CACHE).toBe('on');
    });

    it('TC-CFG-026 rejects an arbitrary LLM_CACHE value', () => {
      expect(() => validateEnv({ ...MINIMAL, LLM_CACHE: 'true' })).toThrow();
    });

    it('TC-CFG-027 rejects an empty-string enum rather than defaulting', () => {
      // `.default()` only applies to `undefined`, so a present-but-empty
      // variable is a validation error — the loud behaviour we want.
      expect(() => validateEnv({ ...MINIMAL, CHAT_PROVIDER: '' })).toThrow();
    });
  });

  describe('TC-CFG-030..034 — PORT coercion', () => {
    it('TC-CFG-030 coerces a numeric string', () => {
      expect(validateEnv({ ...MINIMAL, PORT: '8080' }).PORT).toBe(8080);
    });

    it('TC-CFG-031 accepts a real number', () => {
      expect(validateEnv({ ...MINIMAL, PORT: 8080 }).PORT).toBe(8080);
    });

    it('TC-CFG-032 rejects a non-numeric PORT', () => {
      expect(() => validateEnv({ ...MINIMAL, PORT: 'abc' })).toThrow();
    });

    it('TC-CFG-033 [DEFECT-006 fixed] rejects an out-of-range port at boot', () => {
      // Previously these all passed validation and failed later inside
      // listen(), where the error no longer names PORT. `0` is rejected on
      // purpose: Node accepts it and binds a random free port, so it is the one
      // bad value that starts successfully and then cannot be found.
      expect(() => validateEnv({ ...MINIMAL, PORT: '0' })).toThrow(/PORT/);
      expect(() => validateEnv({ ...MINIMAL, PORT: '-1' })).toThrow(/PORT/);
      expect(() => validateEnv({ ...MINIMAL, PORT: '99999' })).toThrow(/PORT/);
    });

    it('TC-CFG-034 [DEFECT-006 fixed] rejects a fractional port', () => {
      expect(() => validateEnv({ ...MINIMAL, PORT: '3000.7' })).toThrow(/PORT/);
    });

    it('TC-CFG-035 [DEFECT-006 fixed] accepts both ends of the valid range', () => {
      // The boundary matters as much as the rejection: an off-by-one here would
      // lock out port 65535, and 1 is what a privileged-port test would use.
      expect(validateEnv({ ...MINIMAL, PORT: '1' }).PORT).toBe(1);
      expect(validateEnv({ ...MINIMAL, PORT: '65535' }).PORT).toBe(65535);
    });
  });

  describe('TC-CFG-040..042 — extra and unknown keys', () => {
    it('TC-CFG-040 ignores unknown environment variables', () => {
      // process.env carries hundreds of unrelated variables; the schema must
      // not be strict here or the app would refuse to boot on any machine.
      const env = validateEnv({
        ...MINIMAL,
        SOME_UNRELATED_VAR: 'x',
        PATH: '/usr/bin',
      });
      expect(env.DATABASE_URL).toBe(MINIMAL.DATABASE_URL);
      expect('SOME_UNRELATED_VAR' in env).toBe(false);
    });

    it('TC-CFG-041 returns only the declared keys', () => {
      expect(Object.keys(validateEnv(MINIMAL)).sort()).toEqual([
        'CHAT_PROVIDER',
        'CREDENTIAL_KEY',
        'DATABASE_URL',
        'DATA_DIR',
        'EMBEDDING_PROVIDER',
        'GOOGLE_API_KEY',
        'GROQ_API_KEY',
        'LLM_CACHE',
        'NODE_ENV',
        'PORT',
      ]);
    });

    it('TC-CFG-042 names the offending variable in the error message', () => {
      // The operator has to be able to tell WHICH variable is wrong.
      try {
        validateEnv({ ...MINIMAL, CHAT_PROVIDER: 'nope' });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as Error).message).toContain('CHAT_PROVIDER');
      }
    });
  });

  it('TC-CFG-050 does not echo secret values in the error message (SEC)', () => {
    // A config error is logged on boot. It must not print the key it rejected.
    try {
      validateEnv({ GOOGLE_API_KEY: 'AIzaSy-SUPER-SECRET-VALUE' });
      expect.unreachable('should have thrown — DATABASE_URL is missing');
    } catch (err) {
      expect((err as Error).message).not.toContain('SUPER-SECRET-VALUE');
    }
  });
});
