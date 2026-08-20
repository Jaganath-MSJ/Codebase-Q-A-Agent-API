import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, isNull } from 'drizzle-orm';
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

  async setEmbedding(id: string, embedding: number[]): Promise<void> {
    await this.db.update(chunks).set({ embedding }).where(eq(chunks.id, id));
  }

  async countByProjectId(projectId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(chunks)
      .where(eq(chunks.projectId, projectId));
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
