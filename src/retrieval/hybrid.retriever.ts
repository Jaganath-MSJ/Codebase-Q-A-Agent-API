import { Injectable } from '@nestjs/common';
import { VectorRetriever, ScoredChunk } from './vector.retriever';
import { FtsRetriever } from './fts.retriever';
import { TrigramRetriever } from './trigram.retriever';
import { extractIdentifierTokens } from './identifiers';
import { reciprocalRankFusion } from './rrf';

const VECTOR_POOL = 50;
const FTS_POOL = 50;
const TRIGRAM_POOL = 25;
const TRIGRAM_WEIGHT = 0.5;
const RRF_K = 60;

/**
 * Assigns one canonical chunk id per file path, first-seen across all arms
 * (same tie-break as the metadata map below). A file split into several
 * overlapping chunks would otherwise let each arm pick a *different* chunk
 * of that file as "its" representative, so the file still shows up as
 * multiple distinct ids in fusion even after per-arm deduplication — this
 * keeps every arm voting for the exact same id for a given file.
 */
export function buildCanonicalIdByPath(...resultLists: ScoredChunk[][]): Map<string, string> {
  const canonicalIdByPath = new Map<string, string>();
  for (const results of resultLists) {
    for (const chunk of results) {
      if (!canonicalIdByPath.has(chunk.path)) canonicalIdByPath.set(chunk.path, chunk.chunkId);
    }
  }
  return canonicalIdByPath;
}

/**
 * Maps a ranked list to its files' canonical ids, keeping first occurrence.
 * Without this, a file whose several chunks all appear in one arm's list
 * would cast multiple votes for the same file in that arm alone — measured
 * directly: three chunks of one file occupied ranks 1, 3, and 4 of a fused
 * result, pushing the actually-correct single-chunk file down to rank 9.
 */
export function toCanonicalRankedIds(
  results: ScoredChunk[],
  canonicalIdByPath: Map<string, string>,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const chunk of results) {
    const canonicalId = canonicalIdByPath.get(chunk.path)!;
    if (seen.has(canonicalId)) continue;
    seen.add(canonicalId);
    ids.push(canonicalId);
  }
  return ids;
}

@Injectable()
export class HybridRetriever {
  constructor(
    private readonly vectorRetriever: VectorRetriever,
    private readonly ftsRetriever: FtsRetriever,
    private readonly trigramRetriever: TrigramRetriever,
  ) {}

  async search(
    projectId: string,
    query: string,
    queryVector: number[],
    limit = 20,
  ): Promise<ScoredChunk[]> {
    const identifierTokens = extractIdentifierTokens(query);

    const [vectorResults, ftsResults, trigramResults] = await Promise.all([
      this.vectorRetriever.search(projectId, queryVector, VECTOR_POOL),
      this.ftsRetriever.search(projectId, query, FTS_POOL),
      identifierTokens.length > 0
        ? this.trigramRetriever.search(projectId, identifierTokens.join(' '), TRIGRAM_POOL)
        : Promise.resolve([]),
    ]);

    const chunksById = new Map<string, ScoredChunk>();
    for (const chunk of [...vectorResults, ...ftsResults, ...trigramResults]) {
      if (!chunksById.has(chunk.chunkId)) chunksById.set(chunk.chunkId, chunk);
    }

    const canonicalIdByPath = buildCanonicalIdByPath(vectorResults, ftsResults, trigramResults);

    const fused = reciprocalRankFusion(
      [
        { ids: toCanonicalRankedIds(vectorResults, canonicalIdByPath) },
        { ids: toCanonicalRankedIds(ftsResults, canonicalIdByPath) },
        { ids: toCanonicalRankedIds(trigramResults, canonicalIdByPath), weight: TRIGRAM_WEIGHT },
      ],
      RRF_K,
    );

    return fused.slice(0, limit).map(({ id, score }) => ({ ...chunksById.get(id)!, score }));
  }
}
