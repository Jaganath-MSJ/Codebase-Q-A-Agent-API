import { Inject, Injectable } from '@nestjs/common';
import { count, eq, sql } from 'drizzle-orm';
import type { Db } from '../pool';
import { DB_TOKEN } from '../tokens';
import { chunks } from '../schema';

interface ProjectStorageBytes {
  chunkCount: number;
  contentBytes: number;
  vectorBytes: number;
}

interface DatabaseStorageTotals {
  databaseBytes: number;
  chunksIndexBytes: number;
}

@Injectable()
export class StorageRepository {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  /** `pg_column_size` gives exact per-row bytes, so this is a real count, not an estimate. */
  async getProjectBytes(projectId: string): Promise<ProjectStorageBytes> {
    const [row] = await this.db
      .select({
        chunkCount: count(),
        contentBytes: sql<string>`coalesce(sum(pg_column_size(${chunks.content})), 0)`,
        vectorBytes: sql<string>`coalesce(sum(pg_column_size(${chunks.embedding})), 0)`,
      })
      .from(chunks)
      .where(eq(chunks.projectId, projectId));

    return {
      chunkCount: row?.chunkCount ?? 0,
      contentBytes: Number(row?.contentBytes ?? 0),
      vectorBytes: Number(row?.vectorBytes ?? 0),
    };
  }

  /**
   * Whole-instance numbers: `chunks_index_bytes` covers the FTS and trigram
   * GIN indexes for every project's chunks combined — Postgres has no way to
   * attribute index storage to one project's rows, so this is intentionally
   * not divided up.
   */
  async getDatabaseTotals(): Promise<DatabaseStorageTotals> {
    const result = await this.db.execute<{
      database_bytes: string;
      chunks_index_bytes: string;
    }>(sql`
      select
        pg_database_size(current_database()) as database_bytes,
        pg_indexes_size('chunks') as chunks_index_bytes
    `);
    const row = result.rows[0];
    return {
      databaseBytes: Number(row?.database_bytes ?? 0),
      chunksIndexBytes: Number(row?.chunks_index_bytes ?? 0),
    };
  }
}
