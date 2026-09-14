import { Inject, Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import type { Db } from '../pool';
import { DB_TOKEN } from '../tokens';
import { projects, ProjectRow, NewProjectRow } from '../schema';

@Injectable()
export class ProjectsRepository {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async create(
    data: Pick<
      NewProjectRow,
      'name' | 'sourceRef' | 'sourceKind' | 'defaultBranch'
    >,
  ): Promise<ProjectRow> {
    const [row] = await this.db.insert(projects).values(data).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  async findAll(): Promise<ProjectRow[]> {
    return this.db.select().from(projects).orderBy(desc(projects.createdAt));
  }

  async findById(id: string): Promise<ProjectRow | undefined> {
    const [row] = await this.db
      .select()
      .from(projects)
      .where(eq(projects.id, id));
    return row;
  }

  async update(
    id: string,
    data: Partial<
      Pick<
        NewProjectRow,
        | 'status'
        | 'fileCount'
        | 'chunkCount'
        | 'embeddingModel'
        | 'embeddingDim'
        | 'workspacePath'
        | 'defaultBranch'
        | 'headRevision'
        | 'overview'
        | 'tour'
        | 'changeAnalysis'
      >
    >,
  ): Promise<ProjectRow | undefined> {
    const [row] = await this.db
      .update(projects)
      .set(data)
      .where(eq(projects.id, id))
      .returning();
    return row;
  }

  /** Cascades to files/chunks/indexing_jobs/conversations/messages/citations via FK ON DELETE CASCADE. */
  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .delete(projects)
      .where(eq(projects.id, id))
      .returning({ id: projects.id });
    return result.length > 0;
  }
}
