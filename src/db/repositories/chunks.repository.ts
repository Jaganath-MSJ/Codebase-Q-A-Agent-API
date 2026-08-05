import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, isNull } from 'drizzle-orm';
import type { Db } from '../pool';
import { DB_TOKEN } from '../tokens';
import { chunks, ChunkRow, NewChunkRow } from '../schema';

export interface PendingEmbeddingChunk {
  id: string;
  content: string;
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
      .select({ id: chunks.id, content: chunks.content })
      .from(chunks)
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
}
