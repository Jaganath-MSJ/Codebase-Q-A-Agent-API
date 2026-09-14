import { describe, expect, it } from 'vitest';
import {
  buildCanonicalIdByPath,
  toCanonicalRankedIds,
} from './hybrid.retriever';
import type { ScoredChunk } from './vector.retriever';

function chunk(chunkId: string, path: string): ScoredChunk {
  return {
    chunkId,
    path,
    startLine: 1,
    endLine: 1,
    content: '',
    contentHash: '',
    symbol: null,
    score: 0,
  };
}

describe('buildCanonicalIdByPath', () => {
  it('picks the first-seen chunk id for a path, scanning lists in order', () => {
    const vector = [chunk('v1', 'a.ts'), chunk('v2', 'b.ts')];
    const fts = [chunk('f1', 'b.ts'), chunk('f2', 'a.ts')];

    const canonical = buildCanonicalIdByPath(vector, fts);

    expect(canonical.get('a.ts')).toBe('v1');
    expect(canonical.get('b.ts')).toBe('v2');
  });
});

describe('toCanonicalRankedIds', () => {
  it('collapses multiple chunks of the same file to one entry at its best rank', () => {
    // Same shape as the real bug: a file split into 3 chunks each land in
    // one arm's top ranks — without this, that file would cast 3 rank
    // votes in RRF instead of 1, letting a heavily-chunked file win fusion
    // purely from chunk count rather than relevance.
    const results = [
      chunk('big-1', 'big.ts'),
      chunk('other', 'other.ts'),
      chunk('big-2', 'big.ts'),
    ];
    const canonical = new Map([
      ['big.ts', 'big-1'],
      ['other.ts', 'other'],
    ]);

    expect(toCanonicalRankedIds(results, canonical)).toEqual([
      'big-1',
      'other',
    ]);
  });

  it('is a no-op when every path is already distinct', () => {
    const results = [chunk('a', 'a.ts'), chunk('b', 'b.ts')];
    const canonical = new Map([
      ['a.ts', 'a'],
      ['b.ts', 'b'],
    ]);

    expect(toCanonicalRankedIds(results, canonical)).toEqual(['a', 'b']);
  });
});
