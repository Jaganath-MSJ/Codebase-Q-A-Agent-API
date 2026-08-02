import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Db } from '../pool';
import { DB_TOKEN } from '../tokens';
import { files, FileRow, NewFileRow } from '../schema';

@Injectable()
export class FilesRepository {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async insertMany(rows: NewFileRow[]): Promise<FileRow[]> {
    if (rows.length === 0) return [];
    return this.db.insert(files).values(rows).returning();
  }

  async deleteByProjectId(projectId: string): Promise<void> {
    await this.db.delete(files).where(eq(files.projectId, projectId));
  }
}
