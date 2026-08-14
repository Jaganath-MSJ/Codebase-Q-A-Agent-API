import { Inject, Injectable } from '@nestjs/common';
import { sql, eq, and } from 'drizzle-orm';
import type { Db } from '../db/pool';
import { DB_TOKEN } from '../db/tokens';
import { chunks, files } from '../db/schema';
import type { ScoredChunk } from './vector.retriever';

@Injectable()
export class TrigramRetriever {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  /**
   * `probe` is typically the identifier-shaped tokens pulled from the
   * question, not the raw question.
   *
   * Uses `word_similarity`/`<%`, not `similarity`/`%`. `similarity()` scores
   * the trigram overlap of the *whole* two strings — against a chunk's full,
   * multi-line `search_text` that ratio is dominated by the chunk's size, so
   * even an exact identifier match scores near zero (measured: 0.06 for a
   * dead-on match against a 1.6KB chunk, well under the 0.3 default `%`
   * threshold). `word_similarity(probe, text)` instead finds the
   * best-matching substring of `text`, which is what "does this chunk
   * contain something like this identifier" actually means.
   */
  async search(projectId: string, probe: string, limit = 25): Promise<ScoredChunk[]> {
    return this.db
      .select({
        chunkId: chunks.id,
        path: files.path,
        startLine: chunks.startLine,
        endLine: chunks.endLine,
        content: chunks.content,
        contentHash: chunks.contentHash,
        symbol: chunks.symbol,
        score: sql<number>`word_similarity(${probe}, ${chunks.searchText})`,
      })
      .from(chunks)
      .innerJoin(files, eq(files.id, chunks.fileId))
      .where(and(eq(chunks.projectId, projectId), sql`${probe} <% ${chunks.searchText}`))
      // Secondary key: see the same comment in vector.retriever.ts.
      .orderBy(sql`word_similarity(${probe}, ${chunks.searchText}) desc`, chunks.id)
      .limit(limit);
  }
}
