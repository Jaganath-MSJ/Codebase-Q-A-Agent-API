export interface RetrievedItem {
  path: string;
}

function distinctPaths(items: RetrievedItem[]): Set<string> {
  return new Set(items.map((item) => item.path));
}

/** Fraction of `expectedFiles` present among the distinct paths of the top `k` results. */
export function recallAt(items: RetrievedItem[], expectedFiles: string[], k: number): number {
  if (expectedFiles.length === 0) return 1;
  const topPaths = distinctPaths(items.slice(0, k));
  const found = expectedFiles.filter((file) => topPaths.has(file)).length;
  return found / expectedFiles.length;
}

/** 1 / rank of the first result whose path is an expected file, 0 if none appear. */
export function reciprocalRank(items: RetrievedItem[], expectedFiles: string[]): number {
  const expected = new Set(expectedFiles);
  for (let i = 0; i < items.length; i++) {
    if (expected.has(items[i]!.path)) return 1 / (i + 1);
  }
  return 0;
}

export function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
