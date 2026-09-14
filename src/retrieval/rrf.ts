export interface RankedList {
  /** ids in rank order — index 0 is rank 1 */
  ids: string[];
  /** down-weights a whole list's contribution (e.g. trigram at 0.5) */
  weight?: number;
}

interface FusedResult {
  id: string;
  score: number;
}

const DEFAULT_K = 60;

/**
 * Combines ranked id lists by rank position alone — never by score — so
 * arms with incomparable score distributions (cosine similarity vs
 * ts_rank_cd vs trigram similarity) can be fused with zero calibration.
 * An id absent from a list contributes 0 from that list, matching a
 * FULL OUTER JOIN across the arms.
 */
export function reciprocalRankFusion(
  lists: RankedList[],
  k = DEFAULT_K,
): FusedResult[] {
  const scores = new Map<string, number>();

  for (const { ids, weight = 1 } of lists) {
    ids.forEach((id, index) => {
      const rank = index + 1;
      const contribution = weight / (k + rank);
      scores.set(id, (scores.get(id) ?? 0) + contribution);
    });
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
