import { Inject, Injectable } from '@nestjs/common';
import { sql, eq, and } from 'drizzle-orm';
import type { Db } from '../db/pool';
import { DB_TOKEN } from '../db/tokens';
import { chunks, files } from '../db/schema';
import type { ScoredChunk } from './vector.retriever';

@Injectable()
export class FtsRetriever {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async search(
    projectId: string,
    query: string,
    limit = 20,
  ): Promise<ScoredChunk[]> {
    // websearch_to_tsquery ANDs bare words together by default — fine for a
    // literal site search, but it means a single filler word absent from a
    // chunk (e.g. "where", "is") silently zeroes out every candidate. Joining
    // terms with the websearch "or" keyword turns this into a ranked OR
    // match instead, so a chunk containing just the one rare identifier the
    // question cares about can still surface — ts_rank_cd still rewards
    // chunks that match more of the terms.
    const orQuery = query.trim().split(/\s+/).filter(Boolean).join(' or ');
    const tsQuery = sql`websearch_to_tsquery('simple', ${orQuery})`;

    return (
      this.db
        .select({
          chunkId: chunks.id,
          path: files.path,
          startLine: chunks.startLine,
          endLine: chunks.endLine,
          content: chunks.content,
          contentHash: chunks.contentHash,
          symbol: chunks.symbol,
          score: sql<number>`ts_rank_cd(${chunks.tsv}, ${tsQuery})`,
        })
        .from(chunks)
        .innerJoin(files, eq(files.id, chunks.fileId))
        .where(
          and(
            eq(chunks.projectId, projectId),
            sql`${chunks.tsv} @@ ${tsQuery}`,
          ),
        )
        // Secondary key: see the same comment in vector.retriever.ts.
        .orderBy(sql`ts_rank_cd(${chunks.tsv}, ${tsQuery}) desc`, chunks.id)
        .limit(limit)
    );
  }
}
