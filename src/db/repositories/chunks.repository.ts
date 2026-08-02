import { Inject, Injectable } from '@nestjs/common';
import type { Db } from '../pool';
import { DB_TOKEN } from '../tokens';
import { chunks, ChunkRow, NewChunkRow } from '../schema';

@Injectable()
export class ChunksRepository {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async insertMany(rows: NewChunkRow[]): Promise<ChunkRow[]> {
    if (rows.length === 0) return [];
    return this.db.insert(chunks).values(rows).returning();
  }
}
