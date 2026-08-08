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
          score: sql<number>`1 - (${distance})`,
        })
        .from(chunks)
        .innerJoin(files, eq(files.id, chunks.fileId))
        .where(and(eq(chunks.projectId, projectId), isNotNull(chunks.embedding)))
        .orderBy(distance)
        .limit(limit);
    });
  }
}
