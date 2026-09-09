import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../pool';
import { DB_TOKEN } from '../tokens';
import { chunks, files, ChunkRow, NewChunkRow } from '../schema';

export interface PendingEmbeddingChunk {
  id: string;
  content: string;
  symbol: string | null;
  path: string;
  startLine: number;
  endLine: number;
}

export interface FirstChunkOfFile {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface ChunkOfFile {
  startLine: number;
  endLine: number;
  content: string;
  symbol: string | null;
}

@Injectable()
export class ChunksRepository {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async insertMany(rows: NewChunkRow[]): Promise<ChunkRow[]> {
    if (rows.length === 0) return [];
    return this.db.insert(chunks).values(rows).returning();
  }

  async findWithoutEmbedding(projectId: string): Promise<PendingEmbeddingChunk[]> {
    return this.db
      .select({
        id: chunks.id,
        content: chunks.content,
        symbol: chunks.symbol,
        path: files.path,
        startLine: chunks.startLine,
        endLine: chunks.endLine,
      })
      .from(chunks)
      .innerJoin(files, eq(chunks.fileId, files.id))
      .where(and(eq(chunks.projectId, projectId), isNull(chunks.embedding)));
  }

  /**
   * One `UPDATE` for a whole batch instead of N single-row updates (Phase 12.5).
   * Exactly two bound params regardless of row count — an id[] and a text[] of
   * `'[...]'` vector literals — joined via `unnest`, so a large batch never
   * approaches Postgres's 65535-param limit. Each vector must be exactly 768
   * floats (the permanent embedding dimension); the text is cast to halfvec
   * server-side, matching the column type.
   */
  async setEmbeddingsBulk(pairs: { id: string; embedding: number[] }[]): Promise<void> {
    if (pairs.length === 0) return;
    const ids: string[] = [];
    const vectors: string[] = [];
    for (const { id, embedding } of pairs) {
      if (embedding.length !== 768) {
        throw new Error(`Expected a 768-dim embedding for chunk ${id}, got ${embedding.length}`);
      }
      ids.push(id);
      vectors.push(`[${embedding.join(',')}]`);
    }
    // sql.param binds each array as ONE parameter — a plain `${ids}` would be
    // expanded into a `($1,$2,...)` list (a record), which can't cast to uuid[].
    await this.db.execute(sql`
      UPDATE chunks AS c
      SET embedding = d.embedding::halfvec
      FROM (SELECT * FROM unnest(${sql.param(ids)}::uuid[], ${sql.param(vectors)}::text[]) AS t(id, embedding)) AS d
      WHERE c.id = d.id::uuid
    `);
  }

  async countByProjectId(projectId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(chunks)
      .where(eq(chunks.projectId, projectId));
    return row?.value ?? 0;
  }

  /** Chunk count across a set of unchanged files' existing rows — used by the cost estimate to size the "cached, no request needed" bucket without re-chunking them. */
  async countByFileIds(fileIds: string[]): Promise<number> {
    if (fileIds.length === 0) return 0;
    const [row] = await this.db
      .select({ value: count() })
      .from(chunks)
      .where(inArray(chunks.fileId, fileIds));
    return row?.value ?? 0;
  }

  /**
   * One row per file (`ord = 0` is unique per file), used by the tour
   * generator both as representative evidence (correct startLine/endLine to
   * cite) and as the text scanned for the import-fan-in ranking heuristic —
   * without re-walking disk or reading every chunk of every file.
   */
  async findFirstChunkPerFile(projectId: string): Promise<FirstChunkOfFile[]> {
    return this.db
      .select({
        path: files.path,
        startLine: chunks.startLine,
        endLine: chunks.endLine,
        content: chunks.content,
      })
      .from(chunks)
      .innerJoin(files, eq(chunks.fileId, files.id))
      .where(and(eq(chunks.projectId, projectId), eq(chunks.ord, 0)));
  }

  /** Every chunk of one exact repo-relative path, in chunk order — a changed file may span more than one chunk, unlike `findFirstChunkPerFile`. */
  async findByPath(projectId: string, path: string): Promise<ChunkOfFile[]> {
    return this.db
      .select({
        startLine: chunks.startLine,
        endLine: chunks.endLine,
        content: chunks.content,
        symbol: chunks.symbol,
      })
      .from(chunks)
      .innerJoin(files, eq(chunks.fileId, files.id))
      .where(and(eq(chunks.projectId, projectId), eq(files.path, path)))
      .orderBy(chunks.ord);
  }
}
