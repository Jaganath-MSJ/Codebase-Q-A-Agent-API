import { describe, it, expect } from 'vitest';
import {
  planLengthBucketedBatches,
  truncateForEmbedding,
  SUBBATCH_PADDED_BUDGET,
  EMBED_CHAR_CEILING,
} from './local.provider';

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

function assertPartition(lengths: number[], batches: number[][]): void {
  const flat = batches.flat().sort((a, b) => a - b);
  expect(flat).toEqual(lengths.map((_, i) => i)); // every index exactly once
  for (const batch of batches) {
    const maxLen = Math.max(...batch.map((i) => Math.max(1, lengths[i]!)));
    // The memory invariant: padded cost never exceeds the flat-4-at-ceiling budget.
    expect(batch.length * maxLen * maxLen).toBeLessThanOrEqual(
      SUBBATCH_PADDED_BUDGET,
    );
  }
}

describe('planLengthBucketedBatches', () => {
  it('packs many short chunks into few batches', () => {
    const lengths = Array.from({ length: 100 }, () => 200); // all short
    const batches = planLengthBucketedBatches(lengths);
    assertPartition(lengths, batches);
    // 100 short chunks should NOT become ~25 batches of 4 — expect large batches.
    expect(batches.length).toBeLessThan(5);
  });

  it('isolates near-ceiling chunks (no worse than flat-4)', () => {
    const lengths = Array.from({ length: 12 }, () => EMBED_CHAR_CEILING); // all at ceiling
    const batches = planLengthBucketedBatches(lengths);
    assertPartition(lengths, batches);
    for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(4);
  });

  it('keeps the memory invariant on a mixed distribution', () => {
    const lengths = [
      50, 4500, 100, 4500, 300, 80, 2000, 4500, 120, 60, 900, 4500,
    ];
    assertPartition(lengths, planLengthBucketedBatches(lengths));
  });

  it('always places a lone chunk, even at the ceiling', () => {
    expect(planLengthBucketedBatches([EMBED_CHAR_CEILING])).toEqual([[0]]);
    expect(planLengthBucketedBatches([1])).toEqual([[0]]);
  });

  it('handles an empty list', () => {
    expect(planLengthBucketedBatches([])).toEqual([]);
  });
});
