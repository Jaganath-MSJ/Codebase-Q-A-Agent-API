import { describe, expect, it } from 'vitest';
import { truncateForEmbedding } from './local.provider';

describe('truncateForEmbedding', () => {
  it('leaves short text untouched', () => {
    const text = 'search_document: export function slugify() {}';
    expect(truncateForEmbedding(text)).toBe(text);
  });

  it('truncates text over the character cap', () => {
    const text = 'a'.repeat(10_000);
    const result = truncateForEmbedding(text);
    expect(result.length).toBeLessThan(text.length);
    expect(result).toBe('a'.repeat(result.length));
  });

  it('is a no-op exactly at the boundary', () => {
    const atCap = 'x'.repeat(4500);
    expect(truncateForEmbedding(atCap)).toBe(atCap);
    expect(truncateForEmbedding(atCap + 'y').length).toBe(4500);
  });
});
