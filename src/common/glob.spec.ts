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
    expect(matchesGlob('src/auth.controller.ts', 'src/**/*.controller.ts')).toBe(true);
    expect(matchesGlob('src/auth.service.ts', 'src/**/*.controller.ts')).toBe(false);
  });
});
