import { describe, expect, it } from 'vitest';
import { average, recallAt, reciprocalRank } from './metrics';

const results = [
  { path: 'src/b.ts' },
  { path: 'src/c.ts' },
  { path: 'src/a.ts' },
  { path: 'src/d.ts' },
];

describe('recallAt', () => {
  it('counts distinct expected paths found within the top k', () => {
    expect(recallAt(results, ['src/a.ts', 'src/z.ts'], 3)).toBe(0.5);
    expect(recallAt(results, ['src/a.ts', 'src/z.ts'], 2)).toBe(0);
  });

  it('does not double count repeated chunks from the same file', () => {
    const repeated = [{ path: 'src/a.ts' }, { path: 'src/a.ts' }, { path: 'src/b.ts' }];
    expect(recallAt(repeated, ['src/a.ts', 'src/b.ts'], 3)).toBe(1);
  });

  it('treats a question with no expected files as trivially satisfied', () => {
    expect(recallAt(results, [], 5)).toBe(1);
  });
});

describe('reciprocalRank', () => {
  it('is 1 / rank of the first expected match', () => {
    expect(reciprocalRank(results, ['src/a.ts'])).toBeCloseTo(1 / 3);
    expect(reciprocalRank(results, ['src/c.ts', 'src/a.ts'])).toBeCloseTo(1 / 2);
  });

  it('is 0 when no expected file appears', () => {
    expect(reciprocalRank(results, ['src/z.ts'])).toBe(0);
  });
});

describe('average', () => {
  it('averages a list of numbers', () => {
    expect(average([1, 0.5, 0])).toBeCloseTo(0.5);
  });

  it('is 0 for an empty list', () => {
    expect(average([])).toBe(0);
  });
});
