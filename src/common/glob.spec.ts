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
