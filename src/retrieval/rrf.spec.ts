import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion } from './rrf';

describe('reciprocalRankFusion', () => {
  it('fuses two ranked lists into one hand-computed order', () => {
    // k=1 so every score is hand-checkable:
    // x: 1/(1+1) [A rank1] + 1/(1+1) [B rank1] = 1.0
    // y: 1/(1+2) [A rank2]                     = 0.333...
    // z: 1/(1+3) [A rank3] + 1/(1+2) [B rank2] = 0.25 + 0.333... = 0.583...
    const result = reciprocalRankFusion(
      [{ ids: ['x', 'y', 'z'] }, { ids: ['x', 'z'] }],
      1,
    );

    expect(result.map((r) => r.id)).toEqual(['x', 'z', 'y']);
    expect(result[0]).toEqual({ id: 'x', score: 1 });
    expect(result[1]!.score).toBeCloseTo(0.5833333, 6);
    expect(result[2]!.score).toBeCloseTo(0.3333333, 6);
  });

  it('down-weights a whole list by its weight factor', () => {
    // q: 1/(1+2) [A rank2, weight 1] + 0.5 * 1/(1+1) [B rank1, weight 0.5]
    //  = 0.333... + 0.25 = 0.583...
    const result = reciprocalRankFusion(
      [{ ids: ['p', 'q'] }, { ids: ['q'], weight: 0.5 }],
      1,
    );

    const q = result.find((r) => r.id === 'q')!;
    expect(q.score).toBeCloseTo(0.5833333, 6);
  });

  it('gives an id absent from a list zero contribution from it, not an error', () => {
    const result = reciprocalRankFusion([{ ids: ['a'] }, { ids: [] }], 60);
    expect(result).toEqual([{ id: 'a', score: 1 / 61 }]);
  });

  it('defaults k to 60', () => {
    const withDefault = reciprocalRankFusion([{ ids: ['a'] }]);
    const withExplicit60 = reciprocalRankFusion([{ ids: ['a'] }], 60);
    expect(withDefault).toEqual(withExplicit60);
  });
});
