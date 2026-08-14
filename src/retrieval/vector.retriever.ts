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
