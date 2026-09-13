import { Inject, Injectable } from '@nestjs/common';
import { sql, eq, and, isNotNull, cosineDistance } from 'drizzle-orm';
import type { Db } from '../db/pool';
import { DB_TOKEN } from '../db/tokens';
import { chunks, files } from '../db/schema';

export interface ScoredChunk {
  chunkId: string;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
  symbol: string | null;
  score: number;
}

@Injectable()
export class VectorRetriever {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async search(projectId: string, queryVector: number[], limit = 20): Promise<ScoredChunk[]> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL hnsw.ef_search = 100`);
      // Recall-at-scale for the per-project filter (pgvector 0.8+). All projects
      // share one chunks table, and the HNSW index is NOT scoped by project_id
      // (see schema.ts) — so once the table is large enough that the planner
      // prefers the ANN index, a plain scan pulls ef_search candidates from the
      // whole graph and the `project_id` WHERE drops most, which can return
      // fewer than `limit` rows (or miss the true top-K) for a project that's a
      // small share of the corpus. Iterative scan keeps scanning until enough
      // rows pass the filter; strict_order preserves exact distance order for
      // the ORDER BY below. Harmless at current scale (the planner still
      // brute-forces), but closes the gap as the corpus grows.
      await tx.execute(sql`SET LOCAL hnsw.iterative_scan = strict_order`);

      const distance = cosineDistance(chunks.embedding, queryVector);

      return tx
        .select({
          chunkId: chunks.id,
          path: files.path,
          startLine: chunks.startLine,
          endLine: chunks.endLine,
          content: chunks.content,
          contentHash: chunks.contentHash,
          symbol: chunks.symbol,
          score: sql<number>`1 - (${distance})`,
        })
        .from(chunks)
        .innerJoin(files, eq(files.id, chunks.fileId))
        .where(and(eq(chunks.projectId, projectId), isNotNull(chunks.embedding)))
        // Secondary key: Postgres doesn't guarantee row order across equal
        // primary keys, and HybridRetriever now picks one canonical chunk
        // per file across arms — an unstable tie could flip which chunk
        // represents a file between otherwise-identical requests.
        .orderBy(distance, chunks.id)
        .limit(limit);
    });
  }
}
