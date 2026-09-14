import { describe, expect, it } from 'vitest';
import { hashContentTree } from './content-tree-hash';

describe('hashContentTree', () => {
  const entries = [
    { path: 'src/index.ts', contentHash: 'hash-a' },
    { path: 'README.md', contentHash: 'hash-b' },
  ];

  it('is order-independent — re-extracting the same zip into a fresh directory reproduces it', () => {
    const shuffled = [entries[1]!, entries[0]!];
    expect(hashContentTree(shuffled)).toBe(hashContentTree(entries));
  });

  it('is deterministic across repeated calls', () => {
    expect(hashContentTree(entries)).toBe(hashContentTree(entries));
  });

  it("changes when a file's content changes", () => {
    const changed = [
      entries[0]!,
      { path: 'README.md', contentHash: 'hash-b-different' },
    ];
    expect(hashContentTree(changed)).not.toBe(hashContentTree(entries));
  });

  it('changes when a file is added or removed', () => {
    const withExtra = [
      ...entries,
      { path: 'extra.txt', contentHash: 'hash-c' },
    ];
    expect(hashContentTree(withExtra)).not.toBe(hashContentTree(entries));
  });

  it('distinguishes a rename from the original (path is part of the hash input)', () => {
    const renamed = [
      { path: 'src/renamed.ts', contentHash: 'hash-a' },
      entries[1]!,
    ];
    expect(hashContentTree(renamed)).not.toBe(hashContentTree(entries));
  });

  it('hashes the empty tree to a stable value', () => {
    expect(hashContentTree([])).toBe(hashContentTree([]));
  });
});
