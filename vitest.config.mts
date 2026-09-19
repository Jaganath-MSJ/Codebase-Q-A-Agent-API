import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.spec.ts',
      'evals/**/*.spec.ts',
      // QA layers. `.e2e-spec.ts` boots the real Nest app with fake
      // providers (L2); `.int-spec.ts` talks to a real Postgres (L3) and skips
      // itself when DATABASE_URL_TEST is unset, so the suite stays green on a
      // machine with no database.
      // Architecture/invariant assertions that read source text rather than
      // exercising one module — they belong beside the suite, not inside src/.
      'test/**/*.spec.ts',
      'test/**/*.e2e-spec.ts',
      'test/**/*.int-spec.ts',
    ],
    environment: 'node',
    // The L3 suites apply migrations and truncate between tests; the default
    // 5s timeout is not enough for a cold connection plus a migration run.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
