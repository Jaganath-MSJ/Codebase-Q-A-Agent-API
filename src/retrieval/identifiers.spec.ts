import { describe, expect, it } from 'vitest';
import {
  buildSearchText,
  extractIdentifierTokens,
  splitIdentifiers,
} from './identifiers';

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
    expect(splitIdentifiers('user.findUserByEmail(email)')).toBe(
      'user find User By Email email',
    );
  });
});

describe('buildSearchText', () => {
  it('appends the split form after the original content on a new line', () => {
    expect(buildSearchText('const RATE_LIMIT_MS = 1000;')).toBe(
      'const RATE_LIMIT_MS = 1000;\nconst RATE LIMIT MS 1000',
    );
  });
});

describe('extractIdentifierTokens', () => {
  it('catches a camelCase identifier', () => {
    expect(extractIdentifierTokens('Where is getUserByEmail defined?')).toEqual(
      ['getUserByEmail'],
    );
  });

  it('catches a SCREAMING_SNAKE_CASE constant', () => {
    expect(
      extractIdentifierTokens('Where is RATE_LIMIT_MS configured?'),
    ).toEqual(['RATE_LIMIT_MS']);
  });

  it('catches a method-call shape', () => {
    expect(extractIdentifierTokens('What calls service.method(?')).toEqual([
      'service.method(',
    ]);
  });

  it('is empty for a purely conceptual question', () => {
    expect(extractIdentifierTokens('how does error handling work')).toEqual([]);
  });

  it('deduplicates repeated tokens', () => {
    expect(
      extractIdentifierTokens('getUserByEmail calls getUserByEmail again'),
    ).toEqual(['getUserByEmail']);
  });
});
