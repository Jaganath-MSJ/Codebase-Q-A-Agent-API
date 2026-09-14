import { Inject, Injectable } from '@nestjs/common';
import { sql, eq, and } from 'drizzle-orm';
import type { Db } from '../db/pool';
import { DB_TOKEN } from '../db/tokens';
import { chunks, files } from '../db/schema';
import type { ScoredChunk } from './vector.retriever';

const MAX_RESULTS = 100;

@Injectable()
export class ReferencesRetriever {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  /**
   * Exact lexeme match against `search_text` — no ranking, every occurrence
   * up to the cap. `to_tsvector`'s 'simple' config tokenizes only on
   * non-alphanumeric boundaries, so a literal identifier like `validateUser`
   * becomes one whole lexeme; this cannot confuse it with, say,
   * `revalidateUserToken` the way a plain substring search would.
   */
  async findReferences(
    projectId: string,
    symbol: string,
  ): Promise<ScoredChunk[]> {
    const tsQuery = sql`plainto_tsquery('simple', ${symbol})`;

    return this.db
      .select({
        chunkId: chunks.id,
        path: files.path,
        startLine: chunks.startLine,
        endLine: chunks.endLine,
        content: chunks.content,
        contentHash: chunks.contentHash,
        symbol: chunks.symbol,
        score: sql<number>`1`,
      })
      .from(chunks)
      .innerJoin(files, eq(files.id, chunks.fileId))
      .where(
        and(eq(chunks.projectId, projectId), sql`${chunks.tsv} @@ ${tsQuery}`),
      )
      .orderBy(files.path, chunks.startLine, chunks.id)
      .limit(MAX_RESULTS);
  }
}
