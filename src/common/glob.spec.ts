import { describe, expect, it } from 'vitest';
import { matchesGlob } from './glob';

describe('matchesGlob', () => {
  it('matches an exact literal path', () => {
    expect(matchesGlob('src/index.ts', 'src/index.ts')).toBe(true);
    expect(matchesGlob('src/index.ts', 'src/other.ts')).toBe(false);
  });

  it('matches * within a single segment but not across slashes', () => {
    expect(matchesGlob('src/auth.service.ts', 'src/*.ts')).toBe(true);
    expect(matchesGlob('src/nested/file.ts', 'src/*.ts')).toBe(false);
  });

  it('matches ** across any number of segments, including zero', () => {
    expect(matchesGlob('src/nested/deep/file.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesGlob('src/file.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesGlob('file.ts', '**/*.ts')).toBe(true);
  });

  it('matches ? as exactly one character', () => {
    expect(matchesGlob('a.ts', '?.ts')).toBe(true);
    expect(matchesGlob('ab.ts', '?.ts')).toBe(false);
  });

  it('escapes regex-special characters in literal segments', () => {
    expect(matchesGlob('src/a.b.ts', 'src/a.b.ts')).toBe(true);
    expect(matchesGlob('src/aXb.ts', 'src/a.b.ts')).toBe(false);
  });

  it('does not match a suffix-only pattern against an unrelated path', () => {
    expect(
      matchesGlob('src/auth.controller.ts', 'src/**/*.controller.ts'),
    ).toBe(true);
    expect(matchesGlob('src/auth.service.ts', 'src/**/*.controller.ts')).toBe(
      false,
    );
  });

  it('handles ** matching everything and **/x at the root', () => {
    expect(matchesGlob('a/b/c', '**')).toBe(true);
    expect(matchesGlob('x', '**/x')).toBe(true);
    expect(matchesGlob('a/b/x', '**/x')).toBe(true);
  });

  it('matches a star against an empty run and the empty pattern against the empty path', () => {
    expect(matchesGlob('', '')).toBe(true);
    expect(matchesGlob('a', '')).toBe(false);
    expect(matchesGlob('', '*')).toBe(true);
    expect(matchesGlob('', '**')).toBe(true);
  });

  it('backtracks correctly across differing star kinds', () => {
    // A greedy last-star-only matcher gets this wrong; the DP must not.
    expect(matchesGlob('a/bx', '**/*x')).toBe(true);
    // `*` cannot cross a slash, so one literal slash in the pattern != two in the path.
    expect(matchesGlob('a/b/c.ts', '*/*.ts')).toBe(false);
  });

  it('does not backtrack catastrophically on a pathological, non-matching pattern', () => {
    // A regex built by concatenating one `[^/]*` per `*` would hang here for
    // minutes; the linear matcher must return quickly. `!` never appears in the
    // input, so the match is false.
    const path = 'a'.repeat(64);
    const pattern = '*a'.repeat(40) + '!';
    const start = performance.now();
    expect(matchesGlob(path, pattern)).toBe(false);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

/**
 * QA pass — TC-GLOB-*. The pattern reaching `matchesGlob` is chosen by the LLM
 * via `list_files`, so these cover the shapes a model produces and the ones an
 * attacker-influenced model might.
 */
describe('matchesGlob — QA edge cases', () => {
  describe('TC-GLOB-100..105 — literal metacharacters in the path', () => {
    it('TC-GLOB-100 matches a filename that itself contains a star', () => {
      // The path is data, never a pattern: a literal `*` in a filename must be
      // matched by `*` (as an ordinary character) and by an escaped-looking
      // literal position, but must not be re-interpreted as a wildcard.
      expect(matchesGlob('src/a*b.ts', 'src/a*b.ts')).toBe(true);
      expect(matchesGlob('src/aXb.ts', 'src/a*b.ts')).toBe(true);
    });

    it('TC-GLOB-101 matches a filename containing a question mark', () => {
      expect(matchesGlob('src/what?.ts', 'src/what?.ts')).toBe(true);
      expect(matchesGlob('src/whatX.ts', 'src/what?.ts')).toBe(true);
    });

    it('TC-GLOB-102 treats regex metacharacters as literals', () => {
      expect(matchesGlob('src/a+b(c).ts', 'src/a+b(c).ts')).toBe(true);
      expect(matchesGlob('src/a+b(c).ts', 'src/a+b(d).ts')).toBe(false);
      expect(matchesGlob('src/x.ts', 'src/[a-z].ts')).toBe(false);
    });

    it('TC-GLOB-103 treats a dollar sign and caret as literals', () => {
      expect(matchesGlob('src/$x^y.ts', 'src/$x^y.ts')).toBe(true);
    });

    it('TC-GLOB-104 matches unicode path segments', () => {
      expect(matchesGlob('src/wörld/✨.ts', 'src/**/*.ts')).toBe(true);
      expect(matchesGlob('src/wörld/✨.ts', 'src/wörld/✨.ts')).toBe(true);
    });

    it('TC-GLOB-105 is case sensitive', () => {
      expect(matchesGlob('src/Index.ts', 'src/index.ts')).toBe(false);
      expect(matchesGlob('src/index.TS', 'src/*.ts')).toBe(false);
    });
  });

  describe('TC-GLOB-120..126 — pattern structure', () => {
    it('TC-GLOB-120 handles a globstar in the middle of a pattern', () => {
      expect(matchesGlob('src/a/b/c/file.ts', 'src/**/file.ts')).toBe(true);
      expect(matchesGlob('src/file.ts', 'src/**/file.ts')).toBe(true);
    });

    it('TC-GLOB-121 handles multiple globstars', () => {
      expect(matchesGlob('a/b/c/d/e.ts', '**/c/**/*.ts')).toBe(true);
      expect(matchesGlob('a/b/x/d/e.ts', '**/c/**/*.ts')).toBe(false);
    });

    it('TC-GLOB-122 does not let a single star cross a separator', () => {
      expect(matchesGlob('src/a/b.ts', 'src/*')).toBe(false);
      expect(matchesGlob('src/a.ts', 'src/*')).toBe(true);
    });

    it('TC-GLOB-123 does not match a directory-shaped pattern against a file', () => {
      expect(matchesGlob('src/components', 'src/components/')).toBe(false);
      expect(matchesGlob('src/components/Button.tsx', 'src/components/')).toBe(
        false,
      );
    });

    it('TC-GLOB-124 returns false when the pattern is longer than the path', () => {
      expect(matchesGlob('a.ts', 'src/very/deep/a.ts')).toBe(false);
    });

    it('TC-GLOB-125 matches consecutive question marks exactly', () => {
      expect(matchesGlob('abc.ts', '???.ts')).toBe(true);
      expect(matchesGlob('ab.ts', '???.ts')).toBe(false);
      expect(matchesGlob('a/c.ts', '???.ts')).toBe(false);
    });

    it('TC-GLOB-126 never lets ? match a separator', () => {
      expect(matchesGlob('a/b', 'a?b')).toBe(false);
    });
  });

  describe('TC-GLOB-140..142 — scale and pathological input', () => {
    it('TC-GLOB-140 stays fast at the 256-character pattern cap', () => {
      // `list-files.tool.ts` rejects patterns above 256 chars, so this is the
      // worst pattern the matcher can legitimately be handed.
      const pattern = '*a'.repeat(128);
      const path = 'a'.repeat(512);
      const start = performance.now();
      matchesGlob(path, pattern);
      expect(performance.now() - start).toBeLessThan(1000);
    });

    it('TC-GLOB-141 stays fast on a globstar-heavy non-matching pattern', () => {
      const pattern = '**/'.repeat(80) + 'nope.ts';
      const path = Array.from({ length: 40 }, (_, i) => `d${i}`).join('/');
      const start = performance.now();
      expect(matchesGlob(path, pattern)).toBe(false);
      expect(performance.now() - start).toBeLessThan(1000);
    });

    it('TC-GLOB-142 handles a long path against a trivial pattern', () => {
      const path = 'a/'.repeat(500) + 'file.ts';
      expect(matchesGlob(path, '**/*.ts')).toBe(true);
    });
  });
});
