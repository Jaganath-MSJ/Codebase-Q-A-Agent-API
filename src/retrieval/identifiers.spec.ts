import { describe, expect, it } from 'vitest';
import { buildSearchText, splitIdentifiers } from './identifiers';

describe('splitIdentifiers', () => {
  it('splits camelCase', () => {
    expect(splitIdentifiers('getUserByEmail')).toBe('get User By Email');
  });

  it('splits SCREAMING_SNAKE_CASE', () => {
    expect(splitIdentifiers('RATE_LIMIT_MS')).toBe('RATE LIMIT MS');
  });

  it('splits PascalCase with a leading acronym', () => {
    expect(splitIdentifiers('XMLHttpRequest')).toBe('XML Http Request');
  });

  it('splits snake_case', () => {
    expect(splitIdentifiers('snake_case_thing')).toBe('snake case thing');
  });

  it('handles a single-character input', () => {
    expect(splitIdentifiers('x')).toBe('x');
    expect(splitIdentifiers('X')).toBe('X');
  });

  it('is empty for empty input', () => {
    expect(splitIdentifiers('')).toBe('');
  });

  it('tokenizes across punctuation and whitespace in real code', () => {
    expect(splitIdentifiers('user.findUserByEmail(email)')).toBe('user find User By Email email');
  });
});

describe('buildSearchText', () => {
  it('appends the split form after the original content on a new line', () => {
    expect(buildSearchText('const RATE_LIMIT_MS = 1000;')).toBe(
      'const RATE_LIMIT_MS = 1000;\nconst RATE LIMIT MS 1000',
    );
  });
});
